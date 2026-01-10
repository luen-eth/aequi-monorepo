import { encodeFunctionData } from 'viem'
import type { Address, Hex } from 'viem'
import { AEQUI_EXECUTOR_ABI, V2_ROUTER_ABI, V3_ROUTER_ABI, V3_ROUTER02_ABI, WETH_ABI } from './abi'
import type { ChainConfig, ChainKey, PriceQuote, TokenMetadata } from './types'

interface ExecutorCallPlan {
  target: Address
  allowFailure: boolean
  callData: Hex
  value?: bigint
}

export interface SwapBuilderConfig {
  executorByChain: Record<ChainKey, Address | null>
  interhopBufferBps: number
}

export interface SwapBuildParams {
  quote: PriceQuote
  amountOutMin: bigint
  recipient: Address
  slippageBps: number
  deadlineSeconds: number
  useNativeInput?: boolean
  useNativeOutput?: boolean
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
    approvals: { token: Address; spender: Address; amount: bigint }[]
    calls: { target: Address; value: bigint; data: Hex; injectToken: Address; injectOffset: bigint }[]
    tokensToFlush: Address[]
  }
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
  private readonly interhopBufferBps: number

  constructor(private readonly config: SwapBuilderConfig) {
    this.interhopBufferBps = config.interhopBufferBps > 0 ? Math.floor(config.interhopBufferBps) : 0
  }

  build(chain: ChainConfig, params: SwapBuildParams): SwapTransaction {
    if (!params.quote.sources.length) {
      throw new Error('Quote is missing source information')
    }

    const deadlineSeconds = params.deadlineSeconds > 0 ? params.deadlineSeconds : 600
    const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds
    const boundedSlippage = clampSlippage(params.slippageBps)
    const amountOutMinimum = params.amountOutMin > 0n
      ? params.amountOutMin
      : this.applySlippage(params.quote.amountOut, boundedSlippage)

    // ALWAYS use executor for all swaps - this ensures consistent behavior
    // and allows proper token handling (pull, approve, swap, flush)
    return this.buildExecutorSwap(
      chain,
      params.quote,
      params.recipient,
      amountOutMinimum,
      BigInt(deadline),
      params.useNativeInput,
      params.useNativeOutput,
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
    useNativeInput?: boolean,
    useNativeOutput?: boolean,
  ): SwapTransaction {
    const executorAddress = this.resolveExecutor(chain.key, chain.name)

    const inputToken = quote.path[0]
    if (!inputToken) {
      throw new Error('Quote is missing input token metadata')
    }

    const pulls: { token: Address; amount: bigint }[] = []
    if (!useNativeInput) {
      pulls.push({ token: inputToken.address, amount: quote.amountIn })
    }

    const approvals: { token: Address; spender: Address; amount: bigint }[] = []
    const executorCalls: { target: Address; value: bigint; data: Hex; injectToken: Address; injectOffset: bigint }[] = []
    const tokensToFlush = new Set<Address>()
    if (!useNativeInput) {
      tokensToFlush.add(inputToken.address)
    }

    const calls: ExecutorCallPlan[] = []
    let availableAmount = quote.amountIn

    if (useNativeInput) {
      if (!chain.wrappedNativeAddress) {
        throw new Error(`Wrapped native address not configured for chain ${chain.name}`)
      }

      const wrapCallData = encodeFunctionData({
        abi: WETH_ABI,
        functionName: 'deposit',
        args: [],
      })

      const wrapCall = {
        target: chain.wrappedNativeAddress,
        value: quote.amountIn,
        data: wrapCallData,
        injectToken: '0x0000000000000000000000000000000000000000' as Address,
        injectOffset: 0n,
      }

      executorCalls.push(wrapCall)
      tokensToFlush.add(chain.wrappedNativeAddress)
    }

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

      if (index > 0 && this.interhopBufferBps > 0 && hopAmountIn > 0n) {
        const buffer = (hopAmountIn * BigInt(this.interhopBufferBps)) / 10_000n
        if (buffer > 0n && buffer < hopAmountIn) {
          hopAmountIn -= buffer
        }
      }

      if (hopAmountIn <= 0n) {
        throw new Error('Computed hop amountIn is non-positive after buffer adjustment')
      }

      const isLastHop = index === quote.sources.length - 1
      // If unwrapping at the end, the last hop must send tokens to the executor
      const hopRecipient = (isLastHop && !useNativeOutput) ? recipient : executorAddress
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

      // FIX: For intermediate hops (index > 0), use max approval since executor injects
      // actual token balance which may differ from quoted hopAmountIn
      const isIntermediateHop = index > 0
      const approvalAmount = isIntermediateHop
        ? BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') // max uint256
        : hopAmountIn // exact amount for first hop

      approvals.push({
        token: tokenIn.address,
        spender: dex.routerAddress,
        amount: approvalAmount,
        // revokeAfter removed - contract always revokes
      })

      // Detect if this is Uniswap V3 (SwapRouter02) which uses different ABI
      const isUniswapV3 = dex.protocol === 'uniswap' && hopVersion === 'v3'

      const swapCallData = hopVersion === 'v2'
        ? this.encodeV2SingleHopCall(tokenIn.address, tokenOut.address, hopAmountIn, hopMinOut, hopRecipient, deadline)
        : this.encodeV3SingleHopCall(tokenIn.address, tokenOut.address, source.feeTier, hopAmountIn, hopMinOut, hopRecipient, deadline, isUniswapV3)

      // Dynamic Injection for multi-hop
      // For the first hop (index 0), we use the fixed amountIn.
      // For subsequent hops, we must inject the output of the previous hop (which is the current tokenIn balance).
      const isInjectionNeeded = index > 0
      const injectToken = isInjectionNeeded ? tokenIn.address : '0x0000000000000000000000000000000000000000' as Address

      let injectOffset = 0n
      if (isInjectionNeeded) {
        if (hopVersion === 'v2') {
          // swapExactTokensForTokens(amountIn, ...) -> amountIn is at offset 4
          injectOffset = 4n
        } else if (isUniswapV3) {
          // SwapRouter02 exactInputSingle(params) -> params.amountIn at offset 4 + (4 * 32) = 132
          // Struct: tokenIn, tokenOut, fee, recipient, amountIn (no deadline)
          injectOffset = 132n
        } else {
          // Standard V3 Router exactInputSingle(params) -> params.amountIn at offset 4 + (5 * 32) = 164
          // Struct: tokenIn, tokenOut, fee, recipient, deadline, amountIn
          injectOffset = 164n
        }
      }

      const plannedCall = {
        target: dex.routerAddress,
        value: 0n,
        data: swapCallData,
        injectToken,
        injectOffset,
      }

      executorCalls.push(plannedCall)
      tokensToFlush.add(tokenIn.address)

      // Only flush output token if it's coming back to executor (not going directly to recipient)
      if (hopRecipient === executorAddress) {
        tokensToFlush.add(tokenOut.address)
      }

      calls.push({
        target: plannedCall.target,
        allowFailure: false,
        callData: plannedCall.data,
        value: plannedCall.value,
      })

      availableAmount = scaledHopExpectedOut
    }

    if (useNativeOutput) {
      if (!chain.wrappedNativeAddress) {
        throw new Error(`Wrapped native address not configured for chain ${chain.name}`)
      }

      const unwrapCallData = encodeFunctionData({
        abi: WETH_ABI,
        functionName: 'withdraw',
        args: [0n], // Amount will be injected
      })

      const unwrapCall = {
        target: chain.wrappedNativeAddress,
        value: 0n,
        data: unwrapCallData,
        injectToken: chain.wrappedNativeAddress,
        injectOffset: 4n, // Offset of 'amount' parameter
      }

      executorCalls.push(unwrapCall)
      tokensToFlush.add(chain.wrappedNativeAddress)
    }

    const executorData = encodeFunctionData({
      abi: AEQUI_EXECUTOR_ABI,
      functionName: 'execute',
      args: [
        pulls,
        approvals,
        executorCalls,
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
        value: useNativeInput ? quote.amountIn : 0n,
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
    useRouter02: boolean = false,
  ): Hex {
    if (typeof feeTier !== 'number') {
      throw new Error('Missing fee tier for V3 hop')
    }

    // SwapRouter02 (Uniswap V3 on BSC) uses different ABI without deadline in struct
    if (useRouter02) {
      return encodeFunctionData({
        abi: V3_ROUTER02_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            fee: feeTier,
            recipient,
            amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })
    }

    // Standard V3 Router (PancakeSwap) with deadline in struct
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

  private resolveExecutor(chain: ChainKey, chainName: string): Address {
    const executor = this.config.executorByChain[chain]
    if (!executor) {
      throw new Error(`Executor not configured for chain ${chainName}`)
    }
    return executor
  }
}
