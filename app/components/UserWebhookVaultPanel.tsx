'use client';

import React, { useEffect, useState } from 'react';
import { Bell, Plus, Trash2, Send, Lock, ShieldCheck } from 'lucide-react';

interface WebhookItem {
  id: string;
  label: string;
  maskedKey: string;
  isDefault: boolean;
  lastUsedAt: string | null;
}

interface UserWebhookVaultPanelProps {
  isConnected: boolean;
}

export function UserWebhookVaultPanel({ isConnected }: UserWebhookVaultPanelProps) {
  const [hooks, setHooks] = useState<WebhookItem[]>([]);
  const [maxKeys, setMaxKeys] = useState<number>(2);
  const [showAdd, setShowAdd] = useState<boolean>(false);
  const [label, setLabel] = useState<string>('');
  const [webhookUrl, setWebhookUrl] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadWebhooks = async () => {
    if (!isConnected) return;
    try {
      const res = await fetch('/api/user/provider-keys?provider=WEBHOOK');
      const json = await res.json();
      if (json?.success && json.data) {
        setHooks(json.data.keys || []);
        setMaxKeys(Number(json.data.maxKeys ?? 2));
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadWebhooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !webhookUrl.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'WEBHOOK',
          label: label.trim(),
          apiKey: webhookUrl.trim(),
          chainScope: 'all',
          isDefault: true,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || 'Gagal menyimpan Webhook URL'}`);
      } else {
        setLabel('');
        setWebhookUrl('');
        setShowAdd(false);
        setFeedback(`✅ Webhook "${json.data.label}" tersimpan (SSRF-Safe HTTPS · AES-256-GCM).`);
        await loadWebhooks();
      }
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestPing = async (item: WebhookItem) => {
    setPingingId(item.id);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId: item.id, provider: 'WEBHOOK' }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ Test Ping "${item.label}" gagal: ${json?.error || `HTTP ${res.status}`}`);
      } else if (json.data?.connected) {
        setFeedback(`✅ Test Alert terkirim ke "${item.label}" (HTTP ${json.data.statusCode || 200} · ${json.data.latencyMs}ms).`);
        await loadWebhooks();
      } else {
        setFeedback(`⚠️ Endpoint "${item.label}" menolak ping: ${json.data?.error || 'Delivery failed'} (${json.data?.latencyMs ?? 0}ms).`);
      }
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Network error'}`);
    } finally {
      setPingingId(null);
    }
  };

  const handleRevoke = async (keyId: string) => {
    await fetch(`/api/user/provider-keys?keyId=${encodeURIComponent(keyId)}`, { method: 'DELETE' });
    await loadWebhooks();
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
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Bell size={16} style={{ color: '#38BDF8' }} /> Outbound Alert Webhooks ({hooks.length}/{maxKeys})
            <span
              style={{
                fontSize: '9px',
                fontWeight: 800,
                padding: '2px 6px',
                borderRadius: '4px',
                background: 'rgba(16,185,129,0.14)',
                color: '#10B981',
              }}
            >
              <ShieldCheck size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
              SSRF-Safe HTTPS Only
            </span>
          </h3>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            Terima notifikasi real-time untuk <strong>Auto-Pilot TP/SL &amp; Trailing Stop</strong>, <strong>Honeypot Hard-Block</strong>, dan <strong>Token Launch</strong> langsung ke <strong>Telegram Bot</strong>, <strong>Discord</strong>, atau endpoint HTTPS Anda.
          </p>
        </div>

        {isConnected && hooks.length < maxKeys && (
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="btn-secondary"
            style={{ padding: '6px 10px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <Plus size={12} /> {showAdd ? 'Tutup' : 'Tambah Webhook'}
          </button>
        )}
      </div>

      {!isConnected ? (
        <div style={{ fontSize: '12px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={13} /> Hubungkan wallet (SIWE) untuk menyimpan &amp; menguji Webhook Alert akun Anda.
        </div>
      ) : (
        <>
          {showAdd && (
            <form
              onSubmit={handleAdd}
              style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Label (mis: Telegram HP)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px' }}
                  required
                />
                <input
                  type="url"
                  placeholder="https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID> atau Discord"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                  autoComplete="off"
                  required
                />
                <button type="submit" disabled={saving} className="btn-primary" style={{ padding: '7px 12px', fontSize: '12px' }}>
                  {saving ? '...' : 'Simpan'}
                </button>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                Format Telegram: <code>https://api.telegram.org/bot&lt;BOT_TOKEN&gt;/sendMessage?chat_id=&lt;CHAT_ID&gt;</code> · Format Discord: <code>https://discord.com/api/webhooks/...</code>
              </div>
            </form>
          )}

          {hooks.length === 0 ? (
            <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
              Belum ada webhook tersimpan. Klik <strong>Tambah Webhook</strong> untuk menghubungkan Discord atau server HTTPS Anda.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {hooks.map((h) => (
                <div
                  key={h.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '8px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>{h.label}</span>
                    <code style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                      {h.maskedKey}
                      {h.lastUsedAt ? ` · Last ping: ${new Date(h.lastUsedAt).toLocaleString()}` : ''}
                    </code>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => handleTestPing(h)}
                      disabled={pingingId === h.id}
                      className="btn-secondary"
                      style={{ padding: '4px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      <Send size={11} /> {pingingId === h.id ? 'Mengirim...' : 'Test Ping'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(h.id)}
                      className="btn-destructive"
                      style={{ padding: '4px 7px', fontSize: '11px' }}
                      aria-label={`Revoke webhook ${h.label}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {feedback && (
        <div style={{ fontSize: '11px', color: feedback.startsWith('✅') ? '#10B981' : '#F59E0B' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
