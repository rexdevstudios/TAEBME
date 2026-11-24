'use client';

import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { ShieldAlert, CheckCircle2, AlertTriangle, Lock, Send, Layers } from 'lucide-react';
import {
  getContractConfiguration,
  ensureBaseNetwork,
  getBrowserSigner,
  getLaunchpadContract,
  normalizeWeb3Error,
  getExplorerUrl,
} from '@packages/launchpad/web3-provider';

export interface ActiveLaunchOption {
  launchId?: string;
  id?: string;
  name?: string;
  ticker?: string;
  contractAddress?: string;
  chain?: string;
}

interface AdminMerkleSnapshotPanelProps {
  activeTokens: ActiveLaunchOption[];
  walletAddress: string | null;
}

export function AdminMerkleSnapshotPanel({
  activeTokens,
  walletAddress,
}: AdminMerkleSnapshotPanelProps) {
  const [selectedLaunchId, setSelectedLaunchId] = useState<string>('');
  const [manualLaunchId, setManualLaunchId] = useState<string>('');
  const [campaignId, setCampaignId] = useState<string>('');

  // Snapshot lifecycle state
  const [snapshotId, setSnapshotId] = useState<string>('');
  const [snapshotStatus, setSnapshotStatus] = useState<string>('');
  const [merkleRoot, setMerkleRoot] = useState<string>('');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [totalRewardTokens, setTotalRewardTokens] = useState<string>('');
  const [tokenAddress, setTokenAddress] = useState<string>('');
  const [manualTxHash, setManualTxHash] = useState<string>('');
  const [publishedTxHash, setPublishedTxHash] = useState<string | null>(null);
  const [queuedIntentId, setQueuedIntentId] = useState<string | null>(null);

  // Loading & feedback
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const validLaunches = activeTokens.filter((t) => Boolean(t.launchId || t.id));

  useEffect(() => {
    if (!selectedLaunchId && validLaunches.length > 0) {
      const first = validLaunches[0];
      const lid = first.launchId || first.id || '';
      setSelectedLaunchId(lid);
      if (first.contractAddress && ethers.isAddress(first.contractAddress)) {
        setTokenAddress(first.contractAddress);
      }
    }
  }, [activeTokens]);

  const effectiveLaunchId = manualLaunchId.trim() || selectedLaunchId;

  const handleLaunchSelection = (lid: string) => {
    setSelectedLaunchId(lid);
    const found = validLaunches.find((t) => (t.launchId || t.id) === lid);
    if (found?.contractAddress && ethers.isAddress(found.contractAddress)) {
      setTokenAddress(found.contractAddress);
    }
  };

  // Step 1: POST /api/admin/launchpad/snapshots/draft
  const handleCreateDraft = async () => {
    if (!effectiveLaunchId) {
      setErrorMessage('Pilih Token Launch atau masukkan Launch ID (UUID) terlebih dahulu.');
      return;
    }
    setBusyAction('draft');
    setErrorMessage(null);
    setStatusMessage(null);
    setPublishedTxHash(null);
    setQueuedIntentId(null);

    try {
      const res = await fetch('/api/admin/launchpad/snapshots/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          launchId: effectiveLaunchId,
          campaignId: campaignId.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErrorMessage(`Draft gagal (${res.status}): ${json.error || 'Unknown error'}`);
        return;
      }

      setSnapshotId(json.data.snapshotId);
      setSnapshotStatus(json.data.status || 'DRAFT');
      setRecipientCount(json.data.recipientCount ?? 0);
      setTotalRewardTokens(json.data.totalRewardTokens ?? '0');
      if (json.data.merkleRoot) {
        setMerkleRoot(json.data.merkleRoot);
      }
      setStatusMessage(
        `OK: Snapshot DRAFT dibuat (${json.data.snapshotId}) — ${json.data.recipientCount} penerima, total ${json.data.totalRewardTokens} token.`
      );
    } catch (err: any) {
      setErrorMessage(`Koneksi gagal: ${err?.message || 'Tidak dapat menghubungi server'}`);
    } finally {
      setBusyAction(null);
    }
  };

  // Step 2: POST /api/admin/launchpad/snapshots/finalize
  const handleFinalizeSnapshot = async () => {
    if (!snapshotId.trim()) {
      setErrorMessage('Snapshot ID belum tersedia. Buat DRAFT atau tempel Snapshot ID terlebih dahulu.');
      return;
    }
    setBusyAction('finalize');
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/admin/launchpad/snapshots/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: snapshotId.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErrorMessage(`Finalisasi gagal (${res.status}): ${json.error || 'Unknown error'}`);
        return;
      }

      setSnapshotStatus(json.data.status || 'FINALIZED');
      setMerkleRoot(json.data.merkleRoot || '');
      setRecipientCount(json.data.totalRecipients ?? recipientCount);
      setTotalRewardTokens(json.data.totalRewardTokens ?? totalRewardTokens);
      setStatusMessage(
        `Auth: Snapshot FINALIZED! Merkle Root: ${json.data.merkleRoot} (Depth ${json.data.treeDepth}, ${json.data.totalRecipients} penerima). Siap dipublikasikan on-chain.`
      );
    } catch (err: any) {
      setErrorMessage(`Koneksi gagal: ${err?.message || 'Tidak dapat menghubungi server'}`);
    } finally {
      setBusyAction(null);
    }
  };

  // Helper: POST /api/admin/launchpad/snapshots/confirm-publish
  const confirmPublishInSsot = async (targetSnapshotId: string, txHash: string) => {
    const res = await fetch('/api/admin/launchpad/snapshots/confirm-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: targetSnapshotId, txHash }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      setErrorMessage(`Confirm-Publish SSOT gagal (${res.status}): ${json.error || 'Unknown error'}`);
      return false;
    }

    setSnapshotStatus(json.data.status || 'PUBLISHED');
    setPublishedTxHash(json.data.publicationTxHash || txHash);
    setStatusMessage(
      `Snapshot PUBLISHED & terverifikasi on-chain! Tx: ${txHash} (Block #${json.data.confirmedBlockNumber ?? 'confirmed'}).`
    );
    return true;
  };

  // Step 3A (Vercel-First Non-Custodial): MetaMask setBountyMerkleRoot -> confirm-publish
  const handleMetaMaskPublishAndConfirm = async () => {
    if (!snapshotId.trim()) {
      setErrorMessage('Snapshot ID wajib diisi.');
      return;
    }
    if (!walletAddress) {
      setErrorMessage('Hubungkan dompet Web3 MetaMask (Contract Owner) terlebih dahulu.');
      return;
    }
    if (!ethers.isAddress(tokenAddress.trim())) {
      setErrorMessage('Alamat ERC-20 Token tidak valid. Pilih token launch atau masukkan alamat 0x... yang valid.');
      return;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(merkleRoot.trim())) {
      setErrorMessage('Merkle Root tidak valid (harus 32-byte hex 0x...). Pastikan snapshot sudah FINALIZED.');
      return;
    }

    const contractConfig = getContractConfiguration();
    if (!contractConfig.isConfigured || !contractConfig.contractAddress) {
      setErrorMessage(contractConfig.message);
      return;
    }

    setBusyAction('metamask');
    setErrorMessage(null);
    setStatusMessage('Memastikan jaringan Base/L2 sesuai konfigurasi environment...');

    try {
      const netCheck = await ensureBaseNetwork();
      if (!netCheck.success) {
        setErrorMessage(netCheck.error || 'Gagal beralih ke jaringan yang sesuai.');
        return;
      }

      setStatusMessage('Menunggu tanda tangan MetaMask untuk setBountyMerkleRoot(tokenAddress, merkleRoot)...');
      const signer = await getBrowserSigner();
      const contract = getLaunchpadContract(signer);
      const tx = await contract.setBountyMerkleRoot(
        ethers.getAddress(tokenAddress.trim()),
        merkleRoot.trim()
      );

      setStatusMessage(`Transaksi terkirim (${tx.hash}). Menunggu konfirmasi blok on-chain...`);
      await tx.wait();

      setManualTxHash(tx.hash);
      setStatusMessage(`Transaksi mined (${tx.hash}). Memverifikasi root on-chain & memperbarui PostgreSQL SSOT...`);
      await confirmPublishInSsot(snapshotId.trim(), tx.hash);
    } catch (err: any) {
      setErrorMessage(`MetaMask Publish gagal: ${normalizeWeb3Error(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  // Step 3A-Manual: Confirm already-mined txHash (e.g., signed via Safe Multisig)
  const handleManualConfirmPublish = async () => {
    if (!snapshotId.trim()) {
      setErrorMessage('Snapshot ID wajib diisi.');
      return;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(manualTxHash.trim())) {
      setErrorMessage('TxHash tidak valid (harus 32-byte hex 0x...).');
      return;
    }

    setBusyAction('confirm');
    setErrorMessage(null);
    setStatusMessage('Memverifikasi receipt & Merkle Root on-chain di PostgreSQL SSOT...');
    try {
      await confirmPublishInSsot(snapshotId.trim(), manualTxHash.trim());
    } catch (err: any) {
      setErrorMessage(`Koneksi gagal: ${err?.message || 'Tidak dapat menghubungi server'}`);
    } finally {
      setBusyAction(null);
    }
  };

  // Step 3B (Execution Plane Worker): POST /api/admin/launchpad/snapshots/publish-intent
  const handleQueuePublishIntent = async () => {
    if (!snapshotId.trim()) {
      setErrorMessage('Snapshot ID wajib diisi (harus berstatus FINALIZED).');
      return;
    }

    setBusyAction('intent');
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/admin/launchpad/snapshots/publish-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: snapshotId.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErrorMessage(`Queue Publish Intent gagal (${res.status}): ${json.error || 'Unknown error'}`);
        return;
      }

      setQueuedIntentId(json.data.intentId);
      setStatusMessage(
        `Publication Intent (${json.data.intentId}) berstatus ${json.data.status} telah masuk antrean Execution Plane Worker.`
      );
    } catch (err: any) {
      setErrorMessage(`Koneksi gagal: ${err?.message || 'Tidak dapat menghubungi server'}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid rgba(0, 229, 255, 0.45)',
        borderRadius: '8px',
        padding: '24px',
        marginTop: '16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 900, color: 'var(--color-accent-info)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Layers size={17} /> Bounty Merkle Snapshot Console (RBAC: MANAGE_SNAPSHOTS)
        </h3>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: '4px',
            backgroundColor: 'rgba(16, 185, 129, 0.14)',
            color: 'var(--color-text-positive)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          NON-CUSTODIAL · ZERO PRIVATE KEY IN VERCEL
        </span>
      </div>

      {/* Step 1: Select Launch & Create Draft */}
      <div className="grid-3" style={{ gap: '12px', marginBottom: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            Target Token Launch (SSOT)
          </label>
          <select
            value={selectedLaunchId}
            onChange={(e) => handleLaunchSelection(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '12px',
            }}
          >
            <option value="">-- Pilih Launch Terdaftar --</option>
            {validLaunches.map((t) => {
              const lid = t.launchId || t.id || '';
              return (
                <option key={lid} value={lid}>
                  {t.ticker || 'TOKEN'} — {t.name || lid.slice(0, 8)}
                </option>
              );
            })}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            Atau Launch ID Manual (UUID)
          </label>
          <input
            type="text"
            value={manualLaunchId}
            onChange={(e) => setManualLaunchId(e.target.value)}
            placeholder="Opsional: override UUID launch"
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            Campaign ID Filter (Opsional)
          </label>
          <input
            type="text"
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            placeholder="Kosongkan untuk semua kampanye"
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
            }}
          />
        </div>
      </div>

      {/* Step 2: Snapshot State & Resume Inputs */}
      <div className="grid-3" style={{ gap: '12px', marginBottom: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            Snapshot ID {snapshotStatus ? `(${snapshotStatus})` : ''}
          </label>
          <input
            type="text"
            value={snapshotId}
            onChange={(e) => setSnapshotId(e.target.value)}
            placeholder="Terisi otomatis atau tempel UUID"
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            Token Contract Address (ERC-20)
          </label>
          <input
            type="text"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            placeholder="0x..."
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--color-muted)', marginBottom: '4px' }}>
            Sealed Merkle Root (bytes32)
          </label>
          <input
            type="text"
            value={merkleRoot}
            onChange={(e) => setMerkleRoot(e.target.value)}
            placeholder="0x... (terisi saat Finalize)"
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--color-surface-elevated)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-foreground)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
            }}
          />
        </div>
      </div>

      {/* Action Buttons Row */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <button
          type="button"
          className="btn-secondary"
          disabled={busyAction !== null}
          onClick={handleCreateDraft}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          {busyAction === 'draft' ? 'Membuat Draft...' : '1. Create Snapshot Draft'}
        </button>

        <button
          type="button"
          className="btn-secondary"
          disabled={busyAction !== null || !snapshotId.trim()}
          onClick={handleFinalizeSnapshot}
          style={{
            fontSize: '12px',
            padding: '8px 14px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            borderColor: 'rgba(255, 214, 0, 0.5)',
            color: 'var(--color-accent-amber)',
          }}
        >
          <Lock size={13} />
          {busyAction === 'finalize' ? 'Menyegel Root...' : '2. Finalize & Seal Root'}
        </button>

        <button
          type="button"
          className="btn-primary"
          disabled={busyAction !== null || !snapshotId.trim() || !merkleRoot.trim()}
          onClick={handleMetaMaskPublishAndConfirm}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Send size={13} />
          {busyAction === 'metamask' ? 'Menunggu MetaMask...' : '3A. Sign setBountyMerkleRoot (MetaMask) & Confirm'}
        </button>

        <button
          type="button"
          className="btn-secondary"
          disabled={busyAction !== null || !snapshotId.trim()}
          onClick={handleQueuePublishIntent}
          style={{
            fontSize: '12px',
            padding: '8px 14px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            borderColor: 'rgba(168, 85, 247, 0.45)',
            color: 'var(--color-accent-purple)',
          }}
        >
          {busyAction === 'intent' ? 'Mengirim ke Worker...' : '3B. Queue Publish Intent (Execution Plane)'}
        </button>
      </div>

      {/* Safe Multisig / Manual TxHash Confirm Strip */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input
          type="text"
          value={manualTxHash}
          onChange={(e) => setManualTxHash(e.target.value)}
          placeholder="Opsional (Safe Multisig / Hardware Wallet): tempel mined txHash 0x... lalu klik Confirm"
          style={{
            flex: '1 1 320px',
            padding: '7px 10px',
            borderRadius: '6px',
            backgroundColor: 'var(--color-surface-elevated)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-foreground)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={busyAction !== null || !snapshotId.trim() || !manualTxHash.trim()}
          onClick={handleManualConfirmPublish}
          style={{ fontSize: '11px', padding: '7px 12px' }}
        >
          {busyAction === 'confirm' ? 'Memverifikasi...' : 'Confirm Existing TxHash'}
        </button>
      </div>

      {/* Summary & Feedback */}
      {(recipientCount !== null || queuedIntentId || publishedTxHash) && (
        <div
          style={{
            display: 'flex',
            gap: '14px',
            flexWrap: 'wrap',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-muted)',
            marginBottom: '10px',
          }}
        >
          {recipientCount !== null && <span>Recipients: {recipientCount}</span>}
          {totalRewardTokens && <span>Total Reward: {totalRewardTokens}</span>}
          {queuedIntentId && <span>Intent ID: {queuedIntentId}</span>}
          {publishedTxHash && (
            <a
              href={getExplorerUrl(publishedTxHash, '0x2105', 'tx')}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-accent-info)', textDecoration: 'underline' }}
            >
              View Published Tx ↗
            </a>
          )}
        </div>
      )}

      {statusMessage && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            backgroundColor: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.35)',
            color: 'var(--color-text-positive)',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <CheckCircle2 size={15} />
          <span style={{ wordBreak: 'break-all' }}>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            color: '#FCA5A5',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: statusMessage ? '8px' : 0,
          }}
        >
          <AlertTriangle size={15} />
          <span style={{ wordBreak: 'break-all' }}>{errorMessage}</span>
        </div>
      )}
    </div>
  );
}
