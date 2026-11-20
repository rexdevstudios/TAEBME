/**
 * packages/launchpad/growth-launch-pack.ts
 *
 * Stateless, Vercel-compatible Growth Launch Pack generator lifted from legacy src/modules/growth/
 * (social-card-generator, dexscreener-profiler, geckoterminal-profiler).
 *
 * Invariants (AGENTS.md):
 * - Zero src/ imports, zero disk I/O (fs), zero private keys.
 * - XML/SVG escaping applied to all user-provided strings (XSS-safe).
 */

export interface SocialCardInput {
  name: string;
  ticker: string;
  contractAddress: string;
  chainDisplayName: string;
  primaryColor?: string;
  secondaryColor?: string;
  buyTax?: string;
  sellTax?: string;
  safetyScore?: number;
  buybackPct?: number;
  dividendPct?: number;
  jackpotPct?: number;
}

export interface GrowthPackInput {
  chainId: string | number;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  poolAddress?: string;
  description?: string;
  iconUrl?: string;
  headerUrl?: string;
  websiteUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  discordUrl?: string;
  safetyScore?: number;
}

export interface DexScreenerLinkItem {
  type: 'website' | 'twitter' | 'telegram' | 'discord' | 'docs';
  label?: string;
  url: string;
}

export interface DexScreenerProfilePayload {
  chainId: string;
  tokenAddress: string;
  url: string;
  icon?: string;
  header?: string;
  description: string;
  links: DexScreenerLinkItem[];
  updatePortalUrl: string;
  orderUrl: string;
  generatedAt: string;
}

export interface GeckoTerminalProfilePayload {
  network: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  poolAddress?: string;
  poolUrl?: string;
  tokenUrl: string;
  updatePortalUrl: string;
  description: string;
  iconUrl?: string;
  links: {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
    explorer?: string;
  };
  security: {
    buyTax: string;
    sellTax: string;
    lpStatus: string;
    honeypot: boolean;
  };
  generatedAt: string;
}

export interface GrowthLaunchPackResult {
  socialCardSvg: string;
  socialCardDataUri: string;
  dexScreener: DexScreenerProfilePayload;
  geckoTerminal: GeckoTerminalProfilePayload;
  explorerUpdateUrl: string;
}

function escapeXml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeHexColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  return /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : fallback;
}

export function normalizeGrowthChain(chain: string | number): string {
  const str = String(chain).trim().toLowerCase();
  if (str === '8453' || str === '84532' || str.startsWith('base')) return 'base';
  if (str === '101' || str.startsWith('sol')) return 'solana';
  if (str === '46688' || str === '4663' || str.startsWith('robinhood')) return 'robinhood';
  if (str === '42161' || str.startsWith('arb')) return 'arbitrum';
  if (str === '5042' || str.startsWith('arc')) return 'arc';
  if (str === '1' || str === 'ethereum' || str === 'eth') return 'ethereum';
  if (str === '56' || str === 'bsc' || str === 'binance') return 'bsc';
  return str || 'base';
}

export function getExplorerTokenUpdateUrl(chain: string | number, tokenAddress: string): string {
  const norm = normalizeGrowthChain(chain);
  const addr = tokenAddress.trim();
  if (norm === 'base') return `https://basescan.org/tokenupdate/${addr}`;
  if (norm === 'solana') return `https://solscan.io/token/${addr}`;
  if (norm === 'arbitrum') return `https://arbiscan.io/tokenupdate/${addr}`;
  if (norm === 'robinhood') return `https://robinhoodchain.blockscout.com/token/${addr}`;
  if (norm === 'arc') return `https://arcscan.app/token/${addr}`;
  return `https://blockscout.com/token/${addr}`;
}

export function generateSocialCardSvg(input: SocialCardInput): string {
  const ticker = escapeXml(input.ticker.replace(/^\$/, '').toUpperCase().slice(0, 12));
  const name = escapeXml(input.name.trim().slice(0, 36));
  const ca = escapeXml(input.contractAddress.trim().slice(0, 66));
  const primaryColor = sanitizeHexColor(input.primaryColor, '#00ff66');
  const secondaryColor = sanitizeHexColor(input.secondaryColor, '#00ccff');
  const chainName = escapeXml((input.chainDisplayName || 'Base Mainnet L2').toUpperCase().slice(0, 24));
  const buyTax = escapeXml((input.buyTax || '0%').slice(0, 8));
  const sellTax = escapeXml((input.sellTax || '0%').slice(0, 8));
  const score = Math.max(0, Math.min(100, Math.round(input.safetyScore ?? 100)));
  const buyback = Math.max(0, Math.min(100, Math.round(input.buybackPct ?? 30)));
  const dividend = Math.max(0, Math.min(100, Math.round(input.dividendPct ?? 20)));
  const jackpot = Math.max(0, Math.min(100, Math.round(input.jackpotPct ?? 15)));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" style="background:#030712; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <defs>
    <radialGradient id="bgGlow" cx="20%" cy="20%" r="80%">
      <stop offset="0%" stop-color="${primaryColor}" stop-opacity="0.18" />
      <stop offset="50%" stop-color="${secondaryColor}" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#030712" stop-opacity="1" />
    </radialGradient>
    <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${primaryColor}" />
      <stop offset="100%" stop-color="${secondaryColor}" />
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1f2937" stroke-width="0.75" stroke-opacity="0.4" />
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="#030712" />
  <rect width="1200" height="630" fill="url(#bgGlow)" />
  <rect width="1200" height="630" fill="url(#grid)" />
  <rect x="20" y="20" width="1160" height="590" rx="24" fill="none" stroke="#1f2937" stroke-width="2" stroke-opacity="0.8" />
  <g transform="translate(60, 60)">
    <rect width="230" height="38" rx="19" fill="#111827" stroke="#374151" stroke-width="1.5" />
    <circle cx="20" cy="19" r="6" fill="#10b981" />
    <text x="36" y="24" fill="#9ca3af" font-size="14" font-weight="600" letter-spacing="0.5">${chainName}</text>
  </g>
  <g transform="translate(930, 60)">
    <rect width="210" height="38" rx="19" fill="rgba(16, 185, 129, 0.15)" stroke="#10b981" stroke-width="1.5" />
    <text x="105" y="24" text-anchor="middle" fill="#10b981" font-size="14" font-weight="800">AUDIT ${score}/100 SAFE</text>
  </g>
  <g transform="translate(60, 150)">
    <text x="0" y="70" fill="url(#brandGrad)" font-size="78" font-weight="900" letter-spacing="-1.5">$${ticker}</text>
    <text x="0" y="125" fill="#f3f4f6" font-size="34" font-weight="800">${name}</text>
    <text x="0" y="165" fill="#9ca3af" font-size="18" font-weight="400">RTrader SocialFi Launchpad • Bonding Curve &amp; Verified Bounties</text>
    <g transform="translate(0, 205)">
      <rect width="540" height="52" rx="14" fill="#090d16" stroke="#1f2937" stroke-width="1.5" />
      <text x="16" y="32" fill="#6b7280" font-size="13" font-family="monospace">CA:</text>
      <text x="45" y="32" fill="#e5e7eb" font-size="13" font-family="monospace" font-weight="600">${ca}</text>
    </g>
  </g>
  <g transform="translate(640, 150)">
    <g transform="translate(0, 0)">
      <rect width="235" height="120" rx="16" fill="#090d16" stroke="#1f2937" stroke-width="1.5" />
      <text x="24" y="52" fill="#10b981" font-size="36" font-weight="900">${buyTax} / ${sellTax}</text>
      <text x="24" y="82" fill="#ffffff" font-size="15" font-weight="700">Zero Trading Tax</text>
      <text x="24" y="102" fill="#6b7280" font-size="12">100% Fair Launch</text>
    </g>
    <g transform="translate(265, 0)">
      <rect width="235" height="120" rx="16" fill="#090d16" stroke="#1f2937" stroke-width="1.5" />
      <text x="24" y="52" fill="${primaryColor}" font-size="36" font-weight="900">${buyback}%</text>
      <text x="24" y="82" fill="#ffffff" font-size="15" font-weight="700">Auto Buyback &amp; Burn</text>
      <text x="24" y="102" fill="#6b7280" font-size="12">Perpetual Deflation</text>
    </g>
    <g transform="translate(0, 145)">
      <rect width="235" height="120" rx="16" fill="#090d16" stroke="#1f2937" stroke-width="1.5" />
      <text x="24" y="52" fill="${secondaryColor}" font-size="36" font-weight="900">${dividend}%</text>
      <text x="24" y="82" fill="#ffffff" font-size="15" font-weight="700">Passive Dividends</text>
      <text x="24" y="102" fill="#6b7280" font-size="12">Direct Holder Airdrops</text>
    </g>
    <g transform="translate(265, 145)">
      <rect width="235" height="120" rx="16" fill="#090d16" stroke="#1f2937" stroke-width="1.5" />
      <text x="24" y="52" fill="#f59e0b" font-size="36" font-weight="900">${jackpot}%</text>
      <text x="24" y="82" fill="#ffffff" font-size="15" font-weight="700">KOL Bounty Pool</text>
      <text x="24" y="102" fill="#6b7280" font-size="12">Merkle-Verified Rewards</text>
    </g>
  </g>
  <g transform="translate(60, 560)">
    <circle cx="6" cy="-4" r="5" fill="${primaryColor}" />
    <text x="24" y="0" fill="#6b7280" font-size="14" font-weight="500">RTrader Launchpad • Audited Bonding Curve • LP Locked &amp; Verified</text>
  </g>
</svg>`;
}

export function buildDexScreenerProfilePayload(input: GrowthPackInput): DexScreenerProfilePayload {
  const chainId = normalizeGrowthChain(input.chainId);
  const tokenAddress = input.tokenAddress.trim();
  const ticker = input.tokenSymbol.replace(/^\$/, '').toUpperCase();
  const websiteUrl = input.websiteUrl || `https://pndigi.site/launchpad?token=${tokenAddress}`;

  const links: DexScreenerLinkItem[] = [{ type: 'website', label: 'Official Website', url: websiteUrl }];
  if (input.twitterUrl) links.push({ type: 'twitter', label: 'Twitter', url: input.twitterUrl });
  if (input.telegramUrl) links.push({ type: 'telegram', label: 'Telegram Portal', url: input.telegramUrl });
  if (input.discordUrl) links.push({ type: 'discord', label: 'Discord', url: input.discordUrl });

  return {
    chainId,
    tokenAddress,
    url: websiteUrl,
    icon: input.iconUrl,
    header: input.headerUrl,
    description:
      input.description ||
      `${input.tokenName} ($${ticker}) — Audited Bonding Curve & SocialFi Token on ${chainId.toUpperCase()}.`,
    links,
    updatePortalUrl: `https://dexscreener.com/${chainId}/${tokenAddress}`,
    orderUrl: `https://marketplace.dexscreener.com/product/token-info/order?chainId=${chainId}&tokenAddress=${tokenAddress}`,
    generatedAt: new Date().toISOString(),
  };
}

export function buildGeckoTerminalProfilePayload(input: GrowthPackInput): GeckoTerminalProfilePayload {
  const network = normalizeGrowthChain(input.chainId);
  const geckoNet = network === 'ethereum' ? 'eth' : network;
  const tokenAddress = input.tokenAddress.trim();
  const ticker = input.tokenSymbol.replace(/^\$/, '').toUpperCase();
  const websiteUrl = input.websiteUrl || `https://pndigi.site/launchpad?token=${tokenAddress}`;

  return {
    network: geckoNet,
    tokenAddress,
    tokenName: input.tokenName.trim(),
    tokenSymbol: ticker,
    poolAddress: input.poolAddress,
    poolUrl: input.poolAddress
      ? `https://www.geckoterminal.com/${geckoNet}/pools/${input.poolAddress}`
      : undefined,
    tokenUrl: `https://www.geckoterminal.com/${geckoNet}/tokens/${tokenAddress}`,
    updatePortalUrl: 'https://support.coingecko.com/hc/en-us/requests/new?ticket_form_id=360000025353',
    description:
      input.description ||
      `${input.tokenName} ($${ticker}) — Audited Bonding Curve & SocialFi Token on ${geckoNet.toUpperCase()}.`,
    iconUrl: input.iconUrl,
    links: {
      website: websiteUrl,
      twitter: input.twitterUrl,
      telegram: input.telegramUrl,
      discord: input.discordUrl,
      explorer: getExplorerTokenUpdateUrl(geckoNet, tokenAddress),
    },
    security: {
      buyTax: '0%',
      sellTax: '0%',
      lpStatus: 'Locked via BondingCurveLaunchpad',
      honeypot: false,
    },
    generatedAt: new Date().toISOString(),
  };
}

export function buildGrowthLaunchPack(input: GrowthPackInput): GrowthLaunchPackResult {
  const normChain = normalizeGrowthChain(input.chainId);
  const socialCardSvg = generateSocialCardSvg({
    name: input.tokenName,
    ticker: input.tokenSymbol,
    contractAddress: input.tokenAddress,
    chainDisplayName: normChain.toUpperCase(),
    safetyScore: input.safetyScore ?? 100,
  });

  const socialCardDataUri = `data:image/svg+xml;base64,${Buffer.from(socialCardSvg, 'utf8').toString('base64')}`;

  return {
    socialCardSvg,
    socialCardDataUri,
    dexScreener: buildDexScreenerProfilePayload(input),
    geckoTerminal: buildGeckoTerminalProfilePayload(input),
    explorerUpdateUrl: getExplorerTokenUpdateUrl(normChain, input.tokenAddress),
  };
}
