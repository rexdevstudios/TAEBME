'use client';

import React, { useEffect, useState } from 'react';
import { Award, Check, Copy, ExternalLink, ShieldCheck, Users } from 'lucide-react';
import {
  GENESIS_SBT_PROTOCOL_FEE_ETH,
  GENESIS_SBT_PROTOCOL_FEE_WEI_HEX,
  GENESIS_SBT_SUPPLY_CAP,
  buildGenesisReferralUrl,
  buildGenesisShareIntents,
  type GenesisReferralLeaderRow,
  type GenesisSbtMintRecord,
} from '@packages/billing/genesis-sbt';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';

const REF_STORAGE_KEY = 'poolnet_genesis_ref_wallet';

interface GenesisStatePayload {
  totalMinted: number;
  supplyCap: number;
  protocolFeeEth: string;
  welcomeCredits: number;
  referralBonusCredits: number;
  treasuryWallet: string;
  userPass: GenesisSbtMintRecord | null;
  leaderboard: GenesisReferralLeaderRow[];
}

export function GenesisSbtCard() {
  const { isConnected, walletAddress, refreshSession } = useAuth();
  const { tr } = useLocale();
  const [state, setState] = useState<GenesisStatePayload | null>(null);
  const [referrer, setReferrer] = useState<string>('');
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadState = async () => {
    try {
      const res = await fetch('/api/gamefi/genesis-sbt', { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.success && json.data) {
        setState(json.data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlRef = (params.get('ref') || '').trim();
      if (/^0x[a-fA-F0-9]{40}$/.test(urlRef)) {
        window.localStorage.setItem(REF_STORAGE_KEY, urlRef);
        setReferrer(urlRef);
      } else {
        const saved = window.localStorage.getItem(REF_STORAGE_KEY) || '';
        if (/^0x[a-fA-F0-9]{40}$/.test(saved)) setReferrer(saved);
      }
    }
    loadState();
  }, [isConnected, walletAddress]);

  const handleMint = async () => {
    if (!isConnected) {
      setFeedback('Auth: Connect MetaMask (SIWE) first to claim your Free Genesis Pioneer SBT.');
      return;
    }
    setMinting(true);
    setFeedback(null);
    try {
      let txHash: string | undefined;
      if (typeof window !== 'undefined' && window.location.hostname !== 'testnet.pndigi.site') {
        const eth = (window as any).ethereum;
        if (!eth) {
          setFeedback(`Notice: MetaMask required to confirm Base L2 protocol mint fee (${GENESIS_SBT_PROTOCOL_FEE_ETH} ETH).`);
          return;
        }
        const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
        const from = accounts?.[0];
        if (!from) {
          setFeedback('Notice: MetaMask wallet not connected.');
          return;
        }
        const treasury = state?.treasuryWallet || '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6';
        txHash = await eth.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: treasury, value: GENESIS_SBT_PROTOCOL_FEE_WEI_HEX, gas: '0x5208' }],
        });
      }

      const res = await fetch('/api/gamefi/genesis-sbt', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash,
          chain: 'base-mainnet',
          referrerWallet: referrer || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || 'Mint failed'}`);
        return;
      }
      setFeedback(
        `OK: Genesis Pioneer SBT #${json.data?.pass?.serialNumber || 1} minted! +${json.data?.welcomeCreditsGranted || 200} Credits added to your account.`
      );
      refreshSession().catch(() => {});
      await loadState();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Mint cancelled or failed'}`);
    } finally {
      setMinting(false);
    }
  };

  const handleCopyRef = () => {
    if (!walletAddress || typeof window === 'undefined') return;
    const url = buildGenesisReferralUrl(window.location.origin, walletAddress);
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const minted = state?.totalMinted ?? 0;
  const cap = state?.supplyCap ?? GENESIS_SBT_SUPPLY_CAP;
  const pct = Math.min(100, Math.round((minted / cap) * 1000) / 10);
  const userPass = state?.userPass ?? null;
  const leaders = state?.leaderboard ?? [];

  return (
    <div className="card" style={{ border: '1px solid var(--color-badge-success-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
              <Award size={17} style={{ color: 'var(--color-accent-emerald)' }} />
              {tr('Genesis Pioneer SBT — Early Adopter Pass', 'Genesis Pioneer SBT — Kartu Early Adopter')}
            </h3>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 900,
                fontFamily: 'var(--font-mono)',
                padding: '2px 8px',
                borderRadius: '999px',
                backgroundColor: 'var(--color-badge-success-bg)',
                color: 'var(--color-badge-success-text)',
                border: '1px solid var(--color-badge-success-border)',
              }}
            >
              FREE MINT
            </span>
          </div>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px', lineHeight: 1.5 }}>
            {tr(
              'Claim your non-transferable Genesis SBT for free (+200 Credits, 1.5x XP, & early-adopter utility perks). Invite friends with your link to earn +50 Credits per verified mint.',
              'Klaim Genesis SBT (Soulbound) secara gratis (+200 Credits, 1.5x XP, & benefit prioritas early adopter). Ajak teman lewat link referral Anda untuk bonus +50 Credits per mint.'
            )}
          </p>
        </div>

        <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
          <div style={{ fontWeight: 900, color: 'var(--color-foreground)', fontSize: '14px' }}>
            {minted.toLocaleString()} / {cap.toLocaleString()}
          </div>
          <div className="text-muted">{tr('Pioneers Minted', 'Pioneer Ter-mint')} ({pct}%)</div>
        </div>
      </div>

      {/* Supply Progress Bar */}
      <div style={{ width: '100%', height: '6px', borderRadius: '999px', backgroundColor: 'var(--color-surface-inset)', overflow: 'hidden', marginBottom: '12px' }}>
        <div style={{ width: `${Math.max(pct, minted > 0 ? 1.5 : 0)}%`, height: '100%', background: 'var(--color-accent-emerald)', transition: 'width 300ms ease' }} />
      </div>

      {feedback && (
        <div
          style={{
            marginBottom: '10px',
            padding: '8px 12px',
            borderRadius: '8px',
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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        {userPass ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 12px',
                borderRadius: '999px',
                backgroundColor: 'var(--color-badge-success-bg)',
                color: 'var(--color-badge-success-text)',
                border: '1px solid var(--color-badge-success-border)',
                fontSize: '12px',
                fontWeight: 800,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <ShieldCheck size={14} /> GENESIS PIONEER #{userPass.serialNumber}
            </span>
            <button
              type="button"
              onClick={handleCopyRef}
              className="btn-primary"
              style={{ padding: '7px 14px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? tr('Referral Link Copied', 'Link Referral Disalin') : tr('Copy Referral Link (+50 cr/invite)', 'Salin Link Referral (+50 cr/undangan)')}
            </button>
            {walletAddress && (() => {
              const origin = typeof window !== 'undefined' ? window.location.origin : 'https://pndigi.site';
              const intents = buildGenesisShareIntents(origin, walletAddress, userPass.serialNumber);
              return (
                <>
                  <a
                    href={intents.twitterIntentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary"
                    style={{ padding: '7px 12px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
                  >
                    <ExternalLink size={12} />
                    {tr('Share on X', 'Bagikan di X')}
                  </a>
                  <a
                    href={intents.telegramShareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary"
                    style={{ padding: '7px 12px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
                  >
                    <ExternalLink size={12} />
                    {tr('Share on Telegram', 'Bagikan di Telegram')}
                  </a>
                </>
              );
            })()}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={minting}
              onClick={handleMint}
              className="btn-primary"
              style={{ padding: '9px 18px', fontSize: '12px', fontWeight: 800 }}
            >
              {minting
                ? tr('Confirming Mint...', 'Mengonfirmasi Mint...')
                : tr('Mint Free Genesis SBT (+200 cr)', 'Mint Gratis Genesis SBT (+200 cr)')}
            </button>
            <span className="text-muted" style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
              {tr(
                `Free Mint · Base Protocol & Network Fee: ${state?.protocolFeeEth || GENESIS_SBT_PROTOCOL_FEE_ETH} ETH (~$0.50)`,
                `Mint Gratis · Biaya Protokol & Jaringan Base: ${state?.protocolFeeEth || GENESIS_SBT_PROTOCOL_FEE_ETH} ETH (~$0.50)`
              )}
            </span>
          </div>
        )}

        {walletAddress && !userPass && (
          <button
            type="button"
            onClick={handleCopyRef}
            className="btn-secondary"
            style={{ padding: '6px 10px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? tr('Copied', 'Disalin') : tr('Share Invite Link', 'Bagikan Link Undangan')}
          </button>
        )}
      </div>

      {leaders.length > 0 && (
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-muted)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Users size={12} /> {tr('Top Genesis Referrers Leaderboard', 'Papan Peringkat Referral Genesis')}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {leaders.slice(0, 5).map((row, idx) => (
              <span
                key={row.walletAddress}
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  padding: '4px 9px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--color-surface-subtle)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-foreground)',
                }}
              >
                #{idx + 1} {row.walletAddress.slice(0, 6)}...{row.walletAddress.slice(-4)} · <strong>{row.referralsCount}</strong> ({row.bonusCreditsEarned} cr)
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
