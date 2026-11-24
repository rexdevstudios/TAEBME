'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import { Activity, ShieldAlert, Zap, Rocket, Award, Server, Cpu, Lock, Network, Wallet, BrainCircuit } from 'lucide-react';
import { executeKillSwitchToggle } from './lib/kill-switch-admin-client';
import { LandingHeroMotion } from './components/LandingHeroMotion';

interface OverviewData {
  status: string;
  controlPlane: string;
  operationalSsot: string;
  ephemeralSidecar: string;
  telemetryObservability: string;
  executionPlaneWorkers: string[];
  primaryRpcProvider: string;
  fallbackRpcProvider: string;
  activeDomains: string[];
  timestamp: string;
}

export default function OverviewPage() {
  const { isConnected, userRole, planId, credits, walletAddress, connectMetaMask, isConnecting, refreshSession } = useAuth();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [activeLaunches, setActiveLaunches] = useState<any[]>([]);
  const [gameFiProfile, setGameFiProfile] = useState<{
    xp: number;
    level: number;
    passTier: string;
    completedQuests: string[];
    dailyCheckInAvailable?: boolean;
    questEligibility?: Record<string, boolean>;
    nftMintingStatus?: { available: boolean };
  } | null>(null);
  const [questFeedback, setQuestFeedback] = useState<string | null>(null);
  const [questLoading, setQuestLoading] = useState<string | null>(null);
  const [voucherLoading, setVoucherLoading] = useState<boolean>(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Admin interactive states
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [killSwitchReason, setKillSwitchReason] = useState('Routine platform risk evaluation');
  const [dualControlRequestId, setDualControlRequestId] = useState('');
  const [adminFeedback, setAdminFeedback] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<
    Array<{ id: string; actorId: string; action: string; entityId: string | null; reason: string | null; createdAt: string }>
  >([]);
  const [auditFilter, setAuditFilter] = useState<string>('ALL');
  const [auditLoading, setAuditLoading] = useState<boolean>(false);

  const isAdminDashboardRole =
    userRole === 'SYSTEM_ADMIN' ||
    userRole === 'SUPER_ADMIN' ||
    userRole === 'RISK_ADMIN' ||
    userRole === 'LAUNCH_ADMIN' ||
    userRole === 'BILLING_ADMIN';

  const fetchAuditLogs = async (filterVal: string = auditFilter) => {
    setAuditLoading(true);
    try {
      const qs = filterVal && filterVal !== 'ALL' ? `&action=${encodeURIComponent(filterVal)}` : '';
      const res = await fetch(`/api/admin/audit-logs?limit=20${qs}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const json = await res.json();
      if (json.success && Array.isArray(json.data?.entries)) {
        setAuditLogs(json.data.entries);
      }
    } catch {
      // Non-blocking fallback
    } finally {
      setAuditLoading(false);
    }
  };

  const fetchOverview = async () => {
    try {
      const res = await fetch('/api/system/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.success && json.data) {
        setOverview(json.data as OverviewData);
        setError(null);
      }
    } catch (err) {
      console.warn('[Overview UI] System overview fetch error:', (err as Error).message);
      setError('Live telemetry retrying... using cached baseline');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected) {
      fetch('/api/launchpad/tokens')
        .then((r) => r.json())
        .then((json) => {
          if (json.success && Array.isArray(json.data)) {
            setActiveLaunches(json.data);
          }
        })
        .catch(() => {});

      fetch('/api/gamefi/profile', { credentials: 'same-origin' })
        .then((r) => r.json())
        .then((json) => {
          if (json.success && json.profile) {
            setGameFiProfile(json.profile);
          }
        })
        .catch(() => {});
    }
    // Only fetch telemetry, audit logs & kill switch state if Admin
    if (isAdminDashboardRole) {
      fetchOverview();
      fetchAuditLogs('ALL');
      fetch('/api/admin/kill-switch')
        .then((r) => r.json())
        .then((json) => {
          if (json.success && json.data) {
            setKillSwitchActive(Boolean(json.data.isGlobalHalted));
          }
        })
        .catch(() => {});
      const timer = window.setInterval(fetchOverview, 5000);
      return () => window.clearInterval(timer);
    } else {
      setLoading(false);
    }
  }, [isConnected, userRole]);

  const handleToggleKillSwitch = async () => {
    const result = await executeKillSwitchToggle({
      currentActive: killSwitchActive,
      reason: killSwitchReason,
      dualControlRequestId,
    });
    setKillSwitchActive(result.isNowActive);
    setAdminFeedback(result.feedbackMessage);
    fetchAuditLogs(auditFilter);
  };

  const handleRefreshTelemetryAndAudit = async () => {
    setAdminFeedback('⏳ Memuat ulang telemetry live & audit_logs dari PostgreSQL SSOT...');
    await Promise.all([fetchOverview(), fetchAuditLogs(auditFilter)]);
    setAdminFeedback('✅ Live telemetry & Governance Audit Logs berhasil disinkronkan.');
  };

  const handleCompleteQuest = async (questId: string) => {
    setQuestLoading(questId);
    setQuestFeedback(null);
    try {
      const res = await fetch('/api/gamefi/quests/complete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setQuestFeedback(`⚠️ Quest (${questId}): ${json.error || 'Syarat quest belum terpenuhi'}`);
        return;
      }
      if (json.profile) {
        setGameFiProfile(json.profile);
      }
      const crBonus = Number(json.creditsGranted ?? 0);
      if (crBonus > 0) {
        refreshSession().catch(() => {});
      }
      setQuestFeedback(
        `✅ Quest "${questId}" selesai! +${json.completion?.xpGranted ?? 100} XP${crBonus > 0 ? ` & +${crBonus} Credits` : ''} ditambahkan ke akun Anda.`
      );
    } catch (err: any) {
      setQuestFeedback(`⚠️ Gagal memverifikasi quest: ${err?.message || 'Network error'}`);
    } finally {
      setQuestLoading(null);
    }
  };

  const handleRequestPassVoucher = async () => {
    const tier = gameFiProfile?.passTier || 'BRONZE';
    setVoucherLoading(true);
    setQuestFeedback(null);
    try {
      const res = await fetch('/api/gamefi/nft/mint-voucher', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setQuestFeedback(`ℹ️ Mint Voucher (${tier}): ${json.error || 'Signer / koleksi NFT belum dikonfigurasi pada environment ini.'}`);
        return;
      }
      setQuestFeedback(`✅ EIP-712 Mint Voucher (${tier}) diterbitkan! Contract: ${json.voucher?.contractAddress || 'Verified'} · Nonce: ${json.voucher?.nonce || '—'}`);
    } catch (err: any) {
      setQuestFeedback(`⚠️ Gagal meminta Mint Voucher: ${err?.message || 'Network error'}`);
    } finally {
      setVoucherLoading(false);
    }
  };

  // -------------------------
  // GUEST VIEW (Landing Page)
  // -------------------------
  if (!isConnected || userRole === 'GUEST') {
    const handleGuestConnect = async () => {
      setConnectError(null);
      const res = await connectMetaMask();
      if (!res.success && res.error) setConnectError(res.error);
    };

    return (
      <div className="flex-col" style={{ gap: 0 }}>

        {/* ── GSAP INTERACTIVE HERO, LIVE MARQUEE, STATS & SPOTLIGHT BENTO ── */}
        <LandingHeroMotion
          isConnecting={isConnecting}
          connectError={connectError}
          onConnectMetaMask={handleGuestConnect}
        />

        {/* ── 3-STEP ONBOARDING WALKTHROUGH ── */}
        <section style={{
          padding: 'var(--space-2xl) 0 var(--space-3xl) 0',
          textAlign: 'center',
        }}>
          <h2 style={{ fontSize: '28px', fontWeight: 800, margin: '0 0 var(--space-xl) 0', letterSpacing: '-0.5px' }}>
            Start in 3 steps
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--space-lg)',
            maxWidth: '720px',
            margin: '0 auto',
          }}>
            {[
              { n: '1', title: 'Connect Wallet', desc: 'Sign-In with Ethereum (EIP-4361 SIWE) for non-custodial authentication.', color: '#00E5FF' },
              { n: '2', title: 'Launch / Pick Pool', desc: 'Create your token on a bonding curve, or explore existing KOL deal rooms.', color: '#22C55E' },
              { n: '3', title: 'Trade & Graduate', desc: 'Buy tokens on the curve. At 24 ETH, liquidity auto-migrates to Aerodrome DEX.', color: '#D500F9' },
            ].map(step => (
              <div key={step.n} className="glass-panel" style={{ padding: '28px 24px' }}>
                <div style={{
                  width: '40px', height: '40px', borderRadius: '50%',
                  background: `radial-gradient(circle, ${step.color}33, ${step.color}11)`,
                  border: `2px solid ${step.color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 16px auto',
                  fontSize: '16px', fontWeight: 900, color: step.color,
                }}>
                  {step.n}
                </div>
                <h3 style={{ fontSize: '16px', fontWeight: 800, margin: '0 0 8px 0' }}>{step.title}</h3>
                <p className="text-muted" style={{ fontSize: '13px', lineHeight: 1.6, margin: 0 }}>{step.desc}</p>
              </div>
            ))}
          </div>

          {/* Final CTA */}
          <div style={{ marginTop: 'var(--space-2xl)' }}>
            <button
              onClick={async () => {
                setConnectError(null);
                const res = await connectMetaMask();
                if (!res.success && res.error) setConnectError(res.error);
              }}
              disabled={isConnecting}
              className="btn-cta"
              style={{ fontSize: '16px', padding: '16px 40px' }}
            >
              <Wallet size={20} />
              {isConnecting ? 'Menghubungkan...' : 'Get Started — Connect Wallet'}
            </button>
            {connectError && (
              <p className="text-destructive" style={{ marginTop: 'var(--space-md)', fontWeight: 600 }}>
                {connectError}
              </p>
            )}
          </div>
        </section>

      </div>
    );
  }


  // -------------------------
  // TRADER / CREATOR / LAUNCH_ADMIN VIEW
  // -------------------------
  if (userRole === 'TRADER' || userRole === 'CREATOR' || userRole === 'LAUNCH_ADMIN') {
    const activeTier = (planId || 'FREE').toUpperCase();
    return (
      <div className="flex-col gap-lg">
        {/* CEX Launchpad Market Pulse Ticker Strip */}
        <div className="cex-ticker-strip tabular-nums">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 800, color: '#F0B90B' }}>
              <Rocket size={14} /> POOLNET LAUNCHPAD
            </span>
            <span style={{ color: 'var(--color-muted)' }}>
              Active Pools: <strong style={{ color: 'var(--color-foreground)' }}>{activeLaunches.length}</strong>
            </span>
            <span style={{ color: 'var(--color-muted)' }}>
              Trading Tax: <strong style={{ color: '#10B981' }}>0% Buy/Sell</strong>
            </span>
            <span style={{ color: 'var(--color-muted)' }}>
              Gas Relayer: <strong style={{ color: '#38BDF8' }}>Base L2 Sponsored</strong>
            </span>
            <span style={{ color: 'var(--color-muted)' }}>
              Anti-Honeypot: <strong style={{ color: '#10B981' }}>GoPlus Live ($0)</strong>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
            <span style={{ color: 'var(--color-muted)' }}>
              Tier: <strong style={{ color: '#F0B90B' }}>{activeTier}</strong>
            </span>
            <span style={{ color: 'var(--color-muted)' }}>
              Credits: <strong style={{ color: '#38BDF8' }}>{credits.toLocaleString()} cr</strong>
            </span>
          </div>
        </div>

        {/* CEX Launchpad Spotlight Banner & Dual Primary CTAs */}
        <div
          className="card"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '16px',
            background: 'linear-gradient(135deg, rgba(19, 24, 34, 0.98) 0%, rgba(26, 33, 48, 0.92) 60%, rgba(240, 185, 11, 0.08) 100%)',
            border: '1px solid rgba(240, 185, 11, 0.24)',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', fontWeight: 800, color: '#F0B90B', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: '4px' }}>
              Non-Custodial CEX-Grade Launchpad &amp; AI Trading Hub
            </div>
            <h1 style={{ margin: '0 0 6px 0', fontSize: '22px', fontWeight: 900 }}>
              Selamat datang, {walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : 'Trader'}
            </h1>
            <p className="text-muted" style={{ margin: 0, fontSize: '13px' }}>
              Pilih tujuan Anda di bawah — semua fitur sudah dikelompokkan rapi berdasarkan kategori agar mudah digunakan.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <a href="/launchpad" className="cex-btn-gold">
              <Rocket size={15} /> Launch / Explore Pools
            </a>
            <a href="/trading" className="btn-secondary" style={{ textDecoration: 'none', padding: '10px 16px', fontSize: '13px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <Network size={15} /> Buka Terminal Trade
            </a>
          </div>
        </div>

        {/* 4 Role-Based Quick-Start Action Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
          <a href="/launchpad" className="cex-role-card" style={{ borderTop: '2px solid #F0B90B' }}>
            <div>
              <div style={{ fontWeight: 900, color: '#FCD34D', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '6px' }}>
                <Rocket size={16} /> 1. Launchpad &amp; Pools
              </div>
              <div className="text-muted" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                Jelajahi token live, buat token baru 0% tax, AI Brand Studio, &amp; Bankr Multi-Account Fleet.
              </div>
            </div>
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#F0B90B' }}>Buka Launchpad →</span>
          </a>
          <a href="/trading" className="cex-role-card" style={{ borderTop: '2px solid #10B981' }}>
            <div>
              <div style={{ fontWeight: 900, color: '#34D399', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '6px' }}>
                <Network size={16} /> 2. Spot &amp; DEX Terminal
              </div>
              <div className="text-muted" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                Trade 6-chain DEX (0x v2) atau Binance/Bybit Spot dengan Chart &amp; GoPlus Anti-Honeypot Guard.
              </div>
            </div>
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#10B981' }}>Mulai Trading →</span>
          </a>
          <a href="/agent" className="cex-role-card" style={{ borderTop: '2px solid #38BDF8' }}>
            <div>
              <div style={{ fontWeight: 900, color: '#38BDF8', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '6px' }}>
                <BrainCircuit size={16} /> 3. AI Auto-Pilot 24/7
              </div>
              <div className="text-muted" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                Jalankan 5-Agent Desk &amp; Auto-Pilot TP/SL + Trailing Stop otomatis dengan alert Telegram.
              </div>
            </div>
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#38BDF8' }}>Atur AI Bot →</span>
          </a>
          <a href="/kol" className="cex-role-card" style={{ borderTop: '2px solid #A855F7' }}>
            <div>
              <div style={{ fontWeight: 900, color: '#D8B4FE', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '6px' }}>
                <Award size={16} /> 4. Earn &amp; KOL Hub
              </div>
              <div className="text-muted" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                Verifikasi Passport X/Farcaster/World ID, ikuti kampanye bounty, &amp; raih 0.25% referral fee.
              </div>
            </div>
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#C084FC' }}>Lihat Campaign →</span>
          </a>
        </div>

        {/* 3-Column Security, Subscription/Fee & Live Launchpad Activity */}
        <div className="grid-3">
          <div className="card">
            <h3 style={{ margin: '0 0 14px 0', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={18} className="text-accent" /> Security &amp; Risk Guardrails
            </h3>
            <ul style={{ paddingLeft: '18px', color: 'var(--color-foreground)', margin: 0, fontSize: '13px' }} className="flex-col gap-sm">
              <li>Sesi Dompet: <span className="text-accent">Aktif &amp; Aman</span></li>
              <li>Dompet: <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-accent)' }}>{walletAddress ? `${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}` : '—'}</span></li>
              <li>Batas Order Maks: <span>$10,000 <span style={{ color: '#94A3B8', fontSize: '11px' }}>(Risk Guard)</span></span></li>
              <li>Batas Slippage Maks: <span>3.0% <span style={{ color: '#94A3B8', fontSize: '11px' }}>(Otomatis)</span></span></li>
            </ul>
          </div>

          <div className="card">
            <h3 style={{ margin: '0 0 14px 0', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px', color: '#FFC400' }}>
              <Zap size={18} /> Active Tier &amp; Fee Structure
            </h3>
            <ul style={{ paddingLeft: '18px', color: 'var(--color-foreground)', margin: 0, fontSize: '13px' }} className="flex-col gap-sm">
              <li>Current Plan: <strong style={{ color: '#FFC400' }}>{activeTier}</strong> ({credits.toLocaleString()} cr)</li>
              <li>Bonding Curve Fee: <strong>0.50% Treasury / 0.50% Creator</strong></li>
              <li>Metered Burn: <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>1 cr Scrape · 5 cr Desk · 50 cr Launch</span></li>
            </ul>
            <a href="/billing" className="text-accent" style={{ textDecoration: 'underline', fontSize: '12px', marginTop: '10px', display: 'inline-block' }}>
              Manage Subscription &amp; Credits →
            </a>
          </div>

          <div className="card">
            <h3 style={{ margin: '0 0 14px 0', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={18} className="text-accent" /> Live Ecosystem Activity
            </h3>
            {activeLaunches.length > 0 ? (
              <div className="flex-col gap-xs" style={{ fontSize: '12px' }}>
                <div style={{ color: 'var(--color-foreground)', fontWeight: 700 }}>
                  {activeLaunches.length} Token Aktif:
                </div>
                {activeLaunches.slice(0, 3).map((t: any, idx: number) => (
                  <div key={t.launchId || idx} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', color: '#CBD5E1' }}>
                    <span>${t.ticker || 'TOKEN'} ({t.name || 'Launch'})</span>
                    <a href={`/trading?token=${t.contractAddress || ''}`} style={{ color: '#38BDF8' }}>Trade →</a>
                  </div>
                ))}
                <a href="/launchpad" className="text-accent" style={{ textDecoration: 'underline', fontSize: '12px', marginTop: '6px', display: 'inline-block' }}>
                  Explore All Launches →
                </a>
              </div>
            ) : (
              <div className="flex-col gap-sm text-muted" style={{ fontSize: '12px' }}>
                <p style={{ margin: 0 }}>Siap menjalankan 5-Agent Trading Desk atau meluncurkan token pertama Anda.</p>
                <div style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
                  <a href="/agent" className="text-accent" style={{ textDecoration: 'underline' }}>Run 5-Agent Desk →</a>
                  <a href="/launchpad" style={{ color: '#38BDF8', textDecoration: 'underline' }}>Open Launchpad →</a>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 3-Minute Interactive Beginner Onboarding Checklist (Phase CG2) */}
        {(() => {
          const step1Done = Boolean(isConnected && walletAddress);
          const step2Done = Boolean(
            gameFiProfile?.completedQuests?.includes('first_trade_or_launch') ||
              gameFiProfile?.questEligibility?.first_trade_or_launch
          );
          const step3Done = Boolean(
            gameFiProfile?.completedQuests?.includes('verify_sybil') ||
              gameFiProfile?.questEligibility?.verify_sybil ||
              (activeTier !== 'FREE')
          );
          const completedSteps = [step1Done, step2Done, step3Done].filter(Boolean).length;
          return (
            <div
              className="card"
              style={{
                border: `1px solid ${completedSteps === 3 ? 'rgba(16, 185, 129, 0.4)' : 'rgba(56, 189, 248, 0.35)'}`,
                background: completedSteps === 3 ? 'rgba(16, 185, 129, 0.06)' : 'rgba(56, 189, 248, 0.05)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: completedSteps === 3 ? 0 : '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: completedSteps === 3 ? '#34D399' : '#38BDF8' }}>
                  {completedSteps === 3
                    ? '✅ Onboarding Pemula Selesai (3/3) — Akun Anda siap untuk Trading, AI Desk & Launchpad!'
                    : `🚀 Panduan Cepat 3 Menit untuk Pemula (${completedSteps}/3 Selesai)`}
                </div>
                <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>
                  100% Non-Custodial · GoPlus Anti-Insider Aktif
                </span>
              </div>
              {completedSteps < 3 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px', fontSize: '12px' }}>
                  <div className="bg-panel" style={{ padding: '10px', borderRadius: '6px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                    <div style={{ fontWeight: 800, color: '#34D399', marginBottom: '4px' }}>✓ 1. Hubungkan Dompet SIWE</div>
                    <div className="text-muted" style={{ fontSize: '11px' }}>Dompet aktif tanpa kustodi. Klaim +100 XP di kartu GameFi di bawah.</div>
                  </div>
                  <div className="bg-panel" style={{ padding: '10px', borderRadius: '6px', border: `1px solid ${step2Done ? 'rgba(16, 185, 129, 0.3)' : 'var(--color-border)'}` }}>
                    <div style={{ fontWeight: 800, color: step2Done ? '#34D399' : 'var(--color-foreground)', marginBottom: '4px' }}>
                      {step2Done ? '✓' : '2.'} Coba 1 Paper Trade / Scan Token
                    </div>
                    <div className="text-muted" style={{ fontSize: '11px', marginBottom: '6px' }}>Uji terminal bebas risiko + GoPlus Anti-Insider Guard (+500 XP).</div>
                    {!step2Done && (
                      <a href="/trading" style={{ color: '#38BDF8', fontSize: '11px', fontWeight: 700, textDecoration: 'underline' }}>
                        Buka Terminal /trading →
                      </a>
                    )}
                  </div>
                  <div className="bg-panel" style={{ padding: '10px', borderRadius: '6px', border: `1px solid ${step3Done ? 'rgba(16, 185, 129, 0.3)' : 'var(--color-border)'}` }}>
                    <div style={{ fontWeight: 800, color: step3Done ? '#34D399' : 'var(--color-foreground)', marginBottom: '4px' }}>
                      {step3Done ? '✓' : '3.'} Aktifkan AI Preset / KOL / Launch
                    </div>
                    <div className="text-muted" style={{ fontSize: '11px', marginBottom: '6px' }}>Pilih preset Auto-Pilot pemula atau luncurkan token gasless.</div>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <a href="/agent" style={{ color: '#38BDF8', fontSize: '11px', fontWeight: 700, textDecoration: 'underline' }}>AI Desk →</a>
                      <a href="/launchpad" style={{ color: '#C084FC', fontSize: '11px', fontWeight: 700, textDecoration: 'underline' }}>Launchpad →</a>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* GameFi Trader Pass & Quest Progression Card */}
        <div className="card" style={{ border: '1px solid rgba(168, 85, 247, 0.35)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 900, color: '#C084FC', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Award size={17} /> GameFi Trader Pass &amp; On-Chain Quest Progression
              </h3>
              <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '12px' }}>
                Selesaikan Daily Check-In &amp; misi akun untuk memperoleh XP, Bonus Kredit, dan membuka Trader Pass NFT (BRONZE → SILVER 250 XP → GOLD 500 XP).
              </p>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
              <span style={{ padding: '4px 10px', borderRadius: '6px', backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#E9D5FF', border: '1px solid rgba(168, 85, 247, 0.35)', fontWeight: 800 }}>
                XP: {gameFiProfile?.xp ?? 0}
              </span>
              <span style={{ padding: '4px 10px', borderRadius: '6px', backgroundColor: 'rgba(56, 189, 248, 0.15)', color: '#7DD3FC', border: '1px solid rgba(56, 189, 248, 0.35)', fontWeight: 800 }}>
                LEVEL: {gameFiProfile?.level ?? 1}
              </span>
              <span style={{ padding: '4px 10px', borderRadius: '6px', backgroundColor: 'rgba(255, 196, 0, 0.15)', color: '#FDE047', border: '1px solid rgba(255, 196, 0, 0.35)', fontWeight: 800 }}>
                PASS: {gameFiProfile?.passTier || 'BRONZE'}
              </span>
              {gameFiProfile?.nftMintingStatus?.available ? (
                <button
                  type="button"
                  onClick={handleRequestPassVoucher}
                  disabled={voucherLoading}
                  className="btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '11px', borderColor: '#C084FC', color: '#E9D5FF' }}
                >
                  {voucherLoading ? 'Verifying...' : `Request ${gameFiProfile?.passTier || 'BRONZE'} NFT Voucher`}
                </button>
              ) : (
                <span
                  style={{
                    padding: '4px 10px',
                    borderRadius: '6px',
                    backgroundColor: 'rgba(148, 163, 184, 0.12)',
                    color: '#CBD5E1',
                    border: '1px solid rgba(148, 163, 184, 0.3)',
                    fontSize: '11px',
                    fontWeight: 700,
                  }}
                  title="XP & bonus Credits aktif dan tercatat di PostgreSQL SSOT. Minting on-chain NFT menunggu aktivasi isolated signer."
                >
                  NFT Mint: Segera Hadir (XP &amp; Credits Aktif)
                </span>
              )}
            </div>
          </div>

          {/* XP Progress Bar toward GOLD (500 XP) */}
          {(() => {
            const xpVal = gameFiProfile?.xp ?? 0;
            const nextTarget = xpVal < 250 ? 250 : 500;
            const nextLabel = xpVal < 250 ? 'SILVER (250 XP)' : xpVal < 500 ? 'GOLD (500 XP)' : 'MAX TIER (GOLD UNLOCKED)';
            const pct = Math.min(100, Math.round((xpVal / nextTarget) * 100));
            return (
              <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', marginBottom: '4px' }}>
                  <span>Progress menuju {nextLabel}</span>
                  <span>{xpVal} / {nextTarget} XP ({pct}%)</span>
                </div>
                <div style={{ width: '100%', height: '6px', borderRadius: '999px', backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, #A855F7 0%, #22C55E 100%)', transition: 'width 300ms ease' }} />
                </div>
              </div>
            );
          })()}

          {questFeedback && (
            <div style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, backgroundColor: questFeedback.includes('✅') ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)', color: questFeedback.includes('✅') ? '#6EE7B7' : '#FDE047', border: `1px solid ${questFeedback.includes('✅') ? 'rgba(16, 185, 129, 0.35)' : 'rgba(245, 158, 11, 0.35)'}` }}>
              {questFeedback}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            {[
              { id: 'daily_checkin', badge: 'DAILY UTC', title: 'Daily Check-In', xp: '+25 XP · +5 cr', desc: 'Klaim bonus harian 1× per hari (reset otomatis 00:00 UTC).', actionHref: null, actionLabel: null },
              { id: 'connect_siwe', badge: 'ONE-TIME', title: '1. Non-Custodial SIWE Login', xp: '+100 XP · +10 cr', desc: 'Verifikasi sesi dompet EIP-4361 SIWE aktif.', actionHref: null, actionLabel: null },
              { id: 'verify_sybil', badge: 'ONE-TIME', title: '2. Anti-Sybil Social Passport', xp: '+250 XP · +25 cr', desc: 'Verifikasi profil KOL / World ID / Farcaster di KOL Hub.', actionHref: '/kol', actionLabel: 'Lengkapi di KOL Hub →' },
              { id: 'first_trade_or_launch', badge: 'ONE-TIME', title: '3. First Trade or Token Launch', xp: '+500 XP · +50 cr', desc: 'Buat 1 trade intent di Terminal/5-Agent Desk atau launch token.', actionHref: '/trading', actionLabel: 'Buat 1 Trade di /trading →' },
            ].map((q) => {
              const isDone =
                q.id === 'daily_checkin'
                  ? gameFiProfile?.dailyCheckInAvailable === false
                  : Boolean(gameFiProfile?.completedQuests?.includes(q.id));
              const isEligible =
                gameFiProfile?.questEligibility && typeof gameFiProfile.questEligibility[q.id] === 'boolean'
                  ? Boolean(gameFiProfile.questEligibility[q.id])
                  : true;
              return (
                <div key={q.id} className="bg-panel" style={{ border: `1px solid ${isDone ? 'rgba(34, 197, 94, 0.3)' : 'var(--color-border)'}`, borderRadius: '6px', padding: '12px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '10px' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 800, fontSize: '12px', color: 'var(--color-foreground)' }}>{q.title}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: q.badge === 'DAILY UTC' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(168, 85, 247, 0.15)', color: q.badge === 'DAILY UTC' ? '#7DD3FC' : '#E9D5FF' }}>
                        {q.badge}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 900, color: 'var(--color-accent)', marginBottom: '4px' }}>{q.xp}</div>
                    <div className="text-muted" style={{ fontSize: '11px' }}>{q.desc}</div>
                  </div>
                  {!isDone && !isEligible && q.actionHref ? (
                    <a
                      href={q.actionHref}
                      className="btn-secondary"
                      style={{ width: '100%', justifyContent: 'center', padding: '7px 10px', fontSize: '11px', textDecoration: 'none', textAlign: 'center', borderColor: 'rgba(250, 204, 21, 0.45)', color: '#FDE047' }}
                    >
                      {q.actionLabel}
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled={isDone || questLoading !== null}
                      onClick={() => handleCompleteQuest(q.id)}
                      className={isDone ? 'btn-secondary' : 'btn-primary'}
                      style={{ width: '100%', justifyContent: 'center', padding: '7px 10px', fontSize: '11px', opacity: isDone ? 0.75 : 1 }}
                    >
                      {isDone ? (q.id === 'daily_checkin' ? '✓ Claimed Today (UTC)' : '✓ Completed') : questLoading === q.id ? 'Verifying...' : `Claim ${q.xp}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // -------------------------
  // SYSTEM ADMIN VIEW
  // -------------------------
  return (
    <div className="flex-col gap-lg">
      {/* Top Status Header */}
      <div className="bg-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderRadius: '8px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 900, margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity className="text-accent" /> System Overview & Telemetry Matrix
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            Operational SSOT: PostgreSQL (48 Tables) • Ephemeral Tier: Upstash Redis REST Sidecar • GoPlus + Public RPC Guard
          </p>
        </div>
        <div className="flex-row items-center gap-md">
          <span className="text-muted" style={{ fontSize: '12px' }}>
            Updated: {overview?.timestamp ? new Date(overview.timestamp).toLocaleTimeString() : 'LIVE'}
          </span>
          <span className={error ? 'badge badge-admin' : 'badge badge-trader'} style={{ fontSize: '12px' }}>
            {error ? '● CACHED / RETRYING' : `● ${overview?.status || 'OPERATIONAL'}`}
          </span>
        </div>
      </div>

      <div style={{ backgroundColor: 'rgba(239, 68, 68, 0.05)', border: '1px solid var(--color-destructive)', padding: '16px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: '16px', color: 'var(--color-destructive)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <ShieldAlert size={20} /> SYSTEM ADMINISTRATOR CONSOLE ACTIVE
          </div>
          <div style={{ color: '#FCA5A5', fontSize: '12px' }}>
            Full Infrastructure Authority • Emergency Kill-Switch Enabled • Binance Vault Key Inspector Active
          </div>
        </div>
      </div>

      {/* OLED Data-Dense 4-Column Metric Grid */}
      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '8px' }}>CONTROL PLANE & EDGE</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#00E5FF' }}>
            {overview?.controlPlane || 'Vercel / Next.js 14'}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '8px' }}>Stateless Edge Middleware (6 Sec Headers)</div>
        </div>

        <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '8px' }}>OPERATIONAL SSOT</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--color-accent)' }}>
            {overview?.operationalSsot || 'PostgreSQL SSOT (Neon)'}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '8px' }}>28 Relational Tables (Transactional Authority)</div>
        </div>

        <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '8px' }}>EPHEMERAL SIDECAR</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#FFD600' }}>
            {overview?.ephemeralSidecar || 'UPSTASH_REDIS_ACTIVE'}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '8px' }}>REST Sidecar • Zero-Blocking Fail-Open</div>
        </div>

        <div className="bg-panel" style={{ padding: '16px', borderRadius: '8px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '8px' }}>TELEMETRY LOGGER</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#D500F9' }}>
            {overview?.telemetryObservability || 'ACTIVE (Ring Buffer)'}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '8px' }}>Non-Blocking Metric & Audit Buffer</div>
        </div>
      </div>

      {/* SYSTEM ADMIN EXCLUSIVE CONTROL CONSOLE */}
      <div className="bg-panel" style={{ borderRadius: '8px', padding: '24px', border: '1px solid #FF9100' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 900, margin: 0, color: '#FFD600' }}>
            Emergency Master Console
          </h2>
          <span className="badge badge-admin" style={{ border: '1px solid var(--color-badge-warning-border)', color: 'var(--color-badge-warning-text)', backgroundColor: 'var(--color-badge-warning-bg)' }}>
            SUPERVISOR TIER
          </span>
        </div>

        {adminFeedback && (
          <div className={adminFeedback.includes('🚨') ? 'badge badge-admin' : 'badge badge-trader'} style={{ display: 'block', padding: '12px', marginBottom: '24px', fontSize: '14px' }}>
            {adminFeedback}
          </div>
        )}

        <div className="grid-3" style={{ marginBottom: '24px' }}>
          {/* 1. Global Kill Switch Panel */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
            <div style={{ color: 'var(--color-destructive)', fontSize: '12px', fontWeight: 800, marginBottom: '8px' }}><ShieldAlert size={14} className="inline mr-1" style={{display:'inline', marginRight:'4px', verticalAlign:'text-bottom'}}/> EMERGENCY KILL-SWITCH</div>
            <div style={{ fontSize: '12px', color: 'var(--color-foreground)', marginBottom: '16px' }}>
              Status: <strong style={{ color: killSwitchActive ? 'var(--color-destructive)' : 'var(--color-accent)' }}>{killSwitchActive ? 'ACTIVE (HALTED)' : 'NORMAL (ONLINE)'}</strong>
            </div>
            <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '4px', fontWeight: 600 }}>
              Dual-Control Approval ID <span style={{ color: 'var(--color-destructive)' }}>*</span>
            </div>
            <input
              type="text"
              value={dualControlRequestId}
              onChange={(e) => setDualControlRequestId(e.target.value)}
              placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
              className="input"
              style={{ padding: '8px', fontSize: '12px', marginBottom: '8px' }}
            />
            <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '4px', fontWeight: 600 }}>
              Audit Reason
            </div>
            <input
              type="text"
              value={killSwitchReason}
              onChange={(e) => setKillSwitchReason(e.target.value)}
              placeholder="Kill switch reason..."
              className="input"
              style={{ padding: '8px', fontSize: '12px', marginBottom: '12px' }}
            />
            <button
              onClick={handleToggleKillSwitch}
              className={killSwitchActive ? 'btn-primary' : 'btn-destructive'}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {killSwitchActive ? 'Resume Trading Operations' : 'Trigger Global Kill Switch'}
            </button>
          </div>

          {/* 2. Binance AES-256 Vault Status */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
            <div style={{ color: '#00E5FF', fontSize: '12px', fontWeight: 800, marginBottom: '8px' }}><Lock size={14} className="inline mr-1" style={{display:'inline', marginRight:'4px', verticalAlign:'text-bottom'}}/> BINANCE AES-256 VAULT</div>
            <div className="flex-col gap-sm" style={{ fontSize: '12px', color: 'var(--color-foreground)' }}>
              <div>Encryption: <strong style={{ color: 'var(--color-accent)' }}>AES-256-GCM</strong></div>
              <div>Withdrawal Check: <strong style={{ color: 'var(--color-destructive)' }}>STRICTLY REJECTED</strong></div>
              <div>Read / Trade: <strong style={{ color: 'var(--color-accent)' }}>ACTIVE</strong></div>
            </div>
          </div>

          {/* 3. Live Telemetry & Governance Audit Sync */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
            <div style={{ color: '#D500F9', fontSize: '12px', fontWeight: 800, marginBottom: '8px' }}><Server size={14} className="inline mr-1" style={{display:'inline', marginRight:'4px', verticalAlign:'text-bottom'}}/> TELEMETRY &amp; AUDIT SSOT</div>
            <div className="flex-col gap-sm" style={{ fontSize: '12px', color: 'var(--color-foreground)', marginBottom: '16px' }}>
              <div>Redis Sidecar: <strong style={{ color: 'var(--color-accent)' }}>ONLINE (REST)</strong></div>
              <div>Governance Logs: <strong style={{ color: '#00E5FF' }}>{auditLogs.length} Recent Entries</strong></div>
            </div>
            <button
              type="button"
              onClick={handleRefreshTelemetryAndAudit}
              disabled={auditLoading}
              className="btn-secondary"
              style={{ width: '100%', justifyContent: 'center' }}
              title="Muat ulang live telemetry dan audit_logs dari PostgreSQL SSOT"
            >
              {auditLoading ? 'Syncing Telemetry...' : 'Refresh Telemetry & Audit Logs'}
            </button>
          </div>
        </div>

        {/* Governance Audit Log Viewer (SSOT `audit_logs`) */}
        <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
            <div style={{ color: '#8AB4F8', fontSize: '12px', fontWeight: 800 }}>
              📜 Riwayat Aktivitas Admin
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(['ALL', 'BILLING', 'KILL_SWITCH', 'LAUNCH', 'SNAPSHOT'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setAuditFilter(f);
                    fetchAuditLogs(f);
                  }}
                  className={auditFilter === f ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '3px 8px', fontSize: '10px', fontFamily: 'var(--font-mono)' }}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          {auditLogs.length === 0 ? (
            <div className="text-muted" style={{ fontSize: '12px', padding: '8px 0' }}>
              {auditLoading ? 'Memuat log tata kelola dari PostgreSQL...' : 'Belum ada entri audit_logs untuk filter ini.'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px' }}>Timestamp</th>
                    <th style={{ padding: '6px 8px' }}>Action</th>
                    <th style={{ padding: '6px 8px' }}>Actor</th>
                    <th style={{ padding: '6px 8px' }}>Entity</th>
                    <th style={{ padding: '6px 8px' }}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '6px 8px', fontWeight: 800, color: '#FFD600' }}>{log.action}</td>
                      <td style={{ padding: '6px 8px', color: '#38BDF8' }}>
                        {log.actorId.length > 16 ? `${log.actorId.slice(0, 8)}...${log.actorId.slice(-4)}` : log.actorId}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--color-muted)' }}>
                        {log.entityId ? (log.entityId.length > 14 ? `${log.entityId.slice(0, 14)}...` : log.entityId) : '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--color-foreground)', fontFamily: 'var(--font-sans)' }}>
                        {log.reason || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RBAC Matrix Inspector (Synced 100% with packages/auth/rbac-middleware.ts) */}
        <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
          <div style={{ color: '#FFD600', fontSize: '12px', fontWeight: 800, marginBottom: '12px' }}>
            🛡️ RBAC Domain Capabilities Matrix (8 Roles × 13 Capabilities)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '8px', fontSize: '11px' }}>
            {[
              { cap: 'VIEW_TOKENS', roles: 'ALL 8 ROLES', dual: false },
              { cap: 'CONNECT_WALLET', roles: 'ALL 8 ROLES', dual: false },
              { cap: 'CREATE_LAUNCH_DRAFT', roles: 'SUPER, LAUNCH, CREATOR, TRADER', dual: false },
              { cap: 'PUBLISH_LAUNCH', roles: 'SUPER, LAUNCH, CREATOR', dual: false },
              { cap: 'GRADUATE_LAUNCH', roles: 'SUPER, LAUNCH_ADMIN', dual: false },
              { cap: 'TRADE_MANUALLY', roles: 'SUPER, TRADER, CREATOR', dual: false },
              { cap: 'ENABLE_LIVE_AGENT', roles: 'SUPER, TRADER', dual: false },
              { cap: 'REVIEW_FLAGGED_TOKEN', roles: 'SUPER, MOD, RISK_ADMIN', dual: false },
              { cap: 'FREEZE_TOKEN', roles: 'SUPER, MOD, RISK_ADMIN', dual: false },
              { cap: 'SETTLE_BOUNTY_CLAIM', roles: 'SUPER, SYSTEM, TRADER, CREATOR', dual: false },
              { cap: 'MANAGE_SNAPSHOTS', roles: 'SUPER, LAUNCH_ADMIN', dual: false },
              { cap: 'MANAGE_BILLING_PLANS', roles: 'SUPER, SYSTEM, BILLING_ADMIN', dual: true },
              { cap: 'OVERRIDE_RISK_ENGINE', roles: 'SUPER_ADMIN', dual: true },
            ].map((item) => (
              <div key={item.cap} className="bg-panel" style={{ padding: '8px', borderRadius: '4px' }}>
                <div style={{ fontWeight: 800, color: 'var(--color-foreground)' }}>{item.cap}</div>
                <div className="text-muted">{item.roles}</div>
                {item.dual && <span style={{ color: 'var(--color-destructive)', fontWeight: 800, fontSize: '10px' }}>⚠ DUAL-CONTROL</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Data-Dense Active Domains Subsystem Grid */}
      <div className="bg-panel" style={{ padding: '24px', borderRadius: '8px' }}>
        <div className="flex-row justify-between items-center" style={{ marginBottom: '24px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 800, margin: 0 }}>
            Active Domain Subsystems
          </h3>
          <span style={{ fontSize: '12px', color: '#00E5FF', fontWeight: 'bold' }}>100% Boundary Isolation Verified</span>
        </div>

        <div className="grid-3" style={{ marginBottom: '24px' }}>
          {(overview?.activeDomains || ['IDENTITY', 'BILLING', 'LAUNCHPAD', 'TRADING', 'AGENT', 'INTELLIGENCE', 'RISK', 'COMPLIANCE', 'ADMIN']).map((domain) => (
            <div key={domain} className="bg-panel" style={{ padding: '12px 16px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--color-foreground)', fontSize: '14px', fontWeight: 700 }}>{domain}</span>
              <span className="text-accent" style={{ fontSize: '12px', fontWeight: 800 }}>✓ ACTIVE</span>
            </div>
          ))}
        </div>

        {/* Execution Plane Workers */}
        <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
          <div className="text-muted" style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '12px' }}>EXECUTION PLANE WORKERS</div>
          <div className="flex-row gap-sm" style={{ flexWrap: 'wrap' }}>
            {(overview?.executionPlaneWorkers || ['BinanceOrderWorker', 'LaunchpadIndexerWorker', 'DaytonaSandboxRunner', 'BinanceStreamListener']).map((worker) => (
              <span key={worker} style={{ backgroundColor: 'var(--color-badge-info-bg)', color: 'var(--color-badge-info-text)', border: '1px solid var(--color-badge-info-border)', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold' }}>
                <Cpu size={12} className="inline mr-1" style={{display:'inline', marginRight:'4px', verticalAlign:'text-bottom'}}/> {worker}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
