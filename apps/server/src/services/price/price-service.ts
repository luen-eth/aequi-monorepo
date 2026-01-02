import type { Address } from 'viem'
import type { ChainConfig, PriceQuote, RouteHopVersion, RoutePreference, TokenMetadata } from '../../types'
import { defaultAmountForDecimals } from '../../utils/units'
import { TokenService } from '../tokens/token-service'
import type { IChainClientProvider } from '../clients/types'
import { DefaultChainClientProvider } from '../clients/default-chain-client-provider'
import { compareQuotes } from './quote-math'
import { selectBestQuote } from './route-planner'
import { PoolDiscovery } from './pool-discovery'

export class PriceService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly clientProvider: IChainClientProvider = new DefaultChainClientProvider(),
    private readonly poolDiscovery: PoolDiscovery = new PoolDiscovery(tokenService),
  ) {}

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

    let gasPriceWei: bigint | null = null
    try {
      gasPriceWei = await client.getGasPrice()
    } catch {
      gasPriceWei = null
    }

    const [directQuotes, multiHopQuotes] = await Promise.all([
      this.poolDiscovery.fetchDirectQuotes(chain, tokenIn, tokenOut, amountIn, gasPriceWei, client, allowedVersions),
      this.poolDiscovery.fetchMultiHopQuotes(chain, tokenIn, tokenOut, amountIn, gasPriceWei, client, allowedVersions),
    ])

    const candidates = [...directQuotes, ...multiHopQuotes]
    const best = selectBestQuote(candidates)
    if (!best) {
      return null
    }

    const remaining = candidates.filter((quote) => quote !== best).sort(compareQuotes)
    if (remaining.length) {
      best.offers = remaining
    }

    return best
  }
}

const resolveAllowedVersions = (preference: RoutePreference): RouteHopVersion[] => {
  if (preference === 'auto') {
    return ['v3', 'v2']
  }
  return [preference]
}
