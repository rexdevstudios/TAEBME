// ============================================================================
// RTRADER EXECUTION PLANE — MERKLE PUBLICATION & REORG SWEEPER RUNNER (B3.5)
// ============================================================================
// Standalone persistent VPS/systemd process — NEVER runs inside Vercel.
//
// Modes:
//   --mode=sweep   : Read-only post-publication reorg sweeper (ZERO private key)
//   --mode=publish : Polls bounty_merkle_publication_intents & signs on-chain
//   --mode=all     : Runs both publisher loop and periodic reorg sweep
//   --once         : Execute a single cycle and exit cleanly (ideal for cron/tests)
//   --dry-run      : Non-broadcasting dry run for safe preflight verification
// ============================================================================

import { ethers } from 'ethers';
import type { Pool } from 'pg';
import { createWorkerDbPool, defaultRpcManager } from '../../packages/shared/db-pool';
import { getAppEnvironment } from '../../packages/shared/env-config';
import { MerklePublicationWorker } from './workers/merkle-publication-worker';
import { PostgresPublicationWorkerDbAdapter } from './workers/postgres-publication-worker-db-adapter';
import { PublishedSnapshotReorgSweeper } from './workers/published-snapshot-reorg-sweeper';

export type MerkleRunnerMode = 'all' | 'publish' | 'sweep';

export interface MerkleRunnerOptions {
  mode?: MerkleRunnerMode;
  networkId?: string;
  contractAddress?: string;
  rpcUrl?: string;
  signerPrivateKey?: string;
  pollIntervalMs?: number;
  sweepIntervalMs?: number;
  dryRun?: boolean;
  once?: boolean;
  pool?: Pool;
}

export class MerkleExecutionRunner {
  private readonly mode: MerkleRunnerMode;
  private readonly networkId: string;
  private readonly contractAddress?: string;
  private readonly rpcUrl?: string;
  private readonly signerPrivateKey?: string;
  private readonly pollIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly dryRun: boolean;
  private readonly once: boolean;

  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly db: PostgresPublicationWorkerDbAdapter;
  private readonly sweeper: PublishedSnapshotReorgSweeper;

  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MerkleRunnerOptions = {}) {
    const appEnv = getAppEnvironment();
    this.mode = options.mode ?? 'sweep';
    this.networkId =
      options.networkId ??
      process.env.MERKLE_NETWORK_ID ??
      (appEnv === 'production' ? 'base-mainnet' : 'base-sepolia');
    this.contractAddress =
      options.contractAddress ??
      process.env.MERKLE_LAUNCHPAD_CONTRACT_ADDRESS ??
      process.env.NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS;
    this.rpcUrl = options.rpcUrl ?? process.env.MERKLE_RPC_URL;
    this.signerPrivateKey = options.signerPrivateKey ?? process.env.MERKLE_PUBLISHER_PRIVATE_KEY;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.dryRun = options.dryRun ?? false;
    this.once = options.once ?? false;

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = createWorkerDbPool();
      this.ownsPool = true;
    }

    this.db = new PostgresPublicationWorkerDbAdapter(this.pool);
    this.sweeper = new PublishedSnapshotReorgSweeper(this.db, async (netId) => {
      const url = this.rpcUrl || (await defaultRpcManager.getActiveHttpRpc(netId, 'LAUNCHPAD'));
      const provider = new ethers.JsonRpcProvider(url);
      return {
        getNetwork: async () => {
          const n = await provider.getNetwork();
          return { chainId: n.chainId };
        },
        call: async (tx) => provider.call(tx),
      };
    });
  }

  private buildPublicationWorker(): MerklePublicationWorker {
    if (!this.contractAddress || !ethers.isAddress(this.contractAddress)) {
      throw new Error(
        'STARTUP_ERROR: MERKLE_LAUNCHPAD_CONTRACT_ADDRESS (valid EVM address) is required for publish mode.'
      );
    }
    if (!this.signerPrivateKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(this.signerPrivateKey.trim())) {
      throw new Error(
        'STARTUP_ERROR: MERKLE_PUBLISHER_PRIVATE_KEY (32-byte hex) is required for publish mode. Keep this key strictly on the VPS — NEVER in Vercel.'
      );
    }

    const wallet = new ethers.Wallet(this.signerPrivateKey.trim());
    return new MerklePublicationWorker(
      this.db,
      wallet,
      {
        getActiveHttpRpc: async (netId: string, domain: 'LAUNCHPAD') =>
          this.rpcUrl || defaultRpcManager.getActiveHttpRpc(netId, domain),
      },
      {
        dryRun: this.dryRun,
        pollIntervalMs: this.pollIntervalMs,
      }
    );
  }

  async runSingleCycle(): Promise<{
    mode: MerkleRunnerMode;
    networkId: string;
    sweepReport?: Awaited<ReturnType<PublishedSnapshotReorgSweeper['sweepOnce']>>;
    publishedProcessed?: boolean;
  }> {
    let sweepReport;
    let publishedProcessed = false;

    if (this.mode === 'publish' || this.mode === 'all') {
      const worker = this.buildPublicationWorker();
      publishedProcessed = await worker.processNextIntent();
    }

    if (this.mode === 'sweep' || this.mode === 'all') {
      sweepReport = await this.sweeper.sweepOnce(this.networkId);
    }

    return {
      mode: this.mode,
      networkId: this.networkId,
      sweepReport,
      publishedProcessed,
    };
  }

  async start(): Promise<void> {
    if (this.once) {
      const res = await this.runSingleCycle();
      console.log('[MerkleRunner] Single cycle completed:', JSON.stringify(res));
      await this.stop();
      return;
    }

    const bindSignal = (sig: NodeJS.Signals) => {
      process.once(sig, () => {
        console.log(`[MerkleRunner] Received ${sig}, draining gracefully...`);
        void this.stop();
      });
    };
    bindSignal('SIGINT');
    bindSignal('SIGTERM');

    const interval = this.mode === 'sweep' ? this.sweepIntervalMs : this.pollIntervalMs;
    console.log(
      `[MerkleRunner] Started in mode=${this.mode} network=${this.networkId} dryRun=${this.dryRun} interval=${interval}ms`
    );

    const loop = async () => {
      if (this.stopping) return;
      try {
        const res = await this.runSingleCycle();
        console.log('[MerkleRunner] Cycle:', JSON.stringify(res));
      } catch (err: unknown) {
        console.error('[MerkleRunner] Cycle error:', err instanceof Error ? err.message : String(err));
      }
      if (!this.stopping) {
        this.timer = setTimeout(() => void loop(), interval);
      }
    };

    await loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ownsPool) {
      await this.pool.end().catch(() => {});
    }
  }
}

export function parseMerkleRunnerArgs(argv: string[]): MerkleRunnerOptions {
  const opts: MerkleRunnerOptions = {};
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const val = arg.slice('--mode='.length);
      if (val === 'all' || val === 'publish' || val === 'sweep') opts.mode = val;
    } else if (arg.startsWith('--network=')) {
      opts.networkId = arg.slice('--network='.length);
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--once') {
      opts.once = true;
    }
  }
  return opts;
}

if (typeof import.meta !== 'undefined' && (import.meta as any).main) {
  const runner = new MerkleExecutionRunner(parseMerkleRunnerArgs(process.argv.slice(2)));
  runner.start().catch((err) => {
    console.error('[MerkleRunner] Fatal startup error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
