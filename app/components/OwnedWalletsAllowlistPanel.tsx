'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Trash2, KeyRound, Copy, CheckCircle2, RefreshCw } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

interface OwnedWalletItem {
  id: string;
  address: string;
  chainType: string;
  isPrimary: boolean;
  createdAt: string;
  balanceEth?: string | null;
  balanceChain?: string;
}

interface PendingChallenge {
  primaryWallet: string;
  subWalletAddress: string;
  nonce: string;
  expiresAt: string;
  message: string;
  challengeToken: string;
}

interface OwnedWalletsAllowlistPanelProps {
  isConnected: boolean;
}

export function OwnedWalletsAllowlistPanel({ isConnected }: OwnedWalletsAllowlistPanelProps) {
  const { tr } = useLocale();
  const [wallets, setWallets] = useState<OwnedWalletItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [subAddressInput, setSubAddressInput] = useState('');
  const [challenge, setChallenge] = useState<PendingChallenge | null>(null);
  const [signatureInput, setSignatureInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkingBalances, setCheckingBalances] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadWallets = useCallback(async (includeBalances = false) => {
    if (!isConnected) return;
    if (includeBalances) setCheckingBalances(true);
    else setLoading(true);
    try {
      const url = includeBalances ? '/api/user/owned-wallets?includeBalances=1' : '/api/user/owned-wallets';
      const res = await fetch(url, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success && Array.isArray(json.data?.wallets)) {
        setWallets(json.data.wallets);
      }
    } finally {
      setLoading(false);
      setCheckingBalances(false);
    }
  }, [isConnected]);

  useEffect(() => {
    void loadWallets();
  }, [loadWallets]);

  const handleRequestChallenge = async () => {
    const clean = subAddressInput.trim();
    if (!clean) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/user/owned-wallets?challengeFor=${encodeURIComponent(clean)}`,
        { credentials: 'same-origin' }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setNotice(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setChallenge(json.data.challenge);
      setSignatureInput('');
    } finally {
      setBusy(false);
    }
  };

  const handleSignWithActiveWallet = async () => {
    if (!challenge || typeof window === 'undefined' || !(window as any).ethereum) {
      setNotice(
        tr(
          'No injected wallet found. Sign the message in your sub-wallet and paste the 0x signature below.',
          'Wallet browser tidak terdeteksi. Tanda tangani pesan di sub-wallet Anda lalu tempel signature 0x di bawah.'
        )
      );
      return;
    }
    try {
      const eth = (window as any).ethereum;
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      const active = (accounts?.[0] || '').toLowerCase();
      if (active !== challenge.subWalletAddress.toLowerCase()) {
        setNotice(
          tr(
            `Switch your active wallet in MetaMask to ${challenge.subWalletAddress} first, or paste the signature manually.`,
            `Pindahkan akun aktif di MetaMask ke ${challenge.subWalletAddress} terlebih dahulu, atau tempel signature secara manual.`
          )
        );
        return;
      }
      const sig: string = await eth.request({
        method: 'personal_sign',
        params: [challenge.message, active],
      });
      setSignatureInput(sig);
      setNotice(tr('Signature captured. Click Verify & Link Sub-Wallet.', 'Signature berhasil dibuat. Klik Verifikasi & Hubungkan Sub-Wallet.'));
    } catch (err: any) {
      setNotice(`Notice: ${err?.message || 'Signing cancelled'}`);
    }
  };

  const handleVerifyAndLink = async () => {
    if (!challenge || !signatureInput.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/user/owned-wallets', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subWalletAddress: challenge.subWalletAddress,
          challengeToken: challenge.challengeToken,
          message: challenge.message,
          signature: signatureInput.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setNotice(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setChallenge(null);
      setSubAddressInput('');
      setSignatureInput('');
      setNotice(
        tr(
          'Verified sub-wallet added to your AI Copilot Owned-Wallet Allowlist.',
          'Sub-wallet terverifikasi berhasil ditambahkan ke Allowlist AI Copilot Anda.'
        )
      );
      await loadWallets();
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async (address: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/user/owned-wallets?address=${encodeURIComponent(address)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setNotice(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      await loadWallets();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', margin: 0, display: 'flex', alignItems: 'center', gap: '7px' }}>
            <ShieldCheck size={16} style={{ color: 'var(--color-text-positive)' }} />
            {tr('Verified Owned-Wallet Allowlist (AI Copilot Transfer Guard)', 'Allowlist Wallet Milik Sendiri (Guard Transfer AI Copilot)')}
          </h3>
          <p className="text-muted" style={{ fontSize: '11px', margin: '4px 0 0 0' }}>
            {tr(
              'AI Copilot & Bankr Agent may ONLY transfer tokens to addresses verified here via cryptographic signature. External addresses are automatically blocked (HTTP 403).',
              'AI Copilot & Bankr Agent HANYA boleh mentransfer token ke alamat yang terverifikasi kriptografis di sini. Alamat asing otomatis diblokir (HTTP 403).'
            )}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {isConnected && wallets.length > 0 && (
            <button
              type="button"
              disabled={checkingBalances}
              onClick={() => void loadWallets(true)}
              className="btn-secondary"
              style={{ fontSize: '10px', padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <RefreshCw size={11} />
              {checkingBalances
                ? tr('Checking...', 'Memeriksa...', '查询中...')
                : tr('Check ETH Balances', 'Cek Saldo ETH', '查询 ETH 余额')}
            </button>
          )}
          <span style={{ fontSize: '10px', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--color-text-positive)' }}>
            ZERO-CUSTODY · ECDSA PROOF
          </span>
        </div>
      </div>

      {!isConnected ? (
        <div className="text-muted" style={{ fontSize: '12px' }}>
          {tr('Connect your primary wallet (SIWE) to manage your verified sub-wallet allowlist.', 'Hubungkan wallet utama (SIWE) untuk mengelola allowlist sub-wallet terverifikasi Anda.')}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {loading && wallets.length === 0 ? (
              <div className="text-muted" style={{ fontSize: '11px' }}>
                {tr('Loading verified wallets...', 'Memuat wallet terverifikasi...')}
              </div>
            ) : (
              wallets.map((w) => (
                <div
                  key={w.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--color-border)',
                    backgroundColor: 'var(--color-surface-elevated)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <strong>{w.address}</strong>
                    <span
                      style={{
                        fontSize: '9px',
                        fontWeight: 800,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        border: '1px solid rgba(16, 185, 129, 0.35)',
                        color: 'var(--color-text-positive)',
                      }}
                    >
                      {w.isPrimary ? 'PRIMARY SIWE' : 'VERIFIED SUB-WALLET'}
                    </span>
                    {typeof w.balanceEth === 'string' && (
                      <span
                        title={w.balanceChain || 'Base ETH'}
                        style={{
                          fontSize: '10px',
                          fontWeight: 800,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: 'var(--color-badge-info-bg)',
                          color: 'var(--color-badge-info-text)',
                          border: '1px solid var(--color-badge-info-border)',
                        }}
                      >
                        {w.balanceEth} ETH ({w.balanceChain || 'Base'})
                      </span>
                    )}
                  </span>
                  {!w.isPrimary && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleUnlink(w.address)}
                      className="btn-secondary"
                      style={{ fontSize: '10px', padding: '3px 8px', color: 'var(--color-destructive)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <Trash2 size={11} />
                      {tr('Remove', 'Hapus')}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              value={subAddressInput}
              onChange={(e) => setSubAddressInput(e.target.value)}
              placeholder={tr('Enter your secondary EVM wallet (0x...)', 'Masukkan alamat sub-wallet EVM Anda (0x...)')}
              className="input"
              style={{ flex: 1, minWidth: '240px', padding: '8px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            />
            <button
              type="button"
              disabled={busy || !subAddressInput.trim()}
              onClick={() => void handleRequestChallenge()}
              className="btn-secondary"
              style={{ fontSize: '11px', padding: '8px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <KeyRound size={13} />
              {tr('Generate Proof Challenge', 'Buat Challenge Bukti')}
            </button>
          </div>

          {challenge && (
            <div
              style={{
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                backgroundColor: 'rgba(56, 189, 248, 0.05)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-accent-info)' }}>
                  {tr('Step 2: Sign this message with your sub-wallet', 'Langkah 2: Tanda tangani pesan ini dengan sub-wallet Anda')}
                </span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(challenge.message);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="btn-secondary"
                    style={{ fontSize: '10px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
                    {copied ? tr('Copied', 'Disalin') : tr('Copy Message', 'Salin Pesan')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSignWithActiveWallet()}
                    className="btn-secondary"
                    style={{ fontSize: '10px', padding: '3px 8px' }}
                  >
                    {tr('Sign with MetaMask', 'Sign via MetaMask')}
                  </button>
                </div>
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: '8px',
                  borderRadius: '6px',
                  backgroundColor: 'var(--color-panel)',
                  border: '1px solid var(--color-border)',
                  fontSize: '10px',
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {challenge.message}
              </pre>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={signatureInput}
                  onChange={(e) => setSignatureInput(e.target.value)}
                  placeholder={tr('Paste 0x ECDSA signature from sub-wallet...', 'Tempel signature ECDSA 0x dari sub-wallet...')}
                  className="input"
                  style={{ flex: 1, minWidth: '220px', padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                />
                <button
                  type="button"
                  disabled={busy || !signatureInput.trim()}
                  onClick={() => void handleVerifyAndLink()}
                  className="btn-primary"
                  style={{ fontSize: '11px', padding: '7px 14px' }}
                >
                  {busy ? tr('Verifying...', 'Memverifikasi...') : tr('Verify & Link Sub-Wallet', 'Verifikasi & Hubungkan')}
                </button>
              </div>
            </div>
          )}

          {notice && (
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-accent-amber)' }}>
              {notice}
            </div>
          )}
        </>
      )}
    </div>
  );
}
