---
name: mobile-first-dapp-pwa
description: Mobile UX standards, bottom navigation sheets, tactile Web3 wallet connection, viewport safe area padding, and responsive touch mechanics for mobile dApps.
---

# Mobile-First dApp & PWA Skill

Over 70% of Web3 token launches and social browsing happen directly on mobile (via MetaMask Mobile, Rainbow, Coinbase Wallet, or Telegram in-app browsers).

## 1. Mobile Invariants for PoolNet / PoolTrader
1. **Viewport & Safe Area:** Always respect iOS safe areas (nv(safe-area-inset-bottom) and nv(safe-area-inset-top)).
2. **Bottom Sheet Trading Drawer:** On screens < 768px, swap complex trading modals with sliding bottom drawers for easy one-thumb buy/sell actions.
3. **Touch Target Size:** Interactive elements (Connect button, Slippage pill, Token chips) must have a minimum hit area of 44x44px.
4. **No Horizontal Layout Breaking:** Ensure tables and token ticker lists scroll smoothly or collapse into cards on mobile viewports.
