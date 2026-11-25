/**
 * packages/shared/ops-preflight.ts
 *
 * Pure, deterministic Admin Ops Preflight & Execution Plane Readiness Evaluator (Phase EI).
 * - Zero secrets, zero I/O, zero DDL migrations.
 * - Shares canonical PostgreSQL advisory lock keys (482187, 882001) with apps/execution-plane/main.ts.
 */

export const EXECUTION_PLANE_LOCK_KEYS = {
  key1: 482187,
  key2: 882001,
} as const;

export type PreflightCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface OpsPreflightCheckItem {
  id:
    | 'DATABASE_SSOT'
    | 'REDIS_NONCE_STORE'
    | 'KILL_SWITCH_CLEAR'
    | 'AI_ENGINE_BYTEPLUS'
    | 'EXECUTION_PLANE_WORKER';
  label: string;
  status: PreflightCheckStatus;
  detail: string;
}

export interface OpsPreflightReport {
  overallStatus: 'READY' | 'DEGRADED' | 'HALTED';
  passedCount: number;
  totalCount: number;
  checks: OpsPreflightCheckItem[];
}

export interface OpsPreflightInput {
  dbConnected: boolean;
  redisConfigured: boolean;
  activeKillSwitchesCount: number;
  aiEngine: {
    primaryProvider: string;
    byteplusConfigured: boolean;
    fastPoolCount: number;
    deepPoolCount: number;
    infoQuestEnabled: boolean;
  };
  executionPlane: {
    workerOnline: boolean;
    pendingExecutionCount: number;
    lastExecutedAt: string | null;
  };
}

export function evaluateOpsPreflightChecklist(input: OpsPreflightInput): OpsPreflightReport {
  const checks: OpsPreflightCheckItem[] = [];

  // 1. Database SSOT
  checks.push({
    id: 'DATABASE_SSOT',
    label: 'PostgreSQL SSOT',
    status: input.dbConnected ? 'PASS' : 'FAIL',
    detail: input.dbConnected ? 'Neon PostgreSQL connected' : 'PostgreSQL unreachable',
  });

  // 2. Redis Nonce & Cache Store
  checks.push({
    id: 'REDIS_NONCE_STORE',
    label: 'Upstash Redis Store',
    status: input.redisConfigured ? 'PASS' : 'WARN',
    detail: input.redisConfigured
      ? 'Atomic SIWE nonces & telemetry cache active'
      : 'Redis not configured (dev fallback)',
  });

  // 3. Global/Trading Kill-Switch
  const ksCount = Math.max(0, Number(input.activeKillSwitchesCount || 0));
  checks.push({
    id: 'KILL_SWITCH_CLEAR',
    label: 'Kill-Switch Status',
    status: ksCount === 0 ? 'PASS' : 'FAIL',
    detail: ksCount === 0 ? '0 active halts' : `${ksCount} active kill-switch(es) halting execution`,
  });

  // 4. BytePlus ModelArk AI Engine & Waterfall
  const aiReady = Boolean(input.aiEngine?.byteplusConfigured);
  const fastCnt = Math.max(0, Number(input.aiEngine?.fastPoolCount || 0));
  const deepCnt = Math.max(0, Number(input.aiEngine?.deepPoolCount || 0));
  checks.push({
    id: 'AI_ENGINE_BYTEPLUS',
    label: 'BytePlus ModelArk AI',
    status: aiReady ? 'PASS' : 'WARN',
    detail: aiReady
      ? `Primary=${input.aiEngine.primaryProvider} · fastPool=${fastCnt} · deepPool=${deepCnt} · infoQuest=${input.aiEngine.infoQuestEnabled ? 'ON' : 'OFF'}`
      : `Primary=${input.aiEngine?.primaryProvider || 'fallback'} · BytePlus key not set (deterministic fallback active)`,
  });

  // 5. Execution Plane Worker (worker:binance)
  const pending = Math.max(0, Number(input.executionPlane?.pendingExecutionCount || 0));
  const workerOnline = Boolean(input.executionPlane?.workerOnline);
  const workerStatus: PreflightCheckStatus = workerOnline
    ? 'PASS'
    : pending > 0
      ? 'WARN'
      : 'PASS';
  checks.push({
    id: 'EXECUTION_PLANE_WORKER',
    label: 'Execution Plane (worker:binance)',
    status: workerStatus,
    detail: workerOnline
      ? `ONLINE (advisory lock held) · pending=${pending}`
      : pending > 0
        ? `STANDBY · ${pending} APPROVED intent(s) awaiting external worker:binance`
        : 'STANDBY (0 pending CEX intents)',
  });

  const passedCount = checks.filter((c) => c.status === 'PASS').length;
  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasWarn = checks.some((c) => c.status === 'WARN');

  let overallStatus: OpsPreflightReport['overallStatus'] = 'READY';
  if (ksCount > 0 || !input.dbConnected || hasFail) {
    overallStatus = 'HALTED';
  } else if (hasWarn) {
    overallStatus = 'DEGRADED';
  }

  return {
    overallStatus,
    passedCount,
    totalCount: checks.length,
    checks,
  };
}
