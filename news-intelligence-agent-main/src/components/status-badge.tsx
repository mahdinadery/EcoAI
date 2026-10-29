import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "muted";

type StatusBadgeProps = {
  children: ReactNode;
  tone?: StatusTone;
};

const toneClasses: Record<StatusTone, string> = {
  success: "bg-ok-soft text-ok-ink ring-ok-line",
  warning: "bg-warn-soft text-warn-ink ring-warn-line",
  danger: "bg-danger-soft text-danger-ink ring-danger-line",
  muted: "bg-surface-3 text-muted ring-line",
};

const dotClasses: Record<StatusTone, string> = {
  success: "bg-ok",
  warning: "bg-warn",
  danger: "bg-danger",
  muted: "bg-track-strong",
};

export function StatusBadge({ children, tone = "success" }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset ${toneClasses[tone]}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dotClasses[tone]}`} />
      {children}
    </span>
  );
}
