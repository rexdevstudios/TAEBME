'use client';

import React, { useEffect, useState } from 'react';
import { Building2, Check, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { WhiteLabelPartnerConfig } from '@packages/billing/whitelabel-partner';
import { useLocale } from '../context/LocaleContext';

export function AdminWhiteLabelPartnersPanel() {
  const { tr } = useLocale();
  const [partners, setPartners] = useState<WhiteLabelPartnerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [brandName, setBrandName] = useState('');
  const [partnerFeeBps, setPartnerFeeBps] = useState(25);
  const [partnerTreasuryAddress, setPartnerTreasuryAddress] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  const loadPartners = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/partners', { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.success && Array.isArray(json?.data?.partners)) {
        setPartners(json.data.partners);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPartners();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/partners', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          brandName,
          partnerFeeBps,
          partnerTreasuryAddress,
          telegramChatId: telegramChatId.trim() || undefined,
          active: true,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || `HTTP ${res.status}`}`);
        return;
      }
      setSlug('');
      setBrandName('');
      setPartnerFeeBps(25);
      setPartnerTreasuryAddress('');
      setTelegramChatId('');
      setFeedback(`OK: Partner "${json.data?.brandName || slug}" saved to Neon SSOT.`);
      await loadPartners();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (targetSlug: string) => {
    setDeletingSlug(targetSlug);
    setFeedback(null);
    try {
      const res = await fetch(`/api/admin/partners?slug=${encodeURIComponent(targetSlug)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setFeedback(`Notice: ${json.error || `HTTP ${res.status}`}`);
        return;
      }
      setFeedback(`OK: Partner "${targetSlug}" removed.`);
      await loadPartners();
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Delete failed'}`);
    } finally {
      setDeletingSlug(null);
    }
  };

  const handleCopyPartnerLink = (p: WhiteLabelPartnerConfig) => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}/trading?partner=${encodeURIComponent(p.slug)}&ref=${encodeURIComponent(p.partnerTreasuryAddress || '')}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopiedSlug(p.slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

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
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '7px' }}>
            <Building2 size={16} style={{ color: 'var(--color-accent-emerald)' }} />
            {tr('White-Label B2B Partner Registry & Telegram Tenanting', 'Registri Partner B2B White-Label & Tenanting Telegram')}
          </h3>
          <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '11px' }}>
            {tr(
              'Register external communities or DAOs to enable custom Telegram /safety branding and automated swap referral routing (0–100 bps).',
              'Daftarkan komunitas/DAO eksternal untuk mengaktifkan branding otomatis pada Bot Telegram /safety dan routing referral swap (0–100 bps).'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={loadPartners}
          disabled={loading}
          className="btn-secondary"
          style={{ padding: '5px 10px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <RefreshCw size={12} /> {loading ? tr('Loading...', 'Memuat...') : 'Refresh'}
        </button>
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
          <input
            type="text"
            required
            placeholder="slug (e.g. alpha-dao)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
          />
          <input
            type="text"
            required
            placeholder={tr('Brand Name (e.g. Alpha DAO)', 'Nama Brand (mis. Alpha DAO)')}
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px' }}
          />
          <input
            type="number"
            min={0}
            max={100}
            required
            value={partnerFeeBps}
            onChange={(e) => setPartnerFeeBps(Number(e.target.value))}
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
            title="Partner Fee BPS (0 - 100)"
          />
          <input
            type="text"
            required
            placeholder="0x... Partner Treasury"
            value={partnerTreasuryAddress}
            onChange={(e) => setPartnerTreasuryAddress(e.target.value)}
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
          />
          <input
            type="text"
            placeholder="Telegram Group ID (optional)"
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
          />
        </div>
        <button
          type="submit"
          disabled={saving}
          className="btn-primary"
          style={{ alignSelf: 'flex-start', padding: '7px 14px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <Plus size={12} /> {saving ? tr('Saving...', 'Menyimpan...') : tr('Save B2B Partner', 'Simpan Partner B2B')}
        </button>
      </form>

      {feedback && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: '8px',
            fontSize: '11px',
            fontWeight: 700,
            backgroundColor: feedback.startsWith('OK:') ? 'var(--color-badge-success-bg)' : 'var(--color-badge-warning-bg)',
            color: feedback.startsWith('OK:') ? 'var(--color-badge-success-text)' : 'var(--color-badge-warning-text)',
            border: `1px solid ${feedback.startsWith('OK:') ? 'var(--color-badge-success-border)' : 'var(--color-badge-warning-border)'}`,
          }}
        >
          {feedback}
        </div>
      )}

      {partners.length === 0 ? (
        <div className="text-muted" style={{ fontSize: '11px' }}>
          {tr('No B2B partners registered yet.', 'Belum ada partner B2B yang terdaftar.')}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-muted)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Slug</th>
                <th style={{ padding: '6px 8px' }}>Brand</th>
                <th style={{ padding: '6px 8px' }}>Fee</th>
                <th style={{ padding: '6px 8px' }}>Telegram Group</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.slug} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 800 }}>{p.slug}</td>
                  <td style={{ padding: '6px 8px' }}>{p.brandName}</td>
                  <td style={{ padding: '6px 8px' }}>{(p.partnerFeeBps / 100).toFixed(2)}% ({p.partnerFeeBps} bps)</td>
                  <td style={{ padding: '6px 8px' }}>{p.telegramChatId || '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => handleCopyPartnerLink(p)}
                        className="btn-secondary"
                        style={{ padding: '3px 7px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        {copiedSlug === p.slug ? <Check size={10} /> : <Copy size={10} />}
                        {copiedSlug === p.slug ? tr('Copied', 'Disalin') : tr('Link', 'Link')}
                      </button>
                      <button
                        type="button"
                        disabled={deletingSlug === p.slug}
                        onClick={() => handleDelete(p.slug)}
                        className="btn-secondary"
                        style={{ padding: '3px 7px', fontSize: '10px', color: 'var(--color-destructive)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      >
                        <Trash2 size={10} /> {tr('Remove', 'Hapus')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
