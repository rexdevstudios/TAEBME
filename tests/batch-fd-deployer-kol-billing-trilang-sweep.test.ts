import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FD: Complete Tri-Language (EN | ID | CN) Sweep on /launchpad, /kol & /billing', () => {
  test('app/launchpad/page.tsx localizes Deployer vesting, fee recipient & billing sync card across EN | ID | CN', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/launchpad/page.tsx'), 'utf8');
    expect(src).toContain("tr('No Vesting (0%)', 'Tanpa Vesting (0%)', '无锁仓 (0%)')");
    expect(src).toContain('Creator Royalty Recipient (Bankr Fee Recipient Format)');
    expect(src).toContain("tr('Plan & Launch Fee Sync (/billing)', 'Sinkronisasi Paket & Biaya Peluncuran (/billing)', '套餐与发行费用同步 (/billing)')");
    expect(src).toContain("tr('Manage Plan & Credits →', 'Kelola Paket & Kredit →', '管理套餐与积分 →')");
    expect(src).toContain("tr('Active Plan & Balance', 'Paket & Saldo Aktif', '当前套餐与余额')");
  });

  test('app/kol/page.tsx localizes Tabs 2-4 campaign descriptions, Merkle instructions & Creator Escrow header', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/kol/page.tsx'), 'utf8');
    expect(src).toContain("tr('Required official hashtag:', 'Wajib menyertakan hashtag resmi:', '必须包含官方标签：')");
    expect(src).toContain("tr('No Verified Claims Yet', 'Belum Ada Klaim Terverifikasi', '暂无已验证领取')");
    expect(src).toContain("tr('Create Token Marketing Bounty Campaign', 'Buat Kampanye Promosi Marketing Token', '创建代币营销赏金活动')");
  });

  test('app/billing/page.tsx localizes Tab 3 Credit Ledger & Multi-Account API Vault cards across EN | ID | CN', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/billing/page.tsx'), 'utf8');
    expect(src).toContain("tr('Credit Ledger History', 'Riwayat Mutasi Kredit', '积分账本记录')");
    expect(src).toContain("tr('Manage in /launchpad →', 'Kelola di /launchpad →', '前往 /launchpad 管理 →')");
    expect(src).toContain("tr('Manage in /trading →', 'Kelola di /trading →', '前往 /trading 管理 →')");
    expect(src).toContain("tr('Manage in /agent →', 'Kelola di /agent →', '前往 /agent 管理 →')");
  });
});
