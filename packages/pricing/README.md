# @aequi/pricing

Pricing, routing, and pool discovery utilities used by the Aequi server.

## Components

### TokenService
Fetches and caches ERC20 metadata (symbol, name, decimals, totalSupply) via viem multicall. Supports preload lists for intermediate tokens.

### PoolDiscovery
Discovers liquidity pools across Uniswap/Pancake V2+V3:
- Queries factory contracts for direct token pairs
- Filters by minimum liquidity thresholds (configurable per V2/V3)
- Constructs multi-hop routes through intermediate tokens (max 3 hops)
- Returns pool metadata: address, reserves/liquidity, fee tier

### PriceService
Orchestrates route planning and quote generation:
- Calls `PoolDiscovery` to find available routes
- Calculates output amounts using constant product (V2) or tick math (V3)
- Estimates gas costs and applies to quote comparison
- Ranks quotes by net output (amount - gas cost)
- Returns best `PriceQuote` with price impact and liquidity score

## Route Discovery

**Direct Routes**: Single pool connecting token A to token B

**Multi-hop Routes**: Path through intermediate tokens (WBNB, USDT, BUSD, etc.)
- Maximum 3 hops to balance gas vs availability
- Aggregates reserves to estimate slippage
- Prefers high-liquidity intermediate pairs

**Route Preference**:
- `auto`: tries V3 first, falls back to V2
- `v2`: Uniswap V2 / PancakeSwap V2 only
- `v3`: Uniswap V3 / PancakeSwap V3 only

## Quote Structure

`PriceQuote` contains:
- `path`: token addresses for the route
- `routeAddresses`: pool addresses for each hop
- `sources`: pool metadata (dexId, poolAddress, feeTier)
- `amountOut`: expected output amount
- `priceQ18`, `executionPriceQ18`, `midPriceQ18`: fixed-point price values
- `priceImpactBps`: slippage from mid price
- `estimatedGasUnits`, `estimatedGasCostWei`: gas estimates
- `liquidityScore`: reserves/TVL proxy for ranking

## Usage
```ts
import { PriceService, PoolDiscovery, TokenService } from '@aequi/pricing'

const tokenService = new TokenService(clientProvider, { preloadTokens })
const poolDiscovery = new PoolDiscovery(tokenService, clientProvider, {
  intermediateTokenAddresses,
  minV2ReserveThreshold,
  minV3LiquidityThreshold,
})
const pricing = new PriceService(tokenService, clientProvider, poolDiscovery)

const quote = await pricing.getBestQuoteForTokens(
  chainConfig,
  tokenIn,
  tokenOut,
  amountIn,
  'auto',
)
```

## Notes
- All token amounts and prices use `bigint`
- Price values use Q18 fixed-point (1.0 = 10^18)
- Pool discovery uses multicall to reduce RPC round-trips
- Provide multiple RPC URLs for resilience
