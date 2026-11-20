import { NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';

export const CANONICAL_PLANS = [
  {
    id: 'FREE',
    name: 'Free Degen',
    priceUsd: 0,
    monthlyPriceUsd: 0,
    priceEth: '0',
    monthlyCredits: 100,
    hasLiveTrading: false,
    hasCreatorAccess: false,
    hasAgentAccess: false,
    hasPriorityScrape: false,
    features: ['Paper Trading & 5-Agent Paper Sim', 'Basic Launchpad & KOL Bounty View'],
  },
  {
    id: 'CREATOR',
    name: 'Token Creator',
    priceUsd: 49,
    monthlyPriceUsd: 49,
    priceEth: '0.015',
    monthlyCredits: 2000,
    hasLiveTrading: false,
    hasCreatorAccess: true,
    hasAgentAccess: false,
    hasPriorityScrape: true,
    features: [
      'Token Launchpad Wizard (5 Modes)',
      'AI Creator Asset Studio & Growth Pack',
      'KOL Bounty Campaign Creation',
      '0.50% Creator Bonding Curve Fee Share',
    ],
  },
  {
    id: 'TRADER',
    name: 'Pro Terminal Trader',
    priceUsd: 79,
    monthlyPriceUsd: 79,
    priceEth: '0.025',
    monthlyCredits: 5000,
    hasLiveTrading: true,
    hasCreatorAccess: false,
    hasAgentAccess: false,
    hasPriorityScrape: true,
    features: [
      'Live Trading Terminal (DEX & CEX Single-Shot)',
      'MEV Slippage Guard (<= 3.0% Cap)',
      'Deterministic Risk Gate & Kill-Switch Protection',
    ],
  },
  {
    id: 'AGENT',
    name: 'AI Autonomous Desk',
    priceUsd: 149,
    monthlyPriceUsd: 149,
    priceEth: '0.045',
    monthlyCredits: 15000,
    hasLiveTrading: true,
    hasCreatorAccess: true,
    hasAgentAccess: true,
    hasPriorityScrape: true,
    features: [
      'Full Creator + Pro Trader Entitlements',
      '5-Agent Autonomous Trading Desk (BytePlus / Gemini)',
      'Arkham Wallet Profiling & Firecrawl Priority',
      'Daytona Strategy Sandbox & Backtester',
    ],
  },
];

export const dynamic = 'force-dynamic';

export async function GET() {
  const response: ApiResponse<typeof CANONICAL_PLANS> = {
    success: true,
    data: CANONICAL_PLANS,
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(response, { status: 200 });
}
