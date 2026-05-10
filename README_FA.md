<div dir="rtl">

# MasterHttpRelayVPN — فورک با پشتیبانی از TCP

**[🇬🇧 English README](README.md)**

> **این پروژه یک فورک از [masterking32/MasterHttpRelayVPN](https://github.com/masterking32/MasterHttpRelayVPN) است** که یک تغییر اساسی در هسته دارد: علاوه بر رله HTTP اصلی، یک **تونل واقعی TCP** اضافه می‌کند.
>
> پروژه اصلی فقط ترافیک HTTP/HTTPS را از طریق گوگل اپس‌اسکریپت رله می‌کند. این کار برای مرور وب کافی است، اما نمی‌تواند ترافیک TCP عمومی را حمل کند، چون **گوگل اپس‌اسکریپت اصلاً API برای سوکت TCP ندارد**: تنها ابزار شبکه‌اش `UrlFetchApp` است که فقط HTTP می‌فهمد. هر برنامه‌ای که به TCP خام نیاز دارد (SSH، ترافیک SOCKS5 از کلاینت‌هایی که نمی‌توان MITM کرد، پروتکل‌های اختصاصی، مرورگرهایی که گواهی محلی MITM را قبول نمی‌کنند و …) از دسترس آن خارج است.
>
> این فورک رله HTTP قبلی را دست‌نخورده نگه می‌دارد و یک مسیر داده‌ی دوم اضافه می‌کند که به کلاینت یک اتصال TCP واقعی end-to-end از همان کانال فرانت‌شده‌ی گوگل می‌دهد. سوکت پایدار روی یک **Durable Object در Cloudflare Worker** زندگی می‌کند و اپس‌اسکریپت فقط نقش پل را دارد. سمت پایتون هم با **long-polling** هر دو جهت را به‌طور هم‌زمان می‌راند تا مرورگر یک TCP طبیعی حس کند، بدون اینکه سهمیه‌ی اپس‌اسکریپت با polling حلقوی بی‌فایده سوزانده شود.

---

## چرا این فورک؟

جریان پروژه‌ی اصلی این است:

```
مرورگر → پروکسی محلی → فرانت گوگل → اپس‌اسکریپت → fetch به آدرس مقصد → پاسخ
```

اپس‌اسکریپت درخواست را می‌گیرد، `UrlFetchApp.fetch(...)` را صدا می‌زند و بدنه را برمی‌گرداند. **هر درخواست یک fetch مستقل و یک‌شات HTTP است.** بعد از برگشت پاسخ، هیچ حالتی (state) سمت گوگل باقی نمی‌ماند. سوکتی، `connect()`ای، استریم نیمه‌بازی وجود ندارد — runtime اپس‌اسکریپت اصلاً ابزارهای TCP را در اختیار نمی‌گذارد.

نتیجه این است که پروژه‌ی اصلی نمی‌تواند پاسخ‌گوی این موارد باشد:
- مرورگری که آن را به عنوان پروکسی **SOCKS5** تنظیم کرده‌اید (مرورگر همیشه آن را HTTP-proxy نمی‌بیند و وضعیت TLS باید روی چندین رفت‌وبرگشت زنده بماند).
- هر کلاینت SOCKS5 که می‌خواهد پروتکل غیر HTTP حرف بزند (SSH، MTProto، TLS خام به مقصد ناشناس، …).
- موقعیت‌هایی که مرورگر گواهی MITM محلی را اعتماد نمی‌کند (لپ‌تاپ‌های شرکتی، مرورگرهای موبایل، Firefox با کانتینر بدون استثنا و …).

این فورک با اضافه کردن یک سوکت TCP واقعی **بالادست اپس‌اسکریپت** روی Cloudflare و تبدیل اپس‌اسکریپت به یک forwarder، این محدودیت را برطرف می‌کند.

---

## معماری

```
                                                           ┌──────────────────────────────┐
                                                           │  Cloudflare Worker           │
 مرورگر (SOCKS5)                                           │  ┌────────────────────────┐  │
       │                                                   │  │  Durable Object        │  │
       ▼                                                   │  │  TcpTunnel(tunnel_id)  │  │
 ┌──────────────┐    HTTPS (SNI=www.google.com,            │  │   • سوکت TCP واقعی     │  │
 │  پروکسی محلی │──── Host=script.google.com) ────►  Apps  │  │   • بافر دریافت        │──┼──► host:port مقصد
 │   (پایتون)   │◄──── JSON اَکشن‌محور ────  Script  ──────┼─►│   • انتظار long-poll   │  │
 └──────────────┘                                          │  └────────────────────────┘  │
       ▲                                                   └──────────────────────────────┘
       │
   uploader (کلاینت → رله)        downloader (رله → کلاینت با long-poll)
```

### پروتکل اَکشن‌محور (پایتون ↔ اپس‌اسکریپت ↔ DO)

پروکسی پایتون JSON را به اپس‌اسکریپت POST می‌کند؛ اپس‌اسکریپت همان را عیناً به Cloudflare Worker می‌فرستد و worker آن را به نمونه‌ی Durable Object که با `tunnel_id` ایندکس می‌شود می‌سپارد. DO تنها جایی است که سوکت TCP زنده در آن نگه‌داری می‌شود.

| اَکشن  | کار آن                                                                  |
|--------|--------------------------------------------------------------------------|
| `open` | DO یک سوکت TCP به `target_host:target_port` باز می‌کند. اگر `data` بفرستید، روی سوکت نوشته می‌شود و پاسخ فوری (مثلاً بنر SSH) در همان رفت‌وبرگشت برمی‌گردد. |
| `send` | DO روی سوکت می‌نویسد و با `wait_ms` کوتاه (~۲۰۰ms) منتظر می‌ماند تا پاسخی که بلافاصله می‌رسد (مثلاً `ServerHello` در TLS) را در همان پاسخ HTTP برگرداند. |
| `poll` | Long-poll: اگر در بافر داده هست، فوراً برمی‌گردد؛ وگرنه تا حدود ۳۰ ثانیه می‌خوابد و منتظر سرور بالادست می‌ماند. این **کانال idle** است که بدون ترافیک، اتصال را زنده نگه می‌دارد. |
| `close`| سوکت و نمونه‌ی DO آزاد می‌شوند. وقتی کلاینت قطع کند ارسال می‌شود. |

### چرا long-polling؟

طراحی ساده‌لوحانه این است که سمت پایتون هر ۵۰ms یک‌بار از اپس‌اسکریپت بپرسد «بایت جدیدی هست؟». این یعنی **۲۰ درخواست در ثانیه برای هر تونل**، که سهمیه‌ی روزانه‌ی `UrlFetchApp` (حدود ۲۰٬۰۰۰ تماس در روز در پلن رایگان) را در کمتر از ۲۰ دقیقه برای هر تونل می‌سوزاند.

به‌جای آن، downloader یک long-poll واحد ۳۰ ثانیه‌ای می‌فرستد. DO تا وقتی یا (الف) سرور حرف بزند یا (ب) پنجره‌ی انتظار تمام شود داخل همان درخواست HTTP می‌خوابد. در نتیجه:

- یک تب مرورگرِ idle تقریباً ~۲ تماس در دقیقه ≈ ۲٬۸۸۰ در روز خرج می‌کند.
- هندشیک TLS و درخواست‌های HTTP فعال **بلافاصله** برمی‌گردند به محض رسیدن داده — هیچ بازه‌ی polling ثابتی منتظر نیست.

### uploader و downloader هم‌زمان

سمت پایتون دو حلقه‌ی مستقل اجرا می‌شود:

- **Uploader:** از کلاینت SOCKS5 می‌خواند، نوشته‌های ریز پشت‌سرهم را در یک پنجره‌ی ~۲۰ms داخل یک POST جمع می‌کند و `action=send` می‌فرستد. هر آپلود به‌طور فرصت‌طلبانه با `wait_ms=200` پاسخ سمت پایین را هم drain می‌کند.
- **Downloader:** پیوسته با `action=poll` و `wait_ms=30000` long-poll می‌کند و هر بایتی که برمی‌گردد را به کلاینت می‌نویسد.

یک رویداد مشترک `closed` این دو را به هم می‌بندد: هر کدام EOF بشود یا DO جواب `closed:true` بدهد، کل تونل بسته می‌شود و یک `action=close` ارسال می‌شود تا سوکت بالادست سریع آزاد شود.

---

## چالش‌ها و محدودیت‌های فعلی

- **محدودیت نرخ گوگل اپس‌اسکریپت.** قید اصلی همین است. حساب‌های Google رایگان روزانه حدود **۲۰٬۰۰۰ تماس `UrlFetchApp`** و حدود **۶ ساعت زمان اجرای کل اسکریپت** دارند. long-polling تنها چیزی است که این تونل را روی پلن رایگان عملی می‌کند. استفاده‌ی سنگین (چند مرورگر، استریم ویدیو از روی SOCKS5) **حتماً** سقف روزانه را می‌زند و تا ریست بعدی (نیمه‌شب اقیانوس آرام) خطا برمی‌گردد. اکانت‌های Workspace سقف بالاتری دارند. توزیع `script_id` روی چند اکانت گوگل (قابلیت multi-script پروژه‌ی اصلی) هم کمک می‌کند.
- **پلن رایگان Cloudflare Worker.** ۱۰۰٬۰۰۰ درخواست در روز در هر اکانت. هر تماس اپس‌اسکریپت به Worker = یک درخواست. زمان CPU برای Durable Object هم محاسبه می‌شود؛ پس تونل‌های idle طولانی GB-second جمع می‌کنند. برای استفاده‌ی شخصی همچنان راحت داخل پلن رایگان جا می‌شود.
- **تأخیر.** هر رفت‌وبرگشت از مسیر *مرورگر → پایتون → اپس‌اسکریپت → کلودفلر → مقصد → برگشت* عبور می‌کند. RTT اضافه نسبت به VPN واقعی محسوس است. برای مرور وب و SSH خوب است؛ برای بازی‌های low-latency نه.
- **timeout اجرای اپس‌اسکریپت.** هر تماس `UrlFetchApp` باید زیر ~۶۰ ثانیه تمام شود. ما `wait_ms` را روی Worker تا ۴۵ ثانیه clamp می‌کنیم تا تماس همیشه تمیز و با حاشیه برگردد.
- **همروندی هر تونل.** هر تونل از یک نمونه‌ی Durable Object استفاده می‌کند. همروندی DOهای Cloudflare کم نیست ولی روی پلن رایگان بی‌نهایت هم نیست؛ ده‌ها تونل هم‌زمان (تب‌های متعدد مرورگر هرکدام اتصال تازه) ممکن است نزدیک سقف بشود.

---

## راهنمای کامل نصب و استقرار

سرجمع باید سه قطعه را مستقر کنید و آن‌ها را با یک رمز مشترک به هم وصل کنید:

1. **یک Web App گوگل اپس‌اسکریپت** (رله HTTP و forwarder TCP).
2. **یک Cloudflare Worker با Durable Object** (سوکت TCP پایدار).
3. **پروکسی پایتون** که محلی اجرا می‌شود.

پیش‌نیازها:

- یک حساب گوگل.
- یک حساب Cloudflare (پلن رایگان کافی است).
- **Node.js** (برای ابزار `wrangler`).
- **Python 3.10 یا بالاتر**.

### مرحله ۱ — نصب Node.js (لازم برای `wrangler`)

`wrangler` ابزار رسمی Cloudflare برای deploy کردن Worker است که روی Node اجرا می‌شود.

#### لینوکس (Debian/Ubuntu/Pop!_OS)

```bash
# اسکریپت آماده‌ی NodeSource برای Node 20.x به‌روز:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # باید v20.x.x نشان دهد
npm --version
```

یا از مخزن خود توزیع (ممکن است نسخه قدیمی‌تر باشد):

```bash
sudo apt-get update && sudo apt-get install -y nodejs npm
```

#### لینوکس (Fedora / RHEL)

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

#### لینوکس (Arch)

```bash
sudo pacman -S nodejs npm
```

#### مک

```bash
brew install node
```

(یا از [nodejs.org/en/download](https://nodejs.org/en/download) دانلود کنید)

#### ویندوز

نصب‌کننده‌ی LTS را از [nodejs.org](https://nodejs.org/en/download) دانلود و اجرا کنید. سپس در یک پنجره‌ی PowerShell جدید:

```powershell
node --version
npm --version
```

#### روش پیشنهادی برای مدیریت چند نسخه‌ی Node: nvm

```bash
# لینوکس / مک
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# شل را ببندید و باز کنید:
nvm install --lts
nvm use --lts
```

### مرحله ۲ — نصب Wrangler

```bash
npm install -g wrangler
wrangler --version
wrangler login           # مرورگر را برای ورود به Cloudflare باز می‌کند
```

### مرحله ۳ — انتخاب یک رمز مشترک قوی

مقدار `AUTH_KEY` باید در **سه** جا یکی باشد: اپس‌اسکریپت، Cloudflare Worker و `config.json`. یکی بسازید و کنار دست نگه دارید:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### مرحله ۴ — استقرار Cloudflare Worker (Durable Object تونل TCP)

```bash
git clone https://github.com/JJ-arch/MasterHttpRelayVPN.git
cd MasterHttpRelayVPN/apps_script
```

فایل `wrangler_tcp.toml` را باز کنید و مقدار `AUTH_KEY` در بخش `[vars]` را با رمز مشترک از مرحله ۳ جایگزین کنید. در صورت تمایل نام Worker را تغییر دهید:

```toml
name = "tcp-tunnel"     # → آدرس https://tcp-tunnel.<your-subdomain>.workers.dev
```

سپس:

```bash
wrangler deploy --config wrangler_tcp.toml
```

Wrangler آدرس deploy‌شده را چاپ می‌کند، مثل `https://tcp-tunnel.<your-subdomain>.workers.dev`. **این آدرس را ذخیره کنید.**

تست سلامت:

```bash
curl https://tcp-tunnel.<your-subdomain>.workers.dev
# {"ok":true,"status":"healthy","role":"tcp_tunnel"}
```

### مرحله ۵ — استقرار گوگل اپس‌اسکریپت

1. به <https://script.google.com> بروید → **New project**.
2. کد پیش‌فرض را پاک کنید و کل محتوای فایل [`apps_script/Code.gs`](apps_script/Code.gs) را بچسبانید.
3. در بالای فایل تنظیم کنید:
   - `AUTH_KEY` → رمز مشترک مرحله ۳.
   - `CF_ENDPOINT` → آدرس Worker از مرحله ۴.
4. **Deploy → New deployment** را بزنید.
5. مقادیر:
   - **Type:** Web app
   - **Execute as:** Me
   - **Who has access:** Anyone
6. روی **Deploy** کلیک کنید و **Deployment ID** را کپی کنید (همان توکن طولانی در URL پس از `/exec`/`/dev`). این مقدار را در `config.json` قرار خواهید داد.

اگر قبلاً اپس‌اسکریپت قدیمی (بدون TCP) را deploy کرده بودید، می‌توانید همان پروژه را ویرایش کنید (ترجیحاً — Deployment ID ثابت می‌ماند) یا یک deployment جدید بسازید.

### مرحله ۶ — نصب پروکسی پایتون

از ریشه‌ی مخزن:

```bash
# لینوکس / مک
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# ویندوز (PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

کانفیگ را کپی و ویرایش کنید:

```bash
cp config.example.json config.json
```

حداقل این مقادیر:

```jsonc
{
  "auth_key": "<رمز مشترک مرحله ۳>",
  "script_id": "<Deployment ID از مرحله ۵>",
  "listen_port": 8080,
  "socks5_enabled": true,
  "socks5_port": 1080
}
```

(ابزار wizard با دستور `python setup.py` همین مراحل را به صورت تعاملی انجام می‌دهد.)

### مرحله ۷ — اجرا

```bash
python main.py
```

باید پیام‌هایی شبیه این ببینید:

```
Apps Script relay : SNI=www.google.com → script.google.com
HTTP proxy listening on 127.0.0.1:8080
SOCKS5 proxy listening on 127.0.0.1:1080
```

سپس مرورگر را تنظیم کنید:

- **HTTPS / HTTP که می‌خواهید از مسیر MITM رله‌ی اصلی برود:** پروکسی HTTP/HTTPS را روی `127.0.0.1:8080` بگذارید.
- **تونل TCP واقعی (قابلیت جدید این فورک):** پروکسی SOCKS5 را روی `127.0.0.1:1080` بگذارید.

برای فایرفاکس: *Settings → Network Settings → Manual proxy configuration → SOCKS Host = `127.0.0.1`, Port = `1080`, SOCKS v5*. تیک **Proxy DNS when using SOCKS v5** را هم بزنید تا DNS هم از تونل خارج شود.

### مرحله ۸ — تست مسیر TCP

```bash
# باید از مسیر SOCKS5 → اپس‌اسکریپت → DO → TCP واقعی برود:
curl -x socks5h://127.0.0.1:1080 https://example.com
```

سپس یک سایت TLS را در مرورگر باز کنید. در لاگ‌ها چیزی شبیه این می‌بینید:

```
SOCKS5 CONNECT → example.com:443
TCP-tunnel [<id>] → example.com:443 (open)
TCP-tunnel [<id>] closed (up=2048, down=46123)
```

---

## مرجع تنظیمات (فیلدهای مرتبط با TCP)

پروکسی پایتون از `config.json` می‌خواند. فیلدهای کلیدی:

| کلید                  | کاربرد                                                                        |
|-----------------------|------------------------------------------------------------------------------|
| `auth_key`            | رمز مشترک — باید با `AUTH_KEY` در `Code.gs` و `wrangler_tcp.toml` یکی باشد. |
| `script_id`           | Deployment ID اپس‌اسکریپت. می‌تواند لیست برای پخش بار روی چند اکانت باشد.    |
| `socks5_enabled`      | `true` تا listener SOCKS5 (مسیر TCP این فورک) فعال شود.                       |
| `socks5_port`         | پورت گوش‌دهی SOCKS5 (پیش‌فرض `1080`).                                         |
| `front_domain`        | SNI ارائه‌شده به شبکه (پیش‌فرض `www.google.com`).                              |
| `google_ip`           | IPای که برای فرانت TCP-connect می‌شود (با `python main.py --scan` پیدا می‌شود). |
| `tcp_connect_timeout` | ثانیه‌ی تایم‌اوت اتصال به TLS بالادست گوگل.                                    |

تنظیمات ریز تونل (تکه‌بندی، long-poll و …) به‌صورت ویژگی‌های کلاس روی `ProxyServer` در [src/proxy/proxy_server.py](src/proxy/proxy_server.py) تعریف شده‌اند: `_TUNNEL_UPLOAD_CHUNK`, `_TUNNEL_POLL_LONG_MS` و … . مقادیر پیش‌فرض برای پلن رایگان تنظیم شده‌اند.

---

## عیب‌یابی

**`curl` کار می‌کند ولی مرورگر می‌گوید "connection closed".**
معمولاً یا گواهی MITM محلی trust نشده، یا SOCKS5 را در مرورگر گذاشته‌اید ولی DNS هنوز از resolver سیستم می‌رود (در فایرفاکس **Proxy DNS when using SOCKS v5** را تیک بزنید). برای حالت MITM-HTTPS دستور `python main.py --install-cert` را اجرا کنید.

**اپس‌اسکریپت `{"error":"unauthorized"}` برمی‌گرداند.**
سه مقدار `AUTH_KEY` کاملاً یکی نیستند. `Code.gs`، `wrangler_tcp.toml` (`[vars] AUTH_KEY`) و `config.json` (`auth_key`) را دوباره چک کنید.

**`{"error":"cf_status_500"}` یا `cf_status_401`.**
اپس‌اسکریپت به Worker رسید ولی پاسخ غیر ۲۰۰ گرفت. `401` = AUTH_KEY بین اپس‌اسکریپت و Worker یکی نیست. `500` = خود Worker خطا داشته — با `wrangler tail` خطای زنده را ببینید.

**اولین لود مرورگر هنگ می‌زند، در تلاش دوم باز می‌شود.**
DO در حال cold-start است؛ درخواست‌های بعدی به DO گرم می‌رسند. اگر ادامه‌دار شد، `wrangler tail` دلیل را نشان می‌دهد.

**سهمیه‌ی `UrlFetchApp` تمام شد.**
به سقف روزانه‌ی اپس‌اسکریپت خوردید. تا ریست بعدی (نیمه‌شب اقیانوس آرام) صبر کنید یا بار را روی چند `script_id` از اکانت‌های گوگل مختلف پخش کنید.

---

## قدردانی

- پروژه‌ی اصلی: [masterking32/MasterHttpRelayVPN](https://github.com/masterking32/MasterHttpRelayVPN). تمام اعتبار رله‌ی HTTP، ترفند domain fronting و پایه‌ی اپس‌اسکریپت متعلق به نویسنده‌ی اصلی است.
- این فورک مسیر داده‌ی TCP (Durable Object، پروتکل اَکشن‌محور، uploader/downloader هم‌زمان، مدل سهمیه‌ی long-poll) را اضافه می‌کند.

---

## سلب مسئولیت

این نرم‌افزار **همان‌طور که هست (AS IS)** فقط برای اهداف آموزشی و پژوهشی ارائه می‌شود. شما خودتان مسئول رعایت قوانین محلی و شرایط استفاده از سرویس گوگل، Cloudflare و هر شخص ثالث دیگر هستید. زدن سقف سهمیه‌ی Google Apps Script یا Cloudflare ممکن است به اقدامات اجرایی روی حساب شما منجر شود؛ این ریسک به عهده‌ی خود شماست.

</div>
