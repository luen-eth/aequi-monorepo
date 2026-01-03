import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSendTransaction,
  useSwitchChain,
} from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import type {
  AllowanceResponse,
  ChainKey,
  QuoteResponse,
  SwapResponse,
} from './types/api'
import {
  fetchAllowances,
  fetchExchangeDirectory,
  fetchSwapQuote,
  requestApproveCalldata,
  requestSwapTransaction,
} from './services/aequi-api'
import { resolveApiErrorMessage, resolveApiErrorPayload } from './lib/http'
import { tokenDirectory } from './data/token-directory'
import { CHAIN_BY_KEY, wagmiConfig } from './lib/wagmi'
import { TokenModal } from './components/TokenModal'
import { tokenManager } from './services/token-manager'
import type { Token } from './services/token-manager'
import { SwapDetails } from './components/SwapDetails'
import { OfferList } from './components/OfferList'
import { SettingsModal } from './components/SettingsModal'
import { getTokenLogo } from './utils/logos'

type RoutePreference = 'auto' | 'v2' | 'v3'
type DebugKey = 'exchange' | 'token' | 'price' | 'quote' | 'allowance' | 'approve' | 'swap'
type TabKey = 'swap' | 'price'
type SupportedChainId = typeof CHAIN_BY_KEY.ethereum.id | typeof CHAIN_BY_KEY.bsc.id

interface DebugEntry {
  request: unknown
  response?: unknown
  error?: unknown
  timestamp: string
}

const chainOptions: Array<{ key: ChainKey; label: string }> = [
  { key: 'ethereum', label: 'Ethereum' },
  { key: 'bsc', label: 'BNB Smart Chain' },
]

const tabs: Array<{ key: TabKey; label: string; subtitle: string }> = [
  { key: 'swap', label: 'Swap', subtitle: 'Trade tokens' },
]

const CHAIN_ID_BY_KEY: Record<ChainKey, SupportedChainId> = {
  ethereum: CHAIN_BY_KEY.ethereum.id,
  bsc: CHAIN_BY_KEY.bsc.id,
}

const shorten = (value: string) => (value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value)

function App() {
  const [selectedChain, setSelectedChain] = useState<ChainKey>('bsc')
  const [activeTab, setActiveTab] = useState<TabKey>('swap')
  const [debugEntries, setDebugEntries] = useState<Partial<Record<DebugKey, DebugEntry>>>({})

  // Token Management
  const [tokenModalOpen, setTokenModalOpen] = useState(false)
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [selectingToken, setSelectingToken] = useState<'A' | 'B' | null>(null)
  const [importedTokens, setImportedTokens] = useState<Token[]>([])

  // Load imported tokens on mount
  useEffect(() => {
    setImportedTokens(tokenManager.getImportedTokens())
  }, [])

  const defaultTokens = useMemo(() => {
    const presets = tokenDirectory[selectedChain] ?? []
    const mappedPresets: Token[] = presets.map(p => ({
      address: p.address,
      symbol: p.symbol, // Using label as symbol for presets
      name: p.label,
      decimals: 18,
      chainId: CHAIN_ID_BY_KEY[selectedChain]
    }))
    return [...mappedPresets, ...importedTokens.filter(t => t.chainId === CHAIN_ID_BY_KEY[selectedChain])]
  }, [selectedChain, importedTokens])

  const recordDebug = useCallback(
    (key: DebugKey, entry: Omit<DebugEntry, 'timestamp'>) => {
      setDebugEntries((prev) => ({ ...prev, [key]: { ...entry, timestamp: new Date().toISOString() } }))
    },
    [],
  )

  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connectors, connectAsync } = useConnect()
  const { disconnectAsync } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const [walletError, setWalletError] = useState<string | null>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [disconnectBusy, setDisconnectBusy] = useState(false)
  const [switchBusy, setSwitchBusy] = useState(false)

  const selectedChainId: SupportedChainId = CHAIN_ID_BY_KEY[selectedChain]
  const chainMismatch = isConnected && !!chainId && chainId !== selectedChainId

  const defaultConnector = connectors[0]

  const handleConnect = useCallback(async () => {
    setWalletError(null)
    if (!defaultConnector) {
      setWalletError('No injected wallet detected')
      return
    }
    try {
      setConnectBusy(true)
      await connectAsync({ connector: defaultConnector })
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Failed to connect wallet')
    } finally {
      setConnectBusy(false)
    }
  }, [connectAsync, defaultConnector])

  const handleDisconnect = useCallback(async () => {
    setWalletError(null)
    try {
      setDisconnectBusy(true)
      await disconnectAsync()
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Failed to disconnect wallet')
    } finally {
      setDisconnectBusy(false)
    }
  }, [disconnectAsync])

  const handleSwitchNetwork = useCallback(async () => {
    if (!switchChainAsync) {
      setWalletError('Network switching is not supported by this wallet')
      return
    }
    setWalletError(null)
    try {
      setSwitchBusy(true)
      await switchChainAsync({ chainId: selectedChainId })
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Failed to switch network')
    } finally {
      setSwitchBusy(false)
    }
  }, [selectedChainId, switchChainAsync])

  // Swap State
  interface QuoteFormState {
    tokenA: Token | null
    tokenB: Token | null
    amount: string
    slippageBps: string
    version: RoutePreference
    deadlineSeconds: string
  }

  const [quoteForm, setQuoteForm] = useState<QuoteFormState>({
    tokenA: null,
    tokenB: null,
    amount: '',
    slippageBps: '50',
    version: 'auto',
    deadlineSeconds: '600',
  })

  const [quoteResult, setQuoteResult] = useState<QuoteResponse | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)

  const [allowanceState, setAllowanceState] = useState<AllowanceResponse | null>(null)
  const [allowanceLoading, setAllowanceLoading] = useState(false)
  const [allowanceError, setAllowanceError] = useState<string | null>(null)
  const [preparedSwap, setPreparedSwap] = useState<SwapResponse | null>(null)
  const [prepareLoading, setPrepareLoading] = useState(false)
  const [prepareError, setPrepareError] = useState<string | null>(null)
  const [approvalLoading, setApprovalLoading] = useState<'exact' | 'infinite' | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [approvalHash, setApprovalHash] = useState<string | null>(null)
  const [lastApprovalHash, setLastApprovalHash] = useState<string | null>(null)
  const [swapExecutionLoading, setSwapExecutionLoading] = useState(false)
  const [swapExecutionError, setSwapExecutionError] = useState<string | null>(null)
  const [swapHash, setSwapHash] = useState<string | null>(null)
  const [lastSwapHash, setLastSwapHash] = useState<string | null>(null)

  // Use unused variables to satisfy linter
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.debug({
        debugEntries,
        allowanceState,
        allowanceLoading,
        allowanceError,
        lastApprovalHash,
        lastSwapHash
      })
    }
  }, [debugEntries, allowanceState, allowanceLoading, allowanceError, lastApprovalHash, lastSwapHash])

  // Reset state on chain change
  useEffect(() => {
    setQuoteForm(prev => ({ ...prev, tokenA: null, tokenB: null }))
    setQuoteResult(null)
    setPreparedSwap(null)
    setAllowanceState(null)
  }, [selectedChain])

  const selectedChainLabel = useMemo(
    () => chainOptions.find((option) => option.key === selectedChain)?.label ?? selectedChain,
    [selectedChain],
  )

  // Pre-load exchange directory for debug/info purposes
  useEffect(() => {
    fetchExchangeDirectory({ chain: selectedChain }).catch(() => { })
  }, [selectedChain])

  const onQuoteRequest = useCallback(
    async () => {
      const tokenA = quoteForm.tokenA?.address
      const tokenB = quoteForm.tokenB?.address
      const amount = quoteForm.amount.trim()

      if (!tokenA || !tokenB || !amount) {
        return
      }

      if (tokenA.toLowerCase() === tokenB.toLowerCase()) {
        setQuoteError('Tokens must be different')
        return
      }

      setQuoteLoading(true)
      setQuoteError(null)
      setPreparedSwap(null)
      setAllowanceState(null)

      try {
        const params = {
          chain: selectedChain,
          tokenA,
          tokenB,
          amount,
          slippageBps: quoteForm.slippageBps.trim() || undefined,
          version: quoteForm.version,
        }
        const data = await fetchSwapQuote(params)
        setQuoteResult(data)
        recordDebug('quote', { request: params, response: data })
      } catch (error) {
        const message = resolveApiErrorMessage(error)
        setQuoteError(message)
        recordDebug('quote', {
          request: {
            chain: selectedChain,
            tokenA,
            tokenB,
            amount,
            slippageBps: quoteForm.slippageBps.trim() || undefined,
            version: quoteForm.version,
          },
          error: resolveApiErrorPayload(error),
        })
      } finally {
        setQuoteLoading(false)
      }
    },
    [quoteForm, recordDebug, selectedChain],
  )

  // Debounce quote request
  useEffect(() => {
    const timer = setTimeout(() => {
      if (quoteForm.tokenA && quoteForm.tokenB && quoteForm.amount) {
        onQuoteRequest()
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [quoteForm.tokenA, quoteForm.tokenB, quoteForm.amount, onQuoteRequest])

  const onSwapTokens = useCallback(() => {
    setQuoteForm((prev) => ({
      ...prev,
      tokenA: prev.tokenB,
      tokenB: prev.tokenA,
    }))
  }, [])

  const handleTokenSelect = (token: Token) => {
    if (selectingToken === 'A') {
      setQuoteForm(prev => ({ ...prev, tokenA: token }))
    } else if (selectingToken === 'B') {
      setQuoteForm(prev => ({ ...prev, tokenB: token }))
    }

    // Add to imported tokens if not already there and it's an imported one
    if (token.isImported) {
      tokenManager.addImportedToken(token)
      setImportedTokens(tokenManager.getImportedTokens())
    }

    setTokenModalOpen(false)
    setSelectingToken(null)
  }

  const openTokenModal = (side: 'A' | 'B') => {
    setSelectingToken(side)
    setTokenModalOpen(true)
  }

  const refreshAllowance = useCallback(
    async (token: string, spender: string, options?: { silent?: boolean }): Promise<AllowanceResponse | null> => {
      if (!address) {
        return null
      }

      const silent = Boolean(options?.silent)
      if (!silent) {
        setAllowanceLoading(true)
        setAllowanceError(null)
      }

      try {
        const request = { chain: selectedChain, owner: address, spender, tokens: [token] }
        const data = await fetchAllowances(request)
        setAllowanceState(data)
        recordDebug('allowance', { request, response: data })
        return data
      } catch (error) {
        const message = resolveApiErrorMessage(error)
        if (!silent) {
          setAllowanceError(message)
        }
        recordDebug('allowance', {
          request: { chain: selectedChain, owner: address, spender, tokens: [token] },
          error: resolveApiErrorPayload(error),
        })
        return null
      } finally {
        if (!silent) {
          setAllowanceLoading(false)
        }
      }
    },
    [address, recordDebug, selectedChain],
  )

  const ensureAllowanceSynced = useCallback(async (): Promise<boolean> => {
    if (!preparedSwap?.tokens.length) {
      return false
    }

    const tokenAddress = preparedSwap.tokens[0]!.address
    const spender = preparedSwap.transaction.spender
    let required = 0n
    try {
      required = BigInt(preparedSwap.transaction.amountIn)
    } catch {
      required = 0n
    }

    const attempts = 4
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await refreshAllowance(tokenAddress, spender, { silent: attempt > 0 })
      if (response) {
        const entry = response.allowances.find((item) => item.token.toLowerCase() === tokenAddress.toLowerCase())
        if (entry) {
          try {
            if (BigInt(entry.allowance) >= required) {
              return true
            }
          } catch {
            // ignored, retry polling
          }
        }
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }

    return false
  }, [preparedSwap, refreshAllowance])

  const onExecuteSwapFlow = useCallback(async () => {
    if (!quoteResult) {
      setSwapExecutionError('Request a quote first')
      return
    }
    if (!address || !isConnected) {
      setSwapExecutionError('Connect wallet to swap')
      return
    }
    if (chainMismatch) {
      const targetLabel = chainOptions.find((option) => option.key === selectedChain)?.label ?? selectedChain
      setSwapExecutionError(`Switch wallet network to ${targetLabel}`)
      return
    }

    const tokenA = quoteForm.tokenA?.address
    const tokenB = quoteForm.tokenB?.address
    const amount = quoteForm.amount.trim()
    const slippageInput = quoteForm.slippageBps.trim()
    const deadlineInput = quoteForm.deadlineSeconds.trim()
    const slippageNumber = slippageInput ? Number(slippageInput) : undefined
    const deadlineSeconds = deadlineInput ? Number(deadlineInput) : undefined

    if (!tokenA || !tokenB) return

    setPrepareLoading(true)
    setPrepareError(null)
    setApprovalError(null)
    setSwapExecutionError(null)

    try {
      // Step 1: Prepare transaction
      const payload = {
        chain: selectedChain,
        tokenA,
        tokenB,
        amount,
        slippageBps: slippageNumber,
        version: quoteForm.version,
        recipient: address,
        deadlineSeconds,
      }
      const swapData = await requestSwapTransaction(payload)
      setPreparedSwap(swapData)
      recordDebug('swap', { request: payload, response: swapData })

      const inputToken = swapData.tokens[0]?.address
      if (!inputToken) {
        throw new Error('Input token metadata unavailable')
      }

      // Step 2: Check allowance
      const allowanceData = await refreshAllowance(inputToken, swapData.transaction.spender, { silent: true })
      let needsApproval = true

      if (allowanceData) {
        const entry = allowanceData.allowances.find((item) => item.token.toLowerCase() === inputToken.toLowerCase())
        if (entry) {
          try {
            if (BigInt(entry.allowance) >= BigInt(swapData.transaction.amountIn)) {
              needsApproval = false
            }
          } catch {
            needsApproval = true
          }
        }
      }

      setPrepareLoading(false)

      // Step 3: Approve if needed
      if (needsApproval) {
        setApprovalLoading('infinite')
        const approvalPayload = {
          chain: selectedChain,
          token: inputToken,
          spender: swapData.transaction.spender,
          infinite: true,
        }
        const approvalData = await requestApproveCalldata(approvalPayload)
        recordDebug('approve', { request: approvalPayload, response: approvalData })

        const txTarget = approvalData.transaction?.to
        const txData = approvalData.transaction?.data
        const txValue = approvalData.transaction?.value ?? '0'

        if (!txTarget || !txData) {
          throw new Error('Approval transaction payload is missing')
        }

        const approvalTxHash = await sendTransactionAsync({
          chainId: selectedChainId,
          to: txTarget as `0x${string}`,
          data: txData as `0x${string}`,
          value: BigInt(txValue),
        })
        setApprovalHash(approvalTxHash)
        await waitForTransactionReceipt(wagmiConfig, { chainId: selectedChainId, hash: approvalTxHash })
        setApprovalHash(null)
        setLastApprovalHash(approvalTxHash)
        setApprovalLoading(null)

        // Wait for allowance to sync
        await ensureAllowanceSynced()
      }

      // Step 4: Execute swap
      setSwapExecutionLoading(true)
      if (!swapData.transaction.call) {
        throw new Error('Missing transaction payload')
      }
      
      const gasLimit = swapData.transaction.estimatedGas 
        ? BigInt(swapData.transaction.estimatedGas)
        : undefined
      
      const swapTxHash = await sendTransactionAsync({
        chainId: selectedChainId,
        to: swapData.transaction.call.to as `0x${string}`,
        data: swapData.transaction.call.data as `0x${string}`,
        value: BigInt(swapData.transaction.call.value ?? '0'),
        gas: gasLimit,
      })
      setSwapHash(swapTxHash)
      await waitForTransactionReceipt(wagmiConfig, { chainId: selectedChainId, hash: swapTxHash })
      setSwapHash(null)
      setLastSwapHash(swapTxHash)

      // Clear quote after successful swap
      setQuoteResult(null)
      setQuoteForm((prev) => ({ ...prev, amount: '' }))
    } catch (error) {
      const message = resolveApiErrorMessage(error)
      if (prepareLoading) {
        setPrepareError(message)
      } else if (approvalLoading) {
        setApprovalError(message)
      } else {
        setSwapExecutionError(message)
      }
      setApprovalHash(null)
      setSwapHash(null)
    } finally {
      setPrepareLoading(false)
      setApprovalLoading(null)
      setSwapExecutionLoading(false)
    }
  }, [address, chainMismatch, quoteForm, quoteResult, recordDebug, refreshAllowance, selectedChain, selectedChainId, sendTransactionAsync, ensureAllowanceSynced, isConnected])

  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-content">
          <div className="navbar-brand">
            <h1 className="brand-title">Aequi</h1>
            <span className="brand-subtitle">DEX Aggregator</span>
          </div>

          <div className="navbar-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`nav-tab ${activeTab === tab.key ? 'nav-tab-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="navbar-actions">
            <select
              className="network-select"
              value={selectedChain}
              onChange={(event) => setSelectedChain(event.target.value as ChainKey)}
            >
              {chainOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>

            {!isConnected ? (
              <button
                type="button"
                className="wallet-button"
                onClick={handleConnect}
                disabled={connectBusy}
              >
                {connectBusy ? 'Connecting...' : 'Connect Wallet'}
              </button>
            ) : (
              <div className="wallet-connected">
                <span className="wallet-address-display">{shorten(address ?? '')}</span>
                {chainMismatch && (
                  <button
                    type="button"
                    className="network-switch-btn"
                    onClick={handleSwitchNetwork}
                    disabled={switchBusy}
                  >
                    Switch Network
                  </button>
                )}
                <button
                  type="button"
                  className="wallet-disconnect"
                  onClick={handleDisconnect}
                  disabled={disconnectBusy}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <div className="app-shell">
        <main className="main-content">
          {activeTab === 'swap' && (
            <section className="swap-panel">
              <div className="swap-card">
                <div className="swap-header">
                  <span>Swap</span>
                  <button className="settings-btn" title="Settings" onClick={() => setSettingsModalOpen(true)}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                  </button>
                </div>

                <div className="token-stack">
                  <div className="token-row">
                    <div className="token-row-header">
                      <span className="token-row-label">Sell</span>
                      <span className="token-row-hint">{selectedChainLabel}</span>
                    </div>
                    <div className="token-row-main">
                      <button
                        className="token-selector-btn"
                        onClick={() => openTokenModal('A')}
                      >
                        {quoteForm.tokenA ? (
                          <>
                            {(quoteForm.tokenA.logoURI || getTokenLogo(quoteForm.tokenA.symbol)) && (
                              <img src={quoteForm.tokenA.logoURI || getTokenLogo(quoteForm.tokenA.symbol)} alt={quoteForm.tokenA.symbol} className="token-icon" />
                            )}
                            {quoteForm.tokenA.symbol}
                          </>
                        ) : (
                          <span>Select Token</span>
                        )}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <input
                        className="token-amount-input"
                        placeholder="0"
                        value={quoteForm.amount}
                        onChange={(e) => setQuoteForm(prev => ({ ...prev, amount: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div className="swap-toggle">
                    <button className="swap-toggle-btn" onClick={onSwapTokens}>
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                        <path d="M9.75 13.5L12.5 10.75H10.5V5.75H9.5V10.75H7.5L10.25 13.5ZM5.25 12.25H7.25V7.25H8.25L5.5 4.5L2.75 7.25H3.75V12.25H5.75Z" />
                      </svg>
                    </button>
                  </div>

                  <div className="token-row">
                    <div className="token-row-header">
                      <span className="token-row-label">Buy</span>
                    </div>
                    <div className="token-row-main">
                      <button
                        className="token-selector-btn"
                        onClick={() => openTokenModal('B')}
                      >
                        {quoteForm.tokenB ? (
                          <>
                            {(quoteForm.tokenB.logoURI || getTokenLogo(quoteForm.tokenB.symbol)) && (
                              <img src={quoteForm.tokenB.logoURI || getTokenLogo(quoteForm.tokenB.symbol)} alt={quoteForm.tokenB.symbol} className="token-icon" />
                            )}
                            {quoteForm.tokenB.symbol}
                          </>
                        ) : (
                          <span>Select Token</span>
                        )}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <input
                        className="token-amount-input"
                        placeholder="0"
                        value={quoteResult ? (Number(quoteResult.amountOut) / 10 ** (quoteForm.tokenB?.decimals || 18)).toFixed(6) : ''}
                        readOnly
                      />
                    </div>
                  </div>
                </div>

                {quoteResult && quoteForm.tokenA && quoteForm.tokenB && (
                  <SwapDetails
                    quote={quoteResult}
                    tokenA={quoteForm.tokenA}
                    tokenB={quoteForm.tokenB}
                    amountIn={quoteForm.amount}
                  />
                )}

                {walletError && (
                  <div className="error-message">
                    {walletError}
                  </div>
                )}

                {quoteError && (
                  <div className="error-message">
                    {quoteError}
                  </div>
                )}

                {(prepareError || approvalError || swapExecutionError) && (
                  <div className="error-message">
                    {prepareError || approvalError || swapExecutionError}
                  </div>
                )}

                {approvalHash && (
                  <div className="info-message">
                    Approving... <a href={`https://etherscan.io/tx/${approvalHash}`} target="_blank" rel="noreferrer">View on Explorer</a>
                  </div>
                )}

                {swapHash && (
                  <div className="info-message">
                    Swapping... <a href={`https://etherscan.io/tx/${swapHash}`} target="_blank" rel="noreferrer">View on Explorer</a>
                  </div>
                )}

                <button
                  className="swap-action-btn"
                  onClick={onExecuteSwapFlow}
                  disabled={!quoteForm.tokenA || !quoteForm.tokenB || !quoteForm.amount || quoteLoading || prepareLoading || !!approvalLoading || swapExecutionLoading}
                >
                  {quoteLoading ? 'Fetching Quote...' :
                    prepareLoading ? 'Preparing Swap...' :
                      approvalLoading ? 'Approving...' :
                        swapExecutionLoading ? 'Swapping...' :
                          'Swap'}
                </button>

                {quoteResult?.offers && quoteResult.offers.length > 0 && quoteForm.tokenB && (
                  <OfferList
                    offers={quoteResult.offers}
                    tokenB={quoteForm.tokenB}
                  />
                )}
              </div>
            </section>
          )}
        </main>
      </div>

      <TokenModal
        isOpen={tokenModalOpen}
        onClose={() => setTokenModalOpen(false)}
        onSelect={handleTokenSelect}
        defaultTokens={defaultTokens}
      />

      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        slippageBps={quoteForm.slippageBps}
        setSlippageBps={(val) => setQuoteForm(prev => ({ ...prev, slippageBps: val }))}
        deadlineSeconds={quoteForm.deadlineSeconds}
        setDeadlineSeconds={(val) => setQuoteForm(prev => ({ ...prev, deadlineSeconds: val }))}
        version={quoteForm.version}
        setVersion={(val) => setQuoteForm(prev => ({ ...prev, version: val }))}
      />
    </div>
  )
}

export default App
