import { CurrencyAmount as CakeCurrencyAmount, Token as CakeToken } from '@pancakeswap/swap-sdk-core'
import { Pair as CakePair } from '@pancakeswap/v2-sdk'
import { CurrencyAmount as UniCurrencyAmount, Token as UniToken } from '@uniswap/sdk-core'
import { Pair as UniPair } from '@uniswap/v2-sdk'
import type { Address, PublicClient } from 'viem'
import type { ChainConfig, DexConfig, PriceQuote, RouteHopVersion, TokenMetadata } from '@aequi/core'
import {
    V2_FACTORY_ABI,
    V2_PAIR_ABI,
    V3_FACTORY_ABI,
    V3_POOL_ABI,
    V3_QUOTER_ABI,
    ZERO_ADDRESS,
    normalizeAddress,
} from './contracts'
import { minBigInt, scaleToQ18 } from './math'
import {
    computeExecutionPriceQ18,
    computeMidPriceQ18FromPrice,
    computeV3MidPriceQ18FromSqrtPriceX96,
    computePriceImpactBps,
    estimateAmountOutFromMidPrice,
    estimateGasForRoute,
    toRawAmount,
} from './quote-math'
import { selectBestQuote } from './route-planner'
import type { ChainClientProvider, TokenMetadataProvider } from './types'

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export interface HistoricalPriceResult {
    quote: PriceQuote
    blockNumber: bigint
}

export class HistoricalPriceService {
    constructor(
        private readonly tokenMetadataProvider: TokenMetadataProvider,
        private readonly clientProvider: ChainClientProvider,
    ) { }

    async getPriceAtBlock(
        chain: ChainConfig,
        tokenIn: TokenMetadata,
        tokenOut: TokenMetadata,
        amountIn: bigint,
        blockNumber: bigint,
        routePreference: 'auto' | 'v2' | 'v3' = 'auto',
    ): Promise<HistoricalPriceResult | null> {
        const client = await this.clientProvider.getClient(chain)

        const allowedVersions: RouteHopVersion[] =
            routePreference === 'auto' ? ['v2', 'v3'] : [routePreference]

        const quotes = await this.fetchQuotesAtBlock(
            chain,
            tokenIn,
            tokenOut,
            amountIn,
            blockNumber,
            client,
            allowedVersions,
        )

        const best = selectBestQuote(quotes)
        if (!best) {
            return null
        }

        return { quote: best, blockNumber }
    }

    private async fetchQuotesAtBlock(
        chain: ChainConfig,
        tokenIn: TokenMetadata,
        tokenOut: TokenMetadata,
        amountIn: bigint,
        blockNumber: bigint,
        client: PublicClient,
        allowedVersions: RouteHopVersion[],
    ): Promise<PriceQuote[]> {
        console.log(
            `\x1b[36m[HistoricalPrice]\x1b[0m Fetching quotes at block \x1b[33m${blockNumber}\x1b[0m for \x1b[33m${tokenIn.symbol}\x1b[0m → \x1b[33m${tokenOut.symbol}\x1b[0m`,
        )

        // Build list of dex/pool lookups
        const dexEntries: { type: 'v2' | 'v3'; dex: DexConfig; fee?: number }[] = []

        chain.dexes.forEach((dex: DexConfig) => {
            if (!allowedVersions.includes(dex.version)) return

            if (dex.version === 'v2') {
                dexEntries.push({ type: 'v2', dex })
            } else {
                ; (dex.feeTiers ?? []).forEach((fee: number) => {
                    dexEntries.push({ type: 'v3', dex, fee })
                })
            }
        })

        if (dexEntries.length === 0) return []

        console.log(`\x1b[36m[HistoricalPrice]\x1b[0m Making ${dexEntries.length} factory calls (direct readContract)...`)

        // Step 1: Find pool addresses via direct readContract calls (bypasses Multicall3)
        const factoryResults = await Promise.allSettled(
            dexEntries.map((entry) => {
                if (entry.type === 'v2') {
                    return client.readContract({
                        address: entry.dex.factoryAddress,
                        abi: V2_FACTORY_ABI,
                        functionName: 'getPair',
                        args: [tokenIn.address, tokenOut.address],
                        blockNumber,
                    })
                } else {
                    return client.readContract({
                        address: entry.dex.factoryAddress,
                        abi: V3_FACTORY_ABI,
                        functionName: 'getPool',
                        args: [tokenIn.address, tokenOut.address, entry.fee!],
                        blockNumber,
                    })
                }
            }),
        )

        console.log(`\x1b[36m[HistoricalPrice]\x1b[0m Factory results:`, factoryResults.map((r, i) => ({
            index: i,
            status: r.status,
            result: r.status === 'fulfilled' ? r.value : (r.reason as Error)?.message?.slice(0, 120),
        })))

        // Step 2: For each valid pool, fetch on-chain state at historical block
        const validPools: {
            type: 'v2' | 'v3'
            dex: DexConfig
            fee?: number
            poolAddress: Address
        }[] = []

        factoryResults.forEach((result, i) => {
            if (result.status !== 'fulfilled') return
            const addr = result.value as Address
            if (!addr || addr === ZERO_ADDRESS) return
            validPools.push({ ...dexEntries[i], poolAddress: addr })
        })

        if (validPools.length === 0) {
            console.log(`\x1b[36m[HistoricalPrice]\x1b[0m No valid pools found from factory calls`)
            return []
        }

        console.log(`\x1b[36m[HistoricalPrice]\x1b[0m Found ${validPools.length} pools, fetching pool data...`)

        // Step 3: Fetch pool data & compute quotes (direct readContract calls)
        const quotes: PriceQuote[] = []

        const poolQuoteResults = await Promise.allSettled(
            validPools.map(async (item) => {
                if (item.type === 'v2') {
                    const [reserves, token0Addr] = await Promise.all([
                        client.readContract({
                            address: item.poolAddress,
                            abi: V2_PAIR_ABI,
                            functionName: 'getReserves',
                            blockNumber,
                        }),
                        client.readContract({
                            address: item.poolAddress,
                            abi: V2_PAIR_ABI,
                            functionName: 'token0',
                            blockNumber,
                        }),
                    ])

                    const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number]
                    const token0Address = normalizeAddress(token0Addr as Address)

                    const reserveIn = sameAddress(token0Address, tokenIn.address) ? reserve0 : reserve1
                    const reserveOut = sameAddress(token0Address, tokenIn.address) ? reserve1 : reserve0

                    return this.computeV2Quote(
                        chain, item.dex, tokenIn, tokenOut, amountIn, item.poolAddress, reserveIn, reserveOut,
                    )
                } else {
                    const [slot0Data, liquidityValue, token0Addr, token1Addr] = await Promise.all([
                        client.readContract({
                            address: item.poolAddress,
                            abi: V3_POOL_ABI,
                            functionName: 'slot0',
                            blockNumber,
                        }),
                        client.readContract({
                            address: item.poolAddress,
                            abi: V3_POOL_ABI,
                            functionName: 'liquidity',
                            blockNumber,
                        }),
                        client.readContract({
                            address: item.poolAddress,
                            abi: V3_POOL_ABI,
                            functionName: 'token0',
                            blockNumber,
                        }),
                        client.readContract({
                            address: item.poolAddress,
                            abi: V3_POOL_ABI,
                            functionName: 'token1',
                            blockNumber,
                        }),
                    ])

                    const slotData = slot0Data as readonly [bigint, number, number, number, number, number, boolean]
                    const liq = liquidityValue as bigint
                    const token0Address = normalizeAddress(token0Addr as Address)
                    const token1Address = normalizeAddress(token1Addr as Address)

                    let quoterAmountOut: bigint | null = null
                    if (item.dex.quoterAddress) {
                        try {
                            const quoterResult = await client.readContract({
                                address: item.dex.quoterAddress,
                                abi: V3_QUOTER_ABI,
                                functionName: 'quoteExactInputSingle',
                                args: [{
                                    tokenIn: tokenIn.address,
                                    tokenOut: tokenOut.address,
                                    amountIn,
                                    fee: item.fee!,
                                    sqrtPriceLimitX96: 0n,
                                }],
                                blockNumber,
                            })
                            const [quotedAmountOut] = quoterResult as readonly [bigint, bigint, number, bigint]
                            if (quotedAmountOut > 0n) {
                                quoterAmountOut = quotedAmountOut
                            }
                        } catch (error) {
                            console.warn(
                                `[HistoricalPrice] Quoter failed for ${item.dex.id} pool ${item.poolAddress}:`,
                                (error as Error).message.slice(0, 120),
                            )
                        }
                    }

                    return this.computeV3Quote(
                        chain, item.dex, tokenIn, tokenOut, amountIn, item.poolAddress,
                        slotData[0], liq, item.fee!, token0Address, token1Address, quoterAmountOut,
                    )
                }
            }),
        )

        for (let i = 0; i < poolQuoteResults.length; i++) {
            const r = poolQuoteResults[i]
            if (r.status === 'fulfilled' && r.value) {
                quotes.push(r.value)
                console.log(`\x1b[36m[HistoricalPrice]\x1b[0m ${validPools[i].type.toUpperCase()} pool ${validPools[i].poolAddress} → quote SUCCESS`)
            } else if (r.status === 'fulfilled') {
                console.warn(`\x1b[36m[HistoricalPrice]\x1b[0m ${validPools[i].type.toUpperCase()} pool ${validPools[i].poolAddress} → skipped (no quote)`)
            } else if (r.status === 'rejected') {
                console.warn(`\x1b[36m[HistoricalPrice]\x1b[0m ${validPools[i].type.toUpperCase()} pool ${validPools[i].poolAddress} → FAILED: ${(r.reason as Error)?.message?.slice(0, 120)}`)
            }
        }

        console.log(
            `\x1b[36m[HistoricalPrice]\x1b[0m Found \x1b[32m${quotes.length}\x1b[0m quotes at block \x1b[33m${blockNumber}\x1b[0m`,
        )
        return quotes
    }

    private computeV2Quote(
        chain: ChainConfig,
        dex: DexConfig,
        tokenIn: TokenMetadata,
        tokenOut: TokenMetadata,
        amountIn: bigint,
        pairAddress: Address,
        reserveIn: bigint,
        reserveOut: bigint,
    ): PriceQuote | null {
        if (reserveIn <= 0n || reserveOut <= 0n) {
            return null
        }

        const tokenInInstance =
            dex.protocol === 'uniswap'
                ? new UniToken(tokenIn.chainId, tokenIn.address, tokenIn.decimals, tokenIn.symbol, tokenIn.name)
                : new CakeToken(tokenIn.chainId, tokenIn.address, tokenIn.decimals, tokenIn.symbol, tokenIn.name)

        const tokenOutInstance =
            dex.protocol === 'uniswap'
                ? new UniToken(tokenOut.chainId, tokenOut.address, tokenOut.decimals, tokenOut.symbol, tokenOut.name)
                : new CakeToken(tokenOut.chainId, tokenOut.address, tokenOut.decimals, tokenOut.symbol, tokenOut.name)

        const reserveInAmount =
            dex.protocol === 'uniswap'
                ? UniCurrencyAmount.fromRawAmount(tokenInInstance as UniToken, reserveIn.toString())
                : CakeCurrencyAmount.fromRawAmount(tokenInInstance as CakeToken, reserveIn.toString())

        const reserveOutAmount =
            dex.protocol === 'uniswap'
                ? UniCurrencyAmount.fromRawAmount(tokenOutInstance as UniToken, reserveOut.toString())
                : CakeCurrencyAmount.fromRawAmount(tokenOutInstance as CakeToken, reserveOut.toString())

        const pair =
            dex.protocol === 'uniswap'
                ? new UniPair(reserveInAmount as any, reserveOutAmount as any)
                : new CakePair(reserveInAmount as any, reserveOutAmount as any)

        const inputAmount =
            dex.protocol === 'uniswap'
                ? UniCurrencyAmount.fromRawAmount(tokenInInstance as UniToken, amountIn.toString())
                : CakeCurrencyAmount.fromRawAmount(tokenInInstance as CakeToken, amountIn.toString())

        let amountOutRaw: bigint
        try {
            const [amountOutCurrency] = pair.getOutputAmount(inputAmount as any)
            amountOutRaw = toRawAmount(amountOutCurrency)
        } catch (error) {
            console.warn(
                `[HistoricalPrice] V2 quote failed for ${tokenIn.symbol}->${tokenOut.symbol}:`,
                (error as Error).message,
            )
            return null
        }

        if (amountOutRaw <= 0n) {
            return null
        }

        const price = pair.priceOf(tokenInInstance as any)
        const midPriceQ18 = computeMidPriceQ18FromPrice(
            dex.protocol,
            tokenInInstance as any,
            tokenOut.decimals,
            price,
        )
        const executionPriceQ18 = computeExecutionPriceQ18(amountIn, amountOutRaw, tokenIn.decimals, tokenOut.decimals)
        const priceImpactBps = computePriceImpactBps(
            midPriceQ18,
            amountIn,
            amountOutRaw,
            tokenIn.decimals,
            tokenOut.decimals,
        )

        const liquidityScore = minBigInt(
            scaleToQ18(reserveIn, tokenIn.decimals),
            scaleToQ18(reserveOut, tokenOut.decimals),
        )

        const hopVersions: RouteHopVersion[] = ['v2']
        const estimatedGasUnits = estimateGasForRoute(hopVersions)

        return {
            chain: chain.key,
            amountIn,
            amountOut: amountOutRaw,
            priceQ18: executionPriceQ18,
            executionPriceQ18,
            midPriceQ18,
            priceImpactBps,
            path: [tokenIn, tokenOut],
            routeAddresses: [tokenIn.address, tokenOut.address],
            sources: [
                {
                    dexId: dex.id,
                    poolAddress: pairAddress,
                    amountIn,
                    amountOut: amountOutRaw,
                },
            ],
            liquidityScore,
            hopVersions,
            estimatedGasUnits,
            estimatedGasCostWei: null,
            gasPriceWei: null,
        }
    }

    private computeV3Quote(
        chain: ChainConfig,
        dex: DexConfig,
        tokenIn: TokenMetadata,
        tokenOut: TokenMetadata,
        amountIn: bigint,
        poolAddress: Address,
        sqrtPriceX96: bigint,
        liquidity: bigint,
        fee: number,
        token0Address: Address,
        token1Address: Address,
        quoterAmountOut: bigint | null,
    ): PriceQuote | null {
        if (sqrtPriceX96 <= 0n && (!quoterAmountOut || quoterAmountOut <= 0n)) {
            console.warn(`[HistoricalPrice] V3 pool ${poolAddress} skipped: liquidity=${liquidity} sqrtPriceX96=${sqrtPriceX96}`)
            return null
        }

        const tokenInIsToken0 = sameAddress(tokenIn.address, token0Address)
        const tokenInIsToken1 = sameAddress(tokenIn.address, token1Address)
        const tokenOutIsToken0 = sameAddress(tokenOut.address, token0Address)
        const tokenOutIsToken1 = sameAddress(tokenOut.address, token1Address)

        if ((!tokenInIsToken0 && !tokenInIsToken1) || (!tokenOutIsToken0 && !tokenOutIsToken1)) {
            console.warn(`[HistoricalPrice] V3 pool ${poolAddress} skipped: token mismatch for ${tokenIn.symbol}->${tokenOut.symbol}`)
            return null
        }

        const midPriceQ18 = sqrtPriceX96 > 0n
            ? computeV3MidPriceQ18FromSqrtPriceX96(
                sqrtPriceX96,
                tokenIn.decimals,
                tokenOut.decimals,
                tokenInIsToken0,
            )
            : 0n

        let amountOutRaw = quoterAmountOut ?? 0n
        if (amountOutRaw <= 0n) {
            if (midPriceQ18 <= 0n) {
                console.warn(`[HistoricalPrice] V3 pool ${poolAddress} skipped: midPriceQ18=${midPriceQ18}`)
                return null
            }
            // Historical fallback: estimate amountOut from slot0 mid-price.
            amountOutRaw = estimateAmountOutFromMidPrice(
                midPriceQ18,
                amountIn,
                tokenIn.decimals,
                tokenOut.decimals,
                fee,
            )
        }

        if (amountOutRaw <= 0n) {
            console.warn(`[HistoricalPrice] V3 pool ${poolAddress} skipped: amountOut=${amountOutRaw} amountIn=${amountIn}`)
            return null
        }

        const executionPriceQ18 = computeExecutionPriceQ18(amountIn, amountOutRaw, tokenIn.decimals, tokenOut.decimals)
        const effectiveMidPriceQ18 = midPriceQ18 > 0n ? midPriceQ18 : executionPriceQ18
        const priceImpactBps = midPriceQ18 > 0n
            ? computePriceImpactBps(
                midPriceQ18,
                amountIn,
                amountOutRaw,
                tokenIn.decimals,
                tokenOut.decimals,
            )
            : 0

        const hopVersions: RouteHopVersion[] = ['v3']
        const estimatedGasUnits = estimateGasForRoute(hopVersions)

        return {
            chain: chain.key,
            amountIn,
            amountOut: amountOutRaw,
            priceQ18: executionPriceQ18,
            executionPriceQ18,
            midPriceQ18: effectiveMidPriceQ18,
            priceImpactBps,
            path: [tokenIn, tokenOut],
            routeAddresses: [tokenIn.address, tokenOut.address],
            sources: [
                {
                    dexId: dex.id,
                    poolAddress,
                    feeTier: fee,
                    amountIn,
                    amountOut: amountOutRaw,
                },
            ],
            liquidityScore: liquidity,
            hopVersions,
            estimatedGasUnits,
            estimatedGasCostWei: null,
            gasPriceWei: null,
        }
    }
}
