import type { PublicClient } from 'viem'
import type { ChainConfig } from '../../types'
import { getPublicClient } from '../../utils/clients'
import type { IChainClientProvider } from './types'

export class DefaultChainClientProvider implements IChainClientProvider {
  getClient(chain: ChainConfig): Promise<PublicClient> {
    return getPublicClient(chain)
  }
}
