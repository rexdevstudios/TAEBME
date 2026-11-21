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
    { hex: '0x2105', label: 'Base Mainnet (8453)' },
    { hex: '0x14a34', label: 'Base Sepolia (84532)' },
    { hex: '0x1237', label: 'Robinhood L2 (4663)' },
    { hex: '0xa4b1', label: 'Arbitrum One (42161)' },
    { hex: '0x13b2', label: 'Arc Network (5042)' },
  ];

  const normChainHex = (chainId || '').toLowerCase();
  const defaultHexForHost =
    typeof window !== 'undefined' && window.location.hostname === 'testnet.pndigi.site'
      ? '0x14a34'
      : '0x2105';
  const selectedChainHex = CHAIN_OPTIONS.some((c) => c.hex === normChainHex)
    ? normChainHex
    : defaultHexForHost;

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
            borderRadius: '12px',
            backgroundColor: networkLabel === 'Base Sepolia'
              ? 'rgba(0, 229, 255, 0.08)'
              : networkLabel === 'Base Mainnet'
                ? 'rgba(34, 197, 94, 0.08)'
                : 'rgba(148, 163, 184, 0.08)',
            border: `1px solid ${
              networkLabel === 'Base Sepolia'
                ? 'rgba(0, 229, 255, 0.2)'
                : networkLabel === 'Base Mainnet'
                  ? 'rgba(34, 197, 94, 0.2)'
                  : 'rgba(148, 163, 184, 0.2)'
            }`,
            fontSize: '11px',
            color: networkLabel === 'Base Sepolia'
              ? '#67E8F9'
              : networkLabel === 'Base Mainnet'
                ? '#86EFAC'
                : '#94A3B8',
            fontWeight: 600,
          }}
          title="Deployment environment label (informational only — not a wallet chain check)"
          aria-label={`Deployment environment: ${networkLabel}`}
        >
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%',
            backgroundColor: networkLabel === 'Base Sepolia'
              ? '#00E5FF'
              : networkLabel === 'Base Mainnet'
                ? '#22C55E'
                : '#94A3B8',
          }} />
          {networkLabel}
        </div>
        <select
          aria-label="Universal Network Switcher"
          title="Switch active Web3 / MetaMask blockchain network"
          value={selectedChainHex}
          disabled={isSwitchingChain}
          onChange={async (e) => {
            const targetHex = e.target.value;
            setIsSwitchingChain(true);
            try {
              const res = await switchNetwork(targetHex);
              if (!res.success && res.error) {
                alert(`Network Switch: ${res.error}`);
              }
            } finally {
              setIsSwitchingChain(false);
            }
          }}
          style={{
            backgroundColor: '#0B1220',
            border: '1px solid var(--color-border)',
            color: '#38BDF8',
            borderRadius: '8px',
            padding: '4px 8px',
            fontSize: '11px',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            cursor: 'pointer',
          }}
        >
          {CHAIN_OPTIONS.map((c) => (
            <option key={c.hex} value={c.hex}>
              ⚡ {c.label}
            </option>
          ))}
        </select>
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
