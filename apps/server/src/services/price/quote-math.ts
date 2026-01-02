import { CurrencyAmount as CakeCurrencyAmount, Token as CakeToken } from '@pancakeswap/swap-sdk-core'
import { CurrencyAmount as UniCurrencyAmount, Token as UniToken } from '@uniswap/sdk-core'
import type { DexConfig, PriceQuote, RouteHopVersion } from '../../types'
import { Q18 } from '../../config/constants'

const pow10 = (value: number) => (value <= 0 ? 1n : 10n ** BigInt(value))

const buildCurrencyAmount = (
  protocol: DexConfig['protocol'],
  token: UniToken | CakeToken,
  rawAmount: bigint,
) => {
  const value = rawAmount.toString()
  return protocol === 'uniswap'
    ? UniCurrencyAmount.fromRawAmount(token as UniToken, value)
    : CakeCurrencyAmount.fromRawAmount(token as CakeToken, value)
}

export const computeMidPriceQ18FromPrice = (
  protocol: DexConfig['protocol'],
  tokenInInstance: UniToken | CakeToken,
  tokenOutDecimals: number,
  price: { quote(input: unknown): unknown },
): bigint => {
  const unitIn = pow10(tokenInInstance.decimals)
  if (unitIn === 0n) {
    return 0n
  }

  try {
    const baseAmount = buildCurrencyAmount(protocol, tokenInInstance, unitIn)
    const quoted = price.quote(baseAmount as any)
    const quoteRaw = toRawAmount(quoted)
    if (quoteRaw === 0n) {
      return 0n
    }

    const outFactor = pow10(tokenOutDecimals)
    if (outFactor === 0n) {
      return 0n
    }

    return (quoteRaw * Q18) / outFactor
  } catch {
    return 0n
  }
}

export const applyPriceQ18 = (
  priceQ18: bigint,
  amountIn: bigint,
  inDecimals: number,
  outDecimals: number,
): bigint => {
  if (priceQ18 === 0n || amountIn === 0n) {
    return 0n
  }

  const inFactor = pow10(inDecimals)
  const outFactor = pow10(outDecimals)
  const numerator = amountIn * priceQ18 * outFactor
  const denominator = Q18 * inFactor
  if (denominator === 0n) {
    return 0n
  }

  return numerator / denominator
}

export const computeExecutionPriceQ18 = (
  amountIn: bigint,
  amountOut: bigint,
  inDecimals: number,
  outDecimals: number,
): bigint => {
  if (amountIn === 0n || amountOut === 0n) {
    return 0n
  }
  const inFactor = pow10(inDecimals)
  const outFactor = pow10(outDecimals)
  const denominator = amountIn * outFactor
  if (denominator === 0n) {
    return 0n
  }

  return (amountOut * Q18 * inFactor) / denominator
}

export const computePriceImpactBps = (
  midPriceQ18: bigint,
  amountIn: bigint,
  amountOut: bigint,
  inDecimals: number,
  outDecimals: number,
): number => {
  if (midPriceQ18 === 0n || amountIn === 0n || amountOut === 0n) {
    return 0
  }

  const expectedOut = applyPriceQ18(midPriceQ18, amountIn, inDecimals, outDecimals)
  if (expectedOut === 0n) {
    return 0
  }

  const diff = expectedOut > amountOut ? expectedOut - amountOut : amountOut - expectedOut
  if (diff === 0n) {
    return 0
  }

  const impact = (diff * 10000n) / expectedOut
  const capped = impact > 10_000_000n ? 10_000_000n : impact
  return Number(capped)
}

export const toRawAmount = (amount: unknown): bigint =>
  BigInt((amount as { quotient: { toString(): string } }).quotient.toString())

export const estimateAmountOutFromMidPrice = (
  midPriceQ18: bigint,
  amountIn: bigint,
  inDecimals: number,
  outDecimals: number,
  fee: number,
): bigint => {
  if (midPriceQ18 === 0n || amountIn === 0n) {
    return 0n
  }

  const adjustedAmountIn = amountIn - (amountIn * BigInt(fee)) / 1_000_000n
  return applyPriceQ18(midPriceQ18, adjustedAmountIn, inDecimals, outDecimals)
}

export const compareQuotes = (a: PriceQuote, b: PriceQuote) => {
  if (a.amountOut === b.amountOut) {
    if (a.liquidityScore === b.liquidityScore) {
      return a.priceImpactBps <= b.priceImpactBps ? -1 : 1
    }
    return a.liquidityScore > b.liquidityScore ? -1 : 1
  }
  return a.amountOut > b.amountOut ? -1 : 1
}

export const estimateGasForRoute = (hops: RouteHopVersion[]): bigint => {
  const GAS_BASE = 50000n
  const GAS_MULTI_HOP_OVERHEAD = 20000n
  const GAS_COSTS: Record<RouteHopVersion, bigint> = {
    v2: 70000n,
    v3: 110000n,
  }

  if (!hops.length) {
    return GAS_BASE
  }
  const base = hops.reduce((total, hop) => total + (GAS_COSTS[hop] ?? 90000n), GAS_BASE)
  if (hops.length === 1) {
    return base
  }
  return base + BigInt(hops.length - 1) * GAS_MULTI_HOP_OVERHEAD
}
