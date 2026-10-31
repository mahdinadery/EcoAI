"use client";

import { KeywordListEditor } from "./keyword-list-editor";
import type { AiTopicRule } from "@/lib/ai/config-types";

type Props = {
  value: AiTopicRule;
  onChange: (next: AiTopicRule) => void;
  onRemove: () => void;
};

/**
 * One row of the Topic Filter editor (Milestone: dashboard-configurable topics).
 * Keywords are edited as a comma-separated list — plain data, no code changes.
 */
export function AiConfigTopicRow({ value, onChange, onRemove }: Props) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          checked={value.enabled}
          className="h-4 w-4 accent-blue-600"
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          title="فعال/غیرفعال"
          type="checkbox"
        />
        <input
          className="min-w-[160px] flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
          onChange={(event) => onChange({ ...value, label: event.target.value })}
          placeholder="عنوان موضوع (مثلاً: بازار خودرو)"
          value={value.label}
        />
        <button
          className="rounded-lg border border-danger-line px-3 py-2 text-xs font-medium text-danger-ink transition-colors hover:bg-danger-soft"
          onClick={onRemove}
          type="button"
        >
          حذف موضوع
        </button>
      </div>
      <KeywordListEditor
        className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
        onValuesChange={(keywords) =>
          onChange({
            ...value,
            keywords,
          })
        }
        rows={1}
        placeholder="کلیدواژه‌ها با جداکننده ویرگول (مثلاً: خودرو، قیمت خودرو، خودروساز)"
        values={value.keywords}
      />
      <p className="mt-1.5 text-[11px] text-faint">
        تطبیق با هر یک از کلیدواژه‌ها کافی است (جست‌وجوی ساده متنی، بدون فراخوانی هوش مصنوعی).
      </p>
    </div>
  );
}
