// ============================================================================
// ERC-4337 GASLESS PAYMASTER SERVICE (NON-CUSTODIAL REMOTE SIGNER)
// ============================================================================
//
// INVARIANT (AGENTS.md Invariant 3):
//   NEVER store private keys, seed phrases, or custody user funds in Vercel
//   environment variables or database tables.
//   This service delegates cryptographic signing to an isolated external signer/KMS.
//
// ============================================================================

import { ethers } from 'ethers';
import { PaymasterSponsorshipQuote } from '../shared/types/domain';

export interface IPaymasterSigner {
  signSponsorshipHash(structHash: string): Promise<{ signature: string; sponsorAddress: string }>;
  getSponsorAddress(): Promise<string>;
  isConfigured(): boolean;
}

export interface RemoteSignerConfig {
  signerUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Real client that communicates with an out-of-band isolated signing service or KMS.
 * Vercel stores ZERO private keys.
 */
export class RemotePaymasterSignerClient implements IPaymasterSigner {
  private signerUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(config: RemoteSignerConfig = {}) {
    this.signerUrl = (config.signerUrl || process.env.PAYMASTER_SIGNER_URL || '').trim();
    this.apiKey = (config.apiKey || process.env.PAYMASTER_SIGNER_API_KEY || '').trim();
    this.timeoutMs = config.timeoutMs || 5000;
  }

  isConfigured(): boolean {
    return Boolean(this.signerUrl && this.apiKey);
  }

  async getSponsorAddress(): Promise<string> {
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('PAYMASTER_SIGNER_UNCONFIGURED: PAYMASTER_SIGNER_URL and PAYMASTER_SIGNER_API_KEY must be configured in production.');
      }
      throw new Error('PAYMASTER_SIGNER_UNCONFIGURED: Remote paymaster signer endpoint is not configured.');
    }

    try {
      const res = await fetch(`${this.signerUrl}/address`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`Remote signer returned HTTP ${res.status}`);
      }

      const body = (await res.json()) as { success?: boolean; address?: string; data?: { address?: string } };
      const address = body.address || body.data?.address;
      if (!address || !ethers.isAddress(address)) {
        throw new Error('INVALID_REMOTE_SIGNER_ADDRESS: Malformed address returned from remote signer');
      }
      return ethers.getAddress(address);
    } catch (err: any) {
      throw new Error(`PAYMASTER_SIGNER_UNAVAILABLE: Failed to retrieve sponsor address: ${err?.message || String(err)}`);
    }
  }

  async signSponsorshipHash(structHash: string): Promise<{ signature: string; sponsorAddress: string }> {
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('PAYMASTER_SIGNER_UNCONFIGURED: PAYMASTER_SIGNER_URL and PAYMASTER_SIGNER_API_KEY must be configured in production.');
      }
      throw new Error('PAYMASTER_SIGNER_UNCONFIGURED: Remote paymaster signer endpoint is not configured.');
    }

    try {
      const res = await fetch(`${this.signerUrl}/sign`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ structHash }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Remote signer HTTP ${res.status}: ${errText || res.statusText}`);
      }

      const body = (await res.json()) as {
        success?: boolean;
        signature?: string;
        sponsorAddress?: string;
        data?: { signature?: string; sponsorAddress?: string };
      };

      const signature = body.signature || body.data?.signature;
      const sponsorAddress = body.sponsorAddress || body.data?.sponsorAddress;

      if (!signature || !sponsorAddress || !ethers.isAddress(sponsorAddress)) {
        throw new Error('MALFORMED_REMOTE_SIGNATURE: Remote signer returned incomplete signature payload');
      }

      return {
        signature,
        sponsorAddress: ethers.getAddress(sponsorAddress),
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.startsWith('PAYMASTER_SIGNER_UNCONFIGURED') || msg.startsWith('MALFORMED_REMOTE_SIGNATURE')) {
        throw err;
      }
      throw new Error(`PAYMASTER_SIGNER_UNAVAILABLE: ${msg}`);
    }
  }
}

/**
 * Mock signer for unit tests and local simulation only. Never used in production.
 */
export class MockPaymasterSigner implements IPaymasterSigner {
  private localWallet: ethers.HDNodeWallet | ethers.Wallet;

  constructor(wallet?: ethers.HDNodeWallet | ethers.Wallet) {
    this.localWallet = wallet || ethers.Wallet.createRandom();
  }

  isConfigured(): boolean {
    return true;
  }

  async getSponsorAddress(): Promise<string> {
    return this.localWallet.address;
  }

  async signSponsorshipHash(structHash: string): Promise<{ signature: string; sponsorAddress: string }> {
    const signature = await this.localWallet.signMessage(ethers.getBytes(structHash));
    return {
      signature,
      sponsorAddress: this.localWallet.address,
    };
  }
}

export interface PaymasterServiceConfig {
  signer?: IPaymasterSigner;
  defaultChainId?: number;
}

export class GaslessPaymasterService {
  private signer: IPaymasterSigner;
  private defaultChainId: number;

  constructor(config: PaymasterServiceConfig = {}) {
    this.defaultChainId = config.defaultChainId || 8453; // Base Mainnet default
    this.signer = config.signer || new RemotePaymasterSignerClient();
  }

  async getSponsorAddress(): Promise<string> {
    return this.signer.getSponsorAddress();
  }

  static computeSponsorshipHash(
    tokenAddress: string,
    kolWallet: string,
    tokenAmount: bigint,
    deadline: number,
    chainId: number
  ): string {
    if (!ethers.isAddress(tokenAddress)) throw new Error(`INVALID_TOKEN_ADDRESS: ${tokenAddress}`);
    if (!ethers.isAddress(kolWallet)) throw new Error(`INVALID_KOL_WALLET: ${kolWallet}`);

    return ethers.solidityPackedKeccak256(
      ['address', 'address', 'uint256', 'uint256', 'uint256'],
      [
        ethers.getAddress(tokenAddress),
        ethers.getAddress(kolWallet),
        tokenAmount,
        deadline,
        chainId,
      ]
    );
  }

  async signSponsorship(
    tokenAddress: string,
    kolWallet: string,
    tokenAmount: bigint,
    validitySeconds: number = 3600,
    chainId?: number
  ): Promise<PaymasterSponsorshipQuote> {
    const targetChainId = chainId || this.defaultChainId;
    const deadline = Math.floor(Date.now() / 1000) + validitySeconds;

    const hash = GaslessPaymasterService.computeSponsorshipHash(
      tokenAddress,
      kolWallet,
      tokenAmount,
      deadline,
      targetChainId
    );

    // Delegate EIP-191 signing to remote isolated signer (No private key in Vercel)
    const { signature, sponsorAddress } = await this.signer.signSponsorshipHash(hash);

    return {
      sponsorAddress: ethers.getAddress(sponsorAddress),
      sponsoredTxType: 'BOUNTY_CLAIM',
      kolWallet: ethers.getAddress(kolWallet),
      tokenAddress: ethers.getAddress(tokenAddress),
      tokenAmount: tokenAmount.toString(),
      deadline,
      chainId: targetChainId,
      signature,
    };
  }

  verifySignature(quote: PaymasterSponsorshipQuote, expectedSponsorAddress?: string): boolean {
    return GaslessPaymasterService.verifySignature(quote, expectedSponsorAddress);
  }

  static verifySignature(quote: PaymasterSponsorshipQuote, expectedSponsorAddress?: string): boolean {
    try {
      const hash = GaslessPaymasterService.computeSponsorshipHash(
        quote.tokenAddress,
        quote.kolWallet,
        BigInt(quote.tokenAmount),
        quote.deadline,
        quote.chainId
      );
      const recovered = ethers.verifyMessage(ethers.getBytes(hash), quote.signature);
      const target = expectedSponsorAddress || quote.sponsorAddress;
      return recovered.toLowerCase() === target.toLowerCase();
    } catch {
      return false;
    }
  }
}
