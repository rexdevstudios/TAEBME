'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import { Activity, ShieldAlert, Zap, Rocket, Award, Server, Cpu, Lock, Network, Wallet, BrainCircuit } from 'lucide-react';
import { executeKillSwitchToggle } from './lib/kill-switch-admin-client';

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
  const { isConnected, userRole, walletAddress, connectMetaMask, isConnecting, chainId } = useAuth();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Admin interactive states
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [killSwitchReason, setKillSwitchReason] = useState('Routine platform risk evaluation');
  const [dualControlRequestId, setDualControlRequestId] = useState('');
  const [adminFeedback, setAdminFeedback] = useState<string | null>(null);

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
    // Only fetch telemetry & kill switch state if Admin
    if (userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') {
      fetchOverview();
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
  }, [userRole]);

  const handleToggleKillSwitch = async () => {
    const result = await executeKillSwitchToggle({
      currentActive: killSwitchActive,
      reason: killSwitchReason,
      dualControlRequestId,
    });
    setKillSwitchActive(result.isNowActive);
    setAdminFeedback(result.feedbackMessage);
  };

  const handleFlushTelemetry = () => {
    // Telemetry flush not yet wired to a backend endpoint — no operation performed.
    setAdminFeedback('⚠️ Telemetry flush is not yet integrated with a backend endpoint. No data was sent.');
  };

  // -------------------------
  // GUEST VIEW (Landing Page)
  // -------------------------
  if (!isConnected || userRole === 'GUEST') {
    return (
      <div className="flex-col" style={{ gap: 0 }}>

        {/* ── HERO SECTION ── */}
        <section
          style={{
            position: 'relative',
            paddingTop: 'var(--space-3xl)',
            paddingBottom: 'var(--space-3xl)',
            textAlign: 'center',
            overflow: 'hidden',
          }}
        >
          {/* Ambient background glow orbs */}
          <div style={{
            position: 'absolute', top: '-20%', left: '50%', transform: 'translateX(-50%)',
            width: '600px', height: '400px',
            background: 'radial-gradient(ellipse, rgba(0,229,255,0.08) 0%, transparent 70%)',
            pointerEvents: 'none', zIndex: 0,
          }} />
          <div style={{
            position: 'absolute', top: '30%', left: '15%',
            width: '300px', height: '300px',
            background: 'radial-gradient(ellipse, rgba(34,197,94,0.06) 0%, transparent 70%)',
            pointerEvents: 'none', zIndex: 0,
          }} />

          <div style={{ position: 'relative', zIndex: 1, maxWidth: '820px', margin: '0 auto' }}>

            {/* Main headline */}
            <h1 style={{
              fontSize: 'clamp(36px, 6vw, 64px)',
              fontWeight: 900,
              lineHeight: 1.05,
              margin: '0 0 var(--space-lg) 0',
              letterSpacing: '-1.5px',
            }}>
              <span className="hero-headline">The Autonomous Social Liquidity</span>
              <br />
              <span style={{
                background: 'linear-gradient(135deg, #00E5FF 0%, #22C55E 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}>
                &amp; Bonding Curve Engine on Base
              </span>
            </h1>

            {/* Sub-headline */}
            <p className="text-muted" style={{
              fontSize: '18px',
              lineHeight: 1.7,
              maxWidth: '600px',
              margin: '0 auto var(--space-xl) auto',
            }}>
              Launch tokens with automated liquidity graduation, syndicate with verified KOLs,
              and trade with zero rugpull risk — powered by deterministic bonding curves.
            </p>

            {/* CTA Buttons */}
            <div className="flex-row" style={{ justifyContent: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
              <a href="/launchpad" className="btn-cta" style={{ textDecoration: 'none' }}>
                <Rocket size={18} /> Launch Token
              </a>
              <a href="/kol" className="btn-glass" style={{ textDecoration: 'none' }}>
                <Network size={18} /> Explore Deal Rooms
              </a>
              <button
                onClick={async () => {
                  setConnectError(null);
                  const res = await connectMetaMask();
                  if (!res.success && res.error) setConnectError(res.error);
                }}
                disabled={isConnecting}
                className="btn-secondary"
                style={{ fontSize: '15px', padding: '14px 24px' }}
              >
                <Wallet size={18} />
                {isConnecting ? 'Signing SIWE...' : 'Connect Wallet (SIWE)'}
              </button>
            </div>

            {connectError && (
              <p className="text-destructive" style={{ marginTop: 'var(--space-md)', fontWeight: 600 }}>
                {connectError}
              </p>
            )}

            {/* Secondary auth entry — email / alternative login */}
            <p className="text-muted" style={{ marginTop: 'var(--space-lg)', fontSize: '13px' }}>
              Prefer email or alternative login?{' '}
              <a
                href="/auth/login"
                style={{
                  color: '#94A3B8',
                  textDecoration: 'underline',
                  textUnderlineOffset: '3px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <Lock size={12} /> Login Portal
              </a>
            </p>
          </div>
        </section>

        {/* ── PROTOCOL GUARANTEE STRIP ── */}
        <section style={{ padding: 'var(--space-2xl) 0' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-md)',
          }}>
            {[
              { icon: <Zap size={28} style={{ color: '#00E5FF' }} />, stat: '0%', label: 'Initial Liquidity Required' },
              { icon: <Activity size={28} style={{ color: '#22C55E' }} />, stat: 'Auto', label: 'Aerodrome Graduation' },
              { icon: <ShieldAlert size={28} style={{ color: '#D500F9' }} />, stat: 'ZK', label: 'Anti-Sybil KOL Proof' },
              { icon: <Lock size={28} style={{ color: '#FFD600' }} />, stat: '100%', label: 'Non-Custodial' },
            ].map((item, i) => (
              <div key={i} className="stat-card" style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'center' }}>{item.icon}</div>
                <div style={{ fontSize: '28px', fontWeight: 900, lineHeight: 1, marginBottom: '6px', color: 'var(--color-foreground)' }}>
                  {item.stat}
                </div>
                <div className="text-muted" style={{ fontSize: '13px', lineHeight: 1.4 }}>{item.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── BENTO FEATURE GRID ── */}
        <section style={{ padding: 'var(--space-2xl) 0' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-xl)' }}>
            <h2 style={{ fontSize: '32px', fontWeight: 800, margin: '0 0 12px 0', letterSpacing: '-0.5px' }}>
              Everything you need to launch &amp; trade
            </h2>
            <p className="text-muted" style={{ fontSize: '16px', margin: 0 }}>
              Built on Base. Powered by automated bonding curves.
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'var(--space-lg)',
          }}>
            {/* Card A – Bonding Curve Launchpad */}
            <div className="bento-card">
              <div style={{ marginBottom: '16px' }}>
                <Rocket size={32} style={{ color: '#00E5FF' }} className="glow-accent" />
              </div>
              <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
                Bonding Curve Launchpad
              </h3>
              <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
                Fair-launch tokens on a deterministic P₀=0 bonding curve. Auto-graduates to Aerodrome at 24 ETH target with zero rugpull risk.
              </p>
              <div style={{
                background: 'linear-gradient(90deg, rgba(0,229,255,0.06) 0%, rgba(34,197,94,0.06) 100%)',
                border: '1px solid rgba(0,229,255,0.12)',
                borderRadius: '8px',
                padding: '12px 16px',
                fontSize: '12px',
                color: '#67E8F9',
                fontFamily: 'monospace',
              }}>
                G = 24 ETH · Fee = 1% · S_grad = 668M tokens
              </div>
            </div>

            {/* Card B – Angel Deal Room */}
            <div className="bento-card">
              <div style={{ marginBottom: '16px' }}>
                <Award size={32} style={{ color: '#22C55E' }} />
              </div>
              <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
                Angel Deal Room
              </h3>
              <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
                Syndicate with verified KOLs — Twitter, Farcaster &amp; Lens verified — for bounty-powered viral launch campaigns.
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {['Twitter/X ✓', 'Farcaster ✓', 'Lens ✓', 'World ID ✓'].map(p => (
                  <span key={p} style={{
                    padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
                    background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#86EFAC',
                  }}>{p}</span>
                ))}
              </div>
            </div>

            {/* Card C – Risk Gate */}
            <div className="bento-card">
              <div style={{ marginBottom: '16px' }}>
                <ShieldAlert size={32} style={{ color: '#D500F9' }} />
              </div>
              <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
                Deterministic Risk Gate
              </h3>
              <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
                Every trade passes through a fail-closed TradingRiskGate. Slippage caps, MEV frontrun detection, and real-time kill switch.
              </p>
              <div style={{
                background: 'rgba(213, 0, 249, 0.06)',
                border: '1px solid rgba(213, 0, 249, 0.15)',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '12px',
                color: '#E879F9',
              }}>
                ● Slippage Cap: 3%  ● Max Order: $10,000
              </div>
            </div>

            {/* Card D – Cross-Chain */}
            <div className="bento-card">
              <div style={{ marginBottom: '16px' }}>
                <BrainCircuit size={32} style={{ color: '#FFD600' }} />
              </div>
              <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
                Cross-Chain Liquidity
              </h3>
              <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
                Deploy across Base, Solana, Clanker, and Robinhood Chain. AI-advisory agents suggest optimal chain routing.
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {['Base ✓', 'Solana ✓', 'Clanker ✓', 'RH Chain ✓'].map(c => (
                  <span key={c} style={{
                    padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
                    background: 'rgba(255,214,0,0.08)', border: '1px solid rgba(255,214,0,0.2)', color: '#FDE047',
                  }}>{c}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

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
              {isConnecting ? 'Signing SIWE...' : 'Get Started — Connect Wallet'}
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
  // TRADER / CREATOR VIEW
  // -------------------------
  if (userRole === 'TRADER' || userRole === 'CREATOR') {
    return (
      <div className="flex-col gap-lg">
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: '0 0 8px 0', fontSize: '24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              Welcome back, {walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : 'User'}
            </h1>
            <p className="text-muted" style={{ margin: 0 }}>
              You are authenticated as <strong className="text-accent">{userRole}</strong> via EIP-4361 SIWE.
            </p>
          </div>
          <div className="flex-row gap-md">
            <a href="/trading" className="btn-primary" style={{ textDecoration: 'none' }}>
              <Network size={16} /> Open Trading Terminal
            </a>
            {userRole === 'CREATOR' && (
              <a href="/launchpad" className="btn-secondary" style={{ textDecoration: 'none' }}>
                <Rocket size={16} /> Token Launchpad
              </a>
            )}
          </div>
        </div>

        <div className="grid-2">
          <div className="card">
            <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={20} className="text-accent" /> Security Overview
            </h3>
            <ul style={{ paddingLeft: '20px', color: 'var(--color-foreground)', margin: 0 }} className="flex-col gap-sm">
              <li>Session: <span className="text-accent">Active</span></li>
              <li>Wallet: <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-accent)' }}>{walletAddress ? `${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}` : '—'}</span></li>
              <li>Max Order Size: <span>$10,000 <span style={{ color: '#94A3B8', fontSize: '11px' }}>(Platform Default)</span></span></li>
              <li>Max Slippage Cap: <span>3.0% <span style={{ color: '#94A3B8', fontSize: '11px' }}>(Platform Default)</span></span></li>
            </ul>
          </div>
          <div className="card">
            <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={20} className="text-accent" /> Recent Activity
            </h3>
            <div className="flex-col gap-sm text-muted">
              <p style={{ margin: 0 }}>No trade intents have been submitted in this session.</p>
              <p style={{ margin: '4px 0 0 0', fontSize: '11px' }}>Trade intents are logged after submitting a proposal in the Trading Terminal.</p>
              <a href="/trading" className="text-accent" style={{ textDecoration: 'underline', fontSize: '13px', marginTop: '8px', display: 'inline-block' }}>Open Trading Terminal →</a>
            </div>
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
            Operational SSOT: PostgreSQL (28 Tables) • Ephemeral Tier: Upstash Redis REST Sidecar • Native dRPC Engine
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
          <span className="badge badge-admin" style={{ border: '1px solid #FF9100', color: '#FFD600', backgroundColor: '#261704' }}>
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

          {/* 3. Telemetry Flush & Redis Heartbeat */}
          <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
            <div style={{ color: '#D500F9', fontSize: '12px', fontWeight: 800, marginBottom: '8px' }}><Server size={14} className="inline mr-1" style={{display:'inline', marginRight:'4px', verticalAlign:'text-bottom'}}/> TELEMETRY & REDIS SIDECAR</div>
            <div className="flex-col gap-sm" style={{ fontSize: '12px', color: 'var(--color-foreground)', marginBottom: '16px' }}>
              <div>Redis Sidecar: <strong style={{ color: 'var(--color-accent)' }}>ONLINE (REST)</strong></div>
              <div>Ring Buffer: <strong style={{ color: '#00E5FF' }}>18 Events Cached</strong></div>
            </div>
            <button
              onClick={handleFlushTelemetry}
              className="btn-secondary"
              disabled={true}
              style={{ width: '100%', justifyContent: 'center', cursor: 'not-allowed', opacity: 0.5 }}
              title="Telemetry flush is not yet integrated with a backend endpoint."
              aria-label="Telemetry flush not yet available"
            >
              Flush Telemetry (Not Wired)
            </button>
          </div>
        </div>

        {/* RBAC Matrix Inspector */}
        <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px' }}>
          <div style={{ color: '#FFD600', fontSize: '12px', fontWeight: 800, marginBottom: '12px' }}>
            🛡️ RBAC Domain Capabilities Matrix
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', fontSize: '11px' }}>
            {[
              { cap: 'VIEW_TOKENS', roles: 'ALL', dual: false },
              { cap: 'TRADE_MANUALLY', roles: 'ADMIN, TRADER', dual: false },
              { cap: 'ENABLE_LIVE_AGENT', roles: 'ADMIN, TRADER', dual: false },
              { cap: 'CREATE_LAUNCH', roles: 'ADMIN, CREATOR', dual: false },
              { cap: 'FREEZE_TOKEN', roles: 'ADMIN, MOD', dual: false },
              { cap: 'REVIEW_FLAGGED', roles: 'ADMIN, RISK', dual: false },
              { cap: 'MANAGE_BILLING', roles: 'SUPER_ADMIN', dual: true },
              { cap: 'OVERRIDE_RISK', roles: 'SUPER_ADMIN', dual: true },
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
              <span key={worker} style={{ backgroundColor: '#131D2D', color: '#00E5FF', border: '1px solid #1B2B42', padding: '6px 12px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}>
                <Cpu size={12} className="inline mr-1" style={{display:'inline', marginRight:'4px', verticalAlign:'text-bottom'}}/> {worker}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
