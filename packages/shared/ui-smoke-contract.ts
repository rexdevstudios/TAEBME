/**
 * packages/shared/ui-smoke-contract.ts
 *
 * Zero-dependency, deterministic UI & CEX Tab Navigation Smoke Contract (Phase CL).
 * Audits rendered HTML of all 6 core CEX Launchpad routes for:
 *  - Zero Next.js error boundaries / fatal client-side exception fallbacks
 *  - Responsive viewport meta tag presence
 *  - Unified CEX HeaderNav & all 6 canonical navigation links
 *  - Expected role="tablist" & minimum role="tab" / cex-tab-btn counts on tabbed pages
 */

export interface UiRouteSmokeContract {
  path: string;
  label: string;
  requiresTabList: boolean;
  minTabs: number;
  requiredMarkers: string[];
}

export const CEX_CANONICAL_NAV_LABELS = [
  'Overview',
  'Launchpad',
  'Trade',
  'AI Auto-Pilot',
  'Earn &amp; KOL',
  'Account',
] as const;

export const CEX_UI_ROUTE_CONTRACTS: readonly UiRouteSmokeContract[] = [
  {
    path: '/',
    label: 'Overview / CEX Launchpad Home',
    requiresTabList: false,
    minTabs: 0,
    requiredMarkers: ['POOLNET'],
  },
  {
    path: '/launchpad',
    label: 'Token Launchpad & Live Pools',
    requiresTabList: true,
    minTabs: 3,
    requiredMarkers: ['Token Launchpad', 'Live Pools'],
  },
  {
    path: '/trading',
    label: 'Spot & DEX Trading Terminal',
    requiresTabList: true,
    minTabs: 3,
    requiredMarkers: ['Trading Terminal', 'Trade Terminal'],
  },
  {
    path: '/agent',
    label: 'AI Auto-Pilot & 5-Agent Desk',
    requiresTabList: true,
    minTabs: 3,
    requiredMarkers: ['AI Auto-Pilot', '5-Agent'],
  },
  {
    path: '/kol',
    label: 'Earn & KOL Bounties Hub',
    requiresTabList: true,
    minTabs: 4,
    requiredMarkers: ['KOL Hub', 'Active Bounties'],
  },
  {
    path: '/billing',
    label: 'Account, Plans & Telegram Alerts',
    requiresTabList: true,
    minTabs: 3,
    requiredMarkers: ['Paket Layanan', 'Paket &amp; Harga'],
  },
] as const;

const FATAL_NEXT_ERROR_PATTERNS = [
  /__next_error__/i,
  /NEXT_HTTP_ERROR_FALLBACK/i,
  /Application error:\s*a client-side exception/i,
];

export interface UiPageAuditResult {
  path: string;
  ok: boolean;
  tabCount: number;
  hasTabList: boolean;
  hasViewportMeta: boolean;
  hasHeaderNav: boolean;
  missingNavLabels: string[];
  missingMarkers: string[];
  fatalErrors: string[];
  reasons: string[];
}

/**
 * Extracts linked Next.js CSS stylesheet paths (/_next/static/css/...) from rendered HTML.
 */
export function extractStylesheetPaths(html: string): string[] {
  const matches = new Set<string>();
  const re = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']stylesheet["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] || m[2] || '').trim();
    if (href) matches.add(href);
  }
  return Array.from(matches);
}

/**
 * Pure HTML audit against a UiRouteSmokeContract.
 */
export function auditRenderedPageHtml(
  contract: UiRouteSmokeContract,
  html: string
): UiPageAuditResult {
  const source = String(html || '');
  const reasons: string[] = [];

  if (source.trim().length < 200) {
    reasons.push(`Rendered HTML too short (${source.trim().length} bytes)`);
  }

  const fatalErrors: string[] = [];
  for (const re of FATAL_NEXT_ERROR_PATTERNS) {
    if (re.test(source)) {
      fatalErrors.push(re.source);
    }
  }
  if (fatalErrors.length > 0) {
    reasons.push(`Fatal Next.js error boundary detected: ${fatalErrors.join(', ')}`);
  }

  const hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(source);
  if (!hasViewportMeta) {
    reasons.push('Missing <meta name="viewport"> responsive tag');
  }

  const hasHeaderNav = /class=["'][^"']*header-nav[^"']*["']/i.test(source);
  if (!hasHeaderNav) {
    reasons.push('Missing <header class="header-nav">');
  }

  const missingNavLabels: string[] = [];
  for (const label of CEX_CANONICAL_NAV_LABELS) {
    const plain = label.replace(/&amp;/g, '&');
    if (!source.includes(label) && !source.includes(plain)) {
      missingNavLabels.push(plain);
    }
  }
  if (missingNavLabels.length > 0) {
    reasons.push(`Missing canonical CEX nav links: ${missingNavLabels.join(', ')}`);
  }

  const hasTabList = /role=["']tablist["']/i.test(source);
  const tabMatches = source.match(/role=["']tab["']/gi) || [];
  const tabCount = tabMatches.length;

  if (contract.requiresTabList) {
    if (!hasTabList) {
      reasons.push(`Missing role="tablist" on ${contract.path}`);
    }
    if (tabCount < contract.minTabs) {
      reasons.push(`Expected >= ${contract.minTabs} role="tab" buttons on ${contract.path}, found ${tabCount}`);
    }
  }

  const missingMarkers: string[] = [];
  for (const marker of contract.requiredMarkers) {
    const plain = marker.replace(/&amp;/g, '&');
    if (!source.includes(marker) && !source.includes(plain)) {
      missingMarkers.push(plain);
    }
  }
  if (missingMarkers.length > 0) {
    reasons.push(`Missing expected page markers: ${missingMarkers.join(', ')}`);
  }

  return {
    path: contract.path,
    ok: reasons.length === 0,
    tabCount,
    hasTabList,
    hasViewportMeta,
    hasHeaderNav,
    missingNavLabels,
    missingMarkers,
    fatalErrors,
    reasons,
  };
}
