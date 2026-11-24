'use client';

import React, { useEffect, useState } from 'react';
import { Check, Copy, Cpu, RefreshCw, Send, ShieldCheck, Terminal } from 'lucide-react';
import {
  BINANCE_AGENTIC_SUPPORTED_CHAINS,
  buildBinanceAgenticSkillCommand,
  validateBinanceAgenticGuardrail,
  type BinanceAgenticChain,
} from '@packages/agent/binance-agentic-bridge';
import { useLocale } from '../context/LocaleContext';

interface BankrVaultKeyOption {
  id: string;
  label: string;
  maskedKey: string;
  quotaStatus?: string;
}

interface BankrJobResult {
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  jobId?: string;
  response?: string;
  message: string;
  keySource?: string;
}

const GUARDRAIL_STORAGE_KEY = 'poolnet_binance_agentic_guardrail_v1';

export function MultiRailAgentExecutionPanel({ isConnected }: { isConnected: boolean }) {
  const { tr } = useLocale();

  // --- Module 1: Bankr Agent Natural-Language Rail ---
  const [bankrKeys, setBankrKeys] = useState<BankrVaultKeyOption[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>('PLATFORM_DEFAULT');
  const [prompt, setPrompt] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [jobResult, setJobResult] = useState<BankrJobResult | null>(null);
  const [bankrFeedback, setBankrFeedback] = useState<string | null>(null);

  // --- Module 2: Binance Agentic Wallet (MPC) Guardrail Bridge ---
  const [allowedChains, setAllowedChains] = useState<BinanceAgenticChain[]>(['bsc', 'base']);
  const [maxSingleTxUsd, setMaxSingleTxUsd] = useState<number>(100);
  const [dailySpendCapUsd, setDailySpendCapUsd] = useState<number>(500);
  const [requireGoPlus, setRequireGoPlus] = useState<boolean>(true);
  const [activeChain, setActiveChain] = useState<BinanceAgenticChain>('bsc');
  const [targetSymbol, setTargetSymbol] = useState<string>('USDC');
  const [amountUsd, setAmountUsd] = useState<number>(25);
  const [copiedCmd, setCopiedCmd] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(GUARDRAIL_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const check = validateBinanceAgenticGuardrail(parsed);
          if (check.ok && check.sanitized) {
            setAllowedChains(check.sanitized.allowedChains);
            setMaxSingleTxUsd(check.sanitized.maxSingleTxUsd);
            setDailySpendCapUsd(check.sanitized.dailySpendCapUsd);
            setRequireGoPlus(check.sanitized.requireGoPlusPreCheck);
            setActiveChain(check.sanitized.allowedChains[0] || 'bsc');
          }
        }
      } catch {
        // ignore storage parse error
      }
    }
  }, []);

  useEffect(() => {
    if (!isConnected) {
      setBankrKeys([]);
      return;
    }
    fetch('/api/user/provider-keys?provider=BANKR', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((json) => {
        if (json?.success && Array.isArray(json?.data?.keys)) {
          setBankrKeys(json.data.keys);
        }
      })
      .catch(() => {});
  }, [isConnected]);

  const handleBankrSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) {
      setBankrFeedback('Auth: Connect MetaMask (SIWE) first to use Bankr Agent Rail.');
      return;
    }
    setSubmitting(true);
    setBankrFeedback(null);
    try {
      const res = await fetch('/api/agent/bankr-prompt', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          providerKeyId: selectedKeyId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setJobResult(json?.data || null);
        setBankrFeedback(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setJobResult(json.data);
      setBankrFeedback(
        `OK: ${json.data?.jobId ? `Job ${json.data.jobId} submitted (${json.data.status}).` : 'Bankr Agent prompt accepted.'}`
      );
    } catch (err: any) {
      setBankrFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePollJob = async () => {
    if (!jobResult?.jobId) return;
    setPolling(true);
    setBankrFeedback(null);
    try {
      const qs = new URLSearchParams({
        jobId: jobResult.jobId,
        providerKeyId: selectedKeyId,
      });
      const res = await fetch(`/api/agent/bankr-prompt?${qs.toString()}`, {
        credentials: 'same-origin',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setBankrFeedback(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setJobResult(json.data);
      setBankrFeedback(`OK: Job ${json.data.jobId} status: ${json.data.status}`);
    } catch (err: any) {
      setBankrFeedback(`Notice: ${err?.message || 'Poll failed'}`);
    } finally {
      setPolling(false);
    }
  };

  const toggleChain = (chain: BinanceAgenticChain) => {
    const next = allowedChains.includes(chain)
      ? allowedChains.length > 1
        ? allowedChains.filter((c) => c !== chain)
        : allowedChains
      : [...allowedChains, chain];
    setAllowedChains(next);
    if (!next.includes(activeChain)) setActiveChain(next[0]);
    const check = validateBinanceAgenticGuardrail({
      allowedChains: next,
      maxSingleTxUsd,
      dailySpendCapUsd,
      requireGoPlusPreCheck: requireGoPlus,
    });
    if (check.ok && check.sanitized && typeof window !== 'undefined') {
      window.localStorage.setItem(GUARDRAIL_STORAGE_KEY, JSON.stringify(check.sanitized));
    }
  };

  const guardrailCheck = validateBinanceAgenticGuardrail({
    allowedChains,
    maxSingleTxUsd,
    dailySpendCapUsd,
    requireGoPlusPreCheck: requireGoPlus,
  });

  const effectiveGuardrail = guardrailCheck.sanitized || {
    enabled: true,
    allowedChains: ['bsc', 'base'] as BinanceAgenticChain[],
    maxSingleTxUsd: 100,
    dailySpendCapUsd: 500,
    requireGoPlusPreCheck: true,
    updatedAt: '',
  };

  const generatedCmd = buildBinanceAgenticSkillCommand({
    chain: activeChain,
    action: 'swap',
    tokenSymbol: targetSymbol,
    amountUsd,
    guardrail: effectiveGuardrail,
  });

  const handleCopyCommand = () => {
    if (typeof window === 'undefined') return;
    navigator.clipboard?.writeText(generatedCmd).catch(() => {});
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 1800);
  };

  return (
    <div className="grid-2" style={{ gap: '16px', alignItems: 'start' }}>
      {/* CARD 1: Bankr Agent Natural-Language Rail */}
      <div
        className="bg-panel"
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: '10px',
          padding: '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Cpu size={15} style={{ color: 'var(--color-accent-info)' }} />
            {tr('Bankr Agent API Rail (Natural-Language)', 'Bankr Agent API Rail (Perintah Natural)')}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            {tr(
              'Execute Bankr Agent prompts via your encrypted BYOK Bankr key under Global Kill-Switch & anti-key-leak guards.',
              'Jalankan perintah Bankr Agent via BYOK Bankr key terenkripsi di bawah Global Kill-Switch & guard anti-kebocoran key.'
            )}
          </div>
        </div>

        <form onSubmit={handleBankrSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="text-muted" style={{ fontSize: '11px', fontWeight: 700 }}>
              {tr('BYOK Bankr API Key', 'BYOK Bankr API Key')}
            </label>
            <select
              value={selectedKeyId}
              onChange={(e) => setSelectedKeyId(e.target.value)}
              className="input"
              style={{ padding: '7px 10px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            >
              <option value="PLATFORM_DEFAULT">
                {tr('Platform Default (if configured)', 'Default Platform (jika tersedia)')}
              </option>
              {bankrKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({k.maskedKey})
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="text-muted" style={{ fontSize: '11px', fontWeight: 700 }}>
              {tr('Agent Instruction', 'Perintah Agent')}
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={tr(
                'e.g. Check Base ETH balance or quote swap 0.02 ETH to USDC on Base',
                'misal: Cek saldo ETH Base atau quote swap 0.02 ETH ke USDC di Base'
              )}
              className="input"
              style={{ padding: '8px 10px', fontSize: '12px', resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="submit"
              disabled={submitting || !prompt.trim()}
              className="btn-primary"
              style={{ fontSize: '11px', padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            >
              <Send size={12} />
              {submitting ? tr('Submitting...', 'Mengirim...') : tr('Submit to Bankr Agent', 'Kirim ke Bankr Agent')}
            </button>
            {jobResult?.jobId && (
              <button
                type="button"
                onClick={handlePollJob}
                disabled={polling}
                className="btn-secondary"
                style={{ fontSize: '11px', padding: '7px 12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
              >
                <RefreshCw size={12} />
                {polling ? tr('Polling...', 'Mengecek...') : tr('Poll Job Status', 'Cek Status Job')}
              </button>
            )}
          </div>
        </form>

        {jobResult && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              backgroundColor: 'var(--color-background)',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <div>Status: <strong>{jobResult.status.toUpperCase()}</strong> {jobResult.jobId ? `· Job: ${jobResult.jobId}` : ''}</div>
            {jobResult.response && <div style={{ marginTop: '4px', color: 'var(--color-foreground)' }}>{jobResult.response}</div>}
          </div>
        )}

        {bankrFeedback && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 700,
              backgroundColor: bankrFeedback.startsWith('OK:')
                ? 'rgba(16, 185, 129, 0.12)'
                : 'rgba(245, 158, 11, 0.12)',
              color: bankrFeedback.startsWith('OK:')
                ? 'var(--color-text-positive)'
                : 'var(--color-accent-amber)',
              border: `1px solid ${
                bankrFeedback.startsWith('OK:') ? 'rgba(16, 185, 129, 0.32)' : 'rgba(245, 158, 11, 0.32)'
              }`,
            }}
          >
            {bankrFeedback}
          </div>
        )}
      </div>

      {/* CARD 2: Binance Agentic Wallet (MPC) Guardrail Bridge */}
      <div
        className="bg-panel"
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: '10px',
          padding: '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ShieldCheck size={15} style={{ color: 'var(--color-text-positive)' }} />
            {tr('Binance Agentic Wallet (MPC) Guardrail Bridge', 'Bridge Guardrail Binance Agentic Wallet (MPC)')}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            {tr(
              'Configure non-custodial MPC spending quotas and generate GoPlus-guarded skill commands for BSC, Base, Ethereum, and Solana.',
              'Atur batas kuota belanja MPC non-custodial & buat perintah skill berpelindung GoPlus untuk BSC, Base, Ethereum, dan Solana.'
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {BINANCE_AGENTIC_SUPPORTED_CHAINS.map((c) => {
            const active = allowedChains.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => toggleChain(c)}
                className={active ? 'btn-primary' : 'btn-secondary'}
                style={{ fontSize: '11px', padding: '4px 10px', textTransform: 'uppercase' }}
              >
                {c}
              </button>
            );
          })}
        </div>

        <div className="grid-2" style={{ gap: '8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="text-muted" style={{ fontSize: '11px', fontWeight: 700 }}>
              {tr('Max Single Tx (USD)', 'Maks 1x Transaksi (USD)')}
            </label>
            <input
              type="number"
              min={10}
              max={5000}
              value={maxSingleTxUsd}
              onChange={(e) => setMaxSingleTxUsd(Number(e.target.value) || 10)}
              className="input"
              style={{ padding: '6px 9px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="text-muted" style={{ fontSize: '11px', fontWeight: 700 }}>
              {tr('Daily Spend Cap (USD)', 'Batas Harian (USD)')}
            </label>
            <input
              type="number"
              min={10}
              max={25000}
              value={dailySpendCapUsd}
              onChange={(e) => setDailySpendCapUsd(Number(e.target.value) || 25)}
              className="input"
              style={{ padding: '6px 9px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>

        <div className="grid-2" style={{ gap: '8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="text-muted" style={{ fontSize: '11px', fontWeight: 700 }}>
              {tr('Target Token', 'Token Target')}
            </label>
            <input
              type="text"
              value={targetSymbol}
              onChange={(e) => setTargetSymbol(e.target.value)}
              className="input"
              style={{ padding: '6px 9px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="text-muted" style={{ fontSize: '11px', fontWeight: 700 }}>
              {tr('Order Amount (USD)', 'Nominal Order (USD)')}
            </label>
            <input
              type="number"
              min={1}
              max={effectiveGuardrail.maxSingleTxUsd}
              value={amountUsd}
              onChange={(e) => setAmountUsd(Number(e.target.value) || 1)}
              className="input"
              style={{ padding: '6px 9px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
            />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--color-foreground)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requireGoPlus}
            onChange={(e) => setRequireGoPlus(e.target.checked)}
          />
          {tr('Require GoPlus Anti-Honeypot Pre-Check before MPC signing', 'Wajibkan GoPlus Anti-Honeypot Pre-Check sebelum MPC signing')}
        </label>

        <div
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-background)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <code style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-accent-info)', wordBreak: 'break-all' }}>
            <Terminal size={11} style={{ display: 'inline', marginRight: '5px' }} />
            {generatedCmd}
          </code>
          <button
            type="button"
            onClick={handleCopyCommand}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '4px 8px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            {copiedCmd ? <Check size={12} /> : <Copy size={12} />}
            {copiedCmd ? tr('Copied', 'Disalin') : tr('Copy', 'Salin')}
          </button>
        </div>
      </div>
    </div>
  );
}
