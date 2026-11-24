'use client';

import React, { useEffect, useState } from 'react';
import { Cpu, Layers, ShieldCheck } from 'lucide-react';

interface RegistryProviderItem {
  id: string;
  name: string;
  category: 'CEX' | 'LAUNCHPAD' | 'LLM' | 'NOTIFICATION';
  status: 'LIVE' | 'ADAPTER_READY' | 'ROADMAP';
  supportedChainsOrMarkets: string[];
  nonCustodialGuard: string;
  supportsByok: boolean;
}

interface RegistryPayload {
  defaultLlm: {
    primary: string;
    failover: string;
    finalFallback: string;
  };
  providers: RegistryProviderItem[];
}

export function ProviderRegistryStatusPanel() {
  const [data, setData] = useState<RegistryPayload | null>(null);

  useEffect(() => {
    fetch('/api/providers/registry')
      .then((r) => r.json())
      .then((json) => {
        if (json?.success && json.data) {
          setData(json.data);
        }
      })
      .catch(() => {});
  }, []);

  if (!data) return null;

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
            <Layers size={16} style={{ color: '#A855F7' }} /> Modular Provider &amp; AI Engine Registry
          </h3>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            Transparansi arsitektur modular platform — seluruh integrasi mewarisi enkripsi AES-256-GCM, Soft-Freeze kuota, dan Risk Gate deterministik.
          </p>
        </div>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 10px',
            borderRadius: '6px',
            background: 'rgba(56, 189, 248, 0.12)',
            border: '1px solid rgba(56, 189, 248, 0.35)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-accent-info)',
          }}
        >
          <Cpu size={12} />
          Default AI: {data.defaultLlm.primary} → {data.defaultLlm.failover}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '10px' }}>
        {data.providers.map((p) => {
          const isLive = p.status === 'LIVE';
          return (
            <div
              key={p.id}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '5px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-foreground)' }}>{p.name}</span>
                <span
                  style={{
                    fontSize: '9px',
                    fontWeight: 800,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                    background: isLive ? 'rgba(16,185,129,0.15)' : 'rgba(168,85,247,0.16)',
                    color: isLive ? '#10B981' : 'var(--color-accent-purple)',
                  }}
                >
                  {p.status}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '9px', fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: 'var(--color-accent)' }}>{p.category}</span>
                {p.supportsByok && <span style={{ color: 'var(--color-accent-info)' }}>· BYOK</span>}
                <span className="text-muted">· {p.supportedChainsOrMarkets.join(', ')}</span>
              </div>
              <div className="text-muted" style={{ fontSize: '10px', lineHeight: 1.4, display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                <ShieldCheck size={11} style={{ color: '#10B981', flexShrink: 0, marginTop: '1px' }} />
                <span>{p.nonCustodialGuard}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
