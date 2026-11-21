'use client';

import React, { useState } from 'react';
import { Sparkles, Image as ImageIcon, Share2, ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface CreatorStudioPanelProps {
  tokenName: string;
  tokenSymbol: string;
  selectedChain: string;
  onApplyIdentity: (name: string, ticker: string) => void;
}

export function CreatorStudioPanel({
  tokenName,
  tokenSymbol,
  selectedChain,
  onApplyIdentity,
}: CreatorStudioPanelProps) {
  const { refreshSession } = useAuth();
  const [trendPrompt, setTrendPrompt] = useState('');
  const [generatedIdentity, setGeneratedIdentity] = useState<any>(null);
  const [logoDataUri, setLogoDataUri] = useState<string | null>(null);
  const [ipfsMetadataUrl, setIpfsMetadataUrl] = useState<string | null>(null);
  const [growthContractAddress, setGrowthContractAddress] = useState('');
  const [growthPack, setGrowthPack] = useState<any>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleGenerateIdentity = async () => {
    if (trendPrompt.trim().length < 3) {
      setErrorMsg('Masukkan narasi atau ide token minimal 3 karakter.');
      return;
    }
    setBusy('identity');
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/launchpad/asset-studio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate-identity', trendPrompt: trendPrompt.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErrorMsg(`Asset Studio (${res.status}): ${json.error || 'Gagal menghasilkan identitas'}`);
        return;
      }
      setGeneratedIdentity(json.data.identity);
      onApplyIdentity(json.data.identity.name, json.data.identity.ticker);
      refreshSession().catch(() => {});
      setStatusMsg(
        `✅ Identitas $${json.data.identity.ticker} ("${json.data.identity.name}") siap (${json.data.provider}) dan otomatis terisi ke form draft.`
      );
    } catch (err: any) {
      setErrorMsg(`Koneksi gagal: ${err?.message || 'Unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  const handleGenerateLogo = async () => {
    const prompt =
      generatedIdentity?.imagePrompt ||
      `minimalist crypto token emblem for ${tokenName || 'Base Token'}, neon cyan vector badge`;
    setBusy('logo');
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/launchpad/asset-studio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate-logo',
          imagePrompt: prompt,
          tokenName: tokenName || generatedIdentity?.name || 'Token',
          uploadToIpfs: Boolean(generatedIdentity),
          identity: generatedIdentity || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErrorMsg(`Logo Studio (${res.status}): ${json.error || 'Gagal menghasilkan logo'}`);
        return;
      }
      setLogoDataUri(json.data.imageDataUri);
      setIpfsMetadataUrl(json.data.ipfsMetadataUrl || null);
      refreshSession().catch(() => {});
      setStatusMsg(
        json.data.uploadedToIpfs
          ? `✅ Logo dibuat & terunggah ke IPFS Pinata (${json.data.byteLength} bytes).`
          : `✅ Logo preview siap (${json.data.byteLength} bytes, stateless fallback).`
      );
    } catch (err: any) {
      setErrorMsg(`Koneksi gagal: ${err?.message || 'Unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  const handleGenerateGrowthPack = async () => {
    const name = tokenName.trim() || generatedIdentity?.name || '';
    const symbol = tokenSymbol.trim() || generatedIdentity?.ticker || '';
    const addr = growthContractAddress.trim() || '0x0000000000000000000000000000000000000000';
    if (!name || !symbol) {
      setErrorMsg('Isi Token Name & Ticker terlebih dahulu (atau gunakan AI Generate Identity di atas).');
      return;
    }
    setBusy('growth');
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch('/api/launchpad/growth-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: selectedChain || 'base',
          tokenAddress: addr,
          tokenName: name,
          tokenSymbol: symbol,
          description: generatedIdentity?.description,
          websiteUrl: generatedIdentity?.website,
          twitterUrl: generatedIdentity?.twitter,
          telegramUrl: generatedIdentity?.telegram,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErrorMsg(`Growth Pack (${res.status}): ${json.error || 'Gagal membuat Growth Pack'}`);
        return;
      }
      setGrowthPack(json.data);
      setStatusMsg(`🚀 Growth Launch Pack untuk $${symbol.toUpperCase()} (OG SVG 1200x630 + DexScreener + GeckoTerminal) siap.`);
    } catch (err: any) {
      setErrorMsg(`Koneksi gagal: ${err?.message || 'Unknown error'}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid rgba(56, 189, 248, 0.35)',
        borderRadius: '8px',
        padding: '18px',
        marginBottom: '18px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: 900, color: '#38BDF8', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Sparkles size={15} /> AI Token Studio &amp; Marketing Kit
        </div>
        <span style={{ fontSize: '10px', color: '#6EE7B7', fontFamily: 'var(--font-mono)' }}>
          Biaya: 1 Kredit per Aksi
        </span>
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <input
          type="text"
          value={trendPrompt}
          onChange={(e) => setTrendPrompt(e.target.value)}
          placeholder="Tulis ide/narasi token (cth: AI Trading Agent on Base L2 with SocialFi Bounties)"
          style={{
            flex: '1 1 280px',
            padding: '8px 10px',
            borderRadius: '6px',
            backgroundColor: '#0B1220',
            border: '1px solid var(--color-border)',
            color: 'var(--color-foreground)',
            fontSize: '12px',
          }}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null}
          onClick={handleGenerateIdentity}
          style={{ fontSize: '11px', padding: '8px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <Sparkles size={13} /> {busy === 'identity' ? 'Generating...' : 'AI Identity'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={handleGenerateLogo}
          style={{ fontSize: '11px', padding: '8px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <ImageIcon size={13} /> {busy === 'logo' ? 'Generating...' : 'Logo & IPFS'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <input
          type="text"
          value={growthContractAddress}
          onChange={(e) => setGrowthContractAddress(e.target.value)}
          placeholder="Opsional: Contract Address 0x... untuk DexScreener/GeckoTerminal Growth Pack"
          style={{
            flex: '1 1 280px',
            padding: '7px 10px',
            borderRadius: '6px',
            backgroundColor: '#0B1220',
            border: '1px solid var(--color-border)',
            color: 'var(--color-foreground)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={handleGenerateGrowthPack}
          style={{ fontSize: '11px', padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#C084FC', borderColor: 'rgba(168, 85, 247, 0.4)' }}
        >
          <Share2 size={13} /> {busy === 'growth' ? 'Building...' : 'Build Growth Pack'}
        </button>
      </div>

      {(logoDataUri || growthPack) && (
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
          {logoDataUri && (
            <img
              src={logoDataUri}
              alt="Generated Token Logo"
              style={{ width: '56px', height: '56px', borderRadius: '8px', border: '1px solid var(--color-border)' }}
            />
          )}
          {ipfsMetadataUrl && (
            <a href={ipfsMetadataUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#38BDF8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              IPFS Metadata <ExternalLink size={11} />
            </a>
          )}
          {growthPack && (
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <img
                src={growthPack.socialCardDataUri}
                alt="OG Social Card Preview"
                style={{ height: '56px', borderRadius: '6px', border: '1px solid var(--color-border)' }}
              />
              <a href={growthPack.dexScreener.updatePortalUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#6EE7B7', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                DexScreener <ExternalLink size={11} />
              </a>
              <a href={growthPack.geckoTerminal.tokenUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#FDE047', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                GeckoTerminal <ExternalLink size={11} />
              </a>
              <a href={growthPack.explorerUpdateUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: '#38BDF8', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                Explorer Update <ExternalLink size={11} />
              </a>
            </div>
          )}
        </div>
      )}

      {statusMsg && (
        <div style={{ fontSize: '11px', color: '#6EE7B7', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <CheckCircle2 size={13} /> <span>{statusMsg}</span>
        </div>
      )}
      {errorMsg && (
        <div style={{ fontSize: '11px', color: '#FCA5A5', display: 'flex', alignItems: 'center', gap: '6px', marginTop: statusMsg ? '4px' : 0 }}>
          <AlertTriangle size={13} /> <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}
