# @aequi/core

Shared types, ABIs, and swap construction utilities used by the Aequi server and pricing libraries.

## Contents
- Chain and DEX types (`ChainConfig`, `DexConfig`, `ChainKey`, `RoutePreference`, etc.)
- Token and quote shapes (`TokenMetadata`, `PriceQuote`, `QuoteResult`)
- ABIs for AequiExecutor and Uniswap/Pancake V2/V3 routers (`src/abi.ts`)
- `SwapBuilder` to turn priced routes into transaction calldata

## SwapBuilder

Converts a `PriceQuote` into executable transaction calldata. Outputs either direct router calls or AequiExecutor multicall payloads.

### Configuration
```ts
const builder = new SwapBuilder({
  executorByChain: { ethereum: '0x...', bsc: '0x...' },
  interhopBufferBps: 3, // 0.03% buffer between hops
})
```

### Usage
```ts
const tx = builder.build(chainConfig, {
  quote,                  // PriceQuote from @aequi/pricing
  amountOutMin,           // slippage-adjusted minimum output
  recipient: '0x...',
  slippageBps: 50,        // 0.5%
  deadlineSeconds: 600,
  useNativeInput: false,  // true for BNB/ETH input
  useNativeOutput: false, // true for BNB/ETH output
})

// Returns SwapTransaction with:
// - kind: 'direct' | 'executor'
// - call: { to, data, value }
// - executor: { pulls, approvals, calls, tokensToFlush } (if multicall)
```

### Output Modes

**Direct Router** (single DEX, homogeneous hops):
- V2: `swapExactTokensForTokens`
- V3: `exactInput` with fee-encoded path

**AequiExecutor Multicall** (multi-DEX or mixed versions):
- Structured payload with pulls, approvals, calls, tokensToFlush
- Dynamic amount injection via `injectToken`/`injectOffset`
- Per-hop approval revocation
- Native wrap/unwrap calls when needed

### Native Token Support
- `useNativeInput`: adds WETH deposit call, sets `msg.value`
- `useNativeOutput`: adds WETH withdraw call with amount injection
- Executor tracks WETH in `tokensToFlush` for delta reconciliation

## Notes
- V3 calldata requires homogeneous V3 hops (mixed routes fall back to executor path).
- Slippage is clamped internally; pass already-bounded values when available.
- Chain config must include DEX router addresses and versions for route validation.
