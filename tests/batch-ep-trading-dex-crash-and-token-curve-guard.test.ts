import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Batch EP — Trading DEX Null-Trim Crash Fix & Token BondingCurve Config Guard', () => {
  const root = process.cwd();

  it('1. app/trading/page.tsx never calls linkedTokenAddress.trim() directly on nullable string|null state', () => {
    const tradingPath = path.join(root, 'app', 'trading', 'page.tsx');
    const src = fs.readFileSync(tradingPath, 'utf8');

    expect(src).not.toContain('linkedTokenAddress.trim()');
    expect(src).toContain("(linkedTokenAddress || '').trim()");
  });

  it('2. TokenActionsClient gates Direct BondingCurveLaunchpad.sol Settlement button behind isBondingCurveConfigured', () => {
    const tokenActionsPath = path.join(root, 'app', 'token', '[chain]', '[address]', 'TokenActionsClient.tsx');
    const src = fs.readFileSync(tokenActionsPath, 'utf8');

    expect(src).toContain('const isBondingCurveConfigured = getContractConfiguration(launchpadContractAddress).isConfigured;');
    expect(src).toContain('!isSolana && !isGraduated && swapMode === \'buy\' && isBondingCurveConfigured');
  });
});
