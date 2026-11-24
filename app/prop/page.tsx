'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Award, CheckCircle2, RefreshCw, ShieldCheck, Trophy, Wallet } from 'lucide-react';
import {
  PROP_CHALLENGE_RULES,
  type PropChallengeRecord,
} from '@packages/trading/prop-challenge';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';

interface PropApiState {
  rules: typeof PROP_CHALLENGE_RULES;
  treasuryWallet: string;
  totalChallenges: number;
  verifiedTradersCount: number;
  leaderboard: PropChallengeRecord[];
  activeChallenge: PropChallengeRecord | null;
}

export default function PropCupPage() {
  const { isConnected, connectMetaMask, isConnecting, refreshSession } = useAuth();
  const { t, tr } = useLocale();
  const [state, setState] = useState<PropApiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadPropState = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/prop/challenge', { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.success && json.data) {
        setState(json.data);
      }
    } catch {
      // graceful fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPropState();
  }, [isConnected]);

  const handleStart = async (paymentMode: 'CREDITS' | 'ETH') => {
    if (!isConnected) {
      setFeedback('Auth: Connect MetaMask (SIWE) first to enroll in the Proof-of-Skill Prop Challenge.');
      return;
    }
    setBusyAction(`START_${paymentMode}`);
    setFeedback(null);
    try {
      let txHash: string | undefined;
      if (paymentMode === 'ETH' && typeof window !== 'undefined' && window.location.hostname !== 'testnet.pndigi.site') {
        const eth = (window as any).ethereum;
        if (!eth) {
          setFeedback('Notice: MetaMask required to pay 0.005 ETH Base L2 entry fee.');
          return;
        }
        const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
        const from = accounts?.[0];
        if (!from) {
          setFeedback('Notice: MetaMask wallet not connected.');
          return;
        }
        const treasury = state?.treasuryWallet || '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6';
        // 0.005 ETH = 0x11c37937e08000 wei
        txHash = await eth.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: treasury, value: '0x11c37937e08000', gas: '0x5208' }],
        });
      }

      const res = await fetch('/api/prop/challenge', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'START', paymentMode, txHash, chain: 'base-mainnet' }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || 'Enrollment failed'}`);
        return;
      }
      setFeedback('OK: Prop Challenge activated! Trade on /trading and click Evaluate Now once you hit +8% across 3 days.');
      refreshSession().catch(() => {});
      await loadPropState();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Enrollment cancelled or failed'}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleEvaluate = async () => {
    setBusyAction('EVALUATE');
    setFeedback(null);
    try {
      const res = await fetch('/api/prop/challenge', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'EVALUATE' }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || 'Evaluation failed'}`);
        return;
      }
      const c: PropChallengeRecord = json.data;
      setFeedback(
        c.status === 'PASSED'
          ? `OK: Challenge PASSED (+${c.pnlPct}%)! Verified Trader status & +${PROP_CHALLENGE_RULES.passRewardCredits} Credits unlocked.`
          : `OK: Evaluation updated — Status: ${c.status} (${c.verdictReason || `${c.pnlPct}% PnL`}).`
      );
      refreshSession().catch(() => {});
      await loadPropState();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Evaluation error'}`);
    } finally {
      setBusyAction(null);
    }
  };

  const rules = state?.rules || PROP_CHALLENGE_RULES;
  const active = state?.activeChallenge || null;
  const leaders = state?.leaderboard || [];
  const pnlProgressPct = active ? Math.max(0, Math.min(100, Math.round((active.pnlPct / rules.profitTargetPct) * 100))) : 0;

  return (
    <div className="flex-col gap-lg">
      {/* Hero Banner */}
      <div className="cex-hero-banner">
        <div>
          <div className="cex-hero-eyebrow">
            100% Non-Custodial · Virtual $10,000 Paper Equity · Verified Trader Attestation
          </div>
          <h1 style={{ fontSize: '21px', fontWeight: 900, margin: '0 0 4px 0', color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Trophy size={20} style={{ color: 'var(--color-accent-emerald)' }} /> {t('prop.title')}
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            {t('prop.subtitle')}
          </p>
        </div>
        <div className="flex-row gap-sm items-center">
          <span
            className="badge"
            style={{
              backgroundColor: 'var(--color-badge-success-bg)',
              color: 'var(--color-badge-success-text)',
              border: '1px solid var(--color-badge-success-border)',
              fontSize: '11px',
            }}
          >
            {state?.verifiedTradersCount ?? 0} {tr('Verified Traders', 'Verified Trader')}
          </span>
          <button
            type="button"
            onClick={loadPropState}
            disabled={loading}
            className="btn-secondary"
            style={{ padding: '7px 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={13} /> {loading ? tr('Loading...', 'Memuat...') : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Rule Matrix Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '12px' }}>
        {[
          { label: tr('Virtual Capital', 'Modal Virtual'), value: `$${rules.startingEquityUsd.toLocaleString()}` },
          { label: tr('Profit Target', 'Target Profit'), value: `+${rules.profitTargetPct}%`, accent: true },
          { label: tr('Max Daily Loss', 'Batas Rugi Harian'), value: `-${rules.maxDailyLossPct}%` },
          { label: tr('Max Drawdown', 'Batas Drawdown'), value: `-${rules.maxTotalDrawdownPct}%` },
          { label: tr('Min Trading Days', 'Min Hari Trading'), value: `${rules.minTradingDays} / ${rules.maxDurationDays}d` },
          { label: tr('Pass Reward', 'Reward Lulus'), value: `+${rules.passRewardCredits} cr`, accent: true },
        ].map((item) => (
          <div key={item.label} className="card" style={{ padding: '16px' }}>
            <div className="text-muted" style={{ fontSize: '11px', marginBottom: '6px' }}>{item.label}</div>
            <div style={{ fontSize: '20px', fontWeight: 900, fontFamily: 'var(--font-mono)', color: item.accent ? 'var(--color-accent-emerald)' : 'var(--color-foreground)' }}>
              {item.value}
            </div>
          </div>
        ))}
      </div>

      {feedback && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '10px',
            fontSize: '12px',
            fontWeight: 700,
            backgroundColor: feedback.startsWith('OK:') ? 'var(--color-badge-success-bg)' : 'var(--color-badge-warning-bg)',
            color: feedback.startsWith('OK:') ? 'var(--color-badge-success-text)' : 'var(--color-badge-warning-text)',
            border: `1px solid ${feedback.startsWith('OK:') ? 'var(--color-badge-success-border)' : 'var(--color-badge-warning-border)'}`,
          }}
        >
          {feedback}
        </div>
      )}

      {/* Active Challenge / Enrollment Card */}
      <div className="card" style={{ padding: '22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={18} style={{ color: 'var(--color-accent-emerald)' }} />
            {active ? tr('Your Proof-of-Skill Challenge', 'Tantangan Proof-of-Skill Anda') : tr('Enroll in POOLNET Trading Cup', 'Daftar POOLNET Trading Cup')}
          </h2>
          {active && (
            <span
              className="badge"
              style={{
                backgroundColor: active.status === 'PASSED' ? 'var(--color-badge-success-bg)' : 'var(--color-badge-info-bg)',
                color: active.status === 'PASSED' ? 'var(--color-badge-success-text)' : 'var(--color-badge-info-text)',
                border: `1px solid ${active.status === 'PASSED' ? 'var(--color-badge-success-border)' : 'var(--color-badge-info-border)'}`,
                fontWeight: 800,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {active.status}
            </span>
          )}
        </div>

        {!isConnected ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <p className="text-muted" style={{ margin: 0, fontSize: '13px' }}>
              {tr('Connect your non-custodial wallet (SIWE) to enroll with 100 Credits or 0.005 ETH on Base L2.', 'Hubungkan dompet non-kustodial (SIWE) untuk mendaftar dengan 100 Credits atau 0.005 ETH di Base L2.')}
            </p>
            <button
              type="button"
              disabled={isConnecting}
              onClick={() => connectMetaMask()}
              className="btn-primary"
              style={{ padding: '9px 16px', fontSize: '12px' }}
            >
              <Wallet size={14} /> {isConnecting ? tr('Connecting...', 'Menghubungkan...') : tr('Connect Wallet', 'Hubungkan Dompet')}
            </button>
          </div>
        ) : active && active.status === 'ACTIVE' ? (
          <div className="flex-col gap-md">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
              <div className="bg-panel" style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                <div className="text-muted" style={{ fontSize: '10px' }}>Current Equity</div>
                <div style={{ fontWeight: 900, fontSize: '15px' }}>${active.currentEquityUsd.toLocaleString()}</div>
              </div>
              <div className="bg-panel" style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                <div className="text-muted" style={{ fontSize: '10px' }}>PnL Progress</div>
                <div style={{ fontWeight: 900, fontSize: '15px', color: active.pnlPct >= 0 ? 'var(--color-text-positive)' : 'var(--color-destructive)' }}>
                  {active.pnlPct >= 0 ? `+${active.pnlPct}%` : `${active.pnlPct}%`} / +{rules.profitTargetPct}%
                </div>
              </div>
              <div className="bg-panel" style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                <div className="text-muted" style={{ fontSize: '10px' }}>Max Drawdown</div>
                <div style={{ fontWeight: 900, fontSize: '15px' }}>{active.maxDrawdownPct}% / {rules.maxTotalDrawdownPct}%</div>
              </div>
              <div className="bg-panel" style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                <div className="text-muted" style={{ fontSize: '10px' }}>Trading Days</div>
                <div style={{ fontWeight: 900, fontSize: '15px' }}>{active.tradingDaysCount} / {rules.minTradingDays}</div>
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', marginBottom: '4px' }}>
                <span>{tr('Target Progress (+8%)', 'Progres Target (+8%)')}</span>
                <span>{pnlProgressPct}%</span>
              </div>
              <div style={{ width: '100%', height: '8px', borderRadius: '999px', backgroundColor: 'var(--color-surface-inset)', overflow: 'hidden' }}>
                <div style={{ width: `${pnlProgressPct}%`, height: '100%', background: 'var(--color-accent-emerald)', transition: 'width 300ms ease' }} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleEvaluate}
                className="btn-primary"
                style={{ padding: '8px 16px', fontSize: '12px' }}
              >
                <CheckCircle2 size={14} /> {busyAction === 'EVALUATE' ? tr('Evaluating...', 'Mengevaluasi...') : tr('Evaluate Now', 'Evaluasi Sekarang')}
              </button>
              <Link href="/trading" className="btn-secondary" style={{ padding: '8px 14px', fontSize: '12px', textDecoration: 'none' }}>
                {tr('Open Paper Terminal →', 'Buka Terminal Paper →')}
              </Link>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p className="text-muted" style={{ margin: 0, fontSize: '12px', lineHeight: 1.55 }}>
              {tr(
                'Prove your trading discipline without risking user or platform custody. Reach +8% profit across at least 3 trading days while respecting the 5% daily loss and 10% max drawdown guardrails.',
                'Buktikan disiplin trading Anda tanpa risiko kustodi dana. Capai target profit +8% dalam minimal 3 hari trading dengan tetap menjaga batas rugi harian 5% dan max drawdown 10%.'
              )}
            </p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => handleStart('CREDITS')}
                className="btn-primary"
                style={{ padding: '9px 18px', fontSize: '12px' }}
              >
                {busyAction === 'START_CREDITS' ? tr('Starting...', 'Memulai...') : tr(`Start with ${rules.entryFeeCredits} Credits`, `Daftar dengan ${rules.entryFeeCredits} Credits`)}
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => handleStart('ETH')}
                className="btn-secondary"
                style={{ padding: '9px 18px', fontSize: '12px' }}
              >
                {busyAction === 'START_ETH' ? tr('Confirming ETH...', 'Mengonfirmasi ETH...') : tr(`Start with ${rules.entryFeeEth} ETH (Base L2)`, `Daftar dengan ${rules.entryFeeEth} ETH (Base L2)`)}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Verified Traders Public Leaderboard */}
      <div className="card" style={{ padding: '22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Award size={17} style={{ color: 'var(--color-accent-emerald)' }} />
            {tr('Verified Traders Leaderboard', 'Papan Peringkat Verified Trader')}
          </h2>
          <Link href="/agent" className="text-accent" style={{ fontSize: '12px', fontWeight: 700, textDecoration: 'underline' }}>
            {tr('Publish Signal Preset in Marketplace →', 'Publikasikan Preset Sinyal di Marketplace →')}
          </Link>
        </div>

        {leaders.length === 0 ? (
          <div className="text-muted" style={{ fontSize: '12px' }}>
            {tr('No Verified Traders yet for Season 1. Be the first to pass +8% and claim the #1 Verified Trader spot!', 'Belum ada Verified Trader di Season 1. Jadilah trader pertama yang lolos +8% dan raih peringkat #1!')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '8px' }}>#</th>
                  <th style={{ padding: '8px' }}>Trader Wallet</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Return</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Max DD</th>
                  <th style={{ padding: '8px', textAlign: 'right' }}>Days</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((row, idx) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '8px', fontWeight: 800 }}>#{idx + 1}</td>
                    <td style={{ padding: '8px' }}>{row.walletAddress.slice(0, 8)}...{row.walletAddress.slice(-4)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', color: 'var(--color-text-positive)', fontWeight: 800 }}>+{row.pnlPct}%</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{row.maxDrawdownPct}%</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{row.tradingDaysCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
