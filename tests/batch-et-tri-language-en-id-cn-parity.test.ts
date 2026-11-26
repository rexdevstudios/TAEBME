import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  I18N_DICTIONARY,
  resolveLocalizedText,
  translateKey,
} from '../packages/shared/i18n-dictionary';

describe('Batch ET — Tri-Language (EN | ID | CN) Full Parity & UI Localization', () => {
  const root = process.cwd();

  it('1. enforces 100% 3-way key parity across en, id, and cn with zero empty values', () => {
    const enKeys = Object.keys(I18N_DICTIONARY.en).sort();
    const idKeys = Object.keys(I18N_DICTIONARY.id).sort();
    const cnKeys = Object.keys(I18N_DICTIONARY.cn).sort();

    expect(enKeys.length).toBeGreaterThanOrEqual(45);
    expect(idKeys).toEqual(enKeys);
    expect(cnKeys).toEqual(enKeys);

    for (const k of enKeys) {
      expect(I18N_DICTIONARY.en[k].trim().length).toBeGreaterThan(0);
      expect(I18N_DICTIONARY.id[k].trim().length).toBeGreaterThan(0);
      expect(I18N_DICTIONARY.cn[k].trim().length).toBeGreaterThan(0);
    }
  });

  it('2. translates core keys and inline tr() phrases cleanly across en, id, and cn', () => {
    expect(translateKey('cn', 'nav.trade')).toBe('交易');
    expect(translateKey('cn', 'billing.title')).toBe('套餐、积分与账户设置');
    expect(resolveLocalizedText('en', 'Sim ($10K)', 'Simulasi ($10K)')).toBe('Sim ($10K)');
    expect(resolveLocalizedText('id', 'Sim ($10K)', 'Simulasi ($10K)')).toBe('Simulasi ($10K)');
    expect(resolveLocalizedText('cn', 'Sim ($10K)', 'Simulasi ($10K)')).toBe('模拟 ($10K)');
    expect(resolveLocalizedText('cn', 'Approve Proposal', 'Setujui Order', '确认下单')).toBe('确认下单');
  });

  it('3. HeaderNav exposes 1-click EN / ID / CN selector and PageWorkflowBanner + CollapsibleSection use useLocale', () => {
    const headerSrc = fs.readFileSync(path.join(root, 'app', 'components', 'HeaderNav.tsx'), 'utf8');
    const bannerSrc = fs.readFileSync(path.join(root, 'app', 'components', 'PageWorkflowBanner.tsx'), 'utf8');
    const collapseSrc = fs.readFileSync(path.join(root, 'app', 'components', 'CollapsibleSection.tsx'), 'utf8');

    expect(headerSrc).toContain('value="cn"');
    expect(headerSrc).toContain('中文');
    expect(bannerSrc).toContain('useLocale');
    expect(bannerSrc).toContain('访客模式');
    expect(collapseSrc).toContain('useLocale');
    expect(collapseSrc).toContain('展开');
  });
});
