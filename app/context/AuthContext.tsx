'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export type UserRole =
  | 'GUEST'
  | 'TRADER'
  | 'CREATOR'
  | 'LAUNCH_ADMIN'
  | 'SYSTEM_ADMIN'
  | 'SUPER_ADMIN';

export interface AuthContextType {
  walletAddress: string | null;
  userId: string | null;
  isConnected: boolean;
  userRole: UserRole;
  credits: number;
  isConnecting: boolean;
  chainId: string | null;
  connectWallet: (address: string, role?: UserRole) => void;
  connectMetaMask: () => Promise<{ success: boolean; address?: string; error?: string }>;
  disconnectWallet: () => void | Promise<void>;
  switchRole: (role: UserRole) => void;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Resolves the best available EIP-1193 provider in multi-wallet browsers
 * (prioritizes MetaMask from window.ethereum.providers, falls back to window.ethereum).
 */
function resolveInjectedEthereumProvider(): any | null {
  if (typeof window === 'undefined') return null;
  const eth = (window as any).ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    const mm = eth.providers.find((p: any) => p?.isMetaMask && !p?.isBraveWallet);
    return mm || eth.providers[0];
  }
  return eth;
}

function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);
}

function utf8ToHex(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function requestWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [userRole, setUserRole] = useState<UserRole>('GUEST');
  const [credits, setCredits] = useState<number>(0);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [chainId, setChainId] = useState<string | null>(null);

  // Server-Side Session Revalidation (SSOT)
  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/session', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      const json = await res.json();

      if (json.success && json.data && json.data.authenticated) {
        setWalletAddress(json.data.walletAddress);
        setUserId(json.data.userId);
        setIsConnected(true);
        setUserRole(json.data.userRole);
        setCredits(json.data.credits);
        return;
      }

      // Disconnected state (Guest)
      setWalletAddress(null);
      setUserId(null);
      setIsConnected(false);
      setUserRole('GUEST');
      setCredits(0);
    } catch (e) {
      console.warn('[AuthContext] Session revalidation warning:', e);
      setIsConnected(false);
      setUserRole('GUEST');
    }
  }, []);

  // Initial load
  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const disconnectWallet = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.warn('[AuthContext] Failed to call logout endpoint:', err);
    }
    document.cookie = 'rtrader_session=; path=/; max-age=0; SameSite=Strict';
    localStorage.removeItem('rtrader_role');

    setWalletAddress(null);
    setUserId(null);
    setIsConnected(false);
    setUserRole('GUEST');
    setCredits(0);
  }, []);

  const connectWallet = useCallback((address: string, role: UserRole = 'TRADER') => {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[AuthContext] Direct connectWallet without cryptographic SIWE signature is disabled in production.');
      return;
    }
    // In local development / test harness:
    setWalletAddress(address);
    setUserId(`usr-${address.slice(0, 10).toLowerCase()}`);
    setIsConnected(true);
    setUserRole(role);
    setCredits(role === 'SYSTEM_ADMIN' ? 999999 : 15000);
  }, []);

  // Real Dynamic MetaMask Connection with EIP-4361 SIWE Signature Flow
  const connectMetaMask = useCallback(async (): Promise<{ success: boolean; address?: string; error?: string }> => {
    const ethereum = resolveInjectedEthereumProvider();
    if (!ethereum) {
      if (typeof window !== 'undefined' && isMobileBrowser()) {
        const dappPath = `${window.location.host}${window.location.pathname}${window.location.search}`;
        const deepLink = `https://metamask.app.link/dapp/${dappPath}`;
        window.location.href = deepLink;
        return {
          success: false,
          error: 'Membuka aplikasi MetaMask Mobile... Jika tidak otomatis terbuka, buka situs ini langsung dari browser di dalam aplikasi MetaMask.',
        };
      }
      return {
        success: false,
        error: 'MetaMask atau ekstensi dompet Web3 tidak terdeteksi di browser ini. Pasang MetaMask di Desktop atau buka situs melalui MetaMask Mobile Browser.',
      };
    }

    setIsConnecting(true);
    try {
      // 1. Check already-permitted accounts first (0ms, avoids double popup); request permission only if empty
      let accounts: string[] = [];
      try {
        accounts = await ethereum.request({ method: 'eth_accounts' });
      } catch {
        accounts = [];
      }
      if (!accounts || accounts.length === 0) {
        accounts = await requestWithTimeout<string[]>(
          ethereum.request({ method: 'eth_requestAccounts' }),
          30000,
          'Popup MetaMask belum disetujui. Klik ikon ekstensi MetaMask (🦊) di pojok kanan atas browser Anda untuk membuka popup yang tertunda.'
        );
      }

      if (!accounts || accounts.length === 0) {
        throw new Error('Tidak ada akun Ethereum yang dipilih di MetaMask.');
      }

      const activeAddress = accounts[0];

      // Request Chain ID (non-blocking)
      ethereum
        .request({ method: 'eth_chainId' })
        .then((cId: string) => setChainId(cId))
        .catch(() => {});

      // 2. Request SIWE Challenge from backend for this dynamic address
      const challengeRes = await fetch('/api/auth/challenge', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: activeAddress, chainType: 'EVM' }),
      });
      const challengeJson = await challengeRes.json();

      if (!challengeJson.success || !challengeJson.data) {
        throw new Error(challengeJson.error?.message || 'Gagal mengambil SIWE challenge dari server.');
      }

      const { nonce, messageToSign } = challengeJson.data;

      // 3. Prompt wallet popup immediately (0ms synchronous hex encoding to preserve browser user gesture)
      const hexMessage = utf8ToHex(messageToSign);
      const pendingPopupHint =
        'Menunggu tanda tangan di MetaMask. Jika popup tidak muncul otomatis, klik ikon ekstensi MetaMask (🦊) di pojok kanan atas browser Anda.';
      let signature: string;
      try {
        signature = await requestWithTimeout<string>(
          ethereum.request({
            method: 'personal_sign',
            params: [hexMessage, activeAddress],
          }),
          45000,
          pendingPopupHint
        );
      } catch (signErr: any) {
        if (signErr?.code === 4001) throw new Error('Tanda tangan SIWE dibatalkan di MetaMask.');
        if (signErr?.code === -32002) throw new Error(pendingPopupHint);
        signature = await requestWithTimeout<string>(
          ethereum.request({
            method: 'personal_sign',
            params: [messageToSign, activeAddress],
          }),
          45000,
          pendingPopupHint
        );
      }

      // 4. Verify cryptographic signature on backend (sets HttpOnly Secure rtrader_session cookie)
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: activeAddress,
          chainType: 'EVM',
          signature,
          nonce,
          message: messageToSign,
        }),
      });
      const verifyJson = await verifyRes.json();

      if (!verifyJson.success) {
        throw new Error(verifyJson.error?.message || 'Verifikasi tanda tangan SIWE gagal.');
      }

      // 5. Immediately hydrate authenticated state from verify response, then confirm via /api/auth/session
      const verifiedRole = (verifyJson.data?.roles?.[0] as UserRole) || 'TRADER';
      setWalletAddress(verifyJson.data?.primaryWallet || activeAddress);
      setUserId(verifyJson.data?.userId || `usr-${activeAddress.slice(0, 10).toLowerCase()}`);
      setUserRole(verifiedRole);
      setIsConnected(true);
      await refreshSession();

      return { success: true, address: activeAddress };
    } catch (err: any) {
      const msg =
        err?.code === -32002
          ? 'Permintaan MetaMask sudah terbuka di latar belakang. Klik ikon ekstensi MetaMask (🦊) di pojok kanan atas browser Anda.'
          : err?.message || 'Koneksi dompet dibatalkan atau gagal.';
      return { success: false, error: msg };
    } finally {
      setIsConnecting(false);
    }
  }, [refreshSession]);

  // Listen for MetaMask account & chain changes dynamically (EIP-1193)
  useEffect(() => {
    const ethereum = resolveInjectedEthereumProvider();
    if (ethereum) {

      const handleAccountsChanged = (accounts: string[]) => {
        if (!accounts || accounts.length === 0) {
          disconnectWallet();
        } else if (walletAddress && accounts[0].toLowerCase() !== walletAddress.toLowerCase()) {
          // Dynamic account switch in MetaMask: clear old HttpOnly session so user cleanly re-authenticates via SIWE
          disconnectWallet();
        }
      };

      const handleChainChanged = (newChainId: string) => {
        setChainId(newChainId);
      };

      ethereum.on?.('accountsChanged', handleAccountsChanged);
      ethereum.on?.('chainChanged', handleChainChanged);

      return () => {
        ethereum.removeListener?.('accountsChanged', handleAccountsChanged);
        ethereum.removeListener?.('chainChanged', handleChainChanged);
      };
    }
  }, [walletAddress, disconnectWallet, refreshSession]);

  const switchRole = useCallback((role: UserRole) => {
    if (role === 'GUEST') {
      disconnectWallet();
      return;
    }

    if (process.env.NODE_ENV === 'production') {
      console.warn('[AuthContext] Role switching is disabled in production. Roles are strictly authoritative from backend SIWE session.');
      return;
    }

    console.warn('[AuthContext] Role switching is only permitted in local dev sandbox and does not elevate backend API permissions.');
    setUserRole(role);
  }, [disconnectWallet]);

  return (
    <AuthContext.Provider
      value={{
        walletAddress,
        userId,
        isConnected,
        userRole,
        credits,
        isConnecting,
        chainId,
        connectWallet,
        connectMetaMask,
        disconnectWallet,
        switchRole,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
