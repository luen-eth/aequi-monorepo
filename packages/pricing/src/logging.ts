import type { PriceQuote, TokenMetadata } from '@aequi/core'
import { compareQuotes } from './quote-math'

// ANSI color codes
export const c = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m',
    dim: '\x1b[2m',
}

// ============ RPC OPTIMIZATION: Caches ============

// Pool address cache (5 min TTL) - pool addresses don't change
const POOL_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
interface CachedPoolAddress {
    address: string
    timestamp: number
}
const v2PairCache = new Map<string, CachedPoolAddress>()
const v3PoolCache = new Map<string, CachedPoolAddress>()

// Gas price cache (30 sec TTL) - updates slowly
const GAS_CACHE_TTL_MS = 30 * 1000 // 30 seconds
interface CachedGasPrice {
    gasPrice: bigint
    timestamp: number
}
const gasPriceCache = new Map<number, CachedGasPrice>() // chainId => gasPrice

// V3 slot0 cache (5 sec TTL) - changes frequently but we can tolerate small staleness
const SLOT0_CACHE_TTL_MS = 5 * 1000 // 5 seconds
interface CachedSlot0 {
    sqrtPriceX96: bigint
    tick: number
    liquidity: bigint
    timestamp: number
}
const v3Slot0Cache = new Map<string, CachedSlot0>()

// Helper to get cached V2 pair address
export function getCachedV2Pair(chainId: number, factoryAddress: string, tokenA: string, tokenB: string): string | null {
    const key = `${chainId}:${factoryAddress}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`
    const cached = v2PairCache.get(key) ?? v2PairCache.get(`${chainId}:${factoryAddress}:${tokenB.toLowerCase()}:${tokenA.toLowerCase()}`)
    if (cached && Date.now() - cached.timestamp < POOL_CACHE_TTL_MS) {
        return cached.address
    }
    return null
}

export function setCachedV2Pair(chainId: number, factoryAddress: string, tokenA: string, tokenB: string, pairAddress: string): void {
    const key = `${chainId}:${factoryAddress}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}`
    v2PairCache.set(key, { address: pairAddress, timestamp: Date.now() })
}

// Helper to get cached V3 pool address
export function getCachedV3Pool(chainId: number, factoryAddress: string, tokenA: string, tokenB: string, fee: number): string | null {
    const key = `${chainId}:${factoryAddress}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}:${fee}`
    const cached = v3PoolCache.get(key) ?? v3PoolCache.get(`${chainId}:${factoryAddress}:${tokenB.toLowerCase()}:${tokenA.toLowerCase()}:${fee}`)
    if (cached && Date.now() - cached.timestamp < POOL_CACHE_TTL_MS) {
        return cached.address
    }
    return null
}

export function setCachedV3Pool(chainId: number, factoryAddress: string, tokenA: string, tokenB: string, fee: number, poolAddress: string): void {
    const key = `${chainId}:${factoryAddress}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}:${fee}`
    v3PoolCache.set(key, { address: poolAddress, timestamp: Date.now() })
}

// Helper to get cached gas price
export function getCachedGasPrice(chainId: number): bigint | null {
    const cached = gasPriceCache.get(chainId)
    if (cached && Date.now() - cached.timestamp < GAS_CACHE_TTL_MS) {
        return cached.gasPrice
    }
    return null
}

export function setCachedGasPrice(chainId: number, gasPrice: bigint): void {
    gasPriceCache.set(chainId, { gasPrice, timestamp: Date.now() })
}

// Log cache stats periodically
let cacheLogCounter = 0
export function logCacheStats(): void {
    cacheLogCounter++
    if (cacheLogCounter % 50 === 0) {
        console.log(`${c.dim}[Cache Stats]${c.reset} V2 pairs: ${v2PairCache.size}, V3 pools: ${v3PoolCache.size}, Gas: ${gasPriceCache.size}`)
    }
}

// Format amount from units (bigint with decimals) to human readable string
export function formatAmount(amount: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals)
    const whole = amount / divisor
    const fraction = amount % divisor
    const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 6)
    return `${whole}.${fractionStr}`
}

// Log all route candidates with ranking
export function logRouteRankings(
    candidates: PriceQuote[],
    best: PriceQuote,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
): void {
    if (candidates.length === 0) return

    // Sort candidates for display (best first)
    const sortedCandidates = [...candidates].sort(compareQuotes)

    // Calculate rate for each route
    const routeInfo = sortedCandidates.map((quote) => {
        const isSelected = quote === best
        // Calculate rate: amountOut / amountIn, adjusted for decimals
        const inDecimalsFactor = 10n ** BigInt(tokenIn.decimals)
        const outDecimalsFactor = 10n ** BigInt(tokenOut.decimals)
        const rate = (Number(quote.amountOut) * Number(inDecimalsFactor)) /
            (Number(quote.amountIn) * Number(outDecimalsFactor))
        const routeLabel = quote.sources.map(s => s.dexId.split(':')[0]).join(' > ')
        const impactPercent = quote.priceImpactBps / 100
        const impactCol = impactPercent > 5 ? c.yellow : c.green
        const selectedMarker = isSelected ? `${c.green}★${c.reset} ` : '  '

        const amountOutFormatted = formatAmount(quote.amountOut, tokenOut.decimals)
        const liquidityFormatted = formatAmount(quote.liquidityScore, 18)
        return `${selectedMarker}${routeLabel}: ${c.cyan}1 ${tokenIn.symbol} = ${rate.toFixed(6)} ${tokenOut.symbol}${c.reset} (${impactCol}${impactPercent.toFixed(2)}%${c.reset} impact) | Out: ${amountOutFormatted} | Liq: ${liquidityFormatted}`
    })

    const impact = best.priceImpactBps / 100
    const impactColor = impact > 5 ? c.yellow : c.green

    console.log(`${c.cyan}[Quote]${c.reset} ${tokenIn.symbol} → ${tokenOut.symbol} | ${c.green}${candidates.length}${c.reset} routes | Best: ${impactColor}${impact.toFixed(2)}%${c.reset} impact`)
    routeInfo.forEach(info => console.log(`  ${info}`))
}
