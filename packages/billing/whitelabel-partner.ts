/**
 * packages/billing/whitelabel-partner.ts
 *
 * Pure, deterministic White-Label B2B Partner Config & Telegram /safety Tenanting Engine (Phase DI).
 *  - Zero private keys: stores only public brand metadata, fee bps (0..100), public EVM treasury address,
 *    and optional Telegram group chatId for automatic white-label bot branding & referral routing.
 */

export const MAX_WHITELABEL_PARTNER_FEE_BPS = 100; // 1.00% hard cap

export interface WhiteLabelPartnerConfig {
  slug: string;
  brandName: string;
  partnerFeeBps: number;
  partnerTreasuryAddress: string;
  telegramChatId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWhiteLabelPartnerInput {
  slug: string;
  brandName: string;
  partnerFeeBps?: number;
  partnerTreasuryAddress: string;
  telegramChatId?: string;
  active?: boolean;
}

export function validateWhiteLabelPartnerInput(input: UpsertWhiteLabelPartnerInput): {
  ok: boolean;
  error?: string;
  sanitized?: Omit<WhiteLabelPartnerConfig, 'createdAt' | 'updatedAt'>;
} {
  const slug = (input.slug || '').trim().toLowerCase();
  const brandName = (input.brandName || '').trim().slice(0, 48);
  const partnerTreasuryAddress = (input.partnerTreasuryAddress || '').trim();
  const rawBps = Number(input.partnerFeeBps ?? 25);
  const telegramChatId =
    input.telegramChatId !== undefined && input.telegramChatId !== null
      ? String(input.telegramChatId).trim()
      : '';

  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(slug)) {
    return {
      ok: false,
      error: 'INVALID_SLUG: Partner slug must be 2–32 lowercase alphanumeric characters or hyphens.',
    };
  }
  if (brandName.length < 2) {
    return { ok: false, error: 'INVALID_BRAND_NAME: Brand name must be at least 2 characters.' };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(partnerTreasuryAddress)) {
    return {
      ok: false,
      error: 'INVALID_TREASURY_ADDRESS: Valid 0x EVM public treasury address is required.',
    };
  }
  if (!Number.isFinite(rawBps) || rawBps < 0 || rawBps > MAX_WHITELABEL_PARTNER_FEE_BPS) {
    return {
      ok: false,
      error: `INVALID_FEE_BPS: partnerFeeBps must be between 0 and ${MAX_WHITELABEL_PARTNER_FEE_BPS}.`,
    };
  }
  if (telegramChatId && !/^-?\d{5,20}$/.test(telegramChatId)) {
    return {
      ok: false,
      error: 'INVALID_TELEGRAM_CHAT_ID: telegramChatId must be a valid numeric Telegram chat/group ID.',
    };
  }

  return {
    ok: true,
    sanitized: {
      slug,
      brandName,
      partnerFeeBps: Math.round(rawBps),
      partnerTreasuryAddress,
      telegramChatId: telegramChatId || undefined,
      active: input.active !== false,
    },
  };
}

export function resolvePartnerByTelegramChatId(
  partners: readonly WhiteLabelPartnerConfig[],
  chatId: number | string | undefined | null
): WhiteLabelPartnerConfig | null {
  if (chatId === undefined || chatId === null) return null;
  const target = String(chatId).trim();
  if (!target) return null;
  return (
    partners.find(
      (p) => p && p.active && p.telegramChatId && String(p.telegramChatId).trim() === target
    ) || null
  );
}

export function appendWhiteLabelTelegramFooter(
  baseReply: string,
  partner: WhiteLabelPartnerConfig | null,
  baseUrl: string = 'https://pndigi.site'
): string {
  if (!partner) return baseReply;
  const cleanOrigin = baseUrl.replace(/\/+$/, '');
  const refLink = `${cleanOrigin}/trading?partner=${encodeURIComponent(partner.slug)}&ref=${encodeURIComponent(partner.partnerTreasuryAddress)}`;
  return `${baseReply}\n\n— Powered by ${partner.brandName} × POOLNET\nTrade Safe: ${refLink}`;
}
