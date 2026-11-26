import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FC: Tri-Language (EN | ID | CN) Cleanup for Landing & Core Pages', () => {
  test('LandingHeroMotion.tsx uses useLocale() and localizes hero, CTA, stats, and bento cards across EN | ID | CN', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/components/LandingHeroMotion.tsx'), 'utf8');
    expect(src).toContain("import { useLocale } from '../context/LocaleContext'");
    expect(src).toContain('const { tr } = useLocale()');
    expect(src).toContain('Launch tokens with automated bonding curves');
    expect(src).toContain('Prefer manual wallet verification?');
    expect(src).toContain('Everything you need to launch & trade tokens');
    expect(src).toContain('使用自动化联合曲线发行代币');
  });

  test('app/page.tsx Guest View localizes Start in 3 steps & CTA across EN | ID | CN', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/page.tsx'), 'utf8');
    expect(src).toContain("tr('Start in 3 steps', 'Mulai dalam 3 langkah', '三步快速开始')");
    expect(src).toContain("tr('Get Started — Connect Wallet', 'Mulai Sekarang — Hubungkan Dompet', '立即开始 — 连接钱包')");
  });

  test('app/launchpad/page.tsx localizes Live Pools discovery toolbar across EN | ID | CN', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/launchpad/page.tsx'), 'utf8');
    expect(src).toContain("tr('ACTIVE TOKENS', 'TOKEN AKTIF', '活跃代币')");
    expect(src).toContain("tr('Trending', 'Sedang Ramai', '热门')");
    expect(src).toContain("tr('Near Graduation', 'Hampir Graduasi', '即将毕业')");
    expect(src).toContain("tr('Network:', 'Jaringan:', '网络：')");
  });

  test('app/kol/page.tsx localizes Passport stats & Marketplace filters across EN | ID | CN', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/kol/page.tsx'), 'utf8');
    expect(src).toContain("tr('Completed Bounty Claims', 'Klaim Bounty Selesai', '已完成赏金领取')");
    expect(src).toContain("tr('Total Rewards Earned', 'Total Reward Didapat', '累计获得奖励')");
    expect(src).toContain("tr('All Campaigns', 'Semua Kampanye', '全部活动')");
  });
});
