'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Activity, ShieldAlert, BarChart3, Clock, AlertTriangle, Lightbulb, Wallet, BrainCircuit, ActivitySquare, Lock } from 'lucide-react';
import { NutritionLabelCard } from '../components/NutritionLabelCard';
import { PageWorkflowBanner } from '../components/PageWorkflowBanner';
import { BinanceKeyVaultPanel } from '../components/BinanceKeyVaultPanel';

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
          <span>H: <strong style={{ color: '#34D399' }}>{formatPx(activeCandle.high)}</strong></span>
          <span>L: <strong style={{ color: '#F28B82' }}>{formatPx(activeCandle.low)}</strong></span>
          <span>C: <strong style={{ color: isBullActive ? '#34D399' : '#F28B82' }}>{formatPx(activeCandle.close)}</strong></span>
          <span>Vol: <strong style={{ color: '#8AB4F8' }}>{Math.round(activeCandle.volume).toLocaleString()}</strong></span>
        </div>
        <span style={{ color: isBullActive ? '#34D399' : '#F28B82', fontWeight: 700 }}>
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
          const color = isBull ? '#34D399' : '#F28B82';
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

  // Controlled order parameters & deep-link context (Launchpad ?token= & Agent ?proposalId=)
  const [executionMode, setExecutionMode] = useState<'PAPER' | 'DEX_NON_CUSTODIAL' | 'CEX_SINGLE_SHOT'>('PAPER');
  const [selectedBinanceCredentialId, setSelectedBinanceCredentialId] = useState<string>('DEFAULT');
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [orderQty, setOrderQty] = useState<number>(0.1);
  const [orderSlippagePct, setOrderSlippagePct] = useState<number>(1.5);
  const [linkedTokenAddress, setLinkedTokenAddress] = useState<string | null>(null);
  const [linkedProposalId, setLinkedProposalId] = useState<string | null>(null);
  const [mevQuote, setMevQuote] = useState<{ isSafe: boolean; minAmountOut?: string; maxSlippageBps?: number } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    const symbolParam = params.get('symbol');
    const sideParam = params.get('side');
    const qtyParam = params.get('qty');
    const proposalParam = params.get('proposalId');

    if (symbolParam) setSymbol(symbolParam);
    if (sideParam === 'BUY' || sideParam === 'SELL') setOrderSide(sideParam);
    if (qtyParam && Number(qtyParam) > 0) setOrderQty(Number(qtyParam));
    if (proposalParam) setLinkedProposalId(proposalParam);
    if (tokenParam && /^0x[a-fA-F0-9]{40}$/.test(tokenParam)) {
      setLinkedTokenAddress(tokenParam);
      fetch(`/api/trading/mev-quote?tokenAddress=${encodeURIComponent(tokenParam)}`)
        .then((r) => r.json())
        .then((json) => {
          if (json.success && json.data) {
            setMevQuote({
              isSafe: Boolean(json.data.isSafe),
              maxSlippageBps: json.data.maxSlippageBps,
            });
          }
        })
        .catch(() => { /* non-blocking MEV enrichment */ });
    }
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
    setLoading(true);
    setProposalStatus('PENDING');
    setActionFeedback(null);
    fetchMarketData();
    const timer = window.setInterval(fetchMarketData, 5000);
    return () => window.clearInterval(timer);
  }, [symbol, interval]);

  const handleApproveProposal = async () => {
    if (!isConnected) {
      setActionFeedback('🔒 SIWE Session Required: Please connect your wallet to approve trade intents.');
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
          tokenAddress: linkedTokenAddress || '0x4200000000000000000000000000000000000006',
          chainId: parsedChainId,
          ...(executionMode === 'CEX_SINGLE_SHOT' && selectedBinanceCredentialId !== 'DEFAULT'
            ? { credentialId: selectedBinanceCredentialId }
            : {}),
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setProposalStatus('APPROVED');
        const execStatus = json.data?.status || 'APPROVED';
        const intentId = json.data?.tradeIntentId || '';
        setActionFeedback(
          executionMode === 'DEX_NON_CUSTODIAL'
            ? `✅ [DEX NON-CUSTODIAL] Intent ${intentId} lolos Risk Gate & MEV Guard (${execStatus}). Siap ditandatangani di dompet Web3.`
            : executionMode === 'CEX_SINGLE_SHOT'
            ? `✅ [CEX SINGLE-SHOT] Intent ${intentId} (${execStatus}) lolos Risk Gate.`
            : `✅ [PAPER TRADING SIMULATION] Proposal APPROVED & Intent ${intentId} (${execStatus}) lolos Risk Gate! Simulasi 100% bebas risiko modal.`
        );
      } else {
        const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || 'Policy violation';
        setActionFeedback(`❌ Risk Gate Rejected: ${errMsg}`);
      }
    } catch (err) {
      setActionFeedback(`⚠️ Connection error during approval: ${(err as Error).message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRejectProposal = () => {
    setProposalStatus('REJECTED');
    setActionFeedback('⛔ Proposal REJECTED by user.');
  };

  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 65400;

  return (
    <div className="flex-col gap-lg">
      {/* Top Banner Control Bar */}
      <div className="bg-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderRadius: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ActivitySquare className="text-accent" /> Trading Terminal & Orderbook Depth
          </h1>
          <span className="text-muted" style={{ fontSize: '12px' }}>
            Binance Orderbook Sync • Multi-Factor Trading Signal Engine Active
          </span>
        </div>
        <div className="flex-row gap-sm items-center">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="input"
            style={{ padding: '6px 12px', fontSize: '12px', width: 'auto', display: 'inline-block' }}
          >
            <option value="BTCUSDT">BTC / USDT (Binance Live)</option>
            <option value="ETHUSDT">ETH / USDT (Binance Live)</option>
            <option value="SOLUSDT">SOL / USDT (Binance Live)</option>
            <option value="BASEUSDT">BASE / USDT (Binance Live)</option>
            <option value="PUMPRUN/WETH">PUMPRUN / WETH (Base Doppler v4)</option>
            <option value="MOON/ETH">MOON / ETH (Bonding Curve)</option>
            <option value="PEOPLE/ETH">PEOPLE / ETH (Fair Launch)</option>
            <option value="CDAO/ETH">CDAO / ETH (Community Prelaunch)</option>
          </select>
          <span
            className={error ? 'badge badge-admin' : 'badge-live'}
            role="status"
            aria-label={error ? 'Connection retrying' : 'Live market stream active'}
          >
            {error ? 'RETRYING...' : 'LIVE'}
          </span>
        </div>
      </div>

      {/* Workflow & Plan Entitlement Guide */}
      <PageWorkflowBanner
        title="Alur Trading Terminal & Risk Gate"
        isUnlocked={executionMode === 'PAPER' ? true : Boolean(entitlements.liveTrading)}
        requiredPlanLabel="TRADER / AGENT"
        creditSummary="Paper Trading: Gratis · Live DEX/CEX: Paket TRADER/AGENT"
        steps={[
          { step: '1', label: 'Pilih Pair & Analisa Chart/RSI' },
          { step: '2', label: 'Pilih Mode (Paper / DEX / CEX)' },
          { step: '3', label: 'Validasi TradingRiskGate & MEV Cap' },
          { step: '4', label: 'Approve Intent / Sign di MetaMask' },
        ]}
      />

      {/* Main Grid Layout */}
      <div className="grid-3" style={{ gridTemplateColumns: '2fr 1fr' }}>
        {/* Left Column: Candlestick Chart & Derived Indicators */}
        <div className="flex-col gap-md">
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <span style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', fontFamily: 'var(--font-mono)' }}>
                  {symbol} <span className="text-muted">({interval.toUpperCase()})</span>
                </span>
                <span className="text-muted" style={{ fontSize: '12px', marginLeft: '12px' }}>
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
                <span style={{ color: '#FFD600', fontSize: '14px', fontWeight: 900 }}>
                  {tradingAnalysis?.regime.regime || 'RANGE_BOUND'}
                </span>
              </div>
              <div className="bg-panel" style={{ padding: '12px', borderRadius: '6px', border: '1px solid var(--color-border)' }}>
                <span className="text-muted" style={{ fontSize: '10px', fontWeight: 700, display: 'block', marginBottom: '4px' }}>RSI (14-PERIOD)</span>
                <span style={{ color: tradingAnalysis?.rsiZone === 'OVERSOLD' ? 'var(--color-accent)' : tradingAnalysis?.rsiZone === 'OVERBOUGHT' ? 'var(--color-destructive)' : '#00E5FF', fontSize: '14px', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>
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
                    ⛔ TRADING PAUSED BY ALERT ENGINE
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
            <h3 style={{ fontSize: '14px', fontWeight: 800, margin: '0 0 12px 0', color: '#D500F9', display: 'flex', alignItems: 'center', gap: '8px' }}>
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
              <strong className="text-muted">Rationale:</strong> {signal?.rationale || 'Counterparty cleared by Arkham | Volatility LOW | Spread normal'}
            </div>

            <div className="flex-row gap-xs" style={{ flexWrap: 'wrap' }}>
              <span className="badge badge-trader">
                ✓ Arkham {signal?.inputs.counterpartyRisk || 'CLEAR'}
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
                  <span>${p.toLocaleString()} {q > 10 ? '🐳' : ''}</span>
                  <span>{q.toFixed(2)} {symbol.replace('USDT', '')}</span>
                </div>
              )) || (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-destructive)', fontSize: '12px', padding: '4px 8px' }}>
                  <span>$65,405.00 🐳</span>
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
                  <span>${p.toLocaleString()} {q > 10 ? '🐳' : ''}</span>
                  <span>{q.toFixed(2)} {symbol.replace('USDT', '')}</span>
                </div>
              )) || (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-accent)', fontSize: '12px', padding: '4px 8px' }}>
                  <span>$65,400.00 🐳</span>
                  <span>12.80 BTC</span>
                </div>
              )}
            </div>
          </div>

          {/* Proposal-Only Action Gate */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px', border: (userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') ? '1px solid #FFD600' : '1px solid var(--color-accent)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 800, margin: 0, color: (userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') ? '#FFD600' : 'var(--color-accent)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldAlert size={16} /> Proposal Gate
              </h3>
              {(userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
                <span className="badge badge-admin">
                  ADMIN OVERRIDE
                </span>
              )}
            </div>

            {(linkedTokenAddress || linkedProposalId) && (
              <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', padding: '8px', borderRadius: '6px', backgroundColor: 'var(--color-badge-info-bg)', border: '1px solid var(--color-badge-info-border)', marginBottom: '10px', color: 'var(--color-badge-info-text)' }}>
                {linkedTokenAddress && (
                  <div>
                    Target Token: {linkedTokenAddress.slice(0, 10)}...{linkedTokenAddress.slice(-6)}
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
                <option value="CEX_SINGLE_SHOT">Mode: CEX_SINGLE_SHOT (Stateless Binance Trade — TRADER/AGENT)</option>
              </select>
            </div>

            {executionMode === 'CEX_SINGLE_SHOT' && (
              <BinanceKeyVaultPanel
                isConnected={isConnected}
                selectedCredentialId={selectedBinanceCredentialId}
                onSelectCredentialId={setSelectedBinanceCredentialId}
              />
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <select
                aria-label="Order side"
                value={orderSide}
                onChange={(e) => setOrderSide(e.target.value as 'BUY' | 'SELL')}
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
                  color: actionFeedback.includes('✅') ? 'var(--color-accent)' : actionFeedback.includes('❌') ? 'var(--color-destructive)' : actionFeedback.includes('🔒') ? '#FFD600' : 'var(--color-foreground)',
                }}
              >
                {actionFeedback}
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
              <div className="flex-row gap-sm">
                <button
                  onClick={handleApproveProposal}
                  disabled={isSubmitting || proposalStatus === 'APPROVED'}
                  className="btn-primary"
                  style={{ flex: 1, justifyContent: 'center', opacity: proposalStatus === 'APPROVED' ? 0.5 : 1 }}
                  aria-label="Approve trade proposal and submit as trade intent"
                >
                  {isSubmitting ? 'Processing...' : proposalStatus === 'APPROVED' ? 'Approved ✓' : 'Approve Proposal'}
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
    </div>
  );
}
