'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';
import { CreditCard, CheckCircle2, ShieldAlert, Zap, TrendingUp, Wallet, Banknote, Scale, History, RefreshCw } from 'lucide-react';
import { ethers } from 'ethers';
import { ensureBaseNetwork, getBrowserSigner, normalizeWeb3Error, resolveBrowserEthereumProvider } from '@packages/launchpad/web3-provider';
import { PageWorkflowBanner } from '../components/PageWorkflowBanner';
import { BillingAddonStorePanel } from '../components/BillingAddonStorePanel';
import { ProviderRegistryStatusPanel } from '../components/ProviderRegistryStatusPanel';
import { UserWebhookVaultPanel } from '../components/UserWebhookVaultPanel';
import { UserSecurityActivityPanel } from '../components/UserSecurityActivityPanel';
import { AdminOpsHealthPanel } from '../components/AdminOpsHealthPanel';
import { AdminWhiteLabelPartnersPanel } from '../components/AdminWhiteLabelPartnersPanel';
import { AdminGenesisSnapshotPanel } from '../components/AdminGenesisSnapshotPanel';
import { AdminKolVerificationPanel } from '../components/AdminKolVerificationPanel';
import { OwnedWalletsAllowlistPanel } from '../components/OwnedWalletsAllowlistPanel';

interface LedgerEntry {
  id: string;
  amount: number;
  currency: string;
  type: string;
  referenceId: string | null;
  description: string;
  createdAt: string;
}

interface VaultCategoryCount {
  total: number;
  active: number;
  frozenOverQuota: number;
  frozenMainnetLocked: number;
  maxAllowed: number;
}

interface UserVaultSummaryData {
  planId: string;
  allowMainnetCex: boolean;
  addonSlots: {
    bankrExtraSlots: number;
    binanceExtraSlots: number;
  };
  vaults: {
    bankr: VaultCategoryCount;
    binance: VaultCategoryCount;
    bybit: VaultCategoryCount;
    byokLlm: VaultCategoryCount;
    webhook: VaultCategoryCount;
  };
}

interface Plan {
  id: string;
  name: string;
  priceUsd?: number;
  monthlyPriceUsd?: number;
  originalPriceUsd?: number;
  priceEth?: string;
  originalPriceEth?: string;
  discountPct?: number;
  promoLabel?: string;
  monthlyCredits: number;
  hasLiveTrading?: boolean;
  hasCreatorAccess?: boolean;
  hasAgentAccess?: boolean;
  hasPriorityScrape?: boolean;
  features?: string[];
  capacities?: {
    planId: string;
    monthlyCredits: number;
    maxBankrKeys: number;
    maxBinanceAccounts: number;
    allowMainnetBinance: boolean;
    maxOrderValueUsd: number;
    maxDailyLossUsd: number;
  };
}

export default function BillingPage() {
  const { isConnected, userRole, hasCapability, planId, credits, connectMetaMask, isConnecting, refreshSession } = useAuth();
  const { t, tr } = useLocale();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePlanId, setActivePlanId] = useState<string>('FREE');
  const [txHashInput, setTxHashInput] = useState<string>('');
  const [paymentFeedback, setPaymentFeedback] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<string | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [vaultSummary, setVaultSummary] = useState<UserVaultSummaryData | null>(null);
  const [activeBillingTab, setActiveBillingTab] = useState<'plans' | 'vaults' | 'history' | 'admin'>('plans');

  // Admin Discount Management State
  const [discountPlanId, setDiscountPlanId] = useState<string>('CREATOR');
  const [discountPctInput, setDiscountPctInput] = useState<number>(20);
  const [promoLabelInput, setPromoLabelInput] = useState<string>('LAUNCH PROMO');
  const [discountSaving, setDiscountSaving] = useState<boolean>(false);
  const [discountFeedback, setDiscountFeedback] = useState<string | null>(null);

  // Admin Platform Fee, Credit Burn & Risk Gate Configurator State
  const [studioCostCr, setStudioCostCr] = useState<number>(1);
  const [deskCostCr, setDeskCostCr] = useState<number>(5);
  const [launchCostCr, setLaunchCostCr] = useState<number>(50);
  const [maxOrderValueUsd, setMaxOrderValueUsd] = useState<number>(10000);
  const [maxDailyLossUsd, setMaxDailyLossUsd] = useState<number>(1000);
  const [maxSlippagePct, setMaxSlippagePct] = useState<number>(3.0);
  const [dexSwapFeeBps, setDexSwapFeeBps] = useState<number>(25);
  const [treasuryWallet, setTreasuryWallet] = useState<string>('0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6');
  const [launchpadContractAddress, setLaunchpadContractAddress] = useState<string>('');
  const [isVerifyingBytecode, setIsVerifyingBytecode] = useState<boolean>(false);
  const [configSaving, setConfigSaving] = useState<boolean>(false);
  const [configFeedback, setConfigFeedback] = useState<string | null>(null);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/plans');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setPlans(json.data);
      }
      if (json.platformConfig) {
        const cfg = json.platformConfig;
        if (typeof cfg.studioCostCr === 'number') setStudioCostCr(cfg.studioCostCr);
        if (typeof cfg.deskCostCr === 'number') setDeskCostCr(cfg.deskCostCr);
        if (typeof cfg.launchCostCr === 'number') setLaunchCostCr(cfg.launchCostCr);
        if (typeof cfg.maxOrderValueUsd === 'number') setMaxOrderValueUsd(cfg.maxOrderValueUsd);
        if (typeof cfg.maxDailyLossUsd === 'number') setMaxDailyLossUsd(cfg.maxDailyLossUsd);
        if (typeof cfg.maxSlippagePct === 'number') setMaxSlippagePct(cfg.maxSlippagePct);
        if (typeof cfg.dexSwapFeeBps === 'number') setDexSwapFeeBps(cfg.dexSwapFeeBps);
        if (typeof cfg.treasuryWallet === 'string' && cfg.treasuryWallet) setTreasuryWallet(cfg.treasuryWallet);
        if (typeof cfg.launchpadContractAddress === 'string') setLaunchpadContractAddress(cfg.launchpadContractAddress);
      }
    } catch (err) {
      console.warn('[Billing UI] API fetch error (using fallback plans):', (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLedger = useCallback(async () => {
    if (!isConnected) {
      setLedgerEntries([]);
      return;
    }
    setLedgerLoading(true);
    try {
      const res = await fetch('/api/billing/ledger?limit=20', { credentials: 'same-origin' });
      const json = await res.json();
      if (json.success && Array.isArray(json.data?.entries)) {
        setLedgerEntries(json.data.entries);
      }
    } catch {
      // Non-blocking
    } finally {
      setLedgerLoading(false);
    }
  }, [isConnected]);

  const fetchVaultSummary = useCallback(async () => {
    if (!isConnected) {
      setVaultSummary(null);
      return;
    }
    try {
      const res = await fetch('/api/user/vault-summary', { credentials: 'same-origin' });
      const json = await res.json();
      if (res.ok && json?.success && json.data) {
        setVaultSummary(json.data);
      }
    } catch {
      // Non-blocking telemetry
    }
  }, [isConnected]);

  useEffect(() => {
    fetchLedger();
  }, [fetchLedger, credits, activePlanId]);

  useEffect(() => {
    fetchVaultSummary();
  }, [fetchVaultSummary, activePlanId]);

  useEffect(() => {
    if (planId) {
      setActivePlanId(planId.toUpperCase());
    }
  }, [planId]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const handleSaveDiscount = async (overridePct?: number) => {
    const pctToApply = overridePct !== undefined ? overridePct : discountPctInput;
    setDiscountSaving(true);
    setDiscountFeedback(null);
    try {
      const res = await fetch('/api/billing/plans', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: discountPlanId,
          discountPct: pctToApply,
          promoLabel: pctToApply > 0 ? promoLabelInput.trim() || `${pctToApply}% OFF` : '',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setDiscountFeedback(`Notice: Gagal menyimpan diskon (${res.status}): ${json.error || 'Forbidden / Error'}`);
        return;
      }
      await fetchPlans();
      setDiscountFeedback(
        pctToApply > 0
          ? `OK: Diskon ${pctToApply}% (${promoLabelInput || 'PROMO'}) diterapkan pada paket ${discountPlanId}!`
          : `OK: Diskon paket ${discountPlanId} di-reset ke harga normal (0%).`
      );
    } catch (err: any) {
      setDiscountFeedback(`Notice: Gagal menyimpan diskon: ${err?.message || 'Network error'}`);
    } finally {
      setDiscountSaving(false);
    }
  };

  const handleVerifyContractBytecode = async () => {
    const addr = launchpadContractAddress.trim();
    if (!addr || !ethers.isAddress(addr)) {
      setConfigFeedback('Notice: Masukkan alamat EVM 0x... yang valid terlebih dahulu sebelum verifikasi bytecode.');
      return;
    }
    const ethereum = resolveBrowserEthereumProvider();
    if (!ethereum) {
      setConfigFeedback('Notice: MetaMask tidak terdeteksi untuk mengecek bytecode on-chain (eth_getCode).');
      return;
    }
    setIsVerifyingBytecode(true);
    setConfigFeedback(null);
    try {
      const [code, activeChainHex] = await Promise.all([
        ethereum.request({ method: 'eth_getCode', params: [ethers.getAddress(addr), 'latest'] }),
        ethereum.request({ method: 'eth_chainId' }).catch(() => 'unknown'),
      ]);
      if (typeof code === 'string' && code.length > 2 && code !== '0x0') {
        const byteLen = Math.floor((code.length - 2) / 2);
        setConfigFeedback(
          `OK: Kontrak terverifikasi on-chain pada chain ${activeChainHex} (${byteLen.toLocaleString()} bytes bytecode). Siap disimpan ke SSOT.`
        );
      } else {
        setConfigFeedback(
          `Notice: Tidak ditemukan bytecode kontrak (eth_getCode = 0x) untuk ${addr} pada chain ${activeChainHex}. Pastikan alamat adalah Smart Contract (bukan dompet EOA) dan jaringan MetaMask sesuai.`
        );
      }
    } catch (err: any) {
      setConfigFeedback(`Notice: Gagal memeriksa bytecode on-chain: ${normalizeWeb3Error(err)}`);
    } finally {
      setIsVerifyingBytecode(false);
    }
  };

  const handleSavePlatformConfig = async () => {
    setConfigSaving(true);
    setConfigFeedback(null);
    try {
      const res = await fetch('/api/billing/plans', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-platform-config',
          studioCostCr,
          deskCostCr,
          launchCostCr,
          maxOrderValueUsd,
          maxDailyLossUsd,
          maxSlippagePct,
          dexSwapFeeBps,
          treasuryWallet,
          launchpadContractAddress: launchpadContractAddress.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setConfigFeedback(`Notice: Gagal menyimpan konfigurasi (${res.status}): ${json.error || 'Error'}`);
        return;
      }
      await fetchPlans();
      setConfigFeedback(
        `OK: Parameter bisnis & Risk Gate berhasil diperbarui di PostgreSQL SSOT (Burn: ${studioCostCr}/${deskCostCr}/${launchCostCr} cr · Max Order: $${maxOrderValueUsd.toLocaleString()}).`
      );
    } catch (err: any) {
      setConfigFeedback(`Notice: Gagal menyimpan konfigurasi: ${err?.message || 'Network error'}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handlePayWithMetaMask = async (plan: Plan) => {
    if (!isConnected) {
      setPaymentFeedback('Auth: SIWE Session Required: Silakan hubungkan dompet MetaMask terlebih dahulu.');
      return;
    }
    const targetPlanId = plan.id.toUpperCase();
    const ethStr = plan.priceEth || '0';
    const ethNum = parseFloat(ethStr);
    if (!Number.isFinite(ethNum) || ethNum <= 0) {
      return handleSubscribe(plan);
    }

    setIsProcessing(targetPlanId);
    setPaymentFeedback(`Memeriksa jaringan Base L2 & menyiapkan pembayaran ${ethStr} ETH di MetaMask...`);
    try {
      const netCheck = await ensureBaseNetwork();
      if (!netCheck.success) {
        setPaymentFeedback(`Notice: ${netCheck.error || 'Harap beralih ke jaringan Base di MetaMask.'}`);
        return;
      }
      const signer = await getBrowserSigner();
      const networkLabel = netCheck.hexChainId === '0x14a34' ? 'Base Sepolia (Testnet)' : 'Base Mainnet';
      const treasuryTo = ethers.getAddress(
        (treasuryWallet || '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6').trim().toLowerCase()
      );
      const requiredWei = ethers.parseEther(ethStr);

      // Pre-flight balance check to prevent cryptic ethers estimateGas "missing revert data" errors
      if (signer.provider) {
        const senderAddr = await signer.getAddress();
        const balanceWei = await signer.provider.getBalance(senderAddr).catch(() => null);
        if (balanceWei !== null && balanceWei < requiredWei) {
          const formattedBal = Number(ethers.formatEther(balanceWei)).toFixed(6);
          setPaymentFeedback(
            `Notice: Saldo ETH di ${networkLabel} tidak mencukupi: saldo Anda ${formattedBal} ETH, dibutuhkan minimal ${ethStr} ETH + biaya gas. Silakan isi ETH di ${networkLabel} terlebih dahulu.`
          );
          return;
        }
      }

      // For plain EOA treasury transfers, pass explicit 21,000 gasLimit to bypass flaky RPC estimateGas reverts
      const targetCode = signer.provider ? await signer.provider.getCode(treasuryTo).catch(() => '0x') : '0x';
      const isPlainEoa = !targetCode || targetCode === '0x' || targetCode === '0x0';

      const tx = await signer.sendTransaction({
        to: treasuryTo,
        value: requiredWei,
        ...(isPlainEoa ? { gasLimit: BigInt(21000) } : {}),
      });
      setTxHashInput(tx.hash);
      setPaymentFeedback(`Transaksi terkirim (${tx.hash.slice(0, 12)}...). Menunggu 1 konfirmasi blok Base...`);
      await tx.wait(1);

      const settledChain = netCheck.hexChainId === '0x14a34' ? 'base-sepolia' : 'base-mainnet';
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: targetPlanId,
          txHash: tx.hash,
          chain: settledChain,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setPaymentFeedback(`Notice: Pembayaran terkirim (${tx.hash}), namun aktivasi gagal: ${json.error || 'Unknown error'}`);
        return;
      }
      setActivePlanId(targetPlanId);
      await refreshSession();
      await fetchLedger();
      setPaymentFeedback(
        `OK: Pembayaran On-Chain (${tx.hash.slice(0, 10)}...) terverifikasi! Tier ${plan.name} aktif dengan ${Number(json.data.credits).toLocaleString()} Credits.`
      );
    } catch (err: any) {
      setPaymentFeedback(`Notice: Pembayaran MetaMask dibatalkan / gagal: ${normalizeWeb3Error(err)}`);
    } finally {
      setIsProcessing(null);
    }
  };

  const handleSubscribe = async (plan: Plan) => {
    if (!isConnected) {
      setPaymentFeedback('Auth: SIWE Session Required: Silakan hubungkan dompet MetaMask terlebih dahulu.');
      return;
    }

    const targetPlanId = plan.id.toUpperCase();
    setIsProcessing(targetPlanId);
    setPaymentFeedback(null);

    try {
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: targetPlanId,
          txHash: txHashInput.trim() || undefined,
          chain: 'base-mainnet',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setPaymentFeedback(`Notice: Upgrade gagal (${res.status}): ${json.error || 'Unknown error'}`);
        return;
      }

      setActivePlanId(targetPlanId);
      await refreshSession();
      await fetchLedger();
      setPaymentFeedback(
        `OK: Tier ${plan.name} (${targetPlanId}) aktif! Saldo kredit: ${Number(json.data.credits).toLocaleString()} Credits${json.data.unlockedCreatorRole ? ' · Role CREATOR terbuka!' : ''}`
      );
    } catch (err: any) {
      setPaymentFeedback(`Notice: Koneksi gagal: ${err?.message || 'Tidak dapat menghubungi server'}`);
    } finally {
      setIsProcessing(null);
    }
  };

  const defaultPlans: Plan[] = [
    { id: 'FREE', name: 'Free Degen', priceUsd: 0, priceEth: '0', monthlyCredits: 100, hasLiveTrading: false, hasCreatorAccess: false, hasAgentAccess: false, hasPriorityScrape: false },
    { id: 'CREATOR', name: 'Token Creator', priceUsd: 49, priceEth: '0.015', monthlyCredits: 2000, hasLiveTrading: false, hasCreatorAccess: true, hasAgentAccess: false, hasPriorityScrape: true },
    { id: 'TRADER', name: 'Pro Terminal Trader', priceUsd: 79, priceEth: '0.025', monthlyCredits: 5000, hasLiveTrading: true, hasCreatorAccess: false, hasAgentAccess: false, hasPriorityScrape: true },
    { id: 'AGENT', name: 'AI Autonomous Desk', priceUsd: 149, priceEth: '0.045', monthlyCredits: 15000, hasLiveTrading: true, hasCreatorAccess: true, hasAgentAccess: true, hasPriorityScrape: true },
  ];

  const displayPlans = plans.length > 0 ? plans : defaultPlans;

  return (
    <div className="flex-col gap-lg">
      {/* CEX Account & Billing Hero Banner */}
      <div className="cex-hero-banner">
        <div>
          <div className="cex-hero-eyebrow">
            Account · Plans · API Vaults · Telegram Alerts
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 900, margin: '0 0 4px 0', color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CreditCard size={20} style={{ color: 'var(--color-accent-amber)' }} /> {t('billing.title')}
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            {t('billing.subtitle')}
          </p>
        </div>
        <div className="flex-row gap-sm items-center tabular-nums">
          {isConnected && (
            <>
              <div className="bg-panel" style={{ border: '1px solid var(--color-badge-warning-border)', padding: '6px 12px', borderRadius: '8px', fontSize: '12px' }}>
                <span className="text-muted">{tr('Plan: ', 'Paket: ')}</span>
                <span style={{ color: 'var(--color-badge-warning-text)', fontWeight: 800 }}>{activePlanId}</span>
              </div>
              <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '6px 12px', borderRadius: '8px', fontSize: '12px' }}>
                <span className="text-muted">{tr('Balance: ', 'Saldo: ')}</span>
                <span style={{ color: 'var(--color-badge-info-text)', fontWeight: 800 }}>{credits.toLocaleString()} {tr('Credits', 'Kredit')}</span>
              </div>
            </>
          )}
          <span className="badge badge-trader" style={{ border: '1px solid var(--color-badge-success-border)', color: 'var(--color-badge-success-text)', backgroundColor: 'var(--color-badge-success-bg)' }}>
            {loading ? tr('Loading...', 'Memuat...') : tr('Active', 'Aktif')}
          </span>
        </div>
      </div>

      {/* CEX Category Tab Bar for /billing */}
      <div role="tablist" aria-label="Navigasi Halaman Billing dan Vault" className="cex-tab-bar">
        {(
          [
            { id: 'plans', label: t('billing.tabPlans'), hint: 'FREE · CREATOR · TRADER · AGENT', icon: CreditCard },
            { id: 'vaults', label: t('billing.tabVaults'), hint: 'Vault · Webhook · Provider', icon: Zap },
            { id: 'history', label: t('billing.tabHistory'), hint: 'Ledger & Explorer Log', icon: History },
            ...((hasCapability('MANAGE_BILLING_PLANS') || userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' || userRole === 'BILLING_ADMIN')
              ? [{ id: 'admin' as const, label: t('billing.tabAdmin'), hint: 'Promo · Risk · Kill-Switch', icon: ShieldAlert }]
              : []),
          ] as const
        ).map((tab) => {
          const active = activeBillingTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveBillingTab(tab.id)}
              className={`cex-tab-btn ${active ? 'active' : ''}`}
              style={{ flex: '1 1 170px', justifyContent: 'space-between' }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Icon size={14} /> {tab.label}
              </span>
              <span style={{ fontSize: '10px', opacity: 0.72, fontWeight: 600 }}>{tab.hint}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: Paket & Harga */}
      {activeBillingTab === 'plans' && (
        <div className="flex-col gap-lg">
      {/* Workflow & Plan Entitlement Guide */}
      <PageWorkflowBanner
        title={tr('How Subscriptions & Credits Work', 'Cara Berlangganan & Menggunakan Kredit')}
        isUnlocked={true}
        creditSummary={tr(
          `Feature Rates: Studio ${studioCostCr} cr · AI Desk ${deskCostCr} cr · Launch ${launchCostCr} cr`,
          `Tarif Fitur: Studio ${studioCostCr} cr · AI Desk ${deskCostCr} cr · Launch ${launchCostCr} cr`
        )}
        steps={[
          { step: '1', label: tr('Choose Plan (FREE / CREATOR / TRADER / AGENT)', 'Pilih Paket (FREE / CREATOR / TRADER / AGENT)') },
          { step: '2', label: tr('1-Click ETH Payment via MetaMask / Promo', 'Bayar 1-Klik ETH via MetaMask / Promo') },
          { step: '3', label: tr('Plan & Credits Activate Instantly', 'Paket & Kredit Langsung Aktif') },
          { step: '4', label: tr('Track Usage in Credit Ledger', 'Pantau Riwayat di Mutasi Kredit') },
        ]}
      />

      {/* Optional On-Chain Payment TxHash Bar for Mainnet Upgrades */}
      {isConnected && (
        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ fontSize: '12px', color: 'var(--color-muted)' }}>
            <strong style={{ color: 'var(--color-foreground)' }}>On-Chain Base Payment Verifier:</strong>{' '}
            {tr(
              'On Testnet (testnet.pndigi.site), activate any tier with 1 click. On Mainnet (pndigi.site), paste your Base L2 payment txHash here for instant on-chain verification:',
              'Di Testnet (testnet.pndigi.site), Anda dapat mengaktifkan tier apa pun secara instan (1-klik). Di Mainnet (pndigi.site), tempel txHash pembayaran Base L2 Anda di sini untuk verifikasi on-chain otomatis:'
            )}
          </div>
          <input
            type="text"
            value={txHashInput}
            onChange={(e) => setTxHashInput(e.target.value)}
            placeholder={tr('Optional Mainnet: 0x... (Base Payment TxHash)', 'Opsional Mainnet: 0x... (Base Payment TxHash)')}
            style={{
              flex: '1 1 280px',
              padding: '7px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
            }}
          />
        </div>
      )}

      {paymentFeedback && (
        <div
          className="bg-panel"
          style={{
            borderColor: paymentFeedback.includes('Notice:') || paymentFeedback.includes('Auth:') ? 'var(--color-badge-warning-border)' : 'var(--color-badge-success-border)',
            backgroundColor: paymentFeedback.includes('Notice:') || paymentFeedback.includes('Auth:') ? 'var(--color-badge-warning-bg)' : 'var(--color-badge-success-bg)',
            color: paymentFeedback.includes('Notice:') || paymentFeedback.includes('Auth:') ? 'var(--color-badge-warning-text)' : 'var(--color-badge-success-text)',
            padding: '12px 16px',
            borderRadius: '12px',
            fontSize: '12px',
            fontWeight: 800,
            borderWidth: '1px',
            borderStyle: 'solid',
          }}
        >
          {paymentFeedback}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
        {displayPlans.map((plan) => {
          const normId = plan.id.toUpperCase();
          const isActive = normId === activePlanId;
          const displayPrice = plan.priceUsd ?? plan.monthlyPriceUsd ?? 0;
          const origPrice = plan.originalPriceUsd ?? displayPrice;
          const discountPct = Number(plan.discountPct ?? 0);
          const hasDiscount = discountPct > 0 && origPrice > displayPrice;
          const hasCreator = plan.hasCreatorAccess ?? (normId === 'CREATOR' || normId === 'AGENT');
          const hasLive = plan.hasLiveTrading ?? (normId === 'TRADER' || normId === 'AGENT');
          const hasAgent = plan.hasAgentAccess ?? (normId === 'AGENT');
          const hasPriority = plan.hasPriorityScrape ?? (normId !== 'FREE');

          return (
            <div
              key={plan.id}
              className="bg-panel"
              style={{
                border: isActive ? '2px solid var(--color-accent-emerald)' : '1px solid var(--color-border)',
                borderRadius: '20px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                position: 'relative',
              }}
            >
              {isActive && (
                <span style={{ position: 'absolute', top: '12px', right: '12px', backgroundColor: 'var(--color-accent-emerald)', color: '#0C1500', padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 900 }}>
                  ACTIVE PLAN
                </span>
              )}

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <h3 style={{ color: 'var(--color-foreground)', margin: 0, fontSize: '16px', fontWeight: 800 }}>{plan.name}</h3>
                  {hasDiscount && (
                    <span
                      style={{
                        backgroundColor: 'var(--color-badge-success-bg)',
                        color: 'var(--color-badge-success-text)',
                        border: '1px solid var(--color-badge-success-border)',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        fontSize: '10px',
                        fontWeight: 900,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      -{discountPct}% {plan.promoLabel ? `· ${plan.promoLabel}` : 'OFF'}
                    </span>
                  )}
                </div>
                <div className="tabular-nums" style={{ fontSize: '28px', fontWeight: 900, color: 'var(--color-foreground)', marginBottom: '4px', letterSpacing: '-0.03em', display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  {hasDiscount && (
                    <span style={{ fontSize: '14px', color: 'var(--color-muted)', textDecoration: 'line-through', fontWeight: 600 }}>
                      ${origPrice}
                    </span>
                  )}
                  <span>
                    ${displayPrice} <span style={{ fontSize: '12px', color: 'var(--color-muted)', fontWeight: 500 }}>/ month</span>
                  </span>
                </div>
                {plan.priceEth && (
                  <div className="text-muted tabular-nums" style={{ fontSize: '11px', marginBottom: '14px', fontFamily: 'var(--font-mono)' }}>
                    {hasDiscount && plan.originalPriceEth && (
                      <span style={{ opacity: 0.65, textDecoration: 'line-through', marginRight: '6px' }}>
                        {plan.originalPriceEth} ETH
                      </span>
                    )}
                    ~{plan.priceEth} ETH on Base L2
                  </div>
                )}

                <div className="flex-col gap-sm text-muted" style={{ fontSize: '12px', marginBottom: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)', color: 'var(--color-foreground)', fontWeight: 700 }}>
                    <CheckCircle2 size={14} style={{ color: 'var(--color-accent-emerald)' }} /> {plan.monthlyCredits.toLocaleString()} Monthly Credits
                  </div>
                  {plan.capacities && (
                    <div
                      style={{
                        marginTop: '4px',
                        padding: '10px 12px',
                        borderRadius: '12px',
                        border: '1px solid var(--color-border)',
                        background: 'var(--color-surface-inset)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-foreground)',
                      }}
                    >
                      <div>Bankr BYOK Vault: <strong>{plan.capacities.maxBankrKeys}</strong> key(s)</div>
                      <div>
                        Binance CEX Vault: <strong>{plan.capacities.maxBinanceAccounts}</strong> akun ({plan.capacities.allowMainnetBinance ? 'Testnet + Mainnet' : 'Testnet Only'})
                      </div>
                      <div>Max Order Cap: <strong>${plan.capacities.maxOrderValueUsd.toLocaleString()}</strong></div>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={14} style={{ color: hasCreator ? 'var(--color-accent)' : 'var(--color-muted)', opacity: hasCreator ? 1 : 0.3 }} />
                    <span style={{ color: hasCreator ? 'var(--color-foreground)' : 'var(--color-muted)' }}>Launchpad Creator &amp; AI Studio</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={14} style={{ color: hasLive ? 'var(--color-accent)' : 'var(--color-muted)', opacity: hasLive ? 1 : 0.3 }} />
                    <span style={{ color: hasLive ? 'var(--color-foreground)' : 'var(--color-muted)' }}>Live Trading Terminal &amp; Risk Gate</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={14} style={{ color: hasAgent ? 'var(--color-accent)' : 'var(--color-muted)', opacity: hasAgent ? 1 : 0.3 }} />
                    <span style={{ color: hasAgent ? 'var(--color-foreground)' : 'var(--color-muted)' }}>5-Agent Autonomous Desk (BytePlus/Gemini)</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={14} style={{ color: hasPriority ? 'var(--color-accent)' : 'var(--color-muted)', opacity: hasPriority ? 1 : 0.3 }} />
                    <span style={{ color: hasPriority ? 'var(--color-foreground)' : 'var(--color-muted)' }}>GoPlus On-Chain Intel ($0) &amp; Scrape Priority</span>
                  </div>
                </div>
              </div>

              {!isConnected ? (
                <button
                  type="button"
                  onClick={async () => {
                    setPaymentFeedback(null);
                    const res = await connectMetaMask();
                    if (!res.success && res.error) {
                      setPaymentFeedback(`Notice: ${res.error}`);
                    }
                  }}
                  disabled={isConnecting}
                  className="btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Wallet size={16} />
                  {isConnecting ? 'Signing SIWE...' : 'Connect Wallet to Subscribe'}
                </button>
              ) : (
                <div className="flex-col gap-xs">
                  <button
                    type="button"
                    onClick={() => handleSubscribe(plan)}
                    disabled={isActive || isProcessing !== null}
                    className={isActive ? 'btn-secondary' : 'btn-primary'}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <CreditCard size={14} />
                    {isProcessing === normId
                      ? 'Memproses...'
                      : isActive
                      ? 'Current Active Plan'
                      : displayPrice === 0
                      ? 'Activate Free / 100% Promo Tier'
                      : `Activate ${plan.name}`}
                  </button>
                  {!isActive && displayPrice > 0 && plan.priceEth && parseFloat(plan.priceEth) > 0 && (
                    <button
                      type="button"
                      onClick={() => handlePayWithMetaMask(plan)}
                      disabled={isProcessing !== null}
                      className="btn-secondary"
                      style={{ width: '100%', justifyContent: 'center', fontSize: '11px', padding: '7px 10px', borderColor: 'var(--color-accent-info)', color: 'var(--color-accent-info)' }}
                    >
                      <Zap size={13} /> 1-Click Pay {plan.priceEth} ETH via MetaMask
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Platform Business Fee & Credit Burn Transparency Matrix */}
      <div className="bg-panel" style={{ border: '1px solid rgba(56, 189, 248, 0.35)', borderRadius: '8px', padding: '20px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 900, color: 'var(--color-accent-info)', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Scale size={17} /> Kenapa RTrader AI vs Bot Bursa Biasa &amp; Transparansi Biaya
        </h3>
        <div className="grid-3" style={{ gap: '12px', marginBottom: '12px' }}>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}>
            <div style={{ color: 'var(--color-text-positive)', fontWeight: 800, fontSize: '12px' }}>Multi-Signal AI vs Grid Kaku</div>
            <div className="text-muted" style={{ fontSize: '11px', marginTop: '4px' }}>
              Bot bawaan bursa hanya memakai grid/DCA kaku. RTrader menggabungkan Scout 6-Chain, sentimen, on-chain risk, dan BYOK LLM.
            </div>
          </div>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '14px', boxShadow: 'none' }}>
            <div style={{ color: 'var(--color-foreground)', fontWeight: 800, fontSize: '12px' }}>Omnichain CEX + DEX 0x v2</div>
            <div className="text-muted" style={{ fontSize: '11px', marginTop: '4px' }}>
              1 dashboard untuk Binance, Bybit V5, 6 jaringan DEX EVM (0x v2), Launchpad Bankr, dan proteksi Kill-Switch lintas akun.
            </div>
          </div>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '14px', boxShadow: 'none' }}>
            <div style={{ color: 'var(--color-foreground)', fontWeight: 800, fontSize: '12px' }}>100% Non-Custodial &amp; Soft-Freeze</div>
            <div className="text-muted" style={{ fontSize: '11px', marginTop: '4px' }}>
              Zero private key di server; API key dienkripsi AES-256-GCM dan tidak pernah terhapus saat downgrade paket.
            </div>
          </div>
        </div>
        <div className="grid-3" style={{ gap: '12px' }}>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '14px', boxShadow: 'none' }}>
            <div style={{ color: 'var(--color-accent-emerald)', fontWeight: 800, fontSize: '12px' }}>Bonding Curve Swap Fee (1.00%)</div>
            <div style={{ fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>
              0.50% Treasury / 0.50% Creator
            </div>
            <div className="text-muted" style={{ fontSize: '11px' }}>Dibagi otomatis on-chain di BondingCurveLaunchpad.sol tanpa biaya tersembunyi.</div>
          </div>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '14px', boxShadow: 'none' }}>
            <div style={{ color: 'var(--color-foreground)', fontWeight: 800, fontSize: '12px' }}>Graduation Target &amp; LP Lock</div>
            <div style={{ fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>
              $69,000 Standard / $2,500 Degen
            </div>
            <div className="text-muted" style={{ fontSize: '11px' }}>Otomatis bermigrasi ke Uniswap v3 / Aerodrome Pool dengan LP timelock 180 hari.</div>
          </div>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '14px', boxShadow: 'none' }}>
            <div style={{ color: 'var(--color-foreground)', fontWeight: 800, fontSize: '12px' }}>Metered Credit Consumption</div>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--color-foreground)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>
              Scrape/Studio: {studioCostCr} cr · 5-Agent Desk: {deskCostCr} cr · Launch: {launchCostCr} cr
            </div>
            <div className="text-muted" style={{ fontSize: '11px' }}>Max Order: ${maxOrderValueUsd.toLocaleString()} · Max Daily Loss: ${maxDailyLossUsd.toLocaleString()} · Max Slippage: {maxSlippagePct}%</div>
          </div>
        </div>
      </div>
        </div>
      )}

      {/* TAB 3: Mutasi Kredit & Keamanan */}
      {activeBillingTab === 'history' && (
        <div className="flex-col gap-lg">
      {/* Live Double-Entry Credit Ledger Statement */}
      {isConnected && (
        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <History size={16} color="var(--color-accent)" /> Riwayat Mutasi Kredit
              </h3>
              <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '12px' }}>
                Catatan lengkap penambahan kredit paket, bonus quest, dan pemakaian fitur AI / peluncuran token.
              </p>
            </div>
            <button
              type="button"
              onClick={fetchLedger}
              disabled={ledgerLoading}
              className="btn-secondary"
              style={{ fontSize: '11px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <RefreshCw size={12} /> {ledgerLoading ? 'Syncing...' : 'Refresh Ledger'}
            </button>
          </div>

          {ledgerEntries.length === 0 ? (
            <div className="text-muted" style={{ fontSize: '12px', padding: '12px 0' }}>
              {ledgerLoading ? 'Memuat mutasi kredit dari PostgreSQL...' : 'Belum ada riwayat mutasi kredit tercatat untuk sesi ini.'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px' }}>Timestamp</th>
                    <th style={{ padding: '8px 10px' }}>Action Type</th>
                    <th style={{ padding: '8px 10px' }}>Description</th>
                    <th style={{ padding: '8px 10px' }}>Reference</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Amount (CREDITS)</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((entry) => {
                    const isCredit = entry.amount >= 0;
                    return (
                      <tr key={entry.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '8px 10px', color: 'var(--color-muted)' }}>
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                        <td style={{ padding: '8px 10px', fontWeight: 800, color: isCredit ? 'var(--color-accent)' : 'var(--color-accent-info)' }}>
                          {entry.type}
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--color-foreground)', fontFamily: 'var(--font-sans)' }}>
                          {entry.description}
                        </td>
                        <td style={{ padding: '8px 10px', color: 'var(--color-muted)' }}>
                          {entry.referenceId ? entry.referenceId.slice(0, 18) : '—'}
                        </td>
                        <td
                          style={{
                            padding: '8px 10px',
                            textAlign: 'right',
                            fontWeight: 900,
                            color: isCredit ? 'var(--color-text-positive)' : 'var(--color-destructive)',
                          }}
                        >
                          {isCredit ? `+${entry.amount.toLocaleString()}` : entry.amount.toLocaleString()} cr
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
          <UserSecurityActivityPanel isConnected={isConnected} />
        </div>
      )}

      {/* TAB 2: Akun API, Bankr & Webhook */}
      {activeBillingTab === 'vaults' && (
        <div className="flex-col gap-lg">
      {/* Permanent Capacity Add-On Store (Reuses ledger_entries, Zero Data Loss) */}
      <BillingAddonStorePanel
        isConnected={isConnected}
        onPurchased={() => {
          refreshSession().catch(() => {});
          fetchVaultSummary().catch(() => {});
        }}
      />

      {/* Connected Multi-Account Vaults & Non-Custodial Guardrail Overview */}
      <div
        className="bg-panel"
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: '10px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', margin: '0 0 4px 0' }}>
              Connected Multi-Account API Vaults (BYOK &amp; Non-Custodial)
            </h3>
            <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
              Kelola banyak API Key terenkripsi AES-256-GCM per akun tanpa pernah menyimpan private key dompet Anda di server.
            </p>
          </div>
          {vaultSummary && (
            <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-accent-info)', fontWeight: 700 }}>
              Live Telemetry · Tier {vaultSummary.planId} · Webhooks {vaultSummary.vaults.webhook.active}/{vaultSummary.vaults.webhook.maxAllowed}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          {(() => {
            const renderCounter = (c?: VaultCategoryCount) => {
              if (!c) return null;
              const frozen = c.frozenOverQuota + c.frozenMainnetLocked;
              return (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 800,
                      fontFamily: 'var(--font-mono)',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: 'rgba(16, 185, 129, 0.14)',
                      color: 'var(--color-text-positive)',
                    }}
                  >
                    {c.active} / {c.maxAllowed} aktif
                  </span>
                  {frozen > 0 && (
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 800,
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        background: 'rgba(245, 158, 11, 0.16)',
                        color: '#FBBF24',
                      }}
                    >
                      {frozen} frozen
                    </span>
                  )}
                </div>
              );
            };
            return (
              <>
                <div style={{ padding: '12px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)', marginBottom: '4px' }}>
                    Bankr Launchpad Vault (CREATOR+)
                  </div>
                  {renderCounter(vaultSummary?.vaults.bankr)}
                  <p className="text-muted" style={{ fontSize: '11px', margin: '0 0 10px 0', lineHeight: 1.45 }}>
                    Simpan hingga 15 (CREATOR) / 25 (AGENT) API Key Bankr (+ Permanent Add-On Slots) dengan isolasi multi-chain (Base, Robinhood, Arbitrum, Arc).
                  </p>
                  <a href="/launchpad" className="btn-secondary" style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-block' }}>
                    Kelola di /launchpad →
                  </a>
                </div>
                <div style={{ padding: '12px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)', marginBottom: '4px' }}>
                    Binance CEX Multi-Account (TRADER / AGENT)
                  </div>
                  {renderCounter(vaultSummary?.vaults.binance)}
                  <p className="text-muted" style={{ fontSize: '11px', margin: '0 0 10px 0', lineHeight: 1.45 }}>
                    Simpan hingga 5 (TRADER) / 15 (AGENT) akun API Binance Testnet/Mainnet (+ Add-On Slots) dengan No-Withdrawal Guard &amp; Live Ping.
                  </p>
                  <a href="/trading" className="btn-secondary" style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-block' }}>
                    Kelola di /trading →
                  </a>
                </div>
                <div style={{ padding: '12px', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)', marginBottom: '4px' }}>
                    Bybit V5 CEX Vault (TRADER / AGENT)
                  </div>
                  {renderCounter(vaultSummary?.vaults.bybit)}
                  <p className="text-muted" style={{ fontSize: '11px', margin: '0 0 10px 0', lineHeight: 1.45 }}>
                    Eksekusi Single-Shot Spot Bybit V5 (Testnet/Mainnet) dengan HMAC-SHA256, No-Withdrawal Guard, dan kuota bersama add-on CEX.
                  </p>
                  <a href="/trading" className="btn-secondary" style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-block' }}>
                    Kelola di /trading →
                  </a>
                </div>
                <div style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)', marginBottom: '4px' }}>
                    BYOK LLM Vault (TRADER / AGENT)
                  </div>
                  {renderCounter(vaultSummary?.vaults.byokLlm)}
                  <p className="text-muted" style={{ fontSize: '11px', margin: '0 0 10px 0', lineHeight: 1.45 }}>
                    Simpan hingga 3 (TRADER) / 5 (AGENT) key Google Gemini, OpenAI GPT-4o, &amp; Anthropic Claude (Sonnet/Haiku/Opus) — hemat 60% credits (2 Cr/run).
                  </p>
                  <a href="/agent" className="btn-secondary" style={{ fontSize: '11px', padding: '5px 10px', display: 'inline-block' }}>
                    Kelola di /agent →
                  </a>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {/* Live Modular Provider & AI Engine Registry (GET /api/providers/registry) */}
      <ProviderRegistryStatusPanel />

      {/* Outbound Alert Webhooks (SSRF-Safe HTTPS · Discord / Custom Endpoint + Test Ping) */}
      <UserWebhookVaultPanel isConnected={isConnected} />

      {/* Multi-Owned Sub-Wallet Allowlist (ECDSA Proof-of-Ownership · AI Copilot Transfer Guard) */}
      <OwnedWalletsAllowlistPanel isConnected={isConnected} />
        </div>
      )}

      {/* TAB 4: Admin Ops Console */}
      {/* Admin Billing Rail Diagnostics Console (SYSTEM_ADMIN / SUPER_ADMIN / BILLING_ADMIN Exclusive) */}
      {activeBillingTab === 'admin' && (hasCapability('MANAGE_BILLING_PLANS') || userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN' || userRole === 'BILLING_ADMIN') && (
        <div className="bg-panel" style={{ border: '1px solid #FF9100', borderRadius: '8px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--color-foreground)', margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={18} /> Pengaturan Diskon &amp; Promo Paket (Admin)
            </h3>
            <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
              Atur persentase diskon (0% – 100%) dan label promo pada paket layanan. Perubahan langsung memotong harga USD &amp; ETH di seluruh halaman.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="flex-col gap-xs" style={{ minWidth: '160px' }}>
              <label style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-muted)' }}>Target Paket Layanan</label>
              <select
                aria-label="Target plan for discount"
                value={discountPlanId}
                onChange={(e) => setDiscountPlanId(e.target.value)}
                className="input"
                style={{ padding: '8px 10px', fontSize: '12px', fontWeight: 800 }}
              >
                <option value="CREATOR">CREATOR ($49 / 0.015 ETH)</option>
                <option value="TRADER">TRADER ($79 / 0.025 ETH)</option>
                <option value="AGENT">AGENT ($149 / 0.045 ETH)</option>
              </select>
            </div>

            <div className="flex-col gap-xs" style={{ width: '130px' }}>
              <label style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-muted)' }}>Diskon (%)</label>
              <input
                aria-label="Discount percentage"
                type="number"
                min={0}
                max={100}
                value={discountPctInput}
                onChange={(e) => setDiscountPctInput(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                className="input"
                style={{ padding: '8px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)', fontWeight: 800 }}
              />
            </div>

            <div className="flex-col gap-xs" style={{ flex: '1 1 200px' }}>
              <label style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-muted)' }}>Label Promo</label>
              <input
                aria-label="Promo label"
                type="text"
                placeholder="cth: EARLY ADOPTER / RAMADAN SALE"
                value={promoLabelInput}
                onChange={(e) => setPromoLabelInput(e.target.value)}
                className="input"
                style={{ padding: '8px 10px', fontSize: '12px' }}
              />
            </div>

            <button
              type="button"
              onClick={() => handleSaveDiscount()}
              disabled={discountSaving}
              className="btn-primary"
              style={{ padding: '9px 16px', fontSize: '12px' }}
            >
              {discountSaving ? 'Saving...' : 'Apply Discount'}
            </button>

            <button
              type="button"
              onClick={() => {
                setDiscountPctInput(0);
                handleSaveDiscount(0);
              }}
              disabled={discountSaving}
              className="btn-secondary"
              style={{ padding: '9px 14px', fontSize: '12px' }}
            >
              Reset (0%)
            </button>
          </div>

          {/* Preset Quick Buttons */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="text-muted" style={{ fontSize: '11px' }}>Quick Presets:</span>
            {[10, 25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => {
                  setDiscountPctInput(pct);
                  handleSaveDiscount(pct);
                }}
                disabled={discountSaving}
                className="btn-secondary"
                style={{ padding: '4px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
              >
                {pct}% OFF
              </button>
            ))}
          </div>

          {discountFeedback && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 800,
                backgroundColor: discountFeedback.includes('OK:') ? 'var(--color-badge-success-bg)' : 'var(--color-badge-warning-bg)',
                color: discountFeedback.includes('OK:') ? 'var(--color-badge-success-text)' : 'var(--color-badge-warning-text)',
                border: `1px solid ${discountFeedback.includes('OK:') ? 'var(--color-badge-success-border)' : 'var(--color-badge-warning-border)'}`,
              }}
            >
              {discountFeedback}
            </div>
          )}

          {/* Dynamic Credit Burn & Risk Gate Configurator */}
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '16px' }}>
            <h4 style={{ fontSize: '14px', fontWeight: 900, color: 'var(--color-accent-info)', margin: '0 0 8px 0' }}>
              Dynamic Credit Burn Costs, Risk Gate Limits &amp; Treasury Receiver
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '12px' }}>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>AI Studio / Scrape (cr)</label>
                <input
                  type="number"
                  min={0}
                  value={studioCostCr}
                  onChange={(e) => setStudioCostCr(Math.max(0, Number(e.target.value) || 0))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>5-Agent Desk Run (cr)</label>
                <input
                  type="number"
                  min={0}
                  value={deskCostCr}
                  onChange={(e) => setDeskCostCr(Math.max(0, Number(e.target.value) || 0))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>Token Launch (cr)</label>
                <input
                  type="number"
                  min={0}
                  value={launchCostCr}
                  onChange={(e) => setLaunchCostCr(Math.max(0, Number(e.target.value) || 0))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>Max Order Size ($ USD)</label>
                <input
                  type="number"
                  min={100}
                  value={maxOrderValueUsd}
                  onChange={(e) => setMaxOrderValueUsd(Math.max(100, Number(e.target.value) || 100))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>Max Daily Loss ($ USD)</label>
                <input
                  type="number"
                  min={50}
                  value={maxDailyLossUsd}
                  onChange={(e) => setMaxDailyLossUsd(Math.max(50, Number(e.target.value) || 50))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>Max Slippage Cap (%)</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.1}
                  max={10}
                  value={maxSlippagePct}
                  onChange={(e) => setMaxSlippagePct(Math.max(0.1, Math.min(10, Number(e.target.value) || 3.0)))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>DEX Swap Fee (bps · 25=0.25%)</label>
                <input
                  type="number"
                  step={1}
                  min={0}
                  max={100}
                  value={dexSwapFeeBps}
                  onChange={(e) => setDexSwapFeeBps(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="flex-col gap-xs" style={{ flex: '1 1 260px' }}>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>Protocol Treasury Public Wallet (Base L2 Subscription Receiver)</label>
                <input
                  type="text"
                  value={treasuryWallet}
                  onChange={(e) => setTreasuryWallet(e.target.value)}
                  className="input"
                  style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs" style={{ flex: '1 1 260px' }}>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>BondingCurveLaunchpad.sol Factory Contract Address (Optional Override)</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    placeholder="0x... (Deployed BondingCurveLaunchpad.sol)"
                    value={launchpadContractAddress}
                    onChange={(e) => setLaunchpadContractAddress(e.target.value)}
                    className="input"
                    style={{ flex: 1, padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
                  />
                  <button
                    type="button"
                    onClick={handleVerifyContractBytecode}
                    disabled={isVerifyingBytecode || !launchpadContractAddress.trim()}
                    className="btn-secondary"
                    style={{ padding: '7px 10px', fontSize: '11px', whiteSpace: 'nowrap' }}
                    title="Cek eth_getCode on-chain via MetaMask untuk memastikan alamat ini adalah Smart Contract"
                  >
                    {isVerifyingBytecode ? 'Checking...' : 'Verify Bytecode'}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={handleSavePlatformConfig}
                disabled={configSaving}
                className="btn-primary"
                style={{ padding: '9px 16px', fontSize: '12px' }}
              >
                {configSaving ? 'Saving...' : 'Save Fee & Risk Parameters'}
              </button>
            </div>
            {configFeedback && (
              <div style={{ marginTop: '10px', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 800, backgroundColor: configFeedback.includes('OK:') ? 'rgba(16, 185, 129, 0.14)' : 'rgba(245, 158, 11, 0.14)', color: configFeedback.includes('OK:') ? 'var(--color-text-positive)' : 'var(--color-accent-amber)', border: `1px solid ${configFeedback.includes('OK:') ? 'rgba(16, 185, 129, 0.35)' : 'rgba(245, 158, 11, 0.35)'}` }}>
                {configFeedback}
              </div>
            )}
          </div>

          <AdminOpsHealthPanel />
          <AdminWhiteLabelPartnersPanel />
          <AdminGenesisSnapshotPanel />
          <AdminKolVerificationPanel />

          <div className="grid-4">
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent-info)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><TrendingUp size={14} /> Active Billing Plans</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>4 Tiers (SSOT)</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>FREE · CREATOR · TRADER · AGENT</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><CheckCircle2 size={14} /> dRPC Verifier Status</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-accent)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>100% HEALTHY</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>Base &amp; Ethereum Receipt Verifier</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent-purple)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><Zap size={14} /> Double-Entry Ledger</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>ledger_entries</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>PostgreSQL 18 Transactional SSOT</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent-amber)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><Banknote size={14} /> Custody Policy</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-accent)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>100% NON-CUSTODIAL</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>Zero Private Keys in Vercel</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
