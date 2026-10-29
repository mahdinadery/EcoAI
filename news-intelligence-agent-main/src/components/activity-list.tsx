type ActivityListProps = {
  items?: readonly string[];
};

export function ActivityList({ items = [] }: ActivityListProps) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface-2/70 px-5 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-surface text-faint shadow-sm ring-1 ring-line">
          <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
        </div>
        <p className="mt-4 text-sm font-medium text-muted">هنوز فعالیتی ثبت نشده است.</p>
        <p className="mt-1 text-xs text-faint">فعالیت‌های Agent در این بخش نمایش داده می‌شوند.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line-soft">
      {items.map((item) => (
        <li className="py-4 text-sm text-muted first:pt-0 last:pb-0" key={item}>
          {item}
        </li>
      ))}
    </ul>
  );
}
