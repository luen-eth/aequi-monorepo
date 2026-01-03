import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { z } from 'zod'
import { isAddress } from 'viem'
import type { Address } from 'viem'
import { getChainConfig, SUPPORTED_CHAINS } from './config/chains'
import {
    AEQUI_EXECUTOR_ADDRESS,
    EXECUTOR_INTERHOP_BUFFER_BPS,
    SWAP_QUOTE_TTL_SECONDS,
    INTERMEDIATE_TOKENS,
    INTERMEDIATE_TOKEN_ADDRESSES,
    MIN_V2_RESERVE_THRESHOLD,
    MIN_V3_LIQUIDITY_THRESHOLD,
    NATIVE_ADDRESS,
} from './config/constants'
import { appConfig } from './config/app-config'
import { ExchangeService } from './services/exchange/exchange-service'
import { TokenService, PriceService, PoolDiscovery } from '@aequi/pricing'
import { QuoteService } from './services/quote/quote-service'
import { AllowanceService } from './services/tokens/allowance-service'
import { SwapBuilder } from '@aequi/core'
import { formatAmountFromUnits, parseAmountToUnits } from './utils/units'
import { DefaultChainClientProvider } from './services/clients/default-chain-client-provider'
import { normalizeAddress } from './utils/trading'
import type { ChainConfig, PriceQuote, QuoteResult, RoutePreference, TokenMetadata } from './types'

const chainClientProvider = new DefaultChainClientProvider()
const exchangeService = new ExchangeService()
const tokenService = new TokenService(chainClientProvider, { preloadTokens: INTERMEDIATE_TOKENS })
const poolDiscovery = new PoolDiscovery(tokenService, chainClientProvider, {
    intermediateTokenAddresses: INTERMEDIATE_TOKEN_ADDRESSES,
    minV2ReserveThreshold: MIN_V2_RESERVE_THRESHOLD,
    minV3LiquidityThreshold: MIN_V3_LIQUIDITY_THRESHOLD,
})
const priceService = new PriceService(tokenService, chainClientProvider, poolDiscovery)
const quoteService = new QuoteService(tokenService, priceService)
const allowanceService = new AllowanceService(tokenService, chainClientProvider)
const swapBuilder = new SwapBuilder({
    executorByChain: AEQUI_EXECUTOR_ADDRESS,
    interhopBufferBps: EXECUTOR_INTERHOP_BUFFER_BPS,
})

const chainQuerySchema = z.object({
    chain: z.string().min(1),
})
const resolveRoutePreference = (value?: string): RoutePreference => {
    if (!value) {
        return 'auto'
    }
    const normalized = value.toLowerCase()
    if (normalized === 'v2' || normalized === 'v3') {
        return normalized
    }
    if (normalized === 'auto') {
        return 'auto'
    }
    return 'auto'
}

const resolveChain = (chainParam: string) => {
    const chain = getChainConfig(chainParam)
    if (!chain) {
        throw new Error(`Unsupported chain '${chainParam}'. Supported chains: ${SUPPORTED_CHAINS.join(', ')}`)
    }

    return chain
}

const formatPriceQuote = (chain: ChainConfig, quote: PriceQuote, routePreference: RoutePreference): any => {
    const tokenIn = quote.path[0]!
    const tokenOut = quote.path[quote.path.length - 1]!

    const pathSymbols = quote.path.map((token) => token.symbol ?? token.address)
    const tokenPath = quote.path.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
    }))

    const pools = quote.sources.map((source) => ({
        dexId: source.dexId,
        poolAddress: source.poolAddress,
        feeTier: source.feeTier ?? null,
    }))

    const sourceLabel = pools
        .map((source) => (source.feeTier ? `${source.dexId}@${source.feeTier}` : source.dexId))
        .join(' > ')

    const sources = quote.sources.map((source) => ({
        dexId: source.dexId,
        amountOut: source.amountOut.toString(),
    }))

    const amountInFormatted = formatAmountFromUnits(quote.amountIn, tokenIn.decimals)
    const amountOutFormatted = formatAmountFromUnits(quote.amountOut, tokenOut.decimals)

    const offers = quote.offers?.map(offer => formatPriceQuote(chain, offer, routePreference))

    return {
        chain: chain.key,
        source: sourceLabel,
        path: pathSymbols,
        tokens: tokenPath,
        routeAddresses: quote.routeAddresses,
        priceQ18: quote.priceQ18.toString(),
        midPriceQ18: quote.midPriceQ18.toString(),
        executionPriceQ18: quote.executionPriceQ18.toString(),
        priceImpactBps: quote.priceImpactBps,
        amountIn: quote.amountIn.toString(),
        amountInFormatted,
        amountOut: quote.amountOut.toString(),
        amountOutFormatted,
        liquidityScore: quote.liquidityScore.toString(),
        estimatedGasUnits: quote.estimatedGasUnits ? quote.estimatedGasUnits.toString() : null,
        estimatedGasCostWei: quote.estimatedGasCostWei ? quote.estimatedGasCostWei.toString() : null,
        gasPriceWei: quote.gasPriceWei ? quote.gasPriceWei.toString() : null,
        hopVersions: quote.hopVersions,
        routePreference,
        pools,
        sources,
        offers,
    }
}
export const buildServer = async () => {
    const app = Fastify({
        logger: false,
    })

    await app.register(cors, { origin: true })
    await app.register(rateLimit, {
        max: appConfig.rateLimit.max,
        timeWindow: appConfig.rateLimit.window,
    })

    app.get('/health', async () => ({ status: 'ok' }))

    app.get('/exchange', async (request, reply) => {
        const parsed = chainQuerySchema.safeParse(request.query)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const dexes = exchangeService.listDexes(chain).map((dex) => ({
            id: dex.id,
            label: dex.label,
            protocol: dex.protocol,
            version: dex.version,
            factoryAddress: dex.factoryAddress,
            routerAddress: dex.routerAddress,
            feeTiers: dex.feeTiers ?? [],
        }))

        return {
            chain: chain.key,
            dexes,
        }
    })

    app.get('/token', async (request, reply) => {
        const querySchema = chainQuerySchema.extend({
            address: z.string().refine((value) => isAddress(value, { strict: false }), 'Invalid address'),
        })

        const parsed = querySchema.safeParse(request.query)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const address = normalizeAddress(parsed.data.address).toLowerCase() as Address
        const token = await tokenService.getTokenMetadata(chain, address)

        return {
            chain: chain.key,
            token: {
                address: token.address,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                totalSupply: token.totalSupply ? token.totalSupply.toString() : null,
            },
        }
    })

    app.get('/allowance', async (request, reply) => {
        const querySchema = chainQuerySchema.extend({
            owner: z.string().refine((value) => isAddress(value, { strict: false }), 'Invalid owner address'),
            spender: z.string().refine((value) => isAddress(value, { strict: false }), 'Invalid spender address'),
            tokens: z.string().min(1, 'tokens query parameter is required'),
        })

        const parsed = querySchema.safeParse(request.query)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const owner = normalizeAddress(parsed.data.owner).toLowerCase() as Address
        const spender = normalizeAddress(parsed.data.spender).toLowerCase() as Address
        const tokenList = Array.from(
            new Set(
                parsed.data.tokens
                    .split(',')
                    .map((token) => token.trim())
                    .filter(Boolean)
                    .map((token) => normalizeAddress(token).toLowerCase() as Address),
            ),
        )

        if (!tokenList.length) {
            reply.status(400)
            return { error: 'invalid_request', message: 'tokens query parameter must include at least one token address' }
        }

        const allowances = await allowanceService.getAllowances(chain, owner, spender, tokenList)

        return {
            chain: chain.key,
            owner,
            spender,
            allowances: allowances.map((entry) => ({
                token: entry.token,
                allowance: entry.allowance.toString(),
            })),
        }
    })

    app.post('/approve', async (request, reply) => {
        const bodySchema = z.object({
            chain: z.string().min(1),
            token: z.string().refine((value) => isAddress(value, { strict: false }), 'Invalid token address'),
            spender: z.string().refine((value) => isAddress(value, { strict: false }), 'Invalid spender address'),
            amount: z.string().optional(),
            infinite: z.boolean().optional(),
        })

        const parsed = bodySchema.safeParse(request.body)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const token = normalizeAddress(parsed.data.token).toLowerCase() as Address
        const spender = normalizeAddress(parsed.data.spender).toLowerCase() as Address
        const amountInput = parsed.data.infinite ? 'max' : parsed.data.amount ?? null

        const result = await allowanceService.buildApproveCalldata(chain, token, spender, amountInput)

        return {
            chain: chain.key,
            token: result.token,
            spender: result.spender,
            amount: result.amount.toString(),
            decimals: result.decimals,
            callData: result.callData,
            transaction: {
                to: result.transaction.to,
                data: result.transaction.data,
                value: result.transaction.value.toString(),
            },
        }
    })

    app.get('/price', async (request, reply) => {
        const querySchema = chainQuerySchema.extend({
            tokenA: z.string().refine((value) => isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_ADDRESS.toLowerCase(), 'Invalid tokenA address'),
            tokenB: z.string().refine((value) => isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_ADDRESS.toLowerCase(), 'Invalid tokenB address'),
            amount: z.string().optional(),
            version: z.enum(['auto', 'v2', 'v3']).optional(),
        })

        const parsed = querySchema.safeParse(request.query)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const tokenA = normalizeAddress(parsed.data.tokenA).toLowerCase() as Address
        const tokenB = normalizeAddress(parsed.data.tokenB).toLowerCase() as Address
        const routePreference = resolveRoutePreference(parsed.data.version)

        if (tokenA === tokenB) {
            reply.status(400)
            return { error: 'invalid_request', message: 'tokenA and tokenB must be different' }
        }

        const isNativeAddress = (addr: string) => addr.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
        const effectiveTokenA = isNativeAddress(tokenA) ? chain.wrappedNativeAddress.toLowerCase() as Address : tokenA
        const effectiveTokenB = isNativeAddress(tokenB) ? chain.wrappedNativeAddress.toLowerCase() as Address : tokenB

        if (effectiveTokenA === effectiveTokenB) {
            reply.status(400)
            return { error: 'invalid_request', message: 'tokenA and tokenB must be different' }
        }

        let tokenInMeta: TokenMetadata | undefined
        let tokenOutMeta: TokenMetadata | undefined
        let quote: PriceQuote | null = null

        if (parsed.data.amount) {
            try {
                const metadata = await Promise.all([
                    tokenService.getTokenMetadata(chain, effectiveTokenA),
                    tokenService.getTokenMetadata(chain, effectiveTokenB),
                ])
                tokenInMeta = metadata[0]
                tokenOutMeta = metadata[1]
            } catch (error) {
                reply.status(400)
                return { error: 'token_metadata_error', message: (error as Error).message }
            }

            let amountIn: bigint
            try {
                amountIn = parseAmountToUnits(parsed.data.amount, tokenInMeta.decimals)
            } catch (error) {
                reply.status(400)
                return { error: 'invalid_amount', message: (error as Error).message }
            }

            quote = await priceService.getBestQuoteForTokens(
                chain,
                tokenInMeta,
                tokenOutMeta,
                amountIn,
                routePreference,
            )
        } else {
            quote = await priceService.getBestPrice(chain, effectiveTokenA, effectiveTokenB, undefined, routePreference)
            if (quote) {
                tokenInMeta = quote.path[0]
                tokenOutMeta = quote.path[quote.path.length - 1]
            }
        }

        if (!quote) {
            reply.status(404)
            return { error: 'no_route', message: 'No on-chain route found for the requested pair' }
        }

        return formatPriceQuote(chain, quote, routePreference)
    })

    app.get('/quote', async (request, reply) => {
        const querySchema = chainQuerySchema.extend({
            tokenA: z.string().trim().refine((value) => isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_ADDRESS.toLowerCase(), 'Invalid tokenA address'),
            tokenB: z.string().trim().refine((value) => isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_ADDRESS.toLowerCase(), 'Invalid tokenB address'),
            amount: z.string().min(1, 'Amount is required'),
            slippageBps: z.string().optional(),
            version: z.enum(['auto', 'v2', 'v3']).optional(),
        })

        const parsed = querySchema.safeParse(request.query)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const tokenA = normalizeAddress(parsed.data.tokenA).toLowerCase() as Address
        const tokenB = normalizeAddress(parsed.data.tokenB).toLowerCase() as Address
        const routePreference = resolveRoutePreference(parsed.data.version)

        if (tokenA === tokenB) {
            reply.status(400)
            return { error: 'invalid_request', message: 'tokenA and tokenB must be different' }
        }

        const isNativeAddress = (addr: string) => addr.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
        const effectiveTokenA = isNativeAddress(tokenA) ? chain.wrappedNativeAddress.toLowerCase() as Address : tokenA
        const effectiveTokenB = isNativeAddress(tokenB) ? chain.wrappedNativeAddress.toLowerCase() as Address : tokenB

        if (effectiveTokenA === effectiveTokenB) {
            reply.status(400)
            return { error: 'invalid_request', message: 'tokenA and tokenB must be different' }
        }

        const slippage = parsed.data.slippageBps ? Number(parsed.data.slippageBps) : 50
        if (Number.isNaN(slippage)) {
            reply.status(400)
            return { error: 'invalid_amount', message: 'slippageBps must be numeric' }
        }

        let result: QuoteResult | null = null
        try {
            result = await quoteService.getQuote(
                chain,
                effectiveTokenA,
                effectiveTokenB,
                parsed.data.amount,
                slippage,
                routePreference,
            )
        } catch (error) {
            reply.status(400)
            return { error: 'invalid_request', message: (error as Error).message }
        }

        if (!result) {
            reply.status(404)
            return { error: 'no_route', message: 'No on-chain route found for the requested pair' }
        }

        const { quote, amountOutMin, tokenOut, slippageBps } = result

        const baseResponse = formatPriceQuote(chain, quote, routePreference)
        const amountOutMinFormatted = formatAmountFromUnits(amountOutMin, tokenOut.decimals)

        return {
            ...baseResponse,
            amountOutMin: amountOutMin.toString(),
            amountOutMinFormatted,
            slippageBps,
        }
    })

    app.post('/swap', async (request, reply) => {
        const bodySchema = z.object({
            chain: z.string().min(1),
            tokenA: z.string().trim().refine((value) => {
                const valid = isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
                if (!valid) console.log(`[Validation Failed] tokenA: "${value}" (len: ${value.length})`)
                return valid
            }, 'Invalid tokenA address'),
            tokenB: z.string().trim().refine((value) => {
                const valid = isAddress(value, { strict: false }) || value.toLowerCase() === NATIVE_ADDRESS.toLowerCase()
                if (!valid) console.log(`[Validation Failed] tokenB: "${value}" (len: ${value.length})`)
                return valid
            }, 'Invalid tokenB address'),
            amount: z.string().min(1, 'Amount is required'),
            slippageBps: z.coerce.number().optional(),
            version: z.enum(['auto', 'v2', 'v3']).optional(),
            recipient: z.string().refine((value) => isAddress(value, { strict: false }), 'Invalid recipient address'),
            deadlineSeconds: z.coerce.number().optional(),
        })

        const parsed = bodySchema.safeParse(request.body)
        if (!parsed.success) {
            reply.status(400)
            return { error: 'invalid_request', details: parsed.error.flatten() }
        }

        let chain
        try {
            chain = resolveChain(parsed.data.chain)
        } catch (error) {
            reply.status(400)
            return { error: 'unsupported_chain', message: (error as Error).message }
        }

        const tokenA = normalizeAddress(parsed.data.tokenA).toLowerCase() as Address
        const tokenB = normalizeAddress(parsed.data.tokenB).toLowerCase() as Address
        const recipient = normalizeAddress(parsed.data.recipient)
        const routePreference = resolveRoutePreference(parsed.data.version)

        if (tokenA === tokenB) {
            reply.status(400)
            return { error: 'invalid_request', message: 'tokenA and tokenB must be different' }
        }

        // Handle Native Tokens
        const isNativeAddress = (addr: string) => 
            addr.toLowerCase() === NATIVE_ADDRESS.toLowerCase()

        const useNativeInput = isNativeAddress(tokenA)
        const useNativeOutput = isNativeAddress(tokenB)

        const effectiveTokenA = useNativeInput ? chain.wrappedNativeAddress.toLowerCase() as Address : tokenA
        const effectiveTokenB = useNativeOutput ? chain.wrappedNativeAddress.toLowerCase() as Address : tokenB

        if (effectiveTokenA === effectiveTokenB) {
             // Wrap/Unwrap only
             // TODO: Implement direct wrap/unwrap logic if needed, or let it fail as "no route" for now
             // For now, let's assume the user wants to swap, so if they ask for ETH -> WETH, it's a wrap.
             // But the current quote service might not handle direct wrap/unwrap without a pool.
        }

        const slippageInput = Number.isFinite(parsed.data.slippageBps) ? parsed.data.slippageBps! : undefined
        const slippageBps = slippageInput ?? 50
        const deadlineSeconds = Number.isFinite(parsed.data.deadlineSeconds) ? parsed.data.deadlineSeconds! : 600

        console.log(`[API] Swap request: ${effectiveTokenA} -> ${effectiveTokenB}, Amount: ${parsed.data.amount}`)

        let quoteResult: QuoteResult | null = null
        try {
            quoteResult = await quoteService.getQuote(chain, effectiveTokenA, effectiveTokenB, parsed.data.amount, slippageBps, routePreference)
        } catch (error) {
            reply.status(400)
            return { error: 'invalid_request', message: (error as Error).message }
        }

        if (!quoteResult) {
            reply.status(404)
            return { error: 'no_route', message: 'No on-chain route found for the requested pair' }
        }

        const { quote, amountOutMin, tokenOut, slippageBps: boundedSlippage } = quoteResult

        let transaction
        try {
            transaction = swapBuilder.build(chain, {
                quote,
                amountOutMin,
                recipient,
                slippageBps: boundedSlippage,
                deadlineSeconds,
                useNativeInput,
                useNativeOutput,
            })
        } catch (error) {
            reply.status(400)
            return { error: 'calldata_error', message: (error as Error).message }
        }

        let latestBlockNumber: bigint | null = null
        let latestBlockTimestamp: bigint | null = null
        let estimatedGas: bigint | undefined
        try {
            const client = await chainClientProvider.getClient(chain)
            const latestBlock = await client.getBlock()
            latestBlockNumber = latestBlock.number ?? null
            latestBlockTimestamp = latestBlock.timestamp ?? null

            if (transaction.call) {
                try {
                    estimatedGas = await client.estimateGas({
                        account: recipient,
                        to: transaction.call.to,
                        data: transaction.call.data,
                        value: transaction.call.value,
                    })
                    estimatedGas = (estimatedGas * 120n) / 100n
                } catch (gasError) {
                    request.log.warn({ err: gasError }, 'failed to estimate gas')
                }
            }
        } catch (error) {
            request.log.warn({ err: error }, 'failed to load latest block metadata for quote')
        }

        const quoteTimestamp = Math.floor(Date.now() / 1000)
        const quoteExpiresAt = quoteTimestamp + SWAP_QUOTE_TTL_SECONDS

        const baseResponse = formatPriceQuote(chain, quote, routePreference)
        const amountOutMinFormatted = formatAmountFromUnits(amountOutMin, tokenOut.decimals)

        return {
            ...baseResponse,
            amountOutMin: amountOutMin.toString(),
            amountOutMinFormatted,
            slippageBps: boundedSlippage,
            recipient,
            deadline: transaction.deadline,
            quoteTimestamp,
            quoteExpiresAt,
            quoteValidSeconds: SWAP_QUOTE_TTL_SECONDS,
            quoteBlockNumber: latestBlockNumber ? latestBlockNumber.toString() : null,
            quoteBlockTimestamp: latestBlockTimestamp ? Number(latestBlockTimestamp) : null,
            transaction: {
                kind: transaction.kind,
                dexId: transaction.dexId,
                router: transaction.router,
                spender: transaction.spender,
                amountIn: transaction.amountIn.toString(),
                amountOut: transaction.amountOut.toString(),
                amountOutMinimum: transaction.amountOutMinimum.toString(),
                deadline: transaction.deadline,
                calls: transaction.calls.map((call) => ({
                    target: call.target,
                    allowFailure: call.allowFailure,
                    callData: call.callData,
                    value: (call.value ?? 0n).toString(),
                })),
                call: transaction.call
                    ? {
                        to: transaction.call.to,
                        data: transaction.call.data,
                        value: transaction.call.value.toString(),
                    }
                    : null,
                executor: transaction.executor
                    ? {
                        pulls: transaction.executor.pulls.map((pull) => ({
                            token: pull.token,
                            amount: pull.amount.toString(),
                        })),
                        approvals: transaction.executor.approvals.map((approval) => ({
                            token: approval.token,
                            spender: approval.spender,
                            amount: approval.amount.toString(),
                            revokeAfter: approval.revokeAfter,
                        })),
                        calls: transaction.executor.calls.map((call) => ({
                            target: call.target,
                            value: call.value.toString(),
                            data: call.data,
                        })),
                        tokensToFlush: transaction.executor.tokensToFlush,
                    }
                    : null,
                estimatedGas: estimatedGas?.toString(),
            },
        }
    })

    app.setErrorHandler((error, request, reply) => {
        console.error(error)
        request.log.error(error)
        reply.status(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    })

    return app
}

export const startServer = async () => {
    console.log('Starting server with Native Token support...')
    const app = await buildServer()
    const port = appConfig.server.port
    const host = appConfig.server.host

    try {
        await app.listen({ port, host })
        return app
    } catch (error) {
        app.log.error(error)
        process.exit(1)
    }
}
