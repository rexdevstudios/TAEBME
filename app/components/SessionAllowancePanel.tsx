'use client';

import React, { useState } from 'react';
import { ShieldCheck, KeyRound, ChevronDown, ChevronUp } from 'lucide-react';
import { EVM_DEX_CHAINS } from '@packages/launchpad/web3-provider';

interface SessionAllowancePanelProps {
  isConnected: boolean;
}

export function SessionAllowancePanel({ isConnected }: SessionAllowancePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedChainId, setSelectedChainId] = useState<number>(8453);
  const [delegateAddress, setDelegateAddress] = useState('');
  const [dailyCapUsd, setDailyCapUsd] = useState(250);
  const [expiryDays, setExpiryDays] = useState(7);
  const [allowSwap, setAllowSwap] = useState(true);
  const [allowMint, setAllowMint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const handleValidateAllowance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) {
      setResultMsg('Auth: Hubungkan dompet MetaMask terlebih dahulu.');
      return;
    }
    const actions: Array<'SWAP_DEX' | 'MINT_NFT'> = [];
    if (allowSwap) actions.push('SWAP_DEX');
    if (allowMint) actions.push('MINT_NFT');
    if (actions.length === 0) {
      setResultMsg('Notice: Pilih minimal satu izin aksi (SWAP_DEX atau MINT_NFT).');
      return;
    }

    setSubmitting(true);
    setResultMsg(null);
    try {
      const expiresAtIso = new Date(
        Date.now() + Math.max(1, Math.min(30, expiryDays)) * 24 * 60 * 60 * 1000
      ).toISOString();
      const res = await fetch('/api/agent/session-allowance', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(delegateAddress.trim() ? { delegateAddress: delegateAddress.trim() } : {}),
          chainId: selectedChainId,
          dailySpendCapUsd: dailyCapUsd,
          expiresAtIso,
          allowedContracts: ['0x0000000000001fF3684f28c67538d4D072C22734'],
          allowedActions: actions,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setResultMsg(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      const d = json.data;
      setResultMsg(
        `OK: Spec ${d.standard} tervalidasi (Tier ${d.planId} · Cap $${d.effectiveDailySpendCapUsd}/hari · Berlaku s/d ${new Date(d.expiresAtIso).toLocaleDateString()} · 0% Custody).`
      );
    } catch (err: any) {
      setResultMsg(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <KeyRound size={15} color="var(--color-accent-info)" />
          <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            ERC-7715 Non-Custodial Session Allowance (Semi-Auto DEX Guard)
          </span>
          <span
            style={{
              fontSize: '9px',
              fontWeight: 800,
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'rgba(16, 185, 129, 0.14)',
              color: 'var(--color-text-positive)',
            }}
          >
            <ShieldCheck size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
            Zero Private Keys · Max 30 Hari
          </span>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="btn-secondary"
          style={{ padding: '4px 9px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          {expanded ? (
            <>
              Tutup <ChevronUp size={12} />
            </>
          ) : (
            <>
              Atur Allowance <ChevronDown size={12} />
            </>
          )}
        </button>
      </div>

      {expanded && (
        <form onSubmit={handleValidateAllowance} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
            <div className="flex-col gap-xs">
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>
                Jaringan EVM (6 Chain)
              </label>
              <select
                aria-label="Session Allowance EVM Chain"
                value={selectedChainId}
                onChange={(e) => setSelectedChainId(Number(e.target.value) || 8453)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
              >
                {Object.values(EVM_DEX_CHAINS).map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.name} ({c.chainId})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-col gap-xs">
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>
                Public Delegate Address (Opsional — Default Wallet Anda)
              </label>
              <input
                type="text"
                placeholder="0x... (Hanya alamat publik, bukan private key)"
                value={delegateAddress}
                onChange={(e) => setDelegateAddress(e.target.value)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div className="flex-col gap-xs">
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>
                Daily Spend Cap ($ USD · Clamped ke Tier)
              </label>
              <input
                type="number"
                min={10}
                max={25000}
                value={dailyCapUsd}
                onChange={(e) => setDailyCapUsd(Math.max(10, Number(e.target.value) || 100))}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div className="flex-col gap-xs">
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>
                Masa Berlaku (1 – 30 Hari)
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={expiryDays}
                onChange={(e) => setExpiryDays(Math.max(1, Math.min(30, Number(e.target.value) || 7)))}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--color-muted)' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={allowSwap} onChange={(e) => setAllowSwap(e.target.checked)} />
                SWAP_DEX (0x Base AllowanceHolder)
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                <input type="checkbox" checked={allowMint} onChange={(e) => setAllowMint(e.target.checked)} />
                MINT_NFT (Agent Pass)
              </label>
            </div>
            <button type="submit" disabled={submitting || !isConnected} className="btn-primary" style={{ padding: '6px 12px', fontSize: '11px' }}>
              {submitting ? 'Memvalidasi...' : 'Validasi & Siapkan Spec ERC-7715'}
            </button>
          </div>
        </form>
      )}

      {resultMsg && (
        <div style={{ fontSize: '11px', color: resultMsg.startsWith('OK:') ? 'var(--color-text-positive)' : '#FBBF24' }}>
          {resultMsg}
        </div>
      )}
    </div>
  );
}
