"use client";

import { useState } from "react";
import type { ActiveAiConfig } from "@/lib/ai/config-types";

type Props = {
  versions: ActiveAiConfig[];
  loading: boolean;
  activating: string | null;
  onActivate: (id: string) => void;
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("fa-IR");
}

export function AiConfigVersionHistory({ versions, loading, activating, onActivate }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40 sm:p-6">
      <h2 className="text-base font-bold text-ink">تاریخچه نسخه‌ها</h2>
      <p className="mt-1 text-sm text-muted">
        هر بار ذخیره، یک نسخه جدید ایجاد می‌شود؛ نسخه‌های قبلی حفظ می‌شوند و می‌توانید هر کدام را دوباره فعال کنید.
      </p>

      {loading ? (
        <p className="mt-5 text-sm text-faint">در حال بارگذاری تاریخچه...</p>
      ) : versions.length === 0 ? (
        <p className="mt-5 text-sm text-faint">هنوز نسخه‌ای ذخیره نشده است.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {versions.map((version) => {
            const isExpanded = expandedId === version.id;
            return (
              <li className="rounded-xl border border-line bg-surface-2/60" key={version.id}>
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="flex items-center gap-3">
                    <span className="rounded-lg bg-surface px-2.5 py-1 text-xs font-bold text-ink-soft ring-1 ring-line">
                      نسخه {version.version}
                    </span>
                    <div>
                      <p className="text-sm font-bold text-ink">{version.name}</p>
                      <p className="text-[11px] text-faint">به‌روزرسانی: {formatDate(version.updatedAt)}</p>
                    </div>
                    {version.isActive ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2.5 py-1 text-xs font-bold text-ok-ink ring-1 ring-inset ring-ok-line">
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ok" />
                        فعال
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-3"
                      onClick={() => setExpandedId(isExpanded ? null : version.id)}
                      type="button"
                    >
                      {isExpanded ? "پنهان کردن" : "مشاهده"}
                    </button>
                    {!version.isActive ? (
                      <button
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-accent-line"
                        disabled={activating === version.id}
                        onClick={() => onActivate(version.id)}
                        type="button"
                      >
                        {activating === version.id ? "در حال فعال‌سازی..." : "فعال‌سازی این نسخه"}
                      </button>
                    ) : null}
                  </div>
                </div>

                {isExpanded ? (
                  <div className="space-y-3 border-t border-line p-4 text-xs text-muted">
                    <div>
                      <p className="font-bold text-ink-soft">System Prompt:</p>
                      <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface p-2.5 ring-1 ring-line-soft">
                        {version.systemPrompt}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-4">
                      <span>مدل: {version.model || "(پیش‌فرض از env)"}</span>
                      <span>Temperature: {version.temperature}</span>
                      <span>Max Tokens: {version.maxTokens}</span>
                    </div>
                    <div>
                      ویژگی‌های فعال:{" "}
                      {Object.entries(version.features)
                        .filter(([, feature]) => feature.enabled)
                        .map(([key]) => key)
                        .join("، ")}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
