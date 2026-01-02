import { Buffer } from 'node:buffer'
import { erc20Abi, getAddress, type Address, type PublicClient } from 'viem'
import { DEFAULT_TOKEN_CACHE_TTL_MS, INTERMEDIATE_TOKENS } from '../../config/constants'
import type { ChainConfig, TokenMetadata } from '../../types'
import type { IChainClientProvider } from '../clients/types'
import { DefaultChainClientProvider } from '../clients/default-chain-client-provider'

interface CachedToken {
  value: TokenMetadata
  expiresAt: number
}

const now = () => Date.now()

const decodeString = (value: unknown, fallback: string): string => {
  if (typeof value === 'string') {
    if (!value.startsWith('0x')) {
      return value
    }
    const hex = value.slice(2)
    if (hex.length === 0 || hex === ''.padEnd(hex.length, '0')) {
      return fallback
    }
    try {
      const trimmed = hex.replace(/00+$/, '')
      const buffer = Buffer.from(trimmed, 'hex')
      const decoded = buffer.toString('utf8').replace(/\u0000/g, '')
      return decoded.length ? decoded : fallback
    } catch (error) {
      return fallback
    }
  }
  return fallback
}

export class TokenService {
  private readonly cache = new Map<string, CachedToken>()

  constructor(
    private readonly clientProvider: IChainClientProvider = new DefaultChainClientProvider(),
    private readonly ttlMs = DEFAULT_TOKEN_CACHE_TTL_MS,
  ) {
    this.seedIntermediates()
  }

  private seedIntermediates() {
    Object.values(INTERMEDIATE_TOKENS).forEach((tokens) => {
      tokens.forEach((token) => {
        const checksum = getAddress(token.address)
        const key = this.cacheKey(token.chainId, checksum)
        this.cache.set(key, {
          value: { ...token, address: checksum, totalSupply: null },
          expiresAt: now() + this.ttlMs,
        })
      })
    })
  }

  private cacheKey(chainId: number, address: Address) {
    return `${chainId}:${address.toLowerCase()}`
  }

  private getClient(chain: ChainConfig): Promise<PublicClient> {
    return this.clientProvider.getClient(chain)
  }

  async getTokenMetadata(chain: ChainConfig, address: Address): Promise<TokenMetadata> {
    const normalized = getAddress(address)
    const key = this.cacheKey(chain.id, normalized)
    const cached = this.cache.get(key)

    if (cached && cached.expiresAt > now()) {
      return cached.value
    }

  const client = await this.getClient(chain)

    const [symbolResult, nameResult, decimalsResult, supplyResult] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: normalized, abi: erc20Abi, functionName: 'symbol' },
        { address: normalized, abi: erc20Abi, functionName: 'name' },
        { address: normalized, abi: erc20Abi, functionName: 'decimals' },
        { address: normalized, abi: erc20Abi, functionName: 'totalSupply' },
      ],
    })

    const symbol = decodeString(symbolResult.result, 'UNKNOWN')
    const name = decodeString(nameResult.result, symbol)
    const decimalsRaw = decimalsResult.status === 'success' ? decimalsResult.result : null
    const totalSupply = supplyResult.status === 'success' ? (supplyResult.result as bigint) : null

    if (decimalsRaw === null) {
      throw new Error(`Failed to fetch decimals for token ${address} on chain ${chain.name}`)
    }

    const metadata: TokenMetadata = {
      chainId: chain.id,
      address: normalized,
      symbol,
      name,
      decimals: Number(decimalsRaw),
      totalSupply,
    }

    this.cache.set(key, {
      value: metadata,
      expiresAt: now() + this.ttlMs,
    })

    return metadata
  }
}
