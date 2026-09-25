# دليل التشغيل عند الأعطال — استوديو البيان (الإصدار 1) / Albayan Studio — Runbook v1

> **الحالة / Status:** مسودة للمالك، مهمة P3-15 من [PLAN.md](PLAN.md) §12.6. تُعتمد وتُتدرَّب عليها مرة قبل «المعاينة أ» (Preview A).
> Draft for the owner, plan task P3-15 (PLAN.md §12.6). It is approved and rehearsed once before Preview A.
>
> **التاريخ / Date:** 2026-09-25 · **الكود الذي يصفه / Code it describes:** الفرع `main` عند `b02e4d7` (المرحلة 13) / branch `main` at `b02e4d7` (stage 13).
>
> كل جملة هنا صحيحة عن الكود كما هو اليوم، وتذكر المسار أو الإعداد أو نوع التنبيه الذي تعتمد عليه. ما لم يُبنَ بعد مكتوب صراحةً.
> Every statement here is true of the code as it is today and names the route, setting, alert kind or script it relies on. What is not built yet is said plainly.
>
> **العلامات / Markers:** `[owner]` = قرار أو تأكيد من المالك / the owner decides or confirms · `[lawyer]` = يؤكده محامٍ / a lawyer confirms · `[developer]` = خطوة للمطوّر لا يفعلها المالك / a developer step, not the owner's.

---

## 0. قبل أن تبدأ: أدواتك الأربعة / Before you start: your four tools

كل صفحة عطل في هذا الدليل تبدأ بثلاث خطوات تستطيع فعلها بنفسك من هذه الأدوات، دون مطوّر.
Every incident page starts with three steps you can do yourself with these tools, without a developer.

### 0.1 شاشات المدير في البيان / The Albayan admin screens

| الشاشة / Screen | أين / Where | ماذا تجد / What you find |
|---|---|---|
| **مكتب المراجعة (الكلاسيكي)** / The classic review tab | `https://albayanhub.com/studio?tab=review` بحساب مدير أو مراجع / signed in as admin or reviewer | طابور الطلبات، أزرار الموافقة/التعديل/الرفض، ورقة «ربط حملة ميتا» و«إلغاء ربط حملة ميتا»، زر «افحص ميتا الآن»، زر «إيقاف واسترداد» / «إغلاق الحملة»، قسم تذاكر الفريق (طلبات الإيقاف مثبّتة في الأعلى)، وقسم **صحة الاستوديو** (للمدير فقط). / The requests queue, Approve / Request changes / Reject, the "Link Meta campaign" and "Unlink Meta campaign" sheets, "Check Meta now", "Stop & refund" / "Close campaign", the staff tickets section (stop requests pinned on top) and the admin-only **Studio health** section. |
| **مكتب الفريق الجديد (v2)** / The v2 Team desk | `?tab=review` عندما يكون `staffDesk` مفعّلاً / when `staffDesk` is on | أقسامه (Requests, Launch, Settle, Tickets, Health, More) تعرض اليوم «ما زلنا نبني هذا القسم» (`renderStudioV2Soon` في `15h-studio-shell.js`). **استخدم المكتب الكلاسيكي في كل الأعطال.** / Its sections all show "still being built" today. **Use the classic review tab for every incident.** |
| **مركز المتابعة اليومي (مدير البيان)** / Daily Control Center (Albayan Manager) | مدير البيان → مركز المتابعة / Manager → Control Center | زر «إنشاء نسخة مشفرة الآن» (`POST /api/admin/operations/backups/run`، 6 مرات في الساعة)، آخر نسخة احتياطية، إقفال الشهر. / "Create encrypted backup now" (6 per hour), the last backup, the month close. |
| **الإعلانات → ربط Meta (مدير البيان)** / Ads → Meta Sync (Manager) | مدير البيان → الإعلانات / Manager → Ads | حالة اتصال ميتا لمسار المدير (admin lane): «Albayan يحمي اتصال Meta… يستأنف خلال N دقيقة» عندما تطلب ميتا التمهل. / The admin lane's state: "Albayan is protecting the Meta connection… resumes in about N minutes" when Meta asks to slow down. |

### 0.2 عناوين تفتحها في المتصفح وأنت مسجّل الدخول كمدير / Addresses you open in the browser while signed in as admin

تسجيل الدخول يعمل بملف تعريف الارتباط (cookie)، فكل عنوان `GET` أدناه يُفتح مباشرة من شريط العنوان ويعرض JSON. لا يُعرض فيها اسم أو رقم هاتف أو رمز ميتا أبداً.
Sign-in is cookie based, so each `GET` address below opens straight from the address bar and shows JSON. None of them ever shows a name, a phone number or the Meta token.

| العنوان / Address | من / Who | ماذا يعرض / What it shows |
|---|---|---|
| `/api/health/ready` | الجميع / anyone | `ok`, `release` (وسم الإصدار الذي يعمل / the running release tag), `dialect` (يجب أن يكون `postgresql` / must be `postgresql`) |
| `/api/studio/admin/diagnostics` | مدير / admin (20 في الدقيقة / per minute) | `jobs` (نبض حلقة المهام / the jobs heartbeat), `metaLanes` (توقفات ميتا / Meta pauses), `operations.meta.connection` (حالة الاتصال / connection state), `operations.meta.token`, `operations.capacity.intake`, `operations.money.reconciliation`, `operations.goNoGo` (قواعد التوقف / the stop rules), `switches.envStudioV2` |
| `/api/studio/admin/alerts` | مدير / admin (30 في الدقيقة) | آخر التنبيهات (`kind`, `labels.ar/en`, `count`, `day`, `details`) الأحدث أولاً، و`jobs` نفسه / the latest alerts newest first, plus the same `jobs` |
| `/api/meta-ads/token-health` | مدير / admin | رمز ميتا: `isValid`, `daysLeft`, `dataAccessDaysLeft`, `missingScopes`, `stale`, `lastCheckError` |
| `/api/meta-ads/collisions` | مدير / admin (6 في الدقيقة) | إعلانات الاستوديو الموجودة في دفاتر مدير البيان (أعداد ومعرّفات وأعلام فقط) / studio ads found in Manager's books (counts, ids and flags only) |
| `/api/studio/admin/settings/intake` (وكذلك `rollout`, `capabilities`, `hours`, `contact`, `targets`, `thresholds`, `limits`, `settlement`) | مدير / admin | قيمة الإعداد الحالية و`version` الذي تحتاجه للحفظ / the current value and the `version` a save needs |
| `/api/social-studio/pages` | مدير / admin | كل الصفحات المربوطة مع `health` (الحالة والسبب وخطوة الإصلاح) / every linked page with its `health` (state, reason, fix) |
| `/api/studio/me` | أي مستخدم / any user | `ui` (`classic` أو `v2`), `intake.open`, `metaConnection` (لافتة انقطاع ميتا / the Meta banner flag) |

### 0.3 Libyan Spider (Jelastic)

- المتغيرات: **Application Servers > Variables** (`docs/OPERATIONS_SAFETY.md`). بعد تغيير متغير اضغط **Restart** (أو **Redeploy** بالوسم نفسه) على حاوية التطبيق `bashird/albayan`؛ التغيير لا يعمل قبل ذلك.
  Variables: **Application Servers > Variables**. After changing one press **Restart** (or **Redeploy** with the same tag) on the `bashird/albayan` app container; nothing changes before that.
- **Redeploy** يسحب الصورة من جديد ويستبدل الحاوية. يبقى: المتغيرات، قاعدة PostgreSQL (على عقدة مستقلة)، ومجلد النسخ `/var/lib/albayan`. يضيع: أي شيء كُتب داخل الحاوية خارج ذلك المجلد. أبقِ «Keep volumes data» مفعّلة (`docs/RELEASE_AND_SAFETY.md`).
  **Redeploy** pulls the image again and replaces the container. Kept: the variables, the PostgreSQL database (its own node) and the `/var/lib/albayan` volume. Lost: anything written inside the container elsewhere. Keep "Keep volumes data" ticked.
- سجل الحاوية: افتح Log للحاوية. السطر `[albayan] boot:` يقول أي إصدار يعمل ونوع قاعدة البيانات وهل مفتاح النسخ مضبوط. السطر `Refusing to serve on SQLite` يعني أن `DATABASE_URL` ناقص أو خاطئ.
  The container log: the `[albayan] boot:` line names the release, the database type and whether the backup key is set. `Refusing to serve on SQLite` means `DATABASE_URL` is missing or wrong.
- المتغيرات التي يذكرها هذا الدليل / Variables this runbook names: `ALBAYAN_META_ACCESS_TOKEN`, `ALBAYAN_META_APP_SECRET`, `ALBAYAN_META_APP_ID`, `ALBAYAN_META_AD_ACCOUNT_IDS`, `ALBAYAN_META_AUTO_IMPORT`, `ALBAYAN_STUDIO_V2`, `ALBAYAN_STUDIO_JOBS`, `ALBAYAN_ALERT_WEBHOOK_URL`, `ALBAYAN_BACKUP_KEY`, `ALBAYAN_BACKUP_DIR`, `DATABASE_URL`.
  (لا يوجد في الكود متغير `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` الذي تذكره الخطة: القرار D26 أبقى إعلانات الاستوديو على الحسابات نفسها. / The plan's `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` does not exist in the code: decision D26 kept studio ads on the same ad accounts.)

### 0.4 كيف تغيّر إعداداً من دون شاشة (طريقة وحدة التحكم في المتصفح) / How to change a setting without a screen (the browser-console method)

لا توجد اليوم شاشة في البيان لمفاتيح الاستوديو (`rollout`, `intake`, …): الطريق الوحيد هو `PUT /api/studio/admin/settings/{key}` (`server/systems/ads_studio/studio_api.py`). يقبل الخادم التغيير فقط من موقع البيان نفسه (فحص المصدر `require_same_origin`)، لذلك نفّذه من وحدة تحكم المتصفح **وأنت داخل الموقع**:
There is no screen in Albayan today for the studio switches: the only road is `PUT /api/studio/admin/settings/{key}`. The server accepts the change only from the Albayan site itself (the `require_same_origin` check), so run it from the browser console **while inside the site**:

1. افتح `https://albayanhub.com/studio` وسجّل الدخول كمدير. / Open the studio and sign in as admin.
2. اضغط **F12** → تبويب **Console**. / Press **F12** → the **Console** tab.
3. الصق السطر الأول (القراءة)، ثم الثاني (الحفظ). / Paste the first line (read), then the second (save).

```js
// 1) اقرأ الإعداد ورقم نسخته / read the setting and its version
let s = await (await fetch('/api/studio/admin/settings/intake')).json(); s
// 2) احفظ التغيير بنفس رقم النسخة / save the change with that same version
await (await fetch('/api/studio/admin/settings/intake', {
  method: 'PUT', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({expectedVersion: s.version, value: {open: false}})
})).json()
```

- `expectedVersion` = الرقم `version` الذي قرأته للتو (0 إذا لم يُحفظ الإعداد من قبل). إن حفظه مدير آخر بينكما يرد الخادم `409 VERSION_CONFLICT`: اقرأ من جديد ثم احفظ. / `expectedVersion` is the `version` you just read (0 when never saved). If another admin saved in between the server answers `409 VERSION_CONFLICT`: read again, then save.
- `value` قد يكون جزئياً: الحقول التي لا تذكرها تبقى كما هي. حقل مجهول → `400 UNKNOWN_FIELD` ولا يُحفظ شيء. / `value` may be partial: fields you leave out stay as they are. An unknown field → `400 UNKNOWN_FIELD` and nothing is saved.
- كل حفظ يُسجَّل في سجل التدقيق باسم `studio_setting` (القيمة قبل وبعد) ولا يُحذف أبداً. / Every save is audited as `studio_setting` (value before and after) and is never deleted.
- `[owner]` اطلب من المطوّر شاشة إعدادات إن كانت هذه الطريقة ثقيلة عليك. / Ask the developer for a settings screen if this method is too heavy.

### 0.5 قناة التنبيهات الخاصة بالفريق / The staff alert channel

- تعمل فقط إذا كان `ALBAYAN_ALERT_WEBHOOK_URL` مضبوطاً في Jelastic (`server/operations.py`). ترسل الاستوديو إليها (`studio_alert_out.py`): كل طلب إيقاف جديد (`studio_stop:<رقم التذكرة>`)، والتنبيهات من الأنواع: `stop_request_overdue`, `meta_connection_down`, `meta_token_expiring`, `integrity_violation`, `studio_funds_low`, `studio_account_inactive`, `studio_funds_unreadable`, و`jobs_heartbeat_late` من عامل العمليات. الرسالة تحمل عنواناً بالعربية والإنجليزية ورقم التذكرة أو رمز `ALB-S-` فقط؛ لا اسم ولا رقم هاتف.
  It works only while `ALBAYAN_ALERT_WEBHOOK_URL` is set in Jelastic. The studio sends: every new stop request, the alert kinds listed above and `jobs_heartbeat_late` from the operations worker. A message carries an Arabic and an English title and a ticket number or `ALB-S-` code only; never a name or a phone number.
- اختبار القناة (مرة كل 10 دقائق، من وحدة التحكم): / Test it (once per 10 minutes, from the console):
  `await (await fetch('/api/studio/admin/alert-channel/test', {method: 'POST'})).json()` → `{sent: true/false, configured: true/false}`. لا يوجد زر لهذا في الشاشات بعد. / There is no button for this in the screens yet.
- إن كانت القناة غير مضبوطة `[owner]`: البديل هو المكتب المفتوح على هاتف المناوب وخط الواتساب العاجل (D29). / If the channel is not configured `[owner]`: the fallback is the desk open on the on-duty phone and the urgent WhatsApp line (D29).

### 0.6 قواعد «أبداً» / The "never" rules

1. لا تعدّل دفتر المحفظة أو الطلبات بيدك في قاعدة البيانات أبداً. أي إصلاح يمر بإجراء P0-10: نسخة احتياطية مع إثبات استعادة، تقرير للقراءة فقط، قرارك المكتوب والموقّع، ثم معاملة واحدة مدقّقة يمكن التراجع عنها (`docs/RELEASE_AND_SAFETY.md`).
   Never edit the wallet ledger or the requests by hand in the database. Every repair follows P0-10: a backup with restore proof, a read-only report, your written and signed choice, then one audited, reversible transaction.
2. لا يحذف أحد صفاً فيه مال. سكربت الإصلاح نفسه يرفض ذلك (`scripts/studio_collision_repair.py`).
   Nobody deletes a row that carries money. The repair script itself refuses.
3. لا تلصق رمز ميتا أو مفتاح النسخ في محادثة أو صفحة أو صورة شاشة. إن تسرّب رمز: ألغِه في ميتا فوراً وأنشئ غيره (`deploy/README.md`).
   Never paste the Meta token or the backup key into a chat, a page or a screenshot. A leaked token: revoke it in Meta at once and create another.
4. لا «تجاوز تسوية» جماعي أثناء انقطاع ميتا (§3.2).
   No mass settle overrides during a Meta outage (§3.2).

---

## 1. فحص الخمس دقائق اليومي / The daily 5-minute check

افعله كل صباح عمل (وقت طرابلس). ضع علامة ✔ في ورقة المتابعة `[owner]`.
Do it every working morning (Tripoli time). Tick a follow-up sheet `[owner]`.

1. **الموقع يعمل** / **The site is up:** افتح `/api/health/ready` → `ok: true` و`dialect: "postgresql"` و`release` هو آخر وسم نشرته. / `ok: true`, `dialect: "postgresql"`, `release` = the last tag you deployed.
2. **الطابور** / **The queue:** مكتب المراجعة: كم طلباً بانتظار المراجعة؟ هل يوجد «عاجل: طلب إيقاف» في قسم التذاكر؟ (العدّاد الحي يقرأ `GET /api/studio/staff/pulse`: `waitingReview`, `stopRequests`, `openTickets`, `stopTicketsOpen` (تذاكر طلبات الإيقاف المفتوحة ضمن `openTickets`، حتى يُعدّ طلب الإيقاف مرة واحدة)، `paymentsWaiting`, `alerts`.) / The review tab: requests waiting? any "Urgent: stop request" in the tickets section? (The live counter reads `/api/studio/staff/pulse`.)
3. **رمز ميتا** / **The Meta token:** قسم «صحة الاستوديو» → بطاقة «رمز ميتا»: «صالح: نعم»، «الأيام المتبقية» أكثر من 14 (الإعداد `thresholds.tokenMinDaysLeft`)، «صلاحيات ناقصة: 0». / Studio health → "Meta token" card: Valid yes, Days left above 14, Missing permissions 0.
4. **التنبيهات** / **The alerts:** افتح `/api/studio/admin/alerts`. أي `kind` جديد اليوم (`day` = اليوم) من: `integrity_violation`, `approval_interrupted`, `stop_request_overdue`, `review_overdue`, `meta_connection_down`, `meta_token_expiring`, `studio_funds_low`, `studio_account_inactive`, `studio_funds_unreadable`, `jobs_heartbeat_late`, `results_parked`, `page_health_drop`, `instagram_comments_not_arriving`, `running_past_end`, `meta_drift`, `meta_overspend` → افتح صفحته في §3. / Any new kind today → open its page in §3.
5. **حلقة المهام والفحص المالي** / **The jobs loop and the money scan:** في الرد نفسه `jobs.late` يجب أن يكون `false`، و`jobs.lastIntegrityScanAt` يجب أن يكون بعد 04:00 اليوم بتوقيت طرابلس، و`jobs.lastIntegrityResult.total` = 0. / In the same answer `jobs.late` must be `false`, `jobs.lastIntegrityScanAt` after 04:00 Tripoli today, `jobs.lastIntegrityResult.total` = 0.
6. **ميتا لا تبطئنا** / **Meta is not pausing us:** `/api/studio/admin/diagnostics` → `metaLanes.appWide.paused: false` و`parkCount: 0` في المسارات الثلاثة (`admin`, `studio_results`, `page`). / `metaLanes.appWide.paused: false` and `parkCount: 0` on all three lanes.
7. **المدفوعات والنسخ الاحتياطية** / **Payments and backups:** مركز المتابعة: آخر نسخة مشفرة خلال 24 ساعة. `paymentsWaiting` في النبض ليس أكبر من 5 (وإلا انظر الملحق أ). / Control Center: last encrypted backup within 24 h. `paymentsWaiting` in the pulse not above 5 (else Appendix A).
8. **أموال الحساب الإعلاني** / **Ad-account funds:** بطاقة «أموال الحسابات الإعلانية (آخر قراءة)» في صحة الاستوديو، وفي مدير إعلانات ميتا: هل الرصيد يكفي لإعلانات الاستوديو الجارية؟ `[owner]` (D30). / The funds card in Studio health, and in Meta Ads Manager: enough for the running studio ads?

---

## 2. المفتاحان اللذان يحتاجهما كل عطل / The two switches every incident needs

### 2.1 إيقاف استقبال الطلبات الجديدة / Pause new ad requests (intake)

الإعداد `intake` (`studio_settings.py`): `open` و`maxSubmissionsPerDay` (1–500؛ الافتراضي 500 أي بلا سقف فعلي حتى تقرّر D29 `[owner]`). عندما يكون `open: false` يُرفض الإرسال الجديد فقط (409 برسالة عربية)؛ المسودات تُحفظ، وطلبات المراجعة الحالية والتذاكر والمحفظة لا تتأثر. المفتاح يعمل في الشاشة الكلاسيكية والجديدة معاً، ويقرأه الطلب في آخر خطوة قبل الإرسال.
The `intake` setting: `open` and `maxSubmissionsPerDay` (1–500; default 500 = no real cap until D29 is decided `[owner]`). With `open: false` only a NEW submit is refused (409, Arabic text); drafts still save, waiting requests, tickets and the wallet are untouched. It works in both layouts and is re-read right before a send.

```text
GET /api/studio/admin/settings/intake
→ {"key":"intake","value":{"open":true,"maxSubmissionsPerDay":500},"version":0,"updatedAt":null}

PUT /api/studio/admin/settings/intake        (Content-Type: application/json)
{"expectedVersion": 0, "value": {"open": false}}
→ {"key":"intake","value":{"open":false,"maxSubmissionsPerDay":500},"version":1,"updatedAt":"…"}
```

إعادة الفتح / Reopen: `{"expectedVersion": 1, "value": {"open": true}}`.

### 2.2 رفع السقف اليومي / Raise the daily cap

```text
PUT /api/studio/admin/settings/intake
{"expectedVersion": 1, "value": {"maxSubmissionsPerDay": 10}}
```

القيمة المقبولة 1 إلى 500. السقف يُعدّ حسب يوم طرابلس (`count_submissions_today`). قاعدة الخطة `[owner]`: السقف = floor(0.6 × دقائق المكتب اليومية ÷ الدقائق لكل إعلان)، يبدأ بـ 5 (§12.7).
Accepted 1 to 500, counted per Tripoli day. The plan's rule `[owner]`: cap = floor(0.6 × desk minutes per day ÷ minutes per ad), starting at 5 (§12.7).

### 2.3 إعادة العملاء إلى الشاشة الكلاسيكية / Send customers back to the classic layout

انظر §3.13. / See §3.13.

---

## 3. صفحات الأعطال / The incident pages

كل صفحة: كيف تلاحظه · من يتصرف · أول 3 خطوات (تفعلها أنت) · ما بعدها · هل نطفئ أو نعيد النشر؟ · رسالة للعميل · ممنوعات.
Each page: how you notice it · who acts · the first 3 steps (yours) · what follows · switch off or redeploy? · customer message · never.

### 3.1 رمز ميتا على وشك الانتهاء / Albayan's Meta token is expiring

**كيف تلاحظه / How you notice it:** تنبيه `meta_token_expiring` («رمز البيان في ميتا تنتهي صلاحيته قريباً») في `/api/studio/admin/alerts` وفي قناة الفريق، مرة واحدة عند كل عتبة: 14 و7 و2 يوماً (الإعداد `thresholds.tokenExpiryWarnDays`، `studio_alerts_meta.raise_expiry_alerts`)، لانتهاء الرمز أو لانتهاء «الوصول إلى البيانات». مراقبة ميتا تعمل كل 10 دقائق (`run_meta_watch`) ما دام `ALBAYAN_META_ACCESS_TOKEN` مضبوطاً، وتقرأ الرمز من ميتا مرة في اليوم.
Alert `meta_token_expiring` in the alerts list and the staff channel, once per threshold (14, 7, 2 days; setting `thresholds.tokenExpiryWarnDays`), for the token's expiry or its data-access expiry. The Meta watch runs every 10 minutes and reads the token from Meta once a day.

**من يتصرف / Who acts:** المالك (صاحب المستخدم النظامي في Business Manager، الحقيقة P0-01(p)) + المطوّر عند الحاجة. / The owner (the Business Manager person who owns the system user) + the developer if needed.

**أول 3 خطوات / First 3 steps:**
1. افتح مكتب المراجعة → «صحة الاستوديو» → بطاقة «رمز ميتا»: «الأيام المتبقية». (أو `/api/meta-ads/token-health` → `daysLeft` و`dataAccessDaysLeft` و`expiresAt`.) إن ظهر «فحص الرمز غير مُعدّ (ALBAYAN_META_APP_ID)» فالمتغيّر `ALBAYAN_META_APP_ID` أو `ALBAYAN_META_APP_SECRET` ناقص في Jelastic؛ أضفه وأعد التشغيل، وإلا لا يمكن فحص الرمز.
   Open the review tab → Studio health → "Meta token" card: Days left. (Or `/api/meta-ads/token-health` → `daysLeft`, `dataAccessDaysLeft`, `expiresAt`.) "The token check is not set up (ALBAYAN_META_APP_ID)" means that variable or `ALBAYAN_META_APP_SECRET` is missing in Jelastic; add it and restart, or the token cannot be checked.
2. في ميتا: **Business Settings → Users → System users → مستخدم البيان → Generate new token**، التطبيق نفسه والصلاحيات نفسها (القائمة المتوقعة في `EXPECTED_SCOPES`: `pages_manage_metadata`, `pages_messaging`, `pages_manage_engagement`, `pages_read_engagement`, `pages_show_list`, `ads_read`, `ads_management`, `business_management`) وصلاحية 60 يوماً (D35). انسخه مرة واحدة إلى مدير كلمات المرور. `[owner]` أكّد الشاشة الدقيقة في أول تدريب: الخطة تقول «جدّد داخل المهلة، وأنشئ جديداً بعد الانتهاء» (§7.7).
   In Meta: Business Settings → Users → System users → Albayan's system user → Generate new token, the same app, the same permissions (the expected list is `EXPECTED_SCOPES`) and a 60-day expiry (D35). Copy it once into the password manager. `[owner]` confirm the exact Meta screen at the first rehearsal: the plan says "refresh within the window; a new token after expiry" (§7.7).
3. Jelastic → Application Servers > Variables → `ALBAYAN_META_ACCESS_TOKEN` = الرمز الجديد → **Restart**. ثم افتح `/api/health/ready` (يجب `ok: true`).
   Jelastic → Variables → `ALBAYAN_META_ACCESS_TOKEN` = the new token → **Restart**. Then open `/api/health/ready` (`ok: true`).

**ما بعدها / What follows:**
- القراءة المحفوظة تخص الرمز القديم، فتعرض `/api/meta-ads/token-health` لدقائق `stale: true` والرسالة «The saved reading is for an earlier token». مراقبة ميتا تقرأ الرمز الجديد في دورتها التالية (خلال 10 دقائق). للاستعجال، من وحدة التحكم: `await (await fetch('/api/meta-ads/token-health?refresh=1')).json()` (3 مرات كل 10 دقائق، مدقّقة `meta_token_health_check`). يجب أن ترى `isValid: true` و`daysLeft` نحو 60 و`missingScopes: []`.
  The stored reading belongs to the old token, so `token-health` shows `stale: true` for a few minutes. The Meta watch reads the new token on its next turn (within 10 minutes). To hurry, from the console: `fetch('/api/meta-ads/token-health?refresh=1')` (3 per 10 minutes, audited). You must see `isValid: true`, `daysLeft` ≈ 60 and `missingScopes: []`.
- ثم ألغِ الرمز القديم في ميتا `[owner]`. / Then revoke the old token in Meta `[owner]`.
- سجّل تاريخ الانتهاء الجديد في ورقة المتابعة (مراجعة شهرية، §12.7). / Record the new expiry date (monthly review, §12.7).

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. / Neither.
**رسالة للعميل / Customer message:** لا شيء. / None.
**ممنوع / Never:** لصق الرمز في محادثة أو صفحة البيان. / Pasting the token into a chat or an Albayan page.

### 3.2 اتصال البيان بميتا متوقف (رمز غير صالح أو ملغى) / Albayan's Meta connection is down (token invalid or revoked)

**كيف تلاحظه / How you notice it:** تنبيه `meta_connection_down` (يعدّ الردود المتوقفة) في القائمة والقناة. يُرفع فقط عندما يقول **فحص مباشر** في ميتا إن الرمز غير صالح (`is_valid` false أو خطأ 190 على الرمز نفسه)، لا عند فشل صفحة واحدة (190.492 = دور الصفحة فُقد يبقى مشكلة صفحة). يرى كل العملاء لافتة محايدة: «تحديثات فيسبوك وإنستغرام متأخرة حالياً…» (`/api/studio/me` → `metaConnection`)، وتظهر الصفحات المربوطة تسمية الاتصال بدل أسبابها. مشكلة شبكة مؤقتة لا تُعدّ «غير صالح»: تظهر `lastCheckError` فقط.
Alert `meta_connection_down` (counts the parked replies) in the list and the channel. Raised only when a DIRECT Meta check says the token is invalid (`is_valid` false or a 190 on the token itself), never for one page's failure (190.492, page role lost, stays per page). Every customer sees the neutral banner ("Facebook and Instagram updates are delayed right now…"); linked pages show the connection label instead of their own reasons. A network problem is not "invalid": only `lastCheckError` appears.

**من يتصرف / Who acts:** المالك + المطوّر. / The owner + the developer.

**أول 3 خطوات / First 3 steps:**
1. تأكّد: صحة الاستوديو → بطاقة «رمز ميتا» تقول «صالح: لا»، أو `/api/studio/admin/diagnostics` → `operations.meta.connection.state: "down"` مع `since` و`errorCode`. إن كان `token-health` يقول `stale` أو `lastCheckError` فقط (ميتا لم تجب) فانتظر 10 دقائق وأعد القراءة قبل أي شيء.
   Confirm: Studio health → "Meta token" says Valid no, or diagnostics → `operations.meta.connection.state: "down"` with `since` and `errorCode`. If `token-health` shows only `stale` or `lastCheckError` (Meta did not answer), wait 10 minutes and read again first.
2. أنشئ رمزاً جديداً للمستخدم النظامي في ميتا (خطوة 3.1 رقم 2؛ التجديد لم يعد ممكناً بعد الانتهاء أو الإلغاء).
   Create a new system-user token in Meta (step 2 of §3.1; refresh is no longer possible after expiry or revocation).
3. Jelastic → `ALBAYAN_META_ACCESS_TOKEN` → **Restart** → `/api/health/ready`.

**ما بعدها: ماذا يحدث للردود المتوقفة / What follows: what happens to the parked replies**
- أثناء الانقطاع تُحفظ الردود التي رفضتها ميتا بسبب الصلاحية (`parkedReason: meta_connection_down`، `social_studio.py`) ولا تُفقد. تعمل دورة إعادة المحاولة كل دقيقتين تقريباً وتفحص الرمز مرة كل 10 دقائق على الأكثر؛ عندما يعود الفحص «صالحاً» تُمسح الحالة العامة (`recoveredAt`) وتُرسل الردود المحفوظة تلقائياً: الرد الخاص حتى 7 أيام من وقت التعليق، والرد العام أو الإعجاب حتى 24 ساعة منه. ما تجاوز مهلته يُختم `missed_during_outage` ويظهر في سجل الردود (`GET /api/social-studio/log`؛ عدّاده في التشخيص `operations.replies`).
  During the outage, replies Meta refused for authorization are parked (`parkedReason: meta_connection_down`) and never lost. The retry pass runs about every two minutes and checks the token at most once per 10 minutes; once a check says valid, the global state clears and the parked replies are resent automatically: a private reply until 7 days after the comment, a public reply or a like until 24 hours after it. Past that window a reply is finished as `missed_during_outage`, visible in the reply log.
- **التسويات تنتظر.** قراءة النتائج من ميتا متوقفة، فيرفض زر «إغلاق الحملة» التسوية («Meta has not confirmed that this ad ended» / «The final amount is not ready until …»). لا تستخدم «تجاوز التسوية» للمدير (`POST /api/ad-studio/campaigns/{id}/settle-override`) بشكل جماعي لتجاوز الانقطاع: كل تجاوز يُدقّق `settle_override` ويُحفظ للأبد.
  **Settlements wait.** Meta results reads are down, so "Close campaign" refuses to settle. Do not use the admin settle override in bulk to get past the outage: every override is audited `settle_override` and kept forever.
- قاعدة توقف التجربة (§12.8): انقطاع الردود أكثر من 6 ساعات (`thresholds.replyOutageMaxHours`) → أوقف الاستقبال (§2.1) وأعد العملاء للكلاسيكي (§3.13) وخذ نسخة احتياطية.
  Pilot stop rule (§12.8): a reply outage longer than 6 hours → pause intake (§2.1), classic layout (§3.13), take a backup.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا؛ اللافتة تظهر وتختفي وحدها. / Neither; the banner comes and goes by itself.
**رسالة للعميل (إن سأل) / Customer message (if asked):** «نعمل على إصلاح اتصال البيان بميتا. ردودك وإعلاناتك ستتحدث تلقائياً بعد الإصلاح.» / "We are fixing Albayan's connection to Meta. Your replies and ads update automatically once it is fixed."
**ممنوع / Never:** تجاوز تسوية جماعي؛ حذف قواعد الرد «لتنظيفها». / Mass settle overrides; deleting reply rules "to clean up".

### 3.3 طلب إيقاف من عميل تأخر / A customer's stop request is overdue

**كيف تلاحظه / How you notice it:** عند إنشاء الطلب (`POST /api/ad-studio/campaigns/{id}/stop-request`) تُفتح تذكرة عاجلة من نوع `stop_request` وتصل القناة فوراً (`studio_stop:<رقم التذكرة>`) ويعدّها النبض في `stopRequests`. الموعد `dueAt` = `targets.stopRequestMinutes` دقيقة **عمل** (120 افتراضياً) بعد الطلب، حسب تقويم `hours` (طرابلس، العطل، رمضان). حلقة المهام تفحص كل 5 دقائق (`studio_stop.check_stop_requests`) وترفع `stop_request_overdue` («أوقف الإعلان في ميتا الآن») مرة لكل إعلان في اليوم بعد الموعد.
A stop request opens an urgent `stop_request` ticket, reaches the channel at once and is counted in the pulse. Its `dueAt` is `targets.stopRequestMinutes` WORKING minutes (120 by default) after the request, on the `hours` calendar. The jobs loop checks every 5 minutes and raises `stop_request_overdue` once per ad per day after that time.

**من يتصرف / Who acts:** المناوب (D29 `[owner]`: من هو؟ حتى أي ساعة؟ رقم الواتساب العاجل في الإعداد `contact.urgentWhatsapp` و`hours.onDutyUntil`). / The on-duty person (D29 `[owner]`: who, until when; the urgent WhatsApp line is the `contact.urgentWhatsapp` setting with `hours.onDutyUntil`).

**أول 3 خطوات / First 3 steps:**
1. مكتب المراجعة → قسم التذاكر: طلبات الإيقاف مثبّتة في الأعلى بشارة «عاجل: طلب إيقاف». افتح التذكرة واقرأ رمز الاستوديو `ALB-S-…` واسم الحملة.
   Review tab → tickets section: stop requests are pinned on top with "Urgent: stop request". Open it and read the `ALB-S-…` code and the campaign name.
2. **أوقف الحملة في Meta Ads Manager بنفسك** (ابحث بالرمز في اسم الحملة). البيان لا يستطيع إيقاف إعلان في ميتا اليوم: التكامل للقراءة فقط (`deploy/README.md`)؛ زر الإيقاف بلمسة واحدة مؤجل إلى R2.
   **Pause the campaign in Meta Ads Manager yourself** (search the code in the campaign name). Albayan cannot pause an ad in Meta today: the integration is read-only; a one-tap Pause is R2.
3. ردّ على التذكرة من الشاشة نفسها (تصبح «answered») وأخبر العميل أن الإعلان أُوقف. ثم اضغط «افحص ميتا الآن» على بطاقة الطلب (`POST /api/studio/campaigns/{id}/results/refresh`؛ ضغطة ثانية خلال 10 دقائق تعيد القراءة المحفوظة): عندما تُظهر قراءة ميتا أن الإعلان لم يعد يعرض، يُغلق صف الطابور وتذكرته تلقائياً (`resolvedReason: meta_paused`)، ويختفي من العدّاد.
   Reply on the ticket from the same screen (it becomes "answered") and tell the customer the ad is paused. Then press "Check Meta now" on the request card: once Meta's read shows nothing delivering, the queue row and its ticket resolve themselves (`meta_paused`) and leave the counter.

**ما بعدها: التسوية بعد القراءة النهائية / What follows: settle after the final read**
- المزامنة تقرأ الإعلان المربوط كل 15 دقيقة؛ عندما ينتهي العرض تختم `deliveryEndedAt` وتحدد القراءة النهائية `settleReadDueAt` = بعد 48 ساعة (الإعداد `settlement.spendDelayHours`، D28) ثم قراءة يومية لمراقبة الانحراف حتى 28 يوماً.
  The sync reads a linked ad every 15 minutes; when delivery ends it stamps `deliveryEndedAt` and sets the final read `settleReadDueAt` = 48 hours later (`settlement.spendDelayHours`, D28), then one drift read a day up to 28 days.
- بعد القراءة النهائية: زر «إغلاق الحملة» على بطاقة الطلب (`POST /api/ad-studio/campaigns/{id}/stop` مع `refundMinorUSD` و`closeReason: staff_stop`). الخادم يفرض: لا تسوية والإعلان يعرض (409 «Meta is still delivering this ad»)، ولا قبل القراءة النهائية («The final amount is not ready until <الوقت>»)، والمبلغ المسترجَع ≤ المدفوع − ما أكدته ميتا (400 فوقه). إعلان لم تعرضه ميتا أبداً (0 ظهور و0 دولار) يُسترجع كاملاً فوراً (`settleBasis: never_delivered`). حساب إعلاني لا يفوتر بالدولار → «This ad account does not bill in USD».
  After the final read: "Close campaign" on the request card. The server enforces: no settle while delivering, none before the final read, refund ≤ paid − Meta's confirmed spend. A never-delivered ad (0 impressions, $0) returns in full at once. A non-USD ad account is refused.
- تجاوز المدير (`settle-override`، سبب 10–300 حرفاً، مدقّق) للحالات الفردية فقط؛ فوق السقف يُرفع `meta_overspend` ويتحمل البيان الفرق (D27).
  The admin override (reason 10–300 characters, audited) is for single cases only; above the cap `meta_overspend` fires and Albayan absorbs the difference (D27).
- التذكرة تُغلق وحدها عند التسوية (`system_resolve_ticket_conn`). / The ticket resolves itself at settlement.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. / Neither.
**رسالة للعميل / Customer message:** «أوقفنا إعلانك. سنعيد ما لم تصرفه ميتا بعد أن تثبت أرقامها، عادةً خلال يومين إلى ثلاثة.» / "We stopped your ad. We return what Meta did not spend once its numbers settle, usually within two to three days."
**ممنوع / Never:** «إغلاق الحملة» بمبلغ استرجاع مخمَّن قبل القراءة النهائية. / Closing with a guessed refund before the final read.

### 3.4 ميتا أوقفت البيان مؤقتاً (حدود الاستخدام) / Meta paused Albayan (usage limits)

**ما يحدث / What happens:** لكل نداء إلى ميتا مسار (`server/meta_ads.py`، P3-00): `admin` (مزامنة مدير البيان)، `studio_results` (قراءة نتائج الاستوديو)، `page` (الردود على التعليقات ومنشورات الصفحات). ميتا ترد بأكواد أو رؤوس استخدام:
Every Meta call runs on a lane: `admin` (Manager sync), `studio_results` (studio results reads), `page` (comment replies and page posts). Meta answers with codes or usage headers:
- أكواد 4 / 17 / 613 أو رأس `x-app-usage` مرتفع → **توقف لكل المسارات** (`metaLanes.appWide.paused`). / App-wide codes or a high `x-app-usage` → all lanes pause.
- حد على حساب إعلاني → يُوقَف ذلك الحساب فقط في مسار النتائج (`results_parked`، 15 دقيقة، تنبيه مرة في اليوم لكل حساب). / An ad-account limit → only that account is parked on the results lane (`results_parked`, 15 minutes, one alert a day per account).
- حد على صفحة (أكواد 32 / 80001 / 80002 / 80006) → تُوقَف تلك الصفحة فقط، وتظهر بحالة `throttled` («تحدّ ميتا من هذه الصفحة لفترة؛ تعود الردود تلقائياً»)، والصفحات الأخرى تردّ. / A page limit → only that page is parked, health `throttled`; other pages keep replying.
- الاستخدام المرتفع (`usage_high`) يوقف المسار الذي رفعته ميتا فقط. / `usage_high` pauses only the lane the header names.

**من يتصرف / Who acts:** لا أحد في البداية. / Nobody at first.

**أول 3 خطوات / First 3 steps:**
1. اقرأ `/api/studio/admin/diagnostics` → `metaLanes`: `appWide.paused` و`retryAfterSeconds` و`reason`؛ ولكل مسار `paused`, `retryAfterSeconds`, `usagePercent`, `parkCount`, `parks[]` (آخر 4 أرقام من الحساب أو الصفحة ومدة الانتظار). في مدير البيان → الإعلانات → «ربط Meta» ترى الشيء نفسه لمسار المدير: «توقفت الطلبات مؤقتاً وستستأنف تلقائياً خلال حوالي N دقيقة».
   Read diagnostics → `metaLanes`: `appWide.paused`, `retryAfterSeconds`, `reason`; per lane `paused`, `retryAfterSeconds`, `usagePercent`, `parkCount`, `parks[]` (last 4 digits and the wait). Manager → Ads → Meta Sync shows the same for the admin lane.
2. لا تفعل شيئاً: الانتظار مبني في الكود ويستأنف وحده. لا تضغط «افحص ميتا الآن» أو «تحديث من ميتا» مراراً (كل زر محدود أصلاً، وكل ضغطة قد تطيل التوقف).
   Do nothing: the wait is built in and resumes by itself. Do not keep pressing "Check Meta now" or "Refresh from Meta" (each is rate-limited anyway, and each press can lengthen the pause).
3. إن بقيت **الردود** متوقفة أكثر من 6 ساعات (مسار `page` موقوف طوال المدة، أو `operations.goNoGo` يظهر قاعدة التوقف): طبّق قاعدة توقف التجربة (§12.8): أوقف الاستقبال (§2.1) وأخبر العملاء المتأثرين.
   If REPLIES stay paused longer than 6 hours (the `page` lane paused all that time, or `operations.goNoGo` shows the stop rule): apply the pilot stop rule: pause intake (§2.1) and tell affected customers.

**ما بعدها / What follows:** المطوّر يقرأ عدّادات الاستخدام (`usagePercent`) ويقلل الضغط إن تكرر (ميزانية القراءات لكل دورة: 5 قراءات نتائج و20 قراءة إنستغرام كل 30 ثانية). / The developer reads `usagePercent` and lowers the load if it repeats (per-tick budgets: 5 results reads, 20 Instagram reads per 30 s).

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. / Neither.
**رسالة للعميل / Customer message:** «ميتا تبطئ الطلبات مؤقتاً؛ سنكمل تلقائياً.» / "Meta is slowing requests for a while; we continue automatically."

### 3.5 الفحص المالي اليومي وجد مشكلة / The daily money scan found a problem (integrity violation)

**كيف تلاحظه / How you notice it:** تنبيه `integrity_violation` («وجد فحص الأموال اليومي مشكلة») في القائمة والقناة، مرة في اليوم، يحمل `details.violations[]` بكل نوع: `code`, `count`, `requestIds`, `userIds`, `labels.ar/en`. الفحص (`studio_integrity.scan_studio_money`) يعمل في حلقة المهام عند أول دورة بعد **04:00 بتوقيت طرابلس** ويقارن مصدرين مستقلين دائماً، ولا يصلح شيئاً أبداً. الأكواد: `wallet_identity_break` (أرقام المحفظة لا تتطابق)، `wallet_negative_available`، `hold_without_submitted_request`، `submitted_request_without_hold`، `capture_without_approval`، `stranded_capture` (مبلغ في طريقه للعودة منذ أكثر من ساعة)، `duplicate_return` (أكثر من استرجاع لدفعة)، `return_above_paid`، `request_payment_mismatch`، `request_refund_mismatch`، `refund_above_unspent`، `studio_in_core_books` (إعلان استوديو في دفاتر المدير)، `linked_name_without_code`، `check_failed` (الفحص نفسه لم يعمل). يظهر الملخص أيضاً في `jobs.lastIntegrityResult` (`total`, `byCode`). التنبيه القريب `approval_interrupted` (كل 5 دقائق: ميزانية دُفعت والطلب ما زال بانتظار المراجعة بعد 15 دقيقة) حادثة مالية أيضاً ولا يُرجع الكود المبلغ تلقائياً.
Alert `integrity_violation` once a day with `details.violations[]` (code, count, request ids, user ids, labels). The scan runs in the jobs loop at the first tick after 04:00 Tripoli, always compares two independent sources and never repairs. The codes are listed above; the summary is also in `jobs.lastIntegrityResult`. The neighbouring `approval_interrupted` (every 5 minutes: a budget paid while the request still waits for review after 15 minutes) is a money incident too, and the code never releases it by itself.

**من يتصرف / Who acts:** المالك يوقف ويحفظ؛ المطوّر يقيّم. / The owner pauses and backs up; the developer assesses.

**أول 3 خطوات / First 3 steps:**
1. أوقف استقبال الطلبات (§2.1). / Pause intake (§2.1).
2. مركز المتابعة → «إنشاء نسخة مشفرة الآن». / Control Center → "Create encrypted backup now".
3. افتح `/api/studio/admin/alerts`، ابحث عن `integrity_violation` اليوم، وأرسل إلى المطوّر الأكواد و`requestIds` كما هي. لا تلمس المحفظة ولا الطلبات ولا التسويات المذكورة.
   Open the alerts list, find today's `integrity_violation` and send the developer the codes and `requestIds` as they are. Do not touch the wallet, the requests or the settlements named.

**ما بعدها / What follows:**
- `[developer]` تقييم للقراءة فقط (قبل/بعد). أي إصلاح يمر بإجراء P0-10 فقط (§0.6): نسخة مع إثبات استعادة، تقرير، قرارك الموقّع، معاملة واحدة مدقّقة قابلة للتراجع. `check_failed` = خطأ في الفحص نفسه وليس في المال.
  `[developer]` a read-only before/after assessment. Any repair goes through P0-10 only (§0.6). `check_failed` is a fault in the scan itself, not in the money.
- **لا يوجد اليوم زر «أعد الفحص الآن».** الفحص المالي للاستوديو يعمل فقط في حلقة المهام اليومية؛ العنوان `GET /api/admin/data-integrity` هو فحص المنصة (العلاقات والتكرارات في `server/data_integrity.py`) ولا يتضمن فحوص أموال الاستوديو. `[developer]` يشغّل `run_daily_money_check` يدوياً عند الحاجة، وطلب زر لذلك مسجَّل كنقص.
  **Scan again now:** an admin can run the studio money scan on demand with `POST /api/studio/admin/integrity/scan` (once every 10 minutes; the answer is the same report as the daily scan and raises the same alert). In the Team desk: More > Diagnostics > "Scan money now" (افحص الأموال الآن) runs it and shows the number of findings; a second press within 10 minutes shows the wait. `GET /api/admin/data-integrity` is the platform scan and does NOT include the studio money checks.
- قواعد توقف التجربة (§12.8) التي تنطبق هنا: كسر معادلة المحفظة، `duplicate_return`، `stranded_capture` أكثر من ساعة، `studio_in_core_books` → أيضاً أعد العملاء إلى الكلاسيكي (§3.13) حتى ينتهي التقييم.
  Pilot stop rules that apply here: an identity break, `duplicate_return`, `stranded_capture` older than an hour, `studio_in_core_books` → also switch customers to classic (§3.13) until the assessment ends.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** إيقاف الاستقبال؛ الشاشة الجديدة تبقى إلا إذا كانت تعرض أرقاماً خاطئة. / Intake paused; the layout stays unless it shows wrong money.
**رسالة للعميل / Customer message:** لا شيء إلا إذا تأثر عميل؛ عندها رد شخصي في تذكرته بالأرقام. / None unless a customer is affected; then a personal ticket reply with the numbers.
**ممنوع / Never:** تعديل صفوف الدفتر يدوياً، «تصحيح» رصيد من الإدارة قبل التقييم، أو تسوية الطلبات المذكورة. / Editing ledger rows by hand, an admin "correction" before the assessment, or settling the requests named.

### 3.6 حلقة مهام الاستوديو متوقفة / The studio jobs loop is stale

**كيف تلاحظه / How you notice it:** تنبيه `jobs_heartbeat_late` («لم تعمل حلقة مهام الاستوديو منذ أكثر من 5 دقائق») من عامل العمليات (`operations._watch_studio_jobs`، كل 300 ثانية؛ تذكير كل 6 ساعات) في القناة والقائمة. الحلقة (`studio_jobs.py`) تكتب نبضاً كل 30 ثانية (`studioJobState.lastTickAt`) وتُعدّ متأخرة بعد 300 ثانية. تعرضه `jobs` في `/api/studio/admin/alerts` وفي التشخيص: `enabled`, `runningHere`, `lastTickAt`, `ageSeconds`, `late`, `lastSweepAt`, `lastIntegrityScanAt`, `lastError {job, error, at}`.
Alert `jobs_heartbeat_late` from the operations worker (every 300 s; a reminder every 6 hours). The loop writes a heartbeat every 30 s and is late after 300 s. `jobs` in the alerts list and the diagnostics shows `enabled`, `runningHere`, `lastTickAt`, `ageSeconds`, `late`, `lastError`.

**ما يتوقف معها / What stops with it:** إرجاع الحجوزات اليتيمة، تنبيهات التأخر (مراجعة/إيقاف)، الفحص المالي اليومي، مزامنة نتائج ميتا، مراقبة الرمز والأموال، فحص إنستغرام (poll). الطلبات والمحفظة والردود عبر الويب هوك تعمل. / Orphan releases, overdue alerts, the daily money scan, the results sync, the token and funds watch, the Instagram poll. Requests, the wallet and webhook replies keep working.

**من يتصرف / Who acts:** المالك يعيد التشغيل؛ المطوّر إن لم ينفع. / The owner restarts; the developer if that fails.

**أول 3 خطوات / First 3 steps:**
1. افتح `/api/studio/admin/alerts` واقرأ `jobs`. إن كان `enabled: false` فالمتغير `ALBAYAN_STUDIO_JOBS` مضبوط على `off` في Jelastic: احذفه (الافتراضي مفعّل) ثم Restart. إن كان `late: true` تابع.
   Open the alerts list and read `jobs`. `enabled: false` means `ALBAYAN_STUDIO_JOBS` is set to off in Jelastic: remove it (default on), then Restart. `late: true` → continue.
2. Libyan Spider → حاوية التطبيق → **Restart** (أو Redeploy بالوسم نفسه مع «Keep volumes data»). / Libyan Spider → the app container → **Restart** (or Redeploy with the same tag, Keep volumes ticked).
3. بعد دقيقة: `/api/health/ready` → `ok: true`، ثم `jobs.late: false` و`runningHere: true` (أول دورة بعد 15 ثانية ثم كل 30 ثانية). إن غطّت فترة التوقف الساعة 04:00 فالفحص المالي يعمل في أول دورة بعد التشغيل (اليوم لم يُختم في `lastIntegrityScanDay`).
   After a minute: `/api/health/ready` ok, then `jobs.late: false` and `runningHere: true`. If the stale period covered 04:00, the money scan runs on the first tick after the restart.

**ما بعدها / What follows:** إن بقي `late: true`: افتح سجل الحاوية، وأرسل السطور `[albayan]` و`jobs.lastError` إلى المطوّر. `[developer]` يعيد النشر إن فشل التشغيل. قاعدة توقف التجربة: تأخر أكثر من 15 دقيقة (`thresholds.heartbeatLateMaxMinutes`). / If still late: open the container log and send the `[albayan]` lines and `jobs.lastError` to the developer. Redeploy only if the restart fails. Pilot stop rule: late by more than 15 minutes.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** إعادة تشغيل؛ إعادة نشر فقط إن فشلت. / Restart; redeploy only if it fails.
**رسالة للعميل / Customer message:** لا شيء. / None.

### 3.7 ربط خاطئ بحملة ميتا / A wrong Meta link

**ما يفعله البيان عند الربط / What the link did:** ورقة «ربط حملة ميتا» (`POST /api/ad-studio/campaigns/{id}/publish-status`) تتحقق أن الحساب في القائمة المسموحة وأن الحملة فيه وأن اسمها يحمل رمز هذا الطلب `studioRef` وأنها غير مربوطة بطلب آخر، ثم «تدّعي» الحملة، وتعيد تسميتها في ميتا إلى `ALB-S-… · الاسم` عندما يملك الرمز `ads_management` (وإلا زر «نسخ الاسم»)، وتحذف نسخ مدير البيان التي لم تُلمس (`remove_untouched_copies`)، وتحتفظ بالنسخ التي فيها مال أو تعديل وتبلّغ عنها.
The link sheet checks the allowlisted account, the campaign in it, its name carrying this request's `studioRef` and no other link, then claims the campaign, renames it in Meta when the token has `ads_management` (else a Copy-name button), removes Manager's untouched copies and keeps and reports the ones with money or edits.

**من يتصرف / Who acts:** الموظف الذي ربط، أو المدير. / The staff member who linked, or an admin.

**أول 3 خطوات / First 3 steps:**
1. مكتب المراجعة → بطاقة الطلب: قارن رمز الاستوديو `ALB-S-…` واسم الحملة المربوطة مع ما في Ads Manager.
   Review tab → the request card: compare the `ALB-S-…` code and the linked campaign name with Ads Manager.
2. اضغط «إلغاء ربط حملة ميتا» (يظهر فقط لطلب معتمد مربوط؛ الطلب المتوقف يبقى مربوطاً)، اكتب السبب (3–300 حرفاً؛ إلزامي)، وأكّد. (`POST /api/ad-studio/campaigns/{id}/unlink-meta {operationId, expectedLastModified, reason}`، مدقّق `publish_status {unlink: true}`.)
   Press "Unlink Meta campaign" (shown only on an Approved, linked request; a Stopped one stays linked), write the reason (3–300 characters, required) and confirm.
3. اقرأ النتيجة على الورقة: «تم إلغاء الربط»، «أُعيدت N نسخة إلى مدير البيان» (`reverse_link_removal`)، «أعاد البيان اسم الحملة السابق في ميتا» (`renamedBack`). إن ظهر «لم يُعَد اسم الحملة في ميتا…» فأعد تسميتها بيدك في Ads Manager. ثم اربط الحملة الصحيحة بورقة الربط.
   Read the sheet's result: "Unlinked", "N copies restored to Albayan Manager", "Renamed back in Meta". If "The campaign name in Meta was not changed back…", rename it by hand in Ads Manager. Then link the correct campaign with the link sheet.

**ما بعدها / What follows:**
- إلغاء الربط يُرفض كله (423) عندما يكون الشهر المالي للنسخة المستعادة مقفلاً: افتح الشهر من مركز المتابعة بسبب مكتوب، ثم أعد المحاولة، ثم أقفله. / The unlink is refused whole (423) when the restored copy's financial month is closed: unlock the month in Control Center with a reason, retry, close it again.
- صف النتائج القديم يبقى تاريخاً، ومزامنة الحملة الجديدة تبدأ من الصفر. بوابات التسوية تبقى كما علّمها الربط (إلغاء الربط لا يفتحها). / The old results row stays as history; the new campaign's sync starts fresh. The settle gates keep what the link taught them (an unlink lifts none).
- النسخة المستعادة عادت إعلاناً لمدير البيان: تأكد أن مدير البيان لا يفوتر عميلاً عليها مرتين `[owner]`. / The restored copy is Manager's ad again: make sure Manager does not bill a customer twice on it `[owner]`.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. / Neither.
**رسالة للعميل / Customer message:** لا شيء (المرحلة تعود إلى «مقبول — نجهّزه في ميتا» ثم تتقدم بعد الربط الصحيح). / None (the stage returns to "Approved — being set up in Meta" and moves on after the right link).

### 3.8 إعلان من الاستوديو ظهر في مدير البيان / A studio ad found in Albayan Manager

**كيف تلاحظه / How you notice it:** الفحص اليومي يبلّغ بالكود `studio_in_core_books` داخل `integrity_violation` (ملاحظة: النوع `studio_core_collision` معرَّف في `ALERT_KINDS` لكن لا شيء في الكود يرفعه اليوم). التقرير الكامل: `GET /api/meta-ads/collisions` (`server/meta_collisions.py`): `count` وصف لكل إعلان متصادم بمعرّفه وسبب التصادم وأعلام المال (`receipts`, `collections`, `wallet`, `companyFunding`, `paymentState`) و`decisionFingerprint`. لا أسماء ولا أرقام.
The daily scan reports it as the `studio_in_core_books` code inside `integrity_violation` (note: `studio_core_collision` is declared in `ALERT_KINDS` but nothing raises it today). The full report is `GET /api/meta-ads/collisions`: a count and one row per colliding ad with its id, why it collides, money flags and a `decisionFingerprint`.

**لماذا يحدث / Why it happens:** مزامنة مدير البيان الآلية كانت تستورد حملات الاستوديو قبل P0-09؛ اليوم تتخطى الاكتشاف والاستيراد كل حملة اسمها يحمل `ALB-S-` أو ادّعاها طلب استوديو (`is_studio_campaign_name`, `claimed_campaign_ids`)، والربط يحذف النسخ التي لم تُلمس تلقائياً. ما يبقى: نسخ من قبل P0-09، أو نسخ فيها مال أو تعديل، أو ربط باسم بلا رمز.
Manager's automatic sync imported studio campaigns before P0-09; today discovery and import skip every campaign whose name carries `ALB-S-` or that a studio request claimed, and the link removes untouched copies. What remains: copies from before P0-09, copies with money or edits, or a link without the code.

**من يتصرف / Who acts:** المالك يقرر؛ المطوّر ينفّذ. / The owner decides; the developer runs it.

**أول 3 خطوات / First 3 steps:**
1. افتح `/api/meta-ads/collisions` واقرأ `count` والأعلام: أي الصفوف فيها مال (`receipts`/`collections`/`wallet`/`companyFunding`/`paymentState` = true). / Open the report and read the count and flags: which rows carry money.
2. **لا تحذف** الإعلان من شاشة الإعلانات في مدير البيان ولا تعدّله، ولا تسوّه في الاستوديو قبل القرار. / **Do not delete** the ad from Manager's Ads screen, do not edit it, and do not settle it in the studio before the decision.
3. مركز المتابعة → «إنشاء نسخة مشفرة الآن». ثم أرسل التقرير إلى المطوّر. / Control Center → backup now. Then send the report to the developer.

**ما بعدها: سكربت الإصلاح الموقّع من المالك / What follows: the owner-signed repair script** (`scripts/studio_collision_repair.py`؛ يحتاج `DATABASE_URL` وجهازاً يصل إلى قاعدة الإنتاج `[developer]`):
1. `python scripts/studio_collision_repair.py --report > ~/albayan-repairs/collision-report.json` (للقراءة فقط). / read-only report.
2. تكتب أنت `~/albayan-repairs/collision-choices.json` وتوقّعه باسمك والتاريخ: لكل `adId` إما `keep_in_manager` أو `remove_from_manager` مع `decisionFingerprint` من التقرير `[owner]`. / You write and sign the choices file: per `adId` `keep_in_manager` or `remove_from_manager` with its `decisionFingerprint` `[owner]`.
3. تجربة جافة (الافتراضي): `--choices <الملف>`. ثم التطبيق في معاملة واحدة: `--choices <الملف> --apply --confirm-database <اسم القاعدة> --actor <معرّف المدير>`؛ يُكتب ملف التراجع `collision-reversal-<id>.json` خارج المستودع قبل الحفظ. التراجع: `--reverse <ملف التراجع> --confirm-database …`. / Dry run (default), then apply in one transaction; the reversal file is written outside the repository before the commit; undo with `--reverse`.
4. الحذف حذف ناعم فقط، ويُرفض لأي صف فيه مال أو في شهر مقفل أو تغيّرت حقائقه منذ التقرير. `keep_in_manager` يُحفظ فلا يُعدّ الصف بعدها. كل شيء مدقّق `collision_repair` ويُحفظ للأبد (`privacy.html` يذكره). / Removal is a soft delete only, refused for any row with money, in a closed month or whose facts changed since the report. `keep_in_manager` is remembered. Everything is audited `collision_repair` and kept forever.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. إن كان السبب صورة أقدم من إصدار P0-09: انظر §3.11. / Neither. If the cause is an image older than the P0-09 release: §3.11.
**رسالة للعميل / Customer message:** لا شيء. / None.
**ممنوع / Never:** حذف صف فيه مال؛ تشغيل `--apply` بلا نسخة احتياطية وقرار موقّع. / Deleting a row with money; `--apply` without a backup and a signed choice.

### 3.9 أموال الحساب الإعلاني منخفضة أو الحساب غير نشط / Low ad-account funds or an inactive account

**كيف تلاحظه / How you notice it:** مراقبة ميتا تفحص كل 6 ساعات (`FUNDS_EVERY`, `studio_alerts_meta.check_studio_accounts`) كل حساب إعلاني يحمل حملة استوديو مربوطة ومعتمدة وغير مسوّاة، وتقارن رصيده بـ«التعرض» (ما دفعه العملاء − ما أكدته ميتا أنه صُرف): / The Meta watch checks every 6 hours each ad account carrying a linked, approved, unsettled studio campaign and compares it with the exposure (what customers paid − what Meta confirmed as spent):
- `studio_funds_low` «حساب إعلاني فيه إعلانات الاستوديو رصيده أقل مما تحتاجه هذه الإعلانات» (مسبق الدفع: الرصيد أو المتبقي من سقف الإنفاق أقل من التعرض؛ بالبطاقة: المتبقي من سقف الإنفاق). / prepaid funds (or spend-cap room) below the exposure; card-funded: spend-cap room.
- `studio_account_inactive` (`account_status` ≠ 1). / the account is not active in Meta.
- `studio_funds_unreadable` (ميتا لا تعرض الرصيد: لا «تحكم كامل» للمستخدم النظامي، أو حساب بغير الدولار، أو فشلت القراءة). / Meta does not show the funds: no Full control, a non-USD account, or a failed read.
- العميل يرى المرحلة 7 «مشكلة في التشغيل — الفريق يعالجها» عندما تقول ميتا `WITH_ISSUES` أو `PENDING_BILLING_INFO`؛ لا يرى كلمة «فوترة» أبداً. / The customer sees stage 7 "Delivery problem" for `WITH_ISSUES` / `PENDING_BILLING_INFO`, never the word "billing".
تصل الثلاثة إلى القناة. مرة واحدة لكل حساب ونوع في اليوم. **تأكيد الاطلاع:** يستطيع المدير تأكيد الاطلاع على تنبيه عبر `POST /api/studio/admin/alerts/{id}/ack` فيختفي من قائمة التنبيهات المفتوحة (تبقى في `?status=all`)؛ وفي مكتب الفريق زر «تأكيد الاطلاع» بجانب كل تنبيه مفتوح في المزيد ← التنبيهات (P3-23). ويتوقف التنبيه أيضاً عندما ينجح الفحص التالي.
All three reach the channel, once per account, kind and day. **Acknowledging:** an admin can acknowledge an alert with `POST /api/studio/admin/alerts/{id}/ack`; it leaves the open list (still in `?status=all`); in the Team desk every open alert in More > Alerts has an "Acknowledge" button (P3-23). The alert also stops when the next check passes.

**من يتصرف / Who acts:** المالك (Business Manager). / The owner.

**أول 3 خطوات / First 3 steps:**
1. في Meta Business Manager → Billing: اشحن الحساب مسبق الدفع أو أصلح وسيلة الدفع؛ إن كان الحساب معطَّلاً اتبع تعليمات ميتا لتفعيله. قاعدة D30 `[owner]`: رصيد ≈ 1.5 × متوسط الميزانيات المعتمدة أسبوعياً، شحن أسبوعي. / In Business Manager → Billing: top up the prepaid account or fix the payment method; a disabled account follows Meta's steps. D30 `[owner]`: float ≈ 1.5 × average weekly approved budgets, topped up weekly.
2. مكتب المراجعة: الطلبات في مرحلة «مشكلة في التشغيل» → «افحص ميتا الآن» بعد الشحن حتى تعود «يعمل الآن». / Review tab: requests in "Delivery problem" → "Check Meta now" after the top-up until they return to "Running".
3. صحة الاستوديو → بطاقة «أموال الحسابات الإعلانية (آخر قراءة)» و«تحديث من ميتا»: «الأموال ظاهرة: نعم». إن كان `studio_funds_unreadable`: امنح المستخدم النظامي **Full control** على الحساب في Business Settings (`deploy/README.md` §Meta) `[owner]`. / Studio health → the funds card and "Refresh from Meta": funds shown yes. For `studio_funds_unreadable`: give the system user **Full control** on the account `[owner]`.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. / Neither.
**رسالة للعميل / Customer message:** لا شيء (الفريق يصلحه قبل أن يلاحظ العميل). / None (staff fix it before customers notice).

### 3.10 صفحة توقفت عن الرد / A page stopped replying

**كيف تلاحظه / How you notice it:** شارة صحة الصفحة في «الصفحات والردود» عند العميل، وللمدير `GET /api/social-studio/pages` → `health {state, reason, label, fix, teamAction}`. تنبيهات: `page_health_drop` (أي سبب) و`instagram_comments_not_arriving`. الفحص اليومي لكل صفحة (`run_page_health_pass`، 5 صفحات كل ~20 دقيقة) والردود نفسها تكتب السبب (`_set_page_health`).
The page's health chip in Pages & replies, and for admins `GET /api/social-studio/pages` → `health`. Alerts: `page_health_drop` and `instagram_comments_not_arriving`. The daily per-page check and the replies themselves write the reason.

**الأسباب وخطوة الإصلاح (النصوص نفسها التي يراها العميل، `PAGE_HEALTH_LABELS`) / Reasons and their fix (the very texts the customer sees):**

| `reason` | التسمية / Label | الإصلاح / Fix | من / Who |
|---|---|---|---|
| `token_revoked` | توقف وصول البيان إلى هذه الصفحة / Albayan's access to this page stopped working | شارك الصفحة مع البيان مرة أخرى من Meta Business Suite ثم أبلغ الفريق / Share the page with Albayan again in Meta Business Suite, then tell the team | العميل / customer |
| `page_role_lost` | لم يعد للبيان دور على هذه الصفحة / Albayan no longer has a role on this page | أعد منح البيان صلاحية الوصول إلى الصفحة من Meta Business Suite / Give Albayan access again | العميل / customer |
| `permission_missing` | ينقص البيان إذن يحتاجه على هذه الصفحة / A permission is missing | امنح البيان وصولاً كاملاً إلى الصفحة (المحتوى والرسائل والتعليقات) / Give Albayan full access (content, messages, comments) | العميل / customer |
| `webhook_not_subscribed` | إشعارات التعليقات غير مفعّلة لهذه الصفحة بعد / Comment notifications not switched on yet | فريق البيان يفعّلها / The team switches them on | الفريق / team |
| `instagram_not_professional_or_unlinked` | ليس حساباً احترافياً مربوطاً بصفحة فيسبوك / Not a professional account linked to a Facebook page | حوّله إلى حساب أعمال أو صانع محتوى واربطه بالصفحة / Switch to business or creator and link it | العميل / customer |
| `instagram_private` (يضعه الفريق / staff-set) | الحساب خاص فلا تصل التعليقات / The account is private | اجعله عاماً ثم أبلغ الفريق / Make it public, then tell the team | العميل / customer |
| `instagram_comments_not_arriving` | التعليقات الجديدة لا تصل إلى البيان / New comments are not reaching Albayan | تأكد أولاً أن الحساب عام ثم أبلغ الفريق / First make sure it is public, then tell the team | العميل ثم الفريق / customer, then team |
| `throttled` | تحدّ ميتا من هذه الصفحة لفترة؛ تعود الردود تلقائياً / Meta is limiting this page; replies resume automatically | لا شيء؛ الفريق يتابع / Nothing; the team watches | لا أحد / nobody (§3.4) |

**أول 3 خطوات / First 3 steps:**
1. هل هو الاتصال كله؟ إن ظهرت لافتة «تحديثات فيسبوك وإنستغرام متأخرة» (أو `metaConnection` في `/api/studio/me`) فالسبب في §3.2 وليس في الصفحة. / Is it the whole connection? If the banner shows, go to §3.2, not the page.
2. هل القناة مفعّلة أصلاً؟ `GET /api/studio/admin/settings/capabilities`: `fbPublicReply`, `fbPrivateReply`, `igPublicReply`, `igPrivateReply` كل منها `on | poll | gated | off | unavailable` (الافتراضي: `gated` / `unavailable`). قناة `gated` أو `unavailable` لا ترسل أبداً ويظهر لها نص «بانتظار موافقة ميتا» / «غير متاح حالياً»: هذا ليس عطلاً بل قرار (D8a/D24b/D34 `[owner]`). / Is the channel switched on at all? A `gated` or `unavailable` channel never sends and says so: that is a decision, not a fault.
3. افتح سبب الصفحة (`reason`) واتبع صف الجدول. من صحة الاستوديو (للمدير): «اختبار الاشتراك» (`POST /api/studio/admin/pages/{id}/subscribe-test`، مرة في اليوم لكل صفحة)، ولإنستغرام «اختبار القراءة» و«افحص التعليقات الأخيرة الآن» (`POST /api/studio/admin/pages/{id}/check-comments`، مرة في الدقيقة؛ يردّ على التعليقات الجديدة فقط ولا يكرر رداً). ولإعادة فحص الصحة الآن: `POST /api/social-studio/pages/{id}/check` من وحدة التحكم (مرة في الدقيقة). / Open the page's `reason` and follow the table row. From Studio health (admin): "Test subscription", and for Instagram "Read test" and "Check recent comments now". To rerun the health check now: `POST /api/social-studio/pages/{id}/check` from the console (once a minute).

**ما بعدها / What follows:** عندما يؤكد العميل أن حساب إنستغرام خاص: `POST /api/social-studio/pages/{id}/health {"reason": "instagram_private"}` (مدير، مدقّق `page_health`)؛ و`{"reason": ""}` لمسحه. تعليق يصل يمسح أسباب إنستغرام وحده؛ رد ناجح يمسح `token_revoked` / `page_role_lost` / `permission_missing` / `throttled`. سجل الردود: `GET /api/social-studio/log` (المدير يرى الكل). / When the customer confirms a private Instagram: staff set `instagram_private`; an arriving comment clears the Instagram reasons; a successful reply clears the reply reasons. The reply log: `GET /api/social-studio/log`.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** لا. مفاتيح `capabilities` فقط عند قرار. / Neither. The `capabilities` switches only on a decision.
**رسالة للعميل / Customer message:** نص «الإصلاح» في الجدول نفسه يظهر له في الشاشة. / The table's fix text is what the screen already shows.

### 3.11 التراجع عن إصدار / Rolling back a release

**الوسوم / The tags:** كل نشر (`npm run release:image:push`, `scripts/publish-image.js`) يدفع `bashird/albayan:latest` ووسم تراجع فريداً `bashird/albayan:release-<12 من SHA>-<الوقت>` (يُطبع في نهاية السكربت ويظهر على Docker Hub). `/api/health/ready` → `release` يقول أي وسم يعمل الآن. النشر البديل من GitHub («Publish verified Docker image») يدفع `bashird/albayan:<SHA الكامل>`.
Every release pushes `latest` and a unique rollback tag `release-<sha>-<time>` (printed by the script; listed on Docker Hub). `/api/health/ready` → `release` says which tag runs now. The GitHub workflow pushes `bashird/albayan:<full sha>`.

**قاعدتا الصور (PLAN §12.5) / The two image rules (PLAN §12.5):**
- **لا تعُد أبداً إلى وسم أقدم من إصدار P0-09** (المرحلة 3، الالتزام `34c495e`) ما دام على الحسابات الإعلانية حملات استوديو مربوطة: صورة أقدم لا تعرف تخطّي `ALB-S-` والحملات المدّعاة، والاستيراد الآلي (مفعّل افتراضياً) يحوّل إعلانات الاستوديو إلى إعلانات «تحتاج إعداداً» غير مدفوعة في دفاتر المدير. إن كان ذلك حتمياً: أولاً `ALBAYAN_META_AUTO_IMPORT=false` في Jelastic (يتوقف الاستيراد الآلي للمدير أيضاً)، ثم التراجع، ثم `GET /api/meta-ads/collisions` بعده، والتقدم إلى إصدار جديد بأسرع وقت، ثم أعد تفعيل الاستيراد.
  **Never redeploy a tag older than the P0-09 release** (stage 3, commit `34c495e`) while studio campaigns are linked on the ad accounts: an older image knows no `ALB-S-` skip and the automatic import (on by default) turns studio ads into unpaid "needs setup" Manager ads. If truly unavoidable: first `ALBAYAN_META_AUTO_IMPORT=false` in Jelastic, then roll back, read `/api/meta-ads/collisions` afterwards, roll forward as soon as possible, then re-enable the import.
- **لا تعُد أبداً إلى وسم أقدم من إصدار ميزانيات P1** (المرحلة 6، الالتزام `c07e459`) ما دامت هناك طلبات يومية تحجز إجماليها: صورة أقدم تقرأ `budgetMinorUSD` كيوم واحد وتخصم يوماً واحداً فقط عند الموافقة. إن كان حتمياً: أوقف الاستقبال أولاً ولا توافق على أي طلب يومي حتى العودة إلى الأمام.
  **Never roll back to a tag older than the P1 budgets release** (stage 6, commit `c07e459`) while daily requests hold their full total: an older image reads `budgetMinorUSD` as one day and charges one day at approval. If unavoidable: pause intake first and approve no daily request until rolled forward.
- `[owner]` **سجّل وسمي Docker لهذين الإصدارين هنا** من Docker Hub (TASKS.md يسجّل وسم المرحلة 1 فقط: `release-8c082d71ed38-20260924T195027485Z`): P0-09 = `________`، ميزانيات P1 = `________`. / **Record the two Docker tags here** from Docker Hub (TASKS.md records only stage 1's tag): P0-09 = `________`, P1 budgets = `________`.

**من يتصرف / Who acts:** المطوّر؛ المالك يبلَّغ ويقرر التراجع. / The developer; the owner is told and decides.

**أول 3 خطوات (أنت) / First 3 steps (yours):**
1. أوقف الاستقبال (§2.1). إن كان العطل في الشاشة الجديدة فقط: أعد العملاء إلى الكلاسيكي (§3.13) **بدل** التراجع. / Pause intake. If only the v2 layout is broken: classic layout (§3.13) INSTEAD of a rollback.
2. مكتب المراجعة: اكتب قائمة طلبات الإيقاف المفتوحة وعيّن لكل منها شخصاً (§3.3): التراجع لا يلغيها لكنه قد يغيّر الشاشة. / List the open stop requests and give each an owner: a rollback does not cancel them but may change the screen.
3. مركز المتابعة → نسخة مشفرة الآن. ثم اختر الوسم وفق القاعدتين، وأرسله إلى المطوّر (أو نفّذ بنفسك: Jelastic → حاوية التطبيق → **Redeploy** → اكتب الوسم بدل `latest` → «Keep volumes data» → تأكيد؛ `docs/RELEASE_AND_SAFETY.md`). / Backup now. Pick the tag by the two rules and send it to the developer (or do it yourself: Jelastic → app container → Redeploy → type the tag instead of `latest` → Keep volumes → confirm).

**ما بعدها / What follows:**
- `/api/health/ready` → `release` = الوسم و`dialect: "postgresql"`. سجّل الدخول وجرّب إيصالاً وتوصيلاً ومركز المتابعة. / `release` = the tag, `dialect: "postgresql"`. Sign in and try one receipt, one delivery and the Control Center.
- `[developer]` إن كان الإصدار الأحدث أضاف ترحيل قاعدة بيانات (Alembic، `server/MIGRATIONS.md`) فقد لا تعمل الصورة الأقدم مع المخطط الجديد؛ يقرر المطوّر قبل الضغط. / If the newer release added a database migration the older image may not work with the new schema; the developer decides before pressing.
- الدفتر لا يُكتب إلا إضافة، فالتراجع لا يفقد سجلات مال. بعد تراجع إلى ما قبل P1 تتوقف حلقة المهام (لا كنس ولا فحص يومي): يجب فحص المال يدوياً كل يوم `[developer]` حتى العودة. / The ledger is append-only, so no money records are lost. After a rollback past P1 the jobs loop is gone (no sweep, no daily scan): the money must be checked by hand daily `[developer]` until rolled forward.

**رسالة للعميل / Customer message:** «نعمل على إصلاح عطل مؤقت. رصيدك محفوظ ولم يتغير.» / "We are fixing a temporary fault. Your balance is safe and unchanged."

### 3.12 استعادة نسخة احتياطية / Restoring a backup

**ما هو موجود / What exists:** التطبيق نفسه يأخذ نسخة مشفرة كل 24 ساعة إلى `ALBAYAN_BACKUP_DIR=/var/lib/albayan/backups` (على المجلد الذي يبقى بعد Redeploy) بالمفتاح `ALBAYAN_BACKUP_KEY` (في مدير كلمات المرور `[owner]`؛ ضياعه = لا استعادة)، وقد ينسخها إلى مخزن خارجي (S3) إن ضُبط. زر يدوي: مركز المتابعة → «إنشاء نسخة مشفرة الآن». الوثائق: `docs/OPERATIONS_SAFETY.md` §1–3، `deploy/README.md` «Safe backups and restores»، السكربت `scripts/restore-encrypted-backup.py` (يفك التشفير إلى ملف منفصل ولا يلمس القاعدة الحية أبداً)، و`python -m server.ops_backup backup|verify` كأداة ثانية.
The app takes an encrypted backup every 24 h to `/var/lib/albayan/backups` (a volume that survives Redeploy) with `ALBAYAN_BACKUP_KEY` (in the owner's password manager `[owner]`; losing it = no restore), optionally copied off-site. Manual button: Control Center → "Create encrypted backup now". Docs: `docs/OPERATIONS_SAFETY.md` §1–3, `deploy/README.md` "Safe backups and restores", `scripts/restore-encrypted-backup.py` (decrypts to a separate file; never touches the live database) and `python -m server.ops_backup`.

**من يتصرف / Who acts:** المطوّر (D29: المطوّر يقوم بإثباتات الاستعادة)؛ المالك يقرر التبديل. / The developer (D29: the developer does restore proofs); the owner decides the switch.

**أول 3 خطوات (أنت) / First 3 steps (yours):**
1. أوقف الاستقبال (§2.1) وأعد العملاء إلى الكلاسيكي (§3.13): هذه حالة «توقف» في §12.8. / Pause intake and classic layout: this is a §12.8 stop.
2. لا تستعد فوق القاعدة الحية والناس يعملون، ولا تحذف شيئاً من Jelastic. / Never restore over the live database while people use it; delete nothing in Jelastic.
3. أعطِ المطوّر: أي نسخة (التاريخ) ومن أين (المجلد أو المخزن الخارجي)، والمفتاح **بطريقة آمنة** لا عبر المحادثة. / Give the developer: which backup (date) and from where, and the key **securely**, never in chat.

**ما بعدها `[developer]` / What follows `[developer]`:** نسخ الملف إلى جهاز صيانة بالمفتاح نفسه → `restore-encrypted-backup.py <ملف> restored.dump` → `pg_restore --list` → استعادة في **قاعدة اختبار جديدة فارغة** → `/api/health/ready` وتسجيل دخول وفحص العملاء والإيصالات والإعلانات والأرصدة → عندها فقط قرار التبديل `[owner]` (مع النقاط الثلاث للمصالحة: ما أُضيف بعد وقت النسخة يضيع). / Copy the file to a maintenance machine with the same key → decrypt → `pg_restore --list` → restore into a **new empty test database** → check `/api/health/ready`, sign in, inspect → only then the switch decision `[owner]` (anything written after the backup time is lost).
- إثبات الاستعادة مطلوب قبل كل إصدار يمس المال (§11.3) وضمن «go» (`restoreProofMaxDays` = 7). التشخيص لا يسجّله (`goNoGo.restoreProof` = null): سجّله في ورقة المتابعة `[owner]`. / A restore proof is required before every money release and within the go rule (7 days). Diagnostics cannot record it: keep it on the follow-up sheet `[owner]`.

### 3.13 «الاستوديو يبدو خاطئاً للعملاء» / "The studio looks wrong for customers"

**المفاتيح / The switches** (`studio_settings.py`; PLAN §12.2):
- سجل `rollout`: `ui` (`off | pilot | on`) + `uiAllowlist` (معرّفات المستخدمين للتجربة)، `services` (`help`, `stopRequest`, `tiktok` كل منها `off | pilot | on`)، `staffDesk` + `staffAllowlist`. / The `rollout` record: `ui` + `uiAllowlist`, `services`, `staffDesk` + `staffAllowlist`.
- متغيّر البيئة `ALBAYAN_STUDIO_V2` (`off | pilot | on`؛ غير مضبوط أو مكتوب خطأً = `off`). **الأشد يفوز**: `off` في البيئة يفرض الكلاسيكي مهما قال السجل. يُقرأ عند كل طلب، لكن تغييره في Jelastic يحتاج Restart. / Env `ALBAYAN_STUDIO_V2` (unset or misspelt = `off`). **The stricter wins.** Read on every request, but changing it in Jelastic needs a Restart.
- إطفاء الشاشة الجديدة **لا يخفي أبداً** التذاكر ولا طلبات الإيقاف ولا مكتب الفريق (P3-20). إطفاء `staffDesk` يُرفض (409 `STAFF_DESK_IN_USE`) ما دامت تذاكر غير محلولة أو طلبات إيقاف مفتوحة. / Switching the layout off **never hides** tickets, stop requests or the Team desk. Switching `staffDesk` off is refused while unresolved tickets or open stop requests exist.
- يسري عند تحميل الصفحة التالي (الشاشة تقرأ `/api/studio/me` عند الفتح). رابط «العرض القديم» في رأس الشاشة الجديدة (§12.2(e)، P6-06) يخص التبويب الواحد فقط: يعيد هذا التبويب إلى الشاشة الكلاسيكية حتى يضغط المستخدم «الاستوديو الجديد»، ولا يغيّر شيئاً في الخادم ولا في السجل. / Effective on the next page load. The "Classic view" link in the new header (§12.2(e), P6-06) is per tab only: it draws the classic screens in that tab until the user presses "New studio", and changes nothing on the server or in the record.

**أول 3 خطوات / First 3 steps:**
1. مكتب المراجعة: اكتب طلبات الإيقاف العاجلة المفتوحة وعيّن لكل منها شخصاً (§12.5). / List the open urgent stop requests and give each an owner.
2. من وحدة التحكم (§0.4): / From the console:
   ```js
   let r = await (await fetch('/api/studio/admin/settings/rollout')).json(); r   // r.version, r.value.ui, r.envSwitch
   await (await fetch('/api/studio/admin/settings/rollout', {
     method: 'PUT', headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({expectedVersion: r.version, value: {ui: 'off'}})
   })).json()
   ```
   الرد يحمل `envSwitch` أيضاً لتعرف إن كانت البيئة تخفي الشاشة أصلاً. / The answer also carries `envSwitch`, so you see whether the env already hides the layout.
3. اطلب من العميل تحديث الصفحة: `/api/studio/me` عنده يجب أن يقول `ui: "classic"`. الخدمات (المساعدة، اطلب الإيقاف) تبقى في الشاشة الكلاسيكية. / Ask the customer to reload: their `/api/studio/me` must say `ui: "classic"`. Services (Help, Ask to stop) stay in the classic layout.

**ما بعدها / What follows:** إن كانت الشاشة الكلاسيكية نفسها أو الخادم معطلاً → §3.11. إن كان الخطأ أرقام مال → §3.5 أولاً. للعودة: `{ui: 'pilot'}` مع `uiAllowlist` لبضعة مستخدمين قبل `on`. / If classic itself or the server is broken → §3.11. Wrong money numbers → §3.5 first. To return: `pilot` with an allowlist before `on`.

**هل نطفئ أو نعيد النشر؟ / Switch off or redeploy?** مفتاح فقط. / The switch only.
**رسالة للعميل / Customer message:** «نعمل على إصلاح عطل مؤقت. رصيدك محفوظ ولم يتغير.» / "We are fixing a temporary fault. Your balance is safe and unchanged."

---

## الملحق أ: صفوف §12.6 الأخرى (باختصار) / Appendix A: the other §12.6 rows (short)

| الحادثة / Incident | من / Who | أول 3 خطوات / First 3 steps | ملاحظة من الكود / Code note |
|---|---|---|---|
| الخادم لا يجيب / Server down | المطوّر / developer | 1. `/api/health/live` (بلا قاعدة بيانات) ثم `/api/health/ready`. 2. Jelastic → سجل الحاوية → Restart. 3. إن كانت القاعدة غير متاحة (`database: "unavailable"`) اتبع `docs/RELEASE_AND_SAFETY.md`. / 1. `/api/health/live` then `/ready`. 2. Container log → Restart. 3. Database unavailable → RELEASE_AND_SAFETY. | مراقبة التشغيل تستخدم `/api/health/live` فقط. / Uptime monitors use `/api/health/live` only. |
| المدفوعات تتراكم / Payments piling up | المدير / admin | 1. النبض `paymentsWaiting` (للمدير فقط). 2. أكّد أو ألغِ بسبب من شاشة المدفوعات الكلاسيكية. 3. إن تجاوزت 5 غالباً: حساب مدير ثانٍ (D29 `[owner]`). | الهدف `targets.paymentConfirmMinutes` = 240 دقيقة عمل؛ نسبة الالتزام في `operations.queues`. لا يوجد تنبيه `payment_confirm_overdue` يُرفع في الكود اليوم. / No `payment_confirm_overdue` alert is raised today. |
| مراجعة متأخرة / Review overdue | المراجع / reviewer | تنبيه `review_overdue` بعد `targets.reviewBusinessDays` (1) يوم عمل. 1. افتح الطابور. 2. قرّر (موافقة/تعديل مع سبب/رفض مع سبب). 3. إن تكرر: خفّض السقف (§2.2). | كل 5 دقائق، مرة لكل طلب في اليوم. |
| موافقة توقفت في منتصفها / Approval interrupted | المدير / admin | تنبيه `approval_interrupted`. 1. افتح الطلب (`requestIds`). 2. أعد الموافقة (تعيد استخدام الدفعة نفسها) أو أعده للتعديل (يُرجع المبلغ). 3. لا تحرّر المبلغ بيدك. | الحلقة لا تُرجعه أبداً. / The loop never releases it. |
| رفض ميتا التحقق التجاري أو المراجعة / Business Verification or App Review refused | المالك / owner | 1. سجّل السبب في PLAN §14. 2. طبّق D34: `capabilities` → `unavailable` للقنوات المتأثرة (وتُعرض «غير متاح حالياً»). 3. المالك والمحامي `[lawyer]` يقرران إعادة التقديم أو كياناً آخر. | D8a = لاحقاً؛ الافتراضيات اليوم `gated`/`unavailable`. |
| موظف غادر / A staff member leaves | المالك / owner | 1. عطّل مستخدمه في البيان وأزل صلاحية المراجعة. 2. أزل أدواره في Business Manager والتطبيق والحسابات الإعلانية. 3. راجع سجل التدقيق لآخر 30 يوماً (`/api/audit`). | — |
| عميل يعترض على إنفاق ميتا / Customer disputes Meta spend | الفريق ثم المدير / staff, then admin | 1. بطاقة الطلب: `metaSpendAtSettleMinorUSD` و`settleBasis` وقراءات الانحراف (`meta_drift`). 2. قارن مع Ads Manager. 3. المدير يقرر رصيداً (مدقّق). | رد شخصي في التذكرة بالأرقام. |

---

## الملحق ب: أنواع التنبيهات التي يرفعها الكود اليوم / Appendix B: alert kinds the code raises today

(`studio_jobs.ALERT_KINDS`؛ الأنواع المعرَّفة التي لا يرفعها شيء اليوم: `reply_failure_burst`, `post_settle_spend_drift`, `studio_account_config`, `replies_parked`, `payment_confirm_overdue`, `storage_threshold`, `studio_core_collision`.)
(Declared kinds nothing raises today: those listed in brackets.)

| `kind` | المعنى / Meaning | القناة؟ / Channel? | الصفحة / Page |
|---|---|---|---|
| `meta_token_expiring` | رمز ميتا ينتهي خلال 14/7/2 يوماً / token expires in 14/7/2 days | نعم / yes | §3.1 |
| `meta_connection_down` | الرمز غير صالح؛ الردود محفوظة / token invalid; replies parked | نعم / yes | §3.2 |
| `stop_request_overdue` | طلب إيقاف تجاوز موعده / a stop request past its due time | نعم / yes | §3.3 |
| `results_parked` | قراءة نتائج حساب متوقفة دقائق / results reads of an account paused | لا / no | §3.4 |
| `integrity_violation` | الفحص المالي اليومي وجد مشكلة / daily money scan finding | نعم / yes | §3.5 |
| `approval_interrupted` | دُفعت الميزانية والطلب ما زال ينتظر / paid but still waiting | لا / no | ملحق أ / App. A |
| `review_overdue` | طلب انتظر المراجعة أكثر من الهدف / review past target | لا / no | ملحق أ / App. A |
| `jobs_heartbeat_late` | حلقة المهام لم تعمل 5 دقائق / jobs loop stale | نعم / yes | §3.6 |
| `studio_funds_low` / `studio_account_inactive` / `studio_funds_unreadable` | أموال الحساب الإعلاني / ad-account funds | نعم / yes | §3.9 |
| `page_health_drop` / `instagram_comments_not_arriving` | صفحة تحتاج انتباهاً / a page needs attention | لا / no | §3.10 |
| `running_past_end` | إعلان يعمل بعد موعد انتهائه / an ad active past its end | لا / no | أوقفه في Ads Manager ثم «افحص ميتا الآن» / pause it in Ads Manager, then Check Meta now |
| `meta_drift` | ميتا تُظهر صرفاً أكبر من المسوّى (> $0.50) / spend above the settled amount | لا / no | يدخل المصالحة الشهرية (D27) / monthly reconciliation |
| `meta_overspend` | تجاوز تسوية فوق السقف؛ البيان يتحمل الفرق / an override above the cap | لا / no | §3.3 |

---

## 4. قائمة التدريب قبل «المعاينة أ» / The rehearsal checklist before Preview A `[owner]`

يُتدرَّب على كل بند مرة واحدة على الأقل (على خادم التجربة المحلي أو بتجربة جافة في الإنتاج حيث يُذكر)، ويُسجَّل التاريخ ومن قام به. المهمة P3-15 تُعدّ منجزة عندما تُملأ كل الخانات وتوقّع.
Each item is rehearsed at least once (on the local test server, or as a dry run in production where noted), with the date and who did it. Task P3-15 is done when every box is ticked and signed.

- [ ] قرأت §0 كاملاً وفتحت كل عنوان في §0.2 من هاتفي وأنا مسجّل الدخول. / Read §0 and opened every §0.2 address from my phone while signed in.
- [ ] نفّذت §2.1 (إيقاف الاستقبال) ثم أعدت الفتح، ورأيت `version` يزيد و`studio_setting` في سجل التدقيق. / Paused and reopened intake; saw `version` grow and `studio_setting` in the audit log.
- [ ] رفعت السقف اليومي إلى القيمة المتفق عليها (D29): `______` / Raised the daily cap to the agreed value: `______`.
- [ ] §3.13: أطفأت الشاشة الجديدة (`ui: off`) وشاهدت الكلاسيكي بعد تحديث واحد، ثم أعدتها `pilot`. / Switched the layout off, saw classic within one refresh, set it back to `pilot`.
- [ ] §3.1/§3.2: أعرف شاشة ميتا لإنشاء رمز المستخدم النظامي، ومكان `ALBAYAN_META_ACCESS_TOKEN` في Jelastic، وضغطت Restart مرة ورأيت `/api/health/ready`. تاريخ انتهاء الرمز الحالي: `______`. / I know Meta's system-user token screen, the variable in Jelastic, pressed Restart once and saw `/ready`. Current token expiry: `______`.
- [ ] §3.3: فتحت طلب إيقاف تجريبي، أوقفت الحملة في Ads Manager، رددت على التذكرة، ورأيت الصف يُغلق بعد «افحص ميتا الآن». / Opened a test stop request, paused in Ads Manager, replied, saw the row resolve after Check Meta now.
- [ ] §3.4: قرأت `metaLanes` مرة وفهمت `retryAfterSeconds`. / Read `metaLanes` once and understood `retryAfterSeconds`.
- [ ] §3.5: أعرف أين أجد `details.violations` ومن أتصل به. رقم المطوّر: `______`. / I know where `details.violations` is and whom to call. Developer's number: `______`.
- [ ] §3.6: أعدت تشغيل الحاوية مرة ورأيت `jobs.late` يعود `false`. / Restarted the container once and saw `jobs.late` return to `false`.
- [ ] §3.7: ألغيت ربط طلب تجريبي بسبب مكتوب ورأيت النتيجة (النسخ المستعادة، الاسم). / Unlinked a test request with a reason and read the result.
- [ ] §3.8: فتحت `/api/meta-ads/collisions`؛ المطوّر شغّل `--report` وتجربة جافة على نسخة؛ عدد الصفوف اليوم: `______`. / Opened the collisions report; the developer ran `--report` and a dry run on a copy; rows today: `______`.
- [ ] §3.9: أعرف شاشة Billing في Business Manager ورصيد التعويم المتفق عليه (D30): `______`. / I know Business Manager Billing and the agreed float (D30).
- [ ] §3.10: فتحت `/api/social-studio/pages` ورأيت `health` لكل صفحة، وضغطت «اختبار الاشتراك» مرة. / Saw `health` per page and pressed Test subscription once.
- [ ] §3.11: سجّلت وسمي Docker لإصداري P0-09 وميزانيات P1 في §3.11، وأعرف خطوات Redeploy في Jelastic. / Recorded the two Docker tags in §3.11 and know the Jelastic Redeploy steps.
- [ ] §3.12: المطوّر أثبت استعادة نسخة في قاعدة اختبار خلال آخر 7 أيام؛ التاريخ: `______`؛ المفتاح في مدير كلمات المرور. / The developer proved a restore into a test database within the last 7 days; date; the key is in the password manager.
- [ ] §0.5: اختبار قناة التنبيهات وصل (`sent: true`) أو قررت البديل (D29). / The channel test arrived, or the fallback is decided.
- [ ] أسماء المناوبة وساعاتها وخط الواتساب العاجل محفوظة في الإعدادين `hours.onDutyUntil` و`contact.urgentWhatsapp` (D29). / On-duty names, hours and the urgent line saved in `hours.onDutyUntil` and `contact.urgentWhatsapp`.
- [ ] قرأ المحامي رسائل العملاء في هذا الدليل والقسم الخاص بالبيانات في `privacy.html` `[lawyer]`. / The lawyer read the customer messages here and the data section of `privacy.html`.
- [ ] الفحص اليومي (§1) نُفّذ خمسة أيام متتالية. / The daily check (§1) done five days in a row.

التوقيع / Signed: `______________`  التاريخ / Date: `__________`
