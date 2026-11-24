/**
 * packages/agent/signal-marketplace.ts
 *
 * Pure, deterministic Copy-Trading / Auto-Pilot Signal Preset Marketplace engine (Phase DE).
 *  - Fixed 80% Creator / 20% Platform Treasury revenue split on every credit subscription.
 *  - Deterministic Risk Gate bounds on TP/SL/Trailing Stop so unsafe presets are rejected.
 */

export const MARKETPLACE_PLATFORM_FEE_PCT = 20;
export const MARKETPLACE_CREATOR_SHARE_PCT = 80;
export const MIN_PRESET_PRICE_CREDITS = 25;
export const MAX_PRESET_PRICE_CREDITS = 5000;

export interface SignalPresetListing {
  id: string;
  title: string;
  description: string;
  creatorWallet: string;
  priceCredits: number;
  rail: 'CEX_AUTO' | 'DEX_SESSION';
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  allowedSymbols: string[];
  subscribersCount: number;
  createdAt: string;
}

export interface PublishSignalPresetInput {
  title: string;
  description: string;
  priceCredits: number;
  rail?: 'CEX_AUTO' | 'DEX_SESSION';
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct?: number;
  allowedSymbols?: string[];
}

export function computeMarketplaceSplit(priceCredits: number): {
  totalCredits: number;
  creatorCredits: number;
  platformCredits: number;
} {
  const safeTotal = Math.max(0, Math.round(Number(priceCredits) || 0));
  const platformCredits = Math.round((safeTotal * MARKETPLACE_PLATFORM_FEE_PCT) / 100);
  const creatorCredits = Math.max(0, safeTotal - platformCredits);
  return {
    totalCredits: safeTotal,
    creatorCredits,
    platformCredits,
  };
}

export function validateSignalPresetInput(input: PublishSignalPresetInput): {
  ok: boolean;
  error?: string;
  sanitized?: Omit<SignalPresetListing, 'id' | 'creatorWallet' | 'subscribersCount' | 'createdAt'>;
} {
  const title = (input.title || '').trim().slice(0, 60);
  const description = (input.description || '').trim().slice(0, 200);
  const priceCredits = Math.round(Number(input.priceCredits));
  const takeProfitPct = Number(input.takeProfitPct);
  const stopLossPct = Number(input.stopLossPct);
  const trailingStopPct = Number(input.trailingStopPct ?? 3);
  const rail: 'CEX_AUTO' | 'DEX_SESSION' =
    input.rail === 'DEX_SESSION' ? 'DEX_SESSION' : 'CEX_AUTO';

  if (title.length < 4) {
    return { ok: false, error: 'INVALID_TITLE: Preset title must be at least 4 characters.' };
  }
  if (!Number.isFinite(priceCredits) || priceCredits < MIN_PRESET_PRICE_CREDITS || priceCredits > MAX_PRESET_PRICE_CREDITS) {
    return {
      ok: false,
      error: `INVALID_PRICE: Price must be between ${MIN_PRESET_PRICE_CREDITS} and ${MAX_PRESET_PRICE_CREDITS} Credits.`,
    };
  }
  if (!Number.isFinite(takeProfitPct) || takeProfitPct < 2 || takeProfitPct > 200) {
    return { ok: false, error: 'INVALID_TP: Take-Profit must be between 2% and 200%.' };
  }
  if (!Number.isFinite(stopLossPct) || stopLossPct < 1 || stopLossPct > 50) {
    return { ok: false, error: 'INVALID_SL: Stop-Loss must be between 1% and 50%.' };
  }
  if (!Number.isFinite(trailingStopPct) || trailingStopPct < 0.5 || trailingStopPct > 30) {
    return { ok: false, error: 'INVALID_TRAILING: Trailing Stop must be between 0.5% and 30%.' };
  }

  const rawSymbols = Array.isArray(input.allowedSymbols) ? input.allowedSymbols : ['BTCUSDT', 'ETHUSDT'];
  const allowedSymbols = Array.from(
    new Set(
      rawSymbols
        .map((s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9/_-]/g, ''))
        .filter((s) => s.length >= 2)
    )
  ).slice(0, 8);

  return {
    ok: true,
    sanitized: {
      title,
      description: description || 'Verified Risk-Gated Auto-Pilot Strategy Preset.',
      priceCredits,
      rail,
      takeProfitPct: Math.round(takeProfitPct * 10) / 10,
      stopLossPct: Math.round(stopLossPct * 10) / 10,
      trailingStopPct: Math.round(trailingStopPct * 10) / 10,
      allowedSymbols: allowedSymbols.length > 0 ? allowedSymbols : ['BTCUSDT', 'ETHUSDT'],
    },
  };
}
