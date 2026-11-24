'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

export type AppLocale = 'en' | 'id';

const DICTIONARY: Record<AppLocale, Record<string, string>> = {
  en: {
    'nav.overview': 'Overview',
    'nav.launchpad': 'Launchpad',
    'nav.trade': 'Trade',
    'nav.agent': 'AI Auto-Pilot',
    'nav.kol': 'Earn & KOL',
    'nav.transparency': 'Transparency',
    'nav.account': 'Account',
    'nav.connect': 'Connect Wallet',
    'nav.connecting': 'Connecting...',
    'nav.switchLang': 'Switch language to Bahasa Indonesia',
    'nav.switchThemeLight': 'Switch to Light Mode',
    'nav.switchThemeDark': 'Switch to Dark Mode',
    'transparency.title': 'Platform Transparency & Revenue',
    'transparency.subtitle': 'Open real-time audit of protocol fee flows, on-chain Treasury balance, Bounty Escrow, and POOLNET infrastructure health.',
    'transparency.feesHeading': 'Fees and revenue',
    'transparency.pipelineHeading': 'Treasury & Escrow Pipeline',
    'home.welcome': 'Welcome back',
    'home.subtitle': 'Choose your workspace below — every feature is organized by category for fast, non-custodial execution.',
    'home.ctaLaunch': 'Launch / Explore Pools',
    'home.ctaTrade': 'Open Trade Terminal',
  },
  id: {
    'nav.overview': 'Ringkasan',
    'nav.launchpad': 'Launchpad',
    'nav.trade': 'Trading',
    'nav.agent': 'AI Auto-Pilot',
    'nav.kol': 'Earn & KOL',
    'nav.transparency': 'Transparansi',
    'nav.account': 'Akun',
    'nav.connect': 'Hubungkan Dompet',
    'nav.connecting': 'Menghubungkan...',
    'nav.switchLang': 'Ganti bahasa ke English',
    'nav.switchThemeLight': 'Ganti ke Tema Terang',
    'nav.switchThemeDark': 'Ganti ke Tema Gelap',
    'transparency.title': 'Transparansi Platform & Pendapatan',
    'transparency.subtitle': 'Audit terbuka alur fee protokol, saldo Treasury on-chain, Bounty Escrow, dan kesehatan infrastruktur POOLNET secara real-time.',
    'transparency.feesHeading': 'Fees and revenue',
    'transparency.pipelineHeading': 'Treasury & Escrow Pipeline',
    'home.welcome': 'Selamat datang',
    'home.subtitle': 'Pilih ruang kerja Anda di bawah — seluruh fitur sudah dikelompokkan rapi berdasarkan kategori untuk eksekusi non-kustodial.',
    'home.ctaLaunch': 'Launch / Jelajahi Pool',
    'home.ctaTrade': 'Buka Terminal Trade',
  },
};

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  toggleLocale: () => void;
  t: (key: string) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key) => DICTIONARY.en[key] || key,
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>('en');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('poolnet_locale');
    if (saved === 'id' || saved === 'en') {
      setLocaleState(saved);
      document.documentElement.lang = saved;
    }
  }, []);

  const setLocale = (next: AppLocale) => {
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('poolnet_locale', next);
      document.documentElement.lang = next;
    }
  };

  const toggleLocale = () => {
    setLocale(locale === 'en' ? 'id' : 'en');
  };

  const t = (key: string) => DICTIONARY[locale][key] || DICTIONARY.en[key] || key;

  return (
    <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
