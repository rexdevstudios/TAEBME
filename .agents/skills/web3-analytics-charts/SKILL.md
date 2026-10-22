---
name: web3-analytics-charts
description: Interactive lightweight charting, candlestick financial charts, bonding curve progression SVG visualizations, and real-time market depth UI for token trading terminals.
---

# Web3 Analytics & Financial Charts Skill

This skill guides the design and implementation of trading charts, bonding curve depth visualizers, and financial metrics in Next.js/React.

## 1. Charting Engine Selection
- **TradingView Lightweight Charts:** The gold standard for token price action (/token/[chain]/[address] and /trading). Zero layout thrashing, hardware-accelerated canvas.
- **SVG / Canvas Bonding Curve:** Custom reactive SVG rendering for the token launch progress bar showing current price step vs target graduation threshold.

## 2. Best Practices for Crypto Data Visuals
- Use standard crypto colors: Bullish Neon Green (#00e676) and Bearish Crimson (#ff1744).
- Format high-precision decimals gracefully: Use subscript zeros (e.g. $0.0000042 $\rightarrow$ $0.0{5}42) to prevent UI overflow on micro-cap meme tokens.
- Keep chart tooltips responsive and accessible with keyboard navigation.
