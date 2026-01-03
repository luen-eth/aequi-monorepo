import type { Address, Chain } from 'viem'

export type ChainKey = 'ethereum' | 'bsc'

export type RouteHopVersion = 'v2' | 'v3'
export type RoutePreference = 'auto' | RouteHopVersion

export interface DexConfig {
  id: string
  label: string
  protocol: 'uniswap' | 'pancakeswap'
  version: 'v2' | 'v3'
  factoryAddress: Address
  routerAddress: Address
  quoterAddress?: Address
  feeTiers?: number[]
  initCodeHash?: `0x${string}`
}

export interface ChainConfig {
  key: ChainKey
  id: number
  name: string
  nativeCurrencySymbol: string
  wrappedNativeAddress: Address
  rpcUrls: string[]
  fallbackRpcUrls?: string[]
  disablePublicRpcRegistry?: boolean
  viemChain: Chain
  dexes: DexConfig[]
}

export interface TokenMetadata {
  chainId: number
  address: Address
  symbol: string
  name: string
  decimals: number
  totalSupply: bigint | null
}

export interface PriceSource {
  dexId: string
  poolAddress: Address
  feeTier?: number
  approximate?: boolean
  amountIn: bigint
  amountOut: bigint
}

export interface PriceQuote {
  chain: ChainKey
  amountIn: bigint
  amountOut: bigint
  priceQ18: bigint
  executionPriceQ18: bigint
  midPriceQ18: bigint
  priceImpactBps: number
  path: TokenMetadata[]
  routeAddresses: Address[]
  sources: PriceSource[]
  liquidityScore: bigint
  hopVersions: RouteHopVersion[]
  estimatedGasUnits: bigint | null
  estimatedGasCostWei: bigint | null
  gasPriceWei: bigint | null
  offers?: PriceQuote[]
}

export interface QuoteResult {
  quote: PriceQuote
  amountOutMin: bigint
  slippageBps: number
  tokenIn: TokenMetadata
  tokenOut: TokenMetadata
  estimatedGas?: bigint
}
