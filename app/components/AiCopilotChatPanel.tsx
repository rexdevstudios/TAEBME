'use client';

import React, { useRef, useState } from 'react';
import { Bot, Mic, MicOff, Send, ShieldCheck, CheckSquare, Square } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import type {
  CopilotActionDraft,
  CopilotConnectedAccount,
} from '@packages/agent/copilot-engine';

interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  provider?: string;
  liveHighlights?: {
    topMovers?: Array<{ symbol: string; lastPrice: number; priceChangePct24h: number }>;
    kolConsensus?: { score: number; verdict: string; uniqueVerifiedKols: number };
  };
  actionDraft?: CopilotActionDraft | null;
  availableAccounts?: CopilotConnectedAccount[];
  riskLimits?: { maxOrderValueUsd: number; maxDailyLossUsd: number; killSwitchActive: boolean };
  confirmedResult?: { queuedOrDispatchedCount: number; totalExposureUsd: number; details: string[] };
}

interface AiCopilotChatPanelProps {
  isConnected: boolean;
}

export function AiCopilotChatPanel({ isConnected }: AiCopilotChatPanelProps) {
  const { locale, tr } = useLocale();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [selectedByMsg, setSelectedByMsg] = useState<Record<string, string[]>>({});
  const [confirmingMsgId, setConfirmingMsgId] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  const quickPrompts = [
    tr('Any token up > 5% today?', 'Ada token naik > 5% hari ini?'),
    tr('Check my deployer fees', 'Cek fee deployer saya'),
    tr('Buy limit BTC at 88000 for $100', 'Beli limit BTC di 88000 sebesar $100'),
    tr('Check connected Binance & Bankr accounts', 'Cek akun Binance & Bankr terkonek'),
  ];

  const handleToggleVoice = () => {
    setVoiceNotice(null);
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }
    if (typeof window === 'undefined') return;
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setVoiceNotice(
        tr(
          'Browser does not support Web Speech API. Please type your command.',
          'Browser ini belum mendukung Web Speech API. Silakan ketik perintah Anda.'
        )
      );
      return;
    }
    try {
      const rec = new SpeechRec();
      rec.lang = locale === 'id' ? 'id-ID' : 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event: any) => {
        const transcript = event?.results?.[0]?.[0]?.transcript || '';
        if (transcript) {
          setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
        }
      };
      rec.onerror = () => {
        setListening(false);
      };
      rec.onend = () => {
        setListening(false);
      };
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    if (!isConnected) {
      setVoiceNotice(tr('Connect wallet (SIWE) first to use AI Copilot.', 'Hubungkan wallet (SIWE) terlebih dahulu untuk memakai AI Copilot.'));
      return;
    }
    setVoiceNotice(null);
    setSending(true);
    const userMsg: CopilotMessage = { id: `u-${Date.now()}`, role: 'user', text };
    setMessages((prev) => [...prev, userMsg]);
    if (!overrideText) setInput('');

    try {
      const res = await fetch('/api/agent/copilot/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, locale }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setMessages((prev) => [
          ...prev,
          { id: `e-${Date.now()}`, role: 'assistant', text: `Notice: ${json?.error || `HTTP ${res.status}`}` },
        ]);
        return;
      }

      const d = json.data;
      const msgId = `a-${Date.now()}`;
      const compatibleAccounts: CopilotConnectedAccount[] = (d.availableAccounts || []).filter(
        (a: CopilotConnectedAccount) =>
          !d.actionDraft || d.actionDraft.supportedRails.includes(a.rail)
      );
      if (d.actionDraft && compatibleAccounts.length > 0) {
        const defaultAcct = compatibleAccounts.find((a) => a.isDefault) || compatibleAccounts[0];
        setSelectedByMsg((prev) => ({ ...prev, [msgId]: [defaultAcct.id] }));
      }

      setMessages((prev) => [
        ...prev,
        {
          id: msgId,
          role: 'assistant',
          text: String(d.reply || ''),
          provider: d.provider,
          liveHighlights: d.liveHighlights,
          actionDraft: d.actionDraft || null,
          availableAccounts: compatibleAccounts,
          riskLimits: d.riskLimits,
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'assistant', text: `Notice: ${err?.message || 'Request failed'}` },
      ]);
    } finally {
      setSending(false);
    }
  };

  const toggleAccount = (msgId: string, accountId: string) => {
    setSelectedByMsg((prev) => {
      const cur = prev[msgId] || [];
      const next = cur.includes(accountId) ? cur.filter((id) => id !== accountId) : [...cur, accountId];
      return { ...prev, [msgId]: next };
    });
  };

  const selectAllAccounts = (msgId: string, accounts: CopilotConnectedAccount[]) => {
    setSelectedByMsg((prev) => ({ ...prev, [msgId]: accounts.map((a) => a.id) }));
  };

  const handleConfirmExecution = async (msg: CopilotMessage) => {
    if (!msg.actionDraft || !msg.availableAccounts) return;
    const pickedIds = selectedByMsg[msg.id] || [];
    if (pickedIds.length === 0) return;

    setConfirmingMsgId(msg.id);
    try {
      const selectedAccounts = msg.availableAccounts
        .filter((a) => pickedIds.includes(a.id))
        .map((a) => ({ id: a.id, rail: a.rail }));

      const res = await fetch('/api/agent/copilot/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionDraft: msg.actionDraft,
          selectedAccounts,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setVoiceNotice(`Notice: ${json?.error || `HTTP ${res.status}`}`);
        return;
      }

      const details = (json.data?.results || []).map(
        (r: any) => `[${r.rail}] ${r.status}: ${r.detail}`
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? {
                ...m,
                confirmedResult: {
                  queuedOrDispatchedCount: Number(json.data?.queuedOrDispatchedCount || 0),
                  totalExposureUsd: Number(json.data?.exposure?.totalExposureUsd || 0),
                  details,
                },
              }
            : m
        )
      );
    } finally {
      setConfirmingMsgId(null);
    }
  };

  return (
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '7px' }}>
            <Bot size={16} style={{ color: 'var(--color-accent-info)' }} />
            {tr('Universal AI Copilot (Chat + Voice + Multi-Account)', 'Universal AI Copilot (Chat + Suara + Multi-Akun)')}
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            {tr(
              'Ask live market movers (>%), deployer fees, news/KOL consensus, or draft LIMIT/MARKET/Bankr orders with multi-account confirmation.',
              'Tanya top movers (>%), cek fee deployer, berita/konsensus KOL, atau buat draft order LIMIT/MARKET/Bankr dengan konfirmasi multi-akun.'
            )}
          </div>
        </div>
        <span style={{ fontSize: '10px', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--color-text-positive)' }}>
          HUMAN-IN-THE-LOOP · NON-CUSTODIAL
        </span>
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {quickPrompts.map((qp) => (
          <button
            key={qp}
            type="button"
            onClick={() => handleSend(qp)}
            disabled={sending}
            className="btn-secondary"
            style={{ fontSize: '11px', padding: '4px 9px' }}
          >
            {qp}
          </button>
        ))}
      </div>

      {messages.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            maxHeight: '360px',
            overflowY: 'auto',
            padding: '10px',
            borderRadius: '8px',
            backgroundColor: 'var(--color-surface-elevated)',
            border: '1px solid var(--color-border)',
          }}
        >
          {messages.map((m) => {
            const picked = selectedByMsg[m.id] || [];
            const totalUsd = m.actionDraft ? Math.round(picked.length * m.actionDraft.amountUsd * 100) / 100 : 0;
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  backgroundColor:
                    m.role === 'user' ? 'rgba(56, 189, 248, 0.14)' : 'var(--color-panel)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-foreground)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--color-muted)', marginBottom: '3px', fontFamily: 'var(--font-mono)' }}>
                  {m.role === 'user' ? 'YOU' : `COPILOT${m.provider ? ` · ${m.provider}` : ''}`}
                </div>
                <div>{m.text}</div>

                {m.liveHighlights &&
                  ((m.liveHighlights.topMovers && m.liveHighlights.topMovers.length > 0) ||
                    m.liveHighlights.kolConsensus) && (
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                      {m.liveHighlights.kolConsensus && (
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 800,
                            fontFamily: 'var(--font-mono)',
                            padding: '2px 7px',
                            borderRadius: '4px',
                            border: '1px solid rgba(56, 189, 248, 0.35)',
                            color: 'var(--color-accent-info)',
                          }}
                        >
                          KOL VERIFIED: {m.liveHighlights.kolConsensus.verdict} ({m.liveHighlights.kolConsensus.score}/100)
                        </span>
                      )}
                      {(m.liveHighlights.topMovers || []).slice(0, 4).map((mv) => (
                        <button
                          key={mv.symbol}
                          type="button"
                          onClick={() =>
                            setInput(
                              tr(
                                `Buy limit ${mv.symbol.replace(/USDT$/, '')} at ${mv.lastPrice} for $100`,
                                `Beli limit ${mv.symbol.replace(/USDT$/, '')} di ${mv.lastPrice} sebesar $100`
                              )
                            )
                          }
                          className="btn-secondary"
                          style={{
                            fontSize: '10px',
                            padding: '2px 7px',
                            fontFamily: 'var(--font-mono)',
                            color: mv.priceChangePct24h >= 0 ? 'var(--color-text-positive)' : 'var(--color-destructive)',
                          }}
                        >
                          {mv.symbol} {mv.priceChangePct24h >= 0 ? '+' : ''}
                          {mv.priceChangePct24h.toFixed(1)}%
                        </button>
                      ))}
                    </div>
                  )}

                {m.actionDraft && !m.confirmedResult && (
                  <div
                    style={{
                      marginTop: '10px',
                      padding: '10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(16, 185, 129, 0.35)',
                      backgroundColor: 'rgba(16, 185, 129, 0.06)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-text-positive)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <ShieldCheck size={13} />
                        {tr('Multi-Account Execution Confirmation', 'Konfirmasi Eksekusi Multi-Akun')}
                      </span>
                      {(m.availableAccounts || []).length > 1 && (
                        <button
                          type="button"
                          onClick={() => selectAllAccounts(m.id, m.availableAccounts || [])}
                          className="btn-secondary"
                          style={{ fontSize: '10px', padding: '2px 7px' }}
                        >
                          {tr('Select All Accounts', 'Pilih Semua Akun')}
                        </button>
                      )}
                    </div>

                    {(m.availableAccounts || []).length === 0 ? (
                      <div className="text-muted" style={{ fontSize: '11px' }}>
                        {tr(
                          'No matching active API accounts found in Vault. Connect Binance, Bybit, or Bankr API in /billing.',
                          'Belum ada akun API aktif yang cocok di Vault. Hubungkan Binance, Bybit, atau Bankr API di /billing.'
                        )}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {(m.availableAccounts || []).map((acct) => {
                          const isChecked = picked.includes(acct.id);
                          return (
                            <button
                              key={acct.id}
                              type="button"
                              onClick={() => toggleAccount(m.id, acct.id)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '5px 8px',
                                borderRadius: '5px',
                                border: '1px solid var(--color-border)',
                                backgroundColor: isChecked ? 'rgba(16, 185, 129, 0.14)' : 'transparent',
                                color: 'var(--color-foreground)',
                                fontSize: '11px',
                                fontFamily: 'var(--font-mono)',
                                cursor: 'pointer',
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                {isChecked ? <CheckSquare size={13} /> : <Square size={13} />}
                                [{acct.rail}] {acct.label} ({acct.scope})
                              </span>
                              <span className="text-muted">{acct.maskedKey}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                      <span>
                        {tr('Total Exposure', 'Total Eksposur')}: <strong>${totalUsd.toLocaleString()}</strong> ({picked.length} {tr('accounts', 'akun')})
                      </span>
                      <button
                        type="button"
                        disabled={picked.length === 0 || confirmingMsgId === m.id || Boolean(m.riskLimits?.killSwitchActive)}
                        onClick={() => handleConfirmExecution(m)}
                        className="btn-primary"
                        style={{ fontSize: '11px', padding: '5px 12px' }}
                      >
                        {confirmingMsgId === m.id
                          ? tr('Executing...', 'Mengeksekusi...')
                          : tr('Confirm & Execute', 'Konfirmasi & Eksekusi')}
                      </button>
                    </div>
                  </div>
                )}

                {m.confirmedResult && (
                  <div
                    style={{
                      marginTop: '8px',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '1px solid rgba(16, 185, 129, 0.35)',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-positive)',
                    }}
                  >
                    OK: {m.confirmedResult.queuedOrDispatchedCount} {tr('account(s) processed', 'akun diproses')} (${m.confirmedResult.totalExposureUsd})
                    {m.confirmedResult.details.map((d, idx) => (
                      <div key={idx} style={{ color: 'var(--color-muted)', marginTop: '2px' }}>
                        - {d}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          type="button"
          onClick={handleToggleVoice}
          className="btn-secondary"
          title={tr('Voice Command (Web Speech API)', 'Perintah Suara (Web Speech API)')}
          style={{
            padding: '9px 11px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            color: listening ? 'var(--color-destructive)' : 'var(--color-foreground)',
          }}
        >
          {listening ? <MicOff size={15} /> : <Mic size={15} />}
          <span style={{ fontSize: '11px' }}>{listening ? tr('Stop', 'Stop') : tr('Voice', 'Suara')}</span>
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend();
          }}
          placeholder={tr(
            'Type or speak: "Buy limit BTC at 88000 for $100", "Any token up > 5%?", "Check deployer fees"...',
            'Ketik atau ucapkan: "Beli limit BTC di 88000 sebesar $100", "Ada token naik > 5%?", "Cek fee deployer"...'
          )}
          className="input"
          style={{ flex: 1, padding: '9px 12px', fontSize: '12px' }}
        />
        <button
          type="button"
          onClick={() => handleSend()}
          disabled={sending || !input.trim()}
          className="btn-primary"
          style={{ padding: '9px 14px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
        >
          <Send size={13} />
          {sending ? tr('Thinking...', 'Memproses...') : tr('Send', 'Kirim')}
        </button>
      </div>

      {voiceNotice && (
        <div style={{ fontSize: '11px', color: 'var(--color-accent-amber)', fontWeight: 700 }}>
          {voiceNotice}
        </div>
      )}
    </div>
  );
}
