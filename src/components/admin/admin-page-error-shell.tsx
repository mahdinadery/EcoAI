import { Sidebar } from "@/components/sidebar";
import { AdminDbErrorPanel } from "./admin-db-error-panel";

type Props = {
  error: unknown;
  message: string;
  adminKey?: string;
  width?: "default" | "narrow";
};

/** Full admin page shell showing the DB error + schema-repair card. */
export function AdminPageErrorShell({ error, message, adminKey, width = "narrow" }: Props) {
  const containerWidth = width === "narrow" ? "max-w-[1180px]" : "max-w-[1480px]";

  return (
    <div className="min-h-screen bg-canvas-2 text-ink" dir="rtl">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className={`mx-auto ${containerWidth} p-4 sm:p-6 lg:p-10`}>
            <AdminDbErrorPanel adminKey={adminKey} error={error} message={message} />
          </div>
        </main>
      </div>
    </div>
  );
}
