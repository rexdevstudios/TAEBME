/**
 * tests/batch-dz-byteplus-seedream-launchpad-studio.test.ts
 *
 * Unit Suite #93 — Phase DZ:
 *  - BytePlus Seedream Image Generation request builder (b64_json, watermark=false, prompt sanitization)
 *  - AI_PRIMARY_PROVIDER parity & thinking: disabled in creator-asset-studio.ts
 *  - API & UI provider exposure in /api/launchpad/asset-studio & CreatorStudioPanel.tsx
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildSeedreamImageRequestPayload,
  FALLBACK_LOGO_PNG_BUFFER,
} from '../packages/launchpad/creator-asset-studio';

describe('Phase DZ: Launchpad Creator Asset Studio (BytePlus Seedream-4.5/5.x)', () => {
  test('buildSeedreamImageRequestPayload constructs safe b64_json request and strips control chars', () => {
    const payload = buildSeedreamImageRequestPayload({
      endpoint: '  ep-seedream-45  ',
      imagePrompt: 'cyberpunk neon\n\tfox emblem for Base L2',
    });

    expect(payload.model).toBe('ep-seedream-45');
    expect(payload.size).toBe('1024x1024');
    expect(payload.response_format).toBe('b64_json');
    expect(payload.watermark).toBe(false);
    expect(String(payload.prompt)).toContain('cyberpunk neon fox emblem for Base L2');
    expect(String(payload.prompt)).not.toContain('\n');
    expect(String(payload.prompt)).not.toContain('\t');
  });

  test('buildSeedreamImageRequestPayload handles empty prompt safely', () => {
    const payload = buildSeedreamImageRequestPayload({
      endpoint: 'ep-seedream-50-flash',
      imagePrompt: '   ',
    });
    expect(String(payload.prompt)).toContain('minimalist futuristic crypto token emblem');
    expect(FALLBACK_LOGO_PNG_BUFFER.length).toBeGreaterThan(64);
  });

  test('creator-asset-studio, API route, and CreatorStudioPanel wire Seedream & AI_PRIMARY_PROVIDER', () => {
    const studioLib = readFileSync(
      join(process.cwd(), 'packages/launchpad/creator-asset-studio.ts'),
      'utf8'
    );
    const studioRoute = readFileSync(
      join(process.cwd(), 'app/api/launchpad/asset-studio/route.ts'),
      'utf8'
    );
    const studioPanel = readFileSync(
      join(process.cwd(), 'app/components/CreatorStudioPanel.tsx'),
      'utf8'
    );

    expect(studioLib).toContain('AI_PRIMARY_PROVIDER');
    expect(studioLib).toContain('BYTEDANCE_IMAGE_ENDPOINT');
    expect(studioLib).toContain('/images/generations');
    expect(studioLib).toContain("thinking: { type: 'disabled' }");
    expect(studioRoute).toContain('provider');
    expect(studioPanel).toContain('json.data.provider');
  });
});
