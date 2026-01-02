import { getAddress } from 'viem'
import type { Address } from 'viem'

export const clampSlippage = (value: number): number => {
  if (!Number.isFinite(value) || Number.isNaN(value) || value < 0) {
    return 0
  }
  if (value > 5000) {
    return 5000
  }
  return Math.floor(value)
}

export const normalizeAddress = (value: Address | string): Address => getAddress(value as Address)
