import { AdminGateScreen } from "@/components/admin/admin-gate-screen";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { EntitiesConsole } from "@/components/admin/entities-console";
import { Sidebar } from "@/components/sidebar";
import { adminKeyForClient, getAdminPageAccess } from "@/lib/admin/page-access";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "پروندهٔ ناشران و نهادها | دستیار هوشمند اخبار",
  description: "داشبورد رتبه‌بندی ناشران و نهادهای استخراج‌شده بر اساس تعداد، زمان و امتیاز میزان اهمیت",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function EntitiesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const access = await getAdminPageAccess(params.key);

  if (!access.authorized) {
    return <AdminGateScreen />;
  }

  const clientKey = adminKeyForClient(access);

  return (
    <div className="min-h-screen bg-canvas-2 text-ink" dir="rtl">
      <div className="lg:flex">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1480px] p-4 sm:p-6 lg:p-10">
            <AdminKeyQuerySync adminKey={clientKey} />
            <EntitiesConsole adminKey={clientKey} />
          </div>
        </main>
      </div>
    </div>
  );
}
