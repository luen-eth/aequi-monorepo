import type { PublicClient } from 'viem'
import type { ChainConfig } from '../../types'

export interface IChainClientProvider {
  getClient(chain: ChainConfig): Promise<PublicClient>
}

export interface IRpcSelector {
  resolveRpcUrls(chain: ChainConfig): Promise<string[]>
}
