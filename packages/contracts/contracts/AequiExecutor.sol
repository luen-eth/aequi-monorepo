// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";

contract AequiExecutor is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Address for address;

    error ExecutionFailed(uint256 index, address target, bytes reason);
    error InvalidInjectionOffset(uint256 offset, uint256 length);
    error ZeroAmountInjection();

    struct TokenPull {
        address token;
        uint256 amount;
    }

    struct Approval {
        address token;
        address spender;
        uint256 amount;
        bool revokeAfter;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
        address injectToken; // If non-zero, injects the balance of this token into the call data
        uint256 injectOffset; // The byte offset in 'data' to overwrite with the balance
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {}

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueFunds(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        Address.sendValue(to, amount);
    }

    function execute(
        TokenPull[] calldata pulls,
        Approval[] calldata approvals,
        Call[] calldata calls,
        address[] calldata tokensToFlush
    ) external payable nonReentrant whenNotPaused returns (bytes[] memory results) {
        uint256 ethBalanceBefore = address(this).balance - msg.value;
        uint256[] memory tokenBalancesBefore = _snapshotBalances(tokensToFlush);

        _pullTokens(pulls);
        _setApprovals(approvals);
        results = _performCalls(calls);
        _revokeApprovals(approvals);
        _flushDeltas(msg.sender, tokensToFlush, tokenBalancesBefore, ethBalanceBefore);
    }

    function _snapshotBalances(address[] calldata tokens) private view returns (uint256[] memory balances) {
        balances = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length;) {
            balances[i] = IERC20(tokens[i]).balanceOf(address(this));
            unchecked { ++i; }
        }
    }

    function _pullTokens(TokenPull[] calldata pulls) private {
        for (uint256 i; i < pulls.length;) {
            TokenPull calldata p = pulls[i];
            IERC20(p.token).safeTransferFrom(msg.sender, address(this), p.amount);
            unchecked { ++i; }
        }
    }

    function _setApprovals(Approval[] calldata approvals) private {
        for (uint256 i; i < approvals.length;) {
            Approval calldata a = approvals[i];
            IERC20(a.token).forceApprove(a.spender, a.amount);
            unchecked { ++i; }
        }
    }

    function _performCalls(Call[] calldata calls) private returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length;) {
            Call calldata c = calls[i];
            
            bytes memory data = c.data;

            if (c.injectToken != address(0)) {
                uint256 injectedAmount = IERC20(c.injectToken).balanceOf(address(this));
                if (injectedAmount == 0) revert ZeroAmountInjection();

                if (c.injectOffset + 32 > data.length) revert InvalidInjectionOffset(c.injectOffset, data.length);

                uint256 offset = c.injectOffset;
                assembly {
                    mstore(add(add(data, 32), offset), injectedAmount)
                }
            }

            (bool success, bytes memory ret) = c.target.call{value: c.value}(data);
            
            if (!success) {
                if (ret.length > 0) {
                    assembly {
                        let returndata_size := mload(ret)
                        revert(add(32, ret), returndata_size)
                    }
                } else {
                    revert ExecutionFailed(i, c.target, "");
                }
            }
            results[i] = ret;
            unchecked { ++i; }
        }
    }

    function _revokeApprovals(Approval[] calldata approvals) private {
        for (uint256 i; i < approvals.length;) {
            Approval calldata a = approvals[i];
            if (a.revokeAfter) {
                IERC20(a.token).forceApprove(a.spender, 0);
            }
            unchecked { ++i; }
        }
    }

    function _flushDeltas(
        address recipient,
        address[] calldata tokens,
        uint256[] memory balancesBefore,
        uint256 ethBalanceBefore
    ) private {
        for (uint256 i; i < tokens.length;) {
            uint256 balanceAfter = IERC20(tokens[i]).balanceOf(address(this));
            if (balanceAfter > balancesBefore[i]) {
                IERC20(tokens[i]).safeTransfer(recipient, balanceAfter - balancesBefore[i]);
            }
            unchecked { ++i; }
        }

        uint256 ethBalanceAfter = address(this).balance;
        if (ethBalanceAfter > ethBalanceBefore) {
            Address.sendValue(payable(recipient), ethBalanceAfter - ethBalanceBefore);
        }
    }
}
