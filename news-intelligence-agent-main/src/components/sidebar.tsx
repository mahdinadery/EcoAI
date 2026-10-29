"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

type NavIconName = "dashboard" | "sources" | "news" | "agent" | "bale" | "reports" | "settings" | "aiConfig";

type NavItem = {
  label: string;
  icon: NavIconName;
  href?: string;
};

// Only `href` items are functional routes at this stage; the rest stay "به‌زودی".
const navItems: NavItem[] = [
  { label: "داشبورد", icon: "dashboard", href: "/dashboard" },
  { label: "اخبار", icon: "news", href: "/news" },
  { label: "مدیریت اخبار", icon: "reports", href: "/admin/news" },
  { label: "منابع خبری", icon: "sources", href: "/admin/news-sources" },
  { label: "پروندهٔ ناشران و نهادها", icon: "reports", href: "/admin/entities" },
  { label: "انتشار و ارسال‌ها", icon: "bale", href: "/admin/deliveries" },
  { label: "Agent", icon: "agent" },
  { label: "بله", icon: "bale" },
  { label: "پیکربندی AI", icon: "aiConfig", href: "/admin/ai-config" },
  { label: "تنظیمات", icon: "settings" },
];

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    dashboard: (
      <>
        <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
        <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
        <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
        <rect x="14.5" y="14.5" width="6" height="6" rx="1" />
      </>
    ),
    sources: (
      <>
        <circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
        <path d="M5 13a6 6 0 0 1 6 6M5 8a11 11 0 0 1 11 11M5 3a16 16 0 0 1 16 16" />
      </>
    ),
    news: (
      <>
        <path d="M5 3.5h10l4 4v13H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
        <path d="M15 3.5v5h4M7 13h10M7 17h7M7 9h3" />
      </>
    ),
    agent: (
      <path d="m12 3 1.35 4.65L18 9l-4.65 1.35L12 15l-1.35-4.65L6 9l4.65-1.35L12 3ZM18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
    ),
    bale: (
      <>
        <path d="M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 4v-4H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
        <path d="M7 9h10M7 13h6" />
      </>
    ),
    reports: (
      <>
        <path d="M4 20.5v-8M10 20.5V7M16 20.5v-5M22 20.5V3.5" />
        <path d="M2.5 20.5h20" />
      </>
    ),
    settings: (
      <>
        <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
        <path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1A1.7 1.7 0 0 0 6.2 12a1.7 1.7 0 0 0-1.7-1.7h-.2a1.7 1.7 0 0 1 0-3.4h.2A1.7 1.7 0 0 0 6.2 4l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V.2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" transform="translate(0 3) scale(.78)" />
      </>
    ),
    aiConfig: (
      <>
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
        <circle cx="12" cy="12" r="3.5" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      {paths[name]}
    </svg>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-full shrink-0 border-b border-line bg-surface lg:sticky lg:top-0 lg:h-screen lg:w-[276px] lg:border-b-0 lg:border-l">
      <div className="flex h-full flex-col px-4 py-5 sm:px-6 lg:px-5">
        <div className="flex items-center gap-3 px-2 pb-6">
          <div className="ms-auto lg:hidden">
            <ThemeToggle />
          </div>
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-accent text-white shadow-lg shadow-accent/20">
            <svg
              aria-hidden="true"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="m7.5 9.2 4.5 2.6 4.5-2.6M12 11.8V17" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-ink">دستیار هوشمند اخبار</p>
            <p className="mt-0.5 text-xs text-faint">مرکز مدیریت، تحلیل و انتشار</p>
          </div>
        </div>

        <nav aria-label="ناوبری اصلی" className="flex flex-wrap gap-1 lg:flex-col lg:gap-1">
          {navItems.map((item) => {
            const isActive = Boolean(item.href) && pathname.startsWith(item.href as string);
            const content = (
              <>
                <NavIcon name={item.icon} />
                <span className="flex-1 whitespace-nowrap">{item.label}</span>
                {item.href ? null : (
                  <span className="rounded-md bg-surface-3 px-1.5 py-1 text-[10px] font-medium text-faint">
                    به‌زودی
                  </span>
                )}
              </>
            );

            if (item.href) {
              return (
                <Link
                  aria-current={isActive ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors ${
                    isActive ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                  href={item.href}
                  key={item.label}
                >
                  {content}
                </Link>
              );
            }

            return (
              <div
                aria-disabled="true"
                className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-faint"
                key={item.label}
                title="به‌زودی"
              >
                {content}
              </div>
            );
          })}
        </nav>

        <div className="mt-8 hidden rounded-2xl border border-ok-line bg-ok-soft p-4 lg:block">
          <p className="text-xs font-semibold text-ok-ink">⏱️ انتشار پیوسته</p>
          <p className="mt-2 text-xs leading-5 text-ok-ink/85">
            زمان‌بندی ارسال را از «انتشار و ارسال‌ها» تعیین کنید؛ اجرا با کرون روی سرور انجام می‌شود و نیازی به
            باز بودن این صفحه نیست.
          </p>
        </div>

        <div className="mt-auto hidden border-t border-line-soft pt-5 lg:block">
          <ThemeToggle />
          <p className="mt-3 px-2 text-[11px] text-faint">نسخه ۳ — تحلیل، بولتن و انتشار خودکار</p>
        </div>
      </div>
    </aside>
  );
}
