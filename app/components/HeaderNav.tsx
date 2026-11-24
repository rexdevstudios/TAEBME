'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import {
  ShieldAlert,
  Zap,
  LayoutDashboard,
  Rocket,
  Network,
  LogOut,
  Wallet,
  BrainCircuit,
  Award,
  CreditCard,
  Sun,
  Moon,
} from 'lucide-react';
import { getNetworkLabel } from '../lib/classifyHostname';

export default function HeaderNav() {
  const pathname = usePathname();
  const {
    walletAddress,
    isConnected,
    userRole,
    planId,
    credits,
    isConnecting,
    chainId,
    connectMetaMask,
    disconnectWallet,
    switchNetwork,
  } = useAuth();

  const [isSwitchingChain, setIsSwitchingChain] = React.useState(false);
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('poolnet_theme');
    const initial: 'dark' | 'light' = saved === 'light' ? 'light' : 'dark';
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  const toggleTheme = () => {
    const next: 'dark' | 'light' = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('poolnet_theme', next);
      document.documentElement.setAttribute('data-theme', next);
    }
  };

  const CHAIN_OPTIONS = [
    { hex: '0x2105', label: 'Base Mainnet' },
    { hex: '0x14a34', label: 'Base Sepolia' },
    { hex: '0x1237', label: 'Robinhood L2' },
    { hex: '0xa4b1', label: 'Arbitrum One' },
    { hex: '0x13b2', label: 'Arc Network' },
  ];

  const normChainHex = (chainId || '').toLowerCase();
  const isKnownChain = CHAIN_OPTIONS.some((c) => c.hex === normChainHex);
  const defaultHexForHost =
    typeof window !== 'undefined' && window.location.hostname === 'testnet.pndigi.site'
      ? '0x14a34'
      : '0x2105';
  const selectedChainHex = normChainHex ? normChainHex : defaultHexForHost;

  const truncatedAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : null;

  const navItems = [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/launchpad', label: 'Launchpad', icon: Rocket },
    { href: '/trading', label: 'Trade', icon: Network },
    { href: '/agent', label: 'AI Auto-Pilot', icon: BrainCircuit },
    { href: '/kol', label: 'Earn & KOL', icon: Award },
    { href: '/billing', label: 'Account', icon: CreditCard },
  ];

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  // Network label: initialized to '—' during SSR and initial hydration pass
  // to guarantee matching markup between server and client. Updated post-mount
  // with actual browser hostname classification.
  // NOTE: This label is UI-informational only and is NOT a wallet chain-ID check.
  const [networkLabel, setNetworkLabel] = React.useState<string>('—');

  React.useEffect(() => {
    setNetworkLabel(getNetworkLabel());
  }, []);

  return (
    <header className="header-nav">
      {/* Brand & Network Indicator */}
      <div className="flex-row items-center gap-md">
        <Link href="/" className="poolnet-brand" style={{ fontSize: '18px', fontWeight: 900, letterSpacing: '-0.5px' }}>
          POOLNET
        </Link>
        <span className="badge" style={{ backgroundColor: 'var(--color-badge-neutral-bg)', border: '1px solid var(--color-badge-neutral-border)', color: 'var(--color-badge-neutral-text)', fontSize: '11px', padding: '2px 7px' }}>
          v2.5
        </span>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 9px',
            borderRadius: '9999px',
            backgroundColor: selectedChainHex === '0x14a34'
              ? 'var(--color-badge-info-bg)'
              : selectedChainHex === '0x2105'
                ? 'var(--color-badge-success-bg)'
                : 'var(--color-badge-warning-bg)',
            border: `1px solid ${
              selectedChainHex === '0x14a34'
                ? 'var(--color-badge-info-border)'
                : selectedChainHex === '0x2105'
                  ? 'var(--color-badge-success-border)'
                  : 'var(--color-badge-warning-border)'
            }`,
          }}
          title={`Environment: ${networkLabel} · Active Wallet Chain: ${normChainHex || 'Not detected'}`}
          aria-label={`Deployment environment: ${networkLabel}`}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              flexShrink: 0,
              backgroundColor: selectedChainHex === '0x14a34'
                ? 'var(--color-badge-info-text)'
                : selectedChainHex === '0x2105'
                  ? 'var(--color-badge-success-text)'
                  : 'var(--color-badge-warning-text)',
            }}
          />
          <select
            aria-label="Universal Network Switcher"
            value={selectedChainHex}
            disabled={isSwitchingChain}
            onChange={async (e) => {
              const targetHex = e.target.value;
              if (!targetHex || targetHex === normChainHex) return;
              setIsSwitchingChain(true);
              try {
                const res = await switchNetwork(targetHex);
                if (!res.success && res.error) {
                  alert(`MetaMask Network Switch: ${res.error}`);
                }
              } finally {
                setIsSwitchingChain(false);
              }
            }}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              color: selectedChainHex === '0x14a34'
                ? 'var(--color-badge-info-text)'
                : selectedChainHex === '0x2105'
                  ? 'var(--color-badge-success-text)'
                  : 'var(--color-badge-warning-text)',
              fontSize: '11px',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              paddingRight: '4px',
            }}
          >
            {normChainHex && !isKnownChain && (
              <option value={normChainHex} style={{ backgroundColor: 'var(--color-surface-elevated)', color: 'var(--color-badge-warning-text)' }}>
                Other ({parseInt(normChainHex, 16) || normChainHex})
              </option>
            )}
            {CHAIN_OPTIONS.map((c) => (
              <option key={c.hex} value={c.hex} style={{ backgroundColor: 'var(--color-surface-elevated)', color: 'var(--color-foreground)' }}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Dynamic Navigation Links */}
      <nav className="nav-links" style={{ gap: '4px' }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-link ${active ? 'nav-link-active nav-link-cex-active' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '7px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: active ? 800 : 600,
                whiteSpace: 'nowrap',
                border: '1px solid transparent',
                transition: 'all 150ms ease',
              }}
            >
              <Icon size={14} style={{ verticalAlign: 'middle', flexShrink: 0 }} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Account & Session Controls */}
      <div className="flex-row items-center gap-sm">
        <button
          type="button"
          onClick={toggleTheme}
          className="btn-secondary"
          style={{
            padding: '6px 8px',
            borderRadius: '9999px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          title={theme === 'dark' ? 'Ganti ke Tema Terang (Light Mode)' : 'Ganti ke Tema Gelap (Dark Mode)'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={14} color="#FDE047" /> : <Moon size={14} color="#1A73E8" />}
        </button>
        {isConnected ? (
          <>
            {userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' || userRole === 'LAUNCH_ADMIN' || userRole === 'RISK_ADMIN' || userRole === 'BILLING_ADMIN' ? (
              <span className="badge badge-admin" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }} title={`Active RBAC Role: ${userRole}`}>
                <ShieldAlert size={12} />
                {userRole === 'SUPER_ADMIN' || userRole === 'SYSTEM_ADMIN' ? 'ADMIN' : userRole.replace('_ADMIN', '')}
              </span>
            ) : userRole === 'CREATOR' ? (
              <span className="badge badge-creator" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <Rocket size={12} />
                CREATOR
              </span>
            ) : userRole === 'TRADER' ? (
              <span className="badge badge-trader" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <Zap size={12} />
                TRADER
              </span>
            ) : null}

            <Link
              href="/billing"
              className="badge"
              style={{
                border: '1px solid var(--color-badge-neutral-border)',
                backgroundColor: 'var(--color-badge-neutral-bg)',
                color: 'var(--color-badge-neutral-text)',
                fontSize: '11px',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
              title={`Active Subscription Tier: ${planId || 'FREE'} · Available Credits: ${credits.toLocaleString()}`}
            >
              <span style={{ color: 'var(--color-badge-warning-text)', fontWeight: 900 }}>{planId || 'FREE'}</span>
              <span>·</span>
              <span>{credits.toLocaleString()} cr</span>
            </Link>

            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 9px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-primary)',
                fontSize: '12px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                color: 'var(--color-foreground)',
              }}
            >
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22C55E', flexShrink: 0 }} />
              {truncatedAddress}
            </div>

            <button
              onClick={() => disconnectWallet()}
              className="btn-secondary"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                color: 'var(--color-destructive)',
                borderColor: 'rgba(239, 68, 68, 0.3)',
              }}
              title="Disconnect Wallet"
              aria-label="Disconnect Wallet"
            >
              <LogOut size={14} />
            </button>
          </>
        ) : (
          <button
            onClick={async () => {
              const res = await connectMetaMask();
              if (!res.success && res.error) {
                alert(`MetaMask Error: ${res.error}`);
              }
            }}
            disabled={isConnecting}
            className="btn-primary"
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              borderRadius: '6px',
            }}
          >
            <Wallet size={15} />
            <span>{isConnecting ? 'Signing SIWE...' : 'Connect Wallet'}</span>
          </button>
        )}
      </div>
    </header>
  );
}
