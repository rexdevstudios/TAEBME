'use client';

import React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export function SiteFooter() {
  const { tr } = useLocale();
  return (
    <footer
      style={{
        borderTop: '1px solid var(--color-border)',
        marginTop: '32px',
        padding: '16px 24px 72px 24px',
        fontSize: '11px',
        color: 'var(--color-muted)',
      }}
    >
      <div
        className="container"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
        }}
      >
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <ShieldCheck size={13} style={{ color: 'var(--color-text-positive)' }} />
          <span>
            POOLNET · {tr('100% Non-Custodial Software Interface · Not Financial Advice', 'Antarmuka Perangkat Lunak 100% Non-Custodial · Bukan Nasihat Keuangan')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <Link href="/terms" style={{ color: 'var(--color-foreground)', fontWeight: 700, textDecoration: 'none' }}>
            {tr('Terms & Risk Disclosure', 'Syarat & Pengungkapan Risiko')}
          </Link>
          <Link href="/transparency" style={{ color: 'var(--color-muted)', textDecoration: 'none' }}>
            {tr('Transparency', 'Transparansi')}
          </Link>
          <Link href="/leaderboard" style={{ color: 'var(--color-muted)', textDecoration: 'none' }}>
            {tr('Leaderboard', 'Peringkat')}
          </Link>
        </div>
      </div>
    </footer>
  );
}
