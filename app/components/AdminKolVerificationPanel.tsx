'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, Download, FileJson, RefreshCw, Archive } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

interface AdminKolProfileRow {
  id: string;
  userId: string;
  walletAddress: string;
  twitterHandle: string | null;
  followersCount: number;
  trustScore: number;
  completedBounties: number;
  isVerified: boolean;
  computedVerified: boolean;
  computedTier: 'GOLD' | 'SILVER' | 'UNVERIFIED';
  displayHandle: string;
  updatedAt: string;
}

interface KolQueueSummary {
  total: number;
  verifiedCount: number;
  goldCount: number;
  silverCount: number;
  profiles: AdminKolProfileRow[];
}

interface KolBacktestTelemetry {
  totalArchives: number;
  evaluatedSignals: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgDirectionalReturnPct: number;
}

export function AdminKolVerificationPanel() {
  const { tr } = useLocale();
  const [queue, setQueue] = useState<KolQueueSummary | null>(null);
  const [backtest, setBacktest] = useState<KolBacktestTelemetry | null>(null);
  const [loading, setLoading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<'csv' | 'json' | 'jsonl' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadQueue = async () => {
    setLoading(true);
    try {
      const [queueRes, datasetRes] = await Promise.all([
        fetch('/api/admin/kol-verification', { credentials: 'same-origin' }),
        fetch('/api/admin/kol-dataset?format=json', { credentials: 'same-origin' }),
      ]);
      const queueJson = await queueRes.json().catch(() => null);
      if (queueRes.ok && queueJson?.success && queueJson.data) {
        setQueue(queueJson.data as KolQueueSummary);
      }
      const datasetJson = await datasetRes.json().catch(() => null);
      if (datasetRes.ok && datasetJson?.success && datasetJson.data?.backtest) {
        setBacktest(datasetJson.data.backtest as KolBacktestTelemetry);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  const handleDecision = async (
    userId: string,
    decision: 'APPROVE_GOLD' | 'APPROVE_SILVER' | 'REVOKE'
  ) => {
    setUpdatingId(`${userId}:${decision}`);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/kol-verification', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, decision }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setFeedback(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setFeedback(
        `OK: ${tr(
          `KOL status updated to ${decision.replace('_', ' ')} (trust ${json.data?.trustScore ?? ''}).`,
          `Status KOL diperbarui menjadi ${decision.replace('_', ' ')} (trust ${json.data?.trustScore ?? ''}).`
        )}`
      );
      await loadQueue();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Update failed'}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const handleArchiveNow = async () => {
    setArchiving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/kol-dataset', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setFeedback(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setFeedback(
        `OK: ${tr(
          `Snapshot archived (${json.data?.spotPricesCaptured ?? 0} live spot prices recorded).`,
          `Snapshot berhasil diarsipkan (${json.data?.spotPricesCaptured ?? 0} harga spot live terekam).`
        )}`
      );
      await loadQueue();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Archive failed'}`);
    } finally {
      setArchiving(false);
    }
  };

  const handleDownloadDataset = async (format: 'csv' | 'json' | 'jsonl') => {
    setDownloading(format);
    setFeedback(null);
    try {
      const res = await fetch(`/api/admin/kol-dataset?format=${format}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setFeedback(`Notice: ${errJson?.error || `HTTP ${res.status}`}`);
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        format === 'csv'
          ? 'poolnet-kol-ai-consensus-dataset.csv'
          : format === 'jsonl'
            ? 'poolnet-kol-batch-eval.jsonl'
            : 'poolnet-kol-ai-consensus-dataset.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setFeedback(
        `OK: ${tr(
          `Curated Anti-Manipulation KOL AI Dataset (${format.toUpperCase()}) exported.`,
          `Dataset Konsensus AI KOL Anti-Manipulasi (${format.toUpperCase()}) berhasil diunduh.`
        )}`
      );
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Dataset export failed'}`);
    } finally {
      setDownloading(null);
    }
  };

  const profiles = queue?.profiles || [];

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ShieldCheck size={15} style={{ color: 'var(--color-accent)' }} />
            {tr(
              'KOL Verification Queue & Curated AI Consensus Dataset',
              'Antrean Verifikasi KOL & Ekspor Dataset Konsensus AI'
            )}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            {tr(
              'Approve or revoke KOL VERIFIED tiers (GOLD/SILVER) with audit trail and export 5-guardrail anti-manipulation consensus datasets.',
              'Setujui atau cabut tier KOL VERIFIED (GOLD/SILVER) dengan audit log serta ekspor dataset konsensus anti-manipulasi (5 guardrail).'
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={loadQueue}
            disabled={loading}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <RefreshCw size={12} />
            {loading ? tr('Loading...', 'Memuat...') : tr('Refresh', 'Muat Ulang')}
          </button>
          <button
            type="button"
            onClick={handleArchiveNow}
            disabled={archiving}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Archive size={12} />
            {archiving ? tr('Archiving...', 'Mengarsipkan...') : tr('Archive Now', 'Arsipkan Sekarang')}
          </button>
          <button
            type="button"
            onClick={() => handleDownloadDataset('jsonl')}
            disabled={downloading !== null}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Download size={12} />
            {downloading === 'jsonl' ? tr('Exporting...', 'Mengekspor...') : tr('Batch JSONL', 'Batch JSONL')}
          </button>
          <button
            type="button"
            onClick={() => handleDownloadDataset('csv')}
            disabled={downloading !== null}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Download size={12} />
            {downloading === 'csv' ? tr('Exporting...', 'Mengekspor...') : tr('Dataset CSV', 'Dataset CSV')}
          </button>
          <button
            type="button"
            onClick={() => handleDownloadDataset('json')}
            disabled={downloading !== null}
            className="btn-primary"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <FileJson size={12} />
            {downloading === 'json' ? tr('Exporting...', 'Mengekspor...') : tr('Dataset JSON', 'Dataset JSON')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
        <span style={{ color: 'var(--color-foreground)', fontWeight: 700 }}>
          {tr('Total Profiles', 'Total Profil')}: {queue?.total ?? 0}
        </span>
        <span style={{ color: 'var(--color-text-positive)', fontWeight: 700 }}>
          {tr('Verified', 'Terverifikasi')}: {queue?.verifiedCount ?? 0}
        </span>
        <span style={{ color: 'var(--color-accent-amber)', fontWeight: 700 }}>
          GOLD: {queue?.goldCount ?? 0}
        </span>
        <span style={{ color: 'var(--color-accent-info)', fontWeight: 700 }}>
          SILVER: {queue?.silverCount ?? 0}
        </span>
        <span style={{ color: 'var(--color-muted)', fontWeight: 700 }}>
          {tr('Archived Snapshots', 'Arsip Snapshot')}: {backtest?.totalArchives ?? 0}
        </span>
        <span style={{ color: 'var(--color-text-positive)', fontWeight: 700 }}>
          {tr('Backtest Win-Rate', 'Win-Rate Backtest')}:{' '}
          {backtest && backtest.evaluatedSignals > 0
            ? `${backtest.winRatePct}% (${backtest.wins}/${backtest.evaluatedSignals})`
            : tr('Pending Archive', 'Menunggu Arsip')}
        </span>
      </div>

      {profiles.length === 0 ? (
        <div className="text-muted" style={{ fontSize: '12px', padding: '8px 0' }}>
          {loading
            ? tr('Loading KOL profiles from PostgreSQL...', 'Memuat profil KOL dari PostgreSQL...')
            : tr('No KOL profiles registered yet.', 'Belum ada profil KOL terdaftar.')}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-muted)', textAlign: 'left' }}>
                <th style={{ padding: '7px 8px' }}>Handle</th>
                <th style={{ padding: '7px 8px' }}>Wallet</th>
                <th style={{ padding: '7px 8px' }}>Trust</th>
                <th style={{ padding: '7px 8px' }}>Tier</th>
                <th style={{ padding: '7px 8px', textAlign: 'right' }}>{tr('Actions', 'Aksi')}</th>
              </tr>
            </thead>
            <tbody>
              {profiles.slice(0, 20).map((p) => {
                const shortWallet = p.walletAddress
                  ? `${p.walletAddress.slice(0, 6)}...${p.walletAddress.slice(-4)}`
                  : '—';
                const tierColor =
                  p.computedTier === 'GOLD'
                    ? 'var(--color-accent-amber)'
                    : p.computedTier === 'SILVER'
                      ? 'var(--color-text-positive)'
                      : 'var(--color-muted)';
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '7px 8px', color: 'var(--color-foreground)', fontWeight: 700 }}>
                      {p.displayHandle}
                    </td>
                    <td style={{ padding: '7px 8px', color: 'var(--color-muted)' }}>{shortWallet}</td>
                    <td style={{ padding: '7px 8px', color: 'var(--color-foreground)' }}>{p.trustScore}</td>
                    <td style={{ padding: '7px 8px', fontWeight: 800, color: tierColor }}>
                      {p.computedTier}
                    </td>
                    <td style={{ padding: '7px 8px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          onClick={() => handleDecision(p.userId, 'APPROVE_GOLD')}
                          disabled={updatingId !== null}
                          className="btn-secondary"
                          style={{ fontSize: '10px', padding: '3px 7px' }}
                        >
                          {updatingId === `${p.userId}:APPROVE_GOLD` ? '...' : 'GOLD'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDecision(p.userId, 'APPROVE_SILVER')}
                          disabled={updatingId !== null}
                          className="btn-secondary"
                          style={{ fontSize: '10px', padding: '3px 7px' }}
                        >
                          {updatingId === `${p.userId}:APPROVE_SILVER` ? '...' : 'SILVER'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDecision(p.userId, 'REVOKE')}
                          disabled={updatingId !== null}
                          className="btn-secondary"
                          style={{ fontSize: '10px', padding: '3px 7px', color: 'var(--color-destructive)' }}
                        >
                          {updatingId === `${p.userId}:REVOKE` ? '...' : tr('Revoke', 'Cabut')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {feedback && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 700,
            backgroundColor: feedback.startsWith('OK:')
              ? 'rgba(16, 185, 129, 0.12)'
              : 'rgba(245, 158, 11, 0.12)',
            color: feedback.startsWith('OK:')
              ? 'var(--color-text-positive)'
              : 'var(--color-accent-amber)',
            border: `1px solid ${
              feedback.startsWith('OK:') ? 'rgba(16, 185, 129, 0.32)' : 'rgba(245, 158, 11, 0.32)'
            }`,
          }}
        >
          {feedback}
        </div>
      )}
    </div>
  );
}
