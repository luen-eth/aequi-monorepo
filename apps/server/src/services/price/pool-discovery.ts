import { CurrencyAmount as CakeCurrencyAmount, Token as CakeToken } from '@pancakeswap/swap-sdk-core'
import { Pair as CakePair } from '@pancakeswap/v2-sdk'
import { Pool as CakePool } from '@pancakeswap/v3-sdk'
import { CurrencyAmount as UniCurrencyAmount, Token as UniToken } from '@uniswap/sdk-core'
import { Pair as UniPair } from '@uniswap/v2-sdk'
import { Pool as UniPool } from '@uniswap/v3-sdk'
import type { Address, PublicClient } from 'viem'
import {
  INTERMEDIATE_TOKEN_ADDRESSES,
  MIN_V2_RESERVE_THRESHOLD,
  MIN_V3_LIQUIDITY_THRESHOLD,
} from '../../config/constants'
import type { ChainConfig, DexConfig, PriceQuote, RouteHopVersion, RoutePreference, TokenMetadata } from '../../types'
import { V2_FACTORY_ABI, V2_PAIR_ABI, V3_FACTORY_ABI, V3_POOL_ABI, ZERO_ADDRESS, normalizeAddress } from '../../utils/contracts'
import { minBigInt, multiplyQ18, scaleToQ18 } from '../../utils/math'
import {
  computeExecutionPriceQ18,
  computeMidPriceQ18FromPrice,
  computePriceImpactBps,
  estimateAmountOutFromMidPrice,
  estimateGasForRoute,
  toRawAmount,
} from './quote-math'
import { selectBestQuote } from './route-planner'
import { TokenService } from '../tokens/token-service'

interface V2ReserveSnapshot {
  pairAddress: Address
  reserveIn: bigint
  reserveOut: bigint
}

interface V3PoolSnapshot {
  poolAddress: Address
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
  token0: Address
  token1: Address
  fee: number
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export class PoolDiscovery {
  constructor(private readonly tokenService: TokenService) {}

  async fetchDirectQuotes(
    chain: ChainConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
    amountIn: bigint,
    gasPriceWei: bigint | null,
    client: PublicClient,
    allowedVersions: RouteHopVersion[],
  ): Promise<PriceQuote[]> {
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
        (dex.feeTiers ?? []).forEach((fee) => {
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
    })

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
      if (!result || result.status !== 'success' || !result.result || result.result === ZERO_ADDRESS) return

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
    })

    const quotes: PriceQuote[] = []

    for (const item of poolMap) {
      if (item.type === 'v2') {
        const reservesRes = poolDataResults[item.startIndex]
        const token0Res = poolDataResults[item.startIndex + 1]

        if (reservesRes && token0Res && reservesRes.status === 'success' && token0Res.status === 'success') {
          const [reserve0, reserve1] = reservesRes.result as readonly [bigint, bigint, number]
          const token0Address = normalizeAddress(token0Res.result as Address)

          const reserveIn = sameAddress(token0Address, tokenIn.address)
            ? (reserve0 as bigint)
            : (reserve1 as bigint)
          const reserveOut = sameAddress(token0Address, tokenIn.address)
            ? (reserve1 as bigint)
            : (reserve0 as bigint)

          const snapshot: V2ReserveSnapshot = {
            pairAddress: item.poolAddress,
            reserveIn,
            reserveOut,
          }

          const quote = await this.computeV2Quote(
            chain,
            item.dex,
            tokenIn,
            tokenOut,
            amountIn,
            gasPriceWei,
            snapshot,
          )
          if (quote) quotes.push(quote)
        }
      } else {
        const slot0Res = poolDataResults[item.startIndex]
        const liquidityRes = poolDataResults[item.startIndex + 1]
        const token0Res = poolDataResults[item.startIndex + 2]
        const token1Res = poolDataResults[item.startIndex + 3]

        if (
          slot0Res && liquidityRes && token0Res && token1Res &&
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
          const token0Address = normalizeAddress(token0Res.result as Address)
          const token1Address = normalizeAddress(token1Res.result as Address)

          const snapshot: V3PoolSnapshot = {
            poolAddress: item.poolAddress,
            sqrtPriceX96: slotData[0],
            tick: Number(slotData[1]),
            liquidity: liquidityValue,
            token0: token0Address,
            token1: token1Address,
            fee: item.fee!,
          }

          const quote = await this.computeV3Quote(
            chain,
            item.dex,
            tokenIn,
            tokenOut,
            amountIn,
            gasPriceWei,
            snapshot,
          )
          if (quote) quotes.push(quote)
        }
      }
    }

    return quotes
  }

  async fetchMultiHopQuotes(
    chain: ChainConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
    amountIn: bigint,
    gasPriceWei: bigint | null,
    client: PublicClient,
    allowedVersions: RouteHopVersion[],
  ): Promise<PriceQuote[]> {
    const intermediateAddresses = INTERMEDIATE_TOKEN_ADDRESSES[chain.key] ?? []
    const cache = new Map<string, TokenMetadata>()
    const results: PriceQuote[] = []

    for (const candidate of intermediateAddresses) {
      if (sameAddress(candidate, tokenIn.address) || sameAddress(candidate, tokenOut.address)) {
        continue
      }

      const intermediate = await this.loadIntermediate(chain, candidate, cache)

      const legAQuotes = await this.fetchDirectQuotes(
        chain,
        tokenIn,
        intermediate,
        amountIn,
        gasPriceWei,
        client,
        allowedVersions,
      )

      const legA = selectBestQuote(legAQuotes)
      if (!legA || legA.amountOut === 0n) {
        continue
      }

      const legBQuotes = await this.fetchDirectQuotes(
        chain,
        intermediate,
        tokenOut,
        legA.amountOut,
        gasPriceWei,
        client,
        allowedVersions,
      )
      const legB = selectBestQuote(legBQuotes)

      if (!legB || legB.amountOut === 0n) {
        continue
      }

      const midPriceQ18 = multiplyQ18(legA.midPriceQ18, legB.midPriceQ18)
      const executionPriceQ18 = multiplyQ18(legA.executionPriceQ18, legB.executionPriceQ18)
      const priceImpactBps = computePriceImpactBps(
        midPriceQ18,
        amountIn,
        legB.amountOut,
        tokenIn.decimals,
        tokenOut.decimals,
      )
      const hopVersions: RouteHopVersion[] = [...legA.hopVersions, ...legB.hopVersions]
      const estimatedGasUnits = estimateGasForRoute(hopVersions)
      const gasPrice = legA.gasPriceWei ?? legB.gasPriceWei ?? gasPriceWei
      const estimatedGasCostWei = gasPrice ? estimatedGasUnits * gasPrice : null

      results.push({
        chain: chain.key,
        amountIn,
        amountOut: legB.amountOut,
        priceQ18: executionPriceQ18,
        executionPriceQ18,
        midPriceQ18,
        priceImpactBps,
        path: [tokenIn, intermediate, tokenOut],
        routeAddresses: [tokenIn.address, intermediate.address, tokenOut.address],
        sources: [...legA.sources, ...legB.sources],
        liquidityScore: minBigInt(legA.liquidityScore, legB.liquidityScore),
        hopVersions,
        estimatedGasUnits,
        estimatedGasCostWei,
        gasPriceWei: gasPrice ?? null,
      })
    }

    return results
  }

  private async loadIntermediate(
    chain: ChainConfig,
    address: string,
    cache: Map<string, TokenMetadata>,
  ) {
    const lower = address.toLowerCase()
    const cached = cache.get(lower)
    if (cached) {
      return cached
    }
    const metadata = await this.tokenService.getTokenMetadata(chain, lower as Address)
    cache.set(lower, metadata)
    return metadata
  }

  private async computeV2Quote(
    chain: ChainConfig,
    dex: DexConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
    amountIn: bigint,
    gasPriceWei: bigint | null,
    snapshot: V2ReserveSnapshot,
  ): Promise<PriceQuote | null> {
    if (snapshot.reserveIn < MIN_V2_RESERVE_THRESHOLD || snapshot.reserveOut < MIN_V2_RESERVE_THRESHOLD) {
      return null
    }

    const { tokenInInstance, tokenOutInstance } = this.buildV2Tokens(dex, tokenIn, tokenOut)

    const reserveInAmount =
      dex.protocol === 'uniswap'
        ? UniCurrencyAmount.fromRawAmount(tokenInInstance as UniToken, snapshot.reserveIn.toString())
        : CakeCurrencyAmount.fromRawAmount(tokenInInstance as CakeToken, snapshot.reserveIn.toString())

    const reserveOutAmount =
      dex.protocol === 'uniswap'
        ? UniCurrencyAmount.fromRawAmount(tokenOutInstance as UniToken, snapshot.reserveOut.toString())
        : CakeCurrencyAmount.fromRawAmount(tokenOutInstance as CakeToken, snapshot.reserveOut.toString())

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
    } catch {
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
      scaleToQ18(snapshot.reserveIn, tokenIn.decimals),
      scaleToQ18(snapshot.reserveOut, tokenOut.decimals),
    )

    const hopVersions: RouteHopVersion[] = ['v2']
    const estimatedGasUnits = estimateGasForRoute(hopVersions)
    const estimatedGasCostWei = gasPriceWei ? gasPriceWei * estimatedGasUnits : null

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
          poolAddress: snapshot.pairAddress,
          amountIn,
          amountOut: amountOutRaw,
        },
      ],
      liquidityScore,
      hopVersions,
      estimatedGasUnits,
      estimatedGasCostWei,
      gasPriceWei,
    }
  }

  private async computeV3Quote(
    chain: ChainConfig,
    dex: DexConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
    amountIn: bigint,
    gasPriceWei: bigint | null,
    snapshot: V3PoolSnapshot,
  ): Promise<PriceQuote | null> {
    if (snapshot.liquidity < MIN_V3_LIQUIDITY_THRESHOLD) {
      return null
    }

    const { tokenInInstance, tokenOutInstance, token0, token1 } = this.buildV3Tokens(
      dex,
      tokenIn,
      tokenOut,
      snapshot,
    )

    if (!tokenInInstance || !tokenOutInstance || !token0 || !token1) {
      return null
    }

    const pool =
      dex.protocol === 'uniswap'
        ? new UniPool(
          token0 as UniToken,
          token1 as UniToken,
          snapshot.fee,
          snapshot.sqrtPriceX96.toString(),
          snapshot.liquidity.toString(),
          snapshot.tick,
        )
        : new CakePool(
          token0 as CakeToken,
          token1 as CakeToken,
          snapshot.fee,
          snapshot.sqrtPriceX96.toString(),
          snapshot.liquidity.toString(),
          snapshot.tick,
        )

    const inputAmount =
      dex.protocol === 'uniswap'
        ? UniCurrencyAmount.fromRawAmount(tokenInInstance as UniToken, amountIn.toString())
        : CakeCurrencyAmount.fromRawAmount(tokenInInstance as CakeToken, amountIn.toString())

    const price = pool.priceOf(tokenInInstance as any)
    let midPriceQ18 = computeMidPriceQ18FromPrice(
      dex.protocol,
      tokenInInstance as any,
      tokenOut.decimals,
      price,
    )

    let amountOutRaw: bigint | null = null
    let approximateOutput = false
    try {
      const [amountOutCurrency] = await pool.getOutputAmount(inputAmount as any)
      amountOutRaw = toRawAmount(amountOutCurrency)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isTickDataMissing = message.includes('No tick data provider')
      if (!isTickDataMissing) {
        return null
      }

      if (midPriceQ18 === 0n) {
        return null
      }

      amountOutRaw = estimateAmountOutFromMidPrice(
        midPriceQ18,
        amountIn,
        tokenIn.decimals,
        tokenOut.decimals,
        snapshot.fee,
      )

      if (!amountOutRaw || amountOutRaw <= 0n) {
        return null
      }

      approximateOutput = true
    }

    if (!amountOutRaw || amountOutRaw <= 0n) {
      return null
    }

    if (midPriceQ18 === 0n) {
      return null
    }

    const executionPriceQ18 = computeExecutionPriceQ18(amountIn, amountOutRaw, tokenIn.decimals, tokenOut.decimals)
    const priceImpactBps = approximateOutput
      ? 0
      : computePriceImpactBps(midPriceQ18, amountIn, amountOutRaw, tokenIn.decimals, tokenOut.decimals)

    const hopVersions: RouteHopVersion[] = ['v3']
    const estimatedGasUnits = estimateGasForRoute(hopVersions)
    const estimatedGasCostWei = gasPriceWei ? gasPriceWei * estimatedGasUnits : null

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
          poolAddress: snapshot.poolAddress,
          feeTier: snapshot.fee,
          approximate: approximateOutput,
          amountIn,
          amountOut: amountOutRaw,
        },
      ],
      liquidityScore: BigInt(snapshot.liquidity),
      hopVersions,
      estimatedGasUnits,
      estimatedGasCostWei,
      gasPriceWei,
    }
  }

  private buildV2Tokens(
    dex: DexConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
  ) {
    if (dex.protocol === 'uniswap') {
      return {
        tokenInInstance: new UniToken(
          tokenIn.chainId,
          tokenIn.address,
          tokenIn.decimals,
          tokenIn.symbol,
          tokenIn.name,
        ),
        tokenOutInstance: new UniToken(
          tokenOut.chainId,
          tokenOut.address,
          tokenOut.decimals,
          tokenOut.symbol,
          tokenOut.name,
        ),
      }
    }

    return {
      tokenInInstance: new CakeToken(
        tokenIn.chainId,
        tokenIn.address,
        tokenIn.decimals,
        tokenIn.symbol,
        tokenIn.name,
      ),
      tokenOutInstance: new CakeToken(
        tokenOut.chainId,
        tokenOut.address,
        tokenOut.decimals,
        tokenOut.symbol,
        tokenOut.name,
      ),
    }
  }

  private buildV3Tokens(
    dex: DexConfig,
    tokenIn: TokenMetadata,
    tokenOut: TokenMetadata,
    snapshot: V3PoolSnapshot,
  ) {
    const resolveMeta = (address: Address) => {
      if (sameAddress(address, tokenIn.address)) {
        return tokenIn
      }
      if (sameAddress(address, tokenOut.address)) {
        return tokenOut
      }
      return tokenIn
    }

    if (dex.protocol === 'uniswap') {
      const token0Meta = resolveMeta(snapshot.token0)
      const token1Meta = resolveMeta(snapshot.token1)
      const token0 = new UniToken(
        token0Meta.chainId,
        token0Meta.address,
        token0Meta.decimals,
        token0Meta.symbol,
        token0Meta.name,
      )
      const token1 = new UniToken(
        token1Meta.chainId,
        token1Meta.address,
        token1Meta.decimals,
        token1Meta.symbol,
        token1Meta.name,
      )
      const tokenInInstance = sameAddress(tokenIn.address, token0.address) ? token0 : token1
      const tokenOutInstance = sameAddress(tokenOut.address, token0.address) ? token0 : token1
      return { tokenInInstance, tokenOutInstance, token0, token1 }
    }

    const token0Meta = resolveMeta(snapshot.token0)
    const token1Meta = resolveMeta(snapshot.token1)
    const token0 = new CakeToken(
      token0Meta.chainId,
      token0Meta.address,
      token0Meta.decimals,
      token0Meta.symbol,
      token0Meta.name,
    )
    const token1 = new CakeToken(
      token1Meta.chainId,
      token1Meta.address,
      token1Meta.decimals,
      token1Meta.symbol,
      token1Meta.name,
    )
    const tokenInInstance = sameAddress(tokenIn.address, token0.address) ? token0 : token1
    const tokenOutInstance = sameAddress(tokenOut.address, token0.address) ? token0 : token1
    return { tokenInInstance, tokenOutInstance, token0, token1 }
  }
}
