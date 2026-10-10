/**
 * tests/gamefi-contract-evm.test.ts
 *
 * MANDATORY EVM SECURITY INTEGRATION TEST SUITE:
 * Compiles `contracts/gamefi/RTraderTraderPass.sol` via solc, spins up a local
 * Foundry Anvil EVM, deploys the bytecode, and executes positive and negative
 * security vectors against the actual running EVM node.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync, spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const ANVIL_PORT = 8599;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

describe("RTraderTraderPass EVM Security & Standard Conformance Suite", () => {
  let anvilProcess: ChildProcess;
  let provider: ethers.JsonRpcProvider;
  let deployer: ethers.Wallet;
  let adminSigner: ethers.Wallet;
  let recipient: ethers.Wallet;
  let attacker: ethers.Wallet;
  let passContract: ethers.Contract;
  let passAddress: string;
  let abi: any[];
  let bytecode: string;

  beforeAll(async () => {
    const rootDir = path.resolve(__dirname, "..");
    const solPath = path.resolve(rootDir, "contracts/gamefi/RTraderTraderPass.sol");

    // 1. Compile contract with solc
    execSync(`npx solc --base-path . --include-path node_modules --optimize --bin --abi contracts/gamefi/RTraderTraderPass.sol`, {
      cwd: rootDir,
      stdio: "pipe",
    });

    const binFile = path.resolve(rootDir, "contracts_gamefi_RTraderTraderPass_sol_RTraderTraderPass.bin");
    const abiFile = path.resolve(rootDir, "contracts_gamefi_RTraderTraderPass_sol_RTraderTraderPass.abi");

    bytecode = "0x" + fs.readFileSync(binFile, "utf8").trim();
    abi = JSON.parse(fs.readFileSync(abiFile, "utf8"));

    // Cleanup all generated compiler artifacts
    try {
      const generated = fs.readdirSync(rootDir).filter((f) => f.startsWith("contracts_gamefi_RTraderTraderPass_sol_") || f.startsWith("@openzeppelin_contracts_"));
      for (const f of generated) {
        fs.unlinkSync(path.resolve(rootDir, f));
      }
    } catch {}

    // 2. Spawn local Anvil node
    anvilProcess = spawn("C:\\Users\\a\\.foundry\\bin\\anvil.exe", ["--port", String(ANVIL_PORT), "--silent"], {
      stdio: "ignore",
    });

    // Wait for Anvil to accept RPC requests
    provider = new ethers.JsonRpcProvider(RPC_URL);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        await provider.getBlockNumber();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error("Anvil failed to start within 4 seconds");

    // Pre-funded Anvil accounts
    const pks = [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ];

    deployer = new ethers.Wallet(pks[0], provider);
    adminSigner = new ethers.Wallet(pks[1], provider);
    recipient = new ethers.Wallet(pks[2], provider);
    attacker = new ethers.Wallet(pks[3], provider);

    // Deploy contract
    const factory = new ethers.ContractFactory(abi, bytecode, deployer);
    passContract = (await factory.deploy(adminSigner.address)) as ethers.Contract;
    await passContract.waitForDeployment();
    passAddress = await passContract.getAddress();
  }, 35000);

  afterAll(async () => {
    if (anvilProcess) {
      anvilProcess.kill();
    }
  });

  it("1. should deploy with valid ERC-721 metadata and admin signer", async () => {
    expect(await passContract.name()).toBe("RTrader Trader Pass");
    expect(await passContract.symbol()).toBe("RTPASS");
    expect(await passContract.totalSupply()).toBe(0n);
    expect(await passContract.adminSigner()).toBe(adminSigner.address);
    expect(await passContract.owner()).toBe(deployer.address);
  });

  it("2. should correctly implement ERC-165 interface detection", async () => {
    expect(await passContract.supportsInterface("0x01ffc9a7")).toBe(true); // ERC-165
    expect(await passContract.supportsInterface("0x80ac58cd")).toBe(true); // ERC-721
    expect(await passContract.supportsInterface("0x5b5e139f")).toBe(true); // ERC-721 Metadata
    expect(await passContract.supportsInterface("0xffffffff")).toBe(false); // Invalid
  });

  it("3. should execute valid genuine EIP-712 mint voucher on-chain", async () => {
    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const nonce = 1001n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const tier = "GOLD";
    const metadataUri = "ipfs://QmTestHash/gold.json";

    const domain = {
      name: "RTrader Trader Pass",
      version: "1",
      chainId,
      verifyingContract: passAddress,
    };

    const types = {
      MintVoucher: [
        { name: "recipient", type: "address" },
        { name: "tier", type: "string" },
        { name: "metadataUri", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      recipient: recipient.address,
      tier,
      metadataUri,
      nonce,
      deadline,
    };

    const signature = await adminSigner.signTypedData(domain, types, value);

    // Call mintWithVoucher as recipient
    const recipientContract = passContract.connect(recipient) as ethers.Contract;
    const tx = await recipientContract.mintWithVoucher(tier, metadataUri, nonce, deadline, signature);
    const receipt = await tx.wait();
    expect(receipt.status).toBe(1);

    expect(await passContract.totalSupply()).toBe(1n);
    expect(await passContract.ownerOf(1n)).toBe(recipient.address);
    expect(await passContract.balanceOf(recipient.address)).toBe(1n);
    expect(await passContract.tokenURI(1n)).toBe(metadataUri);
    expect(await passContract.tokenTiers(1n)).toBe("GOLD");
    expect(await passContract.usedNonces(nonce)).toBe(true);
  });

  it("4. should REVERT on-chain when attempting replay attack with used nonce", async () => {
    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const nonce = 1001n; // Already used above!
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const tier = "GOLD";
    const metadataUri = "ipfs://QmTestHash/gold.json";

    const domain = {
      name: "RTrader Trader Pass",
      version: "1",
      chainId,
      verifyingContract: passAddress,
    };

    const types = {
      MintVoucher: [
        { name: "recipient", type: "address" },
        { name: "tier", type: "string" },
        { name: "metadataUri", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      recipient: recipient.address,
      tier,
      metadataUri,
      nonce,
      deadline,
    };

    const signature = await adminSigner.signTypedData(domain, types, value);
    const recipientContract = passContract.connect(recipient) as ethers.Contract;

    await expect(
      recipientContract.mintWithVoucher(tier, metadataUri, nonce, deadline, signature)
    ).rejects.toThrow("NONCE_ALREADY_USED");
  });

  it("5. should REVERT on-chain when voucher deadline has expired", async () => {
    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const nonce = 1002n;
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 60); // 60s ago
    const tier = "SILVER";
    const metadataUri = "ipfs://QmTestHash/silver.json";

    const domain = {
      name: "RTrader Trader Pass",
      version: "1",
      chainId,
      verifyingContract: passAddress,
    };

    const types = {
      MintVoucher: [
        { name: "recipient", type: "address" },
        { name: "tier", type: "string" },
        { name: "metadataUri", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      recipient: recipient.address,
      tier,
      metadataUri,
      nonce,
      deadline: expiredDeadline,
    };

    const signature = await adminSigner.signTypedData(domain, types, value);
    const recipientContract = passContract.connect(recipient) as ethers.Contract;

    await expect(
      recipientContract.mintWithVoucher(tier, metadataUri, nonce, expiredDeadline, signature)
    ).rejects.toThrow("VOUCHER_EXPIRED");
  });

  it("6. should REVERT on-chain when voucher signature was created by unauthorized attacker", async () => {
    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const nonce = 1003n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const tier = "GOLD";
    const metadataUri = "ipfs://QmTestHash/fake.json";

    const domain = {
      name: "RTrader Trader Pass",
      version: "1",
      chainId,
      verifyingContract: passAddress,
    };

    const types = {
      MintVoucher: [
        { name: "recipient", type: "address" },
        { name: "tier", type: "string" },
        { name: "metadataUri", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      recipient: recipient.address,
      tier,
      metadataUri,
      nonce,
      deadline,
    };

    // Attacker signs voucher instead of authorized adminSigner
    const fakeSignature = await attacker.signTypedData(domain, types, value);
    const recipientContract = passContract.connect(recipient) as ethers.Contract;

    await expect(
      recipientContract.mintWithVoucher(tier, metadataUri, nonce, deadline, fakeSignature)
    ).rejects.toThrow("INVALID_VOUCHER_SIGNATURE");
  });

  it("7. should REVERT on-chain when replaying voucher across different contracts (cross-contract replay)", async () => {
    // Deploy a second contract instance sharing the same admin signer
    const factory = new ethers.ContractFactory(abi, bytecode, deployer);
    const secondContract = (await factory.deploy(adminSigner.address)) as ethers.Contract;
    await secondContract.waitForDeployment();
    const secondAddress = await secondContract.getAddress();

    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const nonce = 1004n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const tier = "GOLD";
    const metadataUri = "ipfs://QmTestHash/gold.json";

    // Voucher explicitly signed for first contract (passAddress)
    const domainForFirstContract = {
      name: "RTrader Trader Pass",
      version: "1",
      chainId,
      verifyingContract: passAddress,
    };

    const types = {
      MintVoucher: [
        { name: "recipient", type: "address" },
        { name: "tier", type: "string" },
        { name: "metadataUri", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const value = {
      recipient: recipient.address,
      tier,
      metadataUri,
      nonce,
      deadline,
    };

    const signature = await adminSigner.signTypedData(domainForFirstContract, types, value);

    // Attacker tries to submit this voucher to the second contract
    const secondRecipientContract = secondContract.connect(recipient) as ethers.Contract;
    await expect(
      secondRecipientContract.mintWithVoucher(tier, metadataUri, nonce, deadline, signature)
    ).rejects.toThrow("INVALID_VOUCHER_SIGNATURE");
  });

  it("8. should execute standard ERC-721 transfer and approval workflows on-chain", async () => {
    // Recipient owns tokenId 1 from test 3
    expect(await passContract.ownerOf(1n)).toBe(recipient.address);

    // Recipient approves attacker
    const recipientContract = passContract.connect(recipient) as ethers.Contract;
    let tx = await recipientContract.approve(attacker.address, 1n);
    await tx.wait();
    expect(await passContract.getApproved(1n)).toBe(attacker.address);

    // Attacker transfers tokenId 1 from recipient to deployer
    const attackerContract = passContract.connect(attacker) as ethers.Contract;
    tx = await attackerContract.transferFrom(recipient.address, deployer.address, 1n);
    await tx.wait();

    // Verify transfer success
    expect(await passContract.ownerOf(1n)).toBe(deployer.address);
    expect(await passContract.balanceOf(recipient.address)).toBe(0n);
    expect(await passContract.balanceOf(deployer.address)).toBe(1n);

    // Verify approval was cleared upon transfer
    expect(await passContract.getApproved(1n)).toBe(ethers.ZeroAddress);
  });
});
