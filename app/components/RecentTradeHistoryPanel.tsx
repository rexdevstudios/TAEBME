'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, History, RefreshCw } from 'lucide-react';
import {
  parseDexSettlementFromIdempotencyKey,
  summarizeAndFilterTradeIntents,
  type TradeIntentHistoryFilter,
} from '@packages/launchpad/web3-provider';
import { buildTradeHistoryReTradeUrl } from '@packages/agent/autonomous-terminal-engine';

interface TradeIntentItem {
  id: string;
  stage: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  price?: number;
  idempotencyKey?: string;
  status: string;
  createdAt?: string;
}

interface RecentTradeHistoryPanelProps {
  isConnected: boolean;
  refreshSignal?: number;
}

export function RecentTradeHistoryPanel({
  isConnected,
  refreshSignal = 0,
}: RecentTradeHistoryPanelProps) {
  const [intents, setIntents] = useState<TradeIntentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState<TradeIntentHistoryFilter>('ALL');

  const { counts, filtered } = useMemo(
    () => summarizeAndFilterTradeIntents(intents, activeFilter),
    [intents, activeFilter]
  );

  const loadHistory = async () => {
    if (!isConnected) {
      setIntents([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/trade-intents?limit=10', { credentials: 'same-origin' });
      const json = await res.json();
      if (res.ok && json?.success && Array.isArray(json.data?.intents)) {
        setIntents(json.data.intents);
      }
    } catch {
      // Non-blocking history read
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, refreshSignal]);

  if (!isConnected) return null;

  return (
    <div
      className="bg-panel"
      style={{
        padding: '14px 16px',
        borderRadius: '8px',
        border: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3
          style={{
            margin: 0,
            fontSize: '13px',
            fontWeight: 800,
            color: 'var(--color-foreground)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <History size={14} className="text-accent" /> Riwayat Trade Intent ({intents.length})
        </h3>
        <button
          type="button"
          onClick={loadHistory}
          disabled={loading}
          className="btn-secondary"
          style={{ padding: '3px 7px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <RefreshCw size={10} /> {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {intents.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {(
            [
              { key: 'ALL', label: `All (${counts.total})` },
              { key: 'DEX_SETTLED', label: `DEX Settled (${counts.dexSettled})` },
              { key: 'CEX_OR_PAPER', label: `CEX/Paper (${counts.cexOrPaper})` },
              { key: 'REJECTED', label: `Rejected (${counts.rejected})` },
            ] as const
          ).map((tab) => {
            const active = activeFilter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveFilter(tab.key)}
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: '999px',
                  cursor: 'pointer',
                  border: active ? '1px solid #38BDF8' : '1px solid var(--color-border)',
                  background: active ? 'rgba(56, 189, 248, 0.14)' : 'transparent',
                  color: active ? '#38BDF8' : 'var(--color-muted)',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-muted" style={{ fontSize: '11px' }}>
          {intents.length === 0
            ? 'Belum ada riwayat order yang tercatat untuk dompet ini.'
            : 'Tidak ada order pada filter kategori ini.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto' }}>
          {filtered.map((item) => {
            const isBuy = item.side === 'BUY';
            const isApproved = item.status === 'APPROVED' || item.status === 'EXECUTED';
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, color: isBuy ? '#34D399' : '#F28B82' }}>{item.side}</span>
                  <strong style={{ color: 'var(--color-foreground)' }}>{item.symbol}</strong>
                  <span className="text-muted">×{item.quantity}</span>
                  <span style={{ fontSize: '9px', color: '#38BDF8', fontWeight: 700 }}>{item.stage}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 800,
                      padding: '2px 5px',
                      borderRadius: '4px',
                      background: isApproved ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)',
                      color: isApproved ? '#34D399' : '#F28B82',
                    }}
                  >
                    {item.status}
                  </span>
                  {(() => {
                    const settlement = parseDexSettlementFromIdempotencyKey(item.idempotencyKey);
                    if (!settlement) return null;
                    return (
                      <a
                        href={settlement.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: '9px',
                          fontWeight: 800,
                          color: '#38BDF8',
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '2px',
                        }}
                        title={`Tx: ${settlement.txHash} (Chain #${settlement.chainId})`}
                      >
                        #{settlement.chainId} Explorer <ExternalLink size={9} />
                      </a>
                    );
                  })()}
                  <a
                    href={buildTradeHistoryReTradeUrl(item)}
                    style={{
                      fontSize: '9px',
                      fontWeight: 800,
                      color: '#A78BFA',
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '2px',
                    }}
                    title="Muat ulang parameter order ini ke form trading"
                  >
                    Re-Trade ↗
                  </a>
                  {item.createdAt && (
                    <span className="text-muted" style={{ fontSize: '10px' }}>
                      {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
