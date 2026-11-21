/**
 * packages/agent/skill-registry.ts
 *
 * Modular Non-Custodial Agent Skill Registry & 1-Click Action Card Builder.
 * - Complies strictly with AGENTS.md Rule 3 (Non-Custodial) & Rule 5 (Deterministic Risk Gate).
 * - Maps user-selected skills on a custom `agent_profiles` record into executable handoff cards.
 */

export type AgentSkillId =
  | 'SKILL_CEX_TRADE'
  | 'SKILL_TOKEN_DEPLOY'
  | 'SKILL_NFT_MINT'
  | 'SKILL_DEX_SWAP'
  | 'SKILL_SOCIAL_INTEL';

export type AgentRiskTolerance = 'LOW' | 'MODERATE' | 'HIGH' | 'DEGEN';
export type AgentStrategyProfileId = 'EARLY_SNIPER' | 'MOMENTUM_BREAKOUT' | 'DIP_ACCUMULATOR' | 'CONSERVATIVE_DCA';

export interface AgentSkillDefinition {
  id: AgentSkillId;
  name: string;
  description: string;
  executionRail: string;
  nonCustodialGuard: string;
  badgeColor: string;
}

export interface CustomAgentProfile {
  id: string;
  ownerId: string;
  name: string;
  strategyDescription: string;
  systemPrompt: string;
  riskToleranceLevel: AgentRiskTolerance;
  strategyProfile: AgentStrategyProfileId;
  enabledSkills: AgentSkillId[];
  targetSymbols: string[];
  status: 'IDLE' | 'ACTIVE' | 'PAUSED';
  createdAt: string;
  updatedAt: string;
}

export interface AgentActionCard {
  skillId: AgentSkillId;
  title: string;
  subtitle: string;
  href: string;
  badge: string;
}

export const AGENT_SKILL_CATALOG: Record<AgentSkillId, AgentSkillDefinition> = {
  SKILL_CEX_TRADE: {
    id: 'SKILL_CEX_TRADE',
    name: 'Binance CEX Spot Trade',
    description: 'Eksekusi spot order via akun Binance Trade-Only (No-Withdrawal + 24h Daily Loss Guard).',
    executionRail: '/trading (CEX_SINGLE_SHOT)',
    nonCustodialGuard: 'No-Withdrawal API Key + UserRiskPolicy',
    badgeColor: '#F59E0B',
  },
  SKILL_TOKEN_DEPLOY: {
    id: 'SKILL_TOKEN_DEPLOY',
    name: 'Bankr Token Deployer',
    description: 'Bangun narasi & logo IPFS lalu luncurkan token via Bankr BYOK Vault multi-chain.',
    executionRail: '/launchpad (Bankr BYOK)',
    nonCustodialGuard: 'Encrypted BYOK API Key + Chain Scope Isolation',
    badgeColor: '#38BDF8',
  },
  SKILL_NFT_MINT: {
    id: 'SKILL_NFT_MINT',
    name: 'NFT & Agent Pass Minting',
    description: 'Siapkan EIP-712 Mint Voucher untuk mint NFT / Agent Pass 1-klik langsung dari dompet user.',
    executionRail: '/kol (EIP-712 Mint Voucher)',
    nonCustodialGuard: 'Signed Voucher → 1-Klik User Wallet Mint',
    badgeColor: '#C084FC',
  },
  SKILL_DEX_SWAP: {
    id: 'SKILL_DEX_SWAP',
    name: 'MEV-Protected DEX Swap',
    description: 'Susun swap DEX terproteksi MEV Slippage Guard untuk 1-klik tanda tangan di MetaMask / Binance Web3 Wallet.',
    executionRail: '/trading (DEX_NON_CUSTODIAL)',
    nonCustodialGuard: 'Zero Private Key Custody · User Signs On-Chain',
    badgeColor: '#10B981',
  },
  SKILL_SOCIAL_INTEL: {
    id: 'SKILL_SOCIAL_INTEL',
    name: 'Social & Whale Intelligence',
    description: 'Pantau sentimen web (Firecrawl), profil dompet whale (Arkham), dan peluang bounty KOL.',
    executionRail: '/kol & /agent (Advisory)',
    nonCustodialGuard: 'Read-Only Quantitative Intelligence',
    badgeColor: '#60A5FA',
  },
};

export const VALID_AGENT_SKILLS = new Set<AgentSkillId>(Object.keys(AGENT_SKILL_CATALOG) as AgentSkillId[]);
export const VALID_RISK_LEVELS = new Set<AgentRiskTolerance>(['LOW', 'MODERATE', 'HIGH', 'DEGEN']);
export const VALID_STRATEGIES = new Set<AgentStrategyProfileId>([
  'EARLY_SNIPER',
  'MOMENTUM_BREAKOUT',
  'DIP_ACCUMULATOR',
  'CONSERVATIVE_DCA',
]);

export function validateAgentSkills(rawSkills: unknown): AgentSkillId[] {
  if (!Array.isArray(rawSkills) || rawSkills.length === 0) {
    return ['SKILL_CEX_TRADE', 'SKILL_DEX_SWAP'];
  }
  const clean: AgentSkillId[] = [];
  for (const item of rawSkills) {
    const id = String(item || '').trim().toUpperCase() as AgentSkillId;
    if (VALID_AGENT_SKILLS.has(id) && !clean.includes(id)) {
      clean.push(id);
    }
  }
  if (clean.length === 0) {
    throw new Error('INVALID_AGENT_SKILLS: Provide at least one valid modular agent skill.');
  }
  return clean;
}

export function buildAgentActionCards(params: {
  skills: AgentSkillId[];
  symbol: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  agentName?: string;
}): AgentActionCard[] {
  const cleanSymbol = (params.symbol || 'BTCUSDT').trim().toUpperCase();
  const baseTicker = (cleanSymbol.replace(/USDT|USD|WETH|ETH|\//gi, '') || cleanSymbol).slice(0, 8);
  const cards: AgentActionCard[] = [];

  if (params.skills.includes('SKILL_CEX_TRADE')) {
    cards.push({
      skillId: 'SKILL_CEX_TRADE',
      title: `⚡ Execute ${params.action} ${cleanSymbol} via Binance CEX`,
      subtitle: 'Trade-Only No-Withdrawal Vault + Personal 24h Risk Guard',
      href: `/trading?symbol=${encodeURIComponent(cleanSymbol)}&side=${encodeURIComponent(params.action)}&qty=${encodeURIComponent(String(params.quantity))}&mode=CEX_SINGLE_SHOT`,
      badge: 'BINANCE CEX',
    });
  }

  if (params.skills.includes('SKILL_DEX_SWAP')) {
    cards.push({
      skillId: 'SKILL_DEX_SWAP',
      title: `🛡️ Non-Custodial DEX Swap (${cleanSymbol})`,
      subtitle: 'MEV Slippage Guard → 1-Klik Sign di MetaMask / Binance Web3 Wallet',
      href: `/trading?symbol=${encodeURIComponent(cleanSymbol)}&side=${encodeURIComponent(params.action)}&qty=${encodeURIComponent(String(params.quantity))}&mode=DEX_NON_CUSTODIAL`,
      badge: 'DEX MEV-SAFE',
    });
  }

  if (params.skills.includes('SKILL_TOKEN_DEPLOY')) {
    cards.push({
      skillId: 'SKILL_TOKEN_DEPLOY',
      title: `🚀 Deploy $${baseTicker} Narrative via Bankr Vault`,
      subtitle: 'Auto-fill Launch Token Draft Wizard + BYOK Multi-Chain Scope',
      href: `/launchpad?name=${encodeURIComponent(params.agentName ? `${params.agentName} Token` : baseTicker)}&symbol=${encodeURIComponent(baseTicker)}`,
      badge: 'BANKR DEPLOY',
    });
  }

  if (params.skills.includes('SKILL_NFT_MINT')) {
    cards.push({
      skillId: 'SKILL_NFT_MINT',
      title: `🎨 Mint Agent NFT Pass (EIP-712 Voucher)`,
      subtitle: 'Non-Custodial Gas-Efficient Minting via KOL & GameFi Hub',
      href: '/kol',
      badge: 'NFT MINT',
    });
  }

  if (params.skills.includes('SKILL_SOCIAL_INTEL')) {
    cards.push({
      skillId: 'SKILL_SOCIAL_INTEL',
      title: `🔍 Buka KOL & Social Intelligence Hub`,
      subtitle: 'Pantau kampanye bounty, trust score, dan sentimen pasar',
      href: '/kol',
      badge: 'SOCIAL INTEL',
    });
  }

  return cards;
}
