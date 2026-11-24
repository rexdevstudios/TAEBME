import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'POOLNET — Free-Mint Genesis Pioneer SBT & AI Multi-Rail Trading on Base';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '56px 64px',
          backgroundColor: '#0B1220',
          color: '#F8FAFC',
          fontFamily: 'sans-serif',
          border: '2px solid #1E293B',
        }}
      >
        {/* Top Brand Row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '16px',
                height: '16px',
                borderRadius: '999px',
                backgroundColor: '#10B981',
              }}
            />
            <span style={{ fontSize: '30px', fontWeight: 900, letterSpacing: '0.08em' }}>
              POOLNET
            </span>
          </div>
          <div
            style={{
              padding: '8px 18px',
              borderRadius: '999px',
              backgroundColor: '#064E3B',
              border: '1px solid #10B981',
              color: '#10B981',
              fontSize: '18px',
              fontWeight: 800,
              letterSpacing: '0.06em',
            }}
          >
            BASE L2 · 100% NON-CUSTODIAL
          </div>
        </div>

        {/* Center Hero */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div
            style={{
              fontSize: '56px',
              fontWeight: 900,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: '#F8FAFC',
            }}
          >
            Free-Mint Genesis Pioneer SBT
          </div>
          <div
            style={{
              fontSize: '26px',
              fontWeight: 500,
              lineHeight: 1.4,
              color: '#9CA3AF',
              maxWidth: '940px',
            }}
          >
            AI Multi-Rail Trading (0x v2 · Bankr · Binance · Bybit), Fair-Launch Bonding Curve,
            GoPlus Anti-Honeypot Guard, and Proof-of-Skill Prop Cup.
          </div>
        </div>

        {/* Bottom Stats Strip */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: '24px',
            borderTop: '1px solid #1E293B',
          }}
        >
          <div style={{ display: 'flex', gap: '40px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '15px', color: '#9CA3AF', fontWeight: 700 }}>SUPPLY CAP</span>
              <span style={{ fontSize: '28px', color: '#F8FAFC', fontWeight: 900 }}>10,000 SBT</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '15px', color: '#9CA3AF', fontWeight: 700 }}>WELCOME BONUS</span>
              <span style={{ fontSize: '28px', color: '#10B981', fontWeight: 900 }}>+200 CREDITS</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '15px', color: '#9CA3AF', fontWeight: 700 }}>REFERRAL REWARD</span>
              <span style={{ fontSize: '28px', color: '#F59E0B', fontWeight: 900 }}>+50 CR / INVITE</span>
            </div>
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#9CA3AF' }}>
            pndigi.site
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
