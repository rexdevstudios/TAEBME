'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Award, Check, Copy, Medal, RefreshCw, TrendingUp, Trophy, Users } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

interface GenesisLeaderRow {
  walletAddress: string;
  referralsCount: number;
  bonusCreditsEarned: number;
}

interface PropLeaderRow {
  id: string;
  walletAddress: string;
  pnlPct: number;
  maxDrawdownPct: number;
  tradingDaysCount: number;
  status: string;
}

interface SignalPresetRow {
  id: string;
  title: string;
  creatorWallet: string;
  priceCredits: number;
  subscribersCount: number;
  strategyType?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  kolVerified?: boolean;
  kolHandle?: string;
}

function maskWallet(addr: string): string {
  const clean = String(addr || '').trim();
  if (clean.length < 12) return clean || '-';
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

export default function LeaderboardPage() {
  const { tr } = useLocale();
  const [activeTab, setActiveTab] = useState<'genesis' | 'prop' | 'signals'>('genesis');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const [genesisMinted, setGenesisMinted] = useState(0);
  const [genesisCap, setGenesisCap] = useState(10000);
  const [genesisLeaders, setGenesisLeaders] = useState<GenesisLeaderRow[]>([]);

  const [propVerified, setPropVerified] = useState(0);
  const [propTotal, setPropTotal] = useState(0);
  const [propLeaders, setPropLeaders] = useState<PropLeaderRow[]>([]);

  const [signalPresets, setSignalPresets] = useState<SignalPresetRow[]>([]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [genRes, propRes, sigRes] = await Promise.all([
        fetch('/api/gamefi/genesis-sbt').then((r) => r.json()).catch(() => null),
        fetch('/api/prop/challenge').then((r) => r.json()).catch(() => null),
        fetch('/api/agent/marketplace').then((r) => r.json()).catch(() => null),
      ]);

      if (genRes?.success && genRes.data) {
        setGenesisMinted(Number(genRes.data.totalMinted || 0));
        setGenesisCap(Number(genRes.data.supplyCap || 10000));
        setGenesisLeaders(Array.isArray(genRes.data.leaderboard) ? genRes.data.leaderboard : []);
      }

      if (propRes?.success && propRes.data) {
        setPropVerified(Number(propRes.data.verifiedTradersCount || 0));
        setPropTotal(Number(propRes.data.totalChallenges || 0));
        setPropLeaders(Array.isArray(propRes.data.leaderboard) ? propRes.data.leaderboard : []);
      }

      if (sigRes?.success && sigRes.data && Array.isArray(sigRes.data.presets)) {
        const sorted = [...sigRes.data.presets].sort(
          (a: SignalPresetRow, b: SignalPresetRow) =>
            Number(b.subscribersCount || 0) - Number(a.subscribersCount || 0)
        );
        setSignalPresets(sorted);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleCopyUrl = () => {
    if (typeof window === 'undefined') return;
    navigator.clipboard?.writeText(window.location.href).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="container flex-col gap-lg" style={{ paddingTop: '24px', paddingBottom: '48px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 900, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Medal size={22} style={{ color: 'var(--color-accent-amber)' }} />
            {tr('POOLNET Global Leaderboard', 'Papan Peringkat Global POOLNET')}
          </h1>
          <p className="text-muted" style={{ margin: '4px 0 0 0', fontSize: '13px' }}>
            {tr(
              'Real-time verified rankings across Genesis Pioneer Referrers, Prop Trading Cup Winners, and Top Signal Creators.',
              'Peringkat terverifikasi real-time untuk Referral Genesis Pioneer, Pemenang Prop Trading Cup, dan Kreator Sinyal Teratas.'
            )}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={handleCopyUrl}
            className="btn-secondary"
            style={{ fontSize: '12px', padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? tr('Link Copied', 'Link Disalin') : tr('Share Leaderboard', 'Bagikan Peringkat')}
          </button>
          <button
            type="button"
            onClick={loadAll}
            disabled={loading}
            className="btn-primary"
            style={{ fontSize: '12px', padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <RefreshCw size={13} />
            {loading ? tr('Loading...', 'Memuat...') : tr('Refresh', 'Muat Ulang')}
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid-3" style={{ gap: '14px' }}>
        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '16px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Award size={13} style={{ color: 'var(--color-text-positive)' }} />
            {tr('Genesis Pioneers Minted', 'Genesis Pioneer Dicetak')}
          </div>
          <div style={{ fontSize: '20px', fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--color-foreground)', marginTop: '6px' }}>
            {genesisMinted.toLocaleString()} / {genesisCap.toLocaleString()}
          </div>
          <Link href="/" style={{ fontSize: '11px', color: 'var(--color-accent-info)', textDecoration: 'none', fontWeight: 700 }}>
            {tr('Claim Free Genesis SBT →', 'Klaim Gratis Genesis SBT →')}
          </Link>
        </div>

        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '16px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Trophy size={13} style={{ color: 'var(--color-accent-amber)' }} />
            {tr('Verified Prop Traders', 'Trader Prop Terverifikasi')}
          </div>
          <div style={{ fontSize: '20px', fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--color-foreground)', marginTop: '6px' }}>
            {propVerified} <span className="text-muted" style={{ fontSize: '12px', fontWeight: 600 }}>/ {propTotal} {tr('entries', 'peserta')}</span>
          </div>
          <Link href="/prop" style={{ fontSize: '11px', color: 'var(--color-accent-info)', textDecoration: 'none', fontWeight: 700 }}>
            {tr('Enter Prop Trading Cup →', 'Ikut Prop Trading Cup →')}
          </Link>
        </div>

        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '16px' }}>
          <div className="text-muted" style={{ fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <TrendingUp size={13} style={{ color: 'var(--color-accent-purple)' }} />
            {tr('Published Signal Presets', 'Preset Sinyal Terbit')}
          </div>
          <div style={{ fontSize: '20px', fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--color-foreground)', marginTop: '6px' }}>
            {signalPresets.length}
          </div>
          <Link href="/agent" style={{ fontSize: '11px', color: 'var(--color-accent-info)', textDecoration: 'none', fontWeight: 700 }}>
            {tr('Browse 80/20 Marketplace →', 'Lihat Marketplace 80/20 →')}
          </Link>
        </div>
      </div>

      {/* Category Switcher */}
      <div role="tablist" aria-label="Leaderboard Categories" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'genesis'}
          onClick={() => setActiveTab('genesis')}
          className={activeTab === 'genesis' ? 'btn-primary' : 'btn-secondary'}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Users size={13} /> {tr('Genesis Referrers', 'Referral Genesis')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'prop'}
          onClick={() => setActiveTab('prop')}
          className={activeTab === 'prop' ? 'btn-primary' : 'btn-secondary'}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Trophy size={13} /> {tr('Verified Prop Traders', 'Trader Prop Terverifikasi')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'signals'}
          onClick={() => setActiveTab('signals')}
          className={activeTab === 'signals' ? 'btn-primary' : 'btn-secondary'}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <TrendingUp size={13} /> {tr('Top Signal Creators', 'Kreator Sinyal Teratas')}
        </button>
      </div>

      {/* Table Panel */}
      <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '18px', overflowX: 'auto' }}>
        {activeTab === 'genesis' && (
          genesisLeaders.length === 0 ? (
            <div className="text-muted" style={{ fontSize: '13px', padding: '16px 0' }}>
              {tr(
                'No Genesis referrals recorded yet. Claim your Free-Mint Genesis SBT on the home page and invite friends to earn +50 Credits per verified mint.',
                'Belum ada referral Genesis tercatat. Klaim Genesis SBT gratis di beranda dan undang teman untuk bonus +50 Credits per mint terverifikasi.'
              )}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left', color: 'var(--color-muted)' }}>
                  <th style={{ padding: '8px' }}>#</th>
                  <th style={{ padding: '8px' }}>{tr('Wallet', 'Dompet')}</th>
                  <th style={{ padding: '8px' }}>{tr('Verified Invites', 'Undangan Valid')}</th>
                  <th style={{ padding: '8px' }}>{tr('Bonus Credits', 'Bonus Kredit')}</th>
                </tr>
              </thead>
              <tbody>
                {genesisLeaders.map((row, idx) => (
                  <tr key={row.walletAddress} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 900 }}>#{idx + 1}</td>
                    <td style={{ padding: '10px 8px', color: 'var(--color-foreground)' }}>{maskWallet(row.walletAddress)}</td>
                    <td style={{ padding: '10px 8px', fontWeight: 800, color: 'var(--color-accent-info)' }}>{row.referralsCount}</td>
                    <td style={{ padding: '10px 8px', fontWeight: 800, color: 'var(--color-text-positive)' }}>+{row.bonusCreditsEarned} cr</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeTab === 'prop' && (
          propLeaders.length === 0 ? (
            <div className="text-muted" style={{ fontSize: '13px', padding: '16px 0' }}>
              {tr(
                'No Verified Prop Traders yet. Pass the +8% profit target in the POOLNET Trading Cup to claim your Verified Trader badge and +250 Credits.',
                'Belum ada Verified Prop Trader. Capai target profit +8% di POOLNET Trading Cup untuk meraih badge Verified Trader dan +250 Credits.'
              )}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left', color: 'var(--color-muted)' }}>
                  <th style={{ padding: '8px' }}>#</th>
                  <th style={{ padding: '8px' }}>{tr('Trader Wallet', 'Dompet Trader')}</th>
                  <th style={{ padding: '8px' }}>PnL</th>
                  <th style={{ padding: '8px' }}>{tr('Max Drawdown', 'Drawdown Maks')}</th>
                  <th style={{ padding: '8px' }}>{tr('Trading Days', 'Hari Trading')}</th>
                </tr>
              </thead>
              <tbody>
                {propLeaders.map((row, idx) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 900 }}>#{idx + 1}</td>
                    <td style={{ padding: '10px 8px', color: 'var(--color-foreground)' }}>{maskWallet(row.walletAddress)}</td>
                    <td style={{ padding: '10px 8px', fontWeight: 800, color: 'var(--color-text-positive)' }}>+{Number(row.pnlPct || 0).toFixed(2)}%</td>
                    <td style={{ padding: '10px 8px' }}>{Number(row.maxDrawdownPct || 0).toFixed(2)}%</td>
                    <td style={{ padding: '10px 8px' }}>{row.tradingDaysCount}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeTab === 'signals' && (
          signalPresets.length === 0 ? (
            <div className="text-muted" style={{ fontSize: '13px', padding: '16px 0' }}>
              {tr(
                'No public signal presets published yet. Publish your risk-gated Auto-Pilot strategy in /agent to earn 80% creator revenue share.',
                'Belum ada preset sinyal publik. Terbitkan strategi Auto-Pilot terproteksi risk-gate di /agent untuk meraih 80% bagi hasil kreator.'
              )}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left', color: 'var(--color-muted)' }}>
                  <th style={{ padding: '8px' }}>#</th>
                  <th style={{ padding: '8px' }}>{tr('Preset Title', 'Nama Preset', '策略名称')}</th>
                  <th style={{ padding: '8px' }}>{tr('Creator', 'Kreator', '创作者')}</th>
                  <th style={{ padding: '8px' }}>{tr('Risk Params', 'Parameter Risiko', '风控参数')}</th>
                  <th style={{ padding: '8px' }}>{tr('Subscribers', 'Pelanggan', '订阅数')}</th>
                  <th style={{ padding: '8px' }}>{tr('Price', 'Harga', '价格')}</th>
                  <th style={{ padding: '8px' }}>{tr('Action', 'Aksi', '操作')}</th>
                </tr>
              </thead>
              <tbody>
                {signalPresets.map((row, idx) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '10px 8px', fontWeight: 900 }}>#{idx + 1}</td>
                    <td style={{ padding: '10px 8px', color: 'var(--color-foreground)', fontWeight: 700 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span>{row.title}</span>
                        {row.kolVerified && (
                          <span
                            style={{
                              fontSize: '9px',
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: '999px',
                              backgroundColor: 'var(--color-badge-info-bg)',
                              color: 'var(--color-badge-info-text)',
                              border: '1px solid var(--color-badge-info-border)',
                            }}
                          >
                            KOL VERIFIED
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '10px 8px' }}>{row.kolHandle || maskWallet(row.creatorWallet)}</td>
                    <td style={{ padding: '10px 8px', color: 'var(--color-muted)' }}>
                      TP +{row.takeProfitPct ?? '-'}% / SL -{row.stopLossPct ?? '-'}% / Trail {row.trailingStopPct ?? '-'}%
                    </td>
                    <td style={{ padding: '10px 8px', fontWeight: 800, color: 'var(--color-accent-info)' }}>{row.subscribersCount}</td>
                    <td style={{ padding: '10px 8px', fontWeight: 800, color: 'var(--color-text-positive)' }}>{row.priceCredits} cr</td>
                    <td style={{ padding: '10px 8px' }}>
                      <Link
                        href={`/agent?tab=autopilot&presetId=${encodeURIComponent(row.id)}`}
                        style={{ color: 'var(--color-accent-info)', fontWeight: 800, textDecoration: 'none' }}
                      >
                        {tr('Apply →', 'Terapkan →', '应用 →')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
