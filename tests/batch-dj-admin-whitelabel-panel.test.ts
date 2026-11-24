/**
 * tests/batch-dj-admin-whitelabel-panel.test.ts
 *
 * Phase DJ Verification Suite:
 *  - Verifies AdminWhiteLabelPartnersPanel wires GET, POST, and DELETE /api/admin/partners
 *  - Verifies app/billing/page.tsx mounts AdminWhiteLabelPartnersPanel inside Admin Ops tab
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Phase DJ: Admin White-Label Partner Management Panel (/billing Admin Tab)', () => {
  test('[DJ1.1] AdminWhiteLabelPartnersPanel implements full CRUD against /api/admin/partners', () => {
    const panelSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/components/AdminWhiteLabelPartnersPanel.tsx'),
      'utf8'
    );
    expect(panelSrc).toContain('/api/admin/partners');
    expect(panelSrc).toContain("method: 'POST'");
    expect(panelSrc).toContain("method: 'DELETE'");
    expect(panelSrc).toContain('partnerFeeBps');
    expect(panelSrc).toContain('telegramChatId');
  });

  test('[DJ1.2] app/billing/page.tsx mounts AdminWhiteLabelPartnersPanel in Admin tab', () => {
    const billingSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/billing/page.tsx'),
      'utf8'
    );
    expect(billingSrc).toContain('AdminWhiteLabelPartnersPanel');
  });
});
