/**
 * packages/agent/session-allowance.ts
 *
 * Non-Custodial ERC-4337 / ERC-7715 Delegated On-Chain Session Key Allowance Validator.
 * - Enforces AGENTS.md Rule 3: NEVER accepts private keys or seed phrases; only public EVM delegate addresses.
 * - Clamps daily on-chain spend allowance against the user's active billing tier ceiling.
 * - Enforces max 30-day session expiry and verified EVM contract allowlist.
 */

import { ethers } from 'ethers';
import { assertNotPrivateKeyOrMnemonic } from '../shared/credential-vault';
import { SubscriptionsEngine, type PlanId } from '../billing/subscriptions-engine';

export interface SessionAllowanceInput {
  delegateAddress: string;
  chainId: number;
  dailySpendCapUsd: number;
  expiresAtIso: string;
  allowedContracts: string[];
  allowedActions: Array<'MINT_NFT' | 'SWAP_DEX'>;
}

export interface ValidatedSessionAllowance {
  standard: 'ERC-4337/ERC-7715';
  delegateAddress: string;
  chainId: number;
  planId: PlanId;
  effectiveDailySpendCapUsd: number;
  expiresAtIso: string;
  allowedContracts: string[];
  allowedActions: Array<'MINT_NFT' | 'SWAP_DEX'>;
}

const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days hard cap

export function validateSessionAllowanceSpec(
  input: SessionAllowanceInput,
  planId?: string | null,
  nowMs: number = Date.now()
): ValidatedSessionAllowance {
  const rawDelegate = (input.delegateAddress || '').trim();
  // Reject any private key / mnemonic accidentally pasted into delegateAddress
  assertNotPrivateKeyOrMnemonic(rawDelegate);
  if (!ethers.isAddress(rawDelegate)) {
    throw new Error('INVALID_DELEGATE_ADDRESS: delegateAddress must be a valid public EVM address (0x...).');
  }

  const chainId = Number(input.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error('INVALID_CHAIN_ID: chainId must be a positive integer.');
  }

  const rawCap = Number(input.dailySpendCapUsd);
  if (!Number.isFinite(rawCap) || rawCap <= 0) {
    throw new Error('INVALID_DAILY_CAP: dailySpendCapUsd must be a positive number.');
  }

  const expiryMs = Date.parse(input.expiresAtIso || '');
  if (Number.isNaN(expiryMs) || expiryMs <= nowMs) {
    throw new Error('INVALID_EXPIRY: expiresAtIso must be a valid future ISO timestamp.');
  }
  if (expiryMs - nowMs > MAX_SESSION_TTL_MS) {
    throw new Error('EXPIRY_EXCEEDS_MAX_30_DAYS: On-chain session allowance cannot exceed 30 days.');
  }

  if (!Array.isArray(input.allowedContracts) || input.allowedContracts.length === 0) {
    throw new Error('EMPTY_CONTRACT_ALLOWLIST: At least one verified target contract address is required.');
  }
  const cleanContracts: string[] = [];
  for (const addr of input.allowedContracts) {
    const trimmed = String(addr || '').trim();
    if (!ethers.isAddress(trimmed)) {
      throw new Error(`INVALID_CONTRACT_ADDRESS: "${trimmed}" is not a valid EVM contract address.`);
    }
    const checksum = ethers.getAddress(trimmed);
    if (!cleanContracts.includes(checksum)) cleanContracts.push(checksum);
  }

  const allowedActions = Array.from(
    new Set((input.allowedActions || []).filter((a) => a === 'MINT_NFT' || a === 'SWAP_DEX'))
  ) as Array<'MINT_NFT' | 'SWAP_DEX'>;
  if (allowedActions.length === 0) {
    throw new Error('EMPTY_ALLOWED_ACTIONS: Specify at least one allowed action (MINT_NFT or SWAP_DEX).');
  }

  const tier = SubscriptionsEngine.getPlanCapacities(planId);
  const clampedCap = Math.round(Math.min(rawCap, tier.maxOrderValueUsd) * 100) / 100;

  return {
    standard: 'ERC-4337/ERC-7715',
    delegateAddress: ethers.getAddress(rawDelegate),
    chainId,
    planId: tier.planId,
    effectiveDailySpendCapUsd: clampedCap,
    expiresAtIso: new Date(expiryMs).toISOString(),
    allowedContracts: cleanContracts,
    allowedActions,
  };
}
