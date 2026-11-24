import { describe, expect, it } from 'bun:test';
import {
  I18N_DICTIONARY,
  translateKey,
} from '../packages/shared/i18n-dictionary';

describe('Phase CR: Full EN / ID Multi-Language Dictionary Parity & Fallback Guard', () => {
  it('CR1.1 enforces 100% key parity between en and id dictionaries with zero empty values', () => {
    const enKeys = Object.keys(I18N_DICTIONARY.en).sort();
    const idKeys = Object.keys(I18N_DICTIONARY.id).sort();

    expect(enKeys.length).toBeGreaterThanOrEqual(40);
    expect(idKeys).toEqual(enKeys);

    for (const k of enKeys) {
      expect(I18N_DICTIONARY.en[k].trim().length).toBeGreaterThan(0);
      expect(I18N_DICTIONARY.id[k].trim().length).toBeGreaterThan(0);
    }
  });

  it('CR1.2 translates core page headings across en and id and falls back safely on unknown keys', () => {
    expect(translateKey('en', 'billing.title')).toBe('Plans, Credits & Account Settings');
    expect(translateKey('id', 'billing.title')).toBe('Paket Layanan, Kredit & Pengaturan Akun');
    expect(translateKey('en', 'launchpad.ctaCreate')).toBe('Launch New Token');
    expect(translateKey('id', 'launchpad.ctaCreate')).toBe('Launch Token Baru');
    expect(translateKey('id', 'nonexistent.key')).toBe('nonexistent.key');
  });
});
