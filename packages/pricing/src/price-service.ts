import type { Address } from 'viem'
import type { ChainConfig, PriceQuote, RouteHopVersion, RoutePreference, TokenMetadata } from '@aequi/core'
import { defaultAmountForDecimals } from './units'
import { selectBestQuote } from './route-planner'
import { compareQuotes } from './quote-math'
import type { ChainClientProvider, QuoteResult } from './types'
import type { TokenService } from './token-service'
import { PoolDiscovery } from './pool-discovery'
import { c, getCachedGasPrice, setCachedGasPrice, logCacheStats, logRouteRankings } from './logging'

const resolveAllowedVersions = (preference: RoutePreference): RouteHopVersion[] => {
  if (preference === 'auto') {
    return ['v3', 'v2']
  }
  return [preference]
}

const clampSlippage = (value: number): number => {
  if (!Number.isFinite(value) || Number.isNaN(value) || value < 0) {
    return 0
  }
  if (value > 5000) {
    return 5000
  }
  return Math.floor(value)
}

export class PriceService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly clientProvider: ChainClientProvider,
    private readonly poolDiscovery: PoolDiscovery,
  ) { }

  async getBestPrice(
    chain: ChainConfig,
    tokenA: Address,
    tokenB: Address,
    amountIn?: bigint,
    preference: RoutePreference = 'auto',
  ): Promise<PriceQuote | null> {
    const [tokenIn, tokenOut] = await Promise.all([
      this.tokenService.getTokenMetadata(chain, tokenA),
      this.tokenService.getTokenMetadata(chain, tokenB),
    ])

    const effectiveAmountIn = amountIn && amountIn > 0n
      ? amountIn
      : defaultAmountForDecimals(tokenIn.decimals)

    return this.getBestQuoteForTokens(chain, tokenIn, tokenOut, effectiveAmountIn, preference)
  }

  async getBestQuoteForTokens(
    chain: ChainConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
    amountIn: bigint,
    preference: RoutePreference = 'auto',
  ): Promise<PriceQuote | null> {
    if (amountIn <= 0n) {
      return null
    }

    const allowedVersions = resolveAllowedVersions(preference)
    const client = await this.clientProvider.getClient(chain)

    // Use cached gas price to reduce RPC calls
    let gasPriceWei: bigint | null = getCachedGasPrice(chain.id)
    if (!gasPriceWei) {
      try {
        gasPriceWei = await client.getGasPrice()
        setCachedGasPrice(chain.id, gasPriceWei)
      } catch {
        gasPriceWei = null
      }
    }

    // Log cache stats periodically
    logCacheStats()

    const [directQuotes, multiHopQuotes] = await Promise.all([
      this.poolDiscovery.fetchDirectQuotes(chain, tokenIn, tokenOut, amountIn, gasPriceWei, client, allowedVersions),
      this.poolDiscovery.fetchMultiHopQuotes(chain, tokenIn, tokenOut, amountIn, gasPriceWei, client, allowedVersions),
    ])

    const candidates = [...directQuotes, ...multiHopQuotes]
    const best = selectBestQuote(candidates)
    if (!best) {
      console.log(`${c.yellow}[Quote]${c.reset} ${tokenIn.symbol} → ${tokenOut.symbol} | No routes found`)
      return null
    }

    // Log detailed route rankings
    logRouteRankings(candidates, best, tokenIn, tokenOut)

    const remaining = candidates.filter((quote) => quote !== best).sort(compareQuotes)
    if (remaining.length) {
      best.offers = remaining
    }

    return best
  }

  async buildQuoteResult(
    chain: ChainConfig,
    tokenInAddress: Address,
    tokenOutAddress: Address,
    amount: string,
    slippageBps: number,
    preference: RoutePreference = 'auto',
    parseAmount: (value: string, decimals: number) => bigint,
  ): Promise<QuoteResult | null> {
    if (tokenInAddress.toLowerCase() === tokenOutAddress.toLowerCase()) {
      return null
    }

    const [tokenIn, tokenOut] = await Promise.all([
      this.tokenService.getTokenMetadata(chain, tokenInAddress),
      this.tokenService.getTokenMetadata(chain, tokenOutAddress),
    ])

    const amountIn = parseAmount(amount, tokenIn.decimals)
    if (amountIn <= 0n) {
      throw new Error('Amount must be greater than zero')
    }

    const quote = await this.getBestQuoteForTokens(chain, tokenIn, tokenOut, amountIn, preference)
    if (!quote) {
      return null
    }

    const boundedSlippage = clampSlippage(slippageBps)
    const slippageAmount = (quote.amountOut * BigInt(boundedSlippage)) / 10000n
    const amountOutMin = quote.amountOut > slippageAmount ? quote.amountOut - slippageAmount : 0n

    return {
      quote,
      amountOutMin,
      slippageBps: boundedSlippage,
      tokenIn,
      tokenOut,
    }
  }
}
