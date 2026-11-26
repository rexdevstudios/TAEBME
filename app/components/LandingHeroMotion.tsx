'use client';

import React, { useRef, useEffect, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import { Rocket, Network, Wallet, Lock, Zap, Activity, ShieldAlert, Award, ArrowUpRight } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

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
  const { tr } = useLocale();
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
              {tr(
                'AI-Powered Social Liquidity & Launchpad on Base',
                'Likuiditas Sosial & Launchpad Berbasis AI di Base',
                'Base 链上 AI 社交流动性与发行平台'
              )}
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
            <span className="hero-headline">
              {tr(
                'The Autonomous Social Liquidity',
                'Mesin Likuiditas Sosial Otonom',
                '自主社交流动性引擎'
              )}
            </span>
            <br />
            <span
              style={{
                background: 'linear-gradient(135deg, #4285F4 0%, #9B72CB 55%, var(--color-text-positive) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              {tr(
                '& Bonding Curve Engine on Base',
                '& Kurva Bonding di Base',
                '与 Base 联合曲线发行协议'
              )}
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
            {tr(
              'Launch tokens with automated bonding curves, collaborate with verified KOLs, and trade with real-time risk protection — 100% non-custodial.',
              'Luncurkan token dengan kurva likuiditas otomatis, kolaborasi bersama KOL terverifikasi, dan trading dengan perlindungan risiko real-time — 100% non-custodial.',
              '使用自动化联合曲线发行代币，与已验证 KOL 协作，并在实时风控保护下交易 — 100% 非托管。'
            )}
          </p>

          {/* CTA Buttons (Preserved 100%) */}
          <div className="hero-anim flex-row" style={{ justifyContent: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <a href="/launchpad" className="btn-primary" style={{ textDecoration: 'none', padding: '13px 26px', fontSize: '15px' }}>
              <Rocket size={18} /> {tr('Launch Token', 'Luncurkan Token', '发行代币')}
            </a>
            <a href="/kol" className="btn-secondary" style={{ textDecoration: 'none', padding: '13px 24px', fontSize: '15px' }}>
              <Network size={18} /> {tr('Explore Deal Rooms', 'Jelajahi Deal Room', '探索 KOL 合作')}
            </a>
            <button
              onClick={onConnectMetaMask}
              disabled={isConnecting}
              className="btn-secondary"
              style={{ fontSize: '15px', padding: '13px 24px' }}
            >
              <Wallet size={18} />
              {isConnecting
                ? tr('Connecting...', 'Menghubungkan...', '连接中...')
                : tr('Connect Wallet', 'Hubungkan Dompet', '连接钱包')}
            </button>
          </div>

          {connectError && (
            <p className="text-destructive" style={{ marginTop: 'var(--space-md)', fontWeight: 600, fontSize: '13px' }}>
              {connectError}
            </p>
          )}

          {/* Secondary auth entry */}
          <p className="hero-anim text-muted" style={{ marginTop: 'var(--space-md)', fontSize: '13px' }}>
            {tr(
              'Prefer manual wallet verification?',
              'Ingin verifikasi dompet secara manual?',
              '需要手动验证钱包？'
            )}{' '}
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
              <Lock size={12} /> {tr('Login Portal', 'Portal Login', '登录入口')}
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
                  <stop offset="100%" stopColor="var(--color-text-positive)" />
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
              <circle cx="708" cy="12" r="4.5" fill="var(--color-text-positive)" />
              <text x="595" y="114" fill="var(--color-text-positive)" fontSize="10" fontWeight="700" fontFamily="monospace">Auto DEX LP Lock</text>
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
            { icon: <Zap size={26} style={{ color: '#4285F4' }} />, stat: '0%', label: tr('Initial Liquidity Needed', 'Modal Likuiditas Awal', '初始流动性需求') },
            { icon: <Activity size={26} style={{ color: 'var(--color-text-positive)' }} />, stat: tr('Auto', 'Otomatis', '自动'), label: tr('DEX Liquidity Migration', 'Migrasi Likuiditas DEX', 'DEX 流动性自动迁移') },
            { icon: <ShieldAlert size={26} style={{ color: '#9B72CB' }} />, stat: 'Anti-Sybil', label: tr('KOL & Bounty Verification', 'Verifikasi KOL & Bounty', 'KOL 与赏金反女巫验证') },
            { icon: <Lock size={26} style={{ color: '#F59E0B' }} />, stat: '100%', label: tr('Non-Custodial Wallet', 'Dompet Non-Custodial', '非托管钱包') },
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
            {tr(
              'Everything you need to launch & trade tokens',
              'Semua yang Anda butuhkan untuk meluncurkan & trading token',
              '发行与交易代币所需的一切工具'
            )}
          </h2>
          <p className="text-muted" style={{ fontSize: '15px', margin: 0 }}>
            {tr(
              'Fully integrated with 5-Agent AI Desk, Bonding Curve Launchpad, and KOL Bounty Hub.',
              'Terintegrasi penuh dengan 5 Agen AI, Bonding Curve Launchpad, dan KOL Bounty Hub.',
              '全面集成 5 智能体 AI 投研台、联合曲线 Launchpad 与 KOL 赏金中心。'
            )}
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
              {tr('Bonding Curve Launchpad', 'Bonding Curve Launchpad', '联合曲线发射台')}
            </h3>
            <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              {tr(
                'Launch tokens in minutes with 0% buy/sell tax and automatic DEX migration once the curve target is reached.',
                'Luncurkan token dalam hitungan menit dengan 0% pajak beli/jual dan migrasi otomatis ke DEX setelah target tercapai.',
                '数分钟内发行代币，0% 买卖税，达成目标后自动迁移流动性至 DEX。'
              )}
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
              {tr(
                '24 ETH Target · 1% Fee (0.5% Creator) · 0% Tax',
                'Target 24 ETH · Fee 1% (0.5% Kreator) · 0% Tax',
                '24 ETH 目标 · 1% 手续费（0.5% 创作者）· 0% 税'
              )}
            </div>
          </div>

          <div className="bento-card bento-anim spotlight-card" onMouseMove={handleCardMouseMove}>
            <div style={{ marginBottom: '14px' }}>
              <Award size={30} style={{ color: 'var(--color-text-positive)' }} />
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 800, margin: '0 0 10px 0', color: 'var(--color-foreground)' }}>
              {tr('KOL Hub & Angel Deal Room', 'KOL Hub & Angel Deal Room', 'KOL 中心与天使合作室')}
            </h3>
            <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              {tr(
                'Run viral campaigns with verified X, Farcaster, and Lens KOLs with transparent on-chain reward distribution.',
                'Bangun kampanye viral bersama KOL terverifikasi X, Farcaster, dan Lens dengan pembagian reward transparan.',
                '与已验证的 X、Farcaster 和 Lens KOL 合作开展病毒式推广，链上透明分配奖励。'
              )}
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
                    color: 'var(--color-text-positive)',
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
              {tr('AI Desk & Risk Protection', 'AI Desk & Perlindungan Risiko', 'AI 投研台与风险保护')}
            </h3>
            <p className="text-muted" style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px 0' }}>
              {tr(
                'Analyze Launchpad, GeckoTerminal, and DexScreener tokens with 5 AI Agents, complete with slippage caps & Risk Guard.',
                'Analisis token Launchpad maupun GeckoTerminal/DexScreener dengan 5 Agen AI, lengkap dengan batas slippage & Risk Guard.',
                '通过 5 智能体 AI 分析 Launchpad 与 DexScreener 代币，内置滑点上限与风控闸门。'
              )}
            </p>
            <div
              style={{
                background: 'rgba(155, 114, 203, 0.1)',
                border: '1px solid rgba(155, 114, 203, 0.25)',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '12px',
                color: 'var(--color-accent-purple)',
                fontWeight: 600,
              }}
            >
              {tr(
                '4 Strategy Profiles · Slippage Cap · Manual Approval',
                '4 Profil Strategi · Slippage Cap · Persetujuan Manual',
                '4 套策略模板 · 滑点上限 · 手动确认'
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
