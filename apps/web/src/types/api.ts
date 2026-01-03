export type ChainKey = 'ethereum' | 'bsc'

export interface DexSummary {
  id: string
  label: string
  protocol: string
  version: 'v2' | 'v3'
  factoryAddress: string
  routerAddress: string
  feeTiers: number[]
}

export interface ExchangeResponse {
  chain: ChainKey
  dexes: DexSummary[]
}

export interface TokenMetadata {
  address: string
  symbol: string
  name: string
  decimals: number
  totalSupply: string | null
}

export interface TokenResponse {
  chain: ChainKey
  token: TokenMetadata
}

export interface RoutePool {
  dexId: string
  poolAddress: string
  feeTier: number | null
}

export interface RouteToken {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface PriceResponse {
  chain: ChainKey
  source: string
  path: string[]
  tokens: RouteToken[]
  routeAddresses: string[]
  priceQ18: string
  midPriceQ18: string
  executionPriceQ18: string
  priceImpactBps: number
  amountIn: string
  amountInFormatted: string
  amountOut: string
  amountOutFormatted: string
  liquidityScore: string
  estimatedGasUnits: string | null
  estimatedGasCostWei: string | null
  gasPriceWei: string | null
  hopVersions: ('v2' | 'v3')[]
  routePreference: 'auto' | 'v2' | 'v3'
  pools: RoutePool[]
  sources: Array<{ dexId: string; amountOut: string }>
}

export interface QuoteResponse extends PriceResponse {
  amountOutMin: string
  amountOutMinFormatted: string
  slippageBps: number
  offers?: PriceResponse[]
}

export interface AllowanceEntry {
  token: string
  allowance: string
}

export interface AllowanceResponse {
  chain: ChainKey
  owner: string
  spender: string
  allowances: AllowanceEntry[]
}

export interface ApproveResponse {
  chain: ChainKey
  token: string
  spender: string
  amount: string
  decimals: number
  callData: string
  transaction: {
    to: string
    data: string
    value: string
  }
}

export interface RouterCall {
  to: string
  data: string
  value: string
}

export interface ExecutorCallPlan {
  target: string
  allowFailure: boolean
  callData: string
  value: string
}

export interface ExecutorPlanCall {
  target: string
  value: string
  data: string
}

export interface ExecutorPlan {
  pulls: Array<{ token: string; amount: string }>
  approvals: Array<{ token: string; spender: string; amount: string; revokeAfter: boolean }>
  calls: ExecutorPlanCall[]
  tokensToFlush: string[]
}

export interface SwapTransactionPayload {
  kind: 'direct' | 'executor'
  dexId: string
  router: string
  spender: string
  amountIn: string
  amountOut: string
  amountOutMinimum: string
  deadline: number
  calls: ExecutorCallPlan[]
  call: RouterCall | null
  executor: ExecutorPlan | null
  estimatedGas?: string
}

export interface SwapResponse extends QuoteResponse {
  recipient: string
  deadline: number
  quoteTimestamp: number
  quoteExpiresAt: number
  quoteValidSeconds: number
  quoteBlockNumber: string | null
  quoteBlockTimestamp: number | null
  transaction: SwapTransactionPayload
}
