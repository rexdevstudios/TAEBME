'use client';

import React, { useEffect, useState } from 'react';
import { Bot, Plus, Trash2, CheckCircle2, PauseCircle, PlayCircle, Sparkles, Lock } from 'lucide-react';
import type { AgentSkillId, CustomAgentProfile } from '@packages/agent/skill-registry';

interface SkillCatalogItem {
  id: AgentSkillId;
  name: string;
  description: string;
  executionRail: string;
  nonCustodialGuard: string;
  badgeColor: string;
}

interface CustomAgentBuilderPanelProps {
  isConnected: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agent: CustomAgentProfile | null) => void;
}

export function CustomAgentBuilderPanel({
  isConnected,
  selectedAgentId,
  onSelectAgent,
}: CustomAgentBuilderPanelProps) {
  const [agents, setAgents] = useState<CustomAgentProfile[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([]);
  const [planId, setPlanId] = useState<string>('FREE');
  const [maxAgents, setMaxAgents] = useState<number>(1);
  const [showCreateForm, setShowCreateForm] = useState<boolean>(false);

  const [name, setName] = useState('');
  const [strategyProfile, setStrategyProfile] = useState('MOMENTUM_BREAKOUT');
  const [riskLevel, setRiskLevel] = useState('MODERATE');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [targetSymbols, setTargetSymbols] = useState('BTCUSDT, ETHUSDT');
  const [selectedSkills, setSelectedSkills] = useState<AgentSkillId[]>(['SKILL_CEX_TRADE', 'SKILL_DEX_SWAP']);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadAgents = async () => {
    if (!isConnected) return;
    try {
      const res = await fetch('/api/agent/profiles');
      const json = await res.json();
      if (json?.success && json.data) {
        setAgents(json.data.agents || []);
        setSkillCatalog(json.data.skillCatalog || []);
        setPlanId(json.data.planId || 'FREE');
        setMaxAgents(Number(json.data.maxCustomAgents || 1));
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const toggleSkill = (id: AgentSkillId) => {
    setSelectedSkills((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || systemPrompt.trim().length < 10) return;
    if (selectedSkills.length === 0) {
      setFeedback('Notice: Pilih minimal 1 Modular Agent Skill.');
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/agent/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          strategyProfile,
          riskToleranceLevel: riskLevel,
          systemPrompt: systemPrompt.trim(),
          targetSymbols,
          enabledSkills: selectedSkills,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`Notice: ${json?.error || 'Gagal membuat custom agent'}`);
      } else {
        setName('');
        setSystemPrompt('');
        setShowCreateForm(false);
        setFeedback(`OK: Custom Agent "${json.data.name}" berhasil dibuat dengan ${json.data.enabledSkills.length} skill aktif.`);
        await loadAgents();
        onSelectAgent(json.data);
      }
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (agent: CustomAgentProfile) => {
    const nextStatus = agent.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    await fetch('/api/agent/profiles', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, status: nextStatus }),
    });
    await loadAgents();
  };

  const handleDelete = async (agentId: string) => {
    await fetch(`/api/agent/profiles?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    if (selectedAgentId === agentId) onSelectAgent(null);
    await loadAgents();
  };

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '18px',
        marginBottom: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Bot size={16} style={{ color: 'var(--color-accent-info)' }} /> Custom AI Agent Builder &amp; Modular Skills ({agents.length}/{maxAgents} · {planId})
          </h2>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            Rancang AI Agent dengan strategi, prompt, dan pilihan skill sendiri (Binance CEX, Bankr Deploy, NFT Mint Voucher, DEX Swap) — 100% Non-Custodial.
          </p>
        </div>
        {isConnected && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {agents.length >= maxAgents && (
              <a href="/billing" style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-accent-info)', textDecoration: 'underline' }}>
                Upgrade Slot →
              </a>
            )}
            <button
              type="button"
              onClick={() => setShowCreateForm((v) => !v)}
              className="btn-primary"
              style={{ fontSize: '11px', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <Plus size={13} /> {showCreateForm ? 'Tutup Form' : 'Buat Custom Agent'}
            </button>
          </div>
        )}
      </div>

      {!isConnected ? (
        <div style={{ fontSize: '12px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={13} /> Hubungkan wallet (SIWE) untuk merancang dan menyimpan Custom AI Agent Anda.
        </div>
      ) : (
        <>
          {showCreateForm && (
            <form
              onSubmit={handleCreate}
              style={{
                padding: '14px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                <input
                  type="text"
                  placeholder="Nama Agent (mis: Alpha Sniper v1)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px' }}
                  required
                />
                <select
                  aria-label="Agent strategy profile"
                  value={strategyProfile}
                  onChange={(e) => setStrategyProfile(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontWeight: 700 }}
                >
                  <option value="MOMENTUM_BREAKOUT">Strategy: MOMENTUM_BREAKOUT</option>
                  <option value="EARLY_SNIPER">Strategy: EARLY_SNIPER</option>
                  <option value="DIP_ACCUMULATOR">Strategy: DIP_ACCUMULATOR</option>
                  <option value="CONSERVATIVE_DCA">Strategy: CONSERVATIVE_DCA</option>
                </select>
                <select
                  aria-label="Agent risk tolerance"
                  value={riskLevel}
                  onChange={(e) => setRiskLevel(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontWeight: 700 }}
                >
                  <option value="LOW">Risk: LOW</option>
                  <option value="MODERATE">Risk: MODERATE</option>
                  <option value="HIGH">Risk: HIGH</option>
                  <option value="DEGEN">Risk: DEGEN</option>
                </select>
                <input
                  type="text"
                  placeholder="Target Pair (cth: BTCUSDT, ETHUSDT)"
                  value={targetSymbols}
                  onChange={(e) => setTargetSymbols(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <textarea
                rows={3}
                placeholder="Instruksi / Custom System Prompt (min 10 karakter, mis: Cari breakout volume > 2x pada ETHUSDT, konfirmasi RSI < 65, siapkan eksekusi Binance CEX atau mint pass jika skor > 80)..."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                className="input"
                style={{ padding: '8px 10px', fontSize: '12px', resize: 'vertical' }}
                required
              />

              <div>
                <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-muted)', marginBottom: '6px' }}>
                  Pilih Modular Agent Skills (Plug-and-Play · Non-Custodial):
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px' }}>
                  {skillCatalog.map((skill) => {
                    const checked = selectedSkills.includes(skill.id);
                    return (
                      <label
                        key={skill.id}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '6px',
                          border: `1px solid ${checked ? skill.badgeColor : 'var(--color-border)'}`,
                          background: checked ? 'rgba(56, 189, 248, 0.08)' : 'transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          gap: '8px',
                          alignItems: 'flex-start',
                          fontSize: '11px',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSkill(skill.id)}
                          style={{ marginTop: '2px' }}
                        />
                        <div>
                          <div style={{ fontWeight: 800, color: 'var(--color-foreground)' }}>{skill.name}</div>
                          <div className="text-muted" style={{ fontSize: '10px', lineHeight: 1.35 }}>{skill.description}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <button type="submit" disabled={saving} className="btn-primary" style={{ alignSelf: 'flex-start', fontSize: '12px', padding: '7px 14px' }}>
                <Sparkles size={13} /> {saving ? 'Menyimpan...' : 'Simpan & Aktifkan Custom Agent'}
              </button>
            </form>
          )}

          {agents.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
              {agents.map((agent) => {
                const isSelected = selectedAgentId === agent.id;
                return (
                  <div
                    key={agent.id}
                    style={{
                      padding: '12px',
                      borderRadius: '8px',
                      border: `1px solid ${isSelected ? 'var(--color-accent-info)' : 'var(--color-border)'}`,
                      background: isSelected ? 'rgba(56, 189, 248, 0.07)' : 'transparent',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                      <strong style={{ fontSize: '13px', color: 'var(--color-foreground)' }}>{agent.name}</strong>
                      <span style={{ fontSize: '10px', fontWeight: 800, color: agent.status === 'PAUSED' ? '#F59E0B' : '#10B981', fontFamily: 'var(--font-mono)' }}>
                        {agent.status}
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
                      {agent.strategyProfile} · Risk: {agent.riskToleranceLevel}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--color-muted)', lineHeight: 1.4 }}>
                      {agent.systemPrompt.slice(0, 110)}{agent.systemPrompt.length > 110 ? '…' : ''}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {agent.enabledSkills.map((sk) => (
                        <span
                          key={sk}
                          style={{
                            fontSize: '9px',
                            fontWeight: 800,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            border: '1px solid var(--color-border)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {sk.replace('SKILL_', '')}
                        </span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => onSelectAgent(isSelected ? null : agent)}
                        className={isSelected ? 'btn-primary' : 'btn-secondary'}
                        style={{ fontSize: '10px', padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <CheckCircle2 size={11} /> {isSelected ? 'Aktif di Desk ✓' : 'Pakai di 5-Agent Desk'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleStatus(agent)}
                        className="btn-secondary"
                        style={{ fontSize: '10px', padding: '4px 7px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      >
                        {agent.status === 'PAUSED' ? <PlayCircle size={11} /> : <PauseCircle size={11} />}
                        {agent.status === 'PAUSED' ? 'Resume' : 'Pause'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(agent.id)}
                        className="btn-destructive"
                        style={{ fontSize: '10px', padding: '4px 7px' }}
                        aria-label={`Delete ${agent.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {feedback && (
        <div style={{ fontSize: '12px', color: feedback.startsWith('OK:') ? '#10B981' : '#F59E0B' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
