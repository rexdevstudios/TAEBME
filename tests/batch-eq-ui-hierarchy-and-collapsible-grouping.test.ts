import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch EQ — UI Information Hierarchy & Collapsible Grouping', () => {
  const root = process.cwd();

  it('1. CollapsibleSection component exists with aria-expanded progressive disclosure', () => {
    const compPath = path.join(root, 'app', 'components', 'CollapsibleSection.tsx');
    expect(fs.existsSync(compPath)).toBe(true);
    const src = fs.readFileSync(compPath, 'utf8');
    expect(src).toContain('export function CollapsibleSection');
    expect(src).toContain('aria-expanded={open}');
  });

  it('2. PageWorkflowBanner defaults to collapsed steps strip with toggle button', () => {
    const bannerPath = path.join(root, 'app', 'components', 'PageWorkflowBanner.tsx');
    const src = fs.readFileSync(bannerPath, 'utf8');
    expect(src).toContain('useState<boolean>(false)');
    expect(src).toContain('Steps (${steps.length})');
  });

  it('3. /trading places Trade Ticket above-the-fold and unifies Orderbook + AI Signal + Alerts into 1 tabbed panel', () => {
    const tradingPath = path.join(root, 'app', 'trading', 'page.tsx');
    const src = fs.readFileSync(tradingPath, 'utf8');
    expect(src).toContain("useState<'orderbook' | 'signal' | 'alerts'>('orderbook')");
    expect(src).toContain('Unified Market Intelligence & Depth Panel');
    expect(src).toContain('Trade Ticket Above-the-Fold');
  });

  it('4. /launchpad and /billing group secondary/admin panels inside CollapsibleSection', () => {
    const launchpadSrc = fs.readFileSync(path.join(root, 'app', 'launchpad', 'page.tsx'), 'utf8');
    const billingSrc = fs.readFileSync(path.join(root, 'app', 'billing', 'page.tsx'), 'utf8');

    expect(launchpadSrc).toContain("from '../components/CollapsibleSection'");
    expect(launchpadSrc).toContain('BondingCurveLaunchpad.sol On-Chain Registration');
    expect(billingSrc).toContain("from '../components/CollapsibleSection'");
    expect(billingSrc).toContain('Owned Sub-Wallet Allowlist');
    expect(billingSrc).toContain('White-Label B2B Partners');
  });
});
