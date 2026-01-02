# @aequi/pricing

Pricing, routing, and pool discovery utilities used by the Aequi server.

## Contents
- `TokenService` – fetches and caches ERC20 metadata via viem multicall with optional preload list.
- `PoolDiscovery` – probes Uniswap/Pancake V2+V3 factories/pools, filters by liquidity thresholds, and returns direct or multi-hop `PriceQuote` candidates.
- `PriceService` – orchestrates token metadata lookup, pool discovery, gas price retrieval, and quote ranking.
- `route-planner`/`quote-math` – compares quotes, estimates gas, mid/exec prices, and price impact (Q18 math).
- `units` – helpers for default amount sizing.

## Usage
```ts
import { PriceService, PoolDiscovery, TokenService } from '@aequi/pricing'
import type { ChainConfig } from '@aequi/core'

// implement ChainClientProvider with getClient(chain) -> viem PublicClient
const clientProvider: ChainClientProvider = { /* ... */ }

const tokenService = new TokenService(clientProvider, { preloadTokens })
const poolDiscovery = new PoolDiscovery(tokenService, clientProvider, {
  intermediateTokenAddresses,
  minV2ReserveThreshold,
  minV3LiquidityThreshold,
})
const pricing = new PriceService(tokenService, clientProvider, poolDiscovery)

const quote = await pricing.getBestQuoteForTokens(
  chain as ChainConfig,
  tokenIn,
  tokenOut,
  amountIn,
  'auto', // route preference: auto | v2 | v3
)

// or build executable quote with bounded slippage
const result = await pricing.buildQuoteResult(
  chain,
  tokenIn.address,
  tokenOut.address,
  '1.0',      // human amount
  50,         // slippage bps
  'auto',
  parseUnits, // parse fn(decimals) => bigint
)
```

## Notes
- Route preference `auto` tries V3 then V2; V3 calldata requires homogeneous hops.
- Gas estimation is heuristic (`estimateGasForRoute`) and returned on the quote.
- All token amounts and prices are `bigint` and Q18 where noted.
- Pool discovery uses multicall to reduce RPC round-trips; provide multiple RPC URLs for resilience.
