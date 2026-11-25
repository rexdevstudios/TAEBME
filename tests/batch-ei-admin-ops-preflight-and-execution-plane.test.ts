import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXECUTION_PLANE_LOCK_KEYS,
  evaluateOpsPreflightChecklist,
} from '../packages/shared/ops-preflight';

describe('Phase EI — Live Execution Plane Heartbeat, BytePlus AI Engine & Ops Preflight Dashboard', () => {
  test('returns READY when DB, Redis, Kill-Switch, BytePlus AI, and Execution Plane are healthy', () => {
    const report = evaluateOpsPreflightChecklist({
      dbConnected: true,
      redisConfigured: true,
      activeKillSwitchesCount: 0,
      aiEngine: {
        primaryProvider: 'byteplus',
        byteplusConfigured: true,
        fastPoolCount: 3,
        deepPoolCount: 2,
        infoQuestEnabled: true,
      },
      executionPlane: {
        workerOnline: true,
        pendingExecutionCount: 0,
        lastExecutedAt: new Date().toISOString(),
      },
    });
    expect(report.overallStatus).toBe('READY');
    expect(report.passedCount).toBe(5);
    expect(report.totalCount).toBe(5);
  });

  test('returns DEGRADED when worker is standby with pending intents or BytePlus key is not set', () => {
    const report = evaluateOpsPreflightChecklist({
      dbConnected: true,
      redisConfigured: true,
      activeKillSwitchesCount: 0,
      aiEngine: {
        primaryProvider: 'byteplus',
        byteplusConfigured: false,
        fastPoolCount: 0,
        deepPoolCount: 0,
        infoQuestEnabled: false,
      },
      executionPlane: {
        workerOnline: false,
        pendingExecutionCount: 2,
        lastExecutedAt: null,
      },
    });
    expect(report.overallStatus).toBe('DEGRADED');
    const workerCheck = report.checks.find((c) => c.id === 'EXECUTION_PLANE_WORKER');
    expect(workerCheck?.status).toBe('WARN');
    expect(workerCheck?.detail).toContain('2 APPROVED');
  });

  test('returns HALTED when a kill switch is active or PostgreSQL is down', () => {
    const report = evaluateOpsPreflightChecklist({
      dbConnected: true,
      redisConfigured: true,
      activeKillSwitchesCount: 1,
      aiEngine: {
        primaryProvider: 'byteplus',
        byteplusConfigured: true,
        fastPoolCount: 2,
        deepPoolCount: 1,
        infoQuestEnabled: false,
      },
      executionPlane: {
        workerOnline: true,
        pendingExecutionCount: 0,
        lastExecutedAt: null,
      },
    });
    expect(report.overallStatus).toBe('HALTED');
    expect(report.checks.find((c) => c.id === 'KILL_SWITCH_CLEAR')?.status).toBe('FAIL');
  });

  test('shares exact advisory lock keys with execution-plane runner and wires ops-summary + AdminOpsHealthPanel', () => {
    const mainSrc = fs.readFileSync(
      path.join(process.cwd(), 'apps/execution-plane/main.ts'),
      'utf8'
    );
    const opsRouteSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/api/admin/ops-summary/route.ts'),
      'utf8'
    );
    const panelSrc = fs.readFileSync(
      path.join(process.cwd(), 'app/components/AdminOpsHealthPanel.tsx'),
      'utf8'
    );

    expect(mainSrc).toContain(String(EXECUTION_PLANE_LOCK_KEYS.key1));
    expect(mainSrc).toContain(String(EXECUTION_PLANE_LOCK_KEYS.key2));
    expect(opsRouteSrc).toContain('pg_locks');
    expect(opsRouteSrc).toContain('evaluateOpsPreflightChecklist');
    expect(panelSrc).toContain('Execution Plane (worker:binance)');
    expect(panelSrc).toContain('BytePlus ModelArk AI Engine');
    expect(panelSrc).toContain('Ops Preflight Readiness');
  });
});
