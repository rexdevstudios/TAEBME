import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveBrowserEthereumProvider,
  ensureBaseNetwork,
  SUPPORTED_BASE_CHAINS,
} from '../packages/launchpad/web3-provider';

describe('Phase F1 — Direct MetaMask Chain Switcher & Multi-Wallet Provider Resolution', () => {
  const originalWindow = (globalThis as any).window;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    delete (globalThis as any).window;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
    (process.env as any).NODE_ENV = originalNodeEnv;
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }
  });

  it('F1.1 — prioritizes MetaMask over TokenPocket and BraveWallet in multi-provider browsers', () => {
    const tokenPocket = { isMetaMask: true, isTokenPocket: true, id: 'tp' };
    const brave = { isMetaMask: true, isBraveWallet: true, id: 'brave' };
    const metaMask = { isMetaMask: true, id: 'mm' };

    (globalThis as any).window = {
      ethereum: {
        providers: [tokenPocket, brave, metaMask],
      },
    };

    const resolved = resolveBrowserEthereumProvider();
    expect(resolved).toBe(metaMask);
  });

  it('F1.2 — switches chain directly via wallet_switchEthereumChain in production browser without APP_ENV', async () => {
    (process.env as any).NODE_ENV = 'production';
    delete process.env.APP_ENV;

    let activeChain = '0x2105';
    const calls: Array<{ method: string; params?: any[] }> = [];

    const mockMetaMask = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        calls.push({ method, params });
        if (method === 'eth_chainId') return activeChain;
        if (method === 'wallet_switchEthereumChain') {
          activeChain = params?.[0]?.chainId || activeChain;
          return null;
        }
        return null;
      },
    };

    (globalThis as any).window = {
      location: { hostname: 'pndigi.site' },
      ethereum: { providers: [{ isMetaMask: true, isTokenPocket: true }, mockMetaMask] },
    };

    const res = await ensureBaseNetwork('0x1237');
    expect(res.success).toBe(true);
    expect(res.chainId).toBe(4663);
    expect(res.hexChainId).toBe('0x1237');
    expect(calls.some((c) => c.method === 'wallet_switchEthereumChain' && c.params?.[0]?.chainId === '0x1237')).toBe(
      true
    );
  });

  it('F1.3 — handles nested 4902 error by calling wallet_addEthereumChain with full chain params', async () => {
    let activeChain = '0x2105';
    const calls: Array<{ method: string; params?: any[] }> = [];

    const mockMetaMask = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        calls.push({ method, params });
        if (method === 'eth_chainId') return activeChain;
        if (method === 'wallet_switchEthereumChain') {
          const nestedErr: any = new Error('Internal JSON-RPC error.');
          nestedErr.code = -32603;
          nestedErr.data = { originalError: { code: 4902, message: 'Unrecognized chain ID' } };
          throw nestedErr;
        }
        if (method === 'wallet_addEthereumChain') {
          activeChain = params?.[0]?.chainId || activeChain;
          return null;
        }
        return null;
      },
    };

    (globalThis as any).window = {
      location: { hostname: 'pndigi.site' },
      ethereum: mockMetaMask,
    };

    const res = await ensureBaseNetwork('0x14a34');
    expect(res.success).toBe(true);
    expect(res.chainId).toBe(SUPPORTED_BASE_CHAINS.BASE_SEPOLIA.chainId);
    expect(res.hexChainId).toBe('0x14a34');

    const addCall = calls.find((c) => c.method === 'wallet_addEthereumChain');
    expect(addCall).toBeDefined();
    expect(addCall?.params?.[0]?.chainName).toBe(SUPPORTED_BASE_CHAINS.BASE_SEPOLIA.name);
    expect(addCall?.params?.[0]?.rpcUrls?.[0]).toBe(SUPPORTED_BASE_CHAINS.BASE_SEPOLIA.rpcUrl);
  });

  it('F1.4 — returns USER_REJECTED error cleanly on MetaMask code 4001', async () => {
    const mockMetaMask = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'wallet_switchEthereumChain') {
          const err: any = new Error('User rejected the request.');
          err.code = 4001;
          throw err;
        }
        return null;
      },
    };

    (globalThis as any).window = {
      location: { hostname: 'pndigi.site' },
      ethereum: mockMetaMask,
    };

    const res = await ensureBaseNetwork('0xa4b1');
    expect(res.success).toBe(false);
    expect(res.error).toContain('USER_REJECTED');
  });

  it('F1.5 — returns actionable hint on MetaMask pending request error -32002', async () => {
    const mockMetaMask = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'wallet_switchEthereumChain') {
          const err: any = new Error('Request of type wallet_switchEthereumChain already pending');
          err.code = -32002;
          throw err;
        }
        return null;
      },
    };

    (globalThis as any).window = {
      location: { hostname: 'pndigi.site' },
      ethereum: mockMetaMask,
    };

    const res = await ensureBaseNetwork('0x13b2');
    expect(res.success).toBe(false);
    expect(res.error).toContain('MetaMask');
  });
});
