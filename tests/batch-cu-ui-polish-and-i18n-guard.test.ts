/**
 * tests/batch-cu-ui-polish-and-i18n-guard.test.ts
 *
 * Phase CU & CV Regression Guard:
 *  - Ensures zero decorative pictographic emojis exist anywhere in app/ TSX files
 *  - Ensures zero washed-out pastel hexes (#FDE047, #E9D5FF, #7DD3FC, etc.) exist in app/ TSX files
 *  - Verifies Pons-v2 Left Icon Rail Sidebar + Mobile Bottom Navigation Bar contracts
 *  - Verifies LocaleContext exposes tr(en, id) helper for full-page bilingual rendering
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

function walkTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsxFiles(full, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_EMOJIS =
  /🚀|🔥|⚡|👑|🎯|🌐|🔄|⚙️|💎|🎉|🟠|🛡️|⚠️|✅|🔒|🎁|🤖|📊|📈|💰|🏆|🔔|🔍|💡|✨|📌|⭐|🚨|🧪|🧠|🔐|⏳|🥩|🎓|⛔/u;

const FORBIDDEN_PASTEL_HEXES =
  /#(?:FDE047|E9D5FF|7DD3FC|6EE7B7|C084FC|FFC400|FFD600|38BDF8|00E5FF|FCD34D|D8B4FE|34D399|F0B90B)\b/i;

describe('Phase CU & CV: Swiss Fintech Minimalist UI, Zero-Emoji & Pons Shell Guard', () => {
  const tsxFiles = walkTsxFiles(path.resolve(process.cwd(), 'app'));

  test('[CU1.1] Zero decorative pictographic emojis remain in any app/**/*.tsx file', () => {
    const violations: string[] = [];
    for (const f of tsxFiles) {
      const content = fs.readFileSync(f, 'utf8');
      const match = content.match(FORBIDDEN_EMOJIS);
      if (match) {
        violations.push(`${path.relative(process.cwd(), f)} -> ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('[CU1.2] Zero washed-out pastel hex colors remain in any app/**/*.tsx file', () => {
    const violations: string[] = [];
    for (const f of tsxFiles) {
      const content = fs.readFileSync(f, 'utf8');
      const match = content.match(FORBIDDEN_PASTEL_HEXES);
      if (match) {
        violations.push(`${path.relative(process.cwd(), f)} -> ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('[CV1.1] HeaderNav & globals.css enforce Pons Left Icon Rail Sidebar + Mobile Bottom Nav', () => {
    const headerSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/components/HeaderNav.tsx'),
      'utf8'
    );
    const cssSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/globals.css'),
      'utf8'
    );
    expect(headerSrc).toContain('pons-sidebar');
    expect(headerSrc).toContain('pons-mobile-bottom-nav');
    expect(cssSrc).toContain('.pons-sidebar');
    expect(cssSrc).toContain('.pons-mobile-bottom-nav');
  });

  test('[CU1.3] LocaleContext exposes tr(en, id) helper for full-page bilingual coverage', () => {
    const localeSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/context/LocaleContext.tsx'),
      'utf8'
    );
    expect(localeSrc).toContain('tr: (enText: string, idText: string) => string');
    expect(localeSrc).toContain("locale === 'id' ? idText : enText");
  });
});
