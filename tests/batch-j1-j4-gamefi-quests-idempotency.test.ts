import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { GameFiService, computePassTier, getUtcDailyQuestKey } from '../packages/gamefi/gamefi-service';
import { PostgresGameFiDbAdapter } from '../packages/shared/db-pool';
import * as sessionMod from '../packages/auth/session';
import { GET as getGameFiProfile } from '../app/api/gamefi/profile/route';

describe('Phase J1–J4 — GameFi Quest Idempotency, Daily Check-In UTC & Pass Tier Progression', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('WB-GF-01 — connect_siwe is strictly idempotent under parallel double-claim (zero double XP)', async () => {
    const adapter = new PostgresGameFiDbAdapter();
    const service = new GameFiService(adapter);
    const uid = `usr-gf-idem-${Date.now()}`;
    const wallet = '0x000000000000000000000000000000000000a111';

    const [r1, r2] = await Promise.allSettled([
      service.verifyAndCompleteQuest({ userId: uid, walletAddress: wallet, questId: 'connect_siwe' }),
      service.verifyAndCompleteQuest({ userId: uid, walletAddress: wallet, questId: 'connect_siwe' }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason?.message).toContain('QUEST_ALREADY_COMPLETED');

    const okVal = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(okVal.profile.xp).toBe(100);
    expect(okVal.profile.completedQuests).toContain('connect_siwe');
    expect(okVal.creditsGranted).toBe(10);
  });

  it('WB-GF-02 — ignores spoofed client-supplied conditions for verify_sybil (fail-closed)', async () => {
    const adapter = new PostgresGameFiDbAdapter();
    spies.push(spyOn(adapter, 'hasSybilEvidence').mockResolvedValue(false));
    const service = new GameFiService(adapter);

    let errMsg = '';
    try {
      await service.verifyAndCompleteQuest({
        userId: `usr-gf-spoof-${Date.now()}`,
        walletAddress: '0x000000000000000000000000000000000000b222',
        questId: 'verify_sybil',
        conditions: { isSybilVerified: true },
      });
    } catch (e: any) {
      errMsg = e?.message || '';
    }
    expect(errMsg).toContain('QUEST_CONDITIONS_NOT_MET');
  });

  it('WB-GF-03 — daily_checkin is idempotent per UTC day and re-unlocks on the next UTC day', async () => {
    const adapter = new PostgresGameFiDbAdapter();
    const service = new GameFiService(adapter);
    const uid = `usr-gf-daily-${Date.now()}`;
    const wallet = '0x000000000000000000000000000000000000c333';

    const day1 = new Date('2026-11-21T10:00:00Z');
    const day2 = new Date('2026-11-22T00:05:00Z');

    const first = await service.verifyAndCompleteQuest({ userId: uid, walletAddress: wallet, questId: 'daily_checkin', now: day1 });
    expect(first.profile.xp).toBe(25);
    expect(first.creditsGranted).toBe(5);
    expect(first.profile.dailyCheckInAvailable).toBe(false);
    expect(first.profile.completedQuests).toContain(getUtcDailyQuestKey(day1));

    // Same UTC day must reject
    let dupErr = '';
    try {
      await service.verifyAndCompleteQuest({ userId: uid, walletAddress: wallet, questId: 'daily_checkin', now: day1 });
    } catch (e: any) {
      dupErr = e?.message || '';
    }
    expect(dupErr).toContain('QUEST_ALREADY_COMPLETED');

    // Next UTC day succeeds cleanly
    const second = await service.verifyAndCompleteQuest({ userId: uid, walletAddress: wallet, questId: 'daily_checkin', now: day2 });
    expect(second.profile.xp).toBe(50);
    expect(second.profile.completedQuests).toContain(getUtcDailyQuestKey(day2));
  });

  it('WB-GF-04 — computePassTier maps XP deterministically to BRONZE, SILVER, and GOLD', () => {
    expect(computePassTier(0)).toBe('BRONZE');
    expect(computePassTier(249)).toBe('BRONZE');
    expect(computePassTier(250)).toBe('SILVER');
    expect(computePassTier(499)).toBe('SILVER');
    expect(computePassTier(500)).toBe('GOLD');
    expect(computePassTier(850)).toBe('GOLD');
  });

  it('WB-GF-05 — GET /api/gamefi/profile returns completedQuests, passTier, and dailyCheckInAvailable', async () => {
    spies.push(
      spyOn(sessionMod, 'authenticateSession').mockResolvedValue({
        user: { userId: `usr-gf-prof-${Date.now()}`, roles: ['TRADER'], status: 'ACTIVE' },
        walletAddress: '0x000000000000000000000000000000000000d444',
        token: 'mock-token',
        issuedAt: Date.now(),
      })
    );
    const req = new NextRequest('http://localhost:3000/api/gamefi/profile');
    const res = await getGameFiProfile(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.profile.completedQuests)).toBe(true);
    expect(['BRONZE', 'SILVER', 'GOLD']).toContain(json.profile.passTier);
    expect(typeof json.profile.dailyCheckInAvailable).toBe('boolean');
  });
});
