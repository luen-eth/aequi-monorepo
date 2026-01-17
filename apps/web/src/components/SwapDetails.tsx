import { useState } from 'react'
import type { QuoteResponse } from '../types/api'
import type { Token } from '../services/token-manager'

interface SwapDetailsProps {
    quote: QuoteResponse
    tokenA: Token
    tokenB: Token
    amountIn: string
}

export function SwapDetails({ quote, tokenA, tokenB, amountIn }: SwapDetailsProps) {
    const [inverted, setInverted] = useState(false)
    const [expanded, setExpanded] = useState(false)

    const amountOut = Number(quote.amountOut) / 10 ** tokenB.decimals
    const amountInNum = Number(amountIn)

    const rate = amountOut / amountInNum
    const invertedRate = 1 / rate

    const displayRate = inverted
        ? `1 ${tokenB.symbol} = ${invertedRate.toFixed(6)} ${tokenA.symbol}`
        : `1 ${tokenA.symbol} = ${rate.toFixed(6)} ${tokenB.symbol}`

    const priceImpact = quote.priceImpactBps / 100
    const priceImpactColor = priceImpact > 5 ? 'var(--danger-color)' : priceImpact > 1 ? '#e6a23c' : 'var(--text-secondary)'

    // Estimate gas cost in ETH (very rough approximation if not provided)
    const gasCost = quote.estimatedGasCostWei
        ? (Number(quote.estimatedGasCostWei) / 10 ** 18).toFixed(6)
        : quote.estimatedGasUnits
            ? (Number(quote.estimatedGasUnits) * (Number(quote.gasPriceWei || 3000000000)) / 10 ** 18).toFixed(6)
            : 'Unknown'

    return (
        <div className="swap-details-card">
            <div className="swap-details-header" onClick={() => setExpanded(!expanded)}>
                <div className="rate-container" onClick={(e) => { e.stopPropagation(); setInverted(!inverted); }}>
                    <span className="rate-text">{displayRate}</span>
                    <svg
                        className="invert-icon"
                        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ transform: 'rotate(90deg)' }}
                    >
                        <path d="M7 16V4M7 4L3 8M7 4L11 8M17 8V20M17 20L21 16M17 20L13 16" />
                    </svg>
                </div>
                <div className="expand-icon">
                    <svg
                        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                    >
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </div>
            </div>

            <div className={`swap-details-content ${expanded ? 'expanded' : ''}`}>
                <div className="detail-row">
                    <span>Price Impact</span>
                    <span style={{ color: priceImpactColor }}>{priceImpact.toFixed(2)}%</span>
                </div>
                {quote.fee && (
                    <div className="detail-row">
                        <span>Platform Fee</span>
                        <span>{(quote.fee.bps / 100).toFixed(2)}% ({quote.fee.amountFormatted} {tokenB.symbol})</span>
                    </div>
                )}
                <div className="detail-row">
                    <span>Network Cost</span>
                    <div className="gas-cost">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <path d="M16 10a4 4 0 0 1-8 0"></path>
                        </svg>
                        <span>~{gasCost} ETH</span>
                    </div>
                </div>
                <div className="detail-row">
                    <span>Minimum Received</span>
                    <span>{(Number(quote.amountOutMin) / 10 ** tokenB.decimals).toFixed(6)} {tokenB.symbol}</span>
                </div>
                {quote.amountOutAfterFee && (
                    <div className="detail-row">
                        <span>You Receive (after fee)</span>
                        <span style={{ color: 'var(--success-color)' }}>{quote.amountOutAfterFeeFormatted} {tokenB.symbol}</span>
                    </div>
                )}
                <div className="detail-row">
                    <span>Route</span>
                    <span>{quote.routePreference.toUpperCase()}</span>
                </div>
            </div>
        </div>
    )
}
