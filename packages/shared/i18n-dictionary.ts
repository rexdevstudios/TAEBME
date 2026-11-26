/**
 * packages/shared/i18n-dictionary.ts
 *
 * Pure, strictly symmetrical EN / ID / CN (中文) dictionary for all core POOLNET pages (Phase CR + Phase ET).
 * Tested for 100% 3-way key parity across 'en', 'id', and 'cn'.
 */

export type AppLocale = 'en' | 'id' | 'cn';

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
    'nav.switchLang': 'Switch language (EN / ID / CN)',
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
    'nav.switchLang': 'Ganti bahasa (EN / ID / CN)',
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
    'transparency.feesHeading': 'Biaya & Pendapatan Protokol',
    'transparency.pipelineHeading': 'Alur Treasury & Escrow',

    // Launchpad (/launchpad)
    'launchpad.title': 'Token Launchpad & Live Bonding Pools',
    'launchpad.subtitle': 'Jelajahi pool token aktif, luncurkan token baru dengan Bankr Fleet, atau bangun aset brand via AI Studio — terverifikasi GoPlus Anti-Insider ($0).',
    'launchpad.ctaCreate': 'Launch Token Baru',
    'launchpad.ctaAngel': 'Ruang Angel Deal',
    'launchpad.tabPools': 'Pool Aktif',
    'launchpad.tabCreate': 'Launch Token & Bankr Fleet',
    'launchpad.tabStudio': 'AI Brand Studio',
    'launchpad.tabAdmin': 'Tata Kelola Admin',

    // Trading (/trading)
    'trading.title': 'Terminal Trading Spot & DEX',
    'trading.subtitle': '6-Chain 0x v2 DEX · Binance/Bybit Spot · GoPlus Anti-Honeypot Guard',
    'trading.tabTrade': 'Terminal Trade',
    'trading.tabHistory': 'Riwayat & Rekap Portofolio',
    'trading.tabVault': 'Vault API & Risk Guard',

    // AI Desk (/agent)
    'agent.title': 'AI Auto-Pilot & 5-Agent Desk',
    'agent.subtitle': 'Analisis peluang beli/jual berbasis data pasar live, likuiditas DEX, dan sentimen — 100% Non-Custodial dengan Risk Gate deterministik.',
    'agent.tabAutoPilot': 'Auto-Pilot 24/7 & Sinyal',
    'agent.tabAnalyst': 'Meja Analis 5-Agen',
    'agent.tabPro': 'Pro Vault & Sesi',

    // KOL Hub (/kol)
    'kol.title': 'Earn, KOL Hub & Kampanye Bounty',
    'kol.subtitle': 'Verifikasi Passport sosial Anda, selesaikan misi kampanye token, dan klaim alokasi reward secara instan & on-chain.',
    'kol.ctaExplore': 'Jelajahi Bounties',
    'kol.tabPassport': 'KOL Passport',
    'kol.tabMarket': 'Bounty Aktif',
    'kol.tabClaim': 'Kirim & Klaim',
    'kol.tabCreator': 'Escrow Kreator',

    // Billing & Account (/billing)
    'billing.title': 'Paket Layanan, Kredit & Pengaturan Akun',
    'billing.subtitle': 'Kelola paket langganan, Add-On kuota, Webhook Telegram/Discord, dan audit mutasi kredit dalam satu tempat yang rapi.',
    'billing.tabPlans': 'Paket & Harga',
    'billing.tabVaults': 'Add-On, API & Alert Telegram',
    'billing.tabHistory': 'Mutasi Kredit & Keamanan',
    'billing.tabAdmin': 'Konsol Admin Ops',

    // Prop Trading Cup (/prop)
    'prop.title': 'POOLNET Trading Cup — Tantangan Proof-of-Skill',
    'prop.subtitle': 'Evaluasi skill 100% non-kustodial di modal virtual $10.000 dengan harga pasar live. Lulus untuk membuka status Verified Trader, +250 Credits, & Signal Marketplace.',
  },
  cn: {
    // Navbar
    'nav.overview': '总览',
    'nav.launchpad': '发射台',
    'nav.trade': '交易',
    'nav.agent': 'AI 自动交易',
    'nav.kol': 'KOL 悬赏',
    'nav.prop': '交易挑战赛',
    'nav.leaderboard': '排行榜',
    'nav.transparency': '透明审计',
    'nav.account': '账户',
    'nav.connect': '连接钱包',
    'nav.connecting': '连接中...',
    'nav.switchLang': '切换语言 (EN / ID / 中文)',
    'nav.switchThemeLight': '切换至浅色模式',
    'nav.switchThemeDark': '切换至深色模式',

    // Overview (/)
    'home.welcome': '欢迎回来',
    'home.subtitle': '在下方选择工作区 — 所有功能已按类别整理，支持快速非托管执行。',
    'home.ctaLaunch': '发行 / 探索资金池',
    'home.ctaTrade': '打开交易终端',

    // Transparency (/transparency)
    'transparency.title': '平台透明审计与收益',
    'transparency.subtitle': '实时公开审计协议费用流向、链上金库余额、悬赏托管及 POOLNET 基础设施健康状态。',
    'transparency.feesHeading': '协议费用与收益',
    'transparency.pipelineHeading': '金库与托管流水线',

    // Launchpad (/launchpad)
    'launchpad.title': '代币发射台与实时联合曲线池',
    'launchpad.subtitle': '探索活跃代币池、使用 Bankr 车队一键发币，或通过 AI 工作室生成品牌素材 — GoPlus 免费安全检测。',
    'launchpad.ctaCreate': '发行新代币',
    'launchpad.ctaAngel': '天使轮专区',
    'launchpad.tabPools': '活跃代币池',
    'launchpad.tabCreate': '发币与 Bankr 车队',
    'launchpad.tabStudio': 'AI 品牌工作室',
    'launchpad.tabAdmin': '管理员治理',

    // Trading (/trading)
    'trading.title': '现货与 DEX 交易终端',
    'trading.subtitle': '6 链 0x v2 DEX · 币安/Bybit 现货 · GoPlus 防貔貅护盾',
    'trading.tabTrade': '交易终端',
    'trading.tabHistory': '历史记录与收益复盘',
    'trading.tabVault': 'API 金库与风控',

    // AI Desk (/agent)
    'agent.title': 'AI 自动交易与五智能体分析台',
    'agent.subtitle': '实时行情、DEX 流动性与情绪分析 — 100% 非托管并由确定性风控网关护航。',
    'agent.tabAutoPilot': '24/7 自动交易与信号',
    'agent.tabAnalyst': '五智能体分析台',
    'agent.tabPro': '专业金库与会话授权',

    // KOL Hub (/kol)
    'kol.title': '赚取收益、KOL 中心与营销悬赏',
    'kol.subtitle': '验证社交护照、完成代币推广任务，并即时在链上领取激励奖励。',
    'kol.ctaExplore': '探索悬赏',
    'kol.tabPassport': 'KOL 护照',
    'kol.tabMarket': '进行中悬赏',
    'kol.tabClaim': '提交与领奖',
    'kol.tabCreator': '项目方托管',

    // Billing & Account (/billing)
    'billing.title': '套餐、积分与账户设置',
    'billing.subtitle': '一站式管理订阅套餐、配额扩展包、Telegram/Discord 预警 Webhook 及积分账本审计。',
    'billing.tabPlans': '套餐与价格',
    'billing.tabVaults': '扩展包、API 与推送',
    'billing.tabHistory': '积分账本与安全日志',
    'billing.tabAdmin': '管理员运维台',

    // Prop Trading Cup (/prop)
    'prop.title': 'POOLNET 交易杯 — 实力证明挑战赛',
    'prop.subtitle': '使用 $10,000 模拟资金与实时行情进行 100% 非托管交易考核，通过即可解锁认证交易员身份、+250 积分与信号市场。',
  },
};

/**
 * Common inline English -> Simplified Chinese phrase map so existing 2-argument `tr(en, id)`
 * calls across 30+ components automatically render natural Chinese when `locale === 'cn'`.
 */
export const INLINE_CN_PHRASES: Record<string, string> = {
  'Core': '核心',
  'Earn & Social': '收益与社区',
  'Trust & Account': '信任与账户',
  'Collapse sidebar': '收起侧边栏',
  'Pin sidebar open': '固定侧边栏',
  'Open Launchpad →': '打开发射台 →',
  'Start Trading →': '开始交易 →',
  'Configure AI Bot →': '配置 AI 机器人 →',
  'View Campaigns →': '查看活动 →',
  'Trade Ticket (Buy / Sell)': '下单面板 (买入 / 卖出)',
  'Sim ($10K)': '模拟 ($10K)',
  'DEX (Wallet)': 'DEX (钱包)',
  'CEX Spot': 'CEX 现货',
  'Virtual Balance': '模拟余额',
  'Reset $10K': '重置 $10K',
  'Wallet Balance': '钱包余额',
  'Signed in MetaMask': '通过 MetaMask 签名',
  'CEX Vault': 'CEX 金库',
  'Manage API Keys →': '管理 API 密钥 →',
  'Quick Qty:': '快捷数量:',
  'Ask AI Copilot →': '询问 AI 助手 →',
  'Launchpad →': '发射台 →',
  'Plans & Vault →': '套餐与金库 →',
  'Trade Terminal →': '交易终端 →',
  'Live Pools & Deploy →': '活跃池与发币 →',
  'Pinned': '已置顶',
  'Pin': '置顶',
  'Show': '展开',
  'Hide': '收起',
  'Switching...': '切换中...',
  'No active market risk alerts for this pair.': '当前交易对暂无活跃市场风险预警。',
  'Trading Terminal & Risk Gate Flow': '交易终端与风控网关流程',
  'KOL & SocialFi Bounty Flow': 'KOL 与 SocialFi 悬赏流程',
};

export function translateKey(locale: AppLocale, key: string): string {
  return I18N_DICTIONARY[locale]?.[key] || I18N_DICTIONARY.en[key] || key;
}

export function resolveLocalizedText(
  locale: AppLocale,
  enText: string,
  idText: string,
  cnText?: string
): string {
  if (locale === 'id') return idText;
  if (locale === 'cn') {
    if (cnText && cnText.trim().length > 0) return cnText;
    return INLINE_CN_PHRASES[enText] || enText;
  }
  return enText;
}
