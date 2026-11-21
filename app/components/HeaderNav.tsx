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
} from 'lucide-react';
import { getNetworkLabel } from '../lib/classifyHostname';

export default function HeaderNav() {
  const pathname = usePathname();
  const {
    walletAddress,
    isConnected,
    userRole,
    credits,
    isConnecting,
    chainId,
    connectMetaMask,
    disconnectWallet,
    switchNetwork,
  } = useAuth();

  const [isSwitchingChain, setIsSwitchingChain] = React.useState(false);

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
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/launchpad', label: 'Launchpad', icon: Rocket },
    { href: '/kol', label: 'KOL Hub', icon: Award },
    { href: '/trading', label: 'Trading Terminal', icon: Network },
    { href: '/agent', label: 'AI Proposals', icon: BrainCircuit },
    { href: '/billing', label: 'Billing & Tiers', icon: CreditCard },
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
        <span className="badge" style={{ backgroundColor: '#1A1E2F', border: '1px solid #334155', color: '#94A3B8', fontSize: '11px', padding: '2px 6px' }}>
          v2.5
        </span>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '3px 8px',
            borderRadius: '10px',
            backgroundColor: selectedChainHex === '0x14a34'
              ? 'rgba(0, 229, 255, 0.08)'
              : selectedChainHex === '0x2105'
                ? 'rgba(34, 197, 94, 0.08)'
                : 'rgba(245, 158, 11, 0.12)',
            border: `1px solid ${
              selectedChainHex === '0x14a34'
                ? 'rgba(0, 229, 255, 0.25)'
                : selectedChainHex === '0x2105'
                  ? 'rgba(34, 197, 94, 0.25)'
                  : 'rgba(245, 158, 11, 0.35)'
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
                ? '#00E5FF'
                : selectedChainHex === '0x2105'
                  ? '#22C55E'
                  : '#F59E0B',
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
                ? '#67E8F9'
                : selectedChainHex === '0x2105'
                  ? '#86EFAC'
                  : '#FDE047',
              fontSize: '11px',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              paddingRight: '4px',
            }}
          >
            {normChainHex && !isKnownChain && (
              <option value={normChainHex} style={{ backgroundColor: '#0B1220', color: '#FDE047' }}>
                Other ({parseInt(normChainHex, 16) || normChainHex})
              </option>
            )}
            {CHAIN_OPTIONS.map((c) => (
              <option key={c.hex} value={c.hex} style={{ backgroundColor: '#0B1220', color: '#E2E8F0' }}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Dynamic Navigation Links */}
      <nav className="nav-links">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-link ${active ? 'nav-link-active' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                borderRadius: '6px',
                backgroundColor: active ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
                transition: 'all 150ms ease',
              }}
            >
              <Icon size={15} style={{ verticalAlign: 'middle' }} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Account & Session Controls */}
      <div className="flex-row items-center gap-sm">
        {isConnected ? (
          <>
            {userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' ? (
              <span className="badge badge-admin" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <ShieldAlert size={12} />
                ADMIN
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

            <div
              className="badge"
              style={{
                border: '1px solid var(--color-border)',
                backgroundColor: 'rgba(15, 23, 42, 0.6)',
                color: '#94A3B8',
                fontSize: '12px',
              }}
            >
              Credits: {credits.toLocaleString()}
            </div>

            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-primary)',
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--color-foreground)',
              }}
            >
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22C55E' }} />
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
