'use client';

import React, { useRef, useEffect, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import { Rocket, Network, Wallet, Lock, Zap, Activity, ShieldAlert, Award, ArrowUpRight } from 'lucide-react';

gsap.registerPlugin(ScrollTrigger, useGSAP);

interface LandingHeroMotionProps {
  isConnecting: boolean;
  connectError: string | null;
  onConnectMetaMask: () => Promise<void>;
}

/**
 * GSAP-powered Gemini-style Landing Experience:
 * 1. Hero Entrance + Live Animated SVG Bonding Curve
 * 2. Live Token Fleet Marquee (auto-pauses on hover/focus)
 * 3. ScrollTrigger Bento Grid Wave Stagger
 * 4. Cursor Spotlight Hover Cards
 * 5. Subtle Ambient Mesh Parallax (respects prefers-reduced-motion)
 */
export function LandingHeroMotion({
  isConnecting,
  connectError,
  onConnectMetaMask,
}: LandingHeroMotionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [liveTokens, setLiveTokens] = useState<Array<{ ticker: string; name: string; chain: string; contractAddress: string }>>([]);

  useEffect(() => {
    fetch('/api/launchpad/tokens')
      .then((r) => r.json())
      .then((json) => {
        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
          setLiveTokens(json.data.slice(0, 8));
        }
      })
      .catch(() => {});
  }, []);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // 1. Hero Stagger Entrance
        gsap.from('.hero-anim', {
          opacity: 0,
          y: 22,
          duration: 0.65,
          stagger: 0.09,
          ease: 'expo.out',
          clearProps: 'transform,opacity',
        });

        // 2. Ambient Orb Parallax
        gsap.to('.parallax-orb-1', {
          yPercent: -18,
          ease: 'none',
          scrollTrigger: {
            trigger: containerRef.current,
            start: 'top top',
            end: 'bottom top',
            scrub: 0.6,
          },
        });
        gsap.to('.parallax-orb-2', {
          yPercent: 14,
          ease: 'none',
          scrollTrigger: {
            trigger: containerRef.current,
            start: 'top top',
            end: 'bottom top',
            scrub: 0.8,
          },
        });

        // 3. Stats Strip Wave Stagger
        gsap.from('.stat-anim', {
          opacity: 0,
          scale: 0.94,
          y: 18,
          duration: 0.45,
          stagger: { each: 0.07, from: 'center', grid: 'auto' },
          ease: 'power3.out',
          clearProps: 'transform,opacity',
          scrollTrigger: {
            trigger: '.stats-section',
            start: 'top 88%',
            once: true,
          },
        });

        // 4. Bento Feature Cards Scroll Reveal
        gsap.from('.bento-anim', {
          opacity: 0,
          y: 24,
          duration: 0.5,
          stagger: 0.1,
          ease: 'power2.out',
          clearProps: 'transform,opacity',
          scrollTrigger: {
            trigger: '.bento-section',
            start: 'top 86%',
            once: true,
          },
        });
      });

      return () => mm.revert();
    },
    { scope: containerRef }
  );

  const handleCardMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--spot-x', `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty('--spot-y', `${e.clientY - rect.top}px`);
  };

  const tickerItems =
    liveTokens.length > 0
      ? liveTokens.map((t) => ({
          label: `$${t.ticker || 'TOKEN'}`,
          sub: `${t.name || 'Launch'} · ${(t.chain || 'base').toUpperCase()}`,
          href: `/token/${(t.chain || 'base').replace('-mainnet', '').replace('-sepolia', '')}/${t.contractAddress}`,
        }))
      : [
          { label: '$NOIR', sub: 'NoirPay · BASE', href: '/launchpad' },
          { label: '$PUMPRUN', sub: 'Pump Hill Runner · BASE', href: '/launchpad' },
          { label: '0% TAX', sub: 'Fair Bonding Curve', href: '/launchpad' },
          { label: '5-AGENT AI', sub: 'Autonomous Strategy Desk', href: '/agent' },
        ];

  return (
    <div ref={containerRef} className="flex-col" style={{ gap: 0 }}>
      {/* ── HERO SECTION ── */}
      <section
        style={{
          position: 'relative',
          paddingTop: 'var(--space-2xl)',
          paddingBottom: 'var(--space-2xl)',
          textAlign: 'center',
          overflow: 'hidden',
        }}
      >
        {/* Ambient Parallax Orbs */}
        <div
          className="parallax-orb-1"
          style={{
            position: 'absolute',
            top: '-18%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '680px',
            height: '420px',
            background: 'radial-gradient(ellipse, rgba(66, 133, 244, 0.14) 0%, rgba(155, 114, 203, 0.08) 45%, transparent 72%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
        <div
          className="parallax-orb-2"
          style={{
            position: 'absolute',
            top: '28%',
            left: '12%',
            width: '320px',
            height: '320px',
            background: 'radial-gradient(ellipse, rgba(52, 211, 153, 0.1) 0%, transparent 70%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: '880px', margin: '0 auto' }}>
          {/* Pill Eyebrow */}
          <div className="hero-anim" style={{ marginBottom: '16px' }}>
            <span
              className="badge"
              style={{
                backgroundColor: 'rgba(138, 180, 248, 0.12)',
                border: '1px solid rgba(138, 180, 248, 0.3)',
                color: 'var(--color-accent)',
                padding: '6px 14px',
                fontSize: '12px',
              }}
            >
              ✦ AI-Powered Social Liquidity &amp; Launchpad on Base
            </span>
          </div>

          {/* Main headline */}
          <h1
            className="hero-anim"
            style={{
              fontSize: 'clamp(36px, 5.8vw, 62px)',
              fontWeight: 800,
              lineHeight: 1.06,
              margin: '0 0 var(--space-md) 0',
              letterSpacing: '-1.5px',
            }}
          >
            <span className="hero-headline">The Autonomous Social Liquidity</span>
            <br />
            <span
              style={{
                background: 'linear-gradient(135deg, #4285F4 0%, #9B72CB 55%, #34D399 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              &amp; Bonding Curve Engine on Base
            </span>
          </h1>

          {/* Sub-headline */}
          <p
            className="hero-anim text-muted"
            style={{
              fontSize: '17px',
              lineHeight: 1.65,
              maxWidth: '620px',
              margin: '0 auto var(--space-lg) auto',
            }}
          >
            Luncurkan token dengan kurva likuiditas otomatis, kolaborasi bersama KOL terverifikasi,
            dan trading dengan perlindungan risiko real-time — 100% non-custodial.
          </p>

          {/* CTA Buttons (Preserved 100%) */}
          <div className="hero-anim flex-row" style={{ justifyContent: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <a href="/launchpad" className="btn-primary" style={{ textDecoration: 'none', padding: '13px 26px', fontSize: '15px' }}>
              <Rocket size={18} /> Launch Token
            </a>
            <a href="/kol" className="btn-secondary" style={{ textDecoration: 'none', padding: '13px 24px', fontSize: '15px' }}>
              <Network size={18} /> Explore Deal Rooms
            </a>
            <button
              onClick={onConnectMetaMask}
              disabled={isConnecting}
              className="btn-secondary"
              style={{ fontSize: '15px', padding: '13px 24px' }}
            >
              <Wallet size={18} />
              {isConnecting ? 'Menghubungkan...' : 'Connect Wallet'}
            </button>
          </div>

          {connectError && (
            <p className="text-destructive" style={{ marginTop: 'var(--space-md)', fontWeight: 600, fontSize: '13px' }}>
              {connectError}
            </p>
          )}

          {/* Secondary auth entry */}
          <p className="hero-anim text-muted" style={{ marginTop: 'var(--space-md)', fontSize: '13px' }}>
            Ingin verifikasi dompet secara manual?{' '}
            <a
              href="/auth/login"
              style={{
                color: 'var(--color-accent)',
                textDecoration: 'underline',
                textUnderlineOffset: '3px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <Lock size={12} /> Portal Login
            </a>
          </p>

          {/* Interactive Animated SVG Bonding Curve Visual (60fps Lightweight Motion) */}
          <div
            className="hero-anim glass-panel"
            style={{
              marginTop: 'var(--space-xl)',
              padding: '18px 22px',
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-foreground)' }}>
                Deterministic Bonding Curve → Auto DEX Graduation
              </span>
              <span className="badge-live">LIVE ENGINE</span>
            </div>
            <svg viewBox="0 0 720 120" width="100%" height="110" style={{ display: 'block', overflow: 'visible' }} aria-label="Animated Bonding Curve Progression">
              <defs>
                <linearGradient id="curveStroke" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#4285F4" />
                  <stop offset="55%" stopColor="#9B72CB" />
                  <stop offset="100%" stopColor="#34D399" />
                </linearGradient>
                <linearGradient id="curveArea" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#4285F4" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#4285F4" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line x1="12" y1="98" x2="708" y2="98" stroke="var(--color-border)" strokeDasharray="3 3" />
              <path
                d="M 12 96 C 180 94, 340 82, 480 48 C 560 28, 635 16, 708 12 L 708 98 L 12 98 Z"
                fill="url(#curveArea)"
              />
              <path
                id="heroCurvePath"
                d="M 12 96 C 180 94, 340 82, 480 48 C 560 28, 635 16, 708 12"
                fill="none"
                stroke="url(#curveStroke)"
                strokeWidth="3"
                strokeLinecap="round"
              />
              {/* Animated Moving Light Dot along Bonding Curve */}
              <circle r="5" fill="#FFFFFF" stroke="#4285F4" strokeWidth="2.5">
                <animateMotion dur="5.5s" repeatCount="indefinite" path="M 12 96 C 180 94, 340 82, 480 48 C 560 28, 635 16, 708 12" />
              </circle>
              <circle cx="12" cy="96" r="4" fill="#4285F4" />
              <text x="12" y="114" fill="var(--color-muted)" fontSize="10" fontFamily="monospace">Fair Launch (0% Tax)</text>
              <circle cx="480" cy="48" r="4" fill="#9B72CB" />
              <text x="435" y="114" fill="var(--color-muted)" fontSize="10" fontFamily="monospace">24 ETH Target</text>
              <circle cx="708" cy="12" r="4.5" fill="#34D399" />
              <text x="595" y="114" fill="#34D399" fontSize="10" fontWeight="700" fontFamily="monospace">Auto DEX LP Lock</text>
            </svg>
          </div>
        </div>
      </section>

      {/* ── LIVE TOKEN FLEET TICKER MARQUEE (Auto-Pauses on Hover/Focus) ── */}
      <div
        className="poolnet-marquee-wrapper"
        style={{
          overflow: 'hidden',
          borderTop: '1px solid var(--color-border)',
          borderBottom: '1px solid var(--color-border)',
          padding: '12px 0',
          margin: '8px 0 var(--space-xl) 0',
          backgroundColor: 'var(--color-primary)',
          borderRadius: '14px',
        }}
        aria-label="Live active token launches"
      >
        <div className="poolnet-marquee-track" style={{ gap: '16px', paddingLeft: '16px' }}>
          {[...tickerItems, ...tickerItems].map((item, idx) => (
            <a
              key={`${item.label}-${idx}`}
              href={item.href}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 14px',
                borderRadius: '9999px',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-background)',
                fontSize: '12px',
                whiteSpace: 'nowrap',
                textDecoration: 'none',
              }}
            >
              <span style={{ fontWeight: 800, color: 'var(--color-accent)' }}>{item.label}</span>
              <span className="text-muted">{item.sub}</span>
              <ArrowUpRight size={12} style={{ color: 'var(--color-muted)' }} />
            </a>
          ))}
        </div>
      </div>

      {/* ── PROTOCOL GUARANTEE STRIP (GSAP Wave Stagger) ── */}
      <section className="stats-section" style={{ padding: 'var(--space-lg) 0 var(--space-2xl) 0' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-md)',
          }}
        >
          {[
            { icon: <Zap size={26} style={{ color: '#4285F4' }} />, stat: '0%', label: 'Modal Likuiditas Awal' },
            { icon: <Activity size={26} style={{ color: '#34D399' }} />, stat: 'Auto', label: 'Migrasi Likuiditas DEX' },
            { icon: <ShieldAlert size={26} style={{ color: '#9B72CB' }} />, stat: 'Anti-Sybil', label: 'Verifikasi KOL & Bounty' },
            { icon: <Lock size={26} style={{ color: '#F59E0B' }} />, stat: '100%', label: 'Non-Custodial Wallet' },
          ].map((item, i) => (
            <div
              key={i}
              className="stat-card stat-anim spotlight-card"
              onMouseMove={handleCardMouseMove}
              style={{ textAlign: 'center' }}
            >
              <div style={{ marginBottom: '10px', display: 'flex', justifyContent: 'center' }}>{item.icon}</div>
              <div style={{ fontSize: '26px', fontWeight: 800, lineHeight: 1.1, marginBottom: '6px', color: 'var(--color-foreground)' }}>
                {item.stat}
              </div>
              <div className="text-muted" style={{ fontSize: '13px', lineHeight: 1.4 }}>{item.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── BENTO FEATURE GRID (GSAP Scroll Reveal + Cursor Spotlight) ── */}
      <section className="bento-section" style={{ padding: 'var(--space-lg) 0 var(--space-2xl) 0' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-xl)' }}>
          <h2 style={{ fontSize: '30px', fontWeight: 800, margin: '0 0 10px 0', letterSpacing: '-0.5px' }}>
            Semua yang Anda butuhkan untuk meluncurkan &amp; trading token
          </h2>
          <p className="text-muted" style={{ fontSize: '15px', margin: 0 }}>
            Terintegrasi penuh dengan 5 Agen AI, Bonding Curve Launchpad, dan KOL Bounty Hub.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'var(--space-lg)',
          }}
        >
          <div className="bento-card bento-anim spotlight-card" onMouseMove={handleCardMouseMove}>
            <div style={{ marginBottom: '14px' }}>
              <Rocket size={30} style={{ color: '#4285F4' }} />
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
              Bonding Curve Launchpad
            </h3>
            <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              Luncurkan token dalam hitungan menit dengan 0% pajak beli/jual dan migrasi otomatis ke DEX setelah target tercapai.
            </p>
            <div
              style={{
                background: 'rgba(66, 133, 244, 0.08)',
                border: '1px solid rgba(66, 133, 244, 0.2)',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '12px',
                color: 'var(--color-accent)',
                fontWeight: 600,
              }}
            >
              Target 24 ETH · Fee 1% (0.5% Kreator) · 0% Tax
            </div>
          </div>

          <div className="bento-card bento-anim spotlight-card" onMouseMove={handleCardMouseMove}>
            <div style={{ marginBottom: '14px' }}>
              <Award size={30} style={{ color: '#34D399' }} />
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
              KOL Hub &amp; Angel Deal Room
            </h3>
            <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              Bangun kampanye viral bersama KOL terverifikasi X, Farcaster, dan Lens dengan pembagian reward transparan.
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {['Twitter/X ✓', 'Farcaster ✓', 'Lens ✓', '0.25% Referral ✓'].map((p) => (
                <span
                  key={p}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '9999px',
                    fontSize: '11px',
                    fontWeight: 600,
                    background: 'rgba(52, 211, 153, 0.1)',
                    border: '1px solid rgba(52, 211, 153, 0.25)',
                    color: '#34D399',
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>

          <div className="bento-card bento-anim spotlight-card" onMouseMove={handleCardMouseMove}>
            <div style={{ marginBottom: '14px' }}>
              <ShieldAlert size={30} style={{ color: '#9B72CB' }} />
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
              AI Desk &amp; Perlindungan Risiko
            </h3>
            <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              Analisis token Launchpad maupun GeckoTerminal/DexScreener dengan 5 Agen AI, lengkap dengan batas slippage &amp; Risk Guard.
            </p>
            <div
              style={{
                background: 'rgba(155, 114, 203, 0.1)',
                border: '1px solid rgba(155, 114, 203, 0.25)',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '12px',
                color: '#C084FC',
                fontWeight: 600,
              }}
            >
              4 Profil Strategi · Slippage Cap · Persetujuan Manual
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
