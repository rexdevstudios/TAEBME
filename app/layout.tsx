import type { Metadata } from 'next';
import './globals.css';
import HeaderNav from './components/HeaderNav';
import { AuthProvider } from './context/AuthContext';
import { LocaleProvider } from './context/LocaleContext';

export const metadata: Metadata = {
  metadataBase: new URL('https://pndigi.site'),
  title: 'POOLNET | AI Multi-Rail Trading & SocialFi Launchpad on Base',
  description:
    'Claim your Free-Mint Genesis Pioneer SBT (10,000 cap, +200 Welcome Credits). Fair-launch bonding curves, 0x v2 + Bankr + Binance multi-rail AI execution, and GoPlus anti-honeypot guards on pndigi.site.',
  openGraph: {
    type: 'website',
    siteName: 'POOLNET',
    url: 'https://pndigi.site',
    title: 'POOLNET | Free-Mint Genesis Pioneer SBT & AI Trading on Base',
    description:
      'Claim your Free-Mint Genesis Pioneer SBT (+200 Credits & +50 cr/invite). 100% Non-Custodial AI Trading, Bonding Curve Launchpad, and Prop Trading Cup.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'POOLNET | Free-Mint Genesis Pioneer SBT (10,000 Cap)',
    description:
      '100% Non-Custodial AI Multi-Rail Trading & Fair-Launch Launchpad on Base. Claim your Genesis SBT free (+200 Welcome Credits).',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <LocaleProvider>
          <AuthProvider>
            <HeaderNav />
            <main>
              {children}
            </main>
          </AuthProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}



