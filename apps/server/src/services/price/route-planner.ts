import type { PriceQuote } from '../../types'
import { compareQuotes } from './quote-math'

export const selectBestQuote = (quotes: PriceQuote[]): PriceQuote | null => {
  if (!quotes.length) {
    return null
  }
  const [best] = quotes.sort(compareQuotes)
  return best ?? null
}
