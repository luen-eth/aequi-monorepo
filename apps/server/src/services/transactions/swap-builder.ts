import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import { AEQUI_EXECUTOR_ADDRESS, EXECUTOR_INTERHOP_BUFFER_BPS } from '../../config/constants'
import type { ChainConfig, PriceQuote, PriceSource, TokenMetadata } from '../../types'
import { AEQUI_EXECUTOR_ABI, V2_ROUTER_ABI, V3_ROUTER_ABI } from '../../utils/abi'
import { clampSlippage } from '../../utils/trading'

interface ExecutorCallPlan {
  target: Address
  allowFailure: boolean
  callData: Hex
  value?: bigint
}

interface SwapBuildParams {
  quote: PriceQuote
  amountOutMin: bigint
  recipient: Address
  slippageBps: number
  deadlineSeconds: number
}

export interface SwapTransaction {
  kind: 'direct' | 'executor'
  dexId: string
  router: Address
  spender: Address
  amountIn: bigint
  amountOut: bigint
  amountOutMinimum: bigint
  deadline: number
  calls: ExecutorCallPlan[]
  call?: {
    to: Address
    data: Hex
    value: bigint
  }
  executor?: {
    pulls: { token: Address; amount: bigint }[]
    approvals: { token: Address; spender: Address; amount: bigint; revokeAfter: boolean }[]
    calls: { target: Address; value: bigint; data: Hex }[]
    tokensToFlush: Address[]
  }
}

const encodeV3Path = (tokens: Address[], fees: number[]): Hex => {
  if (tokens.length < 2) {
    throw new Error('V3 path requires at least two tokens')
  }
  if (fees.length !== tokens.length - 1) {
    throw new Error('V3 path fee mismatch')
  }

  let concatenated = ''
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!.toLowerCase().replace(/^0x/, '')
    concatenated += token
    if (index < fees.length) {
      const feeHex = fees[index]!.toString(16).padStart(6, '0')
      concatenated += feeHex
    }
  }

  return `0x${concatenated}` as Hex
}

export class SwapBuilder {
  build(chain: ChainConfig, params: SwapBuildParams): SwapTransaction {
    if (!params.quote.sources.length) {
      throw new Error('Quote is missing source information')
    }

    const uniqueDexes = new Set(params.quote.sources.map((source) => source.dexId))
    const deadlineSeconds = params.deadlineSeconds > 0 ? params.deadlineSeconds : 600
    const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds
    const boundedSlippage = clampSlippage(params.slippageBps)
    const amountOutMinimum = params.amountOutMin > 0n
      ? params.amountOutMin
      : this.applySlippage(params.quote.amountOut, boundedSlippage)

    if (uniqueDexes.size === 1) {
      const dexId = params.quote.sources[0]!.dexId
      const dex = chain.dexes.find((entry) => entry.id === dexId)
      if (!dex) {
        throw new Error(`DEX ${dexId} is not configured for chain ${chain.name}`)
      }
      return this.buildDirectSwap(
        dex,
        params.quote,
        params.recipient,
        amountOutMinimum,
        BigInt(deadline),
      )
    }

    return this.buildExecutorSwap(
      chain,
      params.quote,
      params.recipient,
      amountOutMinimum,
      BigInt(deadline),
    )
  }

  private applySlippage(amount: bigint, slippageBps: number): bigint {
    if (amount === 0n || slippageBps <= 0) {
      return amount
    }
    const penalty = (amount * BigInt(slippageBps)) / 10000n
    return amount > penalty ? amount - penalty : 0n
  }

  private buildDirectSwap(
    dex: { id: string; routerAddress: Address; version: 'v2' | 'v3' },
    quote: PriceQuote,
    recipient: Address,
    deadline: bigint,
    amountOutMin: bigint,
  ): SwapTransaction {
    if (dex.version === 'v2' && quote.routeAddresses.length < 2) {
      throw new Error('V2 route must contain at least two tokens')
    }

    const callData = dex.version === 'v2'
      ? this.encodeV2SwapCall(quote, recipient, amountOutMin, deadline)
      : this.encodeV3SwapCall(quote, recipient, amountOutMin, deadline)

    return {
      kind: 'direct',
      dexId: dex.id,
      router: dex.routerAddress,
      spender: dex.routerAddress,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      amountOutMinimum: amountOutMin,
      deadline: Number(deadline),
      calls: [],
      call: {
        to: dex.routerAddress,
        data: callData,
        value: 0n,
      },
    }
  }

  private buildExecutorSwap(
    chain: ChainConfig,
    quote: PriceQuote,
    recipient: Address,
    amountOutMin: bigint,
    deadline: bigint,
  ): SwapTransaction {
    const executorAddress = AEQUI_EXECUTOR_ADDRESS[chain.key]
    if (!executorAddress) {
      throw new Error(`Executor not configured for chain ${chain.name}`)
    }

    const inputToken = quote.path[0]
    if (!inputToken) {
      throw new Error('Quote is missing input token metadata')
    }

    const pulls = [{ token: inputToken.address, amount: quote.amountIn }]
    const approvals: { token: Address; spender: Address; amount: bigint; revokeAfter: boolean }[] = []
    const executorCalls: { target: Address; value: bigint; data: Hex }[] = []
    const tokensToFlush = new Set<Address>([inputToken.address])
    const calls: ExecutorCallPlan[] = []
    let availableAmount = quote.amountIn

    for (let index = 0; index < quote.sources.length; index += 1) {
      const source = quote.sources[index]
      if (!source) {
        throw new Error('Route source metadata missing for executor construction')
      }
      const tokenIn = quote.path[index] as TokenMetadata | undefined
      const tokenOut = quote.path[index + 1] as TokenMetadata | undefined
      const hopVersion = quote.hopVersions[index]
      if (!tokenIn || !tokenOut) {
        throw new Error('Route token metadata missing for executor construction')
      }
      if (!hopVersion) {
        throw new Error('Route hop version missing for executor construction')
      }

      const dex = chain.dexes.find((entry) => entry.id === source.dexId)
      if (!dex) {
        throw new Error(`DEX ${source.dexId} is not configured for chain ${chain.name}`)
      }

      const quotedHopAmountIn = source.amountIn
      if (!quotedHopAmountIn || quotedHopAmountIn <= 0n) {
        throw new Error('Missing hop amountIn for executor construction')
      }

      if (availableAmount <= 0n) {
        throw new Error('Insufficient rolling amount for executor construction')
      }

      let hopAmountIn = quotedHopAmountIn <= availableAmount ? quotedHopAmountIn : availableAmount

      if (index > 0 && EXECUTOR_INTERHOP_BUFFER_BPS > 0 && hopAmountIn > 0n) {
        const buffer = (hopAmountIn * BigInt(EXECUTOR_INTERHOP_BUFFER_BPS)) / 10_000n
        if (buffer > 0n && buffer < hopAmountIn) {
          hopAmountIn -= buffer
        }
      }

      if (hopAmountIn <= 0n) {
        throw new Error('Computed hop amountIn is non-positive after buffer adjustment')
      }

      const isLastHop = index === quote.sources.length - 1
      const hopRecipient = isLastHop ? recipient : executorAddress
      const hopExpectedOut = source.amountOut
      if (!hopExpectedOut || hopExpectedOut <= 0n) {
        throw new Error('Missing hop amountOut for executor construction')
      }
  const scaledHopExpectedOut = (hopExpectedOut * hopAmountIn) / quotedHopAmountIn

      const hopMinOut = this.deriveHopMinOut(
        scaledHopExpectedOut,
        amountOutMin,
        quote.amountOut,
        isLastHop,
      )

      approvals.push({
        token: tokenIn.address,
        spender: dex.routerAddress,
        amount: hopAmountIn,
        revokeAfter: true,
      })

      const swapCallData = hopVersion === 'v2'
        ? this.encodeV2SingleHopCall(tokenIn.address, tokenOut.address, hopAmountIn, hopMinOut, hopRecipient, deadline)
        : this.encodeV3SingleHopCall(tokenIn.address, tokenOut.address, source.feeTier, hopAmountIn, hopMinOut, hopRecipient, deadline)

      const plannedCall = {
        target: dex.routerAddress,
        value: 0n,
        data: swapCallData,
      }

      executorCalls.push(plannedCall)
      tokensToFlush.add(tokenIn.address)
      tokensToFlush.add(tokenOut.address)
      calls.push({
        target: plannedCall.target,
        allowFailure: false,
        callData: plannedCall.data,
        value: plannedCall.value,
      })

      availableAmount = scaledHopExpectedOut
    }

    const executorData = encodeFunctionData({
      abi: AEQUI_EXECUTOR_ABI,
      functionName: 'execute',
      args: [
        pulls,
        approvals,
        executorCalls,
        recipient,
        Array.from(tokensToFlush),
      ],
    })

    return {
      kind: 'executor',
      dexId: quote.sources.length === 1 ? quote.sources[0]!.dexId : 'multi',
      router: executorAddress,
      spender: executorAddress,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      amountOutMinimum: amountOutMin,
      deadline: Number(deadline),
      calls,
      call: {
        to: executorAddress,
        data: executorData,
        value: 0n,
      },
      executor: {
        pulls,
        approvals,
        calls: executorCalls,
        tokensToFlush: Array.from(tokensToFlush),
      },
    }
  }

  private deriveHopMinOut(
    hopExpectedOut: bigint,
    totalMinOut: bigint,
    totalExpectedOut: bigint,
    isLastHop: boolean,
  ): bigint {
    if (isLastHop) {
      return totalMinOut
    }
    if (totalExpectedOut === 0n || hopExpectedOut === 0n) {
      return 0n
    }
    return (hopExpectedOut * totalMinOut) / totalExpectedOut
  }

  private encodeV2SwapCall(
    quote: PriceQuote,
    recipient: Address,
    amountOutMin: bigint,
    deadline: bigint,
  ): Hex {
    return encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [quote.amountIn, amountOutMin, quote.routeAddresses, recipient, deadline],
    })
  }

  private encodeV3SwapCall(
    quote: PriceQuote,
    recipient: Address,
    amountOutMin: bigint,
    deadline: bigint,
  ): Hex {
    if (!quote.hopVersions.every((version) => version === 'v3')) {
      throw new Error('Mixed-version routes are not supported for V3 calldata')
    }

    const fees = quote.sources.map((source) => {
      if (typeof source.feeTier !== 'number') {
        throw new Error('Missing fee tier for V3 route')
      }
      return source.feeTier
    })

    if (fees.length !== quote.routeAddresses.length - 1) {
      throw new Error('Fee tiers do not match V3 path length')
    }

    if (quote.routeAddresses.length === 2) {
      return encodeFunctionData({
        abi: V3_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: quote.routeAddresses[0]!,
            tokenOut: quote.routeAddresses[1]!,
            fee: fees[0]!,
            recipient,
            deadline,
            amountIn: quote.amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })
    }

    const path = encodeV3Path(quote.routeAddresses, fees)
    return encodeFunctionData({
      abi: V3_ROUTER_ABI,
      functionName: 'exactInput',
      args: [
        {
          path,
          recipient,
          deadline,
          amountIn: quote.amountIn,
          amountOutMinimum: amountOutMin,
        },
      ],
    })
  }

  private encodeV2SingleHopCall(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    amountOutMin: bigint,
    recipient: Address,
    deadline: bigint,
  ): Hex {
    return encodeFunctionData({
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, amountOutMin, [tokenIn, tokenOut], recipient, deadline],
    })
  }

  private encodeV3SingleHopCall(
    tokenIn: Address,
    tokenOut: Address,
    feeTier: number | undefined,
    amountIn: bigint,
    amountOutMin: bigint,
    recipient: Address,
    deadline: bigint,
  ): Hex {
    if (typeof feeTier !== 'number') {
      throw new Error('Missing fee tier for V3 hop')
    }

    return encodeFunctionData({
      abi: V3_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee: feeTier,
          recipient,
          deadline,
          amountIn,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
  }
}
