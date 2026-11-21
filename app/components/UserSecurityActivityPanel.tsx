'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';

interface ActivityRow {
  id: string;
  action: string;
  reason: string | null;
  createdAt: string;
}

interface UserSecurityActivityPanelProps {
  isConnected: boolean;
}

export function UserSecurityActivityPanel({ isConnected }: UserSecurityActivityPanelProps) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const res = await fetch('/api/user/activity?limit=10');
      const json = await res.json();
      if (json?.success && Array.isArray(json.data?.activities)) {
        setRows(json.data.activities);
      }
    } catch {
      // Non-blocking
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  if (!isConnected) return null;

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ShieldCheck size={16} style={{ color: '#10B981' }} /> Riwayat Keamanan Akun (10 Terakhir)
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="btn-secondary"
          style={{ padding: '4px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <RefreshCw size={11} /> {loading ? 'Memuat...' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="text-muted" style={{ fontSize: '12px' }}>
          Belum ada catatan aktivitas keamanan (tambah API Key, verifikasi Binance, pembelian Add-On, atau update Risk Policy akan muncul otomatis di sini).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-accent)' }}>{r.action}</strong>
                {r.reason && <span className="text-muted">{r.reason}</span>}
              </div>
              <span className="text-muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                {new Date(r.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
