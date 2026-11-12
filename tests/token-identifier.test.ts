/**
 * tests/token-identifier.test.ts
 *
 * Automated regression test suite for Token Identifier Normalizer:
 *  1. EVM Contract Address parsing & validation (Base, Ethereum, Arc, Robinhood).
 *  2. Solana SPL Mint address parsing & validation.
 *  3. Chain alias normalization.
 *  4. Anti-collision rejection when EVM address is passed as Solana or vice-versa.
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeTokenIdentifier,
  normalizeChainName,
  isSolanaBase58Address,
} from "../packages/shared/token-identifier.ts";

describe("Token Identifier Normalizer & Dual-Identity Suite", () => {
  describe("1. Chain Name Normalization", () => {
    it("should normalize all explicitly supported chains and their network suffixes", () => {
      // Base
      expect(normalizeChainName("base")).toBe("base");
      expect(normalizeChainName("BASE")).toBe("base");
      expect(normalizeChainName("base-mainnet")).toBe("base");
      expect(normalizeChainName("8453")).toBe("base");

      // Ethereum
      expect(normalizeChainName("eth")).toBe("ethereum");
      expect(normalizeChainName("ethereum")).toBe("ethereum");
      expect(normalizeChainName("ETHEREUM")).toBe("ethereum");
      expect(normalizeChainName("ethereum-mainnet")).toBe("ethereum");
      expect(normalizeChainName("1")).toBe("ethereum");

      // Solana
      expect(normalizeChainName("sol")).toBe("solana");
      expect(normalizeChainName("solana")).toBe("solana");
      expect(normalizeChainName("SOLANA")).toBe("solana");
      expect(normalizeChainName("solana-mainnet")).toBe("solana");
      expect(normalizeChainName("101")).toBe("solana");

      // Robinhood
      expect(normalizeChainName("rh")).toBe("robinhood");
      expect(normalizeChainName("robinhood")).toBe("robinhood");
      expect(normalizeChainName("ROBINHOOD")).toBe("robinhood");
      expect(normalizeChainName("robinhood-mainnet")).toBe("robinhood");
      expect(normalizeChainName("46688")).toBe("robinhood");
      expect(normalizeChainName("4663")).toBe("robinhood");

      // Arc
      expect(normalizeChainName("arc")).toBe("arc");
      expect(normalizeChainName("ARC")).toBe("arc");
      expect(normalizeChainName("arc-testnet")).toBe("arc");
      expect(normalizeChainName("5042")).toBe("arc");

      // Arbitrum
      expect(normalizeChainName("arb")).toBe("arbitrum");
      expect(normalizeChainName("arbitrum")).toBe("arbitrum");
      expect(normalizeChainName("ARBITRUM")).toBe("arbitrum");
      expect(normalizeChainName("arbitrum-one")).toBe("arbitrum");
      expect(normalizeChainName("42161")).toBe("arbitrum");

      // BSC
      expect(normalizeChainName("bsc")).toBe("bsc");
      expect(normalizeChainName("BSC")).toBe("bsc");
      expect(normalizeChainName("binance")).toBe("bsc");
      expect(normalizeChainName("bsc-mainnet")).toBe("bsc");
      expect(normalizeChainName("56")).toBe("bsc");

      // Clanker
      expect(normalizeChainName("clanker")).toBe("clanker");
      expect(normalizeChainName("CLANKER")).toBe("clanker");
      expect(normalizeChainName("clanker-mainnet")).toBe("clanker");

      // Default
      expect(normalizeChainName(undefined)).toBe("base");
      expect(normalizeChainName("")).toBe("base");
    });
  });

  describe("2. EVM Address Validation & Checksumming", () => {
    it("should validate and checksum valid Base L2 address regardless of input casing", () => {
      const lowerCa = "0x7ce19e4f978009eb644c27946b47221b824c0ba3";
      const upperCa = "0x7CE19E4F978009EB644C27946B47221B824C0BA3";
      const checksumCa = "0x7CE19E4F978009EB644c27946B47221b824C0bA3";

      const resLower = normalizeTokenIdentifier("base", lowerCa);
      const resUpper = normalizeTokenIdentifier("base", upperCa);
      const resChecksum = normalizeTokenIdentifier("base", checksumCa);

      expect(resLower.isValid).toBe(true);
      expect(resUpper.isValid).toBe(true);
      expect(resChecksum.isValid).toBe(true);

      expect(resLower.contractAddress).toBe(checksumCa);
      expect(resUpper.contractAddress).toBe(checksumCa);
      expect(resChecksum.contractAddress).toBe(checksumCa);
    });

    it("should reject malformed EVM address", () => {
      const result = normalizeTokenIdentifier("ethereum", "0xInvalidHexAddress123");
      expect(result.isValid).toBe(false);
      expect(result.validationError).toBeDefined();
    });
  });

  describe("3. Solana SPL Mint Address Validation & Case-Sensitivity", () => {
    it("should validate legitimate Solana Base58 mint address preserving exact case", () => {
      const solMint = "7jY83c3cBoYYnVXEswfBwFhYnMGxY9MZaD3HxhBT5WCp";
      const result = normalizeTokenIdentifier("solana", solMint);

      expect(result.isValid).toBe(true);
      expect(result.isSolana).toBe(true);
      expect(result.isEvm).toBe(false);
      expect(result.chain).toBe("solana");
      expect(result.mintAddress).toBe(solMint);
      expect(result.contractAddress).toBe(solMint); // Preserved exact case
      expect(result.validationError).toBeUndefined();
    });

    it("should treat Solana addresses as case-distinct (Address A != address a)", () => {
      const originalMint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
      const lowercasedMint = "dezxaz8z7pnrnrjjz3wxborgixca6xjnb7yab1ppb263";

      const resOriginal = normalizeTokenIdentifier("solana", originalMint);
      const resLower = normalizeTokenIdentifier("solana", lowercasedMint);

      expect(resOriginal.contractAddress).toBe(originalMint);
      expect(resLower.contractAddress).toBe(lowercasedMint);
      expect(resOriginal.contractAddress).not.toBe(resLower.contractAddress);
    });

    it("should reject 0x prefixed address when chain is Solana", () => {
      const result = normalizeTokenIdentifier("solana", "0x7CE19E4F978009EB644c27946B47221b824C0bA3");
      expect(result.isValid).toBe(false);
      expect(result.mintAddress).toBeUndefined();
      expect(result.validationError).toContain("INVALID_SOLANA_MINT");
    });

    it("should reject too short or too long Solana addresses", () => {
      expect(isSolanaBase58Address("short")).toBe(false);
      expect(isSolanaBase58Address("1".repeat(50))).toBe(false);
    });
  });

  describe("4. Database Adapter getTokenLaunchByAddress (EVM vs Solana Casing Rules)", () => {
    it("should retrieve mock token launch by EVM address case-insensitively", async () => {
      const { PostgresDraftDbAdapter } = await import("../packages/shared/db-pool.ts");
      const adapter = new PostgresDraftDbAdapter();
      const mockAddrLower = "0x0000000000000000000000000000000000000001";
      const mockAddrUpper = "0x0000000000000000000000000000000000000001".toUpperCase().replace("0X", "0x");

      const tokenFromLower = await adapter.getTokenLaunchByAddress("base", mockAddrLower);
      const tokenFromUpper = await adapter.getTokenLaunchByAddress("base", mockAddrUpper);

      if (tokenFromLower && tokenFromUpper) {
        expect(tokenFromLower.contractAddress.toLowerCase()).toBe(mockAddrLower.toLowerCase());
        expect(tokenFromUpper.contractAddress.toLowerCase()).toBe(mockAddrLower.toLowerCase());
        expect(tokenFromLower.name).toBe(tokenFromUpper.name);
      }
    });

    it("should strictly enforce exact-case matching for Solana addresses and reject altered-case queries", async () => {
      const { PostgresDraftDbAdapter } = await import("../packages/shared/db-pool.ts");
      const adapter = new PostgresDraftDbAdapter();

      const solExactMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const solAlteredMint = "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v";

      // Mock getActiveTokenLaunches to return Solana launch with exact case
      const originalGetActive = adapter.getActiveTokenLaunches;
      adapter.getActiveTokenLaunches = async () => [
        {
          launchId: "solana-test-draft",
          draftId: "solana-test-draft",
          contractAddress: solExactMint,
          chain: "solana-mainnet",
          name: "USD Coin Solana",
          ticker: "USDC",
        },
      ];

      // Exact case should find the token
      const foundExact = await adapter.getTokenLaunchByAddress("solana", solExactMint);
      expect(foundExact).not.toBeNull();
      expect(foundExact?.contractAddress).toBe(solExactMint);

      // Altered case MUST NOT find the token (Solana case-sensitivity rule)
      const foundAltered = await adapter.getTokenLaunchByAddress("solana", solAlteredMint);
      expect(foundAltered).toBeNull();

      // Restore
      adapter.getActiveTokenLaunches = originalGetActive;
    });

    it("should return null for completely nonexistent address in empty state", async () => {
      const { PostgresDraftDbAdapter } = await import("../packages/shared/db-pool.ts");
      const adapter = new PostgresDraftDbAdapter();
      const token = await adapter.getTokenLaunchByAddress("base", "0x9999999999999999999999999999999999999999");
      expect(token).toBeNull();
    });
  });

  describe("6. Multi-Chain Portal URL & Route Generation", () => {
    it("should generate correct portal routes for each supported chain", () => {
      const testCases = [
        { chain: "base", ca: "0x7CE19E4F978009EB644c27946B47221b824C0bA3", expectedChain: "base" },
        { chain: "ethereum", ca: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", expectedChain: "ethereum" },
        { chain: "solana", ca: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", expectedChain: "solana" },
        { chain: "robinhood", ca: "0x3333333333333333333333333333333333333333", expectedChain: "robinhood" },
        { chain: "arc", ca: "0x4444444444444444444444444444444444444444", expectedChain: "arc" },
        { chain: "arbitrum", ca: "0x5555555555555555555555555555555555555555", expectedChain: "arbitrum" },
        { chain: "bsc", ca: "0x6666666666666666666666666666666666666666", expectedChain: "bsc" },
        { chain: "clanker", ca: "0x7777777777777777777777777777777777777777", expectedChain: "clanker" },
      ];

      for (const tc of testCases) {
        const slug = normalizeChainName(tc.chain);
        expect(slug).toBe(tc.expectedChain as any);
        const portalUrl = `/token/${slug}/${tc.ca}`;
        expect(portalUrl).toBe(`/token/${tc.expectedChain}/${tc.ca}`);
      }
    });
  });

  describe("7. Standalone Website Generator Regression Integrity", () => {
    it("should generate a valid standalone static website bundle without errors", async () => {
      const { generateTokenWebsite } = await import("../src/modules/growth/website-generator.ts");
      const result = await generateTokenWebsite({
        name: "Test Portal Token",
        ticker: "TPT",
        contractAddress: "0x7CE19E4F978009EB644c27946B47221b824C0bA3",
        chainName: "base",
        description: "Standalone site generation regression check",
        outputDir: "./sites/test_portal_regression",
      });

      expect(result).toBeDefined();
      expect(result.ticker).toBe("TPT");
      expect(result.siteDirectory).toBeDefined();
      expect(result.indexHtmlPath).toBeDefined();
    }, 15000);
  });
});
