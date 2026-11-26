'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  resolveLocalizedText,
  translateKey,
  type AppLocale,
} from '@packages/shared/i18n-dictionary';

export type { AppLocale };

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (next: AppLocale) => void;
  toggleLocale: () => void;
  t: (key: string) => string;
  tr: (enText: string, idText: string, cnText?: string) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key) => translateKey('en', key),
  tr: (enText) => enText,
});

function toHtmlLang(loc: AppLocale): string {
  return loc === 'cn' ? 'zh-CN' : loc;
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>('en');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('poolnet_locale');
    if (saved === 'id' || saved === 'en' || saved === 'cn') {
      setLocaleState(saved);
      document.documentElement.lang = toHtmlLang(saved);
    }
  }, []);

  const setLocale = (next: AppLocale) => {
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('poolnet_locale', next);
      document.documentElement.lang = toHtmlLang(next);
    }
  };

  const toggleLocale = () => {
    const next: AppLocale = locale === 'en' ? 'id' : locale === 'id' ? 'cn' : 'en';
    setLocale(next);
  };

  const t = (key: string) => translateKey(locale, key);
  const tr = (enText: string, idText: string, cnText?: string) =>
    resolveLocalizedText(locale, enText, idText, cnText);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t, tr }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
