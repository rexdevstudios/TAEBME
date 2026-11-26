import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch EU — Overview (/) Collapsible Grouping, CN Parity & Timing-Safe Telegram Webhook', () => {
  const root = process.cwd();

  it('1. app/page.tsx groups Onboarding/Genesis/Quests, Admin Console, and Infrastructure Telemetry in CollapsibleSection with CN translations', () => {
    const src = fs.readFileSync(path.join(root, 'app', 'page.tsx'), 'utf8');

    expect(src).toContain("import { CollapsibleSection } from './components/CollapsibleSection';");
    expect(src).toContain('Onboarding Checklist, Genesis SBT & Quests');
    expect(src).toContain('新手引导、创世 SBT 与任务');
    expect(src).toContain('System Admin Governance & Kill-Switch Console');
    expect(src).toContain('Infrastructure Telemetry & Active Domains');
  });

  it('2. app/api/telegram/webhook/route.ts validates X-Telegram-Bot-Api-Secret-Token via crypto.timingSafeEqual', () => {
    const src = fs.readFileSync(
      path.join(root, 'app', 'api', 'telegram', 'webhook', 'route.ts'),
      'utf8'
    );

    expect(src).toContain("import crypto from 'crypto';");
    expect(src).toContain('crypto.timingSafeEqual(');
  });
});
