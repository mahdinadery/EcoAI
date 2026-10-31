import { Sidebar } from "@/components/sidebar";
import { AdminKeyGate } from "./admin-key-gate";

type Props = { width?: "default" | "narrow" };

/**
 * Standard admin shell with the key popup instead of the protected content.
 * Used by pages that should show the popup (not a 404) when unauthorized.
 */
export function AdminGateScreen({ width = "default" }: Props) {
  const containerWidth = width === "narrow" ? "max-w-[1180px]" : "max-w-[1480px]";

  return (
    <div className="min-h-screen bg-canvas-2 text-ink" dir="rtl">
      <div className="lg:flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className={`mx-auto ${containerWidth} p-4 sm:p-6 lg:p-10`}>
            <AdminKeyGate />
          </div>
        </main>
      </div>
    </div>
  );
}
