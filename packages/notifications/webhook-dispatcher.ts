/**
 * packages/notifications/webhook-dispatcher.ts
 *
 * Stateless, SSRF-Safe Outbound Alert & Webhook Dispatcher (Discord / Telegram / Custom HTTPS).
 * - Strictly rejects non-HTTPS URLs, localhost, loopback, link-local (169.254.*), and RFC-1918 private IPs.
 * - Enforces 4s hard timeout and never blocks core trading/launchpad transactions.
 */

export type AlertEventType =
  | 'ORDER_APPROVED'
  | 'DAILY_LOSS_WARNING'
  | 'TOKEN_DEPLOYED'
  | 'KEY_FROZEN_OVER_QUOTA';

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

/**
 * Dispatches an outbound alert to a validated HTTPS webhook (auto-formats for Discord or generic JSON).
 */
export async function dispatchOutboundAlert(params: {
  webhookUrl: string;
  payload: OutboundAlertPayload;
  fetchImpl?: typeof fetch;
}): Promise<{ delivered: boolean; statusCode?: number; error?: string }> {
  const safeUrl = assertSafeWebhookUrl(params.webhookUrl);
  const doFetch = params.fetchImpl || fetch;
  const ts = params.payload.timestamp || new Date().toISOString();

  const isDiscord = safeUrl.includes('discord.com/api/webhooks/') || safeUrl.includes('discordapp.com/api/webhooks/');
  const body = isDiscord
    ? {
        content: `**[POOLNET · ${params.payload.event}] ${params.payload.title}**\n${params.payload.message}`,
      }
    : {
        source: 'POOLNET_V25',
        event: params.payload.event,
        title: params.payload.title,
        message: params.payload.message,
        metadata: params.payload.metadata || {},
        timestamp: ts,
      };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let res: Response;
    try {
      res = await doFetch(safeUrl, {
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
