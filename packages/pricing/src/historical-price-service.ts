import { CurrencyAmount as CakeCurrencyAmount, Token as CakeToken } from '@pancakeswap/swap-sdk-core'
import { Pair as CakePair } from '@pancakeswap/v2-sdk'
import { CurrencyAmount as UniCurrencyAmount, Token as UniToken } from '@uniswap/sdk-core'
import { Pair as UniPair } from '@uniswap/v2-sdk'
import { Pool as UniPool } from '@uniswap/v3-sdk'
import type { Address, PublicClient } from 'viem'
import type { ChainConfig, DexConfig, PriceQuote, RouteHopVersion, TokenMetadata } from '@aequi/core'
import {
    V2_FACTORY_ABI,
    V2_PAIR_ABI,
    V3_FACTORY_ABI,
    V3_POOL_ABI,
    ZERO_ADDRESS,
    normalizeAddress,
} from './contracts'
import { Q18, minBigInt, scaleToQ18 } from './math'
import {
    computeExecutionPriceQ18,
    computeMidPriceQ18FromPrice,
    computePriceImpactBps,
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

        // Step 1: Find pool addresses via factory contracts (at historical block)
        const factoryCalls: any[] = []
        const dexMap: { type: 'v2' | 'v3'; dex: DexConfig; fee?: number; index: number }[] = []

        chain.dexes.forEach((dex) => {
            if (!allowedVersions.includes(dex.version)) return

            if (dex.version === 'v2') {
                factoryCalls.push({
                    address: dex.factoryAddress,
                    abi: V2_FACTORY_ABI,
                    functionName: 'getPair',
                    args: [tokenIn.address, tokenOut.address],
                })
                dexMap.push({ type: 'v2', dex, index: factoryCalls.length - 1 })
            } else {
                ; (dex.feeTiers ?? []).forEach((fee) => {
                    factoryCalls.push({
                        address: dex.factoryAddress,
                        abi: V3_FACTORY_ABI,
                        functionName: 'getPool',
                        args: [tokenIn.address, tokenOut.address, fee],
                    })
                    dexMap.push({ type: 'v3', dex, fee, index: factoryCalls.length - 1 })
                })
            }
        })

        if (factoryCalls.length === 0) return []

        const factoryResults = await client.multicall({
            allowFailure: true,
            contracts: factoryCalls,
            blockNumber,
        })

        // Step 2: Fetch pool data at the historical block
        const poolDataCalls: any[] = []
        const poolMap: {
            type: 'v2' | 'v3'
            dex: DexConfig
            fee?: number
            poolAddress: Address
            startIndex: number
        }[] = []

        dexMap.forEach((item) => {
            const result = factoryResults[item.index]
            if (!result || result.status !== 'success' || !result.result || result.result === ZERO_ADDRESS)
                return

            const poolAddress = result.result as Address

            if (item.type === 'v2') {
                poolDataCalls.push(
                    { address: poolAddress, abi: V2_PAIR_ABI, functionName: 'getReserves' },
                    { address: poolAddress, abi: V2_PAIR_ABI, functionName: 'token0' },
                )
                poolMap.push({ ...item, poolAddress, startIndex: poolDataCalls.length - 2 })
            } else {
                poolDataCalls.push(
                    { address: poolAddress, abi: V3_POOL_ABI, functionName: 'slot0' },
                    { address: poolAddress, abi: V3_POOL_ABI, functionName: 'liquidity' },
                    { address: poolAddress, abi: V3_POOL_ABI, functionName: 'token0' },
                    { address: poolAddress, abi: V3_POOL_ABI, functionName: 'token1' },
                )
                poolMap.push({ ...item, poolAddress, startIndex: poolDataCalls.length - 4 })
            }
        })

        if (poolDataCalls.length === 0) return []

        const poolDataResults = await client.multicall({
            allowFailure: true,
            contracts: poolDataCalls,
            blockNumber,
        })

        // Step 3: Compute quotes from historical pool data
        const quotes: PriceQuote[] = []

        for (const item of poolMap) {
            try {
                if (item.type === 'v2') {
                    const reservesRes = poolDataResults[item.startIndex]
                    const token0Res = poolDataResults[item.startIndex + 1]

                    if (
                        reservesRes &&
                        token0Res &&
                        reservesRes.status === 'success' &&
                        token0Res.status === 'success'
                    ) {
                        const [reserve0, reserve1] = reservesRes.result as readonly [bigint, bigint, number]
                        const token0Address = normalizeAddress(token0Res.result as Address)

                        const reserveIn = sameAddress(token0Address, tokenIn.address)
                            ? (reserve0 as bigint)
                            : (reserve1 as bigint)
                        const reserveOut = sameAddress(token0Address, tokenIn.address)
                            ? (reserve1 as bigint)
                            : (reserve0 as bigint)

                        const quote = this.computeV2Quote(
                            chain,
                            item.dex,
                            tokenIn,
                            tokenOut,
                            amountIn,
                            item.poolAddress,
                            reserveIn,
                            reserveOut,
                        )
                        if (quote) quotes.push(quote)
                    }
                } else {
                    const slot0Res = poolDataResults[item.startIndex]
                    const liquidityRes = poolDataResults[item.startIndex + 1]
                    const token0Res = poolDataResults[item.startIndex + 2]
                    const token1Res = poolDataResults[item.startIndex + 3]

                    if (
                        slot0Res &&
                        liquidityRes &&
                        token0Res &&
                        token1Res &&
                        slot0Res.status === 'success' &&
                        liquidityRes.status === 'success' &&
                        token0Res.status === 'success' &&
                        token1Res.status === 'success'
                    ) {
                        const slotData = slot0Res.result as readonly [
                            bigint,
                            number,
                            number,
                            number,
                            number,
                            number,
                            boolean,
                        ]
                        const liquidityValue = liquidityRes.result as bigint

                        if (liquidityValue <= 0n) continue

                        const quote = this.computeV3Quote(
                            chain,
                            item.dex,
                            tokenIn,
                            tokenOut,
                            amountIn,
                            item.poolAddress,
                            slotData[0], // sqrtPriceX96
                            liquidityValue,
                            Number(slotData[1]), // tick
                            item.fee!,
                        )
                        if (quote) quotes.push(quote)
                    }
                }
            } catch (error) {
                console.warn(
                    `[HistoricalPrice] Error processing pool ${item.poolAddress} (${item.type}):`,
                    (error as Error).message,
                )
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
        tick: number,
        fee: number,
    ): PriceQuote | null {
        if (liquidity <= 0n || sqrtPriceX96 <= 0n) {
            return null
        }

        // Compute mid-price from sqrtPriceX96
        // sqrtPriceX96 = sqrt(price) * 2^96
        // price (token1/token0) = (sqrtPriceX96 / 2^96)^2
        const tokenInInstance = new UniToken(
            tokenIn.chainId,
            tokenIn.address,
            tokenIn.decimals,
            tokenIn.symbol,
            tokenIn.name,
        )
        const tokenOutInstance = new UniToken(
            tokenOut.chainId,
            tokenOut.address,
            tokenOut.decimals,
            tokenOut.symbol,
            tokenOut.name,
        )

        // Use SDK to compute mid-price from pool state
        let pool: UniPool
        try {
            pool = new UniPool(
                tokenInInstance,
                tokenOutInstance,
                fee,
                sqrtPriceX96.toString(),
                liquidity.toString(),
                tick,
            )
        } catch (error) {
            console.warn(
                `[HistoricalPrice] Failed to create V3 pool instance:`,
                (error as Error).message,
            )
            return null
        }

        // Get mid-price via SDK
        const midPriceQ18 = computeMidPriceQ18FromPrice(
            dex.protocol,
            tokenInInstance as any,
            tokenOut.decimals,
            pool.token0Price,
        )

        if (midPriceQ18 <= 0n) {
            return null
        }

        // For historical V3 quotes, we approximate amountOut from midPrice
        // (we can't call the Quoter at a historical block easily)
        // Apply fee deduction: amountOut ≈ amountIn * midPrice * (1 - fee/1e6)
        const feeDeduction = 1_000_000n - BigInt(fee)
        const adjustedAmountIn = (amountIn * feeDeduction) / 1_000_000n

        const inFactor = 10n ** BigInt(tokenIn.decimals)
        const outFactor = 10n ** BigInt(tokenOut.decimals)
        const amountOutRaw = (adjustedAmountIn * midPriceQ18 * outFactor) / (Q18 * inFactor)

        if (amountOutRaw <= 0n) {
            return null
        }

        const executionPriceQ18 = computeExecutionPriceQ18(amountIn, amountOutRaw, tokenIn.decimals, tokenOut.decimals)
        const priceImpactBps = computePriceImpactBps(
            midPriceQ18,
            amountIn,
            amountOutRaw,
            tokenIn.decimals,
            tokenOut.decimals,
        )

        const hopVersions: RouteHopVersion[] = ['v3']
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
