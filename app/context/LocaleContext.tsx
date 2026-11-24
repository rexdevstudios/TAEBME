'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  translateKey,
  type AppLocale,
} from '@packages/shared/i18n-dictionary';

export type { AppLocale };

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  toggleLocale: () => void;
  t: (key: string) => string;
  tr: (enText: string, idText: string) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key) => translateKey('en', key),
  tr: (enText) => enText,
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

  const t = (key: string) => translateKey(locale, key);
  const tr = (enText: string, idText: string) => (locale === 'id' ? idText : enText);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t, tr }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
