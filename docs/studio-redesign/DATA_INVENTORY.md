# Albayan Studio — Data inventory for the lawyer (task P3-22, decision D18)

> **Status:** draft for legal review, written on 2026-09-25 from the code as it is (repository HEAD `b02e4d7`).
> Every line names the record type, route, setting or script it rests on. Nothing here is a promise of what the code will do later.
> **[owner]** = a decision or a confirmation Albayan's owner must give. **[lawyer]** = a point the lawyer must confirm.
> Companion documents: [PLAN.md](PLAN.md) (§7.1 entities, §7.5 isolation, §7.7 tokens), [DECISIONS.md](DECISIONS.md) (D18, D22, D31), [PILOT_CONSENT.md](PILOT_CONSENT.md), the public page `/privacy` (`privacy.html`).

---

## ملخص بالعربية (للمالك والمحامي)

**ما هو استوديو البيان؟** جزء من تطبيق «البيان» يستخدمه عملاء البيان (أصحاب المحلات والعيادات والمتاجر) لطلب إعلان على فيسبوك وإنستغرام، ومتابعته، وإدارة محفظتهم، وضبط ردود تلقائية على تعليقات صفحاتهم المرتبطة، وفتح تذاكر مساعدة، وطلب خدمة تيك توك اليدوية. فريق البيان يراجع كل طلب بيده وينشئ الإعلان بيده في «مدير إعلانات ميتا» على حسابات البيان الإعلانية (القرار D26: الحسابات نفسها التي تستخدمها الوكالة).

**البيانات الشخصية التي نخزّنها لهذه الخدمة (كلها في قاعدة بيانات واحدة على خادم البيان):**

1. **حساب العميل:** الاسم والبريد الإلكتروني ونسخة مجزّأة من كلمة المرور (جدول `users`)؛ ينشئه موظف البيان (القرار D23). وسجلات الدخول: عنوان IP ونوع المتصفح لكل جلسة (جدول `sessions`) ولكل طلب إعادة تعيين كلمة مرور.
2. **طلبات الإعلان (`adCampaignRequests`):** اسم الطلب، نصوص الإعلان، الرابط، الاستهداف (مدن، أعمار، جنس، لغات، اهتمامات)، التواريخ، الميزانية، ملاحظات العميل، **صور الإعلان نفسها داخل السجل**، أسباب المراجعة، رقم الاستوديو `ALB-S-…`، أرقام ميتا، أرقام الصرف والتسوية.
3. **المحفظة:** دفتر الحركات (`walletTransactions`) وطلبات الشحن (`walletPaymentRequests`) بما فيها **صورة إيصال التحويل** وملاحظة العميل.
4. **رقم واتساب اختياري** (`studioProfiles`) يُحفظ فقط إذا وافق العميل صراحة (`whatsappConsent: true`) ويُحذف متى شاء.
5. **تذاكر المساعدة ورسائلها** (`supportTickets`, `supportTicketMessages`): الموضوع، الفئة، نصوص الرسائل (العميل والفريق)، وطلبات تيك توك بمعرّف الحساب `@…` وملاحظة الفريق.
6. **طلبات الإيقاف العاجل** (`studioStopRequests`) و**عناصر صندوق الوارد** (`studioActivity`): أرقام وأنواع وأوقات فقط، بلا نص حر.
7. **الصفحات المرتبطة والقواعد والمنشورات** (`socialPages`, `socialReplyRules`, `socialPosts`): أرقام صفحات ميتا واسم الصفحة، نصوص الردود والرسائل الخاصة، الكلمات المفتاحية، تعليقات المنشورات المجدولة وصورها.
8. **سجل الردود على التعليقات** (`socialReplyLog`): **معرّف صاحب التعليق في فيسبوك/إنستغرام** (`fromId`) ورقم التعليق ورقم المنشور وما أُرسل ومتى. نص التعليق يُستخدم في الذاكرة لاختيار الرد ولا يُخزَّن اليوم. صاحب التعليق شخص ثالث ليس عميلاً للبيان [lawyer].
9. **سجل التدقيق** (`audit_logs`): من فعل ماذا ومتى، برقم المستخدم؛ لا يحمل نصوص التذاكر ولا رقم الواتساب.
10. **تنبيهات الفريق** (`studioAlerts`) و**أختام الموظفين** على السجلات (من راجع، من وافق، من أكد الدفع): العميل يراها باسم «فريق البيان» فقط، والموظفون يرونها بالأسماء.

**من يرى ماذا؟** العميل يرى سجلاته فقط. **المراجع** (صلاحية `adsStudioReviewer`) يرى طلبات العملاء المرسلة والمقبولة والمرفوضة والموقوفة (لا المسودات)، وتذاكر الفريق (لا تذاكر الدفع والحساب)، وطلبات الإيقاف، ويصل إلى رقم واتساب العميل فقط عبر رابط مسجَّل في سجل التدقيق وبموافقة العميل. **المدير (admin)** يرى كل شيء، وهو وحده من يؤكد المدفوعات ويرى صور الإيصالات مع العميل ويشغّل إخفاء الهوية.

**كم نحتفظ بالبيانات؟**
- سجل التدقيق: **365 يوماً** افتراضياً (`ALBAYAN_AUDIT_LOG_RETENTION_DAYS`)، وتُحذف الأقدم عند تجاوز 500,000 سجل، **ما عدا 19 نوعاً من العمليات تُحفظ للأبد** (القائمة `_AUDIT_KEEP_ACTIONS` في `server/main.py`؛ انظر الجدول أدناه).
- السجلات التجارية (الطلبات، المحفظة، التذاكر، الصفحات، الردود): **طالما الحساب نشط**؛ الحذف في التطبيق «حذف ناعم» يُبقي الصف.
- مدد القرار D31 (سجل الردود 12 شهراً، التنبيهات 6 أشهر، نصوص التذاكر المغلقة 24 شهراً) **توصية غير مبنية في الكود بعد** [owner].
- النسخ الاحتياطية: مشفّرة، 30 يوماً افتراضياً على الخادم (`ALBAYAN_BACKUP_RETENTION_DAYS`)، ونسخة خارجية اختيارية إن ضُبطت [owner].

**ماذا يمحو «إخفاء الهوية» (`POST /api/users/{id}/privacy-anonymize`)؟** الاسم والبريد وكلمة المرور والجلسات، ونصوص سجل التدقيق الخاصة بالشخص، ثم (الدالة `scrub_studio_personal_data_conn`): رقم الواتساب ووقت موافقته، معرّفات أصحاب التعليقات في سجل الردود، مواضيع التذاكر ونصوص رسائلها ومعرّف تيك توك وملاحظته، نصوص قواعد الرد وأسماء الصفحات وتعليقات المنشورات وصورها. **ما لا يُمحى:** دفتر المحفظة، طلبات الشحن **وصورة الإيصال**، طلبات الإعلان **بنصوصها وصورها**، نتائج ميتا، عناصر الوارد، التنبيهات (بمعرّف الحساب الداخلي فقط). هذه فجوة يجب أن يقررها المالك ويقيّمها المحامي [owner] [lawyer].

**إلى أين تصل البيانات خارج البيان؟**
- **ميتا (فيسبوك/إنستغرام/واتساب):** الإعلان بنصوصه وصوره ينسخه الموظف بيده إلى مدير الإعلانات؛ اسم الطلب يدخل في اسم الحملة في ميتا (`ALB-S-… · اسم الطلب`)؛ الردود والرسائل الخاصة تُرسل إلى صاحب التعليق؛ المنشورات المجدولة تُنشر على الصفحة؛ ونقرأ من ميتا التعليقات وحالات الإعلان والصرف ومنشورات الصفحة. رقم واتساب العميل يصل إلى واتساب عندما يفتح الموظف رابط `wa.me` من هاتفه (لا يوجد ربط برمجي).
- **مزوّد الاستضافة Libyan Spider JPaaS (Jelastic):** الخادم وقاعدة البيانات PostgreSQL والنسخ الاحتياطية.
- **قناة تنبيه الفريق** (`ALBAYAN_ALERT_WEBHOOK_URL`، إن ضُبطت): نوع التنبيه ورقم التذكرة ورقم الاستوديو وأعداد فقط، بلا أسماء ولا أرقام هواتف ولا نصوص [owner: أي أداة دردشة؟].
- **تيك توك:** لا يُرسل شيء؛ الموظف قد يفتح رابط الحساب بيده.

**ما يحتاج قرار المالك [owner]:** مدد الاحتفاظ D31 وصور الإيصالات وصور الإعلانات بعد إخفاء الهوية؛ هل قناة التنبيه والنسخة الخارجية مضبوطتان وعند أي مزوّد؛ تأكيد ساعات العمل والخط العاجل. **ما يحتاج المحامي [lawyer]:** الأساس القانوني لمعالجة معرّفات أصحاب التعليقات (أشخاص ثالثون)؛ التزامات حماية البيانات في ليبيا؛ نصوص الشروط (المسودة في `/privacy`) ونموذج موافقة التجربة؛ أسماء الموظفين كبيانات شخصية؛ كفاية «الحذف الناعم» والاستثناءات المالية.

---

## English detail

### 0. Scope and how to read this

- Covers the **Ads Studio** (service id `ad_maker`: ad requests, wallet use, results, help tickets, TikTok requests, the optional WhatsApp number) and the **Social Studio** (linked pages, auto-reply rules, scheduled posts, the reply log). Both live in `server/systems/ads_studio/` and own the record types listed in `server/systems/ads_studio/__init__.py` (`OWNED_TYPES`). Platform records they use (accounts, wallet ledger, payment requests, audit log) are included because the studio reads or writes them through platform doors (`docs/SMART_SYSTEMS.md`).
- All records are rows of one PostgreSQL database on the production server (`entities` table: `type`, `id`, `created_by`, `data_json`, `deleted` flag; plus the `users`, `sessions`, `password_resets` and `audit_logs` tables, `server/db.py`).
- "Anonymisation" means the admin route `POST /api/users/{id}/privacy-anonymize` (`server/main.py`, `_privacy_anonymize_deleted_user_atomic`), which the studio extends with `studio_privacy.scrub_studio_personal_data_conn` (`server/systems/ads_studio/studio_privacy.py`). It runs only after the account was disabled and a deletion request was verified by a person (the public `/delete-account` page describes the request path).

### 1. Roles: who can see what

| Role | How it is defined | What of a customer's data it can reach |
|---|---|---|
| **Customer** | The signed-in owner of the rows (`created_by` / `ownerId`) | Only their own rows. Every staff stamp on them (`reviewedBy`, `approvedBy`, `confirmedBy`, `canceledBy`, `linkedBy`, `resolvedBy`, `authorUserId`, …) is replaced by `team` and shown as "Albayan team" / «فريق البيان» (`studio_privacy.redact_staff_identity`, used by main.py's entity projection and by every `/api/studio` summary, P1-05). |
| **Reviewer** | The permission preset `adsStudioReviewer` (`src/04-permissions.js`): `adCampaignRequests: view, review` | Ad requests in status Submitted, Approved, Rejected or Stopped (`REVIEWER_VISIBLE_STATUSES`, `ad_campaign_actions.py`); never a Draft. Help tickets whose audience is `staff` (categories ad, page, tiktok, other); a payment or account ticket answers 404 (`studio_support.py`). The stop-request queue and the staff pulse (counts only). A customer's WhatsApp number only through the audited contact link (below). Sees staff stamps and names. |
| **Admin** | `role = admin` | Everything above, plus: confirms or cancels payment requests and sees receipt photos (`wallet_payments.py`, admin only), payment and account tickets, studio alerts, diagnostics (counts only), the audit log (`server/audit_routes.py`), settings, and the anonymisation route. |
| **System jobs** | The studio jobs loop (`studio_jobs.py`), the Meta worker, the operations worker | Write rows with no person (`created_by NULL`); they never send personal data anywhere (see §3). |

### 2. The inventory

Column "Reaches" names every place outside Albayan's own server the data goes to. "Kept" is what the code does today; the D31 periods are recommendations that are **not built** [owner].

| # | Data | Why it is kept (purpose) | Record / table | Who can see it | Kept for / anonymisation | Reaches |
|---|---|---|---|---|---|---|
| 1 | **Customer account:** name, e-mail, salted password hash, role, permissions | Sign-in, ownership of every row below | `users` table; created by an admin (D23: staff-assisted accounts, no self sign-up) | The person; admins; staff allowed to browse the user directory see names (`rbac.can_browse_user_directory`) | While active. "Delete" is a soft delete (the row stays for audit and money references). Anonymisation: name → "Deleted user", e-mail → `deleted-<hash>@privacy.albayanhub.com`, password replaced, permissions emptied, sessions and reset tokens revoked, `createdByName` stamps on the person's records removed. | Hosting provider only |
| 2 | **Sign-in and security records:** IP address, browser/user agent, times per session, per password-reset request and per app-login handoff | Security, session validity, abuse limits | `sessions`, `password_resets`, `app_logins` tables (`server/db.py`); rate-limit buckets by IP in memory (`server/auth_limits.py`) | The server (not shown in the studio) | Sessions expire (8 h by default, `ALBAYAN_SESSION_MS`; longer with "Remember me"). Anonymisation revokes them (`_revoke_user_credentials_conn`). | Hosting; Cloudflare's edge if in use (the server trusts `CF-Connecting-IP` behind the validated edge, `server/http_security.py`) [owner: confirm Cloudflare is in front of albayanhub.com] |
| 3 | **Ad requests:** name, objective/goal, page, primary text, headline, description, call to action, destination link, targeting (locations / Libya city keys, age range, genders, languages, interests), dates and days, budget, notes, **the ad photos themselves (inline, up to 7 MB each, `ad_campaign_fields.py`)**, the boosted post id, review history with reason codes (`budget_dates`, `creative_quality`, `text_policy`, `targeting`, `page_access`, `payment`, `other`), studio code `ALB-S-…`, Meta campaign/ad-account ids, spend and settlement figures, staff stamps | Providing the managed ad service; money settlement; audit of decisions | `adCampaignRequests` (fields: `AD_CAMPAIGN_ALLOWED_FIELDS`, `server/main.py`) | Owner (stamps redacted); reviewers for Submitted/Approved/Rejected/Stopped; admins | Business record while the workspace is active; archiving is a soft delete. **Not scrubbed by anonymisation** (texts and photos stay; only the `createdByName` stamp goes) [owner] [lawyer]. | **Meta:** staff type the texts and upload the photos by hand into Meta Ads Manager on Albayan's ad accounts (managed model, PLAN §4.4). At the desk link the Meta campaign is renamed `ALB-S-XXXXXXXX · <request name>` (`studio_types.studio_campaign_name`, P0-09b; needs the `ads_management` scope, else staff copy the name by hand). |
| 4 | **Meta results of a linked ad:** ad statuses, spend, impressions, result counts, read times, delivery start/end | Stages, "Meta used", settlement | `adCampaignResults` (`studio_results.py`; written by `studio_results_sync.py`) | Owner (results card), staff | Kept with the ad (D31). No personal data. | Read **from** Meta (Marketing API insights, studio lane). |
| 5 | **Wallet ledger:** every credit, hold, charge (`cpay:`), return (`rel:`, `stoprefund:`), transfer, admin credit/reversal, with amounts, currency, idempotency keys, references, actor stamps | Money history ("where every dollar is") | `walletTransactions` (platform door `wallet_payments.py`) | Owner (stamps redacted); admins | **Permanent and append-only; never scrubbed** (`scrub_studio_personal_data_conn` never touches the ledger). | Nobody |
| 6 | **Charge (top-up) requests:** amount, currency, payment method, customer note (≤ 500 chars), reference `PAY-…`, bank/gateway reference, **transfer-receipt photo** (JPG/PNG, ≤ 4 MB decoded), receipt note, exchange rate, confirm/cancel/override stamps | Crediting the wallet after a verified payment | `walletPaymentRequests` (`server/wallet_payments.py`, `server/schemas.py` `WalletPaymentRequestCreate`, `WalletPaymentReceiptAttach`) | Owner: full row including the photo (`GET /api/wallet/payment-requests/{id}`); admins: full row. List rows never carry the photo (`_photoCount` flag only). | Kept (money record). **The receipt photo is not removed by anonymisation or by any timer** [owner: decide a rule] [lawyer: is a bank receipt photo data that must be erased after a period?]. | Nobody (the bank transfer itself happens outside Albayan) |
| 7 | **Optional WhatsApp number** + consent time; the inbox "seen" marker | Staff can message the customer about an item when they agreed (D22, M15) | `studioProfiles` (`studio_profile.py`): stored only with `whatsappConsent: true`, in E.164 form | Only the person (`GET/PUT /api/studio/profile` take no user parameter). Staff: only through `GET /api/studio/staff/customers/{id}/contact` → 409 `NO_CONSENT` without consent; reviewers only for a customer with a visible request or a non-admin ticket; every hand-out is audited `contact_link` (kept forever) **without the number**. | Until the person removes it (`PUT` with an empty number) or anonymisation (number and consent time removed). The audit entry `studio_profile` says only "set / changed / removed". | **WhatsApp (Meta)** when a staff member opens the `wa.me` link on their own phone; there is no WhatsApp API integration. |
| 8 | **Help tickets and messages:** `T-000123` number, subject, category (ad, payment, page, account, tiktok, other), related item, status, times, every message text (customer and team), staff author ids; **TikTok requests:** handle `@…`, what is wanted, state, the team's bilingual note | Support; the TikTok manual service (M10, M11) | `supportTickets`, `supportTicketMessages` (`studio_support.py`) | Owner (team answers shown as "Albayan team"); reviewers for `audience: staff` tickets; admins for all (payment and account tickets are admin-only) | While the workspace is active. D31 recommends anonymising closed-ticket texts after 24 months — **not built** [owner]. Anonymisation removes: subject, `createFingerprint`, `tiktokHandle`, `tiktokNote` and every message text; ids, numbers, status and times stay. Audit entries (`ticket_create`, `ticket_message`, `ticket_status`, `tiktok_status`) carry the number, category and status, never a text. | The staff alert channel receives the **ticket number** of a stop request (never its text). TikTok: nothing is sent; staff may open the profile link by hand. |
| 9 | **Urgent stop requests:** campaign id, owner id, ticket id and number, times, due time, after-hours flag, state | The staff queue and its due times (M4) | `studioStopRequests` (`studio_stop.py`) | Staff; the owner sees the chip and the ticket | With the request; nothing to scrub (no free text). | Staff alert channel: kind `studio_stop:<T-number>`, the studio code, counts, times — never a name (`studio_alert_out.py`). |
| 10 | **Inbox / activity items:** kind, related ids, plain values (amount in minor units, a review reason code, the studio code, a ticket number) | The in-app inbox (M7) | `studioActivity` (`studio_activity.py`) | Owner only (SQL filter on `created_by`) | With the account; holds no free text and no staff id (titles are built on read), so anonymisation has nothing to remove. | Nobody |
| 11 | **Linked pages:** Meta page id, Instagram user id, page name, platform, health state, who linked it | Auto-replies, post picker, page-linked ads (M9) | `socialPages` (`social_studio.py`) | Owner; admins (link sheet) | Unlink keeps the row (relink revives it, P4-01). Anonymisation removes the page **name**; Meta ids stay. **Page access tokens are held in memory only, never stored** (`meta_ads.py`; evicted on 190/401/403, P0-07). | Meta (reads with the page token) |
| 12 | **Auto-reply rules:** name, keywords, public reply text, private message text, platform, scope / post ids / page refs, trigger, active-since | Answering comments (M8) | `socialReplyRules` | Owner; admins | Anonymisation removes name, keywords, `publicReply`, `dmText`. | **Meta:** the reply text is posted publicly under the comment; the private message is sent to the commenter (Facebook via `POST /{page-id}/messages`, Instagram DM) only on channels the capability setting allows (`studio_settings.py` `capabilities`). |
| 13 | **Scheduled page posts:** caption, media (photo), schedule, Meta post ids and results | Social Studio posts | `socialPosts` | Owner; admins | Anonymisation removes caption and media. | **Meta:** published on the page. |
| 14 | **Comment reply log:** owner id, page ids, platform, rule id, comment id, post id, **the commenter's Facebook/Instagram id (`fromId`)**, actions taken (public / dm / like), comment time, received/sent times, attempts, error class and Meta error code, source (webhook / poll / manual check), parked/retry/give-up fields, problem code | Answering each comment once, retries during a Meta outage, troubleshooting, latency metrics (M8, P3-18b, P4-02) | `socialReplyLog` (`social_studio.py`, row written in `process_comment`) | Owner: `GET /api/social-studio/log` shows the row **without the commenter id** (`_log_row_view`). Admins: counts in diagnostics. | **The comment text is used in memory to match rules and is not stored today.** D31 recommends 12 months — **not built** [owner]. Anonymisation removes `fromId` and any name/text field a later release might add (`REPLY_LOG_COMMENTER_FIELDS`). | **Meta:** comments arrive by webhook (`handle_meta_webhook`) or are read by the Instagram poll / admin check (`studio_ig_source.py`, `studio_ig_poll.py`); replies, likes and private messages go back to Meta. The commenter is a third person who is not Albayan's customer [lawyer]. |
| 15 | **Audit log:** time, acting user id, action, resource type and id, message, metadata | Security, accountability, money history | `audit_logs` table (`server/main.py` `audit()`, `server/audit_routes.py`) | Admins | **365 days by default** (`AUDIT_LOG_RETENTION_DAYS = read_env_int("ALBAYAN_AUDIT_LOG_RETENTION_DAYS", 365)`), and the oldest entries go when the log passes **500,000** rows (`ALBAYAN_AUDIT_LOG_MAX_RECORDS`). **Kept forever** (`_AUDIT_KEEP_ACTIONS`): `close`, `unlock`, `cleanup`, `import`, `restore`, `company_coverage`, `wallet_release`, `review`, `studio_setting`, `collision_repair`, `stop`, `withdraw`, `publish_status`, `stop_request`, `settle_override`, `contact_link`, `subscribe_smoke_test`, `ig_read_test`, `check_comments`. Anonymisation keeps action, resource and user ids of the person's rows and replaces the message with "Activity retained after account privacy anonymization" and the metadata with `{}`. What studio entries carry: ticket numbers/categories/status; "set/changed/removed" for the WhatsApp number (`studio_profile`), never the number; review reason codes (`review`); a setting's value before and after (`studio_setting`, kept forever) — this includes pilot allowlist **user ids** and the business's own contact numbers. | Nobody |
| 16 | **Studio alerts:** kind (the `ALERT_KINDS` list in `studio_jobs.py`, e.g. `review_overdue`, `stop_request_overdue`, `payment_confirm_overdue`, `integrity_violation`, `meta_connection_down`, `meta_token_expiring`, `meta_overspend`, `meta_drift`, `studio_funds_low`, `studio_account_inactive`, `studio_funds_unreadable`, `jobs_heartbeat_late`, `approval_interrupted`, `running_past_end`, `results_parked`), related type and id, owner id, day, counts, details (counts and request/user ids), who acknowledged | Operating the service (M17) | `studioAlerts` (`studio_jobs.py`) | Admins (`GET /api/studio/admin/alerts`) | D31 recommends 6 months for acknowledged alerts — **not built** [owner]. Not scrubbed (holds internal ids only). | **Staff alert channel** (`ALBAYAN_ALERT_WEBHOOK_URL`, `operations._send_alert`) for `CHANNEL_ALERT_KINDS`: `stop_request_overdue`, `meta_connection_down`, `meta_token_expiring`, `integrity_violation`, `studio_funds_low`, `studio_account_inactive`, `studio_funds_unreadable`, plus a new stop request and `jobs_heartbeat_late`. Payload: kind, English and Arabic titles, a short body with a `T-` number, an `ALB-S-` code, counts and times; **never a name, e-mail, phone number or text** (`studio_alert_out.py`, tested). |
| 17 | **Staff stamps and names** on customer records (who reviewed, approved, linked, confirmed, answered, acknowledged; `*ByName` copies) | Accountability | On the rows of items 3, 5, 6, 8, 11, 16 | Staff only; customers see "Albayan team" | With the record. Albayan's own staff are people too [lawyer: staff privacy]. | Nobody |
| 18 | **Studio settings:** switches, pilot allowlists (user ids), limits, working hours and holidays, the business's contact numbers, targets, thresholds | Running the service | `studioSettings` (`studio_settings.py`) | Admins; customers see only limits, hours and public contacts through `/api/studio/me` | Personal data only as user ids in the allowlists; every save audited with before/after values (`studio_setting`, kept forever). | Nobody |
| 19 | **Diagnostics, facts, baselines, staff pulse** | Owner's health numbers | `GET /api/studio/admin/diagnostics`, `/admin/facts`, `/staff/pulse` | Admins / staff | Counts, flags and percentiles only; no names, e-mails or phones (tested, P0-05a). | Nobody |
| 20 | **Backups:** encrypted dumps of the whole database | Disaster recovery | Server volume, AES-GCM with `ALBAYAN_BACKUP_KEY` (`server/operations.py`) | Whoever holds the key and the volume | **30 days by default** (`ALBAYAN_BACKUP_RETENTION_DAYS`; the newest three files are never deleted). A backup contains every row above as it was, including rows anonymised later. | Optional off-site copy to an S3-compatible bucket (`ALBAYAN_BACKUP_S3_*`) [owner: is it configured, which provider, which country?]. |

### 3. Third parties and what reaches them

| Party | Role | What goes out | What comes in | Mechanism |
|---|---|---|---|---|
| **Meta Platforms** (Facebook, Instagram, WhatsApp) | Ad delivery, pages, comments | Ad texts and photos (by staff, by hand, in Ads Manager on Albayan's ad accounts); the Meta campaign name with the request's name; public replies, likes and private messages to commenters; scheduled posts; Meta ids of pages and campaigns | Comments (commenter id and text) by webhook or polling; ad statuses, spend and results; ad-account funds and status; the linked page's recent posts (public content, kept in memory only, `studio_posts.py`); token health (`debug_token`) | One system-user token `ALBAYAN_META_ACCESS_TOKEN` and page tokens in memory (PLAN §7.7); `appsecret_proof` on every call. Albayan is liable for the ads it runs under Meta's Self-Serve Ad Terms (PLAN §3.2) [lawyer]. |
| **Libyan Spider JPaaS (Jelastic)** | Hosting | The server, the PostgreSQL database and the backup volume | — | Production deployment (`docs/RELEASE_AND_SAFETY.md`; `privacy.html` already names the provider). [owner: hosting contract / data-processing terms for the lawyer] |
| **Cloudflare** | Edge in front of albayanhub.com | Request metadata (IP, headers) as for any proxied site | `CF-Connecting-IP` header | `server/http_security.py` [owner: confirm it is in use] |
| **Staff alert chat tool** (Slack / Google Chat / Discord shape) | Urgent staff notifications | Kind, bilingual titles, ticket number, studio code, counts, times; never personal data | — | `ALBAYAN_ALERT_WEBHOOK_URL`, `operations._send_alert` [owner: which tool, whose account] |
| **Off-site backup bucket** | Backup copy | Encrypted database dumps | — | `ALBAYAN_BACKUP_S3_*` [owner] |
| **Google (Gmail)** | Contact address on `/privacy` and `/delete-account` | Deletion and privacy requests sent by customers | — | `bashirdernawi1999@gmail.com` [owner: keep or replace with a business address] |
| **TikTok** | None | Nothing is sent; no API | — | Staff may open the profile link `tiktok.com/@…` by hand |

Albayan does not sell data, does not show third-party advertising in the app and has no analytics SDK in the studio screens (nothing in `src/systems/ads_studio/` calls an outside service).

### 4. Retention summary (as built)

| What | Rule in the code | Source |
|---|---|---|
| Audit log | 365 days by default; oldest removed above 500,000 rows; the 19 kept actions never removed; the cleanup writes its own `cleanup` entry | `server/main.py` `AUDIT_LOG_RETENTION_DAYS`, `AUDIT_LOG_MAX_RECORDS`, `_AUDIT_KEEP_ACTIONS`, `cleanup_old_audit_logs()`; `privacy.html` states the same (static test `privacy retention matches server default` in `scripts/test-mobile-ui.js`) |
| Business records (items 3–14, 16) | Kept while the workspace is active; deletions are soft (`deleted = true`); no timer removes them | `entities` table design |
| D31 periods (reply log 12 months; acknowledged alerts 6 months; closed-ticket texts anonymised after 24 months; results kept with the ad) | **Recommendation only, not implemented.** No studio job deletes or scrubs rows by age (grep of `server/systems/ads_studio/` finds no such job). | DECISIONS.md D31 [owner: decide the periods; then a task] |
| Sessions | Expire; revoked on anonymisation | `ALBAYAN_SESSION_MS`, `_revoke_user_credentials_conn` |
| Backups | 30 days by default, newest three kept; off-site copies follow the bucket's own rules | `server/operations.py` |
| Page tokens | Memory only; gone at restart or on an authorization error | `server/meta_ads.py` |

### 5. Anonymisation: exactly what goes and what stays

Runs inside one transaction after an admin disabled the account (`POST /api/users/{id}/privacy-anonymize`):

**Removed or replaced (main.py):** name, e-mail, password, permissions; sessions and reset tokens; the message and metadata of the person's audit rows; `createdByName` on every record the person created.

**Removed by the studio scrub (`scrub_studio_personal_data_conn`, idempotent):**
- `studioProfiles`: `whatsappNumber`, `whatsappConsentAt`;
- `socialReplyLog`: `fromId` (and `fromName`, `fromUsername`, `from`, `commenterId`, `commenterName`, `commentText`, `text`, `message` if a later release stores them);
- `supportTickets`: `subject`, `createFingerprint`, `tiktokHandle`, `tiktokNote`; `supportTicketMessages`: `text` (team answers included);
- `socialReplyRules`: `name`, `keywords`, `publicReply`, `dmText`; `socialPages`: `name`; `socialPosts`: `caption`, `media`.

**Stays (by design, "money history stays exact"):** the wallet ledger; charge requests **including the receipt photo and the customer's note**; ad requests **including texts, targeting, notes and photos**; Meta results; activity items; stop-request rows; alerts; ticket ids, numbers, statuses and times; Meta page and campaign ids; the internal account id as `created_by` on every row.

[owner] Decide whether receipt photos, ad photos and request texts should also be scrubbed (or removed after a period) — a new task if yes. [lawyer] Confirm the retained items are covered by the legal, tax or accounting grounds the privacy page names, and whether Libyan law adds duties.

### 6. Open items

**For the owner [owner]**
1. D31 retention periods (reply log, alerts, closed tickets) — decide, then they become a task; today nothing expires.
2. Receipt photos and ad photos after anonymisation (§5).
3. Is `ALBAYAN_ALERT_WEBHOOK_URL` configured, with which chat tool? Is the off-site backup bucket configured, with which provider and in which country? (P0-01(u), §2 item 20).
4. Confirm Cloudflare is in front of the domain and the hosting contract with Libyan Spider (for the lawyer's third-party list).
5. Confirm the working hours, holidays, Ramadan hours, the on-duty line and public contact numbers (`hours`, `contact` settings; all contact numbers are `null` today, so nothing is shown to customers yet).
6. Replace the Gmail contact address with a business address, or keep it.

**For the lawyer [lawyer]**
1. Legal basis for processing commenters' Facebook/Instagram ids (third persons) and for the auto-reply itself; whether the privacy page's wording (it already mentions commenter ids and comment texts) suffices.
2. Libyan data-protection duties (PLAN §3.2 item 6 calls this an assumption).
3. Staff members' names on customer records (item 17).
4. The retained money records after anonymisation (§5) against the stated legal/tax/accounting grounds.
5. The draft customer terms at the end of `/privacy` (P5-06) and the pilot consent form (`PILOT_CONSENT.md`).
6. Meta's Self-Serve Ad Terms: Albayan's liability for customers' ads and the advertiser-responsibility clause.
7. Trademark search for «استوديو البيان» / "Albayan Studio" (PLAN §3.2 item 1).
