import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  AGENT_SKILL_CATALOG,
  validateAgentSkills,
  buildAgentActionCards,
} from '../packages/agent/skill-registry';
import { SubscriptionsEngine } from '../packages/billing/subscriptions-engine';
import { PostgresCustomAgentAdapter } from '../packages/shared/db-pool';
import {
  GET as getAgents,
  POST as postAgents,
  PATCH as patchAgents,
  DELETE as deleteAgents,
} from '../app/api/agent/profiles/route';

describe('Phase X1–X4: Custom AI Agent Builder & Modular Skill Registry', () => {
  it('[X2.1] Skill catalog & action card builder support all 5 non-custodial skills (including NFT Mint & Bankr Deploy)', () => {
    expect(Object.keys(AGENT_SKILL_CATALOG).length).toBe(5);
    const validated = validateAgentSkills([
      'SKILL_CEX_TRADE',
      'SKILL_TOKEN_DEPLOY',
      'SKILL_NFT_MINT',
      'SKILL_DEX_SWAP',
      'SKILL_SOCIAL_INTEL',
      'UNKNOWN_SKILL',
    ]);
    expect(validated.length).toBe(5);

    const cards = buildAgentActionCards({
      skills: validated,
      symbol: 'ETHUSDT',
      action: 'BUY',
      quantity: 0.5,
      agentName: 'Alpha Muse',
    });
    expect(cards.length).toBe(5);
    expect(cards.find((c) => c.skillId === 'SKILL_CEX_TRADE')?.href).toContain('mode=CEX_SINGLE_SHOT');
    expect(cards.find((c) => c.skillId === 'SKILL_TOKEN_DEPLOY')?.href).toContain('/launchpad?');
    expect(cards.find((c) => c.skillId === 'SKILL_NFT_MINT')?.href).toBe('/kol');
    expect(cards.find((c) => c.skillId === 'SKILL_DEX_SWAP')?.href).toContain('mode=DEX_NON_CUSTODIAL');
  });

  it('[X2.2] Billing tier SSOT defines maxCustomAgents across all 4 tiers', () => {
    expect(SubscriptionsEngine.getPlanCapacities('FREE').maxCustomAgents).toBe(1);
    expect(SubscriptionsEngine.getPlanCapacities('CREATOR').maxCustomAgents).toBe(3);
    expect(SubscriptionsEngine.getPlanCapacities('TRADER').maxCustomAgents).toBe(5);
    expect(SubscriptionsEngine.getPlanCapacities('AGENT').maxCustomAgents).toBe(15);
  });

  it('[X2.3] Custom agent CRUD enforces per-user ownership isolation & tier capacity ceiling', async () => {
    const adapter = new PostgresCustomAgentAdapter();
    const userA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const userB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const created = await adapter.createUserAgent({
      userIdentifier: userA,
      name: 'Muse Sniper Bot',
      systemPrompt: 'Detect volume breakouts on Base and mint agent pass if score > 80.',
      strategyProfile: 'EARLY_SNIPER',
      riskToleranceLevel: 'HIGH',
      enabledSkills: ['SKILL_CEX_TRADE', 'SKILL_NFT_MINT'],
      targetSymbols: ['ETHUSDT', 'SOLUSDT'],
      maxAllowed: 1, // FREE tier limit
    });
    expect(created.name).toBe('Muse Sniper Bot');
    expect(created.enabledSkills).toEqual(['SKILL_CEX_TRADE', 'SKILL_NFT_MINT']);

    // Exceeding tier limit rejected
    await expect(
      adapter.createUserAgent({
        userIdentifier: userA,
        name: 'Second Agent',
        systemPrompt: 'Second custom strategy prompt exceeding free cap.',
        maxAllowed: 1,
      })
    ).rejects.toThrow(/MAX_AGENTS_REACHED/);

    // User B cannot view, pause, or delete User A's agent
    expect(await adapter.getUserAgentById(userB, created.id)).toBeNull();
    expect(await adapter.updateUserAgentStatus(userB, created.id, 'PAUSED')).toBe(false);
    expect(await adapter.deleteUserAgent(userB, created.id)).toBe(false);

    // Owner can pause & delete
    expect(await adapter.updateUserAgentStatus(userA, created.id, 'PAUSED')).toBe(true);
    expect(await adapter.deleteUserAgent(userA, created.id)).toBe(true);
  });

  it('[X2.4] GET/POST/PATCH/DELETE /api/agent/profiles fail closed (401) without SIWE session', async () => {
    expect((await getAgents(new NextRequest('http://localhost/api/agent/profiles', { method: 'GET' }))).status).toBe(401);
    expect(
      (
        await postAgents(
          new NextRequest('http://localhost/api/agent/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Test', systemPrompt: 'Long enough prompt here' }),
          })
        )
      ).status
    ).toBe(401);
    expect(
      (
        await patchAgents(
          new NextRequest('http://localhost/api/agent/profiles', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: '00000000-0000-0000-0000-000000000001', status: 'PAUSED' }),
          })
        )
      ).status
    ).toBe(401);
    expect(
      (
        await deleteAgents(
          new NextRequest('http://localhost/api/agent/profiles?agentId=00000000-0000-0000-0000-000000000001', {
            method: 'DELETE',
          })
        )
      ).status
    ).toBe(401);
  });
});
