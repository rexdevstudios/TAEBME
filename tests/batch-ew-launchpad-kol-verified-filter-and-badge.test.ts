import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { filterAndSortLaunchTokens } from '../packages/shared/launchpad-discovery';

describe('Batch EW — Launchpad KOL Verified (Blue Check) Filter & Creator Reputation Badge', () => {
  const root = process.cwd();

  it('1. filterAndSortLaunchTokens filters strictly by onlyKolVerified and matches @creatorKolHandle search', () => {
    const tokens = [
      {
        contractAddress: '0xa5f832390447b050955d7b734a9a2fa861b4d3ab',
        chain: 'robinhood',
        name: 'Noir Protocol',
        ticker: 'NOIR',
        creatorKolVerified: true,
        creatorKolHandle: 'persister_kol',
        creatorTrustScore: 88,
      },
      {
        contractAddress: '0x814620255bf422d45c0f8abf7ad89f40a1cbca4a',
        chain: 'base',
        name: 'PumpRun',
        ticker: 'PUMPRUN',
        creatorKolVerified: false,
        creatorKolHandle: null,
        creatorTrustScore: null,
      },
    ];

    const verifiedOnly = filterAndSortLaunchTokens(tokens, { onlyKolVerified: true });
    expect(verifiedOnly).toHaveLength(1);
    expect(verifiedOnly[0].ticker).toBe('NOIR');

    const byHandle = filterAndSortLaunchTokens(tokens, { search: '@persister_kol' });
    expect(byHandle).toHaveLength(1);
    expect(byHandle[0].ticker).toBe('NOIR');
  });

  it('2. launch-draft-repo joins kol_profiles and app/launchpad/page.tsx renders KOL Verified pill & badge', () => {
    const repoSrc = fs.readFileSync(path.join(root, 'packages', 'db', 'launch-draft-repo.ts'), 'utf8');
    const pageSrc = fs.readFileSync(path.join(root, 'app', 'launchpad', 'page.tsx'), 'utf8');

    expect(repoSrc).toContain('LEFT JOIN kol_profiles kp ON kp.user_id = ld.creator_id');
    expect(repoSrc).toContain('creatorKolVerified: Boolean(r.creator_kol_verified)');
    expect(pageSrc).toContain("id: 'kol_verified'");
    expect(pageSrc).toContain('onlyKolVerified: statusFilter === \'kol_verified\'');
    expect(pageSrc).toContain('token.creatorKolVerified');
  });
});
