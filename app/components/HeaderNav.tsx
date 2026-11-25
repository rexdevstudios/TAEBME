'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';
import { KNOWN_NAVBAR_CHAINS } from '@packages/trading/paper-wallet';
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
  BarChart3,
  Globe,
  PanelLeft,
  PanelLeftClose,
  Trophy,
  Medal,
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
  const [sidebarPinned, setSidebarPinned] = React.useState<boolean>(false);
  const { locale, toggleLocale, t, tr } = useLocale();

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('poolnet_theme');
    const initial: 'dark' | 'light' = saved === 'light' ? 'light' : 'dark';
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);

    const savedPin = window.localStorage.getItem('poolnet_sidebar_pinned') === '1';
    setSidebarPinned(savedPin);
    document.documentElement.setAttribute('data-sidebar', savedPin ? 'pinned' : 'collapsed');
  }, []);

  const toggleSidebarPin = () => {
    const next = !sidebarPinned;
    setSidebarPinned(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('poolnet_sidebar_pinned', next ? '1' : '0');
      document.documentElement.setAttribute('data-sidebar', next ? 'pinned' : 'collapsed');
    }
  };

  const toggleTheme = () => {
    const next: 'dark' | 'light' = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('poolnet_theme', next);
      document.documentElement.setAttribute('data-theme', next);
    }
  };

  const CHAIN_OPTIONS = KNOWN_NAVBAR_CHAINS;

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
    { href: '/', label: t('nav.overview'), icon: LayoutDashboard },
    { href: '/launchpad', label: t('nav.launchpad'), icon: Rocket },
    { href: '/trading', label: t('nav.trade'), icon: Network },
    { href: '/agent', label: t('nav.agent'), icon: BrainCircuit },
    { href: '/kol', label: t('nav.kol'), icon: Award },
    { href: '/prop', label: t('nav.prop'), icon: Trophy },
    { href: '/leaderboard', label: t('nav.leaderboard'), icon: Medal },
    { href: '/transparency', label: t('nav.transparency'), icon: BarChart3 },
    { href: '/billing', label: t('nav.account'), icon: CreditCard },
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

  const activeNavItem = navItems.find((item) => isActive(item.href)) || navItems[0];

  return (
    <>
      {/* Pons-v2 Desktop Left Icon Rail Sidebar (56px collapsed -> 196px expanded on hover or pin) */}
      <aside
        className={`pons-sidebar ${sidebarPinned ? 'pinned' : ''}`}
        aria-label="Primary Sidebar Navigation"
      >
        <div className="pons-sidebar-header">
          <Link href="/" className="pons-sidebar-brand" title="POOLNET">
            <span className="pons-brand-mark">P</span>
            <span className="pons-sidebar-label pons-brand-text">POOLNET</span>
          </Link>
          <button
            type="button"
            onClick={toggleSidebarPin}
            className="pons-sidebar-pin-btn"
            title={sidebarPinned ? tr('Collapse sidebar', 'Kecilkan sidebar') : tr('Pin sidebar open', 'Sematkan sidebar')}
            aria-label={sidebarPinned ? tr('Collapse sidebar', 'Kecilkan sidebar') : tr('Pin sidebar open', 'Sematkan sidebar')}
          >
            {sidebarPinned ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
          </button>
        </div>

        <nav className="pons-sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={`pons-sidebar-link ${active ? 'active' : ''}`}
              >
                <Icon size={17} style={{ flexShrink: 0 }} />
                <span className="pons-sidebar-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Slim Single-Row Top Utility Bar (Desktop: offset by sidebar; Mobile: full-width + scrollable nav strip) */}
      <header className="header-nav">
        {/* Brand (mobile) + Active Section Breadcrumb (desktop) + Network Indicator */}
        <div className="flex-row items-center" style={{ gap: '10px', flexShrink: 0 }}>
          <Link href="/" className="poolnet-brand pons-mobile-brand" style={{ fontSize: '16px', fontWeight: 900, letterSpacing: '-0.5px', whiteSpace: 'nowrap' }}>
            POOLNET
          </Link>
          <span className="pons-desktop-section-title">
            {activeNavItem.label}
          </span>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 7px',
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

        {/* Mobile-Only Scrollable Navigation Links (Hidden on Desktop where Left Rail Sidebar is active) */}
        <nav className="nav-links pons-mobile-nav" style={{ gap: '2px' }}>
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
                  gap: '5px',
                  padding: '6px 8px',
                  borderRadius: '8px',
                  fontSize: '11.5px',
                  fontWeight: active ? 800 : 600,
                  whiteSpace: 'nowrap',
                  border: '1px solid transparent',
                  transition: 'all 150ms ease',
                }}
              >
                <Icon size={13} style={{ verticalAlign: 'middle', flexShrink: 0 }} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

      {/* Account & Session Controls */}
      <div className="flex-row items-center" style={{ gap: '6px', flexShrink: 0 }}>
        <button
          type="button"
          onClick={toggleLocale}
          className="btn-secondary"
          style={{
            padding: '5px 8px',
            borderRadius: '9999px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            fontWeight: 700,
            flexShrink: 0,
          }}
          title={t('nav.switchLang')}
          aria-label={t('nav.switchLang')}
        >
          <Globe size={12} />
          <span>{locale.toUpperCase()}</span>
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          className="btn-secondary"
          style={{
            padding: '5px 7px',
            borderRadius: '9999px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          title={theme === 'dark' ? t('nav.switchThemeLight') : t('nav.switchThemeDark')}
          aria-label={theme === 'dark' ? t('nav.switchThemeLight') : t('nav.switchThemeDark')}
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
        </button>
        {isConnected ? (
          <>
            {userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' || userRole === 'LAUNCH_ADMIN' || userRole === 'RISK_ADMIN' || userRole === 'BILLING_ADMIN' ? (
              <span className="badge badge-admin" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 7px', fontSize: '10.5px' }} title={`Active RBAC Role: ${userRole}`}>
                <ShieldAlert size={11} />
                {userRole === 'SUPER_ADMIN' || userRole === 'SYSTEM_ADMIN' ? 'ADMIN' : userRole.replace('_ADMIN', '')}
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
                padding: '4px 8px',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                whiteSpace: 'nowrap',
              }}
              title={`Role: ${userRole || 'TRADER'} · Tier: ${planId || 'FREE'} · Credits: ${credits.toLocaleString()}`}
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
                padding: '4px 8px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-primary)',
                fontSize: '11px',
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
                padding: '5px 8px',
                fontSize: '11px',
                color: 'var(--color-destructive)',
                borderColor: 'rgba(239, 68, 68, 0.3)',
              }}
              title="Disconnect Wallet"
              aria-label="Disconnect Wallet"
            >
              <LogOut size={13} />
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
              padding: '6px 12px',
              fontSize: '12px',
              borderRadius: '6px',
              whiteSpace: 'nowrap',
            }}
          >
            <Wallet size={14} />
            <span>{isConnecting ? 'Signing SIWE...' : 'Connect Wallet'}</span>
          </button>
        )}
      </div>
      </header>

      {/* Phase CV: Mobile Bottom Navigation Bar (< 768px native fintech feel) */}
      <nav className="pons-mobile-bottom-nav" aria-label="Mobile Bottom Navigation">
        {[navItems[0], navItems[1], navItems[2], navItems[3], navItems[navItems.length - 1]].map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`pons-mobile-bottom-link ${active ? 'active' : ''}`}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
