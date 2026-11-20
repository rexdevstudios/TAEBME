import type { EncryptedPayload } from './binance-vault';
import type { TradeIntentInput, BinanceKeyPermissions } from '../shared/types/domain';

export interface TradeIntentRecord extends TradeIntentInput {
  id: string;
  userId: string;
  status: string;
  riskDecisionId?: string;
  riskDecisionReason?: string;
  createdAt?: string;
}

export interface BinanceExecutionDbAdapter {
  getApprovedIntentsQueue(): Promise<TradeIntentRecord[]>;
  claimIntentAtomic(intentId: string): Promise<boolean>;
  updateIntentStatus(intentId: string, status: string, riskDecisionId?: string): Promise<void>;
  getStaleExecutingIntents(staleThresholdMs: number): Promise<TradeIntentRecord[]>;
  getBinanceCredentials(userId: string): Promise<{
    id: string;
    encryptedApiKey: EncryptedPayload | string;
    encryptedSecretKey: EncryptedPayload | string;
    iv?: string;
    authTag?: string;
    permissions?: BinanceKeyPermissions;
    isActive?: boolean;
  } | null>;
  recordOrderFill(fill: {
    intentId: string;
    exchangeOrderId: string;
    symbol: string;
    status: string;
    executedQty: number;
    cummulativeQuoteQty: number;
    audit?: {
      actorId?: string;
      action: string;
      reason?: string;
    };
  }): Promise<void>;
  createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void>;
  getActiveKillSwitches(): Promise<any[]>;
  getActiveTransactionCount?(): number;
}
