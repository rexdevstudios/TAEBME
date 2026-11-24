'use client';

import React, { useEffect, useState } from 'react';
import { Award, Download, FileJson, RefreshCw } from 'lucide-react';
import { GENESIS_SBT_SUPPLY_CAP } from '@packages/billing/genesis-sbt';
import { useLocale } from '../context/LocaleContext';

interface SnapshotSummary {
  totalMinted: number;
  supplyCap: number;
  isSoldOut: boolean;
  generatedAt: string;
}

export function AdminGenesisSnapshotPanel() {
  const { tr } = useLocale();
  const [summary, setSummary] = useState<SnapshotSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<'csv' | 'json' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadSummary = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/genesis-snapshot?format=json', {
        credentials: 'same-origin',
      });
      const json = await res.json();
      if (res.ok && json?.success && json.data) {
        setSummary({
          totalMinted: Number(json.data.totalMinted || 0),
          supplyCap: Number(json.data.supplyCap || GENESIS_SBT_SUPPLY_CAP),
          isSoldOut: Boolean(json.data.isSoldOut),
          generatedAt: String(json.data.generatedAt || new Date().toISOString()),
        });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
  }, []);

  const handleDownload = async (format: 'csv' | 'json') => {
    setDownloading(format);
    setFeedback(null);
    try {
      const res = await fetch(`/api/admin/genesis-snapshot?format=${format}`, {
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
          ? 'poolnet-genesis-pioneer-snapshot.csv'
          : 'poolnet-genesis-merkle-whitelist.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setFeedback(
        `OK: ${tr(
          `Genesis Pioneer ${format.toUpperCase()} snapshot exported.`,
          `Snapshot Genesis Pioneer (${format.toUpperCase()}) berhasil diunduh.`
        )}`
      );
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Export failed'}`);
    } finally {
      setDownloading(null);
    }
  };

  const totalMinted = summary?.totalMinted ?? 0;
  const supplyCap = summary?.supplyCap ?? GENESIS_SBT_SUPPLY_CAP;
  const isSoldOut = summary?.isSoldOut ?? false;

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Award size={15} style={{ color: 'var(--color-accent-amber)' }} />
            {tr(
              'Genesis Pioneer Snapshot & Merkle Whitelist Exporter',
              'Ekspor Snapshot Genesis Pioneer & Merkle Whitelist'
            )}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            {tr(
              'Export all minted Genesis Pioneer wallets with deterministic referral tiers and allocation weights for Angel Deal Room / TGE.',
              'Ekspor seluruh wallet Genesis Pioneer beserta tier referral & bobot alokasi deterministik untuk Angel Deal Room / TGE.'
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={loadSummary}
          disabled={loading}
          className="btn-secondary"
          style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <RefreshCw size={12} />
          {loading ? tr('Loading...', 'Memuat...') : tr('Refresh', 'Muat Ulang')}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '13px',
              fontWeight: 800,
              color: 'var(--color-foreground)',
            }}
          >
            {totalMinted.toLocaleString()} / {supplyCap.toLocaleString()} {tr('Minted', 'Dicetak')}
          </span>
          <span
            style={{
              fontSize: '10px',
              fontWeight: 800,
              padding: '2px 8px',
              borderRadius: '4px',
              backgroundColor: isSoldOut ? 'rgba(245, 158, 11, 0.14)' : 'rgba(16, 185, 129, 0.14)',
              color: isSoldOut ? 'var(--color-accent-amber)' : 'var(--color-text-positive)',
              border: `1px solid ${isSoldOut ? 'rgba(245, 158, 11, 0.35)' : 'rgba(16, 185, 129, 0.35)'}`,
            }}
          >
            {isSoldOut ? tr('SOLD OUT (CAP LOCKED)', 'HABIS (CAP TERKUNCI)') : tr('GENESIS ACTIVE', 'GENESIS AKTIF')}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => handleDownload('csv')}
            disabled={downloading !== null}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <Download size={13} />
            {downloading === 'csv' ? tr('Exporting...', 'Mengekspor...') : tr('Download CSV', 'Unduh CSV')}
          </button>
          <button
            type="button"
            onClick={() => handleDownload('json')}
            disabled={downloading !== null}
            className="btn-primary"
            style={{ fontSize: '11px', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <FileJson size={13} />
            {downloading === 'json'
              ? tr('Exporting...', 'Mengekspor...')
              : tr('Download Whitelist JSON', 'Unduh Whitelist JSON')}
          </button>
        </div>
      </div>

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
