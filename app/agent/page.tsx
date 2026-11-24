'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Bot, ShieldAlert, Settings2, FileCode2, Target, BrainCircuit, Activity, BarChart3, Wallet } from 'lucide-react';
import { FiveAgentDeskPanel } from '../components/FiveAgentDeskPanel';
import { PageWorkflowBanner } from '../components/PageWorkflowBanner';
import { UserRiskPolicyPanel } from '../components/UserRiskPolicyPanel';
import { CustomAgentBuilderPanel } from '../components/CustomAgentBuilderPanel';
import { ByokLlmVaultPanel, type SelectedLlmProvider } from '../components/ByokLlmVaultPanel';
import { AutonomousAgentTerminalCard } from '../components/AutonomousAgentTerminalCard';
import { SessionAllowancePanel } from '../components/SessionAllowancePanel';
import { AutoPilotControlPanel } from '../components/AutoPilotControlPanel';
import type { CustomAgentProfile } from '@packages/agent/skill-registry';

export default function AgentPage() {
  const { isConnected, userRole, hasCapability, entitlements, connectMetaMask, isConnecting, refreshSession } = useAuth();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [action, setAction] = useState<'BUY' | 'SELL'>('BUY');
  const [qty, setQty] = useState(100);
  const [selectedCustomAgent, setSelectedCustomAgent] = useState<CustomAgentProfile | null>(null);
  const [selectedLlmProvider, setSelectedLlmProvider] = useState<SelectedLlmProvider>('PLATFORM');
  const [selectedLlmModel, setSelectedLlmModel] = useState<string>('');
  const [activeAgentTab, setActiveAgentTab] = useState<'autopilot' | 'analyst' | 'pro'>('autopilot');
  const [proposal, setProposal] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Admin weights (hydrated from & persisted to PostgreSQL SSOT via /api/billing/plans)
  const [arkhamWeight, setArkhamWeight] = useState(0.35);
  const [firecrawlWeight, setFirecrawlWeight] = useState(0.25);
  const [ohlcvWeight, setOhlcvWeight] = useState(0.25);
  const [defillamaWeight, setDefillamaWeight] = useState(0.15);
  const [weightsSaving, setWeightsSaving] = useState(false);
  const [weightsFeedback, setWeightsFeedback] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/billing/plans')
      .then((r) => r.json())
      .then((json) => {
        const w = json?.platformConfig?.aiFeatureWeights;
        if (w && typeof w === 'object') {
          if (typeof w.arkham === 'number') setArkhamWeight(w.arkham);
          if (typeof w.firecrawl === 'number') setFirecrawlWeight(w.firecrawl);
          if (typeof w.ohlcv === 'number') setOhlcvWeight(w.ohlcv);
          if (typeof w.defillama === 'number') setDefillamaWeight(w.defillama);
        }
      })
      .catch(() => {});
  }, []);

  const handleSaveWeights = async () => {
    setWeightsSaving(true);
    setWeightsFeedback(null);
    try {
      const res = await fetch('/api/billing/plans', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-platform-config',
          aiFeatureWeights: {
            arkham: arkhamWeight,
            firecrawl: firecrawlWeight,
            ohlcv: ohlcvWeight,
            defillama: defillamaWeight,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setWeightsFeedback(`⚠️ Gagal menyimpan bobot (${res.status}): ${json.error || 'Forbidden / Error'}`);
        return;
      }
      const saved = json.data?.aiFeatureWeights;
      if (saved) {
        setArkhamWeight(saved.arkham);
        setFirecrawlWeight(saved.firecrawl);
        setOhlcvWeight(saved.ohlcv);
        setDefillamaWeight(saved.defillama);
      }
      setWeightsFeedback(
        `✅ Bobot AI tersimpan & dinormalisasi ke PostgreSQL SSOT (Arkham ${Math.round((saved?.arkham ?? arkhamWeight) * 100)}% · Firecrawl ${Math.round((saved?.firecrawl ?? firecrawlWeight) * 100)}% · OHLCV ${Math.round((saved?.ohlcv ?? ohlcvWeight) * 100)}% · DefiLlama ${Math.round((saved?.defillama ?? defillamaWeight) * 100)}%).`
      );
    } catch (err: any) {
      setWeightsFeedback(`⚠️ Gagal menyimpan bobot: ${err?.message || 'Network error'}`);
    } finally {
      setWeightsSaving(false);
    }
  };

  const handleResetWeights = () => {
    setArkhamWeight(0.35);
    setFirecrawlWeight(0.25);
    setOhlcvWeight(0.25);
    setDefillamaWeight(0.15);
    setWeightsFeedback('ℹ️ Bobot dikembalikan ke default (35% / 25% / 25% / 15%). Klik "Simpan Bobot ke SSOT" untuk menerapkan.');
  };

  const handleGenerateProposal = async () => {
    if (!isConnected) {
      setError('🔒 Wallet connection required to trigger AI strategy proposals.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/proposals/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSymbol: symbol,
          action,
          suggestedQty: qty,
          agentId: 'agent-alpha-v1',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success) {
        setProposal(json.data);
        refreshSession().catch(() => {});
      } else {
        setError(json.error?.message || 'Proposal generation failed');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-col gap-lg">
      {/* CEX AI Auto-Pilot & 5-Agent Desk Hero Banner */}
      <div
        className="card"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
          padding: '18px 20px',
          background: 'linear-gradient(135deg, rgba(19, 24, 34, 0.98) 0%, rgba(26, 33, 48, 0.92) 65%, rgba(56, 189, 248, 0.1) 100%)',
          border: '1px solid rgba(56, 189, 248, 0.25)',
        }}
      >
        <div>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#38BDF8', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: '4px' }}>
            24/7 Autonomous AI Trading · Trailing Stop-Loss · GoPlus Anti-Insider
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 900, margin: '0 0 4px 0', color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Bot size={20} style={{ color: '#38BDF8' }} /> AI Auto-Pilot &amp; 5-Agent Desk
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            Analisis peluang beli/jual berbasis data pasar live, likuiditas DEX, dan sentimen — 100% Non-Custodial dengan Risk Gate deterministik.
          </p>
        </div>
        <div className="flex-row gap-sm items-center">
          {(userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
            <span className="badge badge-admin">
              👑 Admin Aktif
            </span>
          )}
          <span className="badge" style={{ backgroundColor: 'rgba(16, 185, 129, 0.12)', color: '#34D399', border: '1px solid rgba(16, 185, 129, 0.32)' }}>
            Non-Custodial Guard
          </span>
        </div>
      </div>

      {/* CEX Category Tab Bar for /agent */}
      <div role="tablist" aria-label="Navigasi Ruang Kerja AI Agent" className="cex-tab-bar">
        {(
          [
            { id: 'autopilot', label: '🤖 Auto-Pilot 24/7 & Sinyal', hint: 'Mudah · Pemula' },
            { id: 'analyst', label: '🧠 5-Agent Analyst Desk', hint: 'Scanner · Analyst · Risk' },
            { id: 'pro', label: '⚙️ Pro Vault & Session', hint: 'BYOK LLM · ERC-7715' },
          ] as const
        ).map((tab) => {
          const active = activeAgentTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveAgentTab(tab.id)}
              className={`cex-tab-btn ${active ? 'active' : ''}`}
              style={{ flex: '1 1 180px', justifyContent: 'space-between' }}
            >
              <span>{tab.label}</span>
              <span style={{ fontSize: '10px', opacity: 0.72, fontWeight: 600 }}>{tab.hint}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: Auto-Pilot & Sinyal (Beginner-Friendly Default) */}
      {activeAgentTab === 'autopilot' && (
        <div className="flex-col gap-lg">
          <AutoPilotControlPanel isConnected={isConnected} />
          <AutonomousAgentTerminalCard isConnected={isConnected} />
        </div>
      )}

      {/* TAB 2: AI Analyst Desk (5-Agent + Proposal Generator) */}
      {activeAgentTab === 'analyst' && (
        <div className="flex-col gap-lg">
          <PageWorkflowBanner
            title="Alur AI Autonomous Desk (Proposal-Only)"
            isUnlocked={Boolean(entitlements.aiProposals)}
            requiredPlanLabel="AGENT"
            creditSummary="5-Agent Desk: -5 cr · Single Proposal: -1 cr"
            steps={[
              { step: '1', label: 'Jalankan 5-Agent Trading Desk', cost: '-5 cr' },
              { step: '2', label: 'Tinjau Skor Risiko & Rasional AI' },
              { step: '3', label: 'Klik Review in Trading Terminal →' },
              { step: '4', label: 'Persetujuan Manual di /trading' },
            ]}
          />

          <FiveAgentDeskPanel
            isConnected={isConnected}
            defaultSymbol={symbol}
            defaultAction={action}
            defaultQty={qty}
            selectedAgentId={selectedCustomAgent?.id || null}
            selectedAgentName={selectedCustomAgent?.name || null}
            selectedLlmProvider={selectedLlmProvider}
            selectedLlmModel={selectedLlmModel}
          />

          <div className="grid-2">
        {/* Left Card: Interactive Proposal Generator */}
        <div className="bg-panel" style={{ borderRadius: '8px', padding: '24px' }}>
          <h2 style={{ color: 'var(--color-foreground)', marginTop: 0, fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <Target size={18} /> Live Proposal Test Generator
          </h2>
          <p className="text-muted" style={{ fontSize: '12px', marginBottom: '20px' }}>
            Generate a real-time AI trade proposal backed by multi-source intelligence scoring.
          </p>

          <div className="flex-col gap-md">
            <div className="flex-col gap-xs">
              <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Target Symbol</label>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="input"
                style={{ padding: '12px', color: 'var(--color-accent)', fontWeight: 800, fontFamily: 'var(--font-mono)' }}
              >
                <option value="BTCUSDT">BTC / USDT</option>
                <option value="ETHUSDT">ETH / USDT</option>
                <option value="SOLUSDT">SOL / USDT</option>
                <option value="DEGEN/USDT">DEGEN / USDT</option>
              </select>
            </div>

            <div className="grid-2">
              <div className="flex-col gap-xs">
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Action</label>
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value as 'BUY' | 'SELL')}
                  className="input"
                  style={{ padding: '12px', fontWeight: 800 }}
                >
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
              </div>

              <div className="flex-col gap-xs">
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Quantity</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(parseFloat(e.target.value) || 1)}
                  className="input"
                  style={{ padding: '12px', fontWeight: 800, fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>

            {!isConnected ? (
              <div className="flex-col gap-xs" style={{ marginTop: '8px' }}>
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
                  style={{ padding: '14px', justifyContent: 'center' }}
                >
                  <Wallet size={16} />
                  {isConnecting ? 'Connecting...' : 'Connect MetaMask to Generate AI Proposals'}
                </button>
                {connectError && (
                  <div style={{ color: 'var(--color-destructive)', fontSize: '12px', textAlign: 'center' }}>
                    {connectError}
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={handleGenerateProposal}
                disabled={loading}
                className="btn-primary"
                style={{
                  backgroundColor: loading ? 'var(--color-panel)' : '#7C4DFF',
                  borderColor: loading ? 'var(--color-border)' : '#7C4DFF',
                  padding: '14px',
                  justifyContent: 'center',
                  marginTop: '8px'
                }}
              >
                {loading ? 'Generating Proposal via Feature Engine...' : '🚀 Generate Intelligence Proposal'}
              </button>
            )}

            {error && (
              <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--color-destructive)', border: '1px solid var(--color-destructive)', padding: '12px', borderRadius: '6px', fontSize: '12px' }}>
                ❌ {error}
              </div>
            )}
          </div>
        </div>

        {/* Right Card: Generated Proposal Payload Display */}
        <div className="bg-panel" style={{ borderRadius: '8px', padding: '24px' }}>
          <h2 style={{ color: 'var(--color-foreground)', marginTop: 0, fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <FileCode2 size={18} /> Proposal Output Inspector
          </h2>

          {proposal ? (
            <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px', border: '1px solid var(--color-border)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Proposal ID:</span>
                <span style={{ color: '#D500F9', fontWeight: 800 }}>{proposal.proposalId || proposal.id}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Confidence Score:</span>
                <span style={{ color: 'var(--color-accent)', fontWeight: 900 }}>
                  {proposal.intelligenceSignal ? `${(proposal.intelligenceSignal.computedConfidenceScore * 100).toFixed(1)}%` : '85.0%'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Macro Sentiment:</span>
                <span style={{ color: '#00E5FF', fontWeight: 800 }}>
                  {proposal.intelligenceSignal?.inputs?.macroSentiment || 'UNAVAILABLE'}
                </span>
              </div>
              <div style={{ marginBottom: '16px' }}>
                <span className="text-muted" style={{ display: 'block', marginBottom: '8px' }}>Signal Rationale:</span>
                <div style={{ color: 'var(--color-foreground)', backgroundColor: 'var(--color-background)', padding: '12px', borderRadius: '4px', border: '1px solid var(--color-border)' }}>
                  {proposal.intelligenceSignal?.rationale || 'N/A'}
                </div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 700, padding: '8px', backgroundColor: 'var(--color-panel)', borderRadius: '4px', textAlign: 'center', marginBottom: '12px' }}>
                Status: PROPOSAL_ONLY • Approval Required: YES
              </div>
              <a
                href={`/trading?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(action)}&qty=${encodeURIComponent(String(qty))}&proposalId=${encodeURIComponent(String(proposal.proposalId || proposal.id || ''))}`}
                className="btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px', textDecoration: 'none', fontSize: '12px' }}
              >
                Review & Approve in Trading Terminal →
              </a>
            </div>
          ) : (
            <div className="bg-panel flex-col items-center justify-center" style={{ padding: '3rem 2rem', textAlign: 'center', color: 'var(--color-muted)', borderRadius: '6px', border: '1px dashed var(--color-border)', fontSize: '13px' }}>
              <BrainCircuit size={32} style={{ marginBottom: '16px', opacity: 0.5 }} />
              Click "Generate Intelligence Proposal" to view live engine payload.
            </div>
          )}
        </div>
      </div>
        </div>
      )}

      {/* TAB 3: Pro Vault, Risk & Custom Agent */}
      {activeAgentTab === 'pro' && (
        <div className="flex-col gap-lg">
          <CustomAgentBuilderPanel
            isConnected={isConnected}
            selectedAgentId={selectedCustomAgent?.id || null}
            onSelectAgent={(ag) => {
              setSelectedCustomAgent(ag);
              if (ag?.targetSymbols?.[0]) setSymbol(ag.targetSymbols[0]);
            }}
          />

          <ByokLlmVaultPanel
            isConnected={isConnected}
            selectedLlmProvider={selectedLlmProvider}
            onSelectLlmProvider={setSelectedLlmProvider}
            selectedLlmModel={selectedLlmModel}
            onSelectLlmModel={setSelectedLlmModel}
          />

          <UserRiskPolicyPanel isConnected={isConnected} />

          <SessionAllowancePanel isConnected={isConnected} />

      {/* Admin Feature Weight Configurator (Exclusive to SUPER_ADMIN / SYSTEM_ADMIN / MANAGE_BILLING_PLANS) */}
      {(hasCapability('MANAGE_BILLING_PLANS') || userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
        <div className="bg-panel" style={{ border: '1px solid #FF9100', borderRadius: '8px', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
            <div>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: '#FFD600', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Settings2 size={18} /> Pengaturan Bobot Analisis AI (Admin)
              </h3>
              <p className="text-muted" style={{ margin: '4px 0 0 0', fontSize: '12px' }}>
                Atur persentase pengaruh tiap sumber data pada skor rekomendasi AI. Total bobot otomatis dinormalisasi ke 100% saat disimpan.
              </p>
            </div>
            <div className="flex-row gap-sm items-center">
              <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: '#38BDF8', fontWeight: 800 }}>
                Total Input: {Math.round((arkhamWeight + firecrawlWeight + ohlcvWeight + defillamaWeight) * 100)}%
              </span>
              <button
                type="button"
                onClick={handleResetWeights}
                disabled={weightsSaving}
                className="btn-secondary"
                style={{ padding: '6px 10px', fontSize: '11px' }}
              >
                Reset Default
              </button>
              <button
                type="button"
                onClick={handleSaveWeights}
                disabled={weightsSaving}
                className="btn-primary"
                style={{ padding: '6px 12px', fontSize: '11px' }}
              >
                {weightsSaving ? 'Menyimpan...' : 'Simpan Pengaturan'}
              </button>
            </div>
          </div>
          <div className="grid-4">
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#00E5FF', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><ShieldAlert size={14} /> On-Chain Wallet Guard</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>{Math.round(arkhamWeight * 100)}%</div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(arkhamWeight * 100)}
                onChange={(e) => setArkhamWeight(Number(e.target.value) / 100)}
                aria-label="On-Chain Wallet Guard Weight"
                style={{ width: '100%', marginBottom: '6px' }}
              />
              <div className="text-muted" style={{ fontSize: '11px' }}>GoPlus + RPC Counterparty &amp; Sanctions Risk ($0)</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#D500F9', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><Activity size={14} /> Firecrawl Sentiment</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>{Math.round(firecrawlWeight * 100)}%</div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(firecrawlWeight * 100)}
                onChange={(e) => setFirecrawlWeight(Number(e.target.value) / 100)}
                aria-label="Firecrawl Sentiment Weight"
                style={{ width: '100%', marginBottom: '6px' }}
              />
              <div className="text-muted" style={{ fontSize: '11px' }}>Web News &amp; Social Buzz</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><BarChart3 size={14} /> Binance OHLCV &amp; RSI</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>{Math.round(ohlcvWeight * 100)}%</div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(ohlcvWeight * 100)}
                onChange={(e) => setOhlcvWeight(Number(e.target.value) / 100)}
                aria-label="Binance OHLCV Weight"
                style={{ width: '100%', marginBottom: '6px' }}
              />
              <div className="text-muted" style={{ fontSize: '11px' }}>Technical Momentum Indicators</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#FFC400', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><Activity size={14} /> DefiLlama Macro TVL</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>{Math.round(defillamaWeight * 100)}%</div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(defillamaWeight * 100)}
                onChange={(e) => setDefillamaWeight(Number(e.target.value) / 100)}
                aria-label="DefiLlama Macro TVL Weight"
                style={{ width: '100%', marginBottom: '6px' }}
              />
              <div className="text-muted" style={{ fontSize: '11px' }}>Chain Liquidity Inflow</div>
            </div>
          </div>
          {weightsFeedback && (
            <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, backgroundColor: weightsFeedback.includes('✅') ? 'rgba(16, 185, 129, 0.14)' : 'rgba(245, 158, 11, 0.14)', color: weightsFeedback.includes('✅') ? '#6EE7B7' : '#FDE047', border: `1px solid ${weightsFeedback.includes('✅') ? 'rgba(16, 185, 129, 0.35)' : 'rgba(245, 158, 11, 0.35)'}` }}>
              {weightsFeedback}
            </div>
          )}
        </div>
      )}
        </div>
      )}
    </div>
  );
}
