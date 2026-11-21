'use client';

import React, { useState } from 'react';

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InteractiveCandlestickChartProps {
  candles: OhlcvCandle[];
  height?: number;
  symbol?: string;
}

function formatPriceSmart(val: number): string {
  if (!Number.isFinite(val)) return '0';
  const abs = Math.abs(val);
  if (abs === 0) return '0.00';
  if (abs < 0.001) return val.toFixed(7);
  if (abs < 1) return val.toFixed(5);
  if (abs < 100) return val.toFixed(3);
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTimeShort(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Lightweight, zero-dependency, theme-adaptive (Light & Dark) Interactive Candlestick Chart
 * with hover crosshair, live OHLCV telemetry bar, right Y-axis, and volume histogram.
 */
export function InteractiveCandlestickChart({
  candles,
  height = 360,
  symbol = 'TOKEN',
}: InteractiveCandlestickChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!candles || candles.length === 0) {
    return (
      <div
        className="skeleton-shimmer"
        style={{
          height: `${height}px`,
          borderRadius: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-muted)',
          fontSize: '13px',
        }}
      >
        Memuat grafik candlestick {symbol}...
      </div>
    );
  }

  const width = 920;
  const chartHeight = height - 48;
  const paddingTop = 18;
  const paddingBottom = 52;
  const paddingLeft = 14;
  const paddingRight = 84;
  const usableWidth = width - paddingLeft - paddingRight;
  const usableHeight = chartHeight - paddingTop - paddingBottom;

  const rawMin = Math.min(...candles.map((c) => c.low));
  const rawMax = Math.max(...candles.map((c) => c.high));
  const padRange = (rawMax - rawMin) * 0.08 || Math.max(rawMax * 0.02, 0.000001);
  const minPrice = Math.max(0, rawMin - padRange);
  const maxPrice = rawMax + padRange;
  const priceRange = maxPrice - minPrice || 1;
  const maxVolume = Math.max(...candles.map((c) => c.volume || 0), 1);

  const stepX = usableWidth / candles.length;
  const candleWidth = Math.max(4, Math.min(16, stepX * 0.62));
  const priceToY = (p: number) => paddingTop + ((maxPrice - p) / priceRange) * usableHeight;

  const activeIdx = hoverIdx !== null && candles[hoverIdx] ? hoverIdx : candles.length - 1;
  const activeCandle = candles[activeIdx];
  const prevCandle = activeIdx > 0 ? candles[activeIdx - 1] : activeCandle;
  const deltaPct = prevCandle.close > 0 ? ((activeCandle.close - prevCandle.close) / prevCandle.close) * 100 : 0;
  const isActiveUp = activeCandle.close >= activeCandle.open;
  const latestCandle = candles[candles.length - 1];
  const latestY = priceToY(latestCandle.close);

  const gridLevels = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div style={{ width: '100%', userSelect: 'none' }}>
      {/* Live OHLCV Telemetry Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '8px 12px',
          marginBottom: '8px',
          borderRadius: '8px',
          backgroundColor: 'var(--color-surface-subtle)',
          border: '1px solid var(--color-border)',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--color-foreground)' }}>{symbol}</strong>
          <span style={{ color: 'var(--color-muted)' }}>
            O <strong style={{ color: 'var(--color-foreground)' }}>${formatPriceSmart(activeCandle.open)}</strong>
          </span>
          <span style={{ color: 'var(--color-muted)' }}>
            H <strong style={{ color: 'var(--color-accent-emerald)' }}>${formatPriceSmart(activeCandle.high)}</strong>
          </span>
          <span style={{ color: 'var(--color-muted)' }}>
            L <strong style={{ color: 'var(--color-destructive)' }}>${formatPriceSmart(activeCandle.low)}</strong>
          </span>
          <span style={{ color: 'var(--color-muted)' }}>
            C <strong style={{ color: isActiveUp ? 'var(--color-accent-emerald)' : 'var(--color-destructive)' }}>
              ${formatPriceSmart(activeCandle.close)}
            </strong>
          </span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: '4px',
              fontWeight: 800,
              backgroundColor: deltaPct >= 0 ? 'var(--color-badge-success-bg)' : 'rgba(239, 68, 68, 0.14)',
              color: deltaPct >= 0 ? 'var(--color-badge-success-text)' : 'var(--color-destructive)',
            }}
          >
            {deltaPct >= 0 ? '+' : ''}
            {deltaPct.toFixed(2)}%
          </span>
        </div>
        <div style={{ color: 'var(--color-muted)' }}>
          Vol: <strong style={{ color: 'var(--color-foreground)' }}>{Math.round(activeCandle.volume).toLocaleString()}</strong>
          {' · '}
          {formatTimeShort(activeCandle.timestamp)}
        </div>
      </div>

      {/* Interactive SVG Canvas */}
      <div
        style={{
          width: '100%',
          borderRadius: '10px',
          backgroundColor: 'var(--color-surface-subtle)',
          border: '1px solid var(--color-border)',
          overflow: 'hidden',
        }}
      >
        <svg
          viewBox={`0 0 ${width} ${chartHeight}`}
          style={{ width: '100%', height: `${chartHeight}px`, display: 'block', cursor: 'crosshair' }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Horizontal Price Grid + Right Y-Axis */}
          {gridLevels.map((ratio, idx) => {
            const y = paddingTop + ratio * usableHeight;
            const priceVal = maxPrice - ratio * priceRange;
            return (
              <g key={idx}>
                <line
                  x1={paddingLeft}
                  x2={width - paddingRight}
                  y1={y}
                  y2={y}
                  stroke="var(--color-border)"
                  strokeDasharray="3 4"
                />
                <text
                  x={width - paddingRight + 6}
                  y={y + 4}
                  fill="var(--color-muted)"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  ${formatPriceSmart(priceVal)}
                </text>
              </g>
            );
          })}

          {/* Volume Histogram Bars (Bottom Layer) */}
          {candles.map((c, idx) => {
            const xCenter = paddingLeft + idx * stepX + stepX / 2;
            const volHeight = ((c.volume || 0) / maxVolume) * 34;
            const isUp = c.close >= c.open;
            return (
              <rect
                key={`vol-${idx}`}
                x={xCenter - candleWidth / 2}
                y={chartHeight - 16 - volHeight}
                width={candleWidth}
                height={Math.max(1, volHeight)}
                rx="1.5"
                fill={isUp ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}
              />
            );
          })}

          {/* Candlestick Wicks & Bodies */}
          {candles.map((c, idx) => {
            const xCenter = paddingLeft + idx * stepX + stepX / 2;
            const yHigh = priceToY(c.high);
            const yLow = priceToY(c.low);
            const yOpen = priceToY(c.open);
            const yClose = priceToY(c.close);
            const isUp = c.close >= c.open;
            const color = isUp ? '#10B981' : '#EF4444';
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
            const isHovered = hoverIdx === idx;

            return (
              <g
                key={`c-${idx}`}
                onMouseEnter={() => setHoverIdx(idx)}
              >
                {/* Invisible wider hit zone for effortless hover */}
                <rect
                  x={paddingLeft + idx * stepX}
                  y={paddingTop}
                  width={stepX}
                  height={usableHeight + 24}
                  fill="transparent"
                />
                {isHovered && (
                  <line
                    x1={xCenter}
                    x2={xCenter}
                    y1={paddingTop}
                    y2={chartHeight - 16}
                    stroke="var(--color-accent)"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.7"
                  />
                )}
                <line
                  x1={xCenter}
                  x2={xCenter}
                  y1={yHigh}
                  y2={yLow}
                  stroke={color}
                  strokeWidth={isHovered ? 2 : 1.4}
                />
                <rect
                  x={xCenter - candleWidth / 2}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  rx="1.5"
                  fill={color}
                  opacity={isHovered ? 1 : 0.9}
                />
              </g>
            );
          })}

          {/* Latest Price Dashed Line & Tag */}
          <line
            x1={paddingLeft}
            x2={width - paddingRight}
            y1={latestY}
            y2={latestY}
            stroke="var(--color-accent)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
          <rect
            x={width - paddingRight + 2}
            y={latestY - 9}
            width={paddingRight - 6}
            height="18"
            rx="4"
            fill="var(--color-accent)"
          />
          <text
            x={width - paddingRight + 6}
            y={latestY + 4}
            fill="#FFFFFF"
            fontSize="10"
            fontWeight="700"
            fontFamily="var(--font-mono)"
          >
            ${formatPriceSmart(latestCandle.close)}
          </text>

          {/* Bottom Time Labels (5 evenly spaced) */}
          {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
            const idx = Math.min(candles.length - 1, Math.floor(r * (candles.length - 1)));
            const x = paddingLeft + idx * stepX + stepX / 2;
            return (
              <text
                key={`t-${i}`}
                x={x}
                y={chartHeight - 3}
                textAnchor="middle"
                fill="var(--color-muted)"
                fontSize="9"
                fontFamily="var(--font-mono)"
              >
                {formatTimeShort(candles[idx].timestamp)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
