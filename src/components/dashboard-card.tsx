import type { ReactNode } from "react";

type DashboardCardProps = {
  label: string;
  value: ReactNode;
  detail?: string;
  icon: ReactNode;
  accent: "blue" | "violet" | "amber" | "slate";
};

const accentClasses = {
  blue: "bg-accent-soft text-accent-ink",
  violet: "bg-brand-soft text-brand-ink",
  amber: "bg-warn-soft text-warn-ink",
  slate: "bg-surface-3 text-muted",
};

export function DashboardCard({ label, value, detail, icon, accent }: DashboardCardProps) {
  return (
    <article className="rounded-2xl border border-line/80 bg-surface p-5 shadow-sm shadow-line/40">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted">{label}</p>
          <p className="mt-4 text-2xl font-bold tracking-tight text-ink">{value}</p>
          {detail ? <p className="mt-2 text-xs text-faint">{detail}</p> : null}
        </div>
        <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${accentClasses[accent]}`}>
          {icon}
        </div>
      </div>
    </article>
  );
}
