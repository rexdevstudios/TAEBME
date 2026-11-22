'use client';

import React, { useEffect, useState } from 'react';
import { Bot, ArrowUpRight, RefreshCw, ShieldCheck, Globe2, Layers, Cpu } from 'lucide-react';
import type { AutonomousTerminalSnapshot } from '@packages/agent/autonomous-terminal-engine';

interface AutonomousAgentTerminalCardProps {
  isConnected: boolean;
}

export function AutonomousAgentTerminalCard({ isConnected }: AutonomousAgentTerminalCardProps) {
  const [snapshot, setSnapshot] = useState<AutonomousTerminalSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const loadTelemetry = async () => {
    if (!isConnected) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/agent/terminal-telemetry', { credentials: 'same-origin' });
      const json = await res.json();
      if (res.ok && json?.success && json.data) {
        setSnapshot(json.data);
      }
    } catch {
      // Non-blocking telemetry
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTelemetry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  return (
    <div
      style={{
        borderRadius: '14px',
        border: '1px solid rgba(168, 85, 247, 0.35)',
        background: 'linear-gradient(160deg, rgba(17, 24, 39, 0.96), rgba(15, 23, 42, 0.92))',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      {/* Hero Top Card */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <Bot size={18} color="#34D399" />
            <span style={{ fontSize: '16px', fontWeight: 900, color: '#F8FAFC' }}>
              RTrader Autonomous Terminal
            </span>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 800,
                padding: '2px 7px',
                borderRadius: '999px',
                background: 'rgba(249, 115, 22, 0.18)',
                color: '#FB923C',
                letterSpacing: '0.04em',
              }}
            >
              DUAL-RAIL · 4 SUB-AGENTS
            </span>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 800,
                padding: '2px 7px',
                borderRadius: '999px',
                background: snapshot?.mode === 'LIVE_NON_CUSTODIAL' ? 'rgba(16, 185, 129, 0.18)' : 'rgba(56, 189, 248, 0.16)',
                color: snapshot?.mode === 'LIVE_NON_CUSTODIAL' ? '#34D399' : '#38BDF8',
              }}
            >
              ● {snapshot?.mode === 'LIVE_NON_CUSTODIAL' ? 'LIVE NON-CUSTODIAL' : 'PAPER / ADVISORY'}
            </span>
          </div>
          <p className="text-muted" style={{ margin: 0, fontSize: '11px' }}>
            1 AI Agent cerdas yang bisa mengeksekusi ke <strong>Internal Launchpad kita</strong> maupun <strong>External DEX (0x Swap v2) &amp; External CEX (Binance / Bybit V5)</strong> — 100% Non-Custodial + Risk Gate.
          </p>
        </div>

        {isConnected && (
          <button
            type="button"
            onClick={loadTelemetry}
            disabled={loading}
            className="btn-secondary"
            style={{ padding: '5px 10px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <RefreshCw size={11} /> {loading ? 'Syncing...' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Dual-Rail Readiness Strip (User-Friendly Overview) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, color: '#34D399', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Layers size={12} /> INTERNAL · LAUNCHPAD
          </div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#E2E8F0', marginTop: '3px' }}>
            {snapshot ? `${snapshot.dualRailReadiness.internalLaunchpadCount} Token Aktif` : 'Bonding Curve & Bankr'}
          </div>
        </div>
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(168, 85, 247, 0.08)', border: '1px solid rgba(168, 85, 247, 0.25)' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, color: '#C084FC', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Globe2 size={12} /> EXTERNAL · DEX 0x v2
          </div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#E2E8F0', marginTop: '3px' }}>
            {snapshot?.dualRailReadiness.externalDexZeroXReady ? 'Live Ready (Base/EVM · 1-Klik)' : 'MetaMask Non-Custodial'}
          </div>
        </div>
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, color: '#60A5FA', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Cpu size={12} /> EXTERNAL · CEX AUTO
          </div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#E2E8F0', marginTop: '3px' }}>
            {snapshot?.dualRailReadiness.externalCexAutoReady ? 'Vault Armed (Binance/Bybit)' : 'Auto-Router (Siap di /trading)'}
          </div>
        </div>
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(249, 115, 22, 0.08)', border: '1px solid rgba(249, 115, 22, 0.25)' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, color: '#FB923C', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <ShieldCheck size={12} /> FIRECRAWL SCOUT
          </div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#E2E8F0', marginTop: '3px' }}>
            {snapshot?.dualRailReadiness.firecrawlReady ? 'Live Web Dataset Active' : 'Quantitative Fallback Active'}
          </div>
        </div>
      </div>

      {!isConnected ? (
        <div className="text-muted" style={{ fontSize: '12px', padding: '10px', borderRadius: '8px', border: '1px dashed var(--color-border)' }}>
          Hubungkan dompet MetaMask (SIWE) untuk melihat telemetri 4 sub-agen, riwayat trade cards, dan live action feed Anda.
        </div>
      ) : snapshot ? (
        <>
          {/* Progress & Approval Metrics */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 800, color: '#34D399' }}>
                {snapshot.totalTrades} intents · {snapshot.approvalRatePct}% Risk-Approved
                <span className="text-muted" style={{ fontWeight: 600, marginLeft: '8px', fontSize: '11px' }}>
                  Tier {snapshot.planId}
                </span>
              </div>
              <span className="text-muted" style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                Cycle Goal: {snapshot.totalTrades}/{snapshot.goalTradesTarget} trades ({snapshot.goalProgressPct}%)
              </span>
            </div>
            <div style={{ height: '6px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.max(4, snapshot.goalProgressPct)}%`,
                  background: 'linear-gradient(90deg, #F97316, #34D399)',
                  borderRadius: '999px',
                }}
              />
            </div>
          </div>

          {/* 4-Agent Attribution Segmented Bar ("Activity by agent") */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 700 }}>
              <span style={{ color: '#E2E8F0' }}>Signal &amp; Activity by Sub-Agent</span>
              <span className="text-muted">4 specialized agents active</span>
            </div>
            <div style={{ display: 'flex', height: '8px', borderRadius: '999px', overflow: 'hidden', gap: '2px' }}>
              {snapshot.agentBreakdown.map((ag) => (
                <div
                  key={ag.id}
                  title={`${ag.label}: ${ag.signalCount} (${ag.sharePct}%)`}
                  style={{
                    width: `${Math.max(8, ag.sharePct)}%`,
                    backgroundColor: ag.color,
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
              {snapshot.agentBreakdown.map((ag) => (
                <span key={ag.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#CBD5E1' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: ag.color, display: 'inline-block' }} />
                  {ag.label} <strong style={{ color: '#F8FAFC' }}>{ag.signalCount}</strong>
                </span>
              ))}
            </div>
          </div>

          {/* Compact Recent Trades Grid */}
          {snapshot.recentTradeCards.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 700 }}>
                <span style={{ color: '#E2E8F0' }}>Recent Agent &amp; Terminal Intents</span>
                <span className="text-muted">{snapshot.totalTrades} total</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px' }}>
                {snapshot.recentTradeCards.map((card) => {
                  const isApproved = card.status === 'APPROVED' || card.status === 'EXECUTED';
                  return (
                    <div
                      key={card.id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        background: 'rgba(30, 41, 59, 0.75)',
                        border: '1px solid rgba(148, 163, 184, 0.16)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                        <strong style={{ color: '#F8FAFC' }}>${card.symbol}</strong>
                        <span style={{ fontSize: '9px', fontWeight: 800, color: card.side === 'BUY' ? '#34D399' : '#F28B82' }}>
                          {card.side}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '10px' }}>
                        <span style={{ color: isApproved ? '#34D399' : '#F28B82', fontWeight: 800 }}>{card.status}</span>
                        <span className="text-muted">×{card.quantity}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Live Color-Coded Agent Action Feed with 1-Click Dual-Rail Handoff */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#E2E8F0' }}>
              Live Agent Feed (1-Klik Handoff → Internal Launchpad / External DEX 0x / External CEX)
            </div>
            {snapshot.liveFeed.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  background: 'rgba(15, 23, 42, 0.75)',
                  borderLeft: `3px solid ${item.color}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '11px' }}>
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 800,
                      padding: '2px 5px',
                      borderRadius: '4px',
                      background: 'rgba(255,255,255,0.08)',
                      color: item.color,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {item.railLabel}
                  </span>
                  <span style={{ color: '#E2E8F0' }}>{item.headline}</span>
                </div>
                <a
                  href={item.href}
                  className="btn-secondary"
                  style={{
                    padding: '3px 8px',
                    fontSize: '10px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Execute <ArrowUpRight size={11} />
                </a>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
