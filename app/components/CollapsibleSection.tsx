'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Reusable Pons-v2 Progressive Disclosure Accordion (Phase EQ).
 * Groups secondary, optional, or admin-only containers cleanly so primary
 * user actions stay uncluttered and above-the-fold.
 */
export function CollapsibleSection({
  title,
  subtitle,
  badge,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const { tr } = useLocale();

  return (
    <div
      className="bg-panel"
      style={{
        borderRadius: '8px',
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '10px 14px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--color-foreground)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
          {open ? (
            <ChevronDown size={15} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
          ) : (
            <ChevronRight size={15} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
          )}
          <span style={{ fontSize: '13px', fontWeight: 800 }}>{title}</span>
          {badge && (
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                padding: '2px 7px',
                borderRadius: '999px',
                backgroundColor: 'var(--color-surface-subtle)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-muted)',
              }}
            >
              {badge}
            </span>
          )}
          {subtitle && !open && (
            <span className="text-muted" style={{ fontSize: '11px' }}>
              — {subtitle}
            </span>
          )}
        </div>
        <span className="text-muted" style={{ fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>
          {open ? tr('Hide', 'Tutup', '收起') : tr('Show', 'Buka', '展开')}
        </span>
      </button>

      {open && (
        <div
          style={{
            padding: '12px 14px 14px 14px',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
