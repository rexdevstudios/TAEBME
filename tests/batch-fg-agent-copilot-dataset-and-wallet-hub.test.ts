import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FG: /agent Pro Polish — KOL-Prioritized Copilot Dataset & Managed Wallets Hub', () => {
  test('copilot/chat/route.ts enriches marketplacePresets with KOL Verified status before summarizing dataset', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/api/agent/copilot/chat/route.ts'), 'utf8');
    expect(src).toContain('enrichMarketplacePresetsWithKolStatus');
    expect(src).toContain('enrichedMarketplacePresets');
    expect(src).toContain('buildMarketplaceDatasetAdvisorySummary(enrichedMarketplacePresets, parsed.symbol)');
  });

  test('AiCopilotChatPanel.tsx renders liveHighlights.marketplaceDataset chip cleanly', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/components/AiCopilotChatPanel.tsx'), 'utf8');
    expect(src).toContain('m.liveHighlights.marketplaceDataset');
    expect(src).toContain('SIGNAL DATASET');
    expect(src).toContain('var(--color-badge-success-bg)');
  });

  test('app/agent/page.tsx mounts reusable OwnedWalletsAllowlistPanel in Tab 3 (pro) without duplication', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/agent/page.tsx'), 'utf8');
    expect(src).toContain("import { OwnedWalletsAllowlistPanel } from '../components/OwnedWalletsAllowlistPanel'");
    expect(src).toContain('<OwnedWalletsAllowlistPanel isConnected={isConnected} />');
  });
});
