'use client';

import React, { useEffect, useState } from 'react';
import { BarChart2, ExternalLink, RefreshCw } from 'lucide-react';
import { InteractiveCandlestickChart, OhlcvCandle } from './InteractiveCandlestickChart';

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
  const [chartMode, setChartMode] = useState<'NATIVE' | 'DEXSCREENER'>('NATIVE');
  const [interval, setIntervalVal] = useState<(typeof TIMEFRAMES)[number]>('1h');
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [chartSource, setChartSource] = useState<string>('BONDING_CURVE');
  const [loading, setLoading] = useState(true);
  const [embedTheme, setEmbedTheme] = useState<'dark' | 'light'>('dark');

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
              ? 'Data candlestick real-time tersinkronisasi dari DEX pair publik.'
              : 'Grafik candlestick interaktif native dari kurva bonding (langsung tampil tanpa menunggu indeks DexScreener).'}
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
            <span>Buka DexScreener</span>
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
          <button
            type="button"
            onClick={() => fetchCandles(interval)}
            className="btn-secondary"
            style={{ padding: '4px 10px', fontSize: '11px', gap: '5px' }}
            disabled={loading}
          >
            <RefreshCw size={11} />
            {loading ? 'Memuat...' : 'Refresh'}
          </button>
        </div>
      )}

      {/* Chart Canvas */}
      {chartMode === 'NATIVE' ? (
        <InteractiveCandlestickChart
          candles={candles}
          height={370}
          symbol={`$${tokenTicker} / USD`}
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
