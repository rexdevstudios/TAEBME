'use client';

import React, { useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, X } from 'lucide-react';
import {
  WATCHLIST_STORAGE_KEY,
  buildWatchlistTradeHref,
  isWatchlistPinned,
  parseWatchlistStorage,
  toggleWatchlistItem,
  type WatchlistTokenInput,
  type WatchlistTokenItem,
} from '@packages/shared/token-watchlist';
import { useLocale } from '../context/LocaleContext';

export function useTokenWatchlist() {
  const [items, setItems] = useState<WatchlistTokenItem[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setItems(parseWatchlistStorage(window.localStorage.getItem(WATCHLIST_STORAGE_KEY)));
    const onStorage = (e: StorageEvent) => {
      if (e.key === WATCHLIST_STORAGE_KEY) {
        setItems(parseWatchlistStorage(e.newValue));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const togglePin = (input: WatchlistTokenInput) => {
    setItems((prev) => {
      const next = toggleWatchlistItem(prev, input);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  };

  const isPinned = (chainId: number, symbolOrAddress: string) =>
    isWatchlistPinned(items, chainId, symbolOrAddress);

  return { items, togglePin, isPinned };
}

interface TokenWatchlistBarProps {
  items: WatchlistTokenItem[];
  onUnpin: (item: WatchlistTokenItem) => void;
  onSelect?: (item: WatchlistTokenItem) => void;
}

export function TokenWatchlistBar({ items, onUnpin, onSelect }: TokenWatchlistBarProps) {
  const { tr } = useLocale();
  if (items.length === 0) return null;

  return (
    <div
      className="bg-panel"
      style={{
        padding: '10px 14px',
        borderRadius: '12px',
        border: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '11px',
          fontWeight: 800,
          color: 'var(--color-muted)',
          whiteSpace: 'nowrap',
        }}
      >
        <BookmarkCheck size={13} style={{ color: 'var(--color-accent-emerald)' }} />
        {tr('Pinned Watchlist', 'Watchlist Disematkan')} ({items.length})
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flex: 1 }}>
        {items.map((item) => (
          <div
            key={item.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 8px',
              borderRadius: '999px',
              border: '1px solid var(--color-border)',
              backgroundColor: 'var(--color-surface-subtle)',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  color: 'var(--color-foreground)',
                  fontWeight: 800,
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontFamily: 'inherit',
                }}
              >
                ${item.symbol}
              </button>
            ) : (
              <a
                href={buildWatchlistTradeHref(item)}
                style={{
                  color: 'var(--color-foreground)',
                  fontWeight: 800,
                  textDecoration: 'none',
                }}
              >
                ${item.symbol}
              </a>
            )}
            <button
              type="button"
              onClick={() => onUnpin(item)}
              aria-label={`Remove ${item.symbol} from watchlist`}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--color-muted)',
                cursor: 'pointer',
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PinWatchlistButton({
  pinned,
  onClick,
  label,
}: {
  pinned: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="btn-secondary"
      style={{
        padding: '4px 8px',
        fontSize: '11px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        borderColor: pinned ? 'var(--color-badge-success-border)' : undefined,
        color: pinned ? 'var(--color-badge-success-text)' : undefined,
        backgroundColor: pinned ? 'var(--color-badge-success-bg)' : undefined,
      }}
      title={pinned ? 'Unpin from Watchlist' : 'Pin to Watchlist'}
    >
      {pinned ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
      {label ? <span>{label}</span> : null}
    </button>
  );
}
