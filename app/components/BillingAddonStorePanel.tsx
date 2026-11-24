'use client';

import React, { useEffect, useState } from 'react';
import { PlusCircle, ShieldCheck, Lock } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

interface AddonItem {
  type: 'ADDON_BANKR_SLOTS' | 'ADDON_BINANCE_SLOTS';
  name: string;
  description: string;
  slotsAdded: number;
  creditCost: number;
  targetVault: 'BANKR' | 'BINANCE';
}

interface BillingAddonStorePanelProps {
  isConnected: boolean;
  onPurchased?: () => void;
}

export function BillingAddonStorePanel({ isConnected, onPurchased }: BillingAddonStorePanelProps) {
  const { tr } = useLocale();
  const [catalog, setCatalog] = useState<AddonItem[]>([]);
  const [addonSlots, setAddonSlots] = useState({ bankrExtraSlots: 0, binanceExtraSlots: 0 });
  const [effectiveCap, setEffectiveCap] = useState<{ maxBankrKeys: number; maxBinanceAccounts: number; planId: string } | null>(null);
  const [creditBalance, setCreditBalance] = useState<number>(0);
  const [buyingType, setBuyingType] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadAddons = async () => {
    if (!isConnected) return;
    try {
      const res = await fetch('/api/billing/addons');
      const json = await res.json();
      if (json?.success && json.data) {
        setCatalog(json.data.catalog || []);
        setAddonSlots(json.data.addonSlots || { bankrExtraSlots: 0, binanceExtraSlots: 0 });
        setEffectiveCap(json.data.effectiveCapacity || null);
        setCreditBalance(Number(json.data.creditBalance || 0));
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadAddons();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleBuy = async (addonType: 'ADDON_BANKR_SLOTS' | 'ADDON_BINANCE_SLOTS') => {
    setBuyingType(addonType);
    setFeedback(null);
    try {
      const res = await fetch('/api/billing/addons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addonType }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`Notice: ${json?.error || 'Gagal membeli slot add-on'}`);
      } else {
        setFeedback(
          `OK: Berhasil! +${json.data.slotsAdded} slot permanen ditambahkan (-${json.data.creditsCharged} Credits · Sisa: ${json.data.remainingCredits} Cr).`
        );
        await loadAddons();
        onPurchased?.();
      }
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setBuyingType(null);
    }
  };

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', margin: '0 0 4px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <PlusCircle size={16} style={{ color: 'var(--color-accent-info)' }} /> {tr('Permanent Capacity Add-Ons (Never Expire)', 'Permanent Capacity Add-Ons (Anti-Hangus)')}
          </h3>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            {tr(
              'Add permanent Bankr or Binance CEX API key slots using your Credits balance. Add-on slots never expire even if your monthly plan lapses.',
              'Tambah slot permanen untuk API Key Bankr atau Binance CEX memakai saldo Credits Anda. Slot add-on tidak hangus meski paket bulanan berakhir.'
            )}
          </p>
        </div>
        {isConnected && effectiveCap && (
          <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>
            {tr('Active Total', 'Total Aktif')} ({effectiveCap.planId}): <strong>{effectiveCap.maxBankrKeys} Bankr</strong> (+{addonSlots.bankrExtraSlots}) ·{' '}
            <strong>{effectiveCap.maxBinanceAccounts} Binance</strong> (+{addonSlots.binanceExtraSlots}) · {tr('Balance:', 'Saldo:')} <strong>{creditBalance} Cr</strong>
          </div>
        )}
      </div>

      {!isConnected ? (
        <div style={{ fontSize: '12px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={13} /> {tr('Connect wallet (SIWE) to purchase Permanent Slot Add-Ons with your Credits.', 'Hubungkan wallet (SIWE) untuk membeli Permanent Slot Add-On menggunakan Credits Anda.')}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
          {catalog.map((item) => (
            <div
              key={item.type}
              style={{
                padding: '14px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div>
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--color-foreground)', marginBottom: '4px' }}>
                  {item.name}
                </div>
                <p className="text-muted" style={{ fontSize: '11px', margin: 0, lineHeight: 1.45 }}>
                  {item.description}
                </p>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--color-accent)' }}>
                  {item.creditCost} Credits
                </span>
                <button
                  type="button"
                  disabled={buyingType !== null || creditBalance < item.creditCost}
                  onClick={() => handleBuy(item.type)}
                  className="btn-primary"
                  style={{ fontSize: '11px', padding: '6px 10px' }}
                >
                  {buyingType === item.type ? 'Memproses...' : `Beli +${item.slotsAdded} Slot`}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <ShieldCheck size={13} style={{ color: '#10B981', flexShrink: 0 }} />
        <span>
          <strong>Zero Data Loss Policy:</strong> Bila langganan bulanan habis, key Anda tidak pernah dihapus — key di luar kuota aktif hanya masuk mode <em>Frozen</em> dan langsung terbuka otomatis saat Anda renew.
        </span>
      </div>

      {feedback && (
        <div style={{ fontSize: '12px', color: feedback.startsWith('OK:') ? '#10B981' : '#F59E0B' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
