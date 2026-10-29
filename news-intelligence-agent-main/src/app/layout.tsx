import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";

// Vazirmatn (OFL license, vendored variable woff2) — the Persian UI face.
const vazirmatn = localFont({
  src: "../fonts/vazirmatn.woff2",
  variable: "--font-vazirmatn",
  display: "swap",
});

export const metadata: Metadata = {
  title: "دستیار هوشمند اخبار",
  description: "مدیریت دریافت، تحلیل و ارسال اخبار.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1020" },
  ],
};

/**
 * Runs before first paint (plain script, no hydration) so the page never
 * flashes the wrong theme. Mirrors ThemeToggle's storage key (`nia-theme`).
 */
const themeScript = `(function(){try{var s=localStorage.getItem("nia-theme");var m=s==="light"||s==="dark"?s:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");if(m==="dark")document.documentElement.classList.add("dark");document.documentElement.style.colorScheme=m;}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${vazirmatn.variable} bg-canvas text-ink antialiased`}>{children}</body>
    </html>
  );
}
