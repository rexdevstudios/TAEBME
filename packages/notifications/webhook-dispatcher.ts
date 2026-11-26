/**
 * packages/notifications/webhook-dispatcher.ts
 *
 * Stateless, SSRF-Safe Outbound Alert & Webhook Dispatcher (Discord / Telegram / Custom HTTPS).
 * - Strictly rejects non-HTTPS URLs, localhost, loopback, link-local (169.254.*), and RFC-1918 private IPs.
 * - Enforces 4s hard timeout and never blocks core trading/launchpad transactions.
 */

export type AlertEventType =
  | 'ORDER_APPROVED'
  | 'DEX_SWAP_EXECUTED'
  | 'AUTOPILOT_ORDER_QUEUED'
  | 'TRAILING_STOP_TRIGGERED'
  | 'HONEYPOT_HARD_BLOCKED'
  | 'DAILY_LOSS_WARNING'
  | 'TOKEN_DEPLOYED'
  | 'KEY_FROZEN_OVER_QUOTA'
  | 'GENESIS_WEEKLY_DIGEST'
  | 'GENESIS_SBT_MINTED'
  | 'PROP_CHALLENGE_PASSED'
  | 'AIRDROP_CAMPAIGN_CREATED';

export interface OutboundAlertPayload {
  event: AlertEventType;
  title: string;
  message: string;
  metadata?: Record<string, string | number | boolean>;
  timestamp?: string;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

/**
 * Validates that a user-supplied webhook URL is safe from SSRF attacks (public HTTPS only).
 */
export function assertSafeWebhookUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('INVALID_WEBHOOK_URL: Must be a valid HTTPS URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('UNSAFE_WEBHOOK_PROTOCOL: Only HTTPS webhook URLs are allowed.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error(`SSRF_BLOCKED_HOST: Private or loopback host "${host}" is strictly prohibited.`);
  }

  return parsed.toString();
}

const EVENT_EMOJI: Record<AlertEventType, string> = {
  ORDER_APPROVED: '✅',
  DEX_SWAP_EXECUTED: '⚡',
  AUTOPILOT_ORDER_QUEUED: '🤖',
  TRAILING_STOP_TRIGGERED: '📉',
  HONEYPOT_HARD_BLOCKED: '🚨',
  DAILY_LOSS_WARNING: '⚠️',
  TOKEN_DEPLOYED: '🚀',
  KEY_FROZEN_OVER_QUOTA: '🧊',
  GENESIS_WEEKLY_DIGEST: '🏆',
  GENESIS_SBT_MINTED: '🎖️',
  PROP_CHALLENGE_PASSED: '🥇',
  AIRDROP_CAMPAIGN_CREATED: '🎁',
};

/**
 * Pure request builder that auto-detects Telegram Bot API, Discord Webhooks, or generic HTTPS JSON.
 * - Telegram format: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
 */
export function buildOutboundWebhookRequest(
  safeUrl: string,
  payload: OutboundAlertPayload,
  ts: string
): { targetUrl: string; channel: 'TELEGRAM' | 'DISCORD' | 'GENERIC'; body: Record<string, unknown> } {
  const parsed = new URL(safeUrl);
  const host = parsed.hostname.toLowerCase();

  // 1. Telegram Bot API (https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>)
  if (host === 'api.telegram.org' && /^\/bot[^/]+\/sendMessage$/i.test(parsed.pathname)) {
    const chatId = parsed.searchParams.get('chat_id')?.trim();
    if (!chatId) {
      throw new Error(
        'INVALID_TELEGRAM_WEBHOOK_URL: Missing chat_id query parameter (use https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>).'
      );
    }
    const emoji = EVENT_EMOJI[payload.event] || '🔔';
    const metaLines = Object.entries(payload.metadata || {})
      .slice(0, 4)
      .map(([k, v]) => `• ${k}: ${String(v)}`);
    const text = [
      `${emoji} [POOLNET · ${payload.event}]`,
      payload.title,
      payload.message,
      ...(metaLines.length > 0 ? ['', ...metaLines] : []),
    ].join('\n');

    const cleanEndpoint = `${parsed.origin}${parsed.pathname}`;
    return {
      targetUrl: cleanEndpoint,
      channel: 'TELEGRAM',
      body: {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      },
    };
  }

  // 2. Discord Webhook
  const isDiscord = safeUrl.includes('discord.com/api/webhooks/') || safeUrl.includes('discordapp.com/api/webhooks/');
  if (isDiscord) {
    return {
      targetUrl: safeUrl,
      channel: 'DISCORD',
      body: {
        content: `**[POOLNET · ${payload.event}] ${payload.title}**\n${payload.message}`,
      },
    };
  }

  // 3. Generic HTTPS JSON Webhook
  return {
    targetUrl: safeUrl,
    channel: 'GENERIC',
    body: {
      source: 'POOLNET_V25',
      event: payload.event,
      title: payload.title,
      message: payload.message,
      metadata: payload.metadata || {},
      timestamp: ts,
    },
  };
}

/**
 * Dispatches an outbound alert to a validated HTTPS webhook (auto-formats for Telegram, Discord, or generic JSON).
 */
export async function dispatchOutboundAlert(params: {
  webhookUrl: string;
  payload: OutboundAlertPayload;
  fetchImpl?: typeof fetch;
}): Promise<{ delivered: boolean; statusCode?: number; error?: string }> {
  const safeUrl = assertSafeWebhookUrl(params.webhookUrl);
  const doFetch = params.fetchImpl || fetch;
  const ts = params.payload.timestamp || new Date().toISOString();

  const { targetUrl, body } = buildOutboundWebhookRequest(safeUrl, params.payload, ts);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let res: Response;
    try {
      res = await doFetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    return {
      delivered: res.ok,
      statusCode: res.status,
      ...(res.ok ? {} : { error: `WEBHOOK_HTTP_${res.status}` }),
    };
  } catch (err: any) {
    return {
      delivered: false,
      error: err?.name === 'AbortError' ? 'WEBHOOK_TIMEOUT' : err?.message || 'WEBHOOK_DISPATCH_FAILED',
    };
  }
}

/**
 * Strictly non-blocking best-effort helper for wiring live operational events
 * (ORDER_APPROVED, DAILY_LOSS_WARNING, TOKEN_DEPLOYED) into a user's default WEBHOOK vault entry.
 * Never throws and never blocks core trading or launchpad transactions.
 */
export async function notifyUserWebhookBestEffort(params: {
  resolveWebhookUrl: () => Promise<string | null>;
  payload: OutboundAlertPayload;
  fetchImpl?: typeof fetch;
}): Promise<{ attempted: boolean; delivered: boolean; statusCode?: number; error?: string }> {
  try {
    const url = await params.resolveWebhookUrl().catch(() => null);
    if (!url) {
      return { attempted: false, delivered: false };
    }
    const res = await dispatchOutboundAlert({
      webhookUrl: url,
      payload: params.payload,
      fetchImpl: params.fetchImpl,
    });
    return {
      attempted: true,
      delivered: res.delivered,
      ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  } catch (err: any) {
    return {
      attempted: true,
      delivered: false,
      error: err?.message || 'WEBHOOK_BEST_EFFORT_ERROR',
    };
  }
}

/**
 * Formats an OnChainTokenSecurityReport into a concise, mobile-friendly Telegram message (Phase CK).
 */
export function formatTelegramTokenSafetyReply(report: {
  address: string;
  chainId: number;
  riskLevel: string;
  hardBlocked: boolean;
  isHoneypot?: boolean;
  top10HolderPct: number;
  suspectedClusterCount: number;
  redFlags?: string[];
  summary?: string;
}): string {
  const badge = report.hardBlocked ? '🚨 HARD-BLOCKED' : report.riskLevel === 'LOW' ? '✅ SAFE' : `⚠️ ${report.riskLevel}`;
  const flags = (report.redFlags || []).slice(0, 4).join(', ') || 'None';
  return [
    `${badge} · Token Safety Scan (Chain ${report.chainId})`,
    `Contract: ${report.address}`,
    `Top-10 Holders: ${report.top10HolderPct}% | Insider Clusters: ${report.suspectedClusterCount}`,
    `Flags: ${flags}`,
    report.summary ? `Note: ${report.summary}` : '',
    `Powered by POOLNET GoPlus Guard ($0) · https://pndigi.site/trading`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Formats a Free On-Chain Wallet Intelligence profile into a concise Telegram message (Phase CK).
 */
export function formatTelegramWalletRiskReply(profile: {
  walletAddress: string;
  arkhamEntityName?: string;
  arkhamEntityType: string;
  riskPassportScore: number;
  isCounterpartyBlocked: boolean;
  tags?: string[];
}): string {
  const badge = profile.isCounterpartyBlocked
    ? '🚨 SANCTIONED / BLOCKED'
    : profile.riskPassportScore >= 75
      ? '✅ TRUSTED'
      : '⚠️ CAUTION';
  const tags = (profile.tags || []).slice(0, 4).join(', ') || 'Standard EOA';
  return [
    `${badge} · Wallet Risk Audit ($0 GoPlus + RPC)`,
    `Wallet: ${profile.walletAddress}`,
    `Entity: ${profile.arkhamEntityName || 'Unknown'} (${profile.arkhamEntityType})`,
    `Trust Score: ${profile.riskPassportScore}/100`,
    `Signals: ${tags}`,
    `Inspect on POOLNET · https://pndigi.site/kol`,
  ].join('\n');
}

/**
 * Builds a safe, URL-encoded viral share intent URL for X (Twitter) or Farcaster (Warpcast) (Phase CK).
 */
export function buildSocialShareUrl(
  platform: 'x' | 'farcaster',
  params: {
    text: string;
    url: string;
    refWallet?: string | null;
  }
): string {
  const cleanUrl = (params.url || 'https://pndigi.site/launchpad').trim();
  const ref = params.refWallet && /^0x[a-fA-F0-9]{40}$/.test(params.refWallet.trim())
    ? params.refWallet.trim()
    : null;
  const finalUrl = ref
    ? `${cleanUrl}${cleanUrl.includes('?') ? '&' : '?'}ref=${encodeURIComponent(ref)}`
    : cleanUrl;
  const text = (params.text || 'Check out this live token on POOLNET Launchpad!').trim();

  if (platform === 'farcaster') {
    return `https://warpcast.com/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(finalUrl)}`;
  }
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(finalUrl)}`;
}

/**
 * Resolves the configured public Telegram digest/broadcast URL from environment variables (Phase DP).
 * Priority: GENESIS_DIGEST_WEBHOOK_URL -> TELEGRAM_BOT_TOKEN + TELEGRAM_DIGEST_CHAT_ID -> null.
 */
export function resolvePublicTelegramDigestUrl(): string | null {
  const explicitUrl = process.env.GENESIS_DIGEST_WEBHOOK_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_DIGEST_CHAT_ID?.trim();
  if (botToken && chatId) {
    return `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${encodeURIComponent(chatId)}`;
  }
  return null;
}

/**
 * Strictly non-blocking best-effort broadcaster for public community milestones
 * (GENESIS_SBT_MINTED, PROP_CHALLENGE_PASSED). Never throws or blocks core user transactions.
 */
export async function notifyPublicTelegramChannelBestEffort(
  payload: OutboundAlertPayload,
  fetchImpl?: typeof fetch
): Promise<{ attempted: boolean; delivered: boolean; statusCode?: number; error?: string }> {
  try {
    const targetUrl = resolvePublicTelegramDigestUrl();
    if (!targetUrl) {
      return { attempted: false, delivered: false };
    }
    const res = await dispatchOutboundAlert({
      webhookUrl: targetUrl,
      payload,
      fetchImpl,
    });
    return {
      attempted: true,
      delivered: res.delivered,
      statusCode: res.statusCode,
      error: res.error,
    };
  } catch (err: any) {
    return {
      attempted: true,
      delivered: false,
      error: err?.message || 'PUBLIC_TELEGRAM_NOTIFY_ERROR',
    };
  }
}

export interface TelegramAirdropCampaignSummary {
  id: string;
  title: string;
  description?: string;
  requiredHashtag?: string;
  requiredFollowHandle?: string | null;
  currentParticipants?: number;
  maxParticipants?: number;
  isActive?: boolean;
}

/**
 * Pure, deterministic Telegram /airdrop command reply formatter (Phase EV + Phase EX).
 * Lists active non-custodial bounty/airdrop campaigns + Free-Mint Genesis SBT claim links.
 */
export function formatTelegramAirdropListReply(params: {
  campaigns: TelegramAirdropCampaignSummary[];
  genesisMinted?: number;
  genesisCap?: number;
  siteOrigin?: string;
}): string {
  const origin = (params.siteOrigin || 'https://pndigi.site').replace(/\/+$/, '');
  const active = (params.campaigns || []).filter((c) => c.isActive !== false);
  const lines: string[] = ['POOLNET Active Airdrops & KOL Bounties (100% Non-Custodial)'];

  if (typeof params.genesisMinted === 'number' && typeof params.genesisCap === 'number') {
    lines.push(
      `• Free-Mint Genesis Pioneer SBT: ${params.genesisMinted}/${params.genesisCap} minted (+150 XP & 0.25% referral) -> ${origin}/kol`
    );
  }

  if (active.length === 0) {
    lines.push('No active token bounty campaigns right now. Check back soon or create one at ' + `${origin}/kol`);
  } else {
    lines.push(`Active Campaigns (${active.length}):`);
    for (const c of active.slice(0, 5)) {
      const cur = Number(c.currentParticipants || 0);
      const max = Number(c.maxParticipants || 0);
      const slots = max > 0 ? ` [${cur}/${max} slots]` : '';
      const tag = c.requiredHashtag ? ` ${c.requiredHashtag}` : '';
      const followMatch = (c.description || '').match(/\[FOLLOW:@([A-Za-z0-9_]{1,30})\]/i);
      const followHandle = c.requiredFollowHandle || (followMatch?.[1] ? `@${followMatch[1]}` : null);
      const followStr = followHandle ? ` · Follow ${followHandle}` : '';
      lines.push(`- ${c.title}${tag}${followStr}${slots}\n  Claim: ${origin}/kol?campaignId=${encodeURIComponent(c.id)}&tab=CLAIM`);
    }
  }

  lines.push(`Explore all quests & claim via SIWE + GoPlus Anti-Sybil: ${origin}/kol`);
  return lines.join('\n');
}
