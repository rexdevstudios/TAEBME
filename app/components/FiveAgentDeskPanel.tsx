'use client';

import React, { useState, useEffect } from 'react';
import { Radar, Microscope, BrainCircuit, ShieldCheck, Zap, AlertTriangle, ArrowRight, CheckCircle2, ExternalLink } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';
import { STRATEGY_PROFILES, type StrategyProfileId } from '@packages/intelligence/dex-market-scanner';
import { TokenSafetyBadgeCard } from './TokenSafetyBadgeCard';

interface FiveAgentDeskPanelProps {
  isConnected: boolean;
  defaultSymbol: string;
  defaultAction: 'BUY' | 'SELL';
  defaultQty: number;
  selectedAgentId?: string | null;
  selectedAgentName?: string | null;
  selectedLlmProvider?: 'PLATFORM' | 'GEMINI' | 'OPENAI' | 'ANTHROPIC';
  selectedLlmModel?: string;
}

const AGENT_META: Record<string, { color: string; icon: React.ReactNode; subtitle: string }> = {
  SCANNER: { color: '#10B981', icon: <Radar size={15} />, subtitle: 'Finds pairs & macro regime' },
  ANALYST: { color: '#A855F7', icon: <Microscope size={15} />, subtitle: 'Evaluates tokens & risk flags' },
  BRAIN: { color: 'var(--color-accent-info)', icon: <BrainCircuit size={15} />, subtitle: 'Sizes entries & LLM advisory' },
  RISK: { color: '#F43F5E', icon: <ShieldCheck size={15} />, subtitle: 'Immutable loss & rule guard' },
  EXECUTOR: { color: '#F59E0B', icon: <Zap size={15} />, subtitle: 'Zero-collision execution' },
};

export function FiveAgentDeskPanel({
  isConnected,
  defaultSymbol,
  defaultAction,
  defaultQty,
  selectedAgentId,
  selectedAgentName,
  selectedLlmProvider = 'PLATFORM',
  selectedLlmModel,
}: FiveAgentDeskPanelProps) {
  const { tr } = useLocale();
  const { refreshSession } = useAuth();
  const [targetSource, setTargetSource] = useState<'CEX' | 'LAUNCHPAD' | 'EXTERNAL_DEX'>('CEX');
  const [launchpadTokens, setLaunchpadTokens] = useState<any[]>([]);
  const [tokenAddress, setTokenAddress] = useState<string>('');
  const [dexNetwork, setDexNetwork] = useState<string>('base');
  const [strategyProfile, setStrategyProfile] = useState<StrategyProfileId>('MOMENTUM_BREAKOUT');
  const [mode, setMode] = useState<'PAPER' | 'LIVE_ADVISORY'>('PAPER');
  const [symbol, setSymbol] = useState(defaultSymbol || 'BTCUSDT');
  const [action, setAction] = useState<'BUY' | 'SELL'>(defaultAction || 'BUY');
  const [quantity, setQuantity] = useState<number>(defaultQty || 100);
  const [maxSlippagePct, setMaxSlippagePct] = useState<number>(1.5);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/launchpad/tokens')
      .then((r) => r.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data)) {
          setLaunchpadTokens(json.data);
        }
      })
      .catch(() => {});
  }, []);

  const handleSelectStrategy = (id: StrategyProfileId) => {
    setStrategyProfile(id);
    const cfg = STRATEGY_PROFILES[id];
    if (cfg) setMaxSlippagePct(cfg.recommendedSlippagePct);
  };

  const handleRunDesk = async () => {
    if (!isConnected) {
      setError('Hubungkan dompet Web3 (MetaMask) terlebih dahulu untuk menjalankan AI Trading Desk.');
      return;
    }
    if (targetSource === 'EXTERNAL_DEX' && !tokenAddress.trim()) {
      setError('Tempel Contract Address (0x... / Solana Mint) dari GeckoTerminal atau DexScreener terlebih dahulu.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const effectiveSymbol = targetSource === 'EXTERNAL_DEX' ? 'TOKEN' : symbol;
      const effectiveAddr = targetSource === 'CEX' ? undefined : tokenAddress.trim() || undefined;
      const res = await fetch('/api/agent/desk/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: effectiveSymbol,
          action,
          quantity,
          maxSlippagePct,
          mode,
          tokenAddress: effectiveAddr,
          dexNetwork: targetSource === 'CEX' ? undefined : dexNetwork,
          strategyProfile,
          ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
          ...(selectedLlmProvider && selectedLlmProvider !== 'PLATFORM'
            ? { llmProvider: selectedLlmProvider, ...(selectedLlmModel ? { llmModel: selectedLlmModel } : {}) }
            : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(`AI Trading Desk (${res.status}): ${json.error || 'Gagal menjalankan siklus analisis'}`);
        return;
      }
      setReport(json.data);
      refreshSession().catch(() => {});
    } catch (err: any) {
      setError(`Koneksi gagal: ${err?.message || 'Unknown error'}`);
    } finally {
      setRunning(false);
    }
  };

  const agents = report?.agents || [
    { agent: 'SCANNER', status: 'READY', summary: 'Idle — ready to scan active SSOT launches & macro TVL', elapsedMs: 0 },
    { agent: 'ANALYST', status: 'READY', summary: 'Idle — ready to evaluate FeatureEngine & counterparty flags', elapsedMs: 0 },
    { agent: 'BRAIN', status: 'READY', summary: 'Idle — ready to size proposal + BytePlus/Gemini advisory', elapsedMs: 0 },
    { agent: 'RISK', status: 'READY', summary: 'Immutable Risk Gate & Kill Switch armed', elapsedMs: 0 },
    { agent: 'EXECUTOR', status: 'READY', summary: 'Zero-collision pipeline standing by', elapsedMs: 0 },
  ];

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid rgba(168, 85, 247, 0.45)',
        borderRadius: '10px',
        padding: '20px',
      }}
    >
      {/* Top Telemetry Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BrainCircuit size={18} style={{ color: 'var(--color-accent-purple)' }} /> {tr('AI Trading Desk (5 Modular Agents)', 'AI Trading Desk (5 Agen Modular)')}
          </h2>
          <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '11px' }}>
            {tr(
              'Analyze Launchpad tokens, external GeckoTerminal / DexScreener contracts (paste CA), or major CEX pairs — protected by an immutable Risk Gate.',
              'Analisa token Launchpad kita, token eksternal GeckoTerminal / DexScreener (paste CA), maupun pair CEX — dilindungi Risk Gate permanen.'
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
          <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)', border: '1px solid var(--color-badge-success-border)' }}>
            COLLISIONS: {report ? report.collisions : 0}
          </span>
          <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'rgba(217, 45, 32, 0.1)', color: 'var(--color-destructive)', border: '1px solid rgba(217, 45, 32, 0.3)' }}>
            RULES: IMMUTABLE
          </span>
          {report?.llmAdvisory?.provider && (
            <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'var(--color-badge-info-bg)', color: 'var(--color-badge-info-text)', border: '1px solid var(--color-badge-info-border)' }}>
              LLM: {report.llmAdvisory.provider}
            </span>
          )}
        </div>
      </div>

      {/* Universal Target Source Tabs (Launchpad Kita / External DEX CA / Major CEX) */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {[
          { id: 'LAUNCHPAD' as const, label: tr(`Our Launchpad Tokens (${launchpadTokens.length})`, `Token Launchpad Kita (${launchpadTokens.length})`) },
          { id: 'EXTERNAL_DEX' as const, label: tr('Paste External CA (GeckoTerminal / DexScreener)', 'Paste CA Eksternal (GeckoTerminal / DexScreener)') },
          { id: 'CEX' as const, label: 'Major CEX Pair' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTargetSource(t.id);
              if (t.id === 'LAUNCHPAD' && launchpadTokens.length > 0) {
                const first = launchpadTokens[0];
                setSymbol(first.ticker || 'TOKEN');
                setTokenAddress(first.contractAddress || '');
                setDexNetwork((first.chain || 'base').replace('-mainnet', '').replace('-sepolia', ''));
              } else if (t.id === 'CEX') {
                setSymbol('BTCUSDT');
                setTokenAddress('');
              }
            }}
            className={targetSource === t.id ? 'btn-primary' : 'btn-secondary'}
            style={{ padding: '5px 10px', fontSize: '11px' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '16px' }}>
        {targetSource === 'LAUNCHPAD' ? (
          <select
            value={tokenAddress}
            onChange={(e) => {
              const ca = e.target.value;
              setTokenAddress(ca);
              const found = launchpadTokens.find((tk) => tk.contractAddress === ca);
              if (found) {
                setSymbol(found.ticker || 'TOKEN');
                setDexNetwork((found.chain || 'base').replace('-mainnet', '').replace('-sepolia', ''));
              }
            }}
            style={{ minWidth: '185px', padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
          >
            {launchpadTokens.length === 0 && <option value="">Belum ada token aktif</option>}
            {launchpadTokens.map((tk: any, idx: number) => (
              <option key={tk.launchId || idx} value={tk.contractAddress || ''}>
                ${tk.ticker || 'TOKEN'} ({tk.name || 'Launch'}) · {tk.chain || 'base'}
              </option>
            ))}
          </select>
        ) : targetSource === 'EXTERNAL_DEX' ? (
          <>
            <select
              value={dexNetwork}
              onChange={(e) => setDexNetwork(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px' }}
            >
              <option value="base">Base</option>
              <option value="arbitrum">Arbitrum</option>
              <option value="eth">Ethereum</option>
              <option value="solana">Solana</option>
              <option value="bsc">BSC</option>
            </select>
            <input
              type="text"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="Paste Contract Address (0x... / Solana Mint)"
              style={{ minWidth: '220px', flex: '1 1 220px', padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            />
          </>
        ) : (
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="Symbol (BTCUSDT)"
            style={{ width: '120px', padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
          />
        )}
        <select
          value={strategyProfile}
          onChange={(e) => handleSelectStrategy(e.target.value as StrategyProfileId)}
          title={STRATEGY_PROFILES[strategyProfile]?.description}
          style={{ padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid rgba(168, 85, 247, 0.45)', color: 'var(--color-accent-purple)', fontSize: '12px', fontWeight: 700 }}
        >
          {Object.values(STRATEGY_PROFILES).map((sp) => (
            <option key={sp.id} value={sp.id}>
              Strategi: {sp.label}
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as 'BUY' | 'SELL')}
          style={{ padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px' }}
        >
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          style={{ width: '95px', padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
        />
        <input
          type="number"
          step={0.1}
          min={0.1}
          max={5}
          value={maxSlippagePct}
          onChange={(e) => setMaxSlippagePct(Number(e.target.value))}
          title="Max Slippage %"
          style={{ width: '80px', padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'PAPER' | 'LIVE_ADVISORY')}
          style={{ padding: '7px 10px', borderRadius: '6px', backgroundColor: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px' }}
        >
          <option value="PAPER">PAPER (Auto-Fill Sim)</option>
          <option value="LIVE_ADVISORY">LIVE (Non-Custodial Handoff)</option>
        </select>
        <button
          type="button"
          className="btn-primary"
          disabled={running}
          onClick={handleRunDesk}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Zap size={13} /> {running ? 'Running 5 Agents...' : 'Run 5-Agent Desk Cycle'}
        </button>
      </div>

      {/* Main Split: 5 Agent Status Cards + READ-BACK Audit Log */}
      <div className="grid-2" style={{ gap: '16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {agents.map((a: any) => {
            const meta = AGENT_META[a.agent] || { color: '#94A3B8', icon: null, subtitle: '' };
            const statusColor =
              a.status === 'DONE'
                ? '#10B981'
                : a.status === 'BLOCKED'
                ? '#EF4444'
                : a.status === 'WAITING_CONFIRMATION'
                ? '#F59E0B'
                : '#64748B';
            return (
              <div
                key={a.agent}
                style={{
                  backgroundColor: 'var(--color-surface-elevated)',
                  border: `1px solid ${a.status === 'BLOCKED' ? '#EF4444' : 'var(--color-border)'}`,
                  borderLeft: `3px solid ${meta.color}`,
                  borderRadius: '6px',
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 800, color: meta.color, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    {meta.icon} {a.agent}
                  </span>
                  <span style={{ fontSize: '10px', fontWeight: 800, color: statusColor, fontFamily: 'var(--font-mono)' }}>
                    {a.status} {a.elapsedMs > 0 ? `(${a.elapsedMs}ms)` : ''}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: '#CBD5E1', lineHeight: 1.4 }}>{a.summary}</div>
              </div>
            );
          })}
        </div>

        {/* Right Column: READ-BACK Log + LLM Advisory + Handoff CTA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div
            style={{
              backgroundColor: 'var(--color-surface-subtle)',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '12px',
              flex: 1,
              minHeight: '220px',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
            }}
          >
            <div style={{ color: '#94A3B8', fontWeight: 800, marginBottom: '8px', letterSpacing: '0.06em' }}>
              READ-BACK AUDIT STREAM
            </div>
            {report?.readBackLog?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {report.readBackLog.map((entry: any) => (
                  <div key={entry.id} style={{ color: entry.ok ? '#A7F3D0' : '#FCA5A5', lineHeight: 1.35 }}>
                    <span style={{ color: '#64748B' }}>{entry.ok ? '✓' : '✕'} {entry.id}</span>{' '}
                    <strong>[{entry.event}]</strong> {entry.detail}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted">Jalankan 1 siklus 5-Agent Desk untuk melihat log READ-BACK real-time tanpa kolisi.</div>
            )}
          </div>

          {report?.tokenSecurity && <TokenSafetyBadgeCard report={report.tokenSecurity} />}

          {report?.dexSnapshot && (
            <div
              style={{
                backgroundColor: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontWeight: 800, color: 'var(--color-text-positive)' }}>
                  Live DEX Telemetry: ${report.dexSnapshot.symbol} ({report.dexSnapshot.source})
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <a href={report.dexSnapshot.pairUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent-info)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    DexScreener <ExternalLink size={10} />
                  </a>
                  <a href={report.dexSnapshot.geckoTerminalUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#A7F3D0', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    GeckoTerminal <ExternalLink size={10} />
                  </a>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', color: '#E2E8F0' }}>
                <div>Price: <strong>${report.dexSnapshot.priceUsd < 0.01 ? report.dexSnapshot.priceUsd.toExponential(2) : report.dexSnapshot.priceUsd.toFixed(4)}</strong></div>
                <div>Liq: <strong>${Math.round(report.dexSnapshot.liquidityUsd).toLocaleString()}</strong></div>
                <div>Vol 24h: <strong>${Math.round(report.dexSnapshot.volume24hUsd).toLocaleString()}</strong></div>
                <div>Buys: <strong>{report.dexSnapshot.buyRatioPct}%</strong></div>
              </div>
            </div>
          )}

          {report?.llmAdvisory && (
            <div
              style={{
                backgroundColor: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontSize: '11px',
              }}
            >
              <div style={{ fontWeight: 800, color: 'var(--color-accent-info)', marginBottom: '4px' }}>
                AI Narrative Advisory ({report.llmAdvisory.provider} · Advisory Only)
              </div>
              <div style={{ color: '#E2E8F0', marginBottom: '4px' }}>{report.llmAdvisory.summary}</div>
              <div style={{ color: 'var(--color-accent-amber)' }}>{report.llmAdvisory.caution}</div>
            </div>
          )}

          {report?.agentActionCards?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--color-accent-info)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>
                {selectedAgentName ? `SKILL ACTION CARDS (${selectedAgentName.toUpperCase()})` : 'MODULAR SKILL ACTION CARDS'}
              </div>
              {report.agentActionCards.map((card: any) => (
                <a
                  key={card.skillId}
                  href={card.href}
                  className="btn-secondary"
                  style={{
                    fontSize: '11px',
                    padding: '8px 10px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    textDecoration: 'none',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left' }}>
                    <strong style={{ color: 'var(--color-foreground)' }}>{card.title}</strong>
                    <span className="text-muted" style={{ fontSize: '10px' }}>{card.subtitle}</span>
                  </div>
                  <span style={{ fontSize: '9px', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--color-accent-info)', flexShrink: 0 }}>
                    {card.badge} →
                  </span>
                </a>
              ))}
            </div>
          )}

          {report?.execution?.handoffUrl && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <a
                href={report.execution.handoffUrl}
                className="btn-primary"
                style={{ fontSize: '12px', padding: '9px 14px', justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: '6px', textDecoration: 'none' }}
              >
                <CheckCircle2 size={14} /> Open Approved Plan in Trading Terminal <ArrowRight size={14} />
              </a>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <a
                  href={`/trading?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(action)}&qty=${encodeURIComponent(String(quantity))}&mode=CEX_SINGLE_SHOT`}
                  className="btn-secondary"
                  style={{ fontSize: '11px', padding: '7px 10px', justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
                >
                  Execute via Binance CEX →
                </a>
                <a
                  href={`/launchpad?name=${encodeURIComponent(symbol.replace(/USDT|USD|WETH|ETH|\//gi, '') || symbol)}&symbol=${encodeURIComponent((symbol.replace(/USDT|USD|WETH|ETH|\//gi, '') || symbol).slice(0, 8))}`}
                  className="btn-secondary"
                  style={{ fontSize: '11px', padding: '7px 10px', justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
                >
                  Deploy via Bankr Vault →
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '6px', backgroundColor: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.35)', color: '#FCA5A5', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={15} /> <span>{error}</span>
        </div>
      )}
    </div>
  );
}
