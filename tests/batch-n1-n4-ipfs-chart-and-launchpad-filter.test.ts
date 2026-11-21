import { describe, expect, it } from 'bun:test';
import {
  extractIpfsCidPath,
  isLikelyNonImageUrl,
  resolveIpfsImageCandidates,
  getDeterministicAvatarGradient,
} from '../packages/shared/ipfs-image';
import {
  filterAndSortLaunchTokens,
  normalizeDiscoveryChain,
  computeGraduationProgressPct,
} from '../packages/shared/launchpad-discovery';
import { GET as getMarketChart } from '../app/api/market/chart/route';
import { NextRequest } from 'next/server';

describe('Phase N1–N4 — Resilient IPFS Image, Native Candlestick API & Launchpad Discovery', () => {
  it('N1.1 — resolves ipfs:// and gateway.pinata.cloud URLs into ordered multi-gateway candidates', () => {
    const cid = 'QmdiMA7WbFG93SNqizSZYNV5NG37iuPj87k8vaEMZaxp6Y';
    expect(extractIpfsCidPath(`ipfs://${cid}`)).toBe(cid);
    expect(extractIpfsCidPath(`https://gateway.pinata.cloud/ipfs/${cid}`)).toBe(cid);

    const candidates = resolveIpfsImageCandidates(`ipfs://${cid}`);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates[0]).toBe(`https://gateway.pinata.cloud/ipfs/${cid}`);
    expect(candidates).toContain(`https://ipfs.io/ipfs/${cid}`);
    expect(candidates).toContain(`https://dweb.link/ipfs/${cid}`);
  });

  it('N1.2 — detects non-image HTML root URLs & dead /token-default.png so UI falls back instantly', () => {
    expect(isLikelyNonImageUrl('/token-default.png')).toBe(true);
    expect(isLikelyNonImageUrl('https://clankai-web3.pages.dev')).toBe(true);
    expect(isLikelyNonImageUrl('https://rtrader.io/token-default.png')).toBe(true);
    expect(isLikelyNonImageUrl('/token-default.svg')).toBe(false);
    expect(isLikelyNonImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);

    expect(resolveIpfsImageCandidates('https://clankai-web3.pages.dev')).toEqual([]);
    expect(resolveIpfsImageCandidates('/token-default.png')).toEqual([]);

    const [c1, c2] = getDeterministicAvatarGradient('0xa5f832390447b050955d7b734a9a2fa861b4d3ab');
    expect(c1.startsWith('#')).toBe(true);
    expect(c2.startsWith('#')).toBe(true);
  });

  it('N2.1 — GET /api/market/chart returns deterministic BONDING_CURVE or LIVE_DEX candles for token portal addresses', async () => {
    const req = new NextRequest(
      'https://testnet.pndigi.site/api/market/chart?chain=robinhood&address=0xa5f832390447b050955d7b734a9a2fa861b4d3ab&ticker=NOIR&interval=1h&raised=2500&target=69000'
    );
    const res = await getMarketChart(req);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.symbol).toBe('NOIR');
    expect(['BONDING_CURVE', 'LIVE_DEX']).toContain(json.data.chartSource);
    expect(Array.isArray(json.data.candles)).toBe(true);
    expect(json.data.candles.length).toBeGreaterThanOrEqual(24);
    for (const c of json.data.candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
  });

  it('N3.1 — filters & sorts Launchpad tokens by chain, search query, trending, newest, graduating, and safest', () => {
    const sample = [
      {
        launchId: '1',
        name: 'Noir Protocol',
        ticker: 'NOIR',
        chain: 'robinhood-mainnet',
        contractAddress: '0xa5f832390447b050955d7b734a9a2fa861b4d3ab',
        raisedAmount: 2500,
        graduationThreshold: 69000,
        isGraduated: false,
        riskScore: 94,
        publishedAt: '2026-11-20T21:12:44.588Z',
      },
      {
        launchId: '2',
        name: 'Pump Hill Runner',
        ticker: 'PUMPRUN',
        chain: 'base-mainnet',
        contractAddress: '0x814620255bf422d45c0f8aBF7ad89F40a1CBCA4A',
        raisedAmount: 27501,
        graduationThreshold: 69000,
        isGraduated: false,
        riskScore: 98,
        publishedAt: '2026-09-20T23:15:24.320Z',
      },
      {
        launchId: '3',
        name: 'Clanker Degen AI',
        ticker: 'CLANKAI',
        chain: 'base-mainnet',
        contractAddress: '0x3d04B377AEcFC89Eb2963849197164565145CeD7',
        raisedAmount: 69000,
        graduationThreshold: 69000,
        isGraduated: true,
        riskScore: 90,
        publishedAt: '2026-09-18T04:07:28.424Z',
      },
    ];

    expect(normalizeDiscoveryChain('robinhood-mainnet')).toBe('robinhood');
    expect(computeGraduationProgressPct(sample[1])).toBe(40);

    // Chain filter
    const rhOnly = filterAndSortLaunchTokens(sample, { chain: 'robinhood' });
    expect(rhOnly.length).toBe(1);
    expect(rhOnly[0].ticker).toBe('NOIR');

    // Search by ticker/CA
    const bySearch = filterAndSortLaunchTokens(sample, { search: 'pumprun' });
    expect(bySearch.length).toBe(1);
    expect(bySearch[0].ticker).toBe('PUMPRUN');

    // Sort newest
    const newest = filterAndSortLaunchTokens(sample, { sort: 'newest' });
    expect(newest[0].ticker).toBe('NOIR');

    // Sort trending / graduating
    const graduating = filterAndSortLaunchTokens(sample, { sort: 'graduating' });
    expect(graduating[0].ticker).toBe('CLANKAI');

    // Sort safest
    const safest = filterAndSortLaunchTokens(sample, { sort: 'safest' });
    expect(safest[0].ticker).toBe('PUMPRUN');
  });
});
