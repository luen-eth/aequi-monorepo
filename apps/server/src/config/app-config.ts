import { getAddress } from 'viem'
import type { Address } from 'viem'

const parseUrlList = (value: string | undefined): string[] =>
  value?.split(',').map((url) => url.trim()).filter(Boolean) ?? []

const parseAddressOrNull = (value: string | undefined): Address | null => {
  if (!value) {
    return null
  }
  try {
    return getAddress(value)
  } catch (error) {
    console.warn(`[config] invalid address '${value}':`, (error as Error).message)
    return null
  }
}

const parseAddressWithFallback = (value: string | undefined, fallback: Address): Address => {
  const parsed = parseAddressOrNull(value)
  return parsed ?? fallback
}

const parseIntWithDefault = (value: string | undefined, fallback: number, min: number): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  if (parsed < min) {
    return fallback
  }
  return parsed
}

const DEFAULTS = {
  server: {
    port: 3000,
    host: '0.0.0.0',
    rateLimitMax: 120,
    rateLimitWindow: '1 minute',
  },
  executor: {
    interhopBufferBps: 3,
    quoteTtlSeconds: 15,
    bscAddress: '0x70aC53219E200B63dBf0218Cb0EC9567d091d26A' as Address,
  },
  dex: {
    uniswapV2Factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6' as Address,
    uniswapV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' as Address,
  },
}

const NODE_ENV = process.env.NODE_ENV ?? 'development'

export const appConfig = {
  env: NODE_ENV,
  server: {
    port: parseIntWithDefault(process.env.PORT, DEFAULTS.server.port, 1),
    host: process.env.HOST ?? DEFAULTS.server.host,
    loggerEnabled: NODE_ENV !== 'test',
  },
  rateLimit: {
    max: parseIntWithDefault(process.env.RATE_LIMIT_MAX, DEFAULTS.server.rateLimitMax, 1),
    window: process.env.RATE_LIMIT_WINDOW ?? DEFAULTS.server.rateLimitWindow,
  },
  rpc: {
    ethereum: parseUrlList(process.env.RPC_URL_ETH),
    ethereumFallback: parseUrlList(process.env.RPC_URL_ETH_FALLBACK),
    bsc: parseUrlList(process.env.BSC_RPC_URL),
    bscFallback: parseUrlList(process.env.BSC_RPC_URL_FALLBACK),
  },
  dex: {
    uniswapV2Factory: parseAddressWithFallback(process.env.UNISWAP_V2_FACTORY, DEFAULTS.dex.uniswapV2Factory),
    uniswapV2Router: parseAddressWithFallback(process.env.UNISWAP_V2_ROUTER, DEFAULTS.dex.uniswapV2Router),
  },
  executor: {
    eth: parseAddressOrNull(process.env.AEQUI_EXECUTOR_ETH),
    bsc: parseAddressOrNull(process.env.AEQUI_EXECUTOR_BSC) ?? DEFAULTS.executor.bscAddress,
    interhopBufferBps: parseIntWithDefault(process.env.EXECUTOR_INTERHOP_BUFFER_BPS, DEFAULTS.executor.interhopBufferBps, 0),
  },
  swap: {
    quoteTtlSeconds: parseIntWithDefault(process.env.SWAP_QUOTE_TTL_SECONDS, DEFAULTS.executor.quoteTtlSeconds, 1),
  },
} as const

export type AppConfig = typeof appConfig
