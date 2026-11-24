import './globals.css';
import HeaderNav from './components/HeaderNav';
import { AuthProvider } from './context/AuthContext';
import { LocaleProvider } from './context/LocaleContext';

export const metadata = {
  title: 'PoolNet | Autonomous Social Liquidity & Bonding Curve on Base',
  description: 'Fair-launch token launchpad with automated bonding curves, verified KOL deal rooms, and deterministic MEV risk gates on pndigi.site.',
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



