'use client';

import React from 'react';
import Link from 'next/link';
import { AlertTriangle, FileText, Lock, Scale, ShieldCheck } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export default function TermsAndAgreementPage() {
  const { tr } = useLocale();

  const sections = [
    {
      num: '01',
      title: tr('Acceptance of Terms & Eligibility', 'Penerimaan Ketentuan & Kelayakan Pengguna'),
      body: tr(
        'By connecting a Web3 wallet (SIWE), accessing pndigi.site, or interacting with POOLNET smart contracts, APIs, or Telegram bots (@Moonshiller_bot), you confirm that you are at least 18 years old, have full legal capacity, and are not located in, or acting on behalf of, any jurisdiction or wallet address subject to OFAC or international sanctions. Automated on-chain sanctions screening may block restricted wallets at any time.',
        'Dengan menghubungkan dompet Web3 (SIWE), mengakses pndigi.site, atau menggunakan smart contract, API, maupun bot Telegram POOLNET (@Moonshiller_bot), Anda menyatakan berusia minimal 18 tahun, cakap hukum, serta tidak berada di yurisdiksi atau menggunakan alamat dompet yang terkena sanksi OFAC/internasional. Sistem penyaringan sanksi on-chain otomatis berhak memblokir dompet terbatas kapan saja.'
      ),
    },
    {
      num: '02',
      title: tr('100% Non-Custodial Software Interface', 'Antarmuka Perangkat Lunak 100% Non-Custodial'),
      body: tr(
        'POOLNET is strictly a non-custodial software and analytics interface. POOLNET NEVER stores private keys, seed phrases, or custodies user funds on Vercel servers or in PostgreSQL databases. All on-chain DEX swaps (0x v2), bonding-curve interactions, and token deployments require explicit user wallet signing or user-controlled BYOK API credentials (encrypted via AES-256-GCM with No-Withdrawal restrictions). You remain 100% responsible for safeguarding your wallets and API keys.',
        'POOLNET murni merupakan antarmuka perangkat lunak dan analitik non-custodial. POOLNET TIDAK PERNAH menyimpan private key, seed phrase, atau menahan dana pengguna di server Vercel maupun database PostgreSQL. Seluruh transaksi DEX (0x v2), bonding curve, dan peluncuran token memerlukan tanda tangan dompet pengguna secara langsung atau API Key BYOK milik pengguna (terenkripsi AES-256-GCM tanpa izin penarikan/withdrawal). Anda bertanggung jawab penuh atas keamanan dompet dan API Key Anda.'
      ),
    },
    {
      num: '03',
      title: tr('No Financial, Investment, Legal, or Tax Advice (AI Advisory-Only)', 'Bukan Nasihat Keuangan, Investasi, Hukum, atau Pajak (AI Bersifat Advisory)'),
      body: tr(
        'All AI Auto-Pilot proposals, 5-Agent Trading Desk outputs, GoPlus security scans, Firecrawl research summaries, and Signal Marketplace presets are strictly informational and advisory. Nothing on POOLNET constitutes financial advice, an offer to sell, or a solicitation to buy any digital asset or security. You bear sole responsibility for evaluating every trade and tax obligation in your jurisdiction.',
        'Seluruh proposal AI Auto-Pilot, analisis 5-Agent Trading Desk, hasil scan GoPlus, ringkasan riset Firecrawl, dan preset Signal Marketplace murni bersifat informasional dan advisory. Tidak ada konten di POOLNET yang merupakan nasihat keuangan, penawaran jual, atau ajakan membeli aset digital/sekuritas. Anda bertanggung jawab penuh atas setiap keputusan trading dan kewajiban pajak di yurisdiksi Anda.'
      ),
    },
    {
      num: '04',
      title: tr('High-Risk Digital Asset, Smart Contract & Third-Party Disclosure', 'Pengungkapan Risiko Tinggi Aset Digital, Smart Contract & Pihak Ketiga'),
      body: tr(
        'Digital assets and bonding-curve tokens carry extreme volatility and risk of total capital loss. Blockchain transactions are irreversible once confirmed. POOLNET integrates third-party rails (including Base L2, 0x v2, Bankr API, Binance, Bybit, GoPlus, and dRPC) and cannot guarantee uninterrupted uptime, zero slippage, or protection against third-party protocol exploits.',
        'Aset digital dan token bonding curve memiliki volatilitas ekstrem serta risiko kehilangan modal seluruhnya. Transaksi blockchain bersifat permanen dan tidak dapat dibatalkan setelah terkonfirmasi. POOLNET terintegrasi dengan layanan pihak ketiga (Base L2, 0x v2, Bankr API, Binance, Bybit, GoPlus, dRPC) dan tidak menjamin uptime tanpa henti, bebas slippage, atau bebas dari celah protokol pihak ketiga.'
      ),
    },
    {
      num: '05',
      title: tr('Transparent Protocol Fees & Finality of On-Chain Settlement', 'Transparansi Biaya Protokol & Finalitas Pembayaran On-Chain'),
      body: tr(
        'Protocol fees are published transparently at /transparency (including 0.50% DEX/Launchpad swap fee, 0.00018 ETH Base protocol mint fee for Free-Mint Genesis SBT, 0.005/0.012 ETH Launchpad Featured Boost, 0.005 ETH or 100 Credits Prop Cup entry, and 80/20 Signal Marketplace revenue split). All confirmed on-chain ETH payments verified to the platform treasury are final and non-refundable.',
        'Biaya protokol dipublikasikan secara transparan di /transparency (termasuk biaya swap DEX/Launchpad 0,50%, biaya protokol Base 0,00018 ETH untuk Free-Mint Genesis SBT, Featured Boost 0,005/0,012 ETH, entry Prop Cup 0,005 ETH atau 100 Credits, serta bagi hasil Signal Marketplace 80/20). Seluruh pembayaran ETH on-chain yang telah terkonfirmasi ke treasury bersifat final dan tidak dapat dikembalikan.'
      ),
    },
    {
      num: '06',
      title: tr('Genesis Pioneer SBT (Non-Transferable Utility Pass — Not a Security)', 'Genesis Pioneer SBT (Kartu Utilitas Non-Transferable — Bukan Sekuritas)'),
      body: tr(
        'The Genesis Pioneer SBT (capped at 10,000) is a non-transferable, soulbound utility badge granting platform credits (+200 Welcome Credits, +50 Referral Bonus Credits) and priority ecosystem access. It does not represent equity, ownership, debt, profit-sharing rights, or an investment contract.',
        'Genesis Pioneer SBT (maksimal 10.000 unit) adalah lencana utilitas soulbound yang tidak dapat dipindahtangankan, memberikan kredit platform (+200 Welcome Credits, +50 Referral Bonus Credits) serta akses prioritas ekosistem. SBT ini bukan merupakan saham, kepemilikan, utang, hak bagi hasil, ataupun kontrak investasi.'
      ),
    },
    {
      num: '07',
      title: tr('Proof-of-Skill Prop Trading Cup (Simulated Virtual Equity)', 'Prop Trading Cup Proof-of-Skill (Ekuitas Virtual Simulasi)'),
      body: tr(
        'The POOLNET Prop Trading Cup evaluates trader performance strictly using simulated virtual paper equity ($10,000 virtual baseline) against deterministic rules (+8% profit target, 5% max daily loss, 10% max drawdown, min 3 trading days). It is a skill evaluation program awarding platform credits and badges — not a regulated brokerage, managed fund, or deposit-taking service.',
        'POOLNET Prop Trading Cup menilai performa trader secara eksklusif menggunakan ekuitas simulasi virtual ($10.000 paper equity) berdasarkan aturan deterministik (target profit +8%, batas rugi harian 5%, drawdown maks 10%, min 3 hari trading). Program ini adalah evaluasi keahlian berhadiah kredit & lencana platform — bukan broker teregulasi, pengelola dana, maupun penghimpunan simpanan.'
      ),
    },
    {
      num: '08',
      title: tr('Prohibited Conduct, Anti-Abuse & Emergency Kill-Switch', 'Tindakan Terlarang, Anti-Penyalahgunaan & Emergency Kill-Switch'),
      body: tr(
        'Users are strictly prohibited from sybil farming, self-referral abuse, txHash spoofing/replay, SSRF/injection attacks, market manipulation, or launching malicious honeypot tokens. POOLNET enforces deterministic Risk Gates, global txHash anti-replay, and reserves the right to activate emergency Kill-Switches or suspend abusive accounts without prior notice to protect ecosystem integrity.',
        'Pengguna dilarang keras melakukan sybil farming, manipulasi self-referral, spoofing/replay txHash, serangan SSRF/injeksi, manipulasi pasar, atau meluncurkan token honeypot berbahaya. POOLNET menerapkan Risk Gate deterministik, anti-replay txHash global, dan berhak mengaktifkan Emergency Kill-Switch atau membekukan akun bermasalah tanpa pemberitahuan sebelumnya demi melindungi integritas ekosistem.'
      ),
    },
    {
      num: '09',
      title: tr('Privacy, Public Blockchain Data & Encrypted BYOK Storage', 'Privasi, Data Blockchain Publik & Penyimpanan BYOK Terenkripsi'),
      body: tr(
        'Wallet addresses, transaction hashes, and leaderboard rankings are public by design on blockchain networks and transparency dashboards. User-submitted API keys (Bankr, Binance, Bybit, LLM) are encrypted at rest using AES-256-GCM and may be deleted by the user at any time from the vault panel.',
        'Alamat dompet, hash transaksi, dan peringkat leaderboard bersifat publik sesuai sifat jaringan blockchain dan dasbor transparansi. API Key milik pengguna (Bankr, Binance, Bybit, LLM) dienkripsi saat disimpan menggunakan AES-256-GCM dan dapat dihapus sendiri oleh pengguna kapan saja melalui panel vault.'
      ),
    },
    {
      num: '10',
      title: tr('Disclaimer of Warranties & Limitation of Liability (AS-IS)', 'Penafian Jaminan & Pembatasan Tanggung Jawab (AS-IS)'),
      body: tr(
        'POOLNET IS PROVIDED STRICTLY ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, POOLNET CONTRIBUTORS AND OPERATORS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR TRADING LOSSES ARISING FROM YOUR USE OF THE INTERFACE, SMART CONTRACTS, OR THIRD-PARTY INTEGRATIONS.',
        'POOLNET DISEDIAKAN SEBAGAIMANA ADANYA ("AS IS") DAN SEBAGAIMANA TERSEDIA ("AS AVAILABLE") TANPA JAMINAN APA PUN, BAIK TERSURAT MAUPUN TERSIRAT. SEJAUH DIIZINKAN OLEH HUKUM YANG BERLAKU, PENGEMBANG DAN OPERATOR POOLNET TIDAK BERTANGGUNG JAWAB ATAS KERUGIAN TIDAK LANGSUNG, INSIDENTAL, KHUSUS, KONSEKUENSIAL, ATAU KERUGIAN TRADING AKIBAT PENGGUNAAN ANTARMUKA, SMART CONTRACT, ATAU INTEGRASI PIHAK KETIGA.'
      ),
    },
  ];

  return (
    <div className="container flex-col gap-lg" style={{ paddingTop: '24px', paddingBottom: '64px', maxWidth: '920px' }}>
      {/* Header */}
      <div className="bg-panel" style={{ border: '1px solid var(--color-border)', borderRadius: '10px', padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 900, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Scale size={20} style={{ color: 'var(--color-accent-info)' }} />
            {tr('Terms of Service, User Agreement & Risk Disclosure', 'Syarat & Ketentuan, Perjanjian Pengguna & Pengungkapan Risiko')}
          </h1>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              fontWeight: 800,
              padding: '3px 9px',
              borderRadius: '4px',
              backgroundColor: 'rgba(16, 185, 129, 0.14)',
              color: 'var(--color-text-positive)',
              border: '1px solid rgba(16, 185, 129, 0.35)',
            }}
          >
            EFFECTIVE: 2026-11-25 · v1.0
          </span>
        </div>
        <p className="text-muted" style={{ margin: 0, fontSize: '13px', lineHeight: 1.6 }}>
          {tr(
            'Please read these Terms & Risk Disclosures carefully before connecting your wallet or executing any action on POOLNET (pndigi.site). This agreement governs your non-custodial use of our trading terminal, launchpad, AI agents, Genesis SBT, and Prop Trading Cup.',
            'Harap baca Syarat & Pengungkapan Risiko ini dengan saksama sebelum menghubungkan dompet atau mengeksekusi transaksi apa pun di POOLNET (pndigi.site). Perjanjian ini mengatur penggunaan non-custodial atas terminal trading, launchpad, AI agent, Genesis SBT, dan Prop Trading Cup.'
          )}
        </p>

        <div
          style={{
            marginTop: '14px',
            padding: '12px 14px',
            borderRadius: '8px',
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            color: 'var(--color-accent-amber)',
            fontSize: '12px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>
            {tr(
              'RISK WARNING: Crypto trading and token launches involve substantial risk of loss. POOLNET is a 100% non-custodial software interface and provides zero financial advice or profit guarantees.',
              'PERINGATAN RISIKO: Trading kripto dan peluncuran token mengandung risiko kerugian besar. POOLNET adalah antarmuka perangkat lunak 100% non-custodial dan tidak memberikan nasihat keuangan atau jaminan keuntungan.'
            )}
          </span>
        </div>
      </div>

      {/* Clauses */}
      <div className="flex-col gap-md">
        {sections.map((sec) => (
          <section
            key={sec.num}
            className="bg-panel"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: '10px',
              padding: '18px 20px',
            }}
          >
            <h2
              style={{
                margin: '0 0 8px 0',
                fontSize: '14px',
                fontWeight: 800,
                color: 'var(--color-foreground)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-accent-info)', fontSize: '12px' }}>
                {sec.num}.
              </span>
              {sec.title}
            </h2>
            <p className="text-muted" style={{ margin: 0, fontSize: '13px', lineHeight: 1.65 }}>
              {sec.body}
            </p>
          </section>
        ))}
      </div>

      {/* Bottom Verification Links */}
      <div
        className="bg-panel"
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: '10px',
          padding: '16px 20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          fontSize: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', color: 'var(--color-muted)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontWeight: 700, color: 'var(--color-foreground)' }}>
            <ShieldCheck size={14} style={{ color: 'var(--color-text-positive)' }} /> 100% Non-Custodial
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <Lock size={13} /> AES-256-GCM BYOK Vault
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <FileText size={13} /> Live Fee Proof
          </span>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Link href="/transparency" className="btn-secondary" style={{ fontSize: '11px', padding: '6px 12px', textDecoration: 'none' }}>
            {tr('Platform Transparency', 'Transparansi Platform')}
          </Link>
          <Link href="/" className="btn-primary" style={{ fontSize: '11px', padding: '6px 12px', textDecoration: 'none' }}>
            {tr('Back to POOLNET', 'Kembali ke POOLNET')}
          </Link>
        </div>
      </div>
    </div>
  );
}
