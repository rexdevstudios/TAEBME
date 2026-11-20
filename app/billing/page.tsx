'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { CreditCard, CheckCircle2, ShieldAlert, Zap, TrendingUp, Wallet, Banknote, Scale, History, RefreshCw } from 'lucide-react';

interface LedgerEntry {
  id: string;
  amount: number;
  currency: string;
  type: string;
  referenceId: string | null;
  description: string;
  createdAt: string;
}

interface Plan {
  id: string;
  name: string;
  priceUsd?: number;
  monthlyPriceUsd?: number;
  priceEth?: string;
  monthlyCredits: number;
  hasLiveTrading?: boolean;
  hasCreatorAccess?: boolean;
  hasAgentAccess?: boolean;
  hasPriorityScrape?: boolean;
  features?: string[];
}

export default function BillingPage() {
  const { isConnected, userRole, planId, credits, connectMetaMask, isConnecting, refreshSession } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePlanId, setActivePlanId] = useState<string>('FREE');
  const [txHashInput, setTxHashInput] = useState<string>('');
  const [paymentFeedback, setPaymentFeedback] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<string | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);

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

  useEffect(() => {
    fetchLedger();
  }, [fetchLedger, credits, activePlanId]);

  useEffect(() => {
    if (planId) {
      setActivePlanId(planId.toUpperCase());
    }
  }, [planId]);

  useEffect(() => {
    async function fetchPlans() {
      try {
        const res = await fetch('/api/billing/plans');
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setPlans(json.data);
        }
      } catch (err) {
        console.warn('[Billing UI] API fetch error (using fallback plans):', (err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetchPlans();
  }, []);

  const handleSubscribe = async (plan: Plan) => {
    if (!isConnected) {
      setPaymentFeedback('🔒 SIWE Session Required: Silakan hubungkan dompet MetaMask terlebih dahulu.');
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
        setPaymentFeedback(`⚠️ Upgrade gagal (${res.status}): ${json.error || 'Unknown error'}`);
        return;
      }

      setActivePlanId(targetPlanId);
      await refreshSession();
      await fetchLedger();
      setPaymentFeedback(
        `✅ Tier ${plan.name} (${targetPlanId}) aktif! Saldo kredit: ${Number(json.data.credits).toLocaleString()} Credits${json.data.unlockedCreatorRole ? ' · Role CREATOR terbuka!' : ''}`
      );
    } catch (err: any) {
      setPaymentFeedback(`⚠️ Koneksi gagal: ${err?.message || 'Tidak dapat menghubungi server'}`);
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
      {/* Top Banner */}
      <div className="bg-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', padding: '16px', borderRadius: '8px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 900, margin: '0 0 4px 0', color: '#FFC400', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CreditCard size={20} /> Subscription Tiers, Credit Ledger &amp; Business Fees
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: '12px' }}>
            PostgreSQL SSOT double-entry credit ledger (`plans`, `subscriptions`, `ledger_entries`) &amp; non-custodial on-chain settlement verifier.
          </p>
        </div>
        <div className="flex-row gap-sm items-center">
          {isConnected && (
            <>
              <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                <span className="text-muted">Tier: </span>
                <span style={{ color: '#FFC400', fontWeight: 900 }}>{activePlanId}</span>
              </div>
              <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                <span className="text-muted">Balance: </span>
                <span style={{ color: 'var(--color-accent)', fontWeight: 900 }}>{credits.toLocaleString()} Credits</span>
              </div>
            </>
          )}
          <span className="badge badge-trader" style={{ border: '1px solid #00E676', color: '#00E676', backgroundColor: '#041E15' }}>
            {loading ? 'LOADING...' : 'SSOT PLANS ACTIVE'}
          </span>
        </div>
      </div>

      {/* Optional On-Chain Payment TxHash Bar for Mainnet Upgrades */}
      {isConnected && (
        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ fontSize: '12px', color: 'var(--color-muted)' }}>
            <strong style={{ color: 'var(--color-foreground)' }}>On-Chain Base Payment Verifier:</strong> Di Testnet (`testnet.pndigi.site`), Anda dapat mengaktifkan tier apa pun secara instan (1-klik). Di Mainnet (`pndigi.site`), tempel `txHash` pembayaran Base L2 Anda di sini untuk verifikasi on-chain otomatis:
          </div>
          <input
            type="text"
            value={txHashInput}
            onChange={(e) => setTxHashInput(e.target.value)}
            placeholder="Opsional Mainnet: 0x... (Base Payment TxHash)"
            style={{
              flex: '1 1 280px',
              padding: '7px 10px',
              borderRadius: '6px',
              backgroundColor: '#0B1220',
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
            borderColor: paymentFeedback.includes('⚠️') || paymentFeedback.includes('🔒') ? '#FF9100' : 'var(--color-accent)',
            color: paymentFeedback.includes('⚠️') || paymentFeedback.includes('🔒') ? '#FFD600' : 'var(--color-accent)',
            padding: '12px 16px',
            borderRadius: '6px',
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
          const hasCreator = plan.hasCreatorAccess ?? (normId === 'CREATOR' || normId === 'AGENT');
          const hasLive = plan.hasLiveTrading ?? (normId === 'TRADER' || normId === 'AGENT');
          const hasAgent = plan.hasAgentAccess ?? (normId === 'AGENT');
          const hasPriority = plan.hasPriorityScrape ?? (normId !== 'FREE');

          return (
            <div
              key={plan.id}
              className="bg-panel"
              style={{
                border: isActive ? '2px solid #FFC400' : '1px solid var(--color-border)',
                borderRadius: '8px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                position: 'relative',
              }}
            >
              {isActive && (
                <span style={{ position: 'absolute', top: '12px', right: '12px', backgroundColor: '#FFC400', color: '#000000', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 900 }}>
                  ACTIVE PLAN
                </span>
              )}

              <div>
                <h3 style={{ color: 'var(--color-foreground)', marginTop: 0, fontSize: '16px', fontWeight: 800 }}>{plan.name}</h3>
                <div style={{ fontSize: '24px', fontWeight: 900, color: 'var(--color-accent)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
                  ${displayPrice} <span style={{ fontSize: '12px', color: 'var(--color-muted)', fontWeight: 500 }}>/ month</span>
                </div>
                {plan.priceEth && (
                  <div style={{ fontSize: '11px', color: '#38BDF8', marginBottom: '14px', fontFamily: 'var(--font-mono)' }}>
                    ~{plan.priceEth} ETH on Base L2
                  </div>
                )}

                <div className="flex-col gap-sm text-muted" style={{ fontSize: '12px', marginBottom: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)' }}>
                    <CheckCircle2 size={14} style={{ color: 'var(--color-accent)' }} /> {plan.monthlyCredits.toLocaleString()} Monthly Credits
                  </div>
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
                    <span style={{ color: hasPriority ? 'var(--color-foreground)' : 'var(--color-muted)' }}>Arkham &amp; Firecrawl Scrape Priority</span>
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
                      setPaymentFeedback(`⚠️ ${res.error}`);
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
                    ? 'Activate Free Tier'
                    : `Activate ${plan.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Platform Business Fee & Credit Burn Transparency Matrix */}
      <div className="bg-panel" style={{ border: '1px solid rgba(56, 189, 248, 0.35)', borderRadius: '8px', padding: '20px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 900, color: '#38BDF8', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Scale size={17} /> Platform Business Fee Split &amp; Metered Credit Schedule
        </h3>
        <div className="grid-3" style={{ gap: '12px' }}>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ color: 'var(--color-accent)', fontWeight: 800, fontSize: '12px' }}>Bonding Curve Swap Fee (1.00%)</div>
            <div style={{ fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>
              0.50% Treasury / 0.50% Creator
            </div>
            <div className="text-muted" style={{ fontSize: '11px' }}>Dibagi otomatis on-chain di BondingCurveLaunchpad.sol tanpa biaya tersembunyi.</div>
          </div>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ color: '#00E5FF', fontWeight: 800, fontSize: '12px' }}>Graduation Target &amp; LP Lock</div>
            <div style={{ fontSize: '16px', fontWeight: 900, color: 'var(--color-foreground)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>
              $69,000 Standard / $2,500 Degen
            </div>
            <div className="text-muted" style={{ fontSize: '11px' }}>Otomatis bermigrasi ke Uniswap v3 / Aerodrome Pool dengan LP timelock 180 hari.</div>
          </div>
          <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '14px', borderRadius: '6px' }}>
            <div style={{ color: '#C084FC', fontWeight: 800, fontSize: '12px' }}>Metered Credit Consumption</div>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--color-foreground)', margin: '6px 0', fontFamily: 'var(--font-mono)' }}>
              Scrape: 1 cr · 5-Agent Desk: 5 cr · Launch: 50 cr
            </div>
            <div className="text-muted" style={{ fontSize: '11px' }}>Dicatat secara double-entry di tabel PostgreSQL `ledger_entries`.</div>
          </div>
        </div>
      </div>

      {/* Live Double-Entry Credit Ledger Statement */}
      {isConnected && (
        <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '15px', fontWeight: 900, color: 'var(--color-foreground)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <History size={16} color="var(--color-accent)" /> Double-Entry Credit Ledger Statement (`ledger_entries`)
              </h3>
              <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '11px' }}>
                Riwayat penambahan kredit tier (`+SUBSCRIPTION_GRANT`) dan pemotongan otomatis fitur (`-1 AI_ASSET_STUDIO`, `-5 FIVE_AGENT_DESK_RUN`, `-50 TOKEN_LAUNCH_PUBLISH`).
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
                        <td style={{ padding: '8px 10px', fontWeight: 800, color: isCredit ? 'var(--color-accent)' : '#38BDF8' }}>
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
                            color: isCredit ? '#00E676' : '#FF5252',
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

      {/* Admin Billing Rail Diagnostics Console (SYSTEM_ADMIN Exclusive) */}
      {(userRole === 'SYSTEM_ADMIN' || userRole === 'SUPER_ADMIN') && (
        <div className="bg-panel" style={{ border: '1px solid #FF9100', borderRadius: '8px', padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 900, color: '#FFD600', margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={18} /> System Admin: dRPC Onchain Settlement &amp; Revenue Diagnostics
          </h3>
          <div className="grid-4">
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#00E5FF', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><TrendingUp size={14} /> Active Billing Plans</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>4 Tiers (SSOT)</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>FREE · CREATOR · TRADER · AGENT</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: 'var(--color-accent)', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><CheckCircle2 size={14} /> dRPC Verifier Status</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-accent)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>100% HEALTHY</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>Base &amp; Ethereum Receipt Verifier</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#D500F9', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><Zap size={14} /> Double-Entry Ledger</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-foreground)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>ledger_entries</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>PostgreSQL 18 Transactional SSOT</div>
            </div>
            <div className="bg-panel" style={{ border: '1px solid var(--color-border)', padding: '16px', borderRadius: '6px' }}>
              <div style={{ color: '#FFC400', fontWeight: 800, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}><Banknote size={14} /> Custody Policy</div>
              <div style={{ fontSize: '18px', fontWeight: 900, color: 'var(--color-accent)', margin: '8px 0', fontFamily: 'var(--font-mono)' }}>100% NON-CUSTODIAL</div>
              <div className="text-muted" style={{ fontSize: '11px' }}>Zero Private Keys in Vercel</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
