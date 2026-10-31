# EcoAI — دستیار هوشمند مقالات اقتصادی انگلیسی به فارسی (بله)

سامانهٔ دریافت خودکار مقالات تحلیلی اقتصادی انگلیسی (IMF، Project Syndicate، VoxEU/CEPR، Brookings، PIIE، The Economist، بانک جهانی، فدرال رزرو و بانک مرکزی اروپا)، استخراج متن کامل مقاله، ترجمه و خلاصه‌سازی تخصصی به فارسی روان، و انتشار دوزبانه در پیام‌رسان **بله (`بله`)**.

---

## استقرار رایگان در ۳ گام (Neon + Render + GitHub Actions)

### ۱) دیتابیس رایگان در Neon
1. در سایت [neon.tech](https://neon.tech) با حساب GitHub وارد شوید و یک پروژهٔ رایگان بسازید.
2. از بخش **Connect**، رشتهٔ اتصال **Pooled** را کپی کنید (شامل `?sslmode=require`):
   ```text
   postgresql://neondb_owner:PASSWORD@ep-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```

### ۲) استقرار روی Render (هر دو روش Web Service و Blueprint پشتیبانی می‌شود)
تمام فایل‌های پروژه (`package.json`، `.node-version` و `src/`) مستقیماً در **ریشهٔ مخزن** قرار دارند و نیازی به تغییر `Root Directory` نیست:

1. در سایت [render.com](https://render.com) با GitHub وارد شوید.
2. روی **New + → Web Service** (یا **New + → Blueprint**) بزنید و مخزن **`mahdinadery/EcoAI`** را انتخاب کنید:
   - **Branch**: `main`
   - **Root Directory**: *(خالی بگذارید)*
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
3. در تب **Environment** متغیرهای زیر را وارد کنید:
   - `DATABASE_URL`: رشتهٔ Pooled کپی‌شده از Neon
   - `ADMIN_ACCESS_KEY`: یک کلید رمز قوی دلخواه برای ورود به پنل `/admin`
   - `AI_API_KEY`: کلید API هوش مصنوعی (OpenAI / Groq / OpenRouter)
   - `AI_API_BASE_URL`: آدرس پایهٔ سرویس هوش مصنوعی (مثلاً `https://api.openai.com/v1` یا `https://api.groq.com/openai/v1`)
   - `AI_API_MODEL`: نام مدل (مثلاً `gpt-4o-mini`)
   - `BALE_BOT_TOKEN`: توکن بازوی بله (`@BotFather`)
   - `BALE_CHAT_ID`: شناسهٔ عددی یا `@username` کانال بله (بازو باید ادمین کانال باشد)
   - `BALE_DELIVERY_MODE`: `live`
   - `AUTO_SEND_DESTINATION`: `bale`
4. روی **Deploy** بزنید. جدول‌ها و ستون‌های دیتابیس هنگام بالا آمدن سرور به‌صورت خودکار و ایمن (`db:ensure`) ساخته می‌شوند.

### ۳) فعال‌سازی زمان‌بندی خودکار در GitHub Actions (بیدار نگه داشتن Render)
فایل‌های کرون در [`.github/workflows/`](./.github/workflows) قرار دارند و هر ۵ دقیقه نوبت‌های ارسال را بررسی می‌کنند. برای فعال‌سازی آن‌ها:

1. در مخزن GitHub به مسیر **Settings → Secrets and variables → Actions → New repository secret** بروید.
2. این دو Secret را اضافه کنید:
   - `APP_URL`: آدرس سرویس Render شما (مثلاً `https://ecoai.onrender.com`)
   - `ADMIN_ACCESS_KEY`: دقیقاً همان کلیدی که در Render گذاشتید

---

## راه‌اندازی اولیه پس از بالا آمدن سایت
1. وارد `https://<your-app>.onrender.com/admin/news-sources` شوید و با `ADMIN_ACCESS_KEY` وارد شوید.
2. روی دکمهٔ **«اعمال بسته مقالات اقتصادی انگلیسی»** کلیک کنید تا ۱۰ فید تحلیلی اقتصاد جهانی و موضوعات مرتبط به‌صورت خودکار تست و ثبت شوند.
3. در صفحهٔ `/dashboard` از کارت **«اتصال به بله»** اتصال کانال را تست کنید و در کارت **«ارسال خودکار زمان‌بندی‌شده»** ساعت‌های انتشار را فعال نمایید.

برای جزئیات بیشتر به [`DEPLOYMENT.md`](./DEPLOYMENT.md) مراجعه کنید.
