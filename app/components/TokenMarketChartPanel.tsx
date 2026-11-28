'use client';

import React, { useEffect, useState } from 'react';
import { BarChart2, ExternalLink, MessageSquarePlus, RefreshCw } from 'lucide-react';
import { InteractiveCandlestickChart, OhlcvCandle } from './InteractiveCandlestickChart';
import { useLocale } from '../context/LocaleContext';
import type { ChartCandleMarker, KolConsensusReport } from '@packages/intelligence/kol-chart-overlay';

interface TokenMarketChartPanelProps {
  chain: string;
  contractAddress: string;
  tokenName: string;
  tokenTicker: string;
  raisedAmount: number;
  graduationThreshold: number;
  isGraduated: boolean;
}

const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;

export function TokenMarketChartPanel({
  chain,
  contractAddress,
  tokenName,
  tokenTicker,
  raisedAmount,
  graduationThreshold,
  isGraduated,
}: TokenMarketChartPanelProps) {
  const { tr } = useLocale();
  const [chartMode, setChartMode] = useState<'NATIVE' | 'DEXSCREENER'>('NATIVE');
  const [interval, setIntervalVal] = useState<(typeof TIMEFRAMES)[number]>('1h');
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [chartMarkers, setChartMarkers] = useState<ChartCandleMarker[]>([]);
  const [kolConsensus, setKolConsensus] = useState<KolConsensusReport | null>(null);
  const [chartSource, setChartSource] = useState<string>('BONDING_CURVE');
  const [loading, setLoading] = useState(true);
  const [embedTheme, setEmbedTheme] = useState<'dark' | 'light'>('dark');
  const [showCalloutForm, setShowCalloutForm] = useState(false);
  const [calloutText, setCalloutText] = useState('');
  const [calloutTweetUrl, setCalloutTweetUrl] = useState('');
  const [calloutSide, setCalloutSide] = useState<'BUY' | 'SELL'>('BUY');
  const [calloutBusy, setCalloutBusy] = useState(false);
  const [calloutFeedback, setCalloutFeedback] = useState<string | null>(null);

  useEffect(() => {
    const syncTheme = () => {
      const current = document.documentElement.getAttribute('data-theme');
      setEmbedTheme(current === 'light' ? 'light' : 'dark');
    };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const fetchCandles = async (tf: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        chain,
        address: contractAddress,
        ticker: tokenTicker,
        interval: tf,
        raised: String(raisedAmount || 0),
        target: String(graduationThreshold || 69000),
      });
      const res = await fetch(`/api/market/chart?${qs.toString()}`);
      const json = await res.json();
      if (json?.success && Array.isArray(json.data?.candles)) {
        setCandles(json.data.candles);
        setChartSource(json.data.chartSource || 'BONDING_CURVE');
        setChartMarkers(Array.isArray(json.data.chartMarkers) ? json.data.chartMarkers : []);
        setKolConsensus(json.data.kolConsensus || null);
      }
    } catch {
      // Keep last known candles safely
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCandles(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, contractAddress, interval]);

  const handlePostCallout = async (e: React.FormEvent) => {
    e.preventDefault();
    setCalloutBusy(true);
    setCalloutFeedback(null);
    try {
      const latestPx = candles.length > 0 ? candles[candles.length - 1].close : undefined;
      const res = await fetch('/api/kol/callout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteText: calloutText,
          tweetUrl: calloutTweetUrl || undefined,
          side: calloutSide,
          symbol: tokenTicker,
          tokenAddress: contractAddress,
          chain,
          price: latestPx,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setCalloutFeedback(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setCalloutText('');
      setCalloutTweetUrl('');
      setShowCalloutForm(false);
      setCalloutFeedback('OK: Verified KOL Callout pinned to candlestick chart.');
      await fetchCandles(interval);
    } catch (err: any) {
      setCalloutFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setCalloutBusy(false);
    }
  };

  const dexscreenerChain = chain === 'solana' ? 'solana' : chain;
  const dexscreenerEmbedUrl = `https://dexscreener.com/${dexscreenerChain}/${contractAddress}?embed=1&theme=${embedTheme}&trades=0&info=0`;
  const dexscreenerExternalUrl = `https://dexscreener.com/${dexscreenerChain}/${contractAddress}`;

  return (
    <div
      className="card"
      style={{
        padding: '24px',
        marginBottom: '32px',
      }}
    >
      {/* Header & Controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <BarChart2 size={20} style={{ color: 'var(--color-accent)' }} />
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--color-foreground)' }}>
              Live Market Telemetry &amp; Candlesticks
            </h2>
            <span
              className="badge"
              style={{
                fontSize: '10px',
                fontWeight: 800,
                backgroundColor: chartSource === 'LIVE_DEX' ? 'var(--color-badge-success-bg)' : 'var(--color-badge-info-bg)',
                color: chartSource === 'LIVE_DEX' ? 'var(--color-badge-success-text)' : 'var(--color-badge-info-text)',
                border: `1px solid ${chartSource === 'LIVE_DEX' ? 'var(--color-badge-success-border)' : 'var(--color-badge-info-border)'}`,
              }}
            >
              {chartSource === 'LIVE_DEX'
                ? 'LIVE DEX OHLCV'
                : isGraduated
                ? 'DEX GRADUATED TELEMETRY'
                : 'BONDING CURVE TELEMETRY'}
            </span>
          </div>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: '12px' }}>
            {chartSource === 'LIVE_DEX'
              ? tr(
                  'Real-time candlestick data synchronized from public DEX liquidity pairs.',
                  'Data candlestick real-time tersinkronisasi dari DEX pair publik.',
                  '与公开 DEX 流动性交易对实时同步的 K 线数据。'
                )
              : tr(
                  'Interactive native bonding curve candlestick chart (instant display before DexScreener indexing).',
                  'Grafik candlestick interaktif native dari kurva bonding (langsung tampil tanpa menunggu indeks DexScreener).',
                  '原生联合曲线交互式 K 线图（无需等待 DexScreener 索引即可查看）。'
                )}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Mode Switcher */}
          <div
            style={{
              display: 'inline-flex',
              padding: '3px',
              borderRadius: '9999px',
              backgroundColor: 'var(--color-surface-subtle)',
              border: '1px solid var(--color-border)',
            }}
          >
            <button
              type="button"
              onClick={() => setChartMode('NATIVE')}
              style={{
                padding: '5px 11px',
                borderRadius: '9999px',
                border: 'none',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                backgroundColor: chartMode === 'NATIVE' ? 'var(--color-accent)' : 'transparent',
                color: chartMode === 'NATIVE' ? '#FFFFFF' : 'var(--color-muted)',
                transition: 'all 150ms ease',
              }}
            >
              Native Chart
            </button>
            <button
              type="button"
              onClick={() => setChartMode('DEXSCREENER')}
              style={{
                padding: '5px 11px',
                borderRadius: '9999px',
                border: 'none',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                backgroundColor: chartMode === 'DEXSCREENER' ? 'var(--color-accent)' : 'transparent',
                color: chartMode === 'DEXSCREENER' ? '#FFFFFF' : 'var(--color-muted)',
                transition: 'all 150ms ease',
              }}
            >
              DexScreener
            </button>
          </div>

          <a
            href={dexscreenerExternalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
          >
            <span>{tr('Open DexScreener', 'Buka DexScreener', '打开 DexScreener')}</span>
            <ExternalLink size={12} />
          </a>
        </div>
      </div>

      {/* Timeframe Bar (for Native Chart) */}
      {chartMode === 'NATIVE' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setIntervalVal(tf)}
                className="filter-pill"
                data-active={interval === tf ? 'true' : 'false'}
              >
                {tf}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => setShowCalloutForm((v) => !v)}
              className="btn-secondary"
              style={{ padding: '4px 10px', fontSize: '11px', gap: '5px', display: 'inline-flex', alignItems: 'center' }}
            >
              <MessageSquarePlus size={11} />
              {showCalloutForm
                ? tr('Close Callout', 'Tutup Callout', '收起喊单')
                : tr('Post KOL Callout', 'Posting KOL Callout', '发布 KOL 喊单')}
            </button>
            <button
              type="button"
              onClick={() => fetchCandles(interval)}
              className="btn-secondary"
              style={{ padding: '4px 10px', fontSize: '11px', gap: '5px' }}
              disabled={loading}
            >
              <RefreshCw size={11} />
              {loading ? tr('Loading...', 'Memuat...', '加载中...') : tr('Refresh', 'Muat Ulang', '刷新')}
            </button>
          </div>
        </div>
      )}

      {chartMode === 'NATIVE' && showCalloutForm && (
        <form
          onSubmit={handlePostCallout}
          className="bg-panel"
          style={{
            padding: '12px',
            marginBottom: '12px',
            borderRadius: '8px',
            border: '1px solid var(--color-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            Verified KOL Chart Callout (Pin quote &amp; X link directly onto ${tokenTicker} candle)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px' }}>
            <select
              value={calloutSide}
              onChange={(e) => setCalloutSide(e.target.value === 'SELL' ? 'SELL' : 'BUY')}
              className="input"
              style={{ padding: '6px 8px', fontSize: '11px' }}
            >
              <option value="BUY">BUY Callout</option>
              <option value="SELL">SELL Callout</option>
            </select>
            <input
              type="text"
              required
              minLength={4}
              maxLength={280}
              value={calloutText}
              onChange={(e) => setCalloutText(e.target.value)}
              placeholder="Write short thesis / callout quote (4-280 chars)..."
              className="input"
              style={{ padding: '6px 10px', fontSize: '12px' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="url"
              value={calloutTweetUrl}
              onChange={(e) => setCalloutTweetUrl(e.target.value)}
              placeholder="Optional tweet link (https://x.com/... or https://warpcast.com/...)"
              className="input"
              style={{ flex: 1, minWidth: '220px', padding: '6px 10px', fontSize: '11px' }}
            />
            <button
              type="submit"
              disabled={calloutBusy}
              className="btn-primary"
              style={{ padding: '6px 14px', fontSize: '11px' }}
            >
              {calloutBusy ? 'Pinning...' : 'Pin Callout'}
            </button>
          </div>
        </form>
      )}

      {calloutFeedback && (
        <div
          style={{
            marginBottom: '10px',
            padding: '7px 10px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 700,
            backgroundColor: calloutFeedback.startsWith('OK:')
              ? 'var(--color-badge-success-bg)'
              : 'var(--color-badge-warning-bg)',
            color: calloutFeedback.startsWith('OK:')
              ? 'var(--color-badge-success-text)'
              : 'var(--color-badge-warning-text)',
          }}
        >
          {calloutFeedback}
        </div>
      )}

      {/* Chart Canvas */}
      {chartMode === 'NATIVE' ? (
        <InteractiveCandlestickChart
          candles={candles}
          height={370}
          symbol={`$${tokenTicker} / USD`}
          markers={chartMarkers}
          kolConsensus={kolConsensus}
        />
      ) : (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '460px',
            borderRadius: '10px',
            overflow: 'hidden',
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface-subtle)',
          }}
        >
          <iframe
            src={dexscreenerEmbedUrl}
            title={`${tokenName} DexScreener Chart`}
            style={{ width: '100%', height: '100%', border: 'none' }}
            loading="lazy"
          />
        </div>
      )}
    </div>
  );
}
