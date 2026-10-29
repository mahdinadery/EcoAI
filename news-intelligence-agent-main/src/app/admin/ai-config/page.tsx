import { AdminGateScreen } from "@/components/admin/admin-gate-screen";
import { AdminKeyQuerySync } from "@/components/admin/admin-key-query-sync";
import { AiConfigConsole } from "@/components/admin/ai-config-console";
import { Sidebar } from "@/components/sidebar";
import { adminKeyForClient, getAdminPageAccess } from "@/lib/admin/page-access";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "مرکز پیکربندی هوش مصنوعی | دستیار هوشمند اخبار",
  description: "پیکربندی رفتار تحلیل هوش مصنوعی بدون نیاز به تغییر کد",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AiConfigPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const access = await getAdminPageAccess(params.key);

  if (!access.authorized) {
    return <AdminGateScreen width="narrow" />;
  }

  const clientKey = adminKeyForClient(access);

  return (
    <div className="min-h-screen bg-canvas-2 text-ink" dir="rtl">
      <div className="lg:flex">
        <Sidebar />

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[1280px] p-4 sm:p-6 lg:p-10">
            {!access.gateConfigured ? (
              <div className="mb-6 rounded-2xl border border-warn-line bg-warn-soft px-5 py-4 text-sm text-warn-ink">
                <p className="font-bold">هشدار امنیتی: احراز هویت واقعی هنوز متصل نشده است.</p>
                <p className="mt-1 leading-6">
                  این پروژه هنوز سامانه ورود/نشست کاربری ندارد. این صفحه با متغیر محیطی{" "}
                  <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">ADMIN_ACCESS_KEY</code> قفل
                  می‌شود؛ چون این متغیر تنظیم نشده، دسترسی برای همه باز است. برای محدودسازی، مقدار آن را در محیط
                  سرور تنظیم کنید؛ از آن پس هنگام باز کردن صفحات مدیریت، پاپ‌آپ ورود کلید نمایش داده می‌شود.
                </p>
              </div>
            ) : null}

            <AdminKeyQuerySync adminKey={clientKey} />
            <AiConfigConsole adminKey={clientKey} />
          </div>
        </main>
      </div>
    </div>
  );
}
