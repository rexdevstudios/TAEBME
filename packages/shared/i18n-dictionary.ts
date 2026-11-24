/**
 * packages/shared/i18n-dictionary.ts
 *
 * Pure, strictly symmetrical EN / ID dictionary for all 7 core POOLNET pages (Phase CR).
 * Tested for 100% key parity between 'en' and 'id' in Unit Suite #66.
 */

export type AppLocale = 'en' | 'id';

export const I18N_DICTIONARY: Record<AppLocale, Record<string, string>> = {
  en: {
    // Navbar
    'nav.overview': 'Overview',
    'nav.launchpad': 'Launchpad',
    'nav.trade': 'Trade',
    'nav.agent': 'AI Auto-Pilot',
    'nav.kol': 'Earn & KOL',
    'nav.prop': 'Prop Cup',
    'nav.leaderboard': 'Leaderboard',
    'nav.transparency': 'Transparency',
    'nav.account': 'Account',
    'nav.connect': 'Connect Wallet',
    'nav.connecting': 'Connecting...',
    'nav.switchLang': 'Switch language to Bahasa Indonesia',
    'nav.switchThemeLight': 'Switch to Light Mode',
    'nav.switchThemeDark': 'Switch to Dark Mode',

    // Overview (/)
    'home.welcome': 'Welcome back',
    'home.subtitle': 'Choose your workspace below — every feature is organized by category for fast, non-custodial execution.',
    'home.ctaLaunch': 'Launch / Explore Pools',
    'home.ctaTrade': 'Open Trade Terminal',

    // Transparency (/transparency)
    'transparency.title': 'Platform Transparency & Revenue',
    'transparency.subtitle': 'Open real-time audit of protocol fee flows, on-chain Treasury balance, Bounty Escrow, and POOLNET infrastructure health.',
    'transparency.feesHeading': 'Fees and revenue',
    'transparency.pipelineHeading': 'Treasury & Escrow Pipeline',

    // Launchpad (/launchpad)
    'launchpad.title': 'Token Launchpad & Live Bonding Pools',
    'launchpad.subtitle': 'Explore live token pools, launch new tokens with Bankr Fleet, or generate brand assets via AI Studio — verified by GoPlus Anti-Insider ($0).',
    'launchpad.ctaCreate': 'Launch New Token',
    'launchpad.ctaAngel': 'Angel Deal Room',
    'launchpad.tabPools': 'Live Pools',
    'launchpad.tabCreate': 'Launch Token & Bankr Fleet',
    'launchpad.tabStudio': 'AI Brand Studio',
    'launchpad.tabAdmin': 'Admin Governance',

    // Trading (/trading)
    'trading.title': 'Spot & DEX Trading Terminal',
    'trading.subtitle': '6-Chain 0x v2 DEX · Binance/Bybit Spot · GoPlus Anti-Honeypot Guard',
    'trading.tabTrade': 'Trade Terminal',
    'trading.tabHistory': 'History & Portfolio Recap',
    'trading.tabVault': 'API Vault & Risk Guard',

    // AI Desk (/agent)
    'agent.title': 'AI Auto-Pilot & 5-Agent Desk',
    'agent.subtitle': 'Live market, DEX liquidity, and sentiment analysis — 100% Non-Custodial with deterministic Risk Gate.',
    'agent.tabAutoPilot': 'Auto-Pilot 24/7 & Signals',
    'agent.tabAnalyst': '5-Agent Analyst Desk',
    'agent.tabPro': 'Pro Vault & Session',

    // KOL Hub (/kol)
    'kol.title': 'Earn, KOL Hub & Marketing Bounties',
    'kol.subtitle': 'Verify your social passport, complete token campaign quests, and claim on-chain rewards instantly.',
    'kol.ctaExplore': 'Explore Bounties',
    'kol.tabPassport': 'KOL Passport',
    'kol.tabMarket': 'Active Bounties',
    'kol.tabClaim': 'Submit & Claim',
    'kol.tabCreator': 'Creator Escrow',

    // Billing & Account (/billing)
    'billing.title': 'Plans, Credits & Account Settings',
    'billing.subtitle': 'Manage subscription tiers, quota add-ons, Telegram/Discord alert webhooks, and credit ledger audits in one place.',
    'billing.tabPlans': 'Plans & Pricing',
    'billing.tabVaults': 'Add-Ons, API & Telegram Alerts',
    'billing.tabHistory': 'Credit Ledger & Security',
    'billing.tabAdmin': 'Admin Ops Console',

    // Prop Trading Cup (/prop)
    'prop.title': 'POOLNET Trading Cup — Proof-of-Skill Challenge',
    'prop.subtitle': '100% non-custodial skill evaluation on $10,000 virtual equity with live market feeds. Pass to unlock Verified Trader status, +250 Credits, and Signal Marketplace.',
  },
  id: {
    // Navbar
    'nav.overview': 'Ringkasan',
    'nav.launchpad': 'Launchpad',
    'nav.trade': 'Trading',
    'nav.agent': 'AI Auto-Pilot',
    'nav.kol': 'Earn & KOL',
    'nav.prop': 'Prop Cup',
    'nav.leaderboard': 'Peringkat',
    'nav.transparency': 'Transparansi',
    'nav.account': 'Akun',
    'nav.connect': 'Hubungkan Dompet',
    'nav.connecting': 'Menghubungkan...',
    'nav.switchLang': 'Ganti bahasa ke English',
    'nav.switchThemeLight': 'Ganti ke Tema Terang',
    'nav.switchThemeDark': 'Ganti ke Tema Gelap',

    // Overview (/)
    'home.welcome': 'Selamat datang',
    'home.subtitle': 'Pilih ruang kerja Anda di bawah — seluruh fitur sudah dikelompokkan rapi berdasarkan kategori untuk eksekusi non-kustodial.',
    'home.ctaLaunch': 'Launch / Jelajahi Pool',
    'home.ctaTrade': 'Buka Terminal Trade',

    // Transparency (/transparency)
    'transparency.title': 'Transparansi Platform & Pendapatan',
    'transparency.subtitle': 'Audit terbuka alur fee protokol, saldo Treasury on-chain, Bounty Escrow, dan kesehatan infrastruktur POOLNET secara real-time.',
    'transparency.feesHeading': 'Fees and revenue',
    'transparency.pipelineHeading': 'Treasury & Escrow Pipeline',

    // Launchpad (/launchpad)
    'launchpad.title': 'Token Launchpad & Live Bonding Pools',
    'launchpad.subtitle': 'Jelajahi pool token aktif, luncurkan token baru dengan Bankr Fleet, atau bangun aset brand via AI Studio — terverifikasi GoPlus Anti-Insider ($0).',
    'launchpad.ctaCreate': 'Launch Token Baru',
    'launchpad.ctaAngel': 'Angel Deal Room',
    'launchpad.tabPools': 'Live Pools',
    'launchpad.tabCreate': 'Launch Token & Bankr Fleet',
    'launchpad.tabStudio': 'AI Brand Studio',
    'launchpad.tabAdmin': 'Admin Governance',

    // Trading (/trading)
    'trading.title': 'Terminal Trading Spot & DEX',
    'trading.subtitle': '6-Chain 0x v2 DEX · Binance/Bybit Spot · GoPlus Anti-Honeypot Guard',
    'trading.tabTrade': 'Terminal Trade',
    'trading.tabHistory': 'Riwayat & Portfolio Recap',
    'trading.tabVault': 'API Vault & Risk Guard',

    // AI Desk (/agent)
    'agent.title': 'AI Auto-Pilot & 5-Agent Desk',
    'agent.subtitle': 'Analisis peluang beli/jual berbasis data pasar live, likuiditas DEX, dan sentimen — 100% Non-Custodial dengan Risk Gate deterministik.',
    'agent.tabAutoPilot': 'Auto-Pilot 24/7 & Sinyal',
    'agent.tabAnalyst': '5-Agent Analyst Desk',
    'agent.tabPro': 'Pro Vault & Session',

    // KOL Hub (/kol)
    'kol.title': 'Earn, KOL Hub & Kampanye Bounty',
    'kol.subtitle': 'Verifikasi Passport sosial Anda, selesaikan misi kampanye token, dan klaim alokasi reward secara instan & on-chain.',
    'kol.ctaExplore': 'Jelajahi Bounties',
    'kol.tabPassport': 'KOL Passport',
    'kol.tabMarket': 'Active Bounties',
    'kol.tabClaim': 'Submit & Claim',
    'kol.tabCreator': 'Creator Escrow',

    // Billing & Account (/billing)
    'billing.title': 'Paket Layanan, Kredit & Pengaturan Akun',
    'billing.subtitle': 'Kelola paket langganan, Add-On kuota, Webhook Telegram/Discord, dan audit mutasi kredit dalam satu tempat yang rapi.',
    'billing.tabPlans': 'Paket & Harga',
    'billing.tabVaults': 'Add-On, API & Telegram Alert',
    'billing.tabHistory': 'Mutasi Kredit & Keamanan',
    'billing.tabAdmin': 'Admin Ops Console',

    // Prop Trading Cup (/prop)
    'prop.title': 'POOLNET Trading Cup — Tantangan Proof-of-Skill',
    'prop.subtitle': 'Evaluasi skill 100% non-kustodial di modal virtual $10.000 dengan harga pasar live. Lulus untuk membuka status Verified Trader, +250 Credits, & Signal Marketplace.',
  },
};

export function translateKey(locale: AppLocale, key: string): string {
  return I18N_DICTIONARY[locale]?.[key] || I18N_DICTIONARY.en[key] || key;
}
