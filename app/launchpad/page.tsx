'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { Rocket, ShieldAlert, FileText, CheckCircle2, AlertTriangle, TrendingUp, Scale, Wallet, Users, Tag, Sparkles, Coins, Zap, Search, Copy, Check } from 'lucide-react';
import { NutritionLabelCard } from '../components/NutritionLabelCard';
import { AngelDealRoomModal } from '../components/AngelDealRoomModal';
import { AdminMerkleSnapshotPanel } from '../components/AdminMerkleSnapshotPanel';
import { CreatorStudioPanel } from '../components/CreatorStudioPanel';
import { PageWorkflowBanner } from '../components/PageWorkflowBanner';
import { TokenAvatar } from '../components/TokenAvatar';
import { BankrKeyVaultPanel } from '../components/BankrKeyVaultPanel';
import { ethers } from 'ethers';
import {
  getContractConfiguration,
  ensureBaseNetwork,
  getBrowserSigner,
  getLaunchpadContract,
  normalizeWeb3Error,
  getExplorerUrl,
} from '@packages/launchpad/web3-provider';
import { normalizeChainName } from '@packages/shared/token-identifier';
import {
  filterAndSortLaunchTokens,
  normalizeDiscoveryChain,
  computeGraduationProgressPct,
  LaunchpadSortMode,
} from '@packages/shared/launchpad-discovery';

export type LaunchModeType = 'BONDING_CURVE' | 'FAIR_LAUNCH' | 'WHITELIST_PRIVATE' | 'FIXED_PRICE' | 'COMMUNITY_PRELAUNCH';

export default function LaunchpadPage() {
  const { isConnected, userRole, entitlements, walletAddress, connectMetaMask, isConnecting, refreshSession, switchNetwork, hasCapability, planId, credits } = useAuth();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selectedBankrKeyId, setSelectedBankrKeyId] = useState<string>('PLATFORM_DEFAULT');
  const [ssotFactoryAddress, setSsotFactoryAddress] = useState<string>('');
  const [billingConfig, setBillingConfig] = useState<{
    treasuryFeePct: number;
    creatorFeePct: number;
    launchCostCr: number;
    studioCostCr: number;
  }>({
    treasuryFeePct: 0.5,
    creatorFeePct: 0.5,
    launchCostCr: 50,
    studioCostCr: 1,
  });
  const [feeRecipientType, setFeeRecipientType] = useState<'wallet' | 'x' | 'farcaster' | 'ens'>('wallet');
  const [feeRecipientHandle, setFeeRecipientHandle] = useState<string>('');
  const [isAngelModalOpen, setIsAngelModalOpen] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [tokenDescription, setTokenDescription] = useState('');
  const [tokenImageUrl, setTokenImageUrl] = useState('');
  const [mode, setMode] = useState<LaunchModeType>('BONDING_CURVE');
  const [creatorWallet, setCreatorWallet] = useState(walletAddress || '');
  const [whitelistWallets, setWhitelistWallets] = useState('');
  const [fixedPriceEth, setFixedPriceEth] = useState('0.0001');
  const [fundingGoalEth, setFundingGoalEth] = useState('25');
  const [draftResult, setDraftResult] = useState<any>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTokens, setActiveTokens] = useState<any[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = useState(false);

  // Discovery Filter & Sort State (Live Token Fleet)
  const [tokenSearch, setTokenSearch] = useState('');
  const [chainFilter, setChainFilter] = useState<string>('all');
  const [sortMode, setSortMode] = useState<LaunchpadSortMode>('trending');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  const chainCounts = useMemo(() => {
    const counts: Record<string, number> = { all: activeTokens.length };
    for (const t of activeTokens) {
      const c = normalizeDiscoveryChain(t.chain);
      counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }, [activeTokens]);

  const filteredTokens = useMemo(
    () =>
      filterAndSortLaunchTokens(activeTokens, {
        search: tokenSearch,
        chain: chainFilter,
        sort: sortMode,
      }),
    [activeTokens, tokenSearch, chainFilter, sortMode]
  );

  // 4 Launchpad Alignment Dimensions (Chain, Pairing, Degen Mode, Vesting)
  const [selectedChain, setSelectedChain] = useState<'base' | 'robinhood' | 'arbitrum' | 'arc'>('base');
  const [poolPairing, setPoolPairing] = useState<'WETH' | 'MORE_TOKENS' | 'STOCKS'>('WETH');
  const [isDegenMode, setIsDegenMode] = useState<boolean>(true);
  const [creatorVesting, setCreatorVesting] = useState<'NONE' | '15_PERCENT'>('NONE');
  const [showAdvancedOptions, setShowAdvancedOptions] = useState<boolean>(false);

  const fetchActiveTokens = async () => {
    setIsLoadingTokens(true);
    try {
      const res = await fetch('/api/launchpad/tokens');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setActiveTokens(json.data);
      }
    } catch {
      // Graceful fallback
    } finally {
      setIsLoadingTokens(false);
    }
  };

  useEffect(() => {
    fetchActiveTokens();
    fetch('/api/billing/plans')
      .then((r) => r.json())
      .then((json) => {
        const cfg = json?.platformConfig;
        const addr = cfg?.launchpadContractAddress;
        if (typeof addr === 'string' && addr.trim()) {
          setSsotFactoryAddress(addr.trim());
          if (typeof window !== 'undefined') {
            (window as any).__RTRADER_LAUNCHPAD_CONTRACT__ = addr.trim();
          }
        }
        if (cfg) {
          setBillingConfig({
            treasuryFeePct: Number(cfg.treasuryFeePct ?? 0.5),
            creatorFeePct: Number(cfg.creatorFeePct ?? 0.5),
            launchCostCr: Number(cfg.launchCostCr ?? 50),
            studioCostCr: Number(cfg.studioCostCr ?? 1),
          });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (walletAddress) {
      setCreatorWallet(walletAddress);
    }
  }, [walletAddress]);

  const [draftError, setDraftError] = useState<string | null>(null);

  const handleCreateDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenName || !tokenSymbol) return;

    setIsCreating(true);
    setDraftError(null);
    try {
      const res = await fetch('/api/launchpad/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tokenName,
          ticker: tokenSymbol.toUpperCase(),
          description: `Launch draft for ${tokenName} on ${mode} (${selectedChain.toUpperCase()})`,
          imageUrl: '/token-default.svg',
          launchMode: mode,
          targetChain: selectedChain === 'base' ? 'base-mainnet' : `${selectedChain}-mainnet`,
          totalSupply: '1000000000',
          creatorAllocationPct: creatorVesting === '15_PERCENT' ? 0.15 : 0.0,
          creatorWallet: walletAddress || creatorWallet,
          socialLinks: {
            whitelist_wallets: whitelistWallets,
            fixed_price_eth: fixedPriceEth,
            funding_goal_eth: fundingGoalEth,
            selected_chain: selectedChain,
            pool_pairing: poolPairing,
            degen_mode: isDegenMode ? 'true' : 'false',
            creator_vesting: creatorVesting,
          },
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        const errorMsg = json.error?.message || 'Gagal membuat draft launchpad';
        if (res.status === 403) {
          setDraftError('🛡️ Akses Ditolak (403 Forbidden): Akun Anda memerlukan hak akses CREATOR atau ADMIN untuk membuat draft launchpad.');
        } else if (res.status === 401) {
          setDraftError('⚠️ Autentikasi Diperlukan (401 Unauthorized): Harap masuk via MetaMask SIWE terlebih dahulu.');
        } else {
          setDraftError(`❌ Gagal: ${errorMsg}`);
        }
        return;
      }

      setDraftResult(json.data);
    } catch (err: any) {
      setDraftError(`Koneksi gagal: ${err.message || 'Tidak dapat menghubungi server'}`);
    } finally {
      setIsCreating(false);
    }
  };

  const [isRegisteringOnChain, setIsRegisteringOnChain] = useState(false);
  const [isBankrDeploying, setIsBankrDeploying] = useState(false);
  const [onChainFeedback, setOnChainFeedback] = useState<string | null>(null);
  const [publishedTxHash, setPublishedTxHash] = useState<string | null>(null);
  const [onChainTokenAddress, setOnChainTokenAddress] = useState<string>('');

  const handleBankrDeploy = async (simulateOnly: boolean) => {
    if (!draftResult) return;
    setIsBankrDeploying(true);
    setOnChainFeedback(null);
    try {
      const recipientAddr = (walletAddress || creatorWallet || '').trim();
      const customHandle = feeRecipientHandle.trim();
      const resolvedFeeRecipient =
        feeRecipientType === 'wallet'
          ? recipientAddr
            ? { type: 'wallet' as const, value: recipientAddr }
            : undefined
          : customHandle
          ? { type: feeRecipientType, value: customHandle }
          : recipientAddr
          ? { type: 'wallet' as const, value: recipientAddr }
          : undefined;
      const res = await fetch('/api/launchpad/bankr-deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draftId: draftResult.id || draftResult.draftId,
          tokenName: draftResult.name || tokenName,
          tokenSymbol: draftResult.ticker || draftResult.symbol || tokenSymbol,
          chain: selectedChain,
          feeRecipient: resolvedFeeRecipient,
          degenMode: isDegenMode,
          simulateOnly,
          providerKeyId: selectedBankrKeyId,
          ...(tokenDescription.trim() ? { description: tokenDescription.trim() } : {}),
          ...(tokenImageUrl.trim() ? { imageUrl: tokenImageUrl.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || 'Bankr deploy failed';
        setOnChainFeedback(`❌ Bankr Deploy (${res.status}): ${errMsg}`);
        return;
      }
      const d = json.data || {};
      if (d.tokenAddress) setOnChainTokenAddress(d.tokenAddress);
      if (d.txHash) setPublishedTxHash(d.txHash);
      refreshSession().catch(() => {});
      fetchActiveTokens();
      const keyBadge = d.keySource === 'BYOK_VAULT' ? ` [BYOK: ${d.usedKeyLabel || d.usedKeyMasked}]` : ' [Platform Key]';
      setOnChainFeedback(
        `✅ Bankr ${d.status?.toUpperCase() || 'DEPLOYED'}${keyBadge}: $${d.tokenSymbol || tokenSymbol} on ${selectedChain.toUpperCase()} (${d.tokenAddress || 'Simulated CA'}) · -${d.creditsBurned ?? 50} Credits`
      );
    } catch (err: any) {
      setOnChainFeedback(`❌ Bankr Deploy Error: ${err?.message || 'Network error'}`);
    } finally {
      setIsBankrDeploying(false);
    }
  };

  const handleRegisterOnChain = async () => {
    if (!draftResult) return;
    setIsRegisteringOnChain(true);
    setOnChainFeedback(null);
    try {
      if (!walletAddress) {
        setOnChainFeedback('⚠️ Silakan hubungkan dompet Web3 MetaMask terlebih dahulu.');
        return;
      }

      // 1. Access Control Invariant Check (onlyOwner in BondingCurveLaunchpad.sol)
      if (userRole !== 'SYSTEM_ADMIN' && userRole !== 'SUPER_ADMIN') {
        setOnChainFeedback(
          '🛡️ Akses Terbatas: Pendaftaran token launchpad on-chain memerlukan hak otorisasi Platform Admin / Contract Owner. Draft Anda telah disimpan di SSOT untuk diproses oleh controller.'
        );
        return;
      }

      // 2. Contract Configuration Verification Gate (Rule 6)
      const contractConfig = getContractConfiguration(ssotFactoryAddress);
      if (!contractConfig.isConfigured || !contractConfig.contractAddress) {
        setOnChainFeedback(`❌ ${contractConfig.message}`);
        return;
      }

      // 3. Multi-Chain Network Switching & Validation (Rule 8 — fail closed on unsupported live chains)
      if (selectedChain === 'arbitrum' || selectedChain === 'arc') {
        setOnChainFeedback(
          `⛔ Pendaftaran langsung on-chain untuk ${selectedChain.toUpperCase()} belum aktif di BondingCurveLaunchpad.sol. Gunakan Base L2 atau Robinhood Chain L2.`
        );
        return;
      }

      const trimmedTokenAddr = onChainTokenAddress.trim();
      if (!trimmedTokenAddr || !ethers.isAddress(trimmedTokenAddr)) {
        setOnChainFeedback(
          '⚠️ Masukkan alamat kontrak token ERC-20 yang sudah ter-deploy (0x...) sebelum mendaftarkan ke BondingCurveLaunchpad.'
        );
        return;
      }

      const isRobinhood = selectedChain === 'robinhood';
      const targetChainHex = isRobinhood ? '0x1237' : '0x2105';
      const targetChainKey = isRobinhood ? 'robinhood-mainnet' : 'base-mainnet';
      const chainName = isRobinhood ? 'Robinhood Chain L2' : 'Base';
      const explorerName = isRobinhood ? 'Blockscout' : 'BaseScan';

      const networkCheck = await ensureBaseNetwork(targetChainHex);
      if (!networkCheck.success) {
        setOnChainFeedback(`❌ ${networkCheck.error || `Harap beralih ke jaringan ${chainName}`}`);
        return;
      }

      // 4. Mode mapping to enum integer (0: FAIR_LAUNCH, 1: BONDING_CURVE, 2: FIXED_PRICE, 3: WHITELIST_PRIVATE, 4: COMMUNITY_PRELAUNCH)
      const modeMap: Record<string, number> = {
        FAIR_LAUNCH: 0,
        BONDING_CURVE: 1,
        FIXED_PRICE: 2,
        WHITELIST_PRIVATE: 3,
        COMMUNITY_PRELAUNCH: 4,
      };
      const draftMode = draftResult.launchMode || draftResult.mode;
      const draftTicker = draftResult.ticker || draftResult.symbol;
      const modeInt = modeMap[draftMode] ?? 1;

      // 5. Real Contract Call via MetaMask Signer
      setOnChainFeedback(`⏳ Menyiapkan pendaftaran token on-chain di ${chainName}...`);
      const signer = await getBrowserSigner();
      const contract = getLaunchpadContract(signer, ssotFactoryAddress);

      const verifiedTokenAddress = ethers.getAddress(trimmedTokenAddr);
      const totalSupplyWei = ethers.parseEther('1000000000');
      const initialPriceWei = ethers.parseEther('0.00000002');
      const graduationThresholdWei = ethers.parseEther('24');
      const maxPerWalletPct = 100n;
      const merkleRoot = draftResult.merkleRoot || ethers.ZeroHash;

      setOnChainFeedback('⏳ Menunggu tanda tangan transaksi pendaftaran di MetaMask...');
      const tx = await contract.registerTokenLaunch(
        verifiedTokenAddress,
        draftResult.name,
        draftTicker,
        totalSupplyWei,
        initialPriceWei,
        graduationThresholdWei,
        maxPerWalletPct,
        modeInt,
        merkleRoot
      );

      setOnChainFeedback(`📡 Transaksi terkirim: ${tx.hash}. Menunggu konfirmasi blok ${chainName}...`);
      const receipt = await tx.wait(1);

      if (receipt && receipt.status === 1) {
        setPublishedTxHash(tx.hash);
        const explorerLink = getExplorerUrl(tx.hash, targetChainHex, 'tx');

        // Persist token launch to PostgreSQL SSOT via /api/launchpad/publish
        try {
          const pubRes = await fetch('/api/launchpad/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              draftId: draftResult.id || draftResult.draftId,
              contractAddress: verifiedTokenAddress,
              chain: targetChainKey,
              txHash: tx.hash,
              currentSupply: '1000000000',
              graduationThreshold: isDegenMode ? 2500 : 69000,
            }),
          });
          if (!pubRes.ok) {
            const pubErr = await pubRes.json().catch(() => ({}));
            setOnChainFeedback(
              `✅ Token $${draftTicker} terdaftar on-chain (Hash: ${tx.hash}), tetapi sinkronisasi SSOT gagal: ${pubErr?.error?.message || `HTTP ${pubRes.status}`}`
            );
            return;
          }
          // Refresh active token fleet in UI
          fetchActiveTokens();
          refreshSession().catch(() => {});
        } catch (pubCatchErr: any) {
          setOnChainFeedback(
            `✅ Token $${draftTicker} terdaftar on-chain (Hash: ${tx.hash}), tetapi sinkronisasi SSOT gagal: ${pubCatchErr?.message || 'Network error'}`
          );
          return;
        }

        setOnChainFeedback(
          `✅ Token $${draftTicker} BERHASIL DIDAFTARKAN ON-CHAIN! Blok #${receipt.blockNumber}. Hash: ${tx.hash} — Lihat di ${explorerName}: ${explorerLink}`
        );
      } else {
        setOnChainFeedback(`❌ Transaksi gagal dieksekusi di blockchain ${chainName}.`);
      }
    } catch (err: any) {
      setOnChainFeedback(`❌ Gagal pendaftaran on-chain: ${normalizeWeb3Error(err)}`);
    } finally {
      setIsRegisteringOnChain(false);
    }
  };

  return (
    <div className="flex-col gap-lg">
      {/* Top Banner */}
      <div className="bg-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px', borderRadius: '8px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 900, margin: '0 0 4px 0', color: '#00E5FF', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Rocket size={20} /> Degen Token Launchpad & Wizard
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            Create pump.fun style fair launches and bonding curve tokens backed by Arkham creator risk passports.
          </p>
        </div>
        <div className="flex-row gap-sm items-center">
          <button
            type="button"
            onClick={() => setIsAngelModalOpen(true)}
            className="badge badge-admin"
            style={{ cursor: 'pointer', border: '1px solid #D500F9', color: '#E040FB', backgroundColor: '#1A0826', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Users size={14} /> 👑 ANGEL DEAL ROOM
          </button>
          {(userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
            <span className="badge badge-admin">
              👑 LAUNCHPAD CONTROLLER ACTIVE
            </span>
          )}
          <span className="badge badge-trader" style={{ border: '1px solid #00E5FF', color: '#00E5FF', backgroundColor: '#071A2E' }}>
            5 MODES ACTIVE
          </span>
        </div>
      </div>

      {/* Workflow & Plan Entitlement Guide */}
      <PageWorkflowBanner
        title="Alur Peluncuran Token"
        isUnlocked={Boolean(entitlements.createLaunch)}
        requiredPlanLabel="CREATOR / AGENT"
        creditSummary="Studio: -1 cr · Draft: Gratis · Deploy: -50 cr"
        steps={[
          { step: '1', label: 'AI Creator Studio', cost: '-1 cr' },
          { step: '2', label: 'Buat Draft & Risk Passport', cost: 'Gratis' },
          { step: '3', label: 'Bankr Deploy / On-Chain Contract', cost: '-50 cr / Gas' },
          { step: '4', label: 'Token Portal & KOL Bounty', cost: 'Live' },
        ]}
      />

      {/* Angel Deal Room Modal */}
      <AngelDealRoomModal
        isOpen={isAngelModalOpen}
        onClose={() => setIsAngelModalOpen(false)}
        connectedWallet={walletAddress}
      />

      {/* Vercel-Native Creator Asset Studio & Growth Launch Pack */}
      <CreatorStudioPanel
        tokenName={tokenName}
        tokenSymbol={tokenSymbol}
        selectedChain={selectedChain}
        onApplyIdentity={(name, ticker) => {
          setTokenName(name);
          setTokenSymbol(ticker);
        }}
        onApplyAssets={({ name, ticker, description, imageUrl }) => {
          if (name) setTokenName(name);
          if (ticker) setTokenSymbol(ticker);
          if (description) setTokenDescription(description);
          if (imageUrl) setTokenImageUrl(imageUrl);
        }}
      />

      <div className="grid-2">
        {/* Left Column: Interactive Token Launch Form */}
        <div className="bg-panel" style={{ borderRadius: '8px', padding: '24px' }}>
          <h2 style={{ color: 'var(--color-foreground)', marginTop: 0, fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <FileText size={18} /> Launch Token Draft Wizard
          </h2>
          {(tokenImageUrl || tokenDescription) && (
            <div
              style={{
                marginBottom: '12px',
                padding: '8px 10px',
                borderRadius: '8px',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                background: 'rgba(16, 185, 129, 0.08)',
                fontSize: '11px',
                color: 'var(--color-foreground)',
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
              }}
            >
              <strong style={{ color: '#10B981' }}>✅ Aset Creator Studio Terhubung ke Wizard</strong>
              {tokenImageUrl && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--color-muted)', wordBreak: 'break-all' }}>
                  IPFS Image: {tokenImageUrl}
                </span>
              )}
              {tokenDescription && (
                <span style={{ fontSize: '11px', color: 'var(--color-muted)' }}>{tokenDescription}</span>
              )}
            </div>
          )}
          <form onSubmit={handleCreateDraft} className="flex-col gap-md">
            <div className="flex-col gap-xs">
              <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Token Name</label>
              <input
                type="text"
                placeholder="e.g. Degen Moon Alpha"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                className="input"
                style={{ padding: '12px' }}
                required
              />
            </div>

            <div className="flex-col gap-xs">
              <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Token Symbol</label>
              <input
                type="text"
                placeholder="e.g. MOON"
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value)}
                className="input"
                style={{ padding: '12px', color: 'var(--color-accent)', fontWeight: 800, fontFamily: 'var(--font-mono)' }}
                required
              />
            </div>

            <div className="flex-col gap-xs">
              <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Launch Model (5 Deployment Modes Available)</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setMode('BONDING_CURVE')}
                  className={mode === 'BONDING_CURVE' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '10px 6px', justifyContent: 'center', fontSize: '11px' }}
                >
                  <TrendingUp size={14} className="inline mr-1" /> Bonding Curve
                </button>
                <button
                  type="button"
                  onClick={() => setMode('FAIR_LAUNCH')}
                  className={mode === 'FAIR_LAUNCH' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '10px 6px', justifyContent: 'center', fontSize: '11px' }}
                >
                  <Scale size={14} className="inline mr-1" /> Fair Launch
                </button>
                <button
                  type="button"
                  onClick={() => setMode('WHITELIST_PRIVATE')}
                  className={mode === 'WHITELIST_PRIVATE' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '10px 6px', justifyContent: 'center', fontSize: '11px', border: mode === 'WHITELIST_PRIVATE' ? '1px solid #D500F9' : undefined }}
                >
                  <Users size={14} className="inline mr-1" /> Angel Whitelist
                </button>
                <button
                  type="button"
                  onClick={() => setMode('FIXED_PRICE')}
                  className={mode === 'FIXED_PRICE' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '10px 6px', justifyContent: 'center', fontSize: '11px' }}
                >
                  <Tag size={14} className="inline mr-1" /> Fixed Price
                </button>
                <button
                  type="button"
                  onClick={() => setMode('COMMUNITY_PRELAUNCH')}
                  className={mode === 'COMMUNITY_PRELAUNCH' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '10px 6px', justifyContent: 'center', fontSize: '11px' }}
                >
                  <Sparkles size={14} className="inline mr-1" /> Community
                </button>
              </div>
            </div>

            {/* Dynamic Mode-Specific Settings */}
            {mode === 'WHITELIST_PRIVATE' && (
              <div className="flex-col gap-xs" style={{ backgroundColor: '#1A0826', border: '1px solid #D500F9', padding: '12px', borderRadius: '6px' }}>
                <label style={{ color: '#E040FB', fontSize: '11px', fontWeight: 800 }}>👑 Angel Investor Whitelist Addresses (Merkle Proofs)</label>
                <textarea
                  placeholder="0x123...abc, 0x456...def (Comma-separated investor wallets)"
                  value={whitelistWallets}
                  onChange={(e) => setWhitelistWallets(e.target.value)}
                  className="input"
                  style={{ padding: '8px', fontSize: '11px', fontFamily: 'var(--font-mono)', minHeight: '60px' }}
                />
                <span className="text-muted" style={{ fontSize: '10px' }}>Only whitelisted angel wallets can claim allocated seed tokens.</span>
              </div>
            )}

            {mode === 'FIXED_PRICE' && (
              <div className="flex-col gap-xs" style={{ backgroundColor: '#071A2E', border: '1px solid #00E5FF', padding: '12px', borderRadius: '6px' }}>
                <label style={{ color: '#00E5FF', fontSize: '11px', fontWeight: 800 }}>🏷️ Fixed Price Per Token (in ETH)</label>
                <input
                  type="text"
                  value={fixedPriceEth}
                  onChange={(e) => setFixedPriceEth(e.target.value)}
                  className="input"
                  style={{ padding: '8px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            )}

            {mode === 'COMMUNITY_PRELAUNCH' && (
              <div className="flex-col gap-xs" style={{ backgroundColor: '#041E15', border: '1px solid var(--color-accent)', padding: '12px', borderRadius: '6px' }}>
                <label style={{ color: 'var(--color-accent)', fontSize: '11px', fontWeight: 800 }}>🤝 Target Funding Goal (in ETH)</label>
                <input
                  type="text"
                  value={fundingGoalEth}
                  onChange={(e) => setFundingGoalEth(e.target.value)}
                  className="input"
                  style={{ padding: '8px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
                <span className="text-muted" style={{ fontSize: '10px' }}>Tokens only mint if funding goal is reached before the deadline.</span>
              </div>
            )}

            {/* Target Blockchain & Relayer Gate */}
            <div className="flex-col gap-xs">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>
                  Target Blockchain & Gas Relayer
                </label>
                <span style={{ fontSize: '10px', color: selectedChain === 'base' ? 'var(--color-accent)' : '#FFAB00', fontWeight: 700 }}>
                  {selectedChain === 'base' ? '⚡ 100% Gas Sponsored by Bankr' : '⚠️ Gas Sponsorship Policy Active'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setSelectedChain('base')}
                  className={selectedChain === 'base' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Base L2</span>
                  <span style={{ fontSize: '9px', color: 'var(--color-accent)' }}>✅ Ready (Sponsored)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedChain('robinhood')}
                  className={selectedChain === 'robinhood' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Robinhood</span>
                  <span style={{ fontSize: '9px', color: '#FF5252' }}>⛔ Blocked in Live</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedChain('arbitrum')}
                  className={selectedChain === 'arbitrum' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Arbitrum</span>
                  <span style={{ fontSize: '9px', color: '#FF5252' }}>⛔ Blocked in Live</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedChain('arc')}
                  className={selectedChain === 'arc' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Arc Network</span>
                  <span style={{ fontSize: '9px', color: '#00E5FF' }}>⚡ ArcPad Ready</span>
                </button>
              </div>

              {selectedChain === 'robinhood' && (
                <div style={{ backgroundColor: '#2A0808', border: '1px solid #FF5252', padding: '8px 10px', borderRadius: '4px', fontSize: '11px', color: '#FF8A80' }}>
                  ℹ️ <strong>Subsidi Gas Khusus Base L2:</strong> Deploy gratis tanpa gas saat ini khusus di Base L2. Untuk Robinhood L2, silakan gunakan Mode Simulasi atau deploy memakai dompet Anda sendiri.
                </div>
              )}
              {selectedChain === 'arbitrum' && (
                <div style={{ backgroundColor: '#2A0808', border: '1px solid #FF5252', padding: '8px 10px', borderRadius: '4px', fontSize: '11px', color: '#FF8A80' }}>
                  ℹ️ <strong>Subsidi Gas Khusus Base L2:</strong> Untuk Arbitrum, saat ini tersedia dalam Mode Simulasi atau deploy memakai dompet Anda sendiri.
                </div>
              )}
              {selectedChain === 'arc' && (
                <div style={{ backgroundColor: 'var(--color-badge-info-bg)', border: '1px solid var(--color-badge-info-border)', padding: '8px 10px', borderRadius: '6px', fontSize: '11px', color: 'var(--color-badge-info-text)' }}>
                  ⚡ <strong>Arc Network:</strong> Siap untuk peluncuran simulasi maupun kontrak native Arc Network.
                </div>
              )}
            </div>

            {/* Accordion Toggle for Advanced Settings (Simple Mode by default) */}
            <button
              type="button"
              onClick={() => setShowAdvancedOptions((v) => !v)}
              className="btn-secondary"
              style={{ width: '100%', justifyContent: 'space-between', padding: '8px 12px', fontSize: '11px', color: 'var(--color-foreground)' }}
            >
              <span>
                ⚙️ Pengaturan Lanjutan (Pairing: {poolPairing} · {isDegenMode ? 'Degen $2.5k' : 'Standard $69k'} · Royalty: {billingConfig.creatorFeePct}% · Deploy: -{billingConfig.launchCostCr} cr)
              </span>
              <span>{showAdvancedOptions ? '▲ Sembunyikan' : '▼ Ubah'}</span>
            </button>

            {showAdvancedOptions && (
              <div className="flex-col gap-md" style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-subtle)' }}>
            {/* Pool Pairing & Launch Profile */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="flex-col gap-xs">
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Pool Pairing</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    onClick={() => setPoolPairing('WETH')}
                    className={poolPairing === 'WETH' ? 'btn-primary' : 'btn-secondary'}
                    style={{ flex: 1, padding: '8px 4px', fontSize: '10px', justifyContent: 'center' }}
                  >
                    WETH ✅
                  </button>
                  <button
                    type="button"
                    onClick={() => setPoolPairing('MORE_TOKENS')}
                    className={poolPairing === 'MORE_TOKENS' ? 'btn-primary' : 'btn-secondary'}
                    style={{ flex: 1, padding: '8px 4px', fontSize: '10px', justifyContent: 'center' }}
                    title="Base Quote Tokens: BNKR, ba3Pump, cbHYPE, cbZEC, TAO"
                  >
                    Tokens
                  </button>
                  <button
                    type="button"
                    disabled
                    className="btn-secondary"
                    style={{ flex: 1, padding: '8px 4px', fontSize: '10px', justifyContent: 'center', opacity: 0.35, cursor: 'not-allowed' }}
                    title="Stocks belum memiliki mapping contract tokenized-stock di backend."
                  >
                    Stocks ⛔
                  </button>
                </div>
                {poolPairing === 'MORE_TOKENS' && (
                  <span style={{ fontSize: '10px', color: 'var(--color-accent)' }}>
                    Base Quotes: BNKR, ba3Pump, cbHYPE, cbZEC, TAO.
                  </span>
                )}
              </div>

              {/* Degen Mode Toggle */}
              <div className="flex-col gap-xs">
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Launch Profile</label>
                <button
                  type="button"
                  onClick={() => setIsDegenMode(!isDegenMode)}
                  className={isDegenMode ? 'btn-primary' : 'btn-secondary'}
                  style={{
                    padding: '8px 10px',
                    fontSize: '11px',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    border: isDegenMode ? '1px solid var(--color-accent)' : undefined,
                  }}
                >
                  <span>🔥 Degen Mode</span>
                  <span style={{ fontSize: '10px', fontWeight: 800 }}>
                    {isDegenMode ? 'ON ($2.5k Mcap)' : 'OFF ($69k)'}
                  </span>
                </button>
                <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                  {isDegenMode ? 'Kurva mikro $2,500 mcap awal.' : 'Kurva standar threshold 24 ETH.'}
                </span>
              </div>
            </div>

            {/* Creator Vesting */}
            <div className="flex-col gap-xs">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>
                  Creator Vesting (Local Launchpad Contract)
                </label>
                <span style={{ fontSize: '10px', color: 'var(--color-badge-warning-text)', fontWeight: 700 }}>
                  ℹ️ Smart contract lokal
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setCreatorVesting('NONE')}
                  className={creatorVesting === 'NONE' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px', justifyContent: 'center', fontSize: '11px' }}
                >
                  Tanpa Vesting (0%)
                </button>
                <button
                  type="button"
                  onClick={() => setCreatorVesting('15_PERCENT')}
                  className={creatorVesting === '15_PERCENT' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px', justifyContent: 'center', fontSize: '11px' }}
                >
                  15% Creator Vesting
                </button>
              </div>
              <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                * Vesting kustom berlaku untuk deploy via Smart Contract Launchpad.
              </span>
            </div>

            {/* Bankr-Compatible Creator Royalty / Fee Recipient Routing */}
            <div className="flex-col gap-xs">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>
                  Tujuan Royalti Creator (Bankr Fee Recipient Format)
                </label>
                <span style={{ fontSize: '10px', color: 'var(--color-badge-info-text)', fontWeight: 700 }}>
                  Royalti Creator: {billingConfig.creatorFeePct.toFixed(2)}% / Swap
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                {[
                  { id: 'wallet' as const, label: 'Wallet (0x)' },
                  { id: 'x' as const, label: 'X / Twitter' },
                  { id: 'farcaster' as const, label: 'Farcaster' },
                  { id: 'ens' as const, label: 'ENS (.eth)' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setFeeRecipientType(opt.id)}
                    className={feeRecipientType === opt.id ? 'btn-primary' : 'btn-secondary'}
                    style={{ padding: '6px 4px', justifyContent: 'center', fontSize: '10px' }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {feeRecipientType !== 'wallet' ? (
                <input
                  type="text"
                  value={feeRecipientHandle}
                  onChange={(e) => setFeeRecipientHandle(e.target.value)}
                  placeholder={
                    feeRecipientType === 'x'
                      ? 'Handle X penerima royalti (mis. @creator_handle)'
                      : feeRecipientType === 'farcaster'
                      ? 'Handle Farcaster penerima royalti (mis. @creator.eth)'
                      : 'Nama domain ENS penerima royalti (mis. creator.eth)'
                  }
                  className="input"
                  style={{ padding: '8px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                />
              ) : (
                <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                  * Menggunakan alamat Creator Wallet Address di bawah sebagai penerima royalti on-chain.
                </span>
              )}
            </div>

            {/* Live Billing & Credit Sync Summary Card (Synced with /billing) */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--color-surface-elevated)',
                border: '1px solid var(--color-border)',
                fontSize: '11px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                <span style={{ fontWeight: 800, color: 'var(--color-foreground)' }}>
                  ⚡ Sinkronisasi Paket &amp; Biaya Peluncuran (/billing)
                </span>
                <a
                  href="/billing"
                  style={{ color: 'var(--color-accent)', fontWeight: 700, textDecoration: 'underline', fontSize: '11px' }}
                >
                  Kelola Paket &amp; Kredit →
                </a>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px' }}>
                <div style={{ padding: '6px 8px', borderRadius: '6px', backgroundColor: 'var(--color-surface-subtle)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>Paket &amp; Saldo Aktif</div>
                  <div style={{ fontWeight: 800, color: 'var(--color-foreground)', fontFamily: 'var(--font-mono)' }}>
                    {planId || 'FREE'} · {(credits ?? 0).toLocaleString()} cr
                  </div>
                </div>
                <div style={{ padding: '6px 8px', borderRadius: '6px', backgroundColor: 'var(--color-surface-subtle)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>Biaya Deploy / Studio</div>
                  <div style={{ fontWeight: 800, color: 'var(--color-badge-info-text)', fontFamily: 'var(--font-mono)' }}>
                    {billingConfig.launchCostCr} cr Launch · {billingConfig.studioCostCr} cr AI
                  </div>
                </div>
                <div style={{ padding: '6px 8px', borderRadius: '6px', backgroundColor: 'var(--color-surface-subtle)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>Bagi Hasil Trading Fee</div>
                  <div style={{ fontWeight: 800, color: 'var(--color-badge-success-text)', fontFamily: 'var(--font-mono)' }}>
                    {billingConfig.creatorFeePct.toFixed(2)}% Creator / {billingConfig.treasuryFeePct.toFixed(2)}% Treasury
                  </div>
                </div>
              </div>
            </div>
              </div>
            )}

            <div className="flex-col gap-xs">
              <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>Creator Wallet Address</label>
              <input
                type="text"
                value={creatorWallet}
                onChange={(e) => setCreatorWallet(e.target.value)}
                className="input"
                style={{ padding: '12px', fontFamily: 'var(--font-mono)' }}
              />
            </div>

            {/* Multi-Key Bankr BYOK Vault (Encrypted AES-256-GCM · Multi-Chain Safe) */}
            <BankrKeyVaultPanel
              isConnected={isConnected}
              selectedChain={selectedChain}
              selectedKeyId={selectedBankrKeyId}
              onSelectKeyId={setSelectedBankrKeyId}
              canPublishLaunch={Boolean(hasCapability?.('PUBLISH_LAUNCH') || entitlements?.createLaunch)}
              activePlanLabel={planId || 'FREE'}
            />

            {!isConnected ? (
              <div className="flex-col gap-xs" style={{ marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={async () => {
                    setConnectError(null);
                    const res = await connectMetaMask();
                    if (!res.success && res.error) {
                      setConnectError(res.error);
                    }
                  }}
                  disabled={isConnecting}
                  className="btn-primary"
                  style={{ padding: '14px', justifyContent: 'center' }}
                >
                  <Wallet size={16} />
                  {isConnecting ? 'Connecting...' : 'Connect MetaMask to Launch Token'}
                </button>
                {connectError && (
                  <div style={{ color: 'var(--color-destructive)', fontSize: '12px', textAlign: 'center' }}>
                    {connectError}
                  </div>
                )}
              </div>
            ) : (
              <>
                {draftError && (
                  <div style={{ backgroundColor: 'rgba(255, 23, 68, 0.1)', border: '1px solid var(--color-destructive)', padding: '10px', borderRadius: '6px', fontSize: '12px', color: 'var(--color-destructive)', marginTop: '8px' }}>
                    {draftError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={isCreating}
                  className="btn-primary"
                  style={{ padding: '14px', justifyContent: 'center', marginTop: '8px' }}
                >
                  {isCreating ? 'Validating Risk Passport...' : '🚀 Create Launch Draft'}
                </button>
              </>
            )}
          </form>
        </div>

        {/* Right Column: Live Token Card Preview + Draft & Risk Passport Inspector */}
        <div className="bg-panel" style={{ borderRadius: '8px', padding: '24px' }}>
          {/* Live Token Card Preview */}
          <div
            style={{
              marginBottom: '16px',
              padding: '14px',
              borderRadius: '10px',
              border: '1px solid var(--color-badge-info-border)',
              backgroundColor: 'var(--color-surface-subtle)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontSize: '10px', color: 'var(--color-badge-info-text)', fontFamily: 'var(--font-mono)', fontWeight: 800, marginBottom: '4px' }}>
                LIVE TOKEN CARD PREVIEW
              </div>
              <div style={{ fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)' }}>
                {tokenName.trim() || 'Nama Token Anda'}{' '}
                <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}>
                  ${(tokenSymbol.trim() || 'TICKER').toUpperCase()}
                </span>
              </div>
              <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
                Chain: <strong style={{ color: 'var(--color-foreground)' }}>{selectedChain.toUpperCase()}</strong> · Mode: <strong style={{ color: 'var(--color-foreground)' }}>{mode.replace(/_/g, ' ')}</strong> · Tax: <strong style={{ color: 'var(--color-accent-emerald)' }}>0%</strong>
              </div>
            </div>
            <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', padding: '4px 8px', borderRadius: '6px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)', border: '1px solid var(--color-badge-success-border)' }}>
              {isDegenMode ? 'Degen $2.5k Cap' : 'Standard $69k Cap'}
            </span>
          </div>

          <h2 style={{ color: 'var(--color-foreground)', marginTop: 0, fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <ShieldAlert size={18} /> Skor Keamanan &amp; Ringkasan Draft
          </h2>

          {draftResult ? (
            <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px', border: '1px solid var(--color-border)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Draft ID:</span>
                <span style={{ color: '#00E5FF', fontWeight: 800 }}>{draftResult.id || draftResult.draftId}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Token:</span>
                <span style={{ color: 'var(--color-accent)', fontWeight: 900 }}>{draftResult.name} (${draftResult.ticker || draftResult.symbol})</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Launch Mode:</span>
                <span style={{ color: '#D500F9', fontWeight: 800 }}>{draftResult.launchMode || draftResult.mode}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Creator Wallet:</span>
                <span style={{ color: 'var(--color-foreground)', fontWeight: 800 }}>{draftResult.creatorWallet.slice(0, 10)}...</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
                <span className="text-muted">Target Chain:</span>
                <span style={{ color: selectedChain === 'base' ? 'var(--color-accent)' : '#FFAB00', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <span>
                    {`${selectedChain.toUpperCase()}-MAINNET`}
                    {selectedChain === 'base' ? ' (SPONSORED)' : ' (POLICY RESTRICTED)'}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      const hexMap: Record<string, string> = {
                        base: '0x2105',
                        robinhood: '0x1237',
                        arbitrum: '0xa4b1',
                        arc: '0x13b2',
                      };
                      const res = await switchNetwork(hexMap[selectedChain] || '0x2105');
                      if (res.success) {
                        setOnChainFeedback(`✅ Jaringan MetaMask berhasil berpindah ke ${selectedChain.toUpperCase()}.`);
                      } else if (res.error) {
                        setOnChainFeedback(`⚠️ ${res.error}`);
                      }
                    }}
                    className="btn-secondary"
                    style={{ padding: '2px 7px', fontSize: '10px', borderColor: '#38BDF8', color: '#38BDF8' }}
                  >
                    ⚡ Switch MetaMask
                  </button>
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Pairing / Profile:</span>
                <span style={{ color: 'var(--color-foreground)', fontWeight: 800 }}>
                  {poolPairing} ({isDegenMode ? 'Degen $2.5k Mcap' : 'Std $69k Mcap'})
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Creator Allocation:</span>
                <span style={{ color: 'var(--color-foreground)', fontWeight: 800 }}>
                  {creatorVesting === '15_PERCENT' ? '15% (Local Contract Only)' : '0% (None)'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Arkham Risk Passport:</span>
                <span style={{ color: 'var(--color-accent)', fontWeight: 900 }}>{draftResult.riskPassportScore} / 100 (LOW_RISK)</span>
              </div>
              <div style={{ backgroundColor: 'var(--color-badge-success-bg)', border: '1px solid var(--color-badge-success-border)', color: 'var(--color-badge-success-text)', padding: '12px', borderRadius: '8px', textAlign: 'center', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px' }}>
                <CheckCircle2 size={16} /> Draft Ready for Onchain Graduation Test
              </div>

              {/* On-Chain Registration Action & Status */}
              <div style={{ marginBottom: '16px', padding: '14px', borderRadius: '8px', border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-subtle)' }}>
                <div style={{ fontSize: '12px', fontWeight: 800, marginBottom: '8px', color: 'var(--color-badge-info-text)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Zap size={14} /> Settlement Layer: {selectedChain === 'robinhood' ? 'Robinhood Chain L2' : 'Base Blockchain'}
                </div>
                {userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' ? (
                  <div>
                    <p style={{ fontSize: '11px', color: 'var(--color-muted)', marginBottom: '10px' }}>
                      Sebagai <strong>Protocol Admin</strong>, Anda dapat mendaftarkan token ini langsung ke smart contract <code>BondingCurveLaunchpad.sol</code> (<code>onlyOwner</code>).
                    </p>
                    <input
                      type="text"
                      placeholder="Deployed ERC-20 Token Address (0x...)"
                      value={onChainTokenAddress}
                      onChange={(e) => setOnChainTokenAddress(e.target.value)}
                      className="input"
                      style={{ width: '100%', padding: '8px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)', marginBottom: '8px' }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary w-full"
                      onClick={handleRegisterOnChain}
                      disabled={isRegisteringOnChain || !!publishedTxHash}
                      style={{ padding: '10px', fontSize: '12px', justifyContent: 'center' }}
                    >
                      {isRegisteringOnChain
                        ? `⏳ Memproses di Blockchain ${selectedChain === 'robinhood' ? 'Robinhood L2' : 'Base'}...`
                        : publishedTxHash
                        ? '✅ Terdaftar On-Chain'
                        : '⚡ Register Token Launch On-Chain'}
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--color-muted)', lineHeight: '1.5' }}>
                    ℹ️ Fungsi on-chain langsung (<code>registerTokenLaunch</code>) diproteksi modifier <code>onlyOwner</code>. Sebagai <strong>Creator</strong>, Anda dapat langsung menggunakan jalur <strong>Bankr Gas-Sponsored Pipeline</strong> di bawah:
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleBankrDeploy(true)}
                    disabled={isBankrDeploying || isRegisteringOnChain}
                    style={{ flex: 1, padding: '8px 10px', fontSize: '11px', justifyContent: 'center', borderColor: 'var(--color-badge-info-border)', color: 'var(--color-badge-info-text)' }}
                  >
                    {isBankrDeploying ? '⏳ Running Bankr...' : `🧪 Simulate Bankr Launch (-${billingConfig.launchCostCr} cr)`}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handleBankrDeploy(false)}
                    disabled={isBankrDeploying || isRegisteringOnChain}
                    style={{ flex: 1, padding: '8px 10px', fontSize: '11px', justifyContent: 'center' }}
                  >
                    {isBankrDeploying ? '⏳ Deploying...' : `⚡ Bankr Deploy ${selectedChain.toUpperCase()} (-${billingConfig.launchCostCr} cr)`}
                  </button>
                </div>

                {onChainFeedback && (
                  <div
                    style={{
                      marginTop: '10px',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      backgroundColor: onChainFeedback.startsWith('✅') ? '#041E15' : '#2A0808',
                      color: onChainFeedback.startsWith('✅') ? 'var(--color-accent)' : '#FF5252',
                      border: `1px solid ${onChainFeedback.startsWith('✅') ? 'var(--color-accent)' : '#FF5252'}`,
                      wordBreak: 'break-all',
                    }}
                  >
                    {onChainFeedback}
                  </div>
                )}
              </div>

              {/* Investor Nutrition Label Preview */}
              <NutritionLabelCard
                liquidityLocked={false}
                mintRevoked={true}
                creatorTrustScore={draftResult.riskPassportScore || 75}
                overallTier="LOW"
                reasons={[
                  'Template contracts enforced via BondingCurveLaunchpad.sol',
                  'Zero withdrawal keys detected on deployer vault',
                  'Pre-launch fair distribution limits active'
                ]}
              />
            </div>
          ) : (
            <div className="bg-panel flex-col items-center justify-center" style={{ padding: '3rem 2rem', textAlign: 'center', color: 'var(--color-muted)', borderRadius: '6px', border: '1px dashed var(--color-border)', fontSize: '13px' }}>
              <FileText size={32} style={{ marginBottom: '16px', opacity: 0.5 }} />
              Fill in token details and click "Create Launch Draft" to generate risk passport preview.
            </div>
          )}
        </div>
      </div>

      {/* Live Deployed Tokens & Active Bonding Curves */}
      <div className="bg-panel" style={{ borderRadius: '14px', padding: '24px', border: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
          <h2 style={{ color: 'var(--color-foreground)', margin: 0, fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Rocket size={18} style={{ color: 'var(--color-accent)' }} /> Live Deployed Tokens &amp; Bonding Curves
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className="badge" style={{ backgroundColor: 'var(--color-badge-info-bg)', color: 'var(--color-badge-info-text)', border: '1px solid var(--color-badge-info-border)', fontSize: '11px', fontWeight: 800 }}>
              {filteredTokens.length} / {activeTokens.length} TOKEN AKTIF
            </span>
            <button
              type="button"
              onClick={fetchActiveTokens}
              className="btn-secondary"
              style={{ padding: '6px 12px', fontSize: '11px' }}
              disabled={isLoadingTokens}
            >
              {isLoadingTokens ? 'Memuat...' : '🔄 Refresh Daftar'}
            </button>
          </div>
        </div>

        {/* Discovery Filter & Sort Toolbar */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            marginBottom: '18px',
            padding: '12px 14px',
            borderRadius: '12px',
            backgroundColor: 'var(--color-surface-subtle)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {/* Search Box */}
            <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: '380px' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: '11px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--color-muted)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
                placeholder="Cari nama token, $TICKER, atau 0x..."
                className="input"
                style={{ width: '100%', padding: '7px 12px 7px 32px', fontSize: '12px', borderRadius: '9999px' }}
              />
            </div>

            {/* Sort / Category Tabs */}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {[
                { id: 'trending' as LaunchpadSortMode, label: '🔥 Sedang Ramai' },
                { id: 'newest' as LaunchpadSortMode, label: '🆕 Terbaru' },
                { id: 'graduating' as LaunchpadSortMode, label: '🎓 Hampir Graduasi' },
                { id: 'safest' as LaunchpadSortMode, label: '🛡️ Skor Aman' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSortMode(tab.id)}
                  className="filter-pill"
                  data-active={sortMode === tab.id ? 'true' : 'false'}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Chain Filter Pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 700, marginRight: '4px' }}>
              Jaringan:
            </span>
            {[
              { id: 'all', label: 'Semua' },
              { id: 'base', label: 'Base' },
              { id: 'robinhood', label: 'Robinhood' },
              { id: 'solana', label: 'Solana' },
              { id: 'arbitrum', label: 'Arbitrum' },
              { id: 'arc', label: 'Arc' },
            ].map((ch) => {
              const count = chainCounts[ch.id] || 0;
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => setChainFilter(ch.id)}
                  className="filter-pill"
                  data-active={chainFilter === ch.id ? 'true' : 'false'}
                >
                  <span>{ch.label}</span>
                  <span style={{ opacity: 0.75, fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                    ({count})
                  </span>
                </button>
              );
            })}
            {(tokenSearch || chainFilter !== 'all' || sortMode !== 'trending') && (
              <button
                type="button"
                onClick={() => {
                  setTokenSearch('');
                  setChainFilter('all');
                  setSortMode('trending');
                }}
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-accent)',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Reset Filter
              </button>
            )}
          </div>
        </div>

        {isLoadingTokens && activeTokens.length === 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton-shimmer" style={{ height: '190px', borderRadius: '12px' }} />
            ))}
          </div>
        ) : filteredTokens.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '16px' }}>
            {filteredTokens.map((token: any) => {
              const raised = Number(token.raisedAmount || 0);
              const target = Number(token.graduationThreshold || 69000);
              const progressPct = computeGraduationProgressPct(token);
              const isHot = progressPct >= 25 || raised >= 10000;
              const isNew = token.publishedAt
                ? Date.now() - new Date(token.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000
                : false;
              const tokenChainSlug = normalizeChainName(token.chain);
              const portalUrl = `/token/${tokenChainSlug}/${token.contractAddress}`;
              const explorerUrl = (() => {
                if (tokenChainSlug === 'solana') return `https://solscan.io/token/${token.contractAddress}`;
                if (tokenChainSlug === 'ethereum') return `https://etherscan.io/token/${token.contractAddress}`;
                if (tokenChainSlug === 'robinhood') return `https://robinhoodchain.blockscout.com/address/${token.contractAddress}`;
                if (tokenChainSlug === 'arc') return `https://arcscan.io/token/${token.contractAddress}`;
                if (tokenChainSlug === 'arbitrum') return `https://arbiscan.io/address/${token.contractAddress}`;
                if (tokenChainSlug === 'bsc') return `https://bscscan.com/address/${token.contractAddress}`;
                return `https://basescan.org/address/${token.contractAddress}`;
              })();
              const explorerLabel = tokenChainSlug === 'solana'
                ? 'Solscan ↗'
                : tokenChainSlug === 'robinhood'
                ? 'Blockscout ↗'
                : tokenChainSlug === 'ethereum'
                ? 'Etherscan ↗'
                : tokenChainSlug === 'arc'
                ? 'Arcscan ↗'
                : tokenChainSlug === 'arbitrum'
                ? 'Arbiscan ↗'
                : tokenChainSlug === 'bsc'
                ? 'Bscscan ↗'
                : 'Basescan ↗';

              return (
                <div
                  key={token.launchId || token.contractAddress}
                  className="bg-panel token-card-interactive"
                  style={{
                    padding: '16px',
                    borderRadius: '14px',
                    border: '1px solid var(--color-border)',
                    backgroundColor: 'var(--color-surface-elevated)',
                    boxShadow: 'var(--shadow-sm)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
                    <a
                      href={portalUrl}
                      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}
                      title={`Buka Portal Token ${token.name}`}
                    >
                      <TokenAvatar
                        src={token.imageUrl}
                        name={token.name}
                        ticker={token.ticker}
                        seed={token.contractAddress}
                        size={42}
                        borderRadius={11}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 900, color: 'var(--color-foreground)', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span>{token.name}</span>
                          <span style={{ fontSize: '11px', color: 'var(--color-accent)' }}>↗</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--color-accent)', fontSize: '12px' }}>
                            ${token.ticker}
                          </span>
                          {token.isGraduated ? (
                            <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)' }}>
                              🎓 GRAD
                            </span>
                          ) : isHot ? (
                            <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: 'var(--color-badge-warning-bg)', color: 'var(--color-badge-warning-text)' }}>
                              🔥 HOT
                            </span>
                          ) : isNew ? (
                            <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: 'var(--color-badge-purple-bg)', color: 'var(--color-badge-purple-text)' }}>
                              ✨ NEW
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </a>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: '6px',
                        fontSize: '10px',
                        fontWeight: 800,
                        backgroundColor: 'var(--color-badge-info-bg)',
                        color: 'var(--color-badge-info-text)',
                        border: '1px solid var(--color-badge-info-border)',
                        flexShrink: 0,
                      }}
                    >
                      {token.chain?.toUpperCase() || 'BASE'}
                    </span>
                  </div>

                  <div style={{ fontSize: '11px', color: 'var(--color-muted)', marginBottom: '8px', fontFamily: 'var(--font-mono)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(token.contractAddress).catch(() => {});
                        setCopiedAddr(token.contractAddress);
                        setTimeout(() => setCopiedAddr((cur) => (cur === token.contractAddress ? null : cur)), 1500);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        color: 'var(--color-muted)',
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        cursor: 'pointer',
                      }}
                      title="Salin Contract Address"
                    >
                      <span>CA: {token.contractAddress.slice(0, 8)}...{token.contractAddress.slice(-6)}</span>
                      {copiedAddr === token.contractAddress ? (
                        <Check size={11} style={{ color: 'var(--color-badge-success-text)' }} />
                      ) : (
                        <Copy size={11} />
                      )}
                    </button>
                    <a
                      href={`https://gmgn.ai/${tokenChainSlug === 'solana' ? 'sol' : tokenChainSlug}/token/${token.contractAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 700,
                        backgroundColor: 'var(--color-badge-warning-bg)',
                        color: 'var(--color-badge-warning-text)',
                        border: '1px solid var(--color-badge-warning-border)',
                        textDecoration: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '2px',
                      }}
                      title="Buka Chart & Live Orderbook di GMGN.ai"
                    >
                      GMGN ↗
                    </a>
                  </div>

                  {/* SocialFi Programs Strip */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'monospace' }}>SocialFi:</span>
                    <a
                      href={`/kol?launchId=${token.launchId || ''}&tab=MARKET`}
                      style={{
                        fontSize: '9px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'var(--color-badge-purple-bg)',
                        color: 'var(--color-badge-purple-text)',
                        border: '1px solid var(--color-badge-purple-border)',
                        textDecoration: 'none',
                        fontWeight: 600,
                      }}
                      title="Diamond Hands HODL Loyalty"
                    >
                      💎 HODL
                    </a>
                    <a
                      href={`/kol?launchId=${token.launchId || ''}&tab=MARKET`}
                      style={{
                        fontSize: '9px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'var(--color-badge-success-bg)',
                        color: 'var(--color-badge-success-text)',
                        border: '1px solid var(--color-badge-success-border)',
                        textDecoration: 'none',
                        fontWeight: 600,
                      }}
                      title="Liquid Staking Vault"
                    >
                      🥩 Staking
                    </a>
                    <a
                      href={`/kol?launchId=${token.launchId || ''}&tab=MARKET`}
                      style={{
                        fontSize: '9px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'var(--color-badge-info-bg)',
                        color: 'var(--color-badge-info-text)',
                        border: '1px solid var(--color-badge-info-border)',
                        textDecoration: 'none',
                        fontWeight: 600,
                      }}
                      title="Viral Community & X Raid"
                    >
                      🚀 Raid
                    </a>
                  </div>

                  {/* Graduation Progress Bar */}
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--color-muted)', marginBottom: '4px' }}>
                      <span>Graduation Progress</span>
                      <span style={{ color: 'var(--color-foreground)', fontWeight: 700 }}>${raised.toLocaleString()} / ${target.toLocaleString()}</span>
                    </div>
                    <div style={{ width: '100%', height: '6px', backgroundColor: 'var(--color-surface-inset)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ width: `${progressPct}%`, height: '100%', backgroundColor: 'var(--color-accent)' }} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '4px', marginTop: '12px', flexWrap: 'wrap' }}>
                    <a
                      href={portalUrl}
                      className="btn-secondary"
                      style={{ flex: '1 1 21%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center', color: 'var(--color-badge-info-text)', borderColor: 'var(--color-badge-info-border)' }}
                      title="Buka Portal Detail Token"
                    >
                      Portal 🌐
                    </a>
                    <a
                      href={`/trading?token=${token.contractAddress}`}
                      className="btn-primary"
                      style={{ flex: '1 1 21%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center' }}
                    >
                      Trade ⚡
                    </a>
                    <a
                      href={`/kol?launchId=${token.launchId || ''}&tab=MARKET`}
                      className="btn-secondary"
                      style={{ flex: '1 1 21%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center', borderColor: 'var(--color-badge-purple-border)', color: 'var(--color-badge-purple-text)' }}
                      title="Ikuti Bounties, Kampanye Share & Staking di KOL Hub"
                    >
                      SocialFi 🎯
                    </a>
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary"
                      style={{ flex: '1 1 21%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center' }}
                    >
                      {explorerLabel}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--color-muted)', fontSize: '12px' }}>
            {activeTokens.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                <span>Tidak ada token yang cocok dengan pencarian atau filter jaringan saat ini.</span>
                <button
                  type="button"
                  onClick={() => {
                    setTokenSearch('');
                    setChainFilter('all');
                    setSortMode('trending');
                  }}
                  className="btn-secondary"
                  style={{ padding: '6px 14px', fontSize: '11px' }}
                >
                  Tampilkan Semua Token ({activeTokens.length})
                </button>
              </div>
            ) : (
              'Belum ada token yang diluncurkan. Buat draft di atas untuk mendaftarkan token pertama Anda!'
            )}
          </div>
        )}
      </div>

      {/* Admin Launchpad Governance Console (SYSTEM_ADMIN Exclusive) */}
      {(userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
        <div className="bg-panel" style={{ border: '1px solid #FF9100', borderRadius: '8px', padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 900, color: '#FFD600', margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={18} /> System Admin: Launchpad Bonding Curve & Liquidity Governance
          </h3>
          <div className="grid-3">
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#00E5FF', fontWeight: 800, fontSize: '12px' }}>Graduation Target</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>$69,000 Market Cap</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>Auto-migrates to Uniswap v3 Pool</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent)', fontWeight: 800, fontSize: '12px' }}>Protocol Fee Split</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>0.50% / 0.50%</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>50% Protocol Treasury / 50% Creator</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-destructive)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><AlertTriangle size={14} /> Emergency Blacklist</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-accent)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>0 Blacklisted Contracts</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>Arkham OFAC Scanned Hourly</div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Bounty Merkle Snapshot Console (RBAC: MANAGE_SNAPSHOTS — SUPER_ADMIN / LAUNCH_ADMIN) */}
      {(userRole === 'SUPER_ADMIN' || userRole === 'LAUNCH_ADMIN') && (
        <AdminMerkleSnapshotPanel
          activeTokens={activeTokens}
          walletAddress={walletAddress}
        />
      )}
    </div>
  );
}
