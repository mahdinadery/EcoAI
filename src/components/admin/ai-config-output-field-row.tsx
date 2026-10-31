"use client";

import type { AiOutputFieldSchema } from "@/lib/ai/config-types";

type Props = {
  value: AiOutputFieldSchema;
  locked?: boolean;
  onChange: (next: AiOutputFieldSchema) => void;
};

const TYPE_LABELS: Record<AiOutputFieldSchema["type"], string> = {
  string: "متن",
  number: "عدد",
  boolean: "بولین",
};

/** One row = one field in the structured output schema (name/enabled/description/required/type). */
export function AiConfigOutputFieldRow({ value, locked, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 items-center gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[1fr_1fr_auto_auto_auto]">
      <div>
        <p className="font-mono text-xs font-bold text-ink">{value.name}</p>
        <p className="text-[11px] text-faint">{TYPE_LABELS[value.type]}</p>
      </div>

      <input
        className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-soft focus:border-accent focus:outline-none"
        onChange={(event) => onChange({ ...value, description: event.target.value })}
        placeholder="توضیح فیلد"
        value={value.description}
      />

      <label className="inline-flex items-center gap-1.5 text-xs">
        <input
          checked={value.enabled}
          className="h-3.5 w-3.5 accent-blue-600 disabled:cursor-not-allowed"
          disabled={locked}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          type="checkbox"
        />
        فعال
      </label>

      <label className="inline-flex items-center gap-1.5 text-xs">
        <input
          checked={value.required}
          className="h-3.5 w-3.5 accent-amber-600"
          onChange={(event) => onChange({ ...value, required: event.target.checked })}
          type="checkbox"
        />
        الزامی
      </label>

      {value.type === "number" ? (
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <input
            className="w-12 rounded-md border border-line px-1.5 py-1 text-center"
            onChange={(event) => onChange({ ...value, min: Number(event.target.value) })}
            type="number"
            value={value.min ?? 0}
          />
          <span>-</span>
          <input
            className="w-12 rounded-md border border-line px-1.5 py-1 text-center"
            onChange={(event) => onChange({ ...value, max: Number(event.target.value) })}
            type="number"
            value={value.max ?? 100}
          />
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}
