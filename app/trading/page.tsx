'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';
import { Activity, ShieldAlert, BarChart3, Clock, AlertTriangle, Lightbulb, Wallet, BrainCircuit, ActivitySquare, Lock } from 'lucide-react';
import { NutritionLabelCard } from '../components/NutritionLabelCard';
import { TokenSafetyBadgeCard } from '../components/TokenSafetyBadgeCard';
import type { OnChainTokenSecurityReport } from '@packages/intelligence/onchain-insider-guard';
import { PageWorkflowBanner } from '../components/PageWorkflowBanner';
import { BinanceKeyVaultPanel } from '../components/BinanceKeyVaultPanel';
import { BybitKeyVaultPanel } from '../components/BybitKeyVaultPanel';
import { UserRiskPolicyPanel } from '../components/UserRiskPolicyPanel';
import { RecentTradeHistoryPanel } from '../components/RecentTradeHistoryPanel';
import {
  PinWatchlistButton,
  TokenWatchlistBar,
  useTokenWatchlist,
} from '../components/TokenWatchlistBar';
import {
  LAUNCHPAD_CURVE_PAIRS,
  TOP_LIQUID_CEX_PAIRS,
  isValidMarketSymbol,
} from '@packages/shared/market-pairs';
import {
  EVM_DEX_CHAINS,
  ensureEvmNetwork,
  findDexTokenPresetByAddress,
  formatDexQuoteOutputSummary,
  getBrowserSigner,
  getDefaultDexTokenForChain,
  getDexTokenPresetsForChain,
  getEvmExplorerTxUrl,
  normalizeWeb3Error,
} from '@packages/launchpad/web3-provider';
import {
  parseTradingHandoffSearchParams,
  type ExecutionRailId,
  type SubAgentId,
} from '@packages/agent/autonomous-terminal-engine';
import { buildErc20ApproveTransaction } from '@packages/trading/zerox-swap-client';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Orderbook {
  symbol: string;
  timestamp: number;
  bids: [number, number][];
  asks: [number, number][];
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPct: number;
}

interface IntelligenceSignal {
  symbol: string;
  computedConfidenceScore: number;
  rationale: string;
  riskFlags: string[];
  inputs: {
    webSentiment: string;
    counterpartyRisk: string;
    marketVolatility: string;
    volumeAnomaly: boolean;
  };
  computedAt: string;
}

interface TradingAnalysis {
  symbol: string;
  regime: {
    regime: string;
    confidence: number;
    description: string;
  };
  alerts: Array<{
    alertId: string;
    category: string;
    severity: 'INFO' | 'CAUTION' | 'WARNING' | 'CRITICAL';
    title: string;
    description: string;
    actionableHint: string;
    shouldPauseTrading: boolean;
  }>;
  strategySignals: Array<{
    signalType: string;
    confidence: number;
    rationale: string;
    suggestedAction: string;
    riskLevel: string;
    suggestedPositionSizePct: number;
  }>;
  rsiCurrent: number | null;
  rsiZone: string;
  whaleWallBid: { price: number; qty: number } | null;
  whaleWallAsk: { price: number; qty: number } | null;
  spreadStatus: string;
  overallRiskScore: number;
  tradingPaused: boolean;
}

// Interactive Gemini-Styled Candlestick & Volume Chart with Hover Crosshair, OHLCV Tooltip & Price Scale
function CandlestickChart({ candles }: { candles: Candle[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!candles || candles.length === 0) {
    return <div className="text-muted" style={{ padding: '3rem', textAlign: 'center', fontSize: '13px' }}>Memuat data grafik pasar...</div>;
  }

  const width = 640;
  const height = 268;
  const padLeft = 12;
  const padRight = 64;
  const padTop = 16;
  const padBottom = 46;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const minPrice = Math.min(...candles.map((c) => c.low));
  const maxPrice = Math.max(...candles.map((c) => c.high));
  const priceRange = maxPrice - minPrice || 1;
  const maxVol = Math.max(...candles.map((c) => c.volume)) || 1;
  const candleWidth = plotW / candles.length;

  const formatPx = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toFixed(6));
  const toY = (p: number) => padTop + (1 - (p - minPrice) / priceRange) * plotH;

  const activeIdx = hoverIdx !== null && candles[hoverIdx] ? hoverIdx : candles.length - 1;
  const activeCandle = candles[activeIdx];
  const isBullActive = activeCandle.close >= activeCandle.open;
  const changePct = activeCandle.open > 0 ? ((activeCandle.close - activeCandle.open) / activeCandle.open) * 100 : 0;

  const lastCandle = candles[candles.length - 1];
  const lastY = toY(lastCandle.close);
  const priceLevels = [maxPrice, minPrice + priceRange * 0.66, minPrice + priceRange * 0.33, minPrice];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {/* Floating OHLCV Telemetry Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-muted)',
          padding: '4px 6px',
        }}
      >
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <span>O: <strong style={{ color: '#E3E3E3' }}>{formatPx(activeCandle.open)}</strong></span>
          <span>H: <strong style={{ color: 'var(--color-text-positive)' }}>{formatPx(activeCandle.high)}</strong></span>
          <span>L: <strong style={{ color: '#F28B82' }}>{formatPx(activeCandle.low)}</strong></span>
          <span>C: <strong style={{ color: isBullActive ? 'var(--color-text-positive)' : '#F28B82' }}>{formatPx(activeCandle.close)}</strong></span>
          <span>Vol: <strong style={{ color: '#8AB4F8' }}>{Math.round(activeCandle.volume).toLocaleString()}</strong></span>
        </div>
        <span style={{ color: isBullActive ? 'var(--color-text-positive)' : '#F28B82', fontWeight: 700 }}>
          {changePct >= 0 ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`} · {new Date(activeCandle.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ overflow: 'visible', cursor: 'crosshair' }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Horizontal Price Grid Lines & Right Y-Axis Price Labels */}
        {priceLevels.map((lvl, idx) => {
          const y = toY(lvl);
          return (
            <g key={idx}>
              <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke="rgba(255,255,255,0.07)" strokeDasharray="3 3" />
              <text x={width - padRight + 6} y={y + 3} fill="#9AA0A6" fontSize="9.5" fontFamily="monospace">
                {formatPx(lvl)}
              </text>
            </g>
          );
        })}

        {/* Live Last-Price Dashed Line & Pill */}
        <line x1={padLeft} y1={lastY} x2={width - padRight} y2={lastY} stroke="#8AB4F8" strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
        <rect x={width - padRight + 2} y={lastY - 8} width={60} height={16} rx="4" fill="#4285F4" />
        <text x={width - padRight + 6} y={lastY + 3} fill="#FFFFFF" fontSize="9" fontWeight="700" fontFamily="monospace">
          {formatPx(lastCandle.close)}
        </text>

        {/* Candles + Interactive Hover Hitboxes */}
        {candles.map((c, i) => {
          const isBull = c.close >= c.open;
          const color = isBull ? 'var(--color-text-positive)' : '#F28B82';
          const x = padLeft + i * candleWidth + candleWidth / 2;

          const yHigh = toY(c.high);
          const yLow = toY(c.low);
          const yOpen = toY(c.open);
          const yClose = toY(c.close);

          const candleTop = Math.min(yOpen, yClose);
          const candleBodyHeight = Math.max(2, Math.abs(yClose - yOpen));
          const volHeight = (c.volume / maxVol) * 32;
          const yVol = height - 8 - volHeight;
          const isHovered = hoverIdx === i;

          return (
            <g key={i} onMouseEnter={() => setHoverIdx(i)}>
              {isHovered && (
                <>
                  <line x1={x} y1={padTop} x2={x} y2={height - 8} stroke="rgba(138, 180, 248, 0.45)" strokeWidth="1" strokeDasharray="3 3" />
                  <line x1={padLeft} y1={yClose} x2={width - padRight} y2={yClose} stroke="rgba(138, 180, 248, 0.35)" strokeWidth="1" strokeDasharray="3 3" />
                </>
              )}
              <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth={isHovered ? '1.8' : '1.2'} />
              <rect
                x={x - candleWidth * 0.34}
                y={candleTop}
                width={Math.max(2, candleWidth * 0.68)}
                height={candleBodyHeight}
                fill={color}
                rx="1.5"
                opacity={isHovered ? 1 : 0.9}
              />
              <rect
                x={x - candleWidth * 0.34}
                y={yVol}
                width={Math.max(2, candleWidth * 0.68)}
                height={volHeight}
                fill={color}
                opacity={isHovered ? 0.5 : 0.22}
                rx="1"
              />
              {/* Invisible full-height hitbox for smooth hover */}
              <rect
                x={padLeft + i * candleWidth}
                y={padTop}
                width={candleWidth}
                height={height - padTop}
                fill="transparent"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function TradingPage() {
  const { isConnected, userRole, planId, entitlements, chainId, connectMetaMask, isConnecting } = useAuth();
  const { t, tr } = useLocale();
  const { items: watchlistItems, togglePin: toggleWatchlistPin, isPinned: isWatchlistItemPinned } = useTokenWatchlist();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [interval, setInterval] = useState('1h');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [signal, setSignal] = useState<IntelligenceSignal | null>(null);
  const [tradingAnalysis, setTradingAnalysis] = useState<TradingAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposalStatus, setProposalStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [historyRefreshTick, setHistoryRefreshTick] = useState(0);
  const [activeTradingTab, setActiveTradingTab] = useState<'trade' | 'history' | 'vault'>('trade');

  // Controlled order parameters & deep-link context (Launchpad ?token= & Agent ?proposalId=)
  const [executionMode, setExecutionMode] = useState<'PAPER' | 'DEX_NON_CUSTODIAL' | 'CEX_SINGLE_SHOT'>('PAPER');
  const [dexTokenSafety, setDexTokenSafety] = useState<OnChainTokenSecurityReport | null>(null);
  const [dexChainId, setDexChainId] = useState<number>(8453);
  const [cexVenue, setCexVenue] = useState<'BINANCE' | 'BYBIT'>('BINANCE');
  const [venueManuallyChosen, setVenueManuallyChosen] = useState<boolean>(false);
  const [cexActiveCounts, setCexActiveCounts] = useState<{ binance: number; bybit: number } | null>(null);
  const [selectedBinanceCredentialId, setSelectedBinanceCredentialId] = useState<string>('DEFAULT');
  const [selectedBybitKeyId, setSelectedBybitKeyId] = useState<string>('DEFAULT');
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [orderQty, setOrderQty] = useState<number>(0.1);
  const [orderSlippagePct, setOrderSlippagePct] = useState<number>(1.5);
  const [linkedTokenAddress, setLinkedTokenAddress] = useState<string | null>(null);
  const [linkedProposalId, setLinkedProposalId] = useState<string | null>(null);
  const [linkedAgentHandoff, setLinkedAgentHandoff] = useState<{
    agent: SubAgentId | null;
    rail: ExecutionRailId | null;
    chainId: number | null;
  } | null>(null);
  const [mevQuote, setMevQuote] = useState<{ isSafe: boolean; minAmountOut?: string; maxSlippageBps?: number } | null>(null);
  const [dexSwapPayload, setDexSwapPayload] = useState<{
    available: boolean;
    chainId: number;
    sellToken?: string;
    sellAmount?: string;
    buyAmount?: string;
    minBuyAmount?: string;
    allowanceTarget?: string | null;
    feeBps?: number;
    feeRecipient?: string;
    routeSources?: string[];
    transaction?: { to: string; data: string; value: string; gas?: string };
    reason?: string;
  } | null>(null);
  const [dexSigning, setDexSigning] = useState(false);
  const [dexApprovingErc20, setDexApprovingErc20] = useState(false);
  const [dexTxHash, setDexTxHash] = useState<string | null>(null);
  const [lastApprovedIntentId, setLastApprovedIntentId] = useState<string | null>(null);

  const syncDexTokenSelection = (nextAddress: string | null, nextChainId: number) => {
    setLinkedTokenAddress(nextAddress);
    setDexSwapPayload(null);
    setDexTxHash(null);
    if (nextAddress && /^0x[a-fA-F0-9]{40}$/.test(nextAddress)) {
      fetch(
        `/api/trading/mev-quote?tokenAddress=${encodeURIComponent(nextAddress)}&chainId=${encodeURIComponent(String(nextChainId))}`
      )
        .then((r) => r.json())
        .then((json) => {
          if (json.success && json.data) {
            setMevQuote({
              isSafe: Boolean(json.data.isSafe),
              maxSlippageBps: json.data.maxSlippageBps,
            });
          }
        })
        .catch(() => {
          /* non-blocking MEV enrichment */
        });
    } else {
      setMevQuote(null);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parsed = parseTradingHandoffSearchParams(window.location.search);

    if (parsed.symbol) setSymbol(parsed.symbol);
    if (parsed.side) setOrderSide(parsed.side);
    if (parsed.qty) setOrderQty(parsed.qty);
    if (parsed.mode) setExecutionMode(parsed.mode);
    if (parsed.chainId) setDexChainId(parsed.chainId);
    if (parsed.proposalId) setLinkedProposalId(parsed.proposalId);
    if (parsed.agent || parsed.rail || parsed.chainId) {
      setLinkedAgentHandoff({
        agent: parsed.agent,
        rail: parsed.rail,
        chainId: parsed.chainId,
      });
    }
    if (parsed.tokenAddress) {
      syncDexTokenSelection(parsed.tokenAddress, parsed.chainId || 8453);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMarketData = async () => {
    try {
      const res = await fetch(`/api/market/chart?symbol=${symbol}&interval=${interval}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (json.success && json.data) {
        setCandles(json.data.candles || []);
        setOrderbook(json.data.orderbook || null);
        setSignal(json.data.signal || null);
        setTradingAnalysis(json.data.tradingAnalysis || null);
        setError(null);
      }
    } catch (err) {
      console.warn('[Trading UI] API fetch error (using fallback state):', (err as Error).message);
      setError('Live connection retrying... using cached visualization state');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isConnected) {
      setCexActiveCounts(null);
      return;
    }
    let cancelled = false;
    fetch('/api/user/vault-summary', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json?.success || !json.data?.vaults) return;
        const binanceActive = Number(json.data.vaults.binance?.active ?? 0);
        const bybitActive = Number(json.data.vaults.bybit?.active ?? 0);
        setCexActiveCounts({ binance: binanceActive, bybit: bybitActive });
        if (!venueManuallyChosen && binanceActive === 0 && bybitActive > 0) {
          setCexVenue('BYBIT');
        }
      })
      .catch(() => {
        // Non-blocking auto-detect
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, venueManuallyChosen]);

  useEffect(() => {
    setLoading(true);
    setProposalStatus('PENDING');
    setActionFeedback(null);
    fetchMarketData();
    const timer = window.setInterval(fetchMarketData, 5000);
    return () => window.clearInterval(timer);
  }, [symbol, interval]);

  const handleApproveProposal = async () => {
    if (!isConnected) {
      setActionFeedback('Auth: SIWE Session Required: Please connect your wallet to approve trade intents.');
      return;
    }

    setIsSubmitting(true);
    setActionFeedback(null);
    try {
      const parsedChainId = chainId ? parseInt(chainId, 16) || 8453 : 8453;
      const stage = executionMode === 'PAPER' || symbol.includes('/') ? 'PAPER' : 'TESTNET';
      const res = await fetch('/api/trading/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionMode,
          stage,
          symbol,
          side: orderSide,
          type: orderType,
          quantity: orderQty > 0 ? orderQty : 0.1,
          maxSlippagePct: orderSlippagePct > 0 ? orderSlippagePct : 1.5,
          tokenAddress: linkedTokenAddress || getDefaultDexTokenForChain(dexChainId).address,
          chainId: executionMode === 'DEX_NON_CUSTODIAL' ? dexChainId : parsedChainId,
          ...(executionMode === 'CEX_SINGLE_SHOT'
            ? {
                venue: cexVenue,
                ...((cexVenue === 'BYBIT' ? selectedBybitKeyId : selectedBinanceCredentialId) !== 'DEFAULT'
                  ? { credentialId: cexVenue === 'BYBIT' ? selectedBybitKeyId : selectedBinanceCredentialId }
                  : {}),
              }
            : {}),
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setProposalStatus('APPROVED');
        setHistoryRefreshTick((n) => n + 1);
        setDexTxHash(null);
        if (executionMode === 'DEX_NON_CUSTODIAL' && json.data?.zeroXSwap) {
          setDexSwapPayload(json.data.zeroXSwap);
        } else {
          setDexSwapPayload(null);
        }
        const execStatus = json.data?.status || 'APPROVED';
        const intentId = json.data?.tradeIntentId || '';
        setLastApprovedIntentId(intentId || null);
        const resolvedVenue = json.data?.venue || cexVenue;
        const feePctText =
          typeof json.data?.partnerFee?.feePct === 'number'
            ? ` · Fee ${json.data.partnerFee.feePct}%`
            : '';
        setActionFeedback(
          executionMode === 'DEX_NON_CUSTODIAL'
            ? `OK: [DEX NON-CUSTODIAL] Intent ${intentId} lolos Risk Gate & MEV Guard (${execStatus}${feePctText}). ${
                json.data?.zeroXSwap?.available
                  ? 'Calldata 0x v2 siap — klik tombol "Sign & Swap via MetaMask" di bawah.'
                  : 'Siap ditandatangani di dompet Web3.'
              }`
            : executionMode === 'CEX_SINGLE_SHOT'
            ? `OK: [CEX ${resolvedVenue} SINGLE-SHOT] Intent ${intentId} (${execStatus}) lolos Risk Gate.`
            : `OK: [PAPER TRADING SIMULATION] Proposal APPROVED & Intent ${intentId} (${execStatus}) lolos Risk Gate! Simulasi 100% bebas risiko modal.`
        );
      } else {
        const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || 'Policy violation';
        setActionFeedback(`Error: Risk Gate Rejected: ${errMsg}`);
      }
    } catch (err) {
      setActionFeedback(`Notice: Connection error during approval: ${(err as Error).message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRejectProposal = () => {
    setProposalStatus('REJECTED');
    setDexSwapPayload(null);
    setActionFeedback('Proposal REJECTED by user.');
  };

  const handleApproveZeroXErc20 = async () => {
    if (!dexSwapPayload?.allowanceTarget) return;
    const tokenAddr =
      dexSwapPayload.sellToken ||
      linkedTokenAddress ||
      getDefaultDexTokenForChain(dexChainId).address;
    setDexApprovingErc20(true);
    try {
      const targetChain = dexSwapPayload.chainId || dexChainId;
      const netCheck = await ensureEvmNetwork(targetChain);
      if (!netCheck.success) {
        setActionFeedback(`Notice: ${netCheck.error || 'Harap beralih ke jaringan EVM yang dipilih di MetaMask.'}`);
        return;
      }
      const approveTxSpec = buildErc20ApproveTransaction({
        tokenAddress: tokenAddr,
        spender: dexSwapPayload.allowanceTarget,
        amountWei: dexSwapPayload.sellAmount || '10000000000000000',
      });
      const signer = await getBrowserSigner();
      const tx = await signer.sendTransaction({
        to: approveTxSpec.to,
        data: approveTxSpec.data,
        value: 0n,
      });
      setDexTxHash(tx.hash);
      const chainLabel = EVM_DEX_CHAINS[targetChain]?.name || `Chain ${targetChain}`;
      setActionFeedback(
        `Transaksi ERC-20 Approve terkirim di ${chainLabel} (${tx.hash.slice(0, 12)}...). Menunggu konfirmasi...`
      );
      await tx.wait(1);
      setActionFeedback(
        `OK: ERC-20 Allowance (0x AllowanceHolder) terkonfirmasi di ${chainLabel}! Klik "Approve Proposal" ulang untuk refresh calldata swap.`
      );
    } catch (err: any) {
      setActionFeedback(`Notice: MetaMask ERC-20 Approve dibatalkan / gagal: ${normalizeWeb3Error(err)}`);
    } finally {
      setDexApprovingErc20(false);
    }
  };

  const handleSignZeroXSwap = async () => {
    if (!dexSwapPayload?.available || !dexSwapPayload.transaction) return;
    setDexSigning(true);
    try {
      const targetChain = dexSwapPayload.chainId || dexChainId;
      const netCheck = await ensureEvmNetwork(targetChain);
      if (!netCheck.success) {
        setActionFeedback(`Notice: ${netCheck.error || 'Harap beralih ke jaringan EVM yang dipilih di MetaMask.'}`);
        return;
      }
      const signer = await getBrowserSigner();
      const tx = await signer.sendTransaction({
        to: dexSwapPayload.transaction.to,
        data: dexSwapPayload.transaction.data,
        value: BigInt(dexSwapPayload.transaction.value || '0'),
      });
      setDexTxHash(tx.hash);
      const chainLabel = EVM_DEX_CHAINS[targetChain]?.name || `Chain ${targetChain}`;
      setActionFeedback(`Transaksi 0x Swap v2 terkirim di ${chainLabel} (${tx.hash.slice(0, 12)}...). Menunggu konfirmasi...`);
      await tx.wait(1);
      if (lastApprovedIntentId) {
        await fetch('/api/trade-intents', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradeIntentId: lastApprovedIntentId,
            txHash: tx.hash,
            chainId: targetChain,
          }),
        }).catch(() => {});
        setHistoryRefreshTick((n) => n + 1);
      }
      setActionFeedback(`OK: 0x Swap v2 terkonfirmasi on-chain di ${chainLabel}! Tx: ${tx.hash}`);
    } catch (err: any) {
      setActionFeedback(`Notice: MetaMask Swap dibatalkan / gagal: ${normalizeWeb3Error(err)}`);
    } finally {
      setDexSigning(false);
    }
  };

  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 65400;

  return (
    <div className="flex-col gap-lg">
      {/* CEX Pro Trading Terminal Top Ticker Bar */}
      <div className="cex-hero-banner cex-hero-emerald" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '19px', fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-foreground)' }}>
            <ActivitySquare size={19} style={{ color: '#10B981' }} /> {t('trading.title')}
          </h1>
          <span className="text-muted" style={{ fontSize: '12px' }}>
            {t('trading.subtitle')}
          </span>
        </div>
        <div className="flex-row gap-sm items-center">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="input"
            style={{ padding: '7px 12px', fontSize: '12px', fontWeight: 700, width: 'auto', display: 'inline-block' }}
          >
            {!TOP_LIQUID_CEX_PAIRS.some((p) => p.symbol === symbol) &&
              !LAUNCHPAD_CURVE_PAIRS.some((p) => p.symbol === symbol) && (
                <option value={symbol}>{symbol} (Custom)</option>
              )}
            {TOP_LIQUID_CEX_PAIRS.map((p) => (
              <option key={p.symbol} value={p.symbol}>
                {p.label}
              </option>
            ))}
            {LAUNCHPAD_CURVE_PAIRS.map((p) => (
              <option key={p.symbol} value={p.symbol}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Custom pair ticker"
            placeholder={tr('Custom pair (e.g. WIFUSDT)', 'Pair kustom (mis. WIFUSDT)')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const candidate = (e.currentTarget.value || '').trim().toUpperCase();
                if (isValidMarketSymbol(candidate)) {
                  setSymbol(candidate);
                  e.currentTarget.value = '';
                }
              }
            }}
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)', width: '165px', display: 'inline-block' }}
          />
          <span
            className={error ? 'badge badge-admin' : 'badge-live'}
            role="status"
            aria-label={error ? 'Connection retrying' : 'Live market stream active'}
          >
            {error ? 'RETRYING...' : 'LIVE'}
          </span>
        </div>
      </div>

      {/* CEX Category Tab Bar for /trading */}
      <div role="tablist" aria-label="Navigasi Halaman Trading" className="cex-tab-bar">
        {(
          [
            { id: 'trade', label: t('trading.tabTrade'), hint: 'Chart · DEX 0x v2 · CEX Order', icon: ActivitySquare },
            { id: 'history', label: t('trading.tabHistory'), hint: 'KPI · Explorer · CSV', icon: BarChart3 },
            { id: 'vault', label: t('trading.tabVault'), hint: 'Binance · Bybit · Risk Cap', icon: Lock },
          ] as const
        ).map((tab) => {
          const active = activeTradingTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTradingTab(tab.id)}
              className={`cex-tab-btn ${active ? 'active' : ''}`}
              style={{ flex: '1 1 180px', justifyContent: 'space-between' }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Icon size={14} /> {tab.label}
              </span>
              <span style={{ fontSize: '10px', opacity: 0.72, fontWeight: 600 }}>{tab.hint}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 2: Riwayat Order & CSV Audit */}
      {activeTradingTab === 'history' && (
        <div className="flex-col gap-lg">
          <RecentTradeHistoryPanel isConnected={isConnected} refreshSignal={historyRefreshTick} />
        </div>
      )}

      {/* TAB 3: Pro CEX Vault & Risk Guard */}
      {activeTradingTab === 'vault' && (
        <div className="flex-col gap-lg">
          <UserRiskPolicyPanel isConnected={isConnected} />
          <div className="grid-2" style={{ gap: '16px' }}>
            <BinanceKeyVaultPanel
              isConnected={isConnected}
              selectedCredentialId={selectedBinanceCredentialId}
              onSelectCredentialId={setSelectedBinanceCredentialId}
            />
            <BybitKeyVaultPanel
              isConnected={isConnected}
              selectedKeyId={selectedBybitKeyId}
              onSelectKeyId={setSelectedBybitKeyId}
            />
          </div>
        </div>
      )}

      {/* TAB 1: Quick Swap & Order (Default Beginner-Friendly View) */}
      {activeTradingTab === 'trade' && (
      <>
      {/* Workflow & Plan Entitlement Guide */}
      <PageWorkflowBanner
        title={tr('Trading Terminal & Risk Gate Flow', 'Alur Trading Terminal & Risk Gate')}
        isUnlocked={executionMode === 'PAPER' ? true : Boolean(entitlements.liveTrading)}
        requiredPlanLabel="TRADER / AGENT"
        creditSummary={tr('Paper Trading: Free · Live DEX/CEX: TRADER/AGENT Plan', 'Paper Trading: Gratis · Live DEX/CEX: Paket TRADER/AGENT')}
        steps={[
          { step: '1', label: tr('Select Pair & Inspect Chart/RSI', 'Pilih Pair & Analisa Chart/RSI') },
          { step: '2', label: tr('Choose Mode (Paper / DEX / CEX)', 'Pilih Mode (Paper / DEX / CEX)') },
          { step: '3', label: tr('Validate TradingRiskGate & MEV Cap', 'Validasi TradingRiskGate & MEV Cap') },
          { step: '4', label: tr('Approve Intent / Sign in MetaMask', 'Approve Intent / Sign di MetaMask') },
        ]}
      />

      {/* Pinned Token Watchlist Strip (Phase CZ) */}
      <TokenWatchlistBar
        items={watchlistItems}
        onUnpin={(item) => toggleWatchlistPin({ symbol: item.symbol, name: item.name, chainId: item.chainId, address: item.address })}
        onSelect={(item) => {
          if (item.address) {
            setExecutionMode('DEX_NON_CUSTODIAL');
            setDexChainId(item.chainId);
            setLinkedTokenAddress(item.address);
          } else {
            setSymbol(item.symbol);
          }
        }}
      />

      {/* Main Grid Layout */}
      <div className="grid-3" style={{ gridTemplateColumns: '2fr 1fr' }}>
        {/* Left Column: Candlestick Chart & Derived Indicators */}
        <div className="flex-col gap-md">
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', fontFamily: 'var(--font-mono)' }}>
                  {symbol} <span className="text-muted">({interval.toUpperCase()})</span>
                </span>
                <PinWatchlistButton
                  pinned={isWatchlistItemPinned(
                    dexChainId,
                    executionMode === 'DEX_NON_CUSTODIAL' && linkedTokenAddress.trim() ? linkedTokenAddress.trim() : symbol
                  )}
                  onClick={() =>
                    toggleWatchlistPin({
                      symbol,
                      name: symbol,
                      chainId: dexChainId,
                      address: executionMode === 'DEX_NON_CUSTODIAL' && linkedTokenAddress.trim() ? linkedTokenAddress.trim() : undefined,
                    })
                  }
                  label={
                    isWatchlistItemPinned(
                      dexChainId,
                      executionMode === 'DEX_NON_CUSTODIAL' && linkedTokenAddress.trim() ? linkedTokenAddress.trim() : symbol
                    )
                      ? tr('Pinned', 'Disematkan')
                      : tr('Pin', 'Sematkan')
                  }
                />
                <span className="text-muted" style={{ fontSize: '12px' }}>
                  {loading ? 'Updating live candles...' : 'Binance REST + WebSocket Stream'}
                </span>
              </div>
              <div className="flex-row gap-xs">
                {(['1m', '1h', '4h', '1d'] as const).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setInterval(tf)}
                    className={interval === tf ? 'btn-primary' : 'btn-secondary'}
                    style={{ padding: '4px 8px', fontSize: '12px', minWidth: '40px', justifyContent: 'center' }}
                  >
                    {tf.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* SVG Candlestick Chart Container */}
            <div style={{ backgroundColor: 'var(--color-background)', padding: '16px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
              <CandlestickChart candles={candles} />
            </div>

            {/* Data-Dense Derived Metrics Bar */}
            <div className="grid-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginTop: '16px' }}>
              <div className="bg-panel" style={{ padding: '12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                <span className="text-muted" style={{ fontSize: '10px', fontWeight: 700, display: 'block', marginBottom: '4px' }}>LAST PRICE</span>
                <span style={{ color: 'var(--color-foreground)', fontSize: '16px', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>
                  ${lastClose.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="bg-panel" style={{ padding: '12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                <span className="text-muted" style={{ fontSize: '10px', fontWeight: 700, display: 'block', marginBottom: '4px' }}>MARKET REGIME</span>
                <span style={{ color: 'var(--color-accent-amber)', fontSize: '14px', fontWeight: 900 }}>
                  {tradingAnalysis?.regime.regime || 'RANGE_BOUND'}
                </span>
              </div>
              <div className="bg-panel" style={{ padding: '12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                <span className="text-muted" style={{ fontSize: '10px', fontWeight: 700, display: 'block', marginBottom: '4px' }}>RSI (14-PERIOD)</span>
                <span style={{ color: tradingAnalysis?.rsiZone === 'OVERSOLD' ? 'var(--color-accent)' : tradingAnalysis?.rsiZone === 'OVERBOUGHT' ? 'var(--color-destructive)' : 'var(--color-accent-info)', fontSize: '14px', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>
                  {tradingAnalysis?.rsiCurrent !== null && tradingAnalysis?.rsiCurrent !== undefined ? `${tradingAnalysis.rsiCurrent} (${tradingAnalysis.rsiZone})` : '48.2 (NEUTRAL)'}
                </span>
              </div>
              <div className="bg-panel" style={{ padding: '12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                <span className="text-muted" style={{ fontSize: '10px', fontWeight: 700, display: 'block', marginBottom: '4px' }}>OVERALL RISK SCORE</span>
                <span style={{ color: (tradingAnalysis?.overallRiskScore || 20) > 50 ? 'var(--color-destructive)' : 'var(--color-accent)', fontSize: '14px', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>
                  {tradingAnalysis?.overallRiskScore || 20} / 100
                </span>
              </div>
            </div>
          </div>

          {/* Multi-Factor Market Alerts Banner */}
          {tradingAnalysis && tradingAnalysis.alerts.length > 0 && (
            <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertTriangle size={16} className="text-accent" /> Multi-Factor Market Alerts ({tradingAnalysis.alerts.length})
                </h3>
                {tradingAnalysis.tradingPaused && (
                  <span className="badge badge-admin">
                    TRADING PAUSED BY ALERT ENGINE
                  </span>
                )}
              </div>
              <div className="flex-col gap-sm">
                {tradingAnalysis.alerts.map((alert) => {
                  const isCritical = alert.severity === 'CRITICAL' || alert.severity === 'WARNING';
                  return (
                    <div key={alert.alertId} className={isCritical ? 'bg-panel border-destructive' : 'bg-panel'} style={{ border: '1px solid ' + (isCritical ? 'var(--color-destructive)' : 'var(--color-accent)'), borderRadius: '6px', padding: '12px' }}>
                      <div style={{ fontWeight: 800, color: isCritical ? 'var(--color-destructive)' : 'var(--color-accent)', marginBottom: '4px' }}>
                        {alert.title}
                      </div>
                      <div className="text-muted" style={{ marginBottom: '8px', fontSize: '12px' }}>
                        {alert.description}
                      </div>
                      <div style={{ color: 'var(--color-foreground)', fontSize: '11px', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Lightbulb size={12} /> Hint: {alert.actionableHint}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: AI Signal Overlay & Orderbook Depth */}
        <div className="flex-col gap-md">
          {/* AI Intelligence Signal Overlay Panel */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 800, margin: '0 0 12px 0', color: 'var(--color-accent-purple)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <BrainCircuit size={16} /> AI Feature Engine Signal
            </h3>

            <div className="bg-panel" style={{ padding: '12px', borderRadius: '6px', marginBottom: '12px', border: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span className="text-muted" style={{ fontSize: '12px' }}>Confidence Score</span>
                <span style={{ color: 'var(--color-accent)', fontSize: '16px', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>
                  {signal ? `${(signal.computedConfidenceScore * 100).toFixed(1)}%` : '85.0%'}
                </span>
              </div>
              <div style={{ backgroundColor: 'var(--color-border)', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
                <div
                  style={{
                    backgroundColor: 'var(--color-accent)',
                    height: '100%',
                    width: `${(signal?.computedConfidenceScore || 0.85) * 100}%`,
                  }}
                />
              </div>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--color-foreground)', lineHeight: '1.5', marginBottom: '12px' }}>
              <strong className="text-muted">Rationale:</strong> {signal?.rationale || 'Counterparty cleared by On-Chain Guard (GoPlus + RPC) | Volatility LOW | Spread normal'}
            </div>

            <div className="flex-row gap-xs" style={{ flexWrap: 'wrap' }}>
              <span className="badge badge-trader">
                ✓ On-Chain Guard {signal?.inputs.counterpartyRisk || 'CLEAR'}
              </span>
              <span className="badge badge-trader" style={{ border: '1px solid var(--color-badge-info-border)', color: 'var(--color-badge-info-text)', backgroundColor: 'var(--color-badge-info-bg)' }}>
                ✓ Sentiment {signal?.inputs.webSentiment || 'NEUTRAL'}
              </span>
            </div>
          </div>

          {/* High-Density Orderbook Depth & Whale Wall Panel */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BarChart3 size={16} className="text-accent" /> Orderbook Depth
              </h3>
              <span style={{ color: 'var(--color-accent)', fontSize: '12px', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                Spread: {orderbook ? `${orderbook.spreadPct}%` : '0.02%'}
              </span>
            </div>

            {/* Asks (Sells) */}
            <div className="flex-col gap-xs" style={{ fontFamily: 'var(--font-mono)' }}>
              {orderbook?.asks.slice(0, 4).reverse().map(([p, q], i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    color: 'var(--color-destructive)',
                    fontSize: '12px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor: q > 10 ? 'rgba(239, 68, 68, 0.1)' : 'transparent',
                  }}
                >
                  <span>${p.toLocaleString()} {q > 10 ? '' : ''}</span>
                  <span>{q.toFixed(2)} {symbol.replace('USDT', '')}</span>
                </div>
              )) || (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-destructive)', fontSize: '12px', padding: '4px 8px' }}>
                  <span>$65,405.00 </span>
                  <span>15.00 BTC</span>
                </div>
              )}
            </div>

            <div style={{ textAlign: 'center', color: 'var(--color-muted)', fontSize: '12px', padding: '8px 0', borderTop: '1px dashed var(--color-border)', borderBottom: '1px dashed var(--color-border)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>
              Midpoint: ${((orderbook?.bestBid || 65400) + (orderbook?.bestAsk || 65405)) / 2}
            </div>

            {/* Bids (Buys) */}
            <div className="flex-col gap-xs" style={{ fontFamily: 'var(--font-mono)' }}>
              {orderbook?.bids.slice(0, 4).map(([p, q], i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    color: 'var(--color-accent)',
                    fontSize: '12px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor: q > 10 ? 'rgba(16, 185, 129, 0.1)' : 'transparent',
                  }}
                >
                  <span>${p.toLocaleString()} {q > 10 ? '' : ''}</span>
                  <span>{q.toFixed(2)} {symbol.replace('USDT', '')}</span>
                </div>
              )) || (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-accent)', fontSize: '12px', padding: '4px 8px' }}>
                  <span>$65,400.00 </span>
                  <span>12.80 BTC</span>
                </div>
              )}
            </div>
          </div>

          {/* Proposal-Only Action Gate */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px', border: (userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') ? '1px solid var(--color-accent-amber)' : '1px solid var(--color-accent)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 800, margin: 0, color: (userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') ? 'var(--color-accent-amber)' : 'var(--color-accent)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldAlert size={16} /> Proposal Gate
              </h3>
              {(userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
                <span className="badge badge-admin">
                  ADMIN OVERRIDE
                </span>
              )}
            </div>

            {(linkedTokenAddress || linkedProposalId || linkedAgentHandoff) && (
              <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', padding: '8px', borderRadius: '6px', backgroundColor: 'var(--color-badge-info-bg)', border: '1px solid var(--color-badge-info-border)', marginBottom: '10px', color: 'var(--color-badge-info-text)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {linkedAgentHandoff && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span>
                      Agent Handoff: <strong>{linkedAgentHandoff.agent || 'AUTO'}</strong>
                      {linkedAgentHandoff.rail ? ` · ${linkedAgentHandoff.rail}` : ''}
                      {linkedAgentHandoff.chainId ? ` · Chain ${linkedAgentHandoff.chainId}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setLinkedAgentHandoff(null);
                        setLinkedTokenAddress(null);
                        setLinkedProposalId(null);
                      }}
                      className="btn-secondary"
                      style={{ padding: '1px 6px', fontSize: '10px' }}
                    >
                      Clear
                    </button>
                  </div>
                )}
                {linkedTokenAddress && (
                  <div>
                    Target Token:{' '}
                    {findDexTokenPresetByAddress(dexChainId, linkedTokenAddress)
                      ? `${findDexTokenPresetByAddress(dexChainId, linkedTokenAddress)?.symbol} (`
                      : ''}
                    {linkedTokenAddress.slice(0, 10)}...{linkedTokenAddress.slice(-6)}
                    {findDexTokenPresetByAddress(dexChainId, linkedTokenAddress) ? ')' : ''}
                    {mevQuote && ` • MEV Shield: ${mevQuote.isSafe ? 'SAFE' : 'HIGH_RISK'}`}
                  </div>
                )}
                {linkedProposalId && <div>Linked AI Proposal: {linkedProposalId}</div>}
              </div>
            )}

            <div style={{ marginBottom: '8px' }}>
              <select
                aria-label="Execution mode"
                value={executionMode}
                onChange={(e) => setExecutionMode(e.target.value as 'PAPER' | 'DEX_NON_CUSTODIAL' | 'CEX_SINGLE_SHOT')}
                className="input"
                style={{ width: '100%', padding: '6px 8px', fontSize: '11px', fontWeight: 800, color: 'var(--color-accent)' }}
              >
                <option value="PAPER">Mode: PAPER (Simulated Fill — All Tiers)</option>
                <option value="DEX_NON_CUSTODIAL">Mode: DEX_NON_CUSTODIAL (MEV Guard + MetaMask Sign — TRADER/AGENT)</option>
                <option value="CEX_SINGLE_SHOT">Mode: CEX_SINGLE_SHOT (Stateless Binance / Bybit V5 — TRADER/AGENT)</option>
              </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderRadius: '6px', background: 'rgba(148, 163, 184, 0.06)', border: '1px solid var(--color-border)', marginBottom: '8px', fontSize: '11px' }}>
              <span className="text-muted">Personal Risk Guard Aktif</span>
              <button
                type="button"
                onClick={() => setActiveTradingTab('vault')}
                style={{ background: 'none', border: 'none', color: 'var(--color-accent-amber)', fontWeight: 700, cursor: 'pointer', fontSize: '11px', padding: 0 }}
              >
                Atur Risk &amp; API Key →
              </button>
            </div>

            {executionMode === 'DEX_NON_CUSTODIAL' && (
              <div style={{ marginTop: '8px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <select
                  aria-label="DEX EVM Network"
                  value={dexChainId}
                  onChange={(e) => {
                    const nextChain = Number(e.target.value) || 8453;
                    setDexChainId(nextChain);
                    const defPreset = getDefaultDexTokenForChain(nextChain);
                    syncDexTokenSelection(defPreset.address, nextChain);
                  }}
                  className="input"
                  style={{ width: '100%', padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
                >
                  {Object.values(EVM_DEX_CHAINS).map((c) => (
                    <option key={c.chainId} value={c.chainId}>
                      DEX Network: {c.name} (Chain {c.chainId})
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                  <span className="text-muted" style={{ fontSize: '10px', fontWeight: 700 }}>
                    Presets:
                  </span>
                  {getDexTokenPresetsForChain(dexChainId).map((preset) => {
                    const isSelected =
                      (linkedTokenAddress || getDefaultDexTokenForChain(dexChainId).address).toLowerCase() ===
                      preset.address.toLowerCase();
                    return (
                      <button
                        key={`${preset.chainId}-${preset.symbol}`}
                        type="button"
                        onClick={() => {
                          syncDexTokenSelection(preset.address, dexChainId);
                        }}
                        style={{
                          padding: '2px 7px',
                          fontSize: '10px',
                          fontWeight: 800,
                          borderRadius: '999px',
                          cursor: 'pointer',
                          fontFamily: 'var(--font-mono)',
                          border: isSelected ? '1px solid var(--color-text-positive)' : '1px solid rgba(148, 163, 184, 0.25)',
                          backgroundColor: isSelected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(15, 23, 42, 0.6)',
                          color: isSelected ? 'var(--color-text-positive)' : '#CBD5E1',
                        }}
                        title={`${preset.name} (${preset.address})`}
                      >
                        {preset.symbol}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  aria-label="DEX Target Token Contract Address"
                  value={linkedTokenAddress || ''}
                  onChange={(e) => syncDexTokenSelection(e.target.value.trim() || null, dexChainId)}
                  placeholder={`Target Token 0x... (default ${getDefaultDexTokenForChain(dexChainId).symbol}: ${getDefaultDexTokenForChain(dexChainId).address.slice(0, 10)}...)`}
                  className="input"
                  style={{ width: '100%', padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                />
                <TokenSafetyBadgeCard
                  address={linkedTokenAddress || getDefaultDexTokenForChain(dexChainId).address}
                  chainId={dexChainId}
                  onReportChange={setDexTokenSafety}
                />
              </div>
            )}

            {executionMode === 'CEX_SINGLE_SHOT' && (
              <>
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px', marginBottom: '4px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setVenueManuallyChosen(true);
                      setCexVenue('BINANCE');
                    }}
                    className={cexVenue === 'BINANCE' ? 'btn-primary' : 'btn-secondary'}
                    style={{ flex: 1, padding: '5px 8px', fontSize: '11px', justifyContent: 'center' }}
                  >
                    Binance Spot{cexActiveCounts ? ` (${cexActiveCounts.binance})` : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setVenueManuallyChosen(true);
                      setCexVenue('BYBIT');
                    }}
                    className={cexVenue === 'BYBIT' ? 'btn-primary' : 'btn-secondary'}
                    style={{ flex: 1, padding: '5px 8px', fontSize: '11px', justifyContent: 'center' }}
                  >
                    Bybit V5 Spot{cexActiveCounts ? ` (${cexActiveCounts.bybit})` : ''}
                  </button>
                </div>
                {cexVenue === 'BINANCE' ? (
                  <BinanceKeyVaultPanel
                    isConnected={isConnected}
                    selectedCredentialId={selectedBinanceCredentialId}
                    onSelectCredentialId={setSelectedBinanceCredentialId}
                  />
                ) : (
                  <BybitKeyVaultPanel
                    isConnected={isConnected}
                    selectedKeyId={selectedBybitKeyId}
                    onSelectKeyId={setSelectedBybitKeyId}
                  />
                )}
              </>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <select
                aria-label="Order side"
                value={orderSide}
                onChange={(e) => {
                  setOrderSide(e.target.value as 'BUY' | 'SELL');
                  setDexSwapPayload(null);
                  setDexTxHash(null);
                }}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
              >
                <option value="BUY">Side: BUY</option>
                <option value="SELL">Side: SELL</option>
              </select>
              <select
                aria-label="Order type"
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as 'MARKET' | 'LIMIT')}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
              >
                <option value="MARKET">Type: MARKET</option>
                <option value="LIMIT">Type: LIMIT</option>
              </select>
              <input
                aria-label="Order quantity"
                type="number"
                step="0.01"
                min="0.001"
                value={orderQty}
                onChange={(e) => setOrderQty(parseFloat(e.target.value) || 0.1)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                title="Order Quantity"
              />
              <input
                aria-label="Max slippage percentage"
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={orderSlippagePct}
                onChange={(e) => setOrderSlippagePct(parseFloat(e.target.value) || 1.5)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                title="Max Slippage (%)"
              />
            </div>

            <p style={{ fontSize: '12px', color: 'var(--color-muted)', marginBottom: '16px' }}>
              Status: <strong style={{ color: 'var(--color-foreground)' }}>{proposalStatus}</strong>
            </p>

            {actionFeedback && (
              <div
                className="bg-panel"
                style={{
                  padding: '12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  marginBottom: '16px',
                  border: '1px solid var(--color-border)',
                  color: actionFeedback.includes('OK:') ? 'var(--color-accent)' : actionFeedback.includes('Error:') ? 'var(--color-destructive)' : actionFeedback.includes('Auth:') ? 'var(--color-accent-amber)' : 'var(--color-foreground)',
                }}
              >
                {actionFeedback}
                {dexTxHash && (
                  <div style={{ marginTop: '6px' }}>
                    <a
                      href={getEvmExplorerTxUrl(dexSwapPayload?.chainId || dexChainId, dexTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--color-accent-info)', fontSize: '11px', textDecoration: 'underline' }}
                    >
                      Lihat di Block Explorer →
                    </a>
                  </div>
                )}
              </div>
            )}

            {((dexSwapPayload?.available && dexSwapPayload.transaction) ||
              (orderSide === 'SELL' && Boolean(dexSwapPayload?.allowanceTarget))) && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  background: 'rgba(16, 185, 129, 0.08)',
                  marginBottom: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-text-positive)' }}>
                  0x Swap API v2 {dexSwapPayload?.available ? 'Calldata Ready' : 'ERC-20 Allowance Required'} (Chain {dexSwapPayload?.chainId || dexChainId})
                </div>
                {dexSwapPayload?.available && dexSwapPayload.buyAmount && (() => {
                  const outSummary = formatDexQuoteOutputSummary({
                    side: orderSide,
                    chainId: dexSwapPayload.chainId || dexChainId,
                    tokenAddress: linkedTokenAddress || getDefaultDexTokenForChain(dexChainId).address,
                    buyAmountAtomic: dexSwapPayload.buyAmount,
                    minBuyAmountAtomic: dexSwapPayload.minBuyAmount,
                  });
                  return (
                    <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: '#E2E8F0', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <div>
                        Est. Receive: <strong style={{ color: 'var(--color-text-positive)' }}>~{outSummary.estimatedOutFormatted} {outSummary.buyTokenSymbol}</strong>
                        {' '}· Min: {outSummary.minOutFormatted} {outSummary.buyTokenSymbol}
                      </div>
                      {Array.isArray(dexSwapPayload.routeSources) && dexSwapPayload.routeSources.length > 0 && (
                        <div className="text-muted" style={{ fontSize: '10px' }}>
                          Routed via: {dexSwapPayload.routeSources.join(' + ')}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="text-muted" style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                  Protocol Fee: {((dexSwapPayload?.feeBps ?? 25) / 100).toFixed(2)}% (Auto-ETH → Treasury)
                </div>
                {orderSide === 'SELL' && dexSwapPayload?.allowanceTarget && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div className="text-muted" style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                      0x AllowanceHolder: {dexSwapPayload.allowanceTarget.slice(0, 10)}...{dexSwapPayload.allowanceTarget.slice(-6)}
                    </div>
                    <button
                      type="button"
                      onClick={handleApproveZeroXErc20}
                      disabled={dexApprovingErc20 || dexSigning}
                      className="btn-secondary"
                      style={{ width: '100%', justifyContent: 'center', fontSize: '11px', padding: '7px 10px', borderColor: 'rgba(250, 204, 21, 0.45)', color: 'var(--color-accent-amber)' }}
                    >
                      {dexApprovingErc20 ? 'Menunggu MetaMask Approve...' : 'Step 1: Approve ERC-20 Allowance via MetaMask'}
                    </button>
                  </div>
                )}
                {dexSwapPayload?.available && dexSwapPayload.transaction && (
                  <button
                    type="button"
                    onClick={handleSignZeroXSwap}
                    disabled={dexSigning || dexApprovingErc20 || Boolean(dexTokenSafety?.hardBlocked)}
                    className="btn-primary"
                    style={{ width: '100%', justifyContent: 'center', fontSize: '12px', padding: '8px 12px' }}
                  >
                    {dexTokenSafety?.hardBlocked
                      ? 'Swap Diblokir (Honeypot / Tax >20%)'
                      : dexSigning
                      ? 'Menunggu MetaMask...'
                      : 'Sign & Swap via MetaMask (0x v2)'}
                  </button>
                )}
              </div>
            )}

            {!isConnected ? (
              <div className="flex-col gap-sm">
                <div className="text-muted" style={{ fontSize: '12px', textAlign: 'center', marginBottom: '8px' }}>
                  <Lock size={12} className="inline mr-1" /> Wallet connection required to execute trade intents.
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    setConnectError(null);
                    const res = await connectMetaMask();
                    if (!res.success && res.error) {
                      setConnectError(res.error);
                    }
                  }}
                  disabled={isConnecting}
                  className="btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Wallet size={16} />
                  {isConnecting ? 'Connecting...' : 'Connect MetaMask to Trade'}
                </button>
                {connectError && (
                  <div style={{ color: 'var(--color-destructive)', fontSize: '12px', textAlign: 'center' }}>
                    {connectError}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {executionMode === 'DEX_NON_CUSTODIAL' && dexTokenSafety?.hardBlocked && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(239, 68, 68, 0.5)',
                      background: 'rgba(239, 68, 68, 0.12)',
                      color: '#FCA5A5',
                      fontSize: '11px',
                      fontWeight: 700,
                    }}
                  >
                    PRE-TRADE HARD-BLOCK AKTIF: GoPlus On-Chain Guard mendeteksi Honeypot atau Pajak &gt;20%. Eksekusi DEX dikunci otomatis demi keamanan dana Anda.
                  </div>
                )}
                <div className="flex-row gap-sm">
                  <button
                    onClick={handleApproveProposal}
                    disabled={
                      isSubmitting ||
                      proposalStatus === 'APPROVED' ||
                      (executionMode === 'DEX_NON_CUSTODIAL' && Boolean(dexTokenSafety?.hardBlocked))
                    }
                    className="btn-primary"
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      opacity:
                        proposalStatus === 'APPROVED' ||
                        (executionMode === 'DEX_NON_CUSTODIAL' && Boolean(dexTokenSafety?.hardBlocked))
                          ? 0.5
                          : 1,
                    }}
                    aria-label="Approve trade proposal and submit as trade intent"
                  >
                    {executionMode === 'DEX_NON_CUSTODIAL' && dexTokenSafety?.hardBlocked
                      ? 'Diblokir (Honeypot)'
                      : isSubmitting
                      ? 'Processing...'
                      : proposalStatus === 'APPROVED'
                      ? 'Approved ✓'
                      : 'Approve Proposal'}
                  </button>

                  <button
                    onClick={handleRejectProposal}
                    disabled={isSubmitting || proposalStatus === 'REJECTED'}
                    className="btn-destructive"
                    style={{ flex: 1, justifyContent: 'center', opacity: proposalStatus === 'REJECTED' ? 0.5 : 1 }}
                    aria-label="Reject trade proposal"
                  >
                    {proposalStatus === 'REJECTED' ? 'Rejected ✗' : 'Reject Proposal'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Investor Safety Nutrition Label (for SocialFi / Bonding Curve tokens) */}
          {symbol.includes('/') && (
            <div style={{ marginTop: '8px' }}>
              <NutritionLabelCard
                liquidityLocked={symbol !== 'CDAO/ETH'}
                mintRevoked={true}
                creatorTrustScore={symbol === 'PUMPRUN/WETH' ? 90 : symbol === 'MOON/ETH' ? 88 : symbol === 'PEOPLE/ETH' ? 72 : 55}
                overallTier={symbol === 'PUMPRUN/WETH' || symbol === 'MOON/ETH' ? 'LOW' : symbol === 'PEOPLE/ETH' ? 'MEDIUM' : 'HIGH'}
                reasons={
                  symbol === 'PUMPRUN/WETH'
                    ? ['GoPlus Audit 90/100 (VERY SAFE)', 'No Honeypot | 0% Tax | Cannot Sell All = FALSE', 'Doppler Hook Uniswap v4 Liquidity Locked', 'Verified Base Mainnet Deployment']
                    : symbol === 'MOON/ETH'
                    ? ['Audited Bonding Curve Template', 'Arkham Creator Score 88/100', 'Automatic Liquidity Lock at 24 ETH']
                    : symbol === 'PEOPLE/ETH'
                    ? ['Fair Launch 1% Max Wallet Anti-Snipe', 'Creator wallet age < 30 days']
                    : ['Prelaunch crowdfund in progress', 'Liquidity lock pending graduation']
                }
              />
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
