import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem'
import type { Address, Hex } from 'viem'
import type { ChainConfig } from '../../types'
import { parseAmountToUnits } from '../../utils/units'
import { TokenService } from './token-service'
import type { IChainClientProvider } from '../clients/types'
import { DefaultChainClientProvider } from '../clients/default-chain-client-provider'

interface AllowanceResult {
  token: Address
  allowance: bigint
}

interface ApprovalCalldataResult {
  token: Address
  spender: Address
  amount: bigint
  decimals: number
  callData: Hex
  transaction: {
    to: Address
    data: Hex
    value: bigint
  }
}

export class AllowanceService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly clientProvider: IChainClientProvider = new DefaultChainClientProvider(),
  ) {}

  async getAllowances(
    chain: ChainConfig,
    owner: Address,
    spender: Address,
    tokens: Address[],
  ): Promise<AllowanceResult[]> {
    if (!tokens.length) {
      return []
    }

    const client = await this.clientProvider.getClient(chain)
    const contracts = tokens.map((token) => ({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    }))

    const responses = await client.multicall({ contracts, allowFailure: true })

    return responses.map((response, index) => ({
      token: tokens[index]!,
      allowance: response.status === 'success' ? (response.result as bigint) : 0n,
    }))
  }

  async buildApproveCalldata(
    chain: ChainConfig,
    token: Address,
    spender: Address,
    amountInput: string | null,
  ): Promise<ApprovalCalldataResult> {
    const metadata = await this.tokenService.getTokenMetadata(chain, token)
    const amount = this.resolveAmount(metadata.decimals, amountInput)

    const callData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    })

    return {
      token,
      spender,
      amount,
      decimals: metadata.decimals,
      callData,
      transaction: {
        to: token,
        data: callData,
        value: 0n,
      },
    }
  }

  private resolveAmount(decimals: number, amountInput: string | null): bigint {
    if (!amountInput || amountInput.toLowerCase() === 'max') {
      return maxUint256
    }

    const trimmed = amountInput.trim()
    if (!trimmed) {
      return maxUint256
    }

    return parseAmountToUnits(trimmed, decimals)
  }
}
