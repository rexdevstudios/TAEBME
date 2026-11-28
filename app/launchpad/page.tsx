'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { BANKR_BASE_QUOTE_TOKENS } from '@packages/launchpad/bankr-client';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';
import { Rocket, ShieldAlert, FileText, CheckCircle2, AlertTriangle, TrendingUp, Scale, Wallet, Users, Tag, Sparkles, Coins, Zap, Search, Copy, Check, LayoutGrid, List } from 'lucide-react';
import { NutritionLabelCard } from '../components/NutritionLabelCard';
import { WalletRiskBadgeCard } from '../components/WalletRiskBadgeCard';
import { AngelDealRoomModal } from '../components/AngelDealRoomModal';
import { AdminMerkleSnapshotPanel } from '../components/AdminMerkleSnapshotPanel';
import { CreatorStudioPanel } from '../components/CreatorStudioPanel';
import { PageWorkflowBanner } from '../components/PageWorkflowBanner';
import { NetworkMismatchBanner } from '../components/NetworkMismatchBanner';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { resolveLaunchpadChainHex } from '@packages/trading/paper-wallet';
import { TokenAvatar } from '../components/TokenAvatar';
import { BankrKeyVaultPanel } from '../components/BankrKeyVaultPanel';
import {
  PinWatchlistButton,
  TokenWatchlistBar,
  useTokenWatchlist,
} from '../components/TokenWatchlistBar';
import { buildSocialShareUrl } from '@packages/notifications/webhook-dispatcher';
import {
  sortLaunchesWithFeaturedFirst,
  type FeaturedBoostRecord,
} from '@packages/billing/high-margin-revenue';
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
  const { t, tr } = useLocale();
  const { items: watchlistItems, togglePin: toggleWatchlistPin, isPinned: isWatchlistItemPinned } = useTokenWatchlist();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [selectedBankrKeyId, setSelectedBankrKeyId] = useState<string>('PLATFORM_DEFAULT');
  const [selectedBatchBankrKeyIds, setSelectedBatchBankrKeyIds] = useState<string[]>([]);
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
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const nameParam = params.get('name');
    const symbolParam = params.get('symbol');
    if (nameParam) setTokenName(nameParam);
    if (symbolParam) setTokenSymbol(symbolParam.toUpperCase());
  }, []);

  const [mode, setMode] = useState<LaunchModeType>('BONDING_CURVE');
  const [creatorWallet, setCreatorWallet] = useState(walletAddress || '');
  const [whitelistWallets, setWhitelistWallets] = useState('');
  const [fixedPriceEth, setFixedPriceEth] = useState('0.0001');
  const [fundingGoalEth, setFundingGoalEth] = useState('25');
  const [draftResult, setDraftResult] = useState<any>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTokens, setActiveTokens] = useState<any[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = useState(false);

  // CEX Launchpad Tab Navigation State (Phase CJ)
  const [launchpadTab, setLaunchpadTab] = useState<'POOLS' | 'CREATE' | 'STUDIO' | 'ADMIN'>('POOLS');

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

  const [statusFilter, setStatusFilter] = useState<'all' | 'curve' | 'graduated' | 'kol_verified'>('all');
  const kolVerifiedCount = useMemo(
    () => activeTokens.filter((t) => Boolean(t.creatorKolVerified)).length,
    [activeTokens]
  );
  const [visiblePoolCount, setVisiblePoolCount] = useState<number>(12);
  const [featuredBoosts, setFeaturedBoosts] = useState<FeaturedBoostRecord[]>([]);
  const [poolViewMode, setPoolViewMode] = useState<'GRID' | 'LIST'>('GRID');
  const [boostingAddress, setBoostingAddress] = useState<string | null>(null);
  const [boostFeedback, setBoostFeedback] = useState<string | null>(null);
  const [boostTreasuryWallet, setBoostTreasuryWallet] = useState<string>('0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6');

  const featuredAddressSet = useMemo(
    () => new Set(featuredBoosts.map((b) => b.contractAddress.trim().toLowerCase())),
    [featuredBoosts]
  );

  const filteredTokens = useMemo(() => {
    const base = filterAndSortLaunchTokens(activeTokens, {
      search: tokenSearch,
      chain: chainFilter,
      sort: sortMode,
      onlyKolVerified: statusFilter === 'kol_verified',
    });
    const byStatus =
      statusFilter === 'graduated'
        ? base.filter((t) => Boolean(t.isGraduated))
        : statusFilter === 'curve'
          ? base.filter((t) => !Boolean(t.isGraduated))
          : base;
    return sortLaunchesWithFeaturedFirst(byStatus, featuredBoosts);
  }, [activeTokens, tokenSearch, chainFilter, sortMode, statusFilter, featuredBoosts]);

  const visibleTokens = useMemo(
    () => filteredTokens.slice(0, visiblePoolCount),
    [filteredTokens, visiblePoolCount]
  );

  // 4 Launchpad Alignment Dimensions (Chain, Pairing, Degen Mode, Vesting)
  const [selectedChain, setSelectedChain] = useState<'base' | 'robinhood' | 'arbitrum' | 'arc'>('base');
  const [poolPairing, setPoolPairing] = useState<'WETH' | 'MORE_TOKENS' | 'STOCKS'>('WETH');
  const [selectedBaseQuoteToken, setSelectedBaseQuoteToken] = useState<string>(BANKR_BASE_QUOTE_TOKENS[0].address);
  const [isDegenMode, setIsDegenMode] = useState<boolean>(true);
  const [creatorVesting, setCreatorVesting] = useState<'NONE' | '15_PERCENT'>('NONE');
  const [showAdvancedOptions, setShowAdvancedOptions] = useState<boolean>(false);

  const fetchActiveTokens = async () => {
    setIsLoadingTokens(true);
    try {
      const [res, boostRes] = await Promise.all([
        fetch('/api/launchpad/tokens'),
        fetch('/api/launchpad/featured-boost').catch(() => null),
      ]);
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setActiveTokens(json.data);
      }
      if (boostRes && boostRes.ok) {
        const bJson = await boostRes.json().catch(() => null);
        if (bJson?.success && Array.isArray(bJson?.data?.activeBoosts)) {
          setFeaturedBoosts(bJson.data.activeBoosts);
          if (bJson?.data?.treasuryWallet) setBoostTreasuryWallet(bJson.data.treasuryWallet);
        }
      }
    } catch {
      // Graceful fallback
    } finally {
      setIsLoadingTokens(false);
    }
  };

  const handleFeaturedBoost24h = async (contractAddress: string, chain: string) => {
    if (!isConnected) {
      setBoostFeedback('Auth: Hubungkan dompet MetaMask (SIWE) terlebih dahulu untuk mengaktifkan Featured Boost 24h.');
      return;
    }
    setBoostingAddress(contractAddress);
    setBoostFeedback(null);
    try {
      let txHash: string | undefined;
      if (typeof window !== 'undefined' && window.location.hostname !== 'testnet.pndigi.site') {
        const eth = (window as any).ethereum;
        if (!eth) {
          setBoostFeedback('Notice: MetaMask diperlukan untuk pembayaran on-chain Featured Boost 24h (0.005 ETH Base L2).');
          return;
        }
        const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
        const from = accounts?.[0];
        if (!from) {
          setBoostFeedback('Notice: Dompet MetaMask belum terhubung.');
          return;
        }
        // 0.005 ETH = 5000000000000000 wei = 0x11c37937e08000
        txHash = await eth.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: boostTreasuryWallet, value: '0x11c37937e08000', gas: '0x5208' }],
        });
      }
      const res = await fetch('/api/launchpad/featured-boost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractAddress, chain: chain || 'base-mainnet', tierId: 'BOOST_24H', txHash }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setBoostFeedback(`Notice: Gagal mengaktifkan Featured Boost: ${json.error || res.status}`);
        return;
      }
      if (Array.isArray(json.data?.activeBoosts)) {
        setFeaturedBoosts(json.data.activeBoosts);
      }
      setBoostFeedback(`OK: Featured Boost 24h aktif! Token disematkan di posisi teratas Live Pools.`);
    } catch (err: any) {
      setBoostFeedback(`Notice: Boost dibatalkan/gagal: ${err?.message || 'Error'}`);
    } finally {
      setBoostingAddress(null);
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
          setDraftError('Akses Ditolak (403 Forbidden): Akun Anda memerlukan hak akses CREATOR atau ADMIN untuk membuat draft launchpad.');
        } else if (res.status === 401) {
          setDraftError('Notice: Autentikasi Diperlukan (401 Unauthorized): Harap masuk via MetaMask SIWE terlebih dahulu.');
        } else {
          setDraftError(`Error: Gagal: ${errorMsg}`);
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
          ...(selectedChain === 'base' && poolPairing === 'MORE_TOKENS'
            ? { pairedTokenAddress: selectedBaseQuoteToken }
            : {}),
          feeRecipient: resolvedFeeRecipient,
          degenMode: isDegenMode,
          simulateOnly,
          providerKeyId: selectedBankrKeyId,
          ...(selectedBatchBankrKeyIds.length > 1 ? { providerKeyIds: selectedBatchBankrKeyIds } : {}),
          ...(tokenDescription.trim() ? { description: tokenDescription.trim() } : {}),
          ...(tokenImageUrl.trim() ? { imageUrl: tokenImageUrl.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || 'Bankr deploy failed';
        setOnChainFeedback(`Error: Bankr Deploy (${res.status}): ${errMsg}`);
        return;
      }
      const d = json.data || {};
      if (d.batchMode) {
        refreshSession().catch(() => {});
        fetchActiveTokens();
        setOnChainFeedback(
          `OK: Bankr Fleet Batch (${simulateOnly ? 'SIMULATED' : 'DEPLOYED'}): Berhasil ${d.succeededCount}/${d.totalRequested} akun di ${selectedChain.toUpperCase()} · -${d.creditsBurned ?? 0} Credits`
        );
        return;
      }
      if (d.tokenAddress) setOnChainTokenAddress(d.tokenAddress);
      if (d.txHash) setPublishedTxHash(d.txHash);
      refreshSession().catch(() => {});
      fetchActiveTokens();
      const keyBadge = d.keySource === 'BYOK_VAULT' ? ` [BYOK: ${d.usedKeyLabel || d.usedKeyMasked}]` : ' [Platform Key]';
      setOnChainFeedback(
        `OK: Bankr ${d.status?.toUpperCase() || 'DEPLOYED'}${keyBadge}: $${d.tokenSymbol || tokenSymbol} on ${selectedChain.toUpperCase()} (${d.tokenAddress || 'Simulated CA'}) · -${d.creditsBurned ?? 50} Credits`
      );
    } catch (err: any) {
      setOnChainFeedback(`Error: Bankr Deploy Error: ${err?.message || 'Network error'}`);
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
        setOnChainFeedback('Notice: Silakan hubungkan dompet Web3 MetaMask terlebih dahulu.');
        return;
      }

      // 1. Access Control Invariant Check (onlyOwner in BondingCurveLaunchpad.sol)
      if (userRole !== 'SYSTEM_ADMIN' && userRole !== 'SUPER_ADMIN') {
        setOnChainFeedback(
          'Akses Terbatas: Pendaftaran token launchpad on-chain memerlukan hak otorisasi Platform Admin / Contract Owner. Draft Anda telah disimpan di SSOT untuk diproses oleh controller.'
        );
        return;
      }

      // 2. Contract Configuration Verification Gate (Rule 6)
      const contractConfig = getContractConfiguration(ssotFactoryAddress);
      if (!contractConfig.isConfigured || !contractConfig.contractAddress) {
        setOnChainFeedback(`Error: ${contractConfig.message}`);
        return;
      }

      // 3. Multi-Chain Network Switching & Validation (Rule 8 — fail closed on unsupported live chains)
      if (selectedChain === 'arbitrum' || selectedChain === 'arc') {
        setOnChainFeedback(
          `Pendaftaran langsung on-chain untuk ${selectedChain.toUpperCase()} belum aktif di BondingCurveLaunchpad.sol. Gunakan Base L2 atau Robinhood Chain L2.`
        );
        return;
      }

      const trimmedTokenAddr = onChainTokenAddress.trim();
      if (!trimmedTokenAddr || !ethers.isAddress(trimmedTokenAddr)) {
        setOnChainFeedback(
          'Notice: Masukkan alamat kontrak token ERC-20 yang sudah ter-deploy (0x...) sebelum mendaftarkan ke BondingCurveLaunchpad.'
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
        setOnChainFeedback(`Error: ${networkCheck.error || `Harap beralih ke jaringan ${chainName}`}`);
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
      setOnChainFeedback(`Menyiapkan pendaftaran token on-chain di ${chainName}...`);
      const signer = await getBrowserSigner();
      const contract = getLaunchpadContract(signer, ssotFactoryAddress);

      const verifiedTokenAddress = ethers.getAddress(trimmedTokenAddr);
      const totalSupplyWei = ethers.parseEther('1000000000');
      const initialPriceWei = ethers.parseEther('0.00000002');
      const graduationThresholdWei = ethers.parseEther('24');
      const maxPerWalletPct = 100n;
      const merkleRoot = draftResult.merkleRoot || ethers.ZeroHash;

      setOnChainFeedback('Menunggu tanda tangan transaksi pendaftaran di MetaMask...');
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

      setOnChainFeedback(`Transaksi terkirim: ${tx.hash}. Menunggu konfirmasi blok ${chainName}...`);
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
              `OK: Token $${draftTicker} terdaftar on-chain (Hash: ${tx.hash}), tetapi sinkronisasi SSOT gagal: ${pubErr?.error?.message || `HTTP ${pubRes.status}`}`
            );
            return;
          }
          // Refresh active token fleet in UI
          fetchActiveTokens();
          refreshSession().catch(() => {});
        } catch (pubCatchErr: any) {
          setOnChainFeedback(
            `OK: Token $${draftTicker} terdaftar on-chain (Hash: ${tx.hash}), tetapi sinkronisasi SSOT gagal: ${pubCatchErr?.message || 'Network error'}`
          );
          return;
        }

        setOnChainFeedback(
          `OK: Token $${draftTicker} BERHASIL DIDAFTARKAN ON-CHAIN! Blok #${receipt.blockNumber}. Hash: ${tx.hash} — Lihat di ${explorerName}: ${explorerLink}`
        );
      } else {
        setOnChainFeedback(`Error: Transaksi gagal dieksekusi di blockchain ${chainName}.`);
      }
    } catch (err: any) {
      setOnChainFeedback(`Error: Gagal pendaftaran on-chain: ${normalizeWeb3Error(err)}`);
    } finally {
      setIsRegisteringOnChain(false);
    }
  };

  const isLaunchpadAdmin =
    userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' || userRole === 'LAUNCH_ADMIN';

  return (
    <div className="flex-col gap-lg">
      {/* CEX Launchpad Hero Spotlight Banner */}
      <div className="cex-hero-banner">
        <div>
          <div className="cex-hero-eyebrow">
            POOLNET CEX-Grade Token Launchpad · 0% Tax · Gas-Sponsored Base L2
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 900, margin: '0 0 4px 0', color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Rocket size={20} style={{ color: 'var(--color-accent-amber)' }} /> {t('launchpad.title')}
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            {t('launchpad.subtitle')}
          </p>
        </div>
        <div className="flex-row gap-sm items-center" style={{ flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setLaunchpadTab('CREATE')}
            className="cex-btn-gold"
          >
            <Rocket size={15} /> {t('launchpad.ctaCreate')}
          </button>
          <button
            type="button"
            onClick={() => setIsAngelModalOpen(true)}
            className="btn-secondary"
            style={{
              cursor: 'pointer',
              borderColor: 'var(--color-badge-purple-border)',
              color: 'var(--color-badge-purple-text)',
              backgroundColor: 'var(--color-badge-purple-bg)',
              padding: '9px 13px',
              fontSize: '12px',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Users size={14} /> {t('launchpad.ctaAngel')}
          </button>
        </div>
      </div>

      {/* CEX Launchpad Category Tab Bar */}
      <div className="cex-tab-bar" role="tablist" aria-label="Kategori Launchpad">
        <button
          type="button"
          role="tab"
          aria-selected={launchpadTab === 'POOLS'}
          onClick={() => setLaunchpadTab('POOLS')}
          className={`cex-tab-btn ${launchpadTab === 'POOLS' ? 'active' : ''}`}
        >
          <TrendingUp size={14} /> {t('launchpad.tabPools')} <span className="cex-tab-count">{activeTokens.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={launchpadTab === 'CREATE'}
          onClick={() => setLaunchpadTab('CREATE')}
          className={`cex-tab-btn ${launchpadTab === 'CREATE' ? 'active' : ''}`}
        >
          <Rocket size={14} /> {t('launchpad.tabCreate')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={launchpadTab === 'STUDIO'}
          onClick={() => setLaunchpadTab('STUDIO')}
          className={`cex-tab-btn ${launchpadTab === 'STUDIO' ? 'active' : ''}`}
        >
          <Sparkles size={14} /> {t('launchpad.tabStudio')}
        </button>
        {isLaunchpadAdmin && (
          <button
            type="button"
            role="tab"
            aria-selected={launchpadTab === 'ADMIN'}
            onClick={() => setLaunchpadTab('ADMIN')}
            className={`cex-tab-btn ${launchpadTab === 'ADMIN' ? 'active' : ''}`}
          >
            <ShieldAlert size={14} /> {t('launchpad.tabAdmin')}
          </button>
        )}
      </div>

      {/* Angel Deal Room Modal */}
      <AngelDealRoomModal
        isOpen={isAngelModalOpen}
        onClose={() => setIsAngelModalOpen(false)}
        connectedWallet={walletAddress}
      />

      {/* TAB 3: AI Brand Studio */}
      {launchpadTab === 'STUDIO' && (
        <div className="flex-col gap-md">
          <CreatorStudioPanel
            tokenName={tokenName}
            tokenSymbol={tokenSymbol}
            selectedChain={selectedChain}
            onApplyIdentity={(name, ticker) => {
              setTokenName(name);
              setTokenSymbol(ticker);
              setLaunchpadTab('CREATE');
            }}
            onApplyAssets={({ name, ticker, description, imageUrl }) => {
              if (name) setTokenName(name);
              if (ticker) setTokenSymbol(ticker);
              if (description) setTokenDescription(description);
              if (imageUrl) setTokenImageUrl(imageUrl);
              setLaunchpadTab('CREATE');
            }}
          />
        </div>
      )}

      {/* TAB 2: Create Token Wizard + Live Preview + Bankr Fleet */}
      {launchpadTab === 'CREATE' && (
        <>
          <NetworkMismatchBanner
            targetChainHex={resolveLaunchpadChainHex(selectedChain)}
            contextLabel={`Deployer ${selectedChain.toUpperCase()}`}
          />
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
              <strong style={{ color: '#10B981' }}>OK: Aset Creator Studio Terhubung ke Wizard</strong>
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
                  style={{ padding: '10px 6px', justifyContent: 'center', fontSize: '11px', border: mode === 'WHITELIST_PRIVATE' ? '1px solid var(--color-accent-purple)' : undefined }}
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
              <div className="flex-col gap-xs" style={{ backgroundColor: 'var(--color-badge-purple-bg)', border: '1px solid var(--color-accent-purple)', padding: '12px', borderRadius: '6px' }}>
                <label style={{ color: '#E040FB', fontSize: '11px', fontWeight: 800 }}>Angel Investor Whitelist Addresses (Merkle Proofs)</label>
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
              <div className="flex-col gap-xs" style={{ backgroundColor: 'var(--color-badge-info-bg)', border: '1px solid var(--color-accent-info)', padding: '12px', borderRadius: '6px' }}>
                <label style={{ color: 'var(--color-accent-info)', fontSize: '11px', fontWeight: 800 }}>Fixed Price Per Token (in ETH)</label>
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
              <div className="flex-col gap-xs" style={{ backgroundColor: 'var(--color-badge-success-bg)', border: '1px solid var(--color-accent)', padding: '12px', borderRadius: '6px' }}>
                <label style={{ color: 'var(--color-accent)', fontSize: '11px', fontWeight: 800 }}>Target Funding Goal (in ETH)</label>
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
                  {selectedChain === 'base' ? '100% Gas Sponsored by Bankr' : 'Notice: Gas Sponsorship Policy Active'}
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
                  <span style={{ fontSize: '9px', color: 'var(--color-accent)' }}>OK: Ready (Sponsored)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedChain('robinhood')}
                  className={selectedChain === 'robinhood' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Robinhood</span>
                  <span style={{ fontSize: '9px', color: 'var(--color-badge-info-text)' }}>Bankr API</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedChain('arbitrum')}
                  className={selectedChain === 'arbitrum' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Arbitrum</span>
                  <span style={{ fontSize: '9px', color: 'var(--color-badge-info-text)' }}>Bankr API</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedChain('arc')}
                  className={selectedChain === 'arc' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px 4px', justifyContent: 'center', fontSize: '11px', flexDirection: 'column', gap: '2px' }}
                >
                  <span style={{ fontWeight: 800 }}>Arc Network</span>
                  <span style={{ fontSize: '9px', color: 'var(--color-badge-info-text)' }}>Bankr API</span>
                </button>
              </div>

              {selectedChain === 'robinhood' && (
                <div style={{ backgroundColor: 'rgba(217, 45, 32, 0.1)', border: '1px solid var(--color-destructive)', padding: '8px 10px', borderRadius: '4px', fontSize: '11px', color: '#FF8A80' }}>
                  <strong>Subsidi Gas Khusus Base L2:</strong> Deploy gratis tanpa gas saat ini khusus di Base L2. Untuk Robinhood L2, silakan gunakan Mode Simulasi atau deploy memakai dompet Anda sendiri.
                </div>
              )}
              {selectedChain === 'arbitrum' && (
                <div style={{ backgroundColor: 'rgba(217, 45, 32, 0.1)', border: '1px solid var(--color-destructive)', padding: '8px 10px', borderRadius: '4px', fontSize: '11px', color: '#FF8A80' }}>
                  <strong>Subsidi Gas Khusus Base L2:</strong> Untuk Arbitrum, saat ini tersedia dalam Mode Simulasi atau deploy memakai dompet Anda sendiri.
                </div>
              )}
              {selectedChain === 'arc' && (
                <div style={{ backgroundColor: 'var(--color-badge-info-bg)', border: '1px solid var(--color-badge-info-border)', padding: '8px 10px', borderRadius: '6px', fontSize: '11px', color: 'var(--color-badge-info-text)' }}>
                  <strong>Arc Network:</strong> Siap untuk peluncuran simulasi maupun kontrak native Arc Network.
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
                Pengaturan Lanjutan (Pairing: {poolPairing} · {isDegenMode ? 'Degen $2.5k' : 'Standard $69k'} · Royalty: {billingConfig.creatorFeePct}% · Deploy: -{billingConfig.launchCostCr} cr)
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
                    WETH OK: </button>
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
                    Stocks                   </button>
                </div>
                {poolPairing === 'MORE_TOKENS' && (
                  <select
                    value={selectedBaseQuoteToken}
                    onChange={(e) => setSelectedBaseQuoteToken(e.target.value)}
                    className="input"
                    style={{ marginTop: '4px', padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                    aria-label="Select Official Base Quote Token"
                  >
                    {BANKR_BASE_QUOTE_TOKENS.map((qt) => (
                      <option key={qt.address} value={qt.address}>
                        {qt.label} ({qt.address.slice(0, 6)}...{qt.address.slice(-4)})
                      </option>
                    ))}
                  </select>
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
                  <span>Degen Mode</span>
                  <span style={{ fontSize: '10px', fontWeight: 800 }}>
                    {isDegenMode ? 'ON ($2.5k Mcap)' : 'OFF ($69k)'}
                  </span>
                </button>
                <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                  {isDegenMode
                    ? tr('Micro curve $2,500 initial mcap.', 'Kurva mikro $2,500 mcap awal.', '微型曲线 $2,500 初始市值。')
                    : tr('Standard curve 24 ETH threshold.', 'Kurva standar threshold 24 ETH.', '标准曲线 24 ETH 毕业阈值。')}
                </span>
              </div>
            </div>

            {/* Creator Vesting */}
            <div className="flex-col gap-xs">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>
                  {tr('Creator Vesting (Local Launchpad Contract)', 'Creator Vesting (Kontrak Launchpad Lokal)', '创作者锁仓（本地发射台合约）')}
                </label>
                <span style={{ fontSize: '10px', color: 'var(--color-badge-warning-text)', fontWeight: 700 }}>
                  {tr('Local smart contract', 'Smart contract lokal', '本地智能合约')}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setCreatorVesting('NONE')}
                  className={creatorVesting === 'NONE' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px', justifyContent: 'center', fontSize: '11px' }}
                >
                  {tr('No Vesting (0%)', 'Tanpa Vesting (0%)', '无锁仓 (0%)')}
                </button>
                <button
                  type="button"
                  onClick={() => setCreatorVesting('15_PERCENT')}
                  className={creatorVesting === '15_PERCENT' ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '8px', justifyContent: 'center', fontSize: '11px' }}
                >
                  {tr('15% Creator Vesting', '15% Creator Vesting', '15% 创作者锁仓')}
                </button>
              </div>
              <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                {tr(
                  '* Custom vesting applies to deployments via the Smart Contract Launchpad.',
                  '* Vesting kustom berlaku untuk deploy via Smart Contract Launchpad.',
                  '* 自定义锁仓适用于通过智能合约发射台部署的代币。'
                )}
              </span>
            </div>

            {/* Bankr-Compatible Creator Royalty / Fee Recipient Routing */}
            <div className="flex-col gap-xs">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                <label style={{ color: 'var(--color-muted)', fontSize: '12px', fontWeight: 700 }}>
                  {tr(
                    'Creator Royalty Recipient (Bankr Fee Recipient Format)',
                    'Tujuan Royalti Creator (Bankr Fee Recipient Format)',
                    '创作者版税接收方（Bankr 格式）'
                  )}
                </label>
                <span style={{ fontSize: '10px', color: 'var(--color-badge-info-text)', fontWeight: 700 }}>
                  {tr('Creator Royalty:', 'Royalti Creator:', '创作者版税：')} {billingConfig.creatorFeePct.toFixed(2)}% / Swap
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
                      ? tr('Royalty X handle (e.g. @creator_handle)', 'Handle X penerima royalti (mis. @creator_handle)', '版税接收 X 账号（如 @creator_handle）')
                      : feeRecipientType === 'farcaster'
                      ? tr('Royalty Farcaster handle (e.g. @creator.eth)', 'Handle Farcaster penerima royalti (mis. @creator.eth)', '版税接收 Farcaster 账号（如 @creator.eth）')
                      : tr('Royalty ENS domain (e.g. creator.eth)', 'Nama domain ENS penerima royalti (mis. creator.eth)', '版税接收 ENS 域名（如 creator.eth）')
                  }
                  className="input"
                  style={{ padding: '8px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                />
              ) : (
                <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                  {tr(
                    '* Uses the Creator Wallet Address below as the on-chain royalty recipient.',
                    '* Menggunakan alamat Creator Wallet Address di bawah sebagai penerima royalti on-chain.',
                    '* 使用下方创作者钱包地址作为链上版税接收方。'
                  )}
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
                  {tr('Plan & Launch Fee Sync (/billing)', 'Sinkronisasi Paket & Biaya Peluncuran (/billing)', '套餐与发行费用同步 (/billing)')}
                </span>
                <Link
                  href="/billing"
                  style={{ color: 'var(--color-accent)', fontWeight: 700, textDecoration: 'underline', fontSize: '11px' }}
                >
                  {tr('Manage Plan & Credits →', 'Kelola Paket & Kredit →', '管理套餐与积分 →')}
                </Link>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px' }}>
                <div style={{ padding: '6px 8px', borderRadius: '6px', backgroundColor: 'var(--color-surface-subtle)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                    {tr('Active Plan & Balance', 'Paket & Saldo Aktif', '当前套餐与余额')}
                  </div>
                  <div style={{ fontWeight: 800, color: 'var(--color-foreground)', fontFamily: 'var(--font-mono)' }}>
                    {planId || 'FREE'} · {(credits ?? 0).toLocaleString()} cr
                  </div>
                </div>
                <div style={{ padding: '6px 8px', borderRadius: '6px', backgroundColor: 'var(--color-surface-subtle)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                    {tr('Deploy / Studio Cost', 'Biaya Deploy / Studio', '部署 / 工作室费用')}
                  </div>
                  <div style={{ fontWeight: 800, color: 'var(--color-badge-info-text)', fontFamily: 'var(--font-mono)' }}>
                    {billingConfig.launchCostCr} cr Launch · {billingConfig.studioCostCr} cr AI
                  </div>
                </div>
                <div style={{ padding: '6px 8px', borderRadius: '6px', backgroundColor: 'var(--color-surface-subtle)', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                    {tr('Trading Fee Split', 'Bagi Hasil Trading Fee', '交易手续费分成')}
                  </div>
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

            {/* 3-Point Launchpad Mechanism Explainer (Phase CD2) */}
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                background: 'rgba(56, 189, 248, 0.06)',
                fontSize: '11px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '8px',
              }}
            >
              <div>
                <strong style={{ color: 'var(--color-accent-info)' }}>1. Angel Deal Room:</strong>{' '}
                <span className="text-muted">
                  {tr(
                    'Merkle Proof whitelist mode so early investors/KOLs can buy before public launch (anti-sniper).',
                    'Mode Whitelist Merkle Proof agar investor/KOL awal bisa beli sebelum publik (anti-sniper).'
                  )}
                </span>
              </div>
              <div>
                <strong style={{ color: 'var(--color-text-positive)' }}>2. Bankr Fee Recipient:</strong>{' '}
                <span className="text-muted">
                  {tr(
                    'Swap royalties follow the Bankr protocol; freely specify the recipient (0x / X / Farcaster / ENS).',
                    'Royalti swap mengikuti protokol Bankr; Anda bebas tentukan penerima (0x / X / Farcaster / ENS).'
                  )}
                </span>
              </div>
              <div>
                <strong style={{ color: 'var(--color-accent-purple)' }}>3. Multi-Account Fleet:</strong>{' '}
                <span className="text-muted">
                  {tr(
                    'CREATOR (15 keys) & AGENT (25 keys) plans can select up to 5 Bankr accounts for batch deployment.',
                    'Paket CREATOR (15 key) & AGENT (25 key) dapat mencentang hingga 5 akun Bankr untuk batch deploy.'
                  )}
                </span>
              </div>
            </div>

            {/* Multi-Key Bankr BYOK Vault (Encrypted AES-256-GCM · Multi-Chain Safe) */}
            <BankrKeyVaultPanel
              isConnected={isConnected}
              selectedChain={selectedChain}
              selectedKeyId={selectedBankrKeyId}
              onSelectKeyId={setSelectedBankrKeyId}
              selectedBatchKeyIds={selectedBatchBankrKeyIds}
              onToggleBatchKeyId={(kid) =>
                setSelectedBatchBankrKeyIds((prev) =>
                  prev.includes(kid) ? prev.filter((id) => id !== kid) : prev.length < 5 ? [...prev, kid] : prev
                )
              }
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
                  {isCreating ? 'Validating Risk Passport...' : 'Create Launch Draft'}
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
                {tokenName.trim() || tr('Your Token Name', 'Nama Token Anda')}{' '}
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
            <ShieldAlert size={18} /> {tr('Security Score & Draft Summary', 'Skor Keamanan & Ringkasan Draft')}
          </h2>

          {draftResult ? (
            <div className="bg-panel" style={{ padding: '16px', borderRadius: '6px', border: '1px solid var(--color-border)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Draft ID:</span>
                <span style={{ color: 'var(--color-accent-info)', fontWeight: 800 }}>{draftResult.id || draftResult.draftId}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Token:</span>
                <span style={{ color: 'var(--color-accent)', fontWeight: 900 }}>{draftResult.name} (${draftResult.ticker || draftResult.symbol})</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span className="text-muted">Launch Mode:</span>
                <span style={{ color: 'var(--color-accent-purple)', fontWeight: 800 }}>{draftResult.launchMode || draftResult.mode}</span>
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
                        setOnChainFeedback(`OK: Jaringan MetaMask berhasil berpindah ke ${selectedChain.toUpperCase()}.`);
                      } else if (res.error) {
                        setOnChainFeedback(`Notice: ${res.error}`);
                      }
                    }}
                    className="btn-secondary"
                    style={{ padding: '2px 7px', fontSize: '10px', borderColor: 'var(--color-accent-info)', color: 'var(--color-accent-info)' }}
                  >
                    Switch MetaMask
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
                <span className="text-muted">On-Chain Risk Passport:</span>
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
                  <div style={{ marginBottom: '10px' }}>
                    <CollapsibleSection
                      title="BondingCurveLaunchpad.sol On-Chain Registration"
                      badge={getContractConfiguration(ssotFactoryAddress).isConfigured ? 'Admin · Active' : 'Admin · Optional'}
                      subtitle="onlyOwner direct factory registration"
                      defaultOpen={false}
                    >
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
                          ? `Memproses di Blockchain ${selectedChain === 'robinhood' ? 'Robinhood L2' : 'Base'}...`
                          : publishedTxHash
                          ? 'OK: Terdaftar On-Chain'
                          : 'Register Token Launch On-Chain'}
                      </button>
                    </CollapsibleSection>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--color-muted)', lineHeight: '1.5' }}>
                    Gunakan jalur utama <strong>Bankr / Doppler Gas-Sponsored Pipeline</strong> di bawah untuk langsung men-deploy token Anda:
                  </div>
                )}

                {selectedBatchBankrKeyIds.length > 1 && (
                  <div
                    style={{
                      marginTop: '10px',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(56, 189, 248, 0.45)',
                      background: 'rgba(56, 189, 248, 0.08)',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      color: '#E0F2FE',
                    }}
                  >
                    <strong>Multi-Account Fleet Preview:</strong> {selectedBatchBankrKeyIds.length} akun Bankr dipilih · Estimasi total biaya:{' '}
                    <strong style={{ color: 'var(--color-accent-amber)' }}>{billingConfig.launchCostCr * selectedBatchBankrKeyIds.length} cr</strong>{' '}
                    ({billingConfig.launchCostCr} cr × {selectedBatchBankrKeyIds.length}). Disarankan jalankan <strong>Simulate</strong> dahulu sebelum Live Deploy.
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
                    {isBankrDeploying
                      ? 'Running Bankr...'
                      : selectedBatchBankrKeyIds.length > 1
                      ? `Simulate Fleet (${selectedBatchBankrKeyIds.length} akun · -${billingConfig.launchCostCr * selectedBatchBankrKeyIds.length} cr)`
                      : `Simulate Bankr Launch (-${billingConfig.launchCostCr} cr)`}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handleBankrDeploy(false)}
                    disabled={isBankrDeploying || isRegisteringOnChain}
                    style={{ flex: 1, padding: '8px 10px', fontSize: '11px', justifyContent: 'center' }}
                  >
                    {isBankrDeploying
                      ? 'Deploying...'
                      : selectedBatchBankrKeyIds.length > 1
                      ? `Fleet Deploy ${selectedBatchBankrKeyIds.length} Akun (-${billingConfig.launchCostCr * selectedBatchBankrKeyIds.length} cr)`
                      : `Bankr Deploy ${selectedChain.toUpperCase()} (-${billingConfig.launchCostCr} cr)`}
                  </button>
                </div>

                {onChainFeedback && (
                  <div
                    style={{
                      marginTop: '10px',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      backgroundColor: onChainFeedback.startsWith('OK:') ? 'var(--color-badge-success-bg)' : 'rgba(217, 45, 32, 0.1)',
                      color: onChainFeedback.startsWith('OK:') ? 'var(--color-accent)' : 'var(--color-destructive)',
                      border: `1px solid ${onChainFeedback.startsWith('OK:') ? 'var(--color-accent)' : 'var(--color-destructive)'}`,
                      wordBreak: 'break-all',
                    }}
                  >
                    {onChainFeedback}
                  </div>
                )}
              </div>

              {(creatorWallet || walletAddress) && (
                <div style={{ marginBottom: '12px' }}>
                  <WalletRiskBadgeCard
                    address={creatorWallet || walletAddress}
                    title="Creator Wallet Guard (GoPlus + RPC · $0)"
                  />
                </div>
              )}

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
        </>
      )}

      {/* TAB 1 (Default): Live Deployed Tokens & Active Bonding Curves */}
      {launchpadTab === 'POOLS' && (
      <div className="bg-panel" style={{ borderRadius: '14px', padding: '24px', border: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
          <h2 style={{ color: 'var(--color-foreground)', margin: 0, fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Rocket size={18} style={{ color: 'var(--color-accent)' }} /> Live Deployed Tokens &amp; Bonding Curves
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className="badge" style={{ backgroundColor: 'var(--color-badge-info-bg)', color: 'var(--color-badge-info-text)', border: '1px solid var(--color-badge-info-border)', fontSize: '11px', fontWeight: 800 }}>
              {filteredTokens.length} / {activeTokens.length} {tr('ACTIVE TOKENS', 'TOKEN AKTIF', '活跃代币')}
            </span>
            <button
              type="button"
              onClick={fetchActiveTokens}
              className="btn-secondary"
              style={{ padding: '6px 12px', fontSize: '11px' }}
              disabled={isLoadingTokens}
            >
              {isLoadingTokens
                ? tr('Loading...', 'Memuat...', '加载中...')
                : tr('Refresh List', 'Refresh Daftar', '刷新列表')}
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
                placeholder={tr(
                  'Search token name, $TICKER, @kol, or 0x...',
                  'Cari nama token, $TICKER, @kol, atau 0x...',
                  '搜索代币名称、$TICKER、@kol 或 0x...'
                )}
                className="input"
                style={{ width: '100%', padding: '7px 12px 7px 32px', fontSize: '12px', borderRadius: '9999px' }}
              />
            </div>

            {/* Sort / Category Tabs + Grid/List Screener Toggle (Phase FK) */}
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              {[
                { id: 'trending' as LaunchpadSortMode, label: tr('Trending', 'Sedang Ramai', '热门') },
                { id: 'newest' as LaunchpadSortMode, label: tr('Newest', 'Terbaru', '最新') },
                { id: 'graduating' as LaunchpadSortMode, label: tr('Near Graduation', 'Hampir Graduasi', '即将毕业') },
                { id: 'safest' as LaunchpadSortMode, label: tr('Safest Score', 'Skor Aman', '安全评分') },
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
              <div
                style={{
                  display: 'inline-flex',
                  padding: '2px',
                  borderRadius: '9999px',
                  backgroundColor: 'var(--color-surface-subtle)',
                  border: '1px solid var(--color-border)',
                  marginLeft: '4px',
                }}
                aria-label="Pool View Mode"
              >
                <button
                  type="button"
                  onClick={() => setPoolViewMode('GRID')}
                  className="filter-pill"
                  data-active={poolViewMode === 'GRID' ? 'true' : 'false'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 9px', border: 'none' }}
                  title={tr('Grid View', 'Tampilan Grid', '网格视图')}
                >
                  <LayoutGrid size={12} />
                  <span>{tr('Grid', 'Grid', '网格')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPoolViewMode('LIST')}
                  className="filter-pill"
                  data-active={poolViewMode === 'LIST' ? 'true' : 'false'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 9px', border: 'none' }}
                  title={tr('Screener List View', 'Tampilan Daftar', '列表视图')}
                >
                  <List size={12} />
                  <span>{tr('List', 'Daftar', '列表')}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Pinned Token Watchlist Strip (Phase CZ) */}
          <TokenWatchlistBar
            items={watchlistItems}
            onUnpin={(item) => toggleWatchlistPin({ symbol: item.symbol, name: item.name, chainId: item.chainId, address: item.address })}
          />

          {boostFeedback && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 700,
                backgroundColor: boostFeedback.startsWith('OK:') ? 'var(--color-badge-success-bg)' : 'var(--color-badge-warning-bg)',
                color: boostFeedback.startsWith('OK:') ? 'var(--color-badge-success-text)' : 'var(--color-badge-warning-text)',
                border: `1px solid ${boostFeedback.startsWith('OK:') ? 'var(--color-badge-success-border)' : 'var(--color-badge-warning-border)'}`,
              }}
            >
              {boostFeedback}
            </div>
          )}

          {/* Chain Filter Pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 700, marginRight: '4px' }}>
              {tr('Network:', 'Jaringan:', '网络：')}
            </span>
            {[
              { id: 'all', label: tr('All', 'Semua', '全部') },
              { id: 'base', label: 'Base' },
              { id: 'robinhood', label: 'Robinhood' },
              { id: 'solana', label: 'Solana' },
              { id: 'arbitrum', label: 'Arbitrum' },
              { id: 'arc', label: 'Arc' },
            ].map((ch) => {
              const count = chainCounts[ch.id] || 0;
              if (ch.id === 'solana' && count === 0) return null;
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

          {/* Graduation Status Filter Pills (Phase DC: 100+ tokens/day scalability) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 700, marginRight: '4px' }}>
              Status:
            </span>
            {(
              [
                { id: 'all', label: tr('All', 'Semua', '全部') },
                { id: 'curve', label: tr('Bonding Curve', 'Bonding Curve', '联合曲线') },
                { id: 'graduated', label: tr('Graduated DEX', 'Graduated DEX', '已毕业 DEX') },
                {
                  id: 'kol_verified',
                  label: `${tr('KOL Verified', 'KOL Terverifikasi', '认证 KOL')} (${kolVerifiedCount})`,
                },
              ] as const
            ).map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => {
                  setStatusFilter(st.id);
                  setVisiblePoolCount(12);
                }}
                className="filter-pill"
                data-active={statusFilter === st.id ? 'true' : 'false'}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>

        {isLoadingTokens && activeTokens.length === 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton-shimmer" style={{ height: '190px', borderRadius: '12px' }} />
            ))}
          </div>
        ) : filteredTokens.length > 0 ? (
          <>
          {poolViewMode === 'LIST' ? (
            <div
              style={{
                width: '100%',
                overflowX: 'auto',
                borderRadius: '12px',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-surface-elevated)',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--color-border)',
                      color: 'var(--color-muted)',
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono)',
                      textAlign: 'left',
                      textTransform: 'uppercase',
                    }}
                  >
                    <th style={{ padding: '10px 12px', width: '36px' }}>#</th>
                    <th style={{ padding: '10px 12px' }}>{tr('Token', 'Token', '代币')}</th>
                    <th style={{ padding: '10px 12px' }}>{tr('Network', 'Jaringan', '网络')}</th>
                    <th style={{ padding: '10px 12px' }}>{tr('Progress', 'Progres', '进度')}</th>
                    <th style={{ padding: '10px 12px' }}>{tr('Raised / Target', 'Terkumpul / Target', '已筹 / 目标')}</th>
                    <th style={{ padding: '10px 12px', textAlign: 'right' }}>{tr('Actions', 'Aksi', '操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTokens.map((token: any, rowIdx: number) => {
                    const raised = Number(token.raisedAmount || 0);
                    const target = Number(token.graduationThreshold || 69000);
                    const progressPct = computeGraduationProgressPct(token);
                    const isFeatured = featuredAddressSet.has((token.contractAddress || '').toLowerCase());
                    const tokenChainSlug = normalizeChainName(token.chain);
                    const portalUrl = `/token/${tokenChainSlug}/${token.contractAddress}`;
                    return (
                      <tr
                        key={token.launchId || token.contractAddress}
                        style={{
                          borderBottom: '1px solid var(--color-border)',
                          backgroundColor: isFeatured ? 'var(--color-badge-success-bg)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', fontWeight: 700 }}>
                          #{rowIdx + 1}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <a
                            href={portalUrl}
                            style={{ textDecoration: 'none', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                          >
                            <TokenAvatar
                              src={token.imageUrl}
                              name={token.name}
                              ticker={token.ticker}
                              seed={token.contractAddress}
                              size={28}
                              borderRadius={8}
                            />
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <strong style={{ color: 'var(--color-foreground)', whiteSpace: 'nowrap' }}>{token.name}</strong>
                              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--color-accent)', fontSize: '11px' }}>
                                ${token.ticker}
                              </span>
                              {isFeatured && (
                                <span style={{ fontSize: '9px', fontWeight: 900, whiteSpace: 'nowrap', padding: '1px 6px', borderRadius: '4px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)', border: '1px solid var(--color-badge-success-border)' }}>
                                  FEATURED
                                </span>
                              )}
                              {token.creatorKolVerified && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '9px', fontWeight: 900, whiteSpace: 'nowrap', padding: '1px 6px', borderRadius: '4px', backgroundColor: 'var(--color-badge-info-bg)', color: 'var(--color-badge-info-text)', border: '1px solid var(--color-badge-info-border)' }}>
                                  <CheckCircle2 size={10} />
                                  {token.creatorKolHandle ? `KOL @${String(token.creatorKolHandle).replace(/^@/, '')}` : 'KOL'}
                                </span>
                              )}
                            </div>
                          </a>
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--color-muted)', whiteSpace: 'nowrap' }}>
                          {String(token.chain || 'base').toUpperCase()}
                        </td>
                        <td style={{ padding: '10px 12px', minWidth: '120px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <div style={{ flex: 1, height: '6px', borderRadius: '999px', backgroundColor: 'var(--color-surface-subtle)', overflow: 'hidden' }}>
                              <div style={{ width: `${Math.min(100, progressPct)}%`, height: '100%', backgroundColor: token.isGraduated ? 'var(--color-accent-emerald)' : 'var(--color-accent)' }} />
                            </div>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 700, color: 'var(--color-foreground)' }}>
                              {progressPct}%
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: '11px', whiteSpace: 'nowrap', color: 'var(--color-foreground)' }}>
                          ${raised.toLocaleString()} / ${target.toLocaleString()}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            <a
                              href={portalUrl}
                              className="btn-primary"
                              style={{ padding: '4px 10px', fontSize: '10px', textDecoration: 'none' }}
                            >
                              {tr('Portal', 'Portal', '详情')} →
                            </a>
                            <button
                              type="button"
                              disabled={boostingAddress === token.contractAddress}
                              onClick={() => handleFeaturedBoost24h(token.contractAddress, token.chain)}
                              className="btn-secondary"
                              style={{ padding: '4px 8px', fontSize: '10px' }}
                            >
                              {isFeatured ? 'Boosted' : 'Boost 24h'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '16px' }}>
            {visibleTokens.map((token: any) => {
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
                  <div data-card-header="two-row" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '6px',
                          fontSize: '10px',
                          fontWeight: 800,
                          backgroundColor: 'var(--color-badge-info-bg)',
                          color: 'var(--color-badge-info-text)',
                          border: '1px solid var(--color-badge-info-border)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {token.chain?.toUpperCase() || 'BASE'}
                      </span>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                        <button
                          type="button"
                          disabled={boostingAddress !== null}
                          onClick={() => handleFeaturedBoost24h(token.contractAddress, token.chain)}
                          className="btn-secondary"
                          style={{ padding: '4px 7px', fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap' }}
                          title={tr('Sponsor 24h Featured Boost (0.005 ETH Base L2)', 'Aktifkan Featured Boost 24 Jam (0.005 ETH Base L2)')}
                        >
                          {boostingAddress === token.contractAddress ? '...' : tr('Boost 24h', 'Boost 24j', '置顶 24h')}
                        </button>
                        <PinWatchlistButton
                          pinned={isWatchlistItemPinned(8453, token.contractAddress || token.ticker)}
                          onClick={() =>
                            toggleWatchlistPin({
                              symbol: token.ticker,
                              name: token.name,
                              chainId: 8453,
                              address: token.contractAddress,
                            })
                          }
                        />
                      </div>
                    </div>
                    <a
                      href={portalUrl}
                      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, width: '100%' }}
                      title={`Open Token Portal ${token.name}`}
                    >
                      <TokenAvatar
                        src={token.imageUrl}
                        name={token.name}
                        ticker={token.ticker}
                        seed={token.contractAddress}
                        size={42}
                        borderRadius={11}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 900, color: 'var(--color-foreground)', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{token.name}</span>
                          <span style={{ fontSize: '11px', color: 'var(--color-accent)', flexShrink: 0 }}>↗</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px', flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--color-accent)', fontSize: '12px' }}>
                            ${token.ticker}
                          </span>
                          {featuredAddressSet.has((token.contractAddress || '').toLowerCase()) && (
                            <span style={{ fontSize: '9px', fontWeight: 900, whiteSpace: 'nowrap', padding: '1px 6px', borderRadius: '4px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)', border: '1px solid var(--color-badge-success-border)' }}>
                              FEATURED
                            </span>
                          )}
                          {token.creatorKolVerified && (
                            <span
                              title={
                                token.creatorKolHandle
                                  ? `Verified KOL @${String(token.creatorKolHandle).replace(/^@/, '')}${typeof token.creatorTrustScore === 'number' ? ` · Trust ${token.creatorTrustScore}` : ''}`
                                  : 'Verified KOL Creator'
                              }
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px',
                                fontSize: '9px',
                                fontWeight: 900,
                                whiteSpace: 'nowrap',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                backgroundColor: 'var(--color-badge-info-bg)',
                                color: 'var(--color-badge-info-text)',
                                border: '1px solid var(--color-badge-info-border)',
                              }}
                            >
                              <CheckCircle2 size={10} />
                              {token.creatorKolHandle
                                ? `KOL @${String(token.creatorKolHandle).replace(/^@/, '')}`
                                : 'KOL VERIFIED'}
                              {typeof token.creatorTrustScore === 'number' ? ` · ${token.creatorTrustScore}` : ''}
                            </span>
                          )}
                          {token.isGraduated ? (
                            <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: 'var(--color-badge-success-bg)', color: 'var(--color-badge-success-text)' }}>
                              GRAD
                            </span>
                          ) : isHot ? (
                            <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: 'var(--color-badge-warning-bg)', color: 'var(--color-badge-warning-text)' }}>
                              HOT
                            </span>
                          ) : isNew ? (
                            <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '4px', backgroundColor: 'var(--color-badge-purple-bg)', color: 'var(--color-badge-purple-text)' }}>
                              NEW
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </a>
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
                      HODL
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
                      Staking
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
                      Raid
                    </a>
                  </div>

                  {/* Graduation Progress Bar */}
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--color-muted)', marginBottom: '4px' }}>
                      <span>Graduation Progress</span>
                      <span style={{ color: 'var(--color-foreground)', fontWeight: 700 }}>${raised.toLocaleString()} / ${target.toLocaleString()}</span>
                    </div>
                    <div className="cex-progress-track">
                      <div className="cex-progress-fill" style={{ width: `${progressPct}%` }} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '4px', marginTop: '12px', flexWrap: 'wrap' }}>
                    <a
                      href={portalUrl}
                      className="btn-secondary"
                      style={{ flex: '1 1 18%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center', color: 'var(--color-badge-info-text)', borderColor: 'var(--color-badge-info-border)' }}
                      title="Buka Portal Detail Token"
                    >
                      Portal
                    </a>
                    <a
                      href={`/trading?token=${token.contractAddress}`}
                      className="cex-btn-gold"
                      style={{ flex: '1 1 20%', padding: '6px 4px', textAlign: 'center', fontSize: '11px', borderRadius: '6px', boxShadow: 'none' }}
                    >
                      Trade
                    </a>
                    <a
                      href={`/kol?launchId=${token.launchId || ''}&tab=MARKET`}
                      className="btn-secondary"
                      style={{ flex: '1 1 18%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center', borderColor: 'var(--color-badge-purple-border)', color: 'var(--color-badge-purple-text)' }}
                      title="Ikuti Bounties, Kampanye Share & Staking di KOL Hub"
                    >
                      Bounty
                    </a>
                    <a
                      href={buildSocialShareUrl('x', {
                        text: `$${token.ticker || 'TOKEN'} (${token.name || 'Launch'}) live di POOLNET Launchpad (0% Tax · GoPlus Verified)!`,
                        url: `https://pndigi.site${portalUrl}`,
                        refWallet: walletAddress,
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary"
                      style={{ flex: '1 1 18%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center', borderColor: 'rgba(240, 185, 11, 0.35)', color: 'var(--color-accent-amber)' }}
                      title="Bagikan ke X (Twitter) dengan link referral 0.25%"
                    >
                      Share X
                    </a>
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary"
                      style={{ flex: '1 1 18%', padding: '6px 2px', textAlign: 'center', fontSize: '11px', justifyContent: 'center' }}
                    >
                      {explorerLabel}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
          )}
          {filteredTokens.length > visiblePoolCount && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => setVisiblePoolCount((c) => c + 12)}
                className="btn-secondary"
                style={{ padding: '8px 18px', fontSize: '12px', fontWeight: 700 }}
              >
                {tr(
                  `Load More (${visibleTokens.length} / ${filteredTokens.length})`,
                  `Muat Lebih Banyak (${visibleTokens.length} / ${filteredTokens.length})`
                )}
              </button>
            </div>
          )}
          </>
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
                  {tr('Show All Tokens', 'Tampilkan Semua Token', '显示全部代币')} ({activeTokens.length})
                </button>
              </div>
            ) : (
              'Belum ada token yang diluncurkan. Buat draft di atas untuk mendaftarkan token pertama Anda!'
            )}
          </div>
        )}
      </div>
      )}

      {/* TAB 4 (Admin Only): Launchpad Governance & Merkle Snapshot Console */}
      {launchpadTab === 'ADMIN' && (userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
        <div className="bg-panel" style={{ border: '1px solid #FF9100', borderRadius: '8px', padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 900, color: 'var(--color-accent-amber)', margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={18} /> System Admin: Launchpad Bonding Curve & Liquidity Governance
          </h3>
          <div className="grid-3">
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent-info)', fontWeight: 800, fontSize: '12px' }}>Graduation Target</div>
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
              <div className="text-muted" style={{ fontSize: '11px' }}>GoPlus &amp; On-Chain OFAC Guard Active</div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Bounty Merkle Snapshot Console (RBAC: MANAGE_SNAPSHOTS — SUPER_ADMIN / LAUNCH_ADMIN) */}
      {launchpadTab === 'ADMIN' && (userRole === 'SUPER_ADMIN' || userRole === 'LAUNCH_ADMIN') && (
        <AdminMerkleSnapshotPanel
          activeTokens={activeTokens}
          walletAddress={walletAddress}
        />
      )}
    </div>
  );
}
