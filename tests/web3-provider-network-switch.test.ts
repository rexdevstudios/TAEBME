import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getDefaultBaseChainHex, ensureBaseNetwork, SUPPORTED_BASE_CHAINS, getExplorerUrl } from '../packages/launchpad/web3-provider';

describe('Web3 Provider Network Switching & Chain Enforcement', () => {
  const origEnv = { ...process.env };
  const origWindow = (globalThis as any).window;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.APP_ENV;
    delete process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    if (origWindow !== undefined) {
      (globalThis as any).window = origWindow;
    } else {
      delete (globalThis as any).window;
    }
  });

  describe('1. getDefaultBaseChainHex resolution & precedence', () => {
    it('resolves to Base Sepolia (0x14a34) when NEXT_PUBLIC_APP_ENV is testnet', () => {
      process.env.NEXT_PUBLIC_APP_ENV = 'testnet';
      delete (globalThis as any).window;
      expect(getDefaultBaseChainHex()).toBe('0x14a34');
    });

    it('resolves to Base Sepolia (0x14a34) when NEXT_PUBLIC_DEFAULT_CHAIN_ID is 84532', () => {
      process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID = '84532';
      delete (globalThis as any).window;
      expect(getDefaultBaseChainHex()).toBe('0x14a34');
    });

    it('gives explicit NEXT_PUBLIC_DEFAULT_CHAIN_ID precedence over window.location', () => {
      process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID = '8453';
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
      };
      expect(getDefaultBaseChainHex()).toBe('0x2105');
    });

    it('gives explicit APP_ENV=production precedence over testnet hostname', () => {
      process.env.APP_ENV = 'production';
      (globalThis as any).window = {
        location: { hostname: 'testnet.rbtrade.fun' },
      };
      expect(getDefaultBaseChainHex()).toBe('0x2105');
    });

    it('resolves to Base Mainnet (0x2105) in default production', () => {
      delete (globalThis as any).window;
      expect(getDefaultBaseChainHex()).toBe('0x2105');
    });

    it('resolves to Base Sepolia on testnet hostname in browser window without explicit env', () => {
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
      };
      expect(getDefaultBaseChainHex()).toBe('0x14a34');
    });

    it('resolves to Base Sepolia on localhost in browser window by default', () => {
      (globalThis as any).window = {
        location: { hostname: 'localhost' },
      };
      expect(getDefaultBaseChainHex()).toBe('0x14a34');
    });
  });

  describe('2. ensureBaseNetwork EIP-1193 RPC interactions', () => {
    it('returns fail-closed error if window.ethereum is missing', async () => {
      (globalThis as any).window = {};
      const res = await ensureBaseNetwork('0x14a34');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Dompet Web3 tidak terdeteksi');
    });

    it('returns success immediately without calling switch if wallet is already on target chain', async () => {
      let switchCalled = false;
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
        ethereum: {
          request: async ({ method }: { method: string }) => {
            if (method === 'eth_chainId') return '0x14a34';
            if (method === 'wallet_switchEthereumChain') {
              switchCalled = true;
              return null;
            }
            throw new Error('Unexpected method ' + method);
          },
        },
      };

      const res = await ensureBaseNetwork('0x14a34');
      expect(res.success).toBe(true);
      expect(res.chainId).toBe(84532);
      expect(switchCalled).toBe(false);
    });

    it('calls wallet_switchEthereumChain when wallet is on wrong chain and verifies new chain', async () => {
      let requestedChainId: string | null = null;
      let currentChain = '0x1';
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
        ethereum: {
          request: async ({ method, params }: { method: string; params?: any[] }) => {
            if (method === 'eth_chainId') return currentChain;
            if (method === 'wallet_switchEthereumChain') {
              requestedChainId = params?.[0]?.chainId;
              currentChain = requestedChainId || '0x14a34';
              return null;
            }
            throw new Error('Unexpected method ' + method);
          },
        },
      };

      const res = await ensureBaseNetwork('0x14a34');
      expect(res.success).toBe(true);
      expect(res.chainId).toBe(84532);
      expect(requestedChainId).toBe('0x14a34');
    });

    it('fails closed if wallet_switchEthereumChain succeeds but eth_chainId remains on old chain', async () => {
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
        ethereum: {
          request: async ({ method }: { method: string }) => {
            if (method === 'eth_chainId') return '0x1'; // never updates
            if (method === 'wallet_switchEthereumChain') return null;
            throw new Error('Unexpected method ' + method);
          },
        },
      };

      const res = await ensureBaseNetwork('0x14a34');
      expect(res.success).toBe(false);
      expect(res.error).toContain('NETWORK_MISMATCH');
    });

    it('falls back to wallet_addEthereumChain when wallet returns error 4902 and verifies new chain', async () => {
      let switchCalled = false;
      let addedChainConfig: any = null;
      let currentChain = '0x1';

      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
        ethereum: {
          request: async ({ method, params }: { method: string; params?: any[] }) => {
            if (method === 'eth_chainId') return currentChain;
            if (method === 'wallet_switchEthereumChain') {
              switchCalled = true;
              const err: any = new Error('Chain not recognized');
              err.code = 4902;
              throw err;
            }
            if (method === 'wallet_addEthereumChain') {
              addedChainConfig = params?.[0];
              currentChain = addedChainConfig?.chainId || '0x14a34';
              return null;
            }
            throw new Error('Unexpected method ' + method);
          },
        },
      };

      const res = await ensureBaseNetwork('0x14a34');
      expect(res.success).toBe(true);
      expect(res.chainId).toBe(84532);
      expect(switchCalled).toBe(true);
      expect(addedChainConfig).toBeDefined();
      expect(addedChainConfig.chainId).toBe('0x14a34');
      expect(addedChainConfig.chainName).toBe('Base Sepolia Testnet');
    });

    it('returns clean actionable user rejection error on error code 4001', async () => {
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
        ethereum: {
          request: async ({ method }: { method: string }) => {
            if (method === 'eth_chainId') return '0x1';
            if (method === 'wallet_switchEthereumChain') {
              const err: any = new Error('User rejected switch');
              err.code = 4001;
              throw err;
            }
            throw new Error('Unexpected method ' + method);
          },
        },
      };

      const res = await ensureBaseNetwork('0x14a34');
      expect(res.success).toBe(false);
      expect(res.error).toContain('USER_REJECTED');
      expect(res.error).toContain('Base Sepolia Testnet');
    });

    it('defaults to active environment chain when no argument is passed on testnet', async () => {
      let requestedChainId: string | null = null;
      let currentChain = '0x1';
      (globalThis as any).window = {
        location: { hostname: 'rtrader-testnet.vercel.app' },
        ethereum: {
          request: async ({ method, params }: { method: string; params?: any[] }) => {
            if (method === 'eth_chainId') return currentChain;
            if (method === 'wallet_switchEthereumChain') {
              requestedChainId = params?.[0]?.chainId;
              currentChain = requestedChainId || '0x14a34';
              return null;
            }
            throw new Error('Unexpected method ' + method);
          },
        },
      };

      const res = await ensureBaseNetwork();
      expect(res.success).toBe(true);
      expect(res.chainId).toBe(84532);
      expect(requestedChainId).toBe('0x14a34');
    });
  });

  describe('3. getExplorerUrl dynamic targeting', () => {
    it('produces Base Sepolia explorer link when target chain is 0x14a34', () => {
      const url = getExplorerUrl('0xabcdef123456', '0x14a34', 'tx');
      expect(url).toBe('https://sepolia.basescan.org/tx/0xabcdef123456');
    });

    it('produces Base Mainnet explorer link when target chain is 0x2105', () => {
      const url = getExplorerUrl('0xabcdef123456', '0x2105', 'tx');
      expect(url).toBe('https://basescan.org/tx/0xabcdef123456');
    });

    it('produces Robinhood explorer link when target chain is 0x1237', () => {
      const url = getExplorerUrl('0xabcdef123456', '0x1237', 'address');
      expect(url).toBe('https://robinhoodchain.blockscout.com/address/0xabcdef123456');
    });
  });
});