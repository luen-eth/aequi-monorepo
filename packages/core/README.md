# @aequi/core

Shared types, ABIs, and swap construction utilities used by the Aequi server and pricing libraries.

## Contents
- Chain and DEX types (`ChainConfig`, `DexConfig`, `ChainKey`, `RoutePreference`, etc.).
- Token and quote shapes (`TokenMetadata`, `PriceQuote`, `QuoteResult`).
- ABIs for AequiExecutor and Uniswap/Pancake V2/V3 routers (`src/abi.ts`).
- `SwapBuilder` to turn priced routes into calldata for direct router swaps or AequiExecutor multicall.

## SwapBuilder
- Accepts `executorByChain` map and `interhopBufferBps` in the constructor.
- `build(chain, { quote, amountOutMin, recipient, slippageBps, deadlineSeconds })` returns a `SwapTransaction` describing:
  - direct V2/V3 router call when all hops share one DEX, or
  - AequiExecutor multicall with pulls, approvals (auto-revoke), per-hop minOut scaling, and optional inter-hop buffer.
- Inputs must use `bigint` for all amounts/fees.

```ts
import { SwapBuilder } from '@aequi/core'
import type { ChainConfig } from '@aequi/core'

const builder = new SwapBuilder({
  executorByChain: { ethereum: '0x...', bsc: '0x...' },
  interhopBufferBps: 3,
})

const tx = builder.build(chainConfig as ChainConfig, {
  quote,                // PriceQuote from @aequi/pricing
  amountOutMin: quote.amountOut, // or slippage-adjusted minOut
  recipient: '0xRecipient',
  slippageBps: 50,
  deadlineSeconds: 600,
})

console.log(tx.call) // router or AequiExecutor calldata + value
```

## Notes
- V3 calldata requires homogeneous V3 hops (mixed routes fall back to executor path).
- Slippage is clamped internally; pass already-bounded values when available.
- Chain config must include DEX router addresses and versions for route validation.
