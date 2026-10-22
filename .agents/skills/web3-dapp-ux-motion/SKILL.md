---
name: web3-dapp-ux-motion
description: Modern Web3 dApp design intelligence, tactile feedback, glassmorphism, micro-animations, bonding curve interactive visualizations, and conversion-focused terminal UI/UX for crypto launchpads.
---

# Web3 dApp UX & Motion Design Skill

This skill guides the design, visual hierarchy, micro-interactions, and aesthetics of high-conversion Web3 SocialFi & Trading terminals (like Uniswap, Raydium, Pump.fun, and Hyperliquid).

## 1. Visual Anti-Patterns (Avoid Monotonous / Flat UI)
1. **Never use flat, washed-out grey containers:** Replace flat borders with subtle frosted glass (ackdrop-blur-md bg-neutral-900/60 border border-neutral-800/80 hover:border-neutral-700/80).
2. **Avoid static buttons without feedback:** All CTAs must provide tactile responses:
   - Hover glow effects (shadow-[0_0_20px_rgba(59,130,246,0.3)]).
   - Active press state (ctive:scale-[0.98] transition-all duration-150).
   - Loading skeleton shimmer rather than abrupt empty spinners.
3. **Avoid raw text dumps for data:** Convert metrics (FDV, Market Cap, Bonding Progress) into visual progress rings, animated counters, or pill badges.

## 2. Bonding Curve & Deal Room UX
1. **Interactive Curve Visualizer:**
   - Display a dynamic progress bar or SVG curve showing where the token currently sits between creation (0%) and graduation to Uniswap (100%).
   - Color grading: Gradual transition from Neon Emerald (#10b981) to Cyber Cyan (#06b6d4).
2. **KOL & Social Badges:**
   - Render verified social badges (Twitter checkmark, Farcaster purple ring, Lens green border) with subtle pulse animation to signal on-chain authenticity.
3. **Live Transaction Ticker:**
   - Feed recent buys/sells as floating chips that slide into view with soundless green/red micro-flashes.

## 3. Dark Theme Color Palette for PoolNet / PoolTrader
- **Background Core:** Deep Obsidian (#0a0b0e) with ambient radial blur gradient.
- **Surface Elevation:** Translucent Charcoal (#12141a) with order-white/[0.08].
- **Primary Brand (Base Accent):** Vivid Base Blue (#0052ff) & Electric Cyan (#00f0ff).
- **Success / Profit:** Emerald Neon (#00e676).
- **Danger / Slippage:** Crimson Coral (#ff1744).
- **Typography:** Inter or Geist Sans for UI readability; JetBrains Mono or SF Mono for addresses, tx hashes, and token prices.
