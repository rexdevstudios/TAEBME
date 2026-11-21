'use client';

import React from 'react';
import Link from 'next/link';
import { CheckCircle2, Lock, ArrowRight, Coins } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export interface WorkflowStepItem {
  step: string;
  label: string;
  cost?: string;
}

interface PageWorkflowBannerProps {
  title: string;
  steps: WorkflowStepItem[];
  isUnlocked: boolean;
  requiredPlanLabel?: string;
  unlockedLabel?: string;
  creditSummary?: string;
}

/**
 * Reusable compact workflow & RBAC/Plan entitlement banner mounted across core pages
 * so users immediately understand: (1) step-by-step order, (2) what their plan/role unlocks,
 * and (3) which actions are free vs metered credits vs on-chain ETH.
 */
export function PageWorkflowBanner({
  title,
  steps,
  isUnlocked,
  requiredPlanLabel = 'CREATOR / AGENT',
  unlockedLabel,
  creditSummary,
}: PageWorkflowBannerProps) {
  const { isConnected, planId, userRole, credits } = useAuth();
  const activePlan = (planId || 'FREE').toUpperCase();

  return (
    <div
      className="bg-panel"
      style={{
        borderRadius: '8px',
        padding: '12px 16px',
        border: `1px solid ${isUnlocked ? 'rgba(34, 197, 94, 0.25)' : 'rgba(245, 158, 11, 0.35)'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            {title}
          </span>
          {creditSummary && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-badge-info-text)',
                backgroundColor: 'var(--color-badge-info-bg)',
                border: '1px solid var(--color-badge-info-border)',
                padding: '2px 8px',
                borderRadius: '6px',
              }}
            >
              <Coins size={11} /> {creditSummary}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {!isConnected ? (
            <span style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
              Mode Pengunjung (Hubungkan Dompet MetaMask untuk akses penuh)
            </span>
          ) : isUnlocked ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-badge-success-text)',
                backgroundColor: 'var(--color-badge-success-bg)',
                border: '1px solid var(--color-badge-success-border)',
                padding: '3px 9px',
                borderRadius: '6px',
              }}
            >
              <CheckCircle2 size={12} />
              {unlockedLabel || `Aktif: Paket ${activePlan} (${userRole}) · ${credits.toLocaleString()} cr`}
            </span>
          ) : (
            <Link
              href="/billing"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-badge-warning-text)',
                backgroundColor: 'var(--color-badge-warning-bg)',
                border: '1px solid var(--color-badge-warning-border)',
                padding: '3px 9px',
                borderRadius: '6px',
                textDecoration: 'none',
              }}
            >
              <Lock size={12} />
              Paket {activePlan} — Upgrade ke {requiredPlanLabel} →
            </Link>
          )}
        </div>
      </div>

      {/* Horizontal Stepper */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
        {steps.map((item, idx) => (
          <React.Fragment key={item.step}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: '8px',
                backgroundColor: 'var(--color-surface-subtle)',
                border: '1px solid var(--color-border)',
                fontSize: '11px',
              }}
            >
              <span
                style={{
                  fontWeight: 900,
                  color: 'var(--color-badge-info-text)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {item.step}
              </span>
              <span style={{ color: 'var(--color-foreground)', fontWeight: 600 }}>{item.label}</span>
              {item.cost && (
                <span style={{ color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                  ({item.cost})
                </span>
              )}
            </div>
            {idx < steps.length - 1 && (
              <ArrowRight size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
