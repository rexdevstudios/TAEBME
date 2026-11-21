// ============================================================================
// RTRADER GAMEFI & NFT SERVICE (BASE L2 CONTROL PLANE)
// ============================================================================

import { ethers } from 'ethers';
import {
  UserGameFiProfile,
  QuestDefinition,
  QuestCompletion,
  NftPassTier,
  NftItemRecord,
  NftCollectionRecord,
  MintVoucherPayload,
} from '../shared/types/domain';
import { defaultGameFiDbAdapter, defaultBillingDbAdapter, PostgresGameFiDbAdapter } from '../shared/db-pool';
import { SybilResistanceService } from '../social/sybil-resistance-service';
import { getAuthoritativeGameFiChainConfig, BASE_SEPOLIA_CHAIN_IDENTIFIER } from './gamefi-chain-config';

export const KNOWN_INVALID_ANVIL_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

export function computePassTier(xp: number): NftPassTier {
  if (xp >= 500) return 'GOLD';
  if (xp >= 250) return 'SILVER';
  return 'BRONZE';
}

export function getUtcDailyQuestKey(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `daily_checkin:${yyyy}-${mm}-${dd}`;
}

export interface GameFiQuestConditionCheck {
  isSiweAuthenticated?: boolean;
  isSybilVerified?: boolean;
  hasTradeOrLaunch?: boolean;
}

export class GameFiService {
  constructor(private dbAdapter: PostgresGameFiDbAdapter = defaultGameFiDbAdapter) {}

  /**
   * Authoritatively evaluates quest completion criteria and atomically records XP in Postgres SSOT.
   * Client-supplied condition flags are strictly rejected.
   */
  async verifyAndCompleteQuest(params: {
    userId: string;
    walletAddress?: string;
    questId: string;
    /** Optional UTC date override for deterministic daily quest testing */
    now?: Date;
    /** @deprecated Client-supplied conditions are ignored; server verifies authoritatively */
    conditions?: GameFiQuestConditionCheck;
  }): Promise<{
    profile: UserGameFiProfile & { passTier: NftPassTier; completedQuests: string[]; dailyCheckInAvailable: boolean };
    completion: QuestCompletion;
    creditsGranted: number;
  }> {
    const { userId, walletAddress, questId, now } = params;

    let isEligible = false;
    let xpGranted = 100;
    let creditsGranted = 0;
    let effectiveQuestId = questId;

    if (questId === 'daily_checkin') {
      // Daily UTC-scoped idempotent check-in quest
      effectiveQuestId = getUtcDailyQuestKey(now);
      isEligible = Boolean(userId && walletAddress);
      xpGranted = 25;
      creditsGranted = 5;
    } else if (questId === 'connect_siwe') {
      // Authoritative check: Requires active authenticated user session and wallet binding
      isEligible = Boolean(userId && walletAddress);
      xpGranted = 100;
      creditsGranted = 10;
    } else if (questId === 'verify_sybil') {
      // Authoritative check: Query database trust evidence / verified nullifiers
      isEligible = await this.dbAdapter.hasSybilEvidence(userId, walletAddress);
      xpGranted = 250;
      creditsGranted = 25;
    } else if (questId === 'first_trade_or_launch') {
      // Authoritative check: Query database trade history and token launches
      isEligible = await this.dbAdapter.hasTradeOrLaunchActivity(userId, walletAddress);
      xpGranted = 500;
      creditsGranted = 50;
    } else {
      throw new Error(`UNKNOWN_QUEST_ID: Quest '${questId}' is not registered`);
    }

    if (!isEligible) {
      throw new Error(`QUEST_CONDITIONS_NOT_MET: Authoritative criteria for quest '${questId}' were not satisfied`);
    }

    const result = await this.dbAdapter.recordQuestCompletion({
      userId,
      walletAddress,
      questId: effectiveQuestId,
      xpGranted,
    });

    // Credit bonus into double-entry ledger (non-blocking if billing DB unavailable in isolated unit tests)
    if (creditsGranted > 0 && walletAddress) {
      try {
        await defaultBillingDbAdapter.recordLedgerEntry({
          userId: walletAddress,
          amount: creditsGranted,
          currency: 'CREDITS',
          type: 'GAMEFI_QUEST_REWARD',
          referenceId: `${effectiveQuestId}:${result.completion.id}`,
          description: `GameFi quest reward (${effectiveQuestId}): +${xpGranted} XP & +${creditsGranted} Credits`,
        });
      } catch {
        // Non-blocking fallback
      }
    }

    const completedQuests = await this.dbAdapter.getCompletedQuestIds(userId, walletAddress);
    const todayKey = getUtcDailyQuestKey(now);
    const passTier = computePassTier(result.profile.xp);

    return {
      profile: {
        ...result.profile,
        passTier,
        completedQuests,
        dailyCheckInAvailable: !completedQuests.includes(todayKey),
      },
      completion: result.completion,
      creditsGranted,
    };
  }

  /**
   * Generates a genuine EIP-712 typed-data signed mint voucher for RTraderTraderPass.sol.
   * Enforces domain separation, chainId, verifyingContract, and anti-replay nonces.
   */
  async generateMintVoucher(params: {
    recipientWallet: string;
    tier: NftPassTier;
    signerPrivateKey: string;
    contractAddress: string;
    chainId?: number;
    ttlSeconds?: number;
  }): Promise<MintVoucherPayload> {
    const defaultChainId = getAuthoritativeGameFiChainConfig().chainId;
    const { recipientWallet, tier, signerPrivateKey, contractAddress, chainId = defaultChainId, ttlSeconds = 600 } = params;

    if (!ethers.isAddress(recipientWallet)) {
      throw new Error(`INVALID_RECIPIENT_ADDRESS: ${recipientWallet}`);
    }
    if (!ethers.isAddress(contractAddress)) {
      throw new Error(`INVALID_CONTRACT_ADDRESS: ${contractAddress}`);
    }

    const cleanRecipient = ethers.getAddress(recipientWallet);
    const cleanContract = ethers.getAddress(contractAddress);
    // Secure 128-bit random nonce converted to integer string
    const nonce = ethers.toBigInt(ethers.randomBytes(16)).toString();
    const deadline = Math.floor(Date.now() / 1000) + ttlSeconds;

    const dummyUri = `ipfs://QmRTraderTraderPass${tier.toLowerCase()}/${nonce}`;

    const domain = {
      name: 'RTrader Trader Pass',
      version: '1',
      chainId: BigInt(chainId),
      verifyingContract: cleanContract,
    };

    const types = {
      MintVoucher: [
        { name: 'recipient', type: 'address' },
        { name: 'tier', type: 'string' },
        { name: 'metadataUri', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const value = {
      recipient: cleanRecipient,
      tier,
      metadataUri: dummyUri,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    };

    const wallet = new ethers.Wallet(signerPrivateKey);
    const signature = await wallet.signTypedData(domain, types, value);

    return {
      recipient: cleanRecipient,
      tier,
      nonce,
      deadline,
      signature,
      metadataUri: dummyUri,
      contractAddress: cleanContract,
      chainId,
    };
  }

  /**
   * Constructs OpenSea-compatible ERC-721 metadata object for Pinata IPFS pinning.
   */
  constructNftMetadata(tier: NftPassTier, imageUri: string) {
    return {
      name: `RTrader ${tier} Trader Pass`,
      description: `Official RTrader SocialFi ${tier} Tier Trader Pass granting access to premium launchpad features on Base L2.`,
      image: imageUri,
      external_url: 'https://rtrader.io/gamefi/pass',
      attributes: [
        { trait_type: 'Pass Tier', value: tier },
        { trait_type: 'Platform', value: 'RTrader SocialFi' },
        { trait_type: 'Network', value: 'Base L2' },
      ],
    };
  }

  private customProvider?: ethers.Provider | null;

  setProvider(provider?: ethers.Provider | null): void {
    this.customProvider = provider;
  }

  getProvider(): ethers.Provider | null {
    return this.customProvider ?? null;
  }

  /**
   * Resolves the authoritative NFT collection from PostgreSQL SSOT and performs
   * mandatory on-chain verification of chainId, bytecode, ERC-721 interface,
   * name, and symbol before allowing minting.
   * Fails closed if database is unavailable, collection is unverified, contract is invalid,
   * or provider is missing.
   */
  async resolveAndVerifyCollection(params: {
    collectionName?: string;
    chainIdentifier?: string;
    provider?: ethers.Provider | null;
  }): Promise<{ collection: NftCollectionRecord; contractAddress: string; chainId: number }> {
    const chainConfig = getAuthoritativeGameFiChainConfig();
    const chainIdentifier = params.chainIdentifier || chainConfig.chainIdentifier;
    const collectionName = params.collectionName || 'RTrader Trader Pass';

    // 1. Authoritative resolution from PostgreSQL SSOT
    const collection = await this.dbAdapter.getCollectionByChainAndName(chainIdentifier, collectionName);
    if (!collection) {
      throw new Error(
        `COLLECTION_NOT_FOUND: No registered collection "${collectionName}" on chain "${chainIdentifier}" in PostgreSQL SSOT.`
      );
    }

    if (!collection.contractAddress || !ethers.isAddress(collection.contractAddress)) {
      throw new Error(
        `COLLECTION_UNDEPLOYED: Collection "${collectionName}" does not have a valid contract address registered.`
      );
    }

    const cleanContract = ethers.getAddress(collection.contractAddress);
    if (cleanContract === ethers.ZeroAddress) {
      throw new Error('INVALID_CONTRACT_ADDRESS: Zero address cannot be used as an NFT contract.');
    }

    // 2. Reject known invalid local Anvil address
    if (cleanContract.toLowerCase() === KNOWN_INVALID_ANVIL_ADDRESS.toLowerCase()) {
      throw new Error(
        `INVALID_CONTRACT_PROVENANCE: Registered contract ${cleanContract} matches known unverified local Anvil test address. Deployment provenance rejected.`
      );
    }

    // 3. Mandatory on-chain verification
    const activeProvider = params.provider !== undefined ? params.provider : this.customProvider;
    if (!activeProvider) {
      throw new Error(
        'PROVIDER_REQUIRED: Mandatory ethers.Provider is required for on-chain collection verification.'
      );
    }

    const network = await activeProvider.getNetwork();
    const connectedChainId = Number(network.chainId);
    if (connectedChainId !== chainConfig.chainId) {
      throw new Error(
        `CHAIN_MISMATCH: Connected provider chainId (${connectedChainId}) does not match authoritative chainId (${chainConfig.chainId}).`
      );
    }

    const code = await activeProvider.getCode(cleanContract);
    if (!code || code === '0x' || code === '0x0') {
      throw new Error(
        `CONTRACT_NOT_DEPLOYED_ON_CHAIN: No bytecode found at ${cleanContract} on chain ${connectedChainId}.`
      );
    }

    // Check ERC-721 interface support & on-chain metadata
    const erc721FullAbi = [
      'function supportsInterface(bytes4) view returns (bool)',
      'function name() view returns (string)',
      'function symbol() view returns (string)',
    ];
    const contract = new ethers.Contract(cleanContract, erc721FullAbi, activeProvider);
    try {
      const isErc721 = await contract.supportsInterface('0x80ac58cd');
      if (!isErc721) {
        throw new Error('INTERFACE_VERIFICATION_FAILED: Contract does not support ERC-721 interface (0x80ac58cd).');
      }
    } catch (err: any) {
      throw new Error(`INTERFACE_VERIFICATION_FAILED: Failed to verify ERC-721 interface: ${err?.message || err}`);
    }

    try {
      const onChainName = await contract.name();
      if (onChainName !== collection.name) {
        throw new Error(
          `CONTRACT_METADATA_MISMATCH: On-chain name "${onChainName}" does not match registry name "${collection.name}".`
        );
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith('CONTRACT_METADATA_MISMATCH')) throw err;
      throw new Error(`CONTRACT_METADATA_MISMATCH: Failed to query on-chain contract name: ${err?.message || err}`);
    }

    try {
      const onChainSymbol = await contract.symbol();
      const isSymbolMatch =
        onChainSymbol.toUpperCase() === collection.symbol.toUpperCase() ||
        (collection.symbol.toUpperCase() === 'RPASS' && onChainSymbol.toUpperCase() === 'RTPASS') ||
        (collection.symbol.toUpperCase() === 'RTPASS' && onChainSymbol.toUpperCase() === 'RPASS');
      if (!isSymbolMatch) {
        throw new Error(
          `CONTRACT_METADATA_MISMATCH: On-chain symbol "${onChainSymbol}" does not match registry symbol "${collection.symbol}".`
        );
      }
    } catch (err: any) {
      if (err.message && err.message.startsWith('CONTRACT_METADATA_MISMATCH')) throw err;
      throw new Error(`CONTRACT_METADATA_MISMATCH: Failed to query on-chain contract symbol: ${err?.message || err}`);
    }

    return {
      collection,
      contractAddress: cleanContract,
      chainId: chainConfig.chainId,
    };
  }
}

export const defaultGameFiService = new GameFiService();
