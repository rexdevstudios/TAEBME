'use client';

import React, { useEffect, useState } from 'react';
import { Layers, Plus, CheckCircle2, ShieldCheck, Users } from 'lucide-react';
import type { SignalPresetListing } from '@packages/agent/signal-marketplace';
import { useLocale } from '../context/LocaleContext';

type EnrichedPresetListing = SignalPresetListing & {
  kolVerified?: boolean;
  kolTier?: 'GOLD' | 'SILVER' | 'UNVERIFIED';
  kolHandle?: string;
};

interface SignalMarketplacePanelProps {
  isConnected: boolean;
}

export function SignalMarketplacePanel({ isConnected }: SignalMarketplacePanelProps) {
  const { tr } = useLocale();
  const [presets, setPresets] = useState<EnrichedPresetListing[]>([]);
  const [loading, setLoading] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priceCredits, setPriceCredits] = useState(100);
  const [takeProfitPct, setTakeProfitPct] = useState(15);
  const [stopLossPct, setStopLossPct] = useState(5);
  const [trailingStopPct, setTrailingStopPct] = useState(3);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadPresets = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agent/marketplace');
      const json = await res.json();
      if (json?.success && Array.isArray(json?.data?.presets)) {
        setPresets(json.data.presets);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPresets();
  }, []);

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyId('PUBLISH');
    setFeedback(null);
    try {
      const res = await fetch('/api/agent/marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'PUBLISH',
          title,
          description,
          priceCredits,
          takeProfitPct,
          stopLossPct,
          trailingStopPct,
          rail: 'CEX_AUTO',
          allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || 'Failed to publish preset'}`);
        return;
      }
      setTitle('');
      setDescription('');
      setShowPublish(false);
      setFeedback('OK: Strategy preset published to Marketplace (80% Creator / 20% Platform Treasury).');
      await loadPresets();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleSubscribe = async (preset: SignalPresetListing) => {
    if (!isConnected) {
      setFeedback('Auth: Connect MetaMask (SIWE) first to subscribe to a strategy preset.');
      return;
    }
    setBusyId(preset.id);
    setFeedback(null);
    try {
      const res = await fetch('/api/agent/marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SUBSCRIBE', presetId: preset.id }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || 'Subscription failed'}`);
        return;
      }
      setFeedback(
        `OK: Subscribed to "${preset.title}" (${preset.priceCredits} cr · 80% creator / 20% treasury). TP ${preset.takeProfitPct}% / SL ${preset.stopLossPct}% / Trailing ${preset.trailingStopPct}%.`
      );
      await loadPresets();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={17} style={{ color: 'var(--color-accent-emerald)' }} />
            {tr('Copy-Trading & Signal Preset Marketplace (80/20 Rev-Share)', 'Marketplace Sinyal & Copy-Trading (Bagi Hasil 80/20)')}
          </h2>
          <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '12px' }}>
            {tr(
              'Publish verified Auto-Pilot TP/SL & Trailing Stop presets. Creators earn 80% of every credit subscription; 20% funds the Platform Treasury.',
              'Publikasikan preset Auto-Pilot TP/SL & Trailing Stop terverifikasi. Kreator menerima 80% dari setiap langganan kredit; 20% masuk Treasury platform.'
            )}
          </p>
        </div>
        {isConnected && (
          <button
            type="button"
            onClick={() => setShowPublish((v) => !v)}
            className="btn-secondary"
            style={{ padding: '6px 12px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Plus size={13} /> {showPublish ? tr('Close Form', 'Tutup Form') : tr('Publish Preset', 'Publikasikan Preset')}
          </button>
        )}
      </div>

      {showPublish && isConnected && (
        <form
          onSubmit={handlePublish}
          className="bg-panel"
          style={{ padding: '14px', borderRadius: '10px', border: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
            <input
              type="text"
              required
              placeholder={tr('Strategy Title (e.g. Base Momentum Scalper)', 'Nama Strategi (mis. Base Momentum Scalper)')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input"
              style={{ padding: '7px 10px', fontSize: '12px' }}
            />
            <input
              type="number"
              min={25}
              max={5000}
              required
              value={priceCredits}
              onChange={(e) => setPriceCredits(Number(e.target.value))}
              className="input"
              style={{ padding: '7px 10px', fontSize: '12px' }}
              title="Price in Credits (25 - 5000)"
            />
          </div>
          <input
            type="text"
            placeholder={tr('Short risk & entry rationale...', 'Penjelasan singkat strategi & manajemen risiko...')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
            style={{ padding: '7px 10px', fontSize: '12px' }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '11px' }}>
            <label>
              TP (%)
              <input type="number" step="0.5" min={2} max={200} value={takeProfitPct} onChange={(e) => setTakeProfitPct(Number(e.target.value))} className="input" style={{ width: '100%', padding: '6px 8px', marginTop: '4px' }} />
            </label>
            <label>
              SL (%)
              <input type="number" step="0.5" min={1} max={50} value={stopLossPct} onChange={(e) => setStopLossPct(Number(e.target.value))} className="input" style={{ width: '100%', padding: '6px 8px', marginTop: '4px' }} />
            </label>
            <label>
              Trailing (%)
              <input type="number" step="0.5" min={0.5} max={30} value={trailingStopPct} onChange={(e) => setTrailingStopPct(Number(e.target.value))} className="input" style={{ width: '100%', padding: '6px 8px', marginTop: '4px' }} />
            </label>
          </div>
          <button type="submit" disabled={busyId === 'PUBLISH'} className="btn-primary" style={{ alignSelf: 'flex-start', padding: '7px 14px', fontSize: '12px' }}>
            {busyId === 'PUBLISH' ? tr('Publishing...', 'Mempublikasikan...') : tr('Publish Strategy (80% Rev-Share)', 'Publikasikan Strategi (Bagi Hasil 80%)')}
          </button>
        </form>
      )}

      {feedback && (
        <div
          style={{
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

      {loading && presets.length === 0 ? (
        <div className="text-muted" style={{ fontSize: '12px' }}>{tr('Loading verified presets...', 'Memuat preset terverifikasi...')}</div>
      ) : presets.length === 0 ? (
        <div className="text-muted" style={{ fontSize: '12px' }}>
          {tr('No community presets published yet. Be the first trader to publish and earn 80% credit revenue share.', 'Belum ada preset komunitas. Jadilah trader pertama yang mempublikasikan preset dan raih bagi hasil 80% kredit.')}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
          {presets.map((p) => (
            <div
              key={p.id}
              className="bg-panel"
              style={{
                padding: '14px',
                borderRadius: '12px',
                border: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: '13px', color: 'var(--color-foreground)' }}>{p.title}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {p.kolVerified && (
                      <span
                        title={p.kolHandle ? `Verified KOL ${p.kolHandle}` : 'Verified KOL'}
                        style={{
                          fontSize: '9px',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 800,
                          padding: '2px 6px',
                          borderRadius: '999px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          backgroundColor: 'rgba(16, 185, 129, 0.14)',
                          color: 'var(--color-text-positive)',
                          border: '1px solid rgba(16, 185, 129, 0.35)',
                        }}
                      >
                        <ShieldCheck size={10} /> KOL VERIFIED · {p.kolTier}
                      </span>
                    )}
                    <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', fontWeight: 800, padding: '2px 6px', borderRadius: '999px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)' }}>
                      {p.priceCredits} cr
                    </span>
                  </div>
                </div>
                <p className="text-muted" style={{ margin: '0 0 8px 0', fontSize: '11px', lineHeight: 1.45 }}>
                  {p.description}
                </p>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>
                  <span>TP +{p.takeProfitPct}%</span>
                  <span>·</span>
                  <span>SL -{p.stopLossPct}%</span>
                  <span>·</span>
                  <span>Trail {p.trailingStopPct}%</span>
                  <span>·</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <Users size={10} /> {p.subscribersCount}
                  </span>
                </div>
              </div>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => handleSubscribe(p)}
                className="btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '7px 10px', fontSize: '11px' }}
              >
                <CheckCircle2 size={12} />
                {busyId === p.id ? tr('Activating...', 'Mengaktifkan...') : tr(`Copy Preset (${p.priceCredits} cr)`, `Salin Preset (${p.priceCredits} cr)`)}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
