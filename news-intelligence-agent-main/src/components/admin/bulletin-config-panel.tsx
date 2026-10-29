"use client";

import { buildBulletinMessage, BULLETIN_TEMPLATE_VARS, BULLETIN_ITEM_TEMPLATE_VARS, DEFAULT_BULLETIN_TEMPLATE, DEFAULT_BULLETIN_ITEM_TEMPLATE, unknownBulletinVariables, DEFAULT_BULLETIN_SETTINGS, resolveBulletinSettings, type BulletinSettings } from "@/lib/delivery/bulletin";

type Props = { value?: Partial<BulletinSettings>; onChange: (value: BulletinSettings) => void };
export function BulletinConfigPanel({ value, onChange }: Props) {
  const settings = resolveBulletinSettings(value);
  const update = (patch: Partial<BulletinSettings>) => onChange({ ...settings, ...patch });
  const preview = buildBulletinMessage({
    settings, generatedAt: new Date("2026-01-01T12:00:00Z"), timezone: "Asia/Tehran",
    intro: "این یک مقدمهٔ نمونه برای پیش‌نمایش است؛ هیچ درخواست AI اجرا نشده است.",
    items: Array.from({length: 5}, (_, i) => ({ id: String(i), title: `خبر نمونه ${i + 1}: تغییر مقررات اعتبارسنجی`, oneLiner: "خلاصهٔ کوتاه و نمونهٔ خبر.", whyItMatters: "این تغییر بر تصمیم اعطای اعتبار اثر دارد.", url: "https://example.com/sample", importanceScore: 80, hashtags: "#اعتبارسنجی #بازار_سهام", publishedAt: null, entityTags: ["بانک نمونه"], corroborated: true })),
  });
  return <section className="rounded-2xl border border-line bg-surface p-5 space-y-3" dir="rtl">
    <div className="flex justify-between"><h2 className="font-bold">پیکربندی بولتن</h2><button type="button" className="text-xs text-muted" onClick={() => onChange({...DEFAULT_BULLETIN_SETTINGS})}>بازنشانی پیش‌فرض</button></div>
    <p className="text-xs text-muted">برای بولتن زمان‌بندی‌شده و بولتن موجودیت‌ها. پس از «ذخیره و فعال‌سازی» روی بولتن‌های بعدی اعمال می‌شود. زمان‌بندی و مقصد همچنان در تنظیمات زمان‌بندی کنترل می‌شوند.</p>
    <label className="block text-sm">عنوان بولتن<input className="mx-2 rounded border border-line p-2" maxLength={100} value={settings.title} onChange={e => update({title:e.target.value})}/></label>
    <label className="block text-sm">حداکثر تعداد خبر (۱ تا ۵)<input type="number" min={1} max={5} className="mx-2 w-20 rounded border border-line p-2" value={settings.maxItems} onChange={e => update({maxItems:Number(e.target.value)})}/></label>
    <div className="flex flex-wrap gap-4">{([{key:"showSummary",label:"نمایش خلاصه"},{key:"showWhy",label:"چرا مهم است"},{key:"showEntities",label:"نمایش نهادها"},{key:"showSources",label:"نمایش تأیید چندمنبعی"},{key:"aiIntro",label:"مقدمه با AI (یک درخواست اضافه)"}] as const).map(item => <label key={item.key} className="text-sm"><input type="checkbox" checked={settings[item.key]} onChange={e => update({[item.key]:e.target.checked})}/> {item.label}</label>)}</div>
    <label className="block text-sm">دستور مقدمهٔ AI<textarea className="mt-2 w-full rounded border border-line p-2 text-sm" rows={4} value={settings.introPrompt} onChange={e => update({introPrompt:e.target.value})}/></label>
    <label className="block text-sm">سقف توکن پاسخ مقدمه (۵۰ تا ۵۰۰)<input type="number" min={50} max={500} className="mx-2 w-24 rounded border border-line p-2" value={settings.introMaxTokens} onChange={e => update({introMaxTokens:Number(e.target.value)})}/></label>
    <p className="text-xs text-muted">خاموش کردن مقدمه، فراخوانی AI آن را حذف می‌کند. مدل از تنظیمات اصلی تحلیل خوانده می‌شود. لینک اصلی خبر همیشه حفظ می‌شود.</p>
    <h3 className="font-bold">قالب انتشار بولتن (Publishing Template)</h3>
    <p className="text-xs text-muted">قالب کل بولتن باید {"{items}"} داشته باشد. قالب هر خبر برای تمام خبرهای انتخاب‌شده تکرار می‌شود. خالی گذاشتن قالب یعنی چیدمان پیش‌فرض. گزینه‌های نمایش بالا همچنان اعمال می‌شوند؛ لینک منبع در صورت حذف متغیرش به انتهای هر خبر افزوده می‌شود.</p>
    {([{key: "template", label: "قالب کل بولتن", variables: BULLETIN_TEMPLATE_VARS, fallback: DEFAULT_BULLETIN_TEMPLATE}, {key: "itemTemplate", label: "قالب هر خبر داخل بولتن", variables: BULLETIN_ITEM_TEMPLATE_VARS, fallback: DEFAULT_BULLETIN_ITEM_TEMPLATE}] as const).map(field => <div key={field.key}>
      <div className="flex justify-between"><label htmlFor={`bulletin-${field.key}`} className="text-sm font-bold">{field.label}</label><button type="button" className="text-xs text-muted" onClick={() => update({[field.key]:field.fallback})}>درج قالب پیش‌فرض</button></div>
      <textarea id={`bulletin-${field.key}`} className="mt-2 w-full rounded border border-line p-3 font-mono text-xs" rows={6} value={settings[field.key]} placeholder={field.fallback} onChange={e => update({[field.key]:e.target.value})}/>
      <div className="flex flex-wrap gap-2 text-xs">{field.variables.map(name => <code key={name}>{`{${name}}`}</code>)}</div>
      {unknownBulletinVariables(settings[field.key], field.variables).length ? <p className="text-xs text-danger-ink">متغیر ناشناخته: {unknownBulletinVariables(settings[field.key], field.variables).join("، ")}</p> : null}
      {field.key === "template" && settings.template.trim() && !settings.template.includes("{items}") ? <p className="text-xs text-danger-ink">متغیر {"{items}"} برای نمایش خبرها الزامی است.</p> : null}
    </div>)}
    <h3 className="text-sm font-bold">پیش‌نمایش نمونه — بدون ارسال و بدون مصرف توکن</h3>
    <p className="text-xs text-muted">متن و تاریخ و لینک نمونه‌اند؛ دستور مقدمه در این پیش‌نمایش اجرا نمی‌شود.</p>
    <pre className="whitespace-pre-wrap rounded border border-line p-3 text-sm">{preview}</pre>
  </section>;
}
