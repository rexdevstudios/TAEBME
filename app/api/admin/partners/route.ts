/**
 * app/api/admin/partners/route.ts
 *
 * White-Label B2B Partner Config Management Endpoint (Phase DI).
 * - GET: Public (Edge cached 15s for guests) returns active partner public metadata
 *   (slug, brandName, partnerFeeBps); authenticated Admin receives full config including telegramChatId.
 * - POST & DELETE: Strictly RBAC-protected (MANAGE_BILLING_PLANS), fail-closed 401/403.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateSession, requireCapability } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { validateWhiteLabelPartnerInput } from '@packages/billing/whitelabel-partner';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await authenticateSession(req).catch(() => null);
    const isAdmin = Boolean(
      session?.user?.roles?.some((r) =>
        ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'BILLING_ADMIN'].includes(r)
      )
    );
    const partners = await defaultBillingDbAdapter.getWhiteLabelPartners();
    const list = isAdmin
      ? partners
      : partners
          .filter((p) => p.active)
          .map((p) => ({
            slug: p.slug,
            brandName: p.brandName,
            partnerFeeBps: p.partnerFeeBps,
            active: p.active,
          }));

    return NextResponse.json(
      {
        success: true,
        data: {
          partners: list,
          count: list.length,
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: isAdmin
          ? { 'Cache-Control': 'no-store' }
          : { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'PARTNERS_LOAD_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    try {
      await requireCapability(req, 'MANAGE_BILLING_PLANS');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const check = validateWhiteLabelPartnerInput(body);
    if (!check.ok || !check.sanitized) {
      return NextResponse.json(
        { success: false, error: check.error || 'INVALID_PARTNER_CONFIG', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const saved = await defaultBillingDbAdapter.upsertWhiteLabelPartner(check.sanitized);
    return NextResponse.json(
      { success: true, data: saved, timestamp: new Date().toISOString() },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'PARTNER_UPSERT_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    try {
      await requireCapability(req, 'MANAGE_BILLING_PLANS');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const slug = (req.nextUrl.searchParams.get('slug') || '').trim().toLowerCase();
    if (!slug) {
      return NextResponse.json(
        { success: false, error: 'MISSING_SLUG: slug query param is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const deleted = await defaultBillingDbAdapter.deleteWhiteLabelPartner(slug);
    return NextResponse.json(
      { success: true, data: { slug, deleted }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'PARTNER_DELETE_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
