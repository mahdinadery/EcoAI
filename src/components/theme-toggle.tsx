"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type ThemeMode = "light" | "system" | "dark";

const STORAGE_KEY = "nia-theme";

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // private mode / storage blocked — fall back to system
  }
  return "system";
}

function applyTheme(mode: ThemeMode) {
  const dark =
    mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

const sunIcon = (
  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" strokeLinecap="round" />
  </svg>
);

const moonIcon = (
  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
  </svg>
);

const systemIcon = (
  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <rect height="13" rx="2" width="18" x="3" y="4" />
    <path d="M8 21h8M12 17v4" strokeLinecap="round" />
  </svg>
);

const OPTIONS: { key: ThemeMode; label: string; icon: ReactNode }[] = [
  { key: "light", label: "روشن", icon: sunIcon },
  { key: "system", label: "سیستم", icon: systemIcon },
  { key: "dark", label: "تیره", icon: moonIcon },
];

/**
 * Segmented light/system/dark switch. The stored choice is read after mount
 * (async — the react-hooks compiler forbids synchronous setState inside
 * effects) and mirrored to `nia-theme` + the `.dark` class on <html>.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");

  const hydrate = useCallback(() => {
    void Promise.resolve().then(() => {
      const stored = readStoredMode();
      setMode(stored);
      applyTheme(stored);
    });
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const choose = useCallback((next: ThemeMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked — still apply for this session
    }
    applyTheme(next);
  }, []);

  return (
    <div aria-label="پوسته" className="flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1" role="group">
      {OPTIONS.map((option) => (
        <button
          aria-pressed={mode === option.key}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
            mode === option.key
              ? "bg-ink text-on-ink"
              : "text-muted hover:bg-surface-3 hover:text-ink"
          }`}
          key={option.key}
          onClick={() => choose(option.key)}
          type="button"
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
