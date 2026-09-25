# Albayan Studio: redesign plan for the Ads Studio (phone-first, Arabic-first, managed now, automatic later)

> **Status:** approved by the owner on 2026-09-24 (planning only; implementation proceeds phase by phase).
> Companion files: [TASKS.md](TASKS.md) (every task with outcome, acceptance criteria and verification) and [DECISIONS.md](DECISIONS.md) (owner decisions, options, recommendations and the answers log).


**Iteration:** 4, round 1 of resolving the remaining significant issues (revised after review 4) · **Date:** 2026-09-24 · **Repository:** `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2` (HEAD `d7d627e`, clean tree) · **Mode:** planning only. Nothing was changed.

> **In plain words (for the owner).** We keep your current studio: the same login, wallet, data and staff review. It gets a new phone-first look, Arabic first with English available. Customers get five things.
> 1. **Ask for an ad and follow it.** Every ad shows its stage and who acts next. Once your team links an ad to Meta, the "in review", "running" and "rejected" stages come from **Meta's own report**. They never come from a button someone pressed.
> 2. **See their money in four clear numbers.**
>    - **Available:** money they can use now.
>    - **Reserved:** held for a request that is waiting for your team. It is still theirs.
>    - **In your ads:** paid. Part of it may come back when the ad ends.
>    - **Spent:** final.
> 3. **Comment auto-replies, stated honestly.**
>    - **Facebook:** public replies and likes work at launch, once our first check proves they work. We look at your existing reply records first, and run a live test only if we have to.
>    - **Instagram has two possible roads. We try both from week 1–2.**
>      - *Road 1 (a test in week 2):* if Albayan can read and answer comments on a customer's Instagram without Meta's approval, Instagram public replies work at launch. The server checks for new comments every few minutes, and the app says «يعمل — نفحص كل 5 دقائق».
>      - *Road 2 (Meta approval):* we record the **current** screens in English and apply as soon as Meta verifies Albayan as a business. We start that verification in week 1. We do **not** wait for the redesign. If Meta approves in time, Instagram replies are instant at launch.
>      - If neither road is ready on release day, Instagram shows «بانتظار موافقة ميتا». If Meta refuses to verify Albayan, it shows «غير متاح حالياً» (decision D34). The app never pretends.
>    - **Private messages** (on both platforms) wait for Meta's approval.
>    - If even the Facebook check fails, you decide whether to release with replies marked "waiting" (decision D24b).
> 4. **Help from your team (support tickets)**, linked to the exact ad, payment or page.
> 5. **A TikTok service request.** The customer tells us their TikTok account and your team helps by hand. Albayan does not reply automatically on TikTok, and the screen says so.
>
> **Money-safety rules underneath:**
> - Studio ads run on **their own Albayan ad account**, and every studio campaign name carries a studio code (decision D26). They never appear as unpaid "needs setup" work in your main ads books, so nobody can bill a customer twice.
> - Unused money comes back **about 2 days after the ad stops**, because Meta's own numbers keep changing for a couple of days. An ad that Meta never showed is returned at once.
> - Nobody can return money that Meta actually spent unless an admin writes down why.
> - Every money change is tested on the **same kind of database as your live server** (PostgreSQL) before release. From stage 0, one GitHub button runs every test and builds the release.
>
> **Running the service:**
> - Your team's desk shows a live counter and plays a sound when a stop request, a ticket or a new ad request arrives.
> - Urgent events also go to your team's **private alert channel**, if you set one up, so someone knows even when nobody has the desk open. These events are: a stop request, a failed money check, a broken Meta connection, or stopped background jobs.
> - The server warns you **14, 7 and 2 days before Albayan's Meta key expires**. If the connection breaks anyway, comments that arrive in the meantime are kept and answered after the repair, within Meta's time limits.
> - Outside working hours, a customer who needs an ad stopped urgently gets your on-duty WhatsApp number (decision D29).
> - One switch pauses **new** ad requests if the team is overloaded; customers' drafts are kept. The daily cap starts at 5 requests and is raised once staff time is measured.
> - A one-page playbook tells you what to do when something goes wrong.
> - The pilot has written pass and stop rules (decision D32).
>
> We build this in small stages, each with automatic tests. Each stage stays switched off for customers until you turn it on. Once the ads-and-money part is built, you and 2–3 friendly customers try it first (decision D20). **Realistic timeline: about 19–23 weeks (4.5–5.5 months) until every customer has it**, including a safety margin.

---

## 0. Context and evidence legend

### Why this plan exists
- **What prompted it.** The owner recorded about 8.5 minutes of a Libyan competitor app, "Bot Libya / BOTLI" (frames f000–f229). He wants Albayan's own Ads Studio (`/studio`) to meet the same customer needs, with its own identity, flows and copy.
- **The current studio works, but not well on phones.**
  - The server side is solid: submit/review/stop, the wallet ledger, plans and the auto-reply engine.
  - The screens are desktop-style: a five-step wizard with comma-separated text fields, a tab row that wraps, and money decisions made in `confirm()`/`prompt()` pop-ups.
  - It has known defects (§7.9).
  - It has no support tickets, no notifications, no TikTok and no link to real Meta results.
- **Intended outcome.** A first customer release, "Albayan Studio v2", containing all four items the owner required:
  - ad requests with tracking;
  - FB/IG comment auto-replies (Instagram depends on a week-2 test or on Meta approval; see §8.2, D24, D34);
  - support tickets;
  - TikTok as an honest managed service.

  It stays the same web app. It is rolled out customer by customer behind a switch, proven by tests at every stage, and operated with a runbook, a risk register and pilot pass/stop rules (§12).

### Owner's binding answers (applied throughout)
1. **Managed now, automatic later.** Staff review requests and launch them in Meta on Albayan's own ad accounts. The data is shaped so Marketing-API launch can be switched on after Meta approval.
2. **The first release includes everything:** ad requests and tracking, FB/IG comment auto-replies, support tickets, and TikTok (managed and honestly labelled).
3. **Budget only.** The customer pays the ad budget from the USD wallet; Albayan earns from LYD subscriptions. Available, reserved and spent are shown clearly. USD is for ads, LYD for plans.
4. **Phone-friendly web first.** This is a redesign of `/studio`; there is no store app.

### Evidence legend
| Label | Meaning |
|---|---|
| **[OBSERVED]** | Seen in the reference video frames (`fNNN`). |
| **[VERIFIED]** | Backed by an official doc URL (from the research part, or pages fetched on 2026-09-24) or by a code `file:line` that was read. |
| **[ASSUMPTION]** | Believed true but needs confirmation. Each one has a verification task or a decision. |
| **[RECOMMENDATION]** | My proposal; the owner can change it. |

### Findings verified in the code and Meta docs (iterations 1–4)
1. **[VERIFIED] A daily budget holds and charges only one day's amount.** The hold sums `budgetMinorUSD` (`server/wallet_payments.py:89-114`), and approval captures `budgetMinorUSD` (`:146-151`). When "Daily" is chosen, the builder saves the per-day amount (`src/15c-ads-studio.js:1247`). Fix: P1-06, P1-18 / D5, D33.
2. **[VERIFIED] The quick boost, as first designed, could not be submitted.** Strict submit requires `primaryText`, `destination`, CTA, dates and at least one image on every request (`server/ad_campaign_fields.py:493-516`). The boost rule only adds `sourcePostRef` (`server/ad_campaign_actions.py:131-137`). Fix: J3, P1-13 / D19.
3. **[VERIFIED] Approval moves the whole budget out of the wallet** (`wallet_payments.py:146-208`). `spendMinorUSD` is written only at stop (`ad_campaign_actions.py:296`). So "spent" cannot mean "charged". Fix: the money model in §7.8.
4. **[VERIFIED] Meta's campaign-level status never says "in review" or "rejected".** Campaign `effective_status` is one of ACTIVE, PAUSED, DELETED, ARCHIVED, IN_PROCESS, WITH_ISSUES (https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/). The ad level adds PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ADSET_PAUSED and `ad_review_feedback` (https://developers.facebook.com/docs/marketing-api/reference/adgroup/). So stages are read at ad level (§5.4).
5. **[VERIFIED] A late approval silently shortens the ad.** A start date that has passed moves to approval day while the end date stays. Approval is refused with 409 after the end date (`server/main.py:10488-10496`). Fix: `durationDays` (P1-11).
6. **[VERIFIED] Arabic-Indic digits typed as a budget become 0** (`15c:955`, `15c:1693`). `normalizeDigitsAscii` already exists in the startup bundle (`src/14-forms.js:5183`). Fix: P1-08b, P2-01.
7. **[VERIFIED] Arabic customers see raw English server errors.** The refusal map has 11 entries and falls back to the English `detail` (`15c:615-633`). Fix: P0-08, P1-08c, P2-11.
8. **[VERIFIED] The phone's Back button leaves the studio** (`updateUrlParams(..., true)` at `15c:145, 858, 947, 1503, 1534`; Android handler `src/01b-mobile-runtime.js:299-330`). Fix: P2-02b, P2-09.
9. **[VERIFIED] A withdraw that lands in the middle of an approval would lose track of the customer's money.** Approval captures (`cpay`) in its own committed transaction (`main.py:10513-10526`). It then writes Approved with a required version check (`main.py:10564-10586`; `server/schemas.py:286-291`). The 409 path does not return the capture (`main.py:10587-10594`). Fix: P1-03, P1-03b.
10. **[VERIFIED] Every ad on Albayan's allowlisted Meta accounts is imported into the core `ads` books as unpaid "needs setup" work.** Auto-import is on by default (`server/meta_ads.py:1020-1021`). It creates `paymentStatus:'pending_setup'` drafts (`meta_ads.py:3146-3206`), which the core treats as unpaid setup work (`src/13-filters-helpers.js:22, 208-232`; `src/12b-control-center.js:39-45`; `server/operations.py:379`). Fix: D26 / P0-09.
11. **[VERIFIED] All Meta calls share one lock and one global pause.** The lock is held for the whole HTTP call (`meta_ads.py:1224-1242`), and throttle codes set a global, persisted pause (`meta_ads.py:1115-1127`). Meta scopes these codes differently: 4 app, 17 user, 32 Pages, 613 custom, 80000 Ads Insights, 80004 Ads Management, 80003 Custom Audience, 80014 Catalog, 80001 Page, 80002 Instagram, 80006 Messenger [VERIFIED https://developers.facebook.com/docs/graph-api/overview/rate-limiting/, fetched 2026-09-24]. Fix: P3-00a–c, P4-04.
12. **[VERIFIED] Meta results can be unreadable while the ad itself is readable.** The code avoids a false $0 (`meta_ads.py:2351-2366, 4280-4310`). The staff refund limit uses `spendMinorUSD`, which stays 0 until stop (`ad_campaign_actions.py:245-261, 296`). Fix: P3-06a.
13. **[VERIFIED] Staff identities reach customers through money records** (`createdBy`/`createdByName`, `main.py:3971-3980`; `confirmedBy`/`canceledBy`/`receiptOverriddenBy`, `wallet_payments.py:652, 692, 734`; customers read both, `main.py:3910`). Fix: P1-05.
14. **[VERIFIED] The ad-account allowlist check fails open** when the list is empty (`meta_ads.py:1093-1098`). Fix: P0-09.
15. **[VERIFIED, closed]** An admin can set a customer's password (`main.py:13891-13896`). Ad-set `end_time` and campaign `stop_time` are already read (`meta_ads.py:2036-2049, 2396`).
16. **[VERIFIED] Every money-race test runs on in-memory SQLite, not on PostgreSQL (production).**
    - `npm run test:backend` uses `sqlite+pysqlite:///:memory:` (`scripts/test-backend.js:26`).
    - On SQLite, advisory locks are skipped (`main.py:4124-4128`) and `FOR UPDATE` is not issued (`ad_campaign_actions.py:196-197`); one process lock serialises everything.
    - A real-PostgreSQL suite exists (`server/test_postgres_financial_review.py`, Barrier harness), and CI runs it on every push in the `postgres-migration` job (`.github/workflows/ci.yml:3-5, 101-134`). But its scenarios contain no campaign lifecycle (`:32-34`), and the local release gate `release:quality` has no PostgreSQL step (`package.json:37`).
    - Production must be PostgreSQL (`docs/RELEASE_AND_SAFETY.md:63`; SQLite is refused at boot, `main.py:2424`).
    - Fix: P1-19, P0-11, §11.3.
17. **[VERIFIED] A preventive global Meta pause also exists.** When any usage header (`x-business-use-case-usage`, `x-ad-account-usage`, `x-app-usage`) reaches 85%, a process-wide pause with reason `usage_high` is set (`meta_ads.py:193-207, 289-320`). One reason variable is shared by everything (`:253-277`). Every call waits in one lock held through the HTTP call (`:1224-1242`), with 750 ms pacing (`:282-287`) and a 15 s default timeout (`:1036-1038`). Fix: P3-00a–c.
18. **[VERIFIED] The Social Studio worker starts only when a Meta token is set.** It is one sequential thread that publishes scheduled posts and retries replies (`server/social_studio.py:983-1027`). The browser-test server blanks the token (`scripts/start-e2e-server.js:49-51`). Money jobs must not live there. Fix: P1-21.
19. **[VERIFIED] Meta App Review needs screen recordings of the working feature.** The guide asks for "Screen recordings demonstrating how your app uses each permission", "Record the complete login flow" and "Use English as the app's UI language"; a permission is denied if reviewers cannot verify the need (https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings/, fetched 2026-09-24). The recordings **can be made on the existing classic screens** (finding 25). Fix: D8a/D8b, P1-23, P1-24.
20. **[VERIFIED] `entities.created_by` is a foreign key to `users.id`** (nullable) (`server/db.py:303`). SQLite does not enforce it (there is no `PRAGMA foreign_keys` anywhere), but PostgreSQL does. Fix: §7.1 rule, P1-19.
21. **[VERIFIED] No working-hours or holiday calendar exists** (0 matches for `business_day|working_hours|holiday`). Fix: P3-16.
22. **[VERIFIED] The lock order in the code differs from earlier plan text.** The stop route locks the campaign row first and never the user row (`ad_campaign_actions.py:192-202`). The approval capture takes the `cpay:` advisory key, then the campaign row (`wallet_payments.py:156-168`). `patch_entity` locks the row (`main.py:2095`). Fix: explicit lock table (§7.8).
23. **[VERIFIED] PostgreSQL JSON field reads parse the whole row** (`data_json::jsonb ->> 'field'`, `server/db.py:233-235`), including inline base64 images. Fix: P3-14.
24. **[VERIFIED] Other operating facts.**
    - There is one uvicorn process (`server/Dockerfile:113`; cross-process Meta coordination is required before adding workers, `docs/RELEASE_AND_SAFETY.md:90-93`).
    - The Capacitor app ships its own copy of the web files (`capacitor.config.json:4`) and is not yet published.
    - The data-integrity scan runs only on demand (`main.py:2727-2730`).
    - Meta account funds are already readable (`get_account_funds`, `meta_ads.py:1625-1670`).
25. **[VERIFIED, new] Instagram App Review does not depend on the redesign.**
    - The classic rule editor offers Facebook and Instagram rules in English and Arabic (`src/15f-social-studio.js:1145`; `socialText`, `15f:48`), and the admin "Link a page" sheet exists (`15f:324-384`).
    - The server already sends Instagram public replies and Instagram private messages (`social_studio.py:1160-1185`).
    - Meta's recording guide asks for an English UI, the login flow, and the app user using the permission. It says nothing about a redesigned UI.
    - The real blockers are two. First, Business Verification must come before Advanced Access [VERIFIED research 1.4]. Second, Instagram comment webhooks need "Advanced Access", an app "set to **Live**", and an account that "must be public" [VERIFIED https://developers.facebook.com/docs/instagram-platform/webhooks, fetched 2026-09-24].
    - So a recording cannot show a reply triggered by an Instagram webhook before approval. A server-side "check recent comments now" read that feeds the existing `process_comment()` (`social_studio.py:1294-1400`) solves this (P1-23).
26. **[VERIFIED, new] Zero Instagram reply-log rows do not prove webhooks are missing.** `process_comment()` returns before writing the log row when the owner cannot automate (`social_studio.py:1312`), has no rules (`:1320`), or no rule matches (`:1347, 1352`). The insert comes after these checks (`:1371`). Duplicate protection is sound: the log id is a hash of owner, platform and comment (`:1064-1066`), inserted with `reject_existing=True` (`:1371`). So a comment seen by both a webhook and a poll is answered once. Fix: P0-13 counter; P0-01(a)/(g) method.
27. **[VERIFIED, new] Every comment that arrives during an outage of Albayan's Meta token is lost for good.**
    - HTTP 401/403 and code 190 are classified as `authorization` (`meta_ads.py:1106-1107`) and are never retryable (`retryable: bool = False`, `:1065`).
    - A reply is retried only when every failure was temporary (`social_studio.py:1196`).
    - The same bucket mixes per-page causes, such as 190.492 (the user lost their Page role, [VERIFIED research 2.8]), with a dead token. The subcode survives in `provider_code` (`meta_ads.py:1105`), so the two cases can be separated.
    - Fix: P3-18a, P3-18b.
28. **[VERIFIED, new] The token's health can be read automatically.**
    - There is no app-id environment variable today (`meta_ads.py:1003-1056`); the app secret exists (`:1024`).
    - `debug_token` returns `is_valid`, `expires_at`, `data_access_expires_at`, `scopes` and `granular_scopes`, and accepts an app access token [VERIFIED https://developers.facebook.com/docs/graph-api/reference/debug_token/, fetched 2026-09-24].
    - System-user tokens are either non-expiring, or expiring after 60 days from creation or refresh. Meta calls expiring tokens a security best practice [VERIFIED https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens, fetched 2026-09-24].
    - Fix: P0-14, P3-18a, D35.
29. **[VERIFIED, new] A 3-hour settlement wait is unsafe.**
    - Meta: "Insights metrics may continue to update for a couple of days after an ad has completed", and they "do not change after 28 days of being reported" [VERIFIED https://developers.facebook.com/docs/marketing-api/insights/best-practices/, fetched 2026-09-24].
    - Each payment cycle allows only one return (`wallet_payments.py:269-357`), so an early settlement can never be corrected.
    - A campaign `spend_cap` cannot act as a hard limit for small studio ads, because its minimum is "$100 USD" [VERIFIED ad-campaign-group reference, fetched 2026-09-24].
    - Albayan already stores `finalSpendMetaMinorAtConfirmation` for core ads (`server/ad_final_spend.py:41-49`), and the core sync keeps reading linked ads afterwards (`meta_ads.py:4821-4860`). So drift can be measured from Albayan's own data.
    - Fix: P3-03, P3-06a, P0-01(s), D28.
30. **[VERIFIED, new] Funding facts can already be read, and discovery can skip studio campaigns.**
    - `get_account_funds` returns `isPrepay`, `fundsHidden` (false only with Full control), `status` and `capRemainingMinor` (`meta_ads.py:1625-1670`). The last reading is saved in `metaFundsState` (`:3497-3511`).
    - Discovery runs every 60 s by default (`meta_ads.py:1041-1043`) over the allowed accounts (`:4071-4078`), and already reads each ad's `campaign{id,name}` (`:1387-1393`). Core rows store `metaCampaignName` (`META_AD_LINK_FIELDS`, `:321-345`).
    - Fix: P0-01(n1–n3), P0-09 name tag, D26.
31. **[VERIFIED, new] Only an admin can confirm payments** (`wallet_payments.py:625-626`). So the owner sits on every customer's path to their first ad. Fix: D11 payment target, P3-19 admin lines.
32. **[VERIFIED, new] An operations alert transport exists.**
    - `_send_alert` posts JSON to `ALBAYAN_ALERT_WEBHOOK_URL` with a per-kind cooldown of 1800 s (`server/operations.py:784-809`).
    - It is called from an independent worker every 300 s (`:930-975`), and an `alertingConfigured` flag exists (`:134`).
    - The payload has no `text` field. Some chat tools (for example Slack and Google Chat) need one [ASSUMPTION].
    - Fix: P3-21, P0-01(u).
33. **[VERIFIED, new] CI is fast (≈8 min) but is not yet the release gate.**
    - The CI run for `d7d627e` took 7m58s (run 35995177433).
    - `ci.yml` never runs `npm test`. The frontend job lists individual scripts and leaves out `test:architecture` (main.py line cap, script.js byte budget), `test:mobile-config` and `test:profitability` (`.github/workflows/ci.yml:14-45`; `package.json:34`).
    - A "Publish verified Docker image" workflow (npm test, e2e, image smoke test, immutable SHA push) exists (`.github/workflows/publish-image.yml:1-95`) but has never been run (`gh run list` returned no runs).
    - The CI PostgreSQL job also proves a `pg_dump`/`pg_restore` round trip, but on CI data, not production (`ci.yml:130-160`).
    - Fix: P0-11, §11.3.
34. **[VERIFIED, new] Meta documents the usage-header types.**
    - `X-Business-Use-Case-Usage` types are `ads_insights`, `ads_management`, `custom_audience`, `instagram`, `leadgen`, `messenger` and `pages`, keyed by business object id.
    - `X-Ad-Account-Usage` has `acc_id_util_pct`, `reset_time_duration` and `ads_api_access_tier`.
    - There is a table mapping codes 80000–80014 to use-case types (rate-limiting page, fetched 2026-09-24).
    - Today the three headers are merged into one maximum (`meta_ads.py:193-207`).
    - Fix: P3-00b; P0-01(r) becomes a confirmation only.
35. **[VERIFIED, new] The legal pages do not fit the studio.**
    - Only `/privacy` and `/delete-account` are public (`main.py:533-534, 600-608, 2978-2996`); there is no terms-of-use page.
    - `privacy.html` describes "advertising-office teams" (`privacy.html:29`) and gives a default audit retention of 90 days (`:48`), while the code default is 365 days (`main.py:1199`).
    - The page does not mention commenter ids stored in the reply log (`social_studio.py:1363`).
    - Fix: P0-12, P3-22, P5-06, D18.
36. **[VERIFIED, new] There was no plan branch for Business Verification being refused.** It is required for Advanced Access [research 1.4], and the documents Meta accepts for Libya are UNVERIFIED [5.3]. Fix: D34.
37. **[VERIFIED, new] Who Standard Access covers.** "Permissions with Standard Access can only be requested from app users who have a role on the requesting app" (https://developers.facebook.com/docs/graph-api/overview/access-levels, fetched 2026-09-24). Whether Albayan's system user, reading a customer's Instagram shared with Albayan's business, counts as such a user is an [ASSUMPTION]. Fix: P0-01(w) "IG-poll" test.

---

## 0.5 System boundaries (owner decision D36, 2026-09-24)

Every Smart System is a **separate module inside one Albayan platform** (one login, one wallet, one set of subscriptions for the customer). This applies to Albayan Manager, Albayan Ads Studio, Clothes System and every future system in the Smart Systems section.

| Rule | What it means in the code |
|---|---|
| Own folder | Server code in `server/systems/<system>/` (routes, rules, jobs); screens in `src/systems/<system>/`, built into the system's **own lazy bundle** (`studio.js`, `clothes.js`, …). Albayan Manager keeps the core app code. |
| Own data | A system reads and writes **only its own record types** (e.g. `adCampaignRequests`, `adCampaignResults`, `socialPosts` for Ads Studio; `clothesProducts`, `clothesOrders` for Clothes). Studio ads never enter Manager's `ads` books (D26). |
| Own API prefix | `/api/studio/…`, `/api/social-studio/…`, `/api/ad-studio/…` for Ads Studio; `/api/clothes/…` for Clothes. |
| Platform doors (shared, fixed) | Login/users/permissions, wallet ledger + payment requests, subscriptions/plans, the Meta connection client (pacing, lanes, token health), notifications, audit, design tokens. A system calls these through their public functions only. |
| Automatic guard | A static test fails if a system module imports another system's module or queries another system's record types (extends `scripts/test-import-boundaries.js` + a new server boundary test). |
| Own switch and tests | Each system can be switched on/off, tested and released without touching the others. |
| Template | A new system = copy the template folder, add one registry entry (`SMART_SYSTEMS_CHILDREN`), one router registration and one bundle entry. |

**Where Ads Studio code goes:** `ad_campaign_actions.py`, `ad_campaign_fields.py`, `social_studio.py` and every new `studio_*` module from this plan move into `server/systems/ads_studio/`; `15c-ads-studio.js`, `15f-social-studio.js` and the new `15g`/`15h` files move into `src/systems/ads_studio/` (still bundled into `studio.js`). The startup bundle keeps only the tiny loader (`15c0-ads-studio-loader.js`). The Meta client stays a platform door; Manager-only Meta import/sync stays with Manager.

## 1. Product definition

### 1.1 Target users
| User | Situation | What they need |
|---|---|---|
| **Customer (primary)** | A Libyan small-business owner or manager (shop, clinic, restaurant, online seller). Uses Facebook/Instagram pages, lives on a phone, pays locally in LYD, and does not know Meta Ads Manager. | Ask for an ad without learning Ads Manager. Know where every dollar is. Answer comments automatically. Get help fast. Know the status without phoning. |
| **Albayan staff (reviewer/launcher)** | Holds the `adsStudioReviewer` preset (`src/04-permissions.js:367-377`). | One phone-friendly desk to review, launch in Meta, link results, settle, answer tickets and stop requests, and handle TikTok and page-link requests. They must be told immediately when something urgent arrives, even when the desk is closed (alert channel). |
| **Owner/admin** | Runs the business; a beginner. Is the only person who can confirm payments today. | Confirm payments, set limits, prices and working hours, switch features on per customer, pause intake, and read simple health numbers: queues vs targets, studio money vs Meta spend, USD owed to customers, storage, and the Meta key's expiry. A playbook for incidents. |

### 1.2 Value proposition (customer-facing, original)
**Arabic:** «اطلب إعلانك من هاتفك، واعرف أين كل دولار، وفريق البيان يتولّى العمل في ميتا نيابةً عنك.»

**English:** "Request your ad from your phone, see where every dollar is, and let the Albayan team do the Meta work for you."

Three promises we can keep today:
1. **Clear stages** that say who acts next, with the Meta stages taken from Meta.
2. **Clear money.** Nothing is charged until approval. Paid-but-unused money is shown separately. Unused money is returned only against Meta's final numbers, about 2 days after the ad stops.
3. **Human help** attached to the exact item, within published working hours.

### 1.3 Name and identity proposal (original)
- **Recommended name [RECOMMENDATION]: «استوديو البيان» / "Albayan Studio".**
  - It keeps the trusted Albayan master brand, which already shares the same login.
  - It drops "Ads", because the product now also covers replies, support and TikTok.
  - It shares no word, sound or mark with "BOTLI / بوت ليبيا".
  - It is shorter than «استوديو إعلانات البيان», so the rename *saves* startup-bundle bytes.
  - The rename touches: `src/05-state-services.js:181-182` (`SMART_SYSTEMS_CHILDREN.ad_maker` name/nameAr); `src/12-views.js:757` (login header); `15c:304` (studio header); plan names in the admin plan catalog; and the test pins in §11.2. The service id `ad_maker` never changes (`PLATFORM_FOUNDATION.md:101-104`). Task P2-12, decision D1.
- **Alternatives:** «البيان للنمو» / "Albayan Grow", or «مكتب البيان الرقمي» / "Albayan Desk" (D1).
- **Identity elements (original):**
  - Keep the Albayan `--ui-*` tokens (`style.css:3255-3316`) so the main app and the studio feel like one company.
  - A studio mark built from the Albayan "A" plus a small progress arc, echoing our stage tracker. It replaces the generic rocket icon.
  - Plain Modern Standard Arabic in short sentences. Every status names **who acts next** («التالي: أنت / فريق البيان / ميتا»).
  - Money and IDs always use Latin digits set left-to-right (`15c:1999` pattern). Typed Arabic-Indic digits are accepted and converted (P2-01). Dates use `ar-LY`.
  - No mascots, no "AI" claims, no floating buttons.

---

## 2. Reference analysis (BOTLI / "بوت ليبيا")

### 2.1 What the video shows
| Category | Items (frames) |
|---|---|
| **Demonstrated (worked in-app)** | • Home counters (f001, f013)<br>• Support ticket list and filters, empty only (f004–f006)<br>• Notifications list, empty (f011)<br>• Wallet history with filters; the ledger adds up 10−5+5−7+7=10 (f056–f061, f117)<br>• "Increase page likes" request: form → validation → "sent for review" (f070–f093)<br>• Campaign list with tabs and zero metrics (f101, f108)<br>• Stop & refund confirmation showing budget and refund (f102–f106)<br>• Language switch with full RTL (f192–f194)<br>• Plans by period (f132–f144)<br>• Tutorials accordion (f184)<br>• Logout (f229) |
| **Shown but not used** | • Recharge sheet with an Arabic-Indic keypad (f050–f054)<br>• Add Post form (f036)<br>• Add a page via Facebook, cancelled (f027)<br>• Disconnect / page power / delete (f022)<br>• TikTok bot accounts (f023)<br>• New ticket ⊕, support headset<br>• AI chat button (f046)<br>• Boost Post, a dead end at "No posts" (f069)<br>• Duplicate / extend / refresh results (f102)<br>• Subscribe now (f132)<br>• Delete account (f189)<br>• Contact options on the login screen: phone, WhatsApp, FB, IG (f229) |
| **Disabled / plan-gated** | • Advanced Auto-Reply and "BOTLI Ai" ("Not enabled", f016, f042, f121)<br>• TikTok linking blocked by the package via a red toast with no upgrade path (f020, f044)<br>• "Not available in the active package" (f040, f123) |
| **Claimed only (unproven)** | • AI targeting and automated campaign management (f016)<br>• AI replies to text, voice and images (f042, f122)<br>• TikTok DM templates (f016)<br>• "Fix for the ban problem" and unlimited bulk messages (f136)<br>• 24/7 support vs "working hours" (f213 vs f151)<br>• Audience "4.1M–4.8M" next to "Reach 0 – 0" (f083)<br>**Nothing in the video proves a Meta or TikTok call succeeded:** request #3480 never left "under review" and every metric stayed 0 [OBSERVED]. |

### 2.2 User problems it addresses (we solve them in our own way)
| # | User problem | Evidence |
|---|---|---|
| U1 | "I don't know Ads Manager; I just want more likes or messages." | Goal-first form, presets (f071–f082) |
| U2 | "Where did my money go? Will I lose it if I cancel?" | Ledger with refund lines (f056, f117); the stop dialog shows the refund (f103) |
| U3 | "Is my request done? Is my ad running?" | Status chips and tabs (f101, f108) |
| U4 | "Are my pages connected? Is my bot working?" | Connections page, counters (f022, f001) |
| U5 | "Answer comments for me." | Auto-reply service (f016, f017) |
| U6 | "I need help from a human." | Tickets, headset, contact page, login contacts (f004, f158, f229) |
| U7 | "What does my plan include? When does it end?" | Profile days-left, plan cards (f002, f136) |
| U8 | "How do I start?" | Tutorials; the most viewed is "top up + create FB ad", 1050 views (f185) |

### 2.3 Its UX problems (we must avoid them)
- Raw i18n keys on screen ("current_ads_balance", "under_review", f046).
- Contradictory state: "Token expired" beside "Connected", with no Reconnect (f022).
- Counters that go stale after submit and cancel (f094–f114).
- A stepper that says "Step 2 of 2" while showing 5 steps (f071).
- Validation only after tapping Launch; the error banner stays after the fix (f089–f091).
- Estimates that look fake: "0 – 0" beside a rising chart (f083).
- A $28 default on a $10 balance, with no warning (f071).
- A label that doesn't match its destination: "Auto Reply Settings" opens Posts (f033).
- Gates shown as red toasts with no upgrade path (f020, f040).
- Two floating buttons covering content (f056, f067).
- The keyboard plus a sticky footer leave about 1/5 of the screen for the form (f078–f083).
- Mixed Arabic/English, and a keypad that switches digit sets (f052 vs f054); English-only privacy text right-aligned (f215).
- Charges taken at *creation*, not on approval (ledger "خصم لإنشاء حملة", f117).
- "24/7 support" claimed while the terms say working hours (f213 vs f151). We publish our real hours instead (P3-16).

---

## 3. Three product/UX directions

| | **A. "Guided request desk" (request-centric, managed-first)** | **B. "Goal-first weekly coach"** | **C. "Concierge chat" (conversation-first)** |
|---|---|---|---|
| Core idea | Everything the customer asks for (ad, page link, TikTok, help) is a **tracked request** with stages, money state and "who acts next". Home = money strip + "needs you" + live tracker. | Home asks "What do you want this week?". Each goal starts a guided bundle (e.g. an ad request plus a reply rule). Progress is shown per goal. | One thread with Albayan. Guided cards inside the chat create ad requests and tickets; staff answer in the thread. |
| Fit with managed model | **Excellent.** Matches the server lifecycle and human review exactly. | Good for starting; weak for tracking many ads and the money per ad. | Good, but money and status get buried in messages. |
| Beginner fit | High: one question per screen, plain stages. | Very high for the first week, then confusing. | High at first, low for finding past items. |
| Reuse of existing server | Very high. | High, plus a new "goal bundle" model. | Low: needs a messaging model and staff chat tooling. |
| Staff operability | Structured queues with due times, counters and a pause switch. | Moderate. | Hard: free-form chat has no queue or due time. |
| Build effort (dev-days, before contingency) [ASSUMPTION] | ~73–92 (this plan) | ~80–100 | ~88–110 |
| Resemblance risk to the reference | Low: different information architecture, layouts and copy. | Low–medium: goal quick actions exist in many apps, including the reference's (f115). | Low. |
| Path to automation later | Clean: each request becomes a launch job (§4.4). | Clean, via its ad requests. | Awkward: chat data is unstructured. |

All three would carry the same ≈32 days of foundation and operations work found in reviews 2–4:
- money races proven on PostgreSQL;
- studio ads kept out of the core books;
- Meta call lanes;
- settlement gates;
- a money-jobs loop;
- staff alerts;
- the token-health and reply-parking work;
- the release pipeline;
- the runbook.

**Recommendation: Direction A** [RECOMMENDATION], borrowing one idea from each of the others:
- **from C, contextual help:** every ad, payment and page has "Ask about this";
- **from B, a goal-first start:** Home quick actions are phrased as goals ("Get more messages", "Grow my page", "Answer comments").

### 3.1 Differentiation from the reference
- **Functional:**
  1. **Nothing is charged until approval.** The reference deducts at creation (f117). We show "Reserved" and let the customer **withdraw** a waiting request.
  2. **Paid-but-unused money is its own number** ("In your ads"), with "Meta used $Y". The final return is calculated from Meta's final spend.
  3. **Every item says who acts next**, with a due time based on our published working hours.
  4. **Meta stages come from Meta** (ad-level status, "checked X ago"), including "Meta rejected the ad".
  5. **Honest capability labels.** Each reply channel shows *Working / Working, checked every N min / Waiting for Meta approval / Not available*.
  6. **Contextual tickets and urgent stop requests** (with an after-hours line) instead of a floating headset.
  7. **A "Needs you" list** on Home, including "Money added — send your ad" and "Fix: photo".
  8. **A staff desk** in the same app, usable on a phone, with live counters and alerts to a staff channel.
- **Visual and structural:**
  - Bottom nav: **Home / My ads / Pages & replies / Wallet / Help**. The reference has Home / Services / Bot Connections / Settings.
  - A horizontal **stage tracker** on request cards instead of a metrics grid.
  - A **four-part money strip** instead of a flip card.
  - The wallet ledger is **grouped by ad** (reserved → paid → Meta used → returned), instead of the reference's four filter chips (f056).
  - Top-up presets come from Albayan's own payment history (P0-05b), not the reference's $10/25/50/100/200 chips (f051).
  - No services grid, floating buttons, flip animations or mascot/AI imagery. All copy is written fresh.

### 3.2 IP / licensing questions to verify (no legal guarantee)
1. A trademark search for «استوديو البيان» / "Albayan Studio" in Libya and the region (owner/lawyer).
2. Never reuse reference screenshots, texts, illustrations, tutorial titles or plan names, including in marketing and tutorials.
3. Meta (Facebook/Instagram) and TikTok names and logos must follow their brand guidelines [ASSUMPTION: current guideline URLs still need checking]. Recommendation: text names plus neutral icons.
4. Icon library licence: Lucide is already bundled; confirm its licence file ships. Any self-hosted Arabic font must be OFL-licensed (D3).
5. Meta's Self-Serve Ad Terms make **Albayan liable for the client ads it runs** [VERIFIED 1.11, https://www.facebook.com/legal/self_service_ads_terms]. Albayan needs customer terms with an advertiser-responsibility clause. The accuracy/rights checkbox (`15c:1254-1271`) stays mandatory. Lawyer review.
6. **No terms-of-use page exists, and the privacy page contains factual errors** (finding 35).
   - Now: correct the facts (retention and audience; P0-12).
   - Give the lawyer a one-page data inventory: wallet, tickets, optional WhatsApp number, TikTok handles, commenter ids and texts in the reply log, and retention per D31 (P3-22).
   - Add the customer terms as a section of the existing `/privacy` page, which needs 0 main.py lines (P5-06).
   - Libyan data-protection obligations are an [ASSUMPTION]; ask a lawyer (D18).
   - For Preview A, use a signed plain-Arabic pilot consent if the review is not finished.

---

## 4. Scope

### 4.1 MVP: "Albayan Studio v2", the first customer release (all owner-required items)
**Baselines.** B1–B6 are computed from existing timestamps in the classic studio **before** the pilot (P0-05b).
- **B1:** median time from submit to decision
- **B2:** share of submissions sent back for changes
- **B3:** count of holds older than 14 days
- **B4:** Approved requests more than 7 days past their end date and never settled
- **B5:** median time from draft creation to submit
- **B6:** median time from account creation to first approval

| # | Item | User problem | Metric |
|---|---|---|---|
| M1 | Phone-first shell: bottom nav; Home with a four-number money strip and "Needs you"; Arabic default in the shell | U2, U3 | Hallway test: 5 of 5 customers correctly answer "how much can you use now?" and "how much may still come back?"; zero horizontal overflow at 320–820 px (e2e); every customer screen reachable from Home in ≤2 taps (e2e) |
| M2 | Ad request wizard v2: quick boost (3 screens) and full request (5 screens); inline validation; linked-page picker; Libya city chips; total budget + days with a wallet check and the per-day minimum | U1 | Median draft→submit time below B5; share sent back ≥30% below B2; quick boost submits end to end in Arabic at 390 px (e2e) |
| M3 | Unmistakable stages (§5.4); Meta stages read from Meta; "who acts next" | U3 | ≤10% of linked ads get an "ad" ticket while in stages 2/4/5; ≥90% of linked ads show a Meta check less than 6 h old |
| M4 | Withdraw a waiting request (safe against a simultaneous approval, **proven on PostgreSQL**); stop & refund sheet; **urgent stop request** with marker, staff alert and after-hours line; staff "finish & settle" **only after Meta's final spend** (≈48 h after delivery ends; at once if Meta never delivered) | U2 | 0 holds older than 14 days (B3 → 0); 0 ended ads unsettled 2 business days after the final Meta read (B4 → 0); never-delivered ads returned within 1 business day; **stop request → paused in Meta: p90 within the D11 target**; 0 refunds above paid − Meta spend without an audited admin override |
| M5 | Wallet v2: four numbers (plus "Being returned" when non-zero), per-ad money chains, purpose-first "Add money", LYD rows in the right currency, separate LYD plan card | U2, U7 | 0 LYD amounts shown with "$" (test); the wallet identity holds for every user, checked **daily** (property test + scheduled integrity scan); 0 duplicate charges (SQLite logic tests **and** PostgreSQL race scenarios); ≥90% of payment requests confirmed within the D11 target (4 working hours) |
| M6 | Tracking: staff link the Meta campaign (on the **Studio ad account**, with the studio code in its name, D26); the server reads statuses, spend and results on an **isolated studio lane**; "checked X ago" | U3 | ≥90% of linked ads have a Meta check < 6 h old; **an Ads throttle, an ads `usage_high` pause or a slow admin call never delays a comment reply by more than ~1 s** (tests) |
| M7 | In-app activity inbox (bell and badge), derived from real records | U3 | A decision is visible within 60 s while the studio is open (test) |
| M8 | Comment auto-replies. **At launch: FB public replies + likes**, if P0-01(g) and (l) pass. **Instagram public replies at launch either by polling (if P0-01(w) passes, P4-09) or by webhook after Meta approval (D8b).** Private messages switch on only after approval. Fixes: removed FB private-reply endpoint; rules scoped to stable page ids; reply log; page health incl. webhook subscription and "Instagram comments not arriving"; per-page back-off; honest labels; a global "Albayan–Meta connection" state; **comments parked, not lost, during a token outage** | U5, U4 | Every reply failure visible to its owner within 5 min; a revoked token or missing subscription flagged at the next 6-hourly check; one throttled page does not pause others; **webhook reply latency p95 ≤ 2 min; poll reply latency p95 ≤ 10 min** [ASSUMPTION targets, tuned in the pilot]; 0 comments lost to a token outage shorter than 24 h (public) / 7 days (private) |
| M9 | Pages & replies hub: linked pages with health ("checked X ago") and fix steps; "Request a page link" with an Instagram professional-and-public pre-check (managed) | U4 | Median page-link request → linked in < 1 business day |
| M10 | Support tickets: list, new, thread, resolve/reopen; contextual "Ask about this"; staff queue (payment and account tickets go to admins only); Help in the bottom nav **and in the classic layout** | U6 | First staff response within the D11 target (working hours, P3-16) |
| M11 | TikTok **service request** (managed; exact commitment in §8.4), labelled as a service, never as a connection | U4, U5 | Every request acknowledged in < 1 business day; 0 "connected/managed" wording on TikTok screens (text test) |
| M12 | Staff desk v2 with a phone nav: review (reason picker), launch & link, settle, tickets, stop requests, TikTok, health, alerts; **live staff pulse with title badge and sound**; own switch, independent of the customer rollout | Staff | Decision time below B1; 0 native dialogs for money (static test); **a new stop request appears in an open desk within 60 s (e2e)** |
| M13 | Server money and lifecycle hardening (§7.8, §7.9): serialised submit; atomic withdraw; approval self-release; orphan sweep; staff-id redaction; total-only budgets; `durationDays`; `closeReason`; settlement gates; **in-flight legacy rows handled** | U2 | PostgreSQL Barrier scenarios prove no over-reservation, no lost capture and no deadlock; the late-approval test keeps the promised days |
| M14 | **Getting started (J0):** login help line, first-run checklist in the real order, purpose-first money | U8 | Median account creation → first running ad below B6 |
| M15 | **Reach customers when the app is closed** (no new transport): optional consented WhatsApp number; staff "Message on WhatsApp"; after-hours urgent line for stop requests | U3, U6 | Median time in "Needs your changes" below the classic baseline |
| M16 | **Studio ads kept out of the core ads books** (D26: Studio account + studio code in every campaign name) | U2, staff | 0 core `ads` rows for studio campaigns (daily integrity check); monthly "Meta spend on the Studio account vs captures − returns" line |
| M17 | **Operations safety:** studio jobs loop independent of Meta; daily money integrity scan with admin alert; **urgent events to the staff alert channel**; token expiry warnings; intake pause switch; working-hours calendar; runbook; risk register; pilot go/no-go rules; capacity and storage lines in diagnostics; **one-button verified release** | Owner, staff | Jobs heartbeat never stale > 5 min, and a late heartbeat reaches the alert channel within 10 min; daily scan ran on 100% of pilot days; token expiry warned ≥14 days ahead; runbook rehearsed before Preview A; every queue meets its target ≥90% before each rollout step |
| M18 | **Privacy and terms that fit the studio:** corrected privacy facts, data inventory for the lawyer, customer terms section | Trust (U2, U6) | Privacy page retention equals the code default (static test); 100% of pilot customers accepted the terms or the pilot consent |

### 4.2 Later releases
| Release | Items | Dependency |
|---|---|---|
| **R2 (no Meta approval needed)** | Cut from the MVP to keep it small [RECOMMENDATION]: Control Center "Studio health" card; customer "Refresh results" button; photo-storage meter for customers; restyled posts composer; Duplicate polish.<br><br>Also in R2: media moved out of rows into file storage (frees the 48 MB quota; a separate migration, `docs/RELEASE_AND_SAFETY.md:88-90`); ready-reply templates; a real delivery estimate; results charts; optional self-hosted Arabic font; WhatsApp/SMS/email sending to customers; installable PWA; **staff one-tap "Pause in Meta"** (`ads_management` on own accounts works with standard access [VERIFIED 1.3]; token scope read by P0-14); a combined "starter payment"; customer self sign-up; **the studio inside a published store app** (needs an outdated-build check first, §12.1); a second system user once Full Access allows it (D35). | D3, D12, D13, D35 |
| **R3 (gated on Meta)** | Automatic launch on the Studio ad account (created PAUSED, staff activate); private replies at scale; Instagram comment webhooks if not approved earlier (D24) | Business Verification (D8a/D34); App Review / Advanced Access for `pages_messaging`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_manage_metadata` and dependencies (D8b); Marketing API Full access (500 calls in 15 days, <15% errors) [VERIFIED 1.1–1.4, 2.3, 3.2, 3.8] |
| **R4 (gated on Meta Tech Provider / TikTok)** | Customer self-connect via Facebook Login for Business; TikTok comment/DM automation; store app | Tech Provider access verification [VERIFIED 1.5]; TikTok Accounts API form, Business Messaging beta and Libya availability [UNVERIFIED 4.3–4.7]; store payments decision (`docs/store/STORE_CHECKLIST.md:138-143`) |

### 4.3 Excluded or deferred (and why)
- **AI chatbots / "AI replies".** Unproven value, plus policy and cost risk. The reference itself has them disabled (f042).
- **Bulk or broadcast messaging.** Promotional messages outside the 24-hour window are not allowed. Sponsored Messages are Messenger-only, and three message tags return errors since 27 Apr 2026 [VERIFIED 3.5, 3.6].
- **Any "ban fix" claim.**
- **TikTok ads.** Ad-account availability in Libya is unverified [4.7].
- **Billing ads in LYD.** LYD is not a Meta ad-account currency [VERIFIED 5.1].
- **Legacy Advantage+ shopping/app campaigns.** Blocked since v25 [VERIFIED 1.14].
- **Numeric reach estimates.** No fake numbers.
- **Campaign `spend_cap` as a safety limit.** Its minimum is $100 [VERIFIED], so it cannot protect small ads. The launch checklist uses a lifetime budget ≤ paid instead.
- **Customer self-connection of pages** (R4), **self sign-up** (R2), **new SPA paths** (navigation stays on `?tab=`).
- **Studio results built from the core `ads` rows** (rejected; see §6 "Core books separation").
- **A 24/7 support promise.** We publish real working hours plus an after-hours urgent line for stops only.

### 4.4 Managed service vs automated API advertising (and the chosen path)
| | Managed (MVP) | Automated via Marketing API (R3) |
|---|---|---|
| Who launches | Staff in Meta Ads Manager on **one dedicated Albayan "Studio" USD ad account** (more later if needed, D26). The campaign name carries the request's studio code `ALB-S-XXXXXXXX`. Staff then link the Meta campaign in the desk. | The server creates campaign, ad set and ad **PAUSED** on the Studio account, with the code in the name; staff approve and activate. |
| Prerequisites | • Studio ad account created and **funded** in USD. The funding method is read in P0-01(n1–n3). The account is listed in `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` (a subset of `ALBAYAN_META_AD_ACCOUNT_IDS`), and both the account and tagged campaigns are **skipped by the core auto-import** (P0-09)<br>• **the system user assigned to the account** with `ads_read`, plus Full control to read funds (`deploy/README.md:26-29`; research 1.8); proven by `fundsHidden=false` (P0-01(n3))<br>• staff with roles on the account<br>• the admin Meta token (`ALBAYAN_META_ACCESS_TOKEN`, `meta_ads.py:1023`), with **its type, expiry and scopes read automatically** (P0-14) and expiry alerts (P3-18a)<br>• the launch checklist: studio code in the campaign name, lifetime budget ≤ paid, `special_ad_categories` set<br>• **enough staff time** (capacity formula, §12.7; D29) | Everything in the managed column, plus `ads_management` **Full access**, Business Verification, system user setup, `special_ad_categories` + `special_ad_category_country` on every campaign, and handling Meta ad review (~24 h) [VERIFIED 1.1, 1.2, 1.4, 1.8, 1.12, 1.13] |
| Staff time per ad [ASSUMPTION; measured on 10 agency ads in P0-01(v), confirmed in Preview A] | ≈30–45 min: review 5–10, build in Ads Manager 15–25, link 2, watch 2, settle 3, plus a share of tickets | ≈10 min: review, activate, settle |
| Money | Submit reserves; approve charges (`cpay:`); settle returns paid − Meta's confirmed spend (`stoprefund:`), about 48 h after delivery ends. | Same ledger. |
| Stages | From ad-level status once linked (§5.4). | Same, from creation. |
| Liability | Albayan is liable for client ads [VERIFIED 1.11], so human review stays. | Same. |
| Rate limits | Reads only: `ads_insights` per ad account [VERIFIED 1.7], on the isolated studio lane (P3-00). | `ads_management`: 300/h dev vs 100,000/h Full [VERIFIED 1.7]. |
| **Chosen** | **MVP = managed**, with the data shaped for R3: `launchMode`, `studioRef`, `metaAdAccountId`, `metaCampaignId`/`metaAdSetId`/`metaAdId`, `specialAdCategories`, `locationKeys`, `durationDays`, `goalDetail`, and a server-side goal → objective map (§7.1). | Switched on per request (`launchMode='api'`) only after approvals; an `adLaunchJobs` entity is added then. |

---

## 5. Screens and journeys

### 5.1 Navigation model (constraint-safe)
- There is one view, `ads-studio`. Sub-screens use `?tab=<id>`, plus optional `&section=`, `&id=`, `&step=` (`updateUrlParams` accepts any keys, `src/11-routing-cloud.js:139-186`) [VERIFIED]. `viewUrlParamsFor` keeps only `tab` on a whole-view re-navigation (`11-routing-cloud.js:74-76`) [VERIFIED]. That is acceptable and costs no startup bytes.
- **Tab ids pinned by tests stay** (`dashboard, campaigns, builder, posts, replies, review`; `tests/e2e/design-system.spec.js:317-322`), and the global `setAdsStudioTab` keeps driving `?tab=` [VERIFIED]. **New tab ids:** `wallet`, `help`, `inbox`, `account`.
- **Two layouts, one set of services** [RECOMMENDATION]. `/api/studio/me` returns:
  - `ui: 'v2' | 'classic'` — chooses only the **customer layout** (Home, My ads, wizard, Wallet, Account);
  - `services: {help, stopRequest, tiktok}` — service features shown in **both** layouts (classic gets a `help` tab and a real "Ask to stop" sheet);
  - `staffDesk: 'v2' | 'classic'` — the Team desk, controlled by its **own** switch.
  
  So switching the customer layout back to classic never hides a ticket, a stop request or the staff queue (§12.2).
- **Customer bottom nav** (≤900 px). It reuses `.mobile-bottom-nav*` inside the studio HTML (`renderMainApp` hides the manager bar for `ads-studio`, `src/12-views.js:1388-1411`):

  | # | Label (AR / EN) | Tab |
  |---|---|---|
  | 1 | الرئيسية / Home | `dashboard` |
  | 2 | إعلاناتي / My ads | `campaigns` |
  | 3 | الصفحات والردود / Pages & replies | `replies` |
  | 4 | المحفظة / Wallet | `wallet` |
  | 5 | المساعدة / Help | `help` |

  Pages & replies has the sections `pages`, `rules`, `log`, `tiktok`, plus a link to scheduled `posts`. Above 900 px the same items appear as a side rail.
- **Header:** brand, bell (`inbox`) with an unread badge, account avatar (`account`). No floating buttons anywhere.
- **Staff nav (reviewer)** [RECOMMENDATION]. Everything sits under the pinned `review` tab, with a **live counter badge** per item (from the staff pulse, §7.6):

  | # | Label (AR / EN) | Section |
  |---|---|---|
  | 1 | الطلبات / Requests | `requests` |
  | 2 | الإطلاق / Launch | `launch` |
  | 3 | التذاكر / Tickets | `tickets`, stop requests pinned on top |
  | 4 | التنبيهات / Health | `health` (lists + alerts) |
  | 5 | المزيد / More | `account`, TikTok requests, page health (read-only) |

  **Admin** gets the same nav. For admins, More also lists Payments (with a live count), Link a page, Rollout, Service hours, Meta token and "Customer screens (test)". A reviewer never sees wallet, payment tickets, account tickets or ad-creation items.
- **Phone Back, fully defined** [RECOMMENDATION]:
  1. An open sheet or overlay closes first (`src/01b-mobile-runtime.js:378-545`).
  2. Wizard step N goes to step N−1. Each step pushes `&step=N`.
  3. Any tab other than Home goes to Home. Leaving Home pushes one history entry; moving between non-Home tabs replaces it.
  4. Only then does Back leave the studio.
  - **Phone browsers:** popstate calls `restoreViewStateFromUrl` → `restoreAdsStudioTabFromUrl` (`11-routing-cloud.js:96-102`). v2 extends it in the lazy bundle.
  - **Capacitor app (future builds only, §12.1):** a ~70-byte hook after the overlay check in `handleAndroidBackButton` (`01b:299-330`): `if (typeof studioHandleBack==='function'&&studioHandleBack()) return;` (P2-09, D21).
- **Wizard focus mode.** On `builder` the bottom nav is hidden, and the header shows Back and Close (which saves the draft). The sticky footer shrinks to one line while the keyboard is open (`style.css:1614-1621, 2877`). Target: the form keeps ≥60% of a 360×640 screen (e2e).

### 5.2 Customer screen map
| Screen (tab / section) | Contents |
|---|---|
| **Home** `dashboard` | 1. Plan chip (active until DATE / ended → renew).<br>2. **Money strip** (2×2): **Available** · **Reserved** · **In your ads** ("Meta used $Y", only once linked) · **Spent**. "Being returned $Z" appears only when non-zero. Tapping opens the "where every dollar is" sheet (§7.8).<br>3. **Needs you** cards: fix reasons, "Money added — send your ad", receipt missing, plan ended, page needs attention, ticket reply waiting, TikTok team contacted you.<br>4. **Your ads now:** up to 3 tracker rows, with a "Stop requested" chip where relevant.<br>5. **Replies today** (only if rules exist).<br>6. Goal quick actions: Get more messages / Promote a post / Grow my page / Answer comments / Get help.<br>**Intake paused (admin switch):** a calm banner «نستقبل طلبات الإعلانات الجديدة مجدداً قريباً — مسوداتك محفوظة»; goal actions open drafts only.<br>**New-customer state: "Getting started" checklist (J0).** |
| **My ads** `campaigns` | Segments: Needs you · In progress · Running · Ended · Drafts. Cards carry the stage tracker. |
| **Ad detail** `campaigns&id=` | Stage tracker with dates, "Next: …" and due time ("Our team replies by Sunday 10:00"), "checked X ago" on Meta stages; **Money box** (on Ended: «المبلغ النهائي خلال يومين إلى ثلاثة تقريباً»); results card (when linked); brief; team note with reason chips; actions by stage (§5.4). |
| **New request** `builder` (`section=boost\|full`, `step=`) | Wizard (J3). Focus mode. |
| **Wallet** `wallet` | Four-number strip + definitions; **Add money** (purpose first, J2); payment requests (right currency, due time); per-ad money chains (archived included); **Plan balance (LYD)** + Renew; chronological ledger with a USD/LYD switch. |
| **Pages & replies** `replies` | `pages`: health, "checked X ago", one fix; "Request a page link". **When Albayan's own Meta connection is down, one neutral banner replaces all per-page "re-share" prompts.**<br>`rules`: each channel shows its capability label (J6).<br>`log`; `tiktok`; link to `posts`.<br>Until P4 ships, `rules`/`log` embed the existing 15f screens unchanged. |
| **Help** `help` | My tickets (Waiting for team · Waiting for you · Resolved); New ticket; thread `&id=`; short guides; **our working hours** (from P3-16); Albayan's WhatsApp/phone as a secondary contact (D16). Also rendered in the classic layout. |
| **Inbox** `inbox` | Activity list (newest first), "mark all seen". |
| **Account** `account` | Plan and renew; language; theme; change password (`POST /api/auth/password-change`, `main.py:3293`); WhatsApp number (optional, with consent); "Classic view" link (rollout only); privacy and customer terms (`/privacy`, P0-12/P5-06); delete-account link (`main.py:2990`); logout. |

### 5.3 Staff / admin screen map (tab `review`, renamed «مكتب الفريق / Team desk»)
Every section is backed by a staff route in §7.3. While the desk is open, the browser tab title shows the urgent count (e.g. «(2) مكتب الفريق»), and an urgent arrival plays a short sound (generated in the page, no external file) and vibrates where supported. **When no desk is open,** urgent events go to the staff alert channel (P3-21), if one is configured.

| Section `&section=` | Who | Contents |
|---|---|---|
| `requests` (default) | reviewer, admin | Submitted queue (not own) with due times; reason picker (photo, text, link, page, budget_dates, audience, policy, other + note); Approve sheet ("charges $X; runs N days from start; studio code ALB-S-XXXXXXXX" with a copy button); **legacy rows flagged** «طلب قديم بميزانية يومية» with the D33 rule (P1-18). Existing rules stay: no self-review; a note is required unless approving (`15c:1587-1634`). |
| `launch` | reviewer, admin | **Approved but not linked:** launch checklist ("put ALB-S-XXXXXXXX in the campaign name", lifetime budget ≤ paid) → Link Meta campaign (Studio account only; the name must carry this code; warnings such as "Meta budget above paid").<br>**Ended — settle:** enabled only when the §7.8 gates pass, with a countdown "final Meta read in N h"; pre-filled paid − Meta spend; capped. Never-delivered ads can settle at once.<br>"Check Meta now" (cached if < 10 min). |
| `tickets` | reviewer, admin | **Stop requests pinned on top** with due time and overdue alarm; filters (new, waiting for team, overdue); reply; status; internal note; payment/account tickets only for admins; page-link requests → "Open link sheet"; "Message on WhatsApp"/"Email" on time-critical items (audited fetch). |
| `health` | reviewer, admin | Meta rejected / delivery problems; running past the promised end; Meta used more than paid; **Meta spend changed after settle (reads until day 28)**; approval interrupted; money being returned; approved but not linked > 1 business day; ended and unsettled; pages needing attention (incl. "Instagram comments not arriving"); **Albayan–Meta connection down**; **Meta token expires in N days**; **replies parked during an outage**; **Studio account funds low / account not active**; reply failures (24 h); results sync errors and parked accounts; holds > 7 days; **studio jobs heartbeat late**; **daily money scan failed**; alerts with acknowledge. |
| `tiktok` (More) | reviewer, admin | TikTok requests by status; customer-visible note; internal note. |
| `pages-health` (More) | reviewer, admin | Read-only page list with health reason and "checked X ago". No tokens. |
| `payments` | **admin only** | Existing "Payments waiting for confirmation" (`15c:1978-1982`; server admin-only `wallet_payments.py:408-409, 625-626`), now with due times (D11) and an overdue badge. |
| `pages` | **admin only** | Existing "Link a page" sheet (`15f:324-384`) + "Check all pages" (if P0-01(l) passes) + **"Check recent comments now"** per Instagram account (P1-23). |
| `rollout` | **admin only** | Customer rollout, **staff desk switch**, **intake open/paused** and daily cap, capability switches per channel (`on/poll/gated/off/unavailable`), ad limits, settlement settings, **service hours and holidays**, public contact and **on-duty urgent number**, **alert channel test button**, **Meta token status** (valid, expires in N days, missing permissions; no token shown), diagnostics (baselines, pilot metrics, **queue targets met % incl. admin queues, capacity, storage, USD owed to customers vs Studio funds**, reconciliation, go/no-go checklist). |

### 5.4 The stages, unmistakable
- **One shared definition.** The pure server function `derive_display_stage()` (built in P1-20, before any screen) produces it. The client shows what the server says, and a shared fixture keeps the client fallback identical.
- **Before a Meta link**, only Albayan's statuses and staff markers are used. An Approved request is stage 4 and shows **no "Meta used" line**.
- **After a link**, Meta's ad-level status decides. The manual `publishStatus` marker is kept only for money rules (it blocks a customer self-stop after launch).

| # | Stage (AR / EN) | Derived from | Colour + icon (never colour alone) | Money meaning | Next actor | Customer actions |
|---|---|---|---|---|---|---|
| 1 | مسودة — لم تُرسل / Draft — not sent | `Draft` (also after withdraw) | slate, pencil | Nothing reserved | You | Edit, Send, Delete |
| 2 | بانتظار مراجعة فريق البيان / Waiting for Albayan review | `Submitted` | amber, clock | **Reserved** (still yours) | Albayan team (due time from D11 + service hours) | **Withdraw**, Ask about this |
| 3 | يحتاج تعديلك: <السبب> / Needs your changes: <reason> | `Changes Requested` + `changeReasons` | orange, message-warning | Reserve released | You | **Fix**, Ask about this |
| 4 | مقبول — نجهّزه في ميتا / Approved — being set up in Meta | `Approved`, not linked (or linked but never checked: "Checking Meta…") | blue, badge-check | **Paid** (counts in "In your ads") | Albayan team | Stop & full refund (until the start day), Ask to stop, Ask about this |
| 5 | ميتا تراجع الإعلان / Meta is reviewing | Linked; no ad ACTIVE; some ad PENDING_REVIEW / IN_PROCESS / PREAPPROVED | blue, shield | Paid | Meta (~24 h, [VERIFIED 1.13]) | Ask to stop, Ask about this |
| 6 | ميتا رفضت الإعلان — الفريق يعالجه / Meta rejected the ad — the team is fixing it | Linked; all ads DISAPPROVED; no end signal | red-orange, shield-alert | Paid; usually $0 used; if unfixable within D11, settled at once (never delivered) | Albayan team | Ask about this, Ask to stop |
| 7 | مشكلة في التشغيل — الفريق يعالجها / Delivery problem — the team is fixing it | Linked; WITH_ISSUES or PENDING_BILLING_INFO; none ACTIVE; no end signal. The customer never sees "billing"; staff see "Studio account funds low / not active" when that is the cause. | orange, alert-triangle | Paid | Albayan team | Ask about this, Ask to stop |
| 8 | يعمل الآن / Running | Linked; ≥1 ad ACTIVE, **whatever the request's end date** | green, play | Paid; "Meta used $Y so far · checked X ago" | — | Ask to stop, Ask about this |
| 9 | متوقف مؤقتاً / Paused | Linked; campaign PAUSED or all ads PAUSED / CAMPAIGN_PAUSED / ADSET_PAUSED; no end signal; no stop request | slate-blue, pause | Paid | Albayan team | Ask to stop, Ask about this |
| 10 | انتهى — نحسب المبلغ النهائي / Ended — final amount being calculated | `Approved`, not settled, and **either** (a) linked and synced, no ad ACTIVE or in review, and one end signal: ad set `end_time` / campaign `stop_time` passed [VERIFIED `meta_ads.py:2396`], campaign DELETED/ARCHIVED, request end date passed, or a stop was requested; **or** (b) never linked and end date passed (full return) | slate, hourglass | Paid; Meta used $Y; **unused $Z comes back after Meta's final numbers, usually within 2–3 days** («نحسب المبلغ النهائي بعد أن تثبت أرقام ميتا — عادةً خلال يومين إلى ثلاثة»). If Meta never showed the ad: «لم تعرض ميتا إعلانك — نعيد المبلغ كاملاً خلال يوم عمل» | Albayan team | Ask about this |
| 11 | انتهى / Finished | `Stopped` + `closeReason=completed`. **Legacy:** `Stopped`, no `closeReason`, spend > 0, end date passed | slate, flag | Final: spent $S, returned $R | — | Archive |
| 12 | أُوقف / Stopped | `Stopped` + `customer_stop`/`staff_stop`; legacy rows otherwise | rose, stop | Returned $R | — | Archive |
| 13 | مرفوض من فريق البيان / Rejected by Albayan | `Rejected` + reasons | red, x | Reserve released | — | Read reasons, Copy & fix, Delete |

- **Overlay chip on stages 4–9:** «طُلب الإيقاف — سنوقفه قبل <الوقت>» / "Stop requested — we'll pause it by <time>" (P3-10). `<الوقت>` comes from the service-hours helper (P3-16).
- **Precedence** (tested). Status comes first. Within Approved:
  1. settled;
  2. if linked and synced: **Running** > **Meta reviewing** > **Ended** > Meta rejected > Delivery problem > Paused;
  3. linked but not checked: stage 4 "Checking Meta…";
  4. not linked: stage 4, or 10(b) after the end date.
  
  A check older than 6 h keeps the last stage and turns "checked X ago" amber. Running/reviewing past the end date keeps that stage and raises "running past promised end". Settle stays disabled while any ad delivers (server-enforced, §7.8).
- **Tracker dots:** Sent → Approved → Meta review → Running → Ended → Finished. Draft shows "Not sent". Side states replace the current dot with their own chip.

### 5.5 Core journeys
- "Toast" = the existing `showNotification`. Money decisions use in-app sheets, never `confirm()`/`prompt()`.
- **Every server refusal is shown in plain Arabic** (P1-08c for classic, P2-11 for v2). Unknown refusals show «تعذّر إتمام العملية. لم يتغير شيء في رصيدك.» plus **Ask about this**. HTTP 429 is recognised by its status code (it has no body, `src/09-api-auth.js:254-262`).

**J0 Becoming a customer**
- **Account creation:** there is no self sign-up (R2). The prospect contacts Albayan by WhatsApp or phone.
  - The numbers appear on the studio login screen as a **login help line** («عميل جديد أو نسيت كلمة المرور؟ راسلنا على واتساب …»).
  - `studio.js` provides it through a ~60-byte hook in the shell login template (`src/12-views.js:1054`). `/studio.js` is public and loads at boot on `/studio` (`server/main.py:2928-2930`, `src/15c0-ads-studio-loader.js:99-101`) [VERIFIED].
  - The numbers come from the admin-editable `studioSettings.contact`, through a public read-only endpoint.
  - An admin creates the account (preset `adsStudioCustomer`, `15c:124-131`). Staff hand over a temporary password [ASSUMPTION: process confirmed in D23], and the customer changes it at first login (`main.py:3293`) [VERIFIED].
- **Forgot password:** no email transport exists (report 2 §7). The help line leads to staff, and an admin sets a new password (`main.py:13891-13896`) [VERIFIED].
- **Getting started:** (1) activate plan (LYD) → J1; (2) ask us to link your page → J7; (3) add ad budget (USD) → J2; (4) send your first ad request → J3. Each step shows a live status.
- **Metric:** median account creation → first running ad, vs B6.

**J1 Activation (LYD plan)**
- Home → activation card (the existing `renderAdsStudioSubscriptionGate`, restyled) with the LYD price → existing paywall `showSubscriptionModal('ad_maker','ad_maker')` (`src/04-permissions.js:678-706`).
- **Validation:** price pin 409 (`subscription_plans.py:354-355`); the LYD balance must cover the price (`15-modals.js:2192`).
- **States:** skeleton; not enough LYD → "Add the missing N LYD" (J2, purpose "My plan", amount = shortfall); success → green chip.
- **Recovery:** a lapsed customer keeps reads, withdraw, stop/refund, ask to stop and tickets (`15c:107-115`; `main.py:11426`).
- **Permissions:** `adsStudioCustomer` (`src/04-permissions.js:358-366`).

**J2 Add money (purpose first; USD for ads, LYD for plans)**
- Wallet → Add money:
  1. «لماذا هذا المال؟» — **My ads** («يُستخدم للإعلانات فقط — بالدولار») or **My plan** («لتجديد اشتراكك — بالدينار»), with «ستدفع بالدينار في الحالتين؛ نحسبه لك.»
  2. Amount: presets from Albayan's confirmed-payment history (P0-05b, D25), or a field that accepts Arabic-Indic digits and ٫/، (P2-01), with "≈ N LYD at today's rate" for ads.
  3. Method (`/api/wallet/payment-requests/methods`).
  4. Confirm screen.
  5. Result: `PAY-XXXXXXXX`, the method instruction ("Pay N LYD…", `server/payment_methods.py:12-139`), a copy button, and receipt attach if needed.
- **Validation:** minimum 1.00 (`wallet_payments.py:65`); ≤5 open requests (`:64`); idempotency key over amount + method + currency (`15c:741-756`); no exchange rate → "rate unavailable, contact us".
- **States:** pending (amber, «نؤكد دفعتك قبل <الوقت>», due time from the **D11 payment target**, 4 working hours) → confirmed (green, «أضفت رصيداً») → cancelled (grey).
- **Recovery:** wrong purpose before confirmation → cancel and redo; after confirmation → "Ask about this payment" (admin-only ticket). There is no USD↔LYD transfer route; admins handle this by hand [ASSUMPTION: the reversal policy is the owner's call].
- **Permissions:** the customer creates and views their own requests; confirmation is **admin only**; the confirming admin is shown as «فريق البيان» (P1-05).

**J3 Ask for an ad (quick boost or full request)**
- **Entry points:** Home goal actions, My ads "+", Needs-you cards.
- **Intake paused or daily cap reached:** the wizard still saves drafts. The Send button reads «الإرسال متوقف مؤقتاً — سنخبرك عند الاستئناف», and the server refuses submit with a stable prefix (P1-22).
- **Quick boost (3 screens)** [RECOMMENDATION; D19]:
  1. **What to promote:** page picker (or page name).
     - **(a) Promote a post:** the post link only (validated host, `ad_campaign_actions.py:73-100`) plus an optional note. This needs P1-13: a `boost_post` with a valid `sourcePostRef` skips the `primaryText`/image checks, and `destination` = the post link, as in `15c:1333-1334`.
     - **(b) Grow my page:** page link + one short line (required) + one photo (required).
     - The name is set automatically («ترويج منشور — 24 سبتمبر»). **If D19 = no,** (a) also asks for one line and one photo.
  2. **Budget and days:** total USD presets that meet the per-day minimum; days 3 / 7 / 14 / custom 1–30; «≈ $X يومياً (الحد الأدنى $Y)» and "≈ N LYD (estimate)"; a wallet line ("Available $A: enough ✓" / "short by $S → Add money"); «يبدأ عند الموافقة ويعمل N أيام».
  3. **Review & send:** plain summary; "What happens next" (reserve → team review by <due time> → Meta review ~24 h → running); rights/accuracy checkbox.
- **Full request (5 screens):**
  1. Goal (`goalDetail`: Messages / Page likes / Post engagement / Video views / Website visits / Leads / Sales). The server maps these to the 7 objectives (`ad_campaign_fields.py:349-357`) and a `resultType` (P1-14).
  2. Page picker (`socialPages` → `connectedAssetId`), or text + "Request a page link".
  3. Content: text, headline, button, destination (https or phone; `09x` → `+2189x`); ≤3 photos with the existing compression and `data-photo-paste-target` hooks (`15c:1086,1102`).
  4. Audience: Libya city chips → `locationKeys`; age 18–65; gender; interest chips; "Let Meta find people" on by default.
  5. Budget & days, then Review & send. Start: "as soon as approved (recommended)" or a date from today (Libya time, `ad_campaign_fields.py:442-445`).
- **Validation:** inline per step; client limits = server limits (P1-08b); total budget only (D5); min/max total (D4) and a per-day floor (P1-15) from Meta's `min_daily_budget` [VERIFIED field, https://developers.facebook.com/docs/marketing-api/reference/ad-account/; value from P0-01(f)]. Banners clear when the field is fixed.
- **Auto-save:** `saveAdsStudioDraftOnce` (`15c:1386-1453`) with a version baseline. The new fields are accepted once added to the allow-list (P1-11/P1-14). Each step is a history entry.
- **States:** "Saved"; button spinner; success **"Sent. $X is reserved, not charged"** + "View request"; a 409 "already Submitted" is treated as success (`15c:1513-1517`).
- **Recovery:** offline → "Not sent. Your draft is saved" + Retry; wallet short → Add money deep link; pending payment → «بانتظار تأكيد دفعتك PAY-XXXX»; confirmed → "Money added — send your ad"; "Fix: photo" opens the right step.
- **Permissions:** `add`, `editOwn`, `submitOwn`, and an active `ad_maker` plan (`main.py:4633-4696`).

**J4 Track an ad**
- My ads → card → detail. The stage comes from `GET /api/studio/campaigns/summary` (exists from P1-20; Meta-fed from P3).
- **Results card** (once linked): Meta stage in plain words + "checked X ago"; Meta used vs paid; the main result for `goalDetail`; cost per result, reach, impressions; "Reported by Meta".
- **States:**
  - not linked → "Results appear after the team finishes setup in Meta";
  - `throttled`/`error`/`insightsState=unavailable` → last good numbers + "Meta's numbers are late; we'll check again automatically" (never a false $0);
  - `not_found`/`not_allowed` → "The team is checking this" (staff health item);
  - **Albayan–Meta connection down** → «نعمل على إصلاح اتصال البيان بميتا» (no blame on the customer).
- **Recovery:** no customer refresh in the MVP (R2); scheduled sync; staff "Check Meta now".
- **Permissions:** owner or staff (§7.5).

**J5 Change, withdraw, stop, finish (money outcomes)**
| Stage | Action | Sheet shows | Server |
|---|---|---|---|
| Waiting for review | **Withdraw** | "Your $X reservation ends now. The request goes back to Draft." | `POST /api/ad-studio/campaigns/{id}/withdraw` (one locked transaction, §7.8) |
| Approved, before start day, not linked | **Stop & full refund** | Paid $X → returned $X | existing `/stop` (`ad_campaign_actions.py:262-279`) |
| Approved after start / stages 5–9 | **Ask to stop (urgent)** | «سنوقفه قبل <الوقت>. قد تواصل ميتا الصرف حتى نوقفه؛ نعيد لك ما لم تصرفه ميتا بعد أن تثبت أرقامها (عادةً خلال يومين إلى ثلاثة بعد التوقف).» **Outside working hours** the sheet adds «لإيقاف عاجل الآن راسل فريق المناوبة على واتساب» with a button that opens `wa.me/<on-duty number>?text=<ad reference>` (a user navigation, not a fetch; D29) | `POST …/{id}/stop-request`: sets `stopRequestedAt`, creates an urgent ticket with `dueAt`, bumps the staff pulse, sends a staff channel alert (P3-21) |
| Staff, stage 10 | **Finish & settle** | Paid $X, Meta used $Y (confirmed at <time>), return $X−Y (may be lowered, never raised above the cap) | existing `/stop` staff branch + `closeReason` + settlement gates (§7.8: nothing delivering, a Meta read ≥ 48 h after delivery ended, or never delivered) |
| Finished / Stopped / Rejected | **Archive** | "Hidden from lists; the ledger and your money history stay." | existing delete (`main.py:4929-5028`) |

- **Errors:** a withdraw racing an approval → 409 "already approved — ask to stop instead". Exactly one action wins (§7.8; proven on PostgreSQL, P1-19). Every action is single-flight, with an `operationId` per (action, version) (`15c:717-725`).
- **Classic layout:** the "Ask us to stop it" toast (`15c:540`) becomes the same stop-request sheet (P3-10), so the service works in both layouts.

**J6 Set up comment auto-replies (FB/IG)**
- Pages & replies → Rules → New rule:
  1. **Where:** platform + page chips (stable `pageRefs`, e.g. `fb:<metaPageId>`; empty = all pages).
  2. **When:** every comment or keywords (≤30 × 40 chars; Arabic normalisation, `social_studio.py:126-259`).
  3. **Reply:** public (≤1000 chars); private message **with its capability label**, disabled with the reason while gated; like (FB only); once per person; quiet hours.
  4. **Save** → on/off toggle and today's counters.
- **Honest labels** (from `studioCapabilities`, per channel):

  | State | Arabic label | Shown when |
  |---|---|---|
  | `on` | «يعمل» | Webhook delivery proven (FB: P0-01(g) passed and page subscribed; IG: after approval) |
  | `poll` | «يعمل — نفحص التعليقات كل 5 دقائق» | IG road 1 (P0-01(w) passed, P4-09) |
  | `gated` | «بانتظار موافقة ميتا — لن يعمل بعد» | Waiting for App Review |
  | `unavailable` | «غير متاح حالياً» | D34 fired (Business Verification refused or stuck) |
  | `off` | hidden | Admin switched the channel off |

  Instagram rules can be saved in any state and start working when the state changes. No new release is needed.
- **Validation:** `_clean_rule` (`social_studio.py:586-632`) + `pageRefs` ownership.
- **States:**
  - no pages → Request a page link;
  - master switch off → banner;
  - page removed → «الصفحة لم تعد مربوطة» + `page_not_linked` in the log;
  - the log shows each comment, rule, actions and **the problem in plain words**, including «فاتنا أثناء انقطاع الاتصال» when a parked reply passed its window;
  - **Albayan–Meta connection down** → one neutral banner, and new comments are **kept and answered after the repair** (within 24 h for public replies, 7 days for private).
- **Recovery:** failure row → "Fix connection" or "Ask about this".
- **Permissions:** owner with an active plan (`social_studio.py:453-466`).

**J7 Link a page and fix a connection**
- Pages & replies → Pages. Health chip: يعمل Working / يحتاج انتباه Needs attention (reason) / بانتظار الفريق Waiting for team, always with «فُحص قبل X».
- **"Request a page link":**
  - platform and page link;
  - for Instagram, two questions: «هل حسابك على إنستغرام حساب أعمال أو صانع محتوى ومربوط بصفحة فيسبوك؟» and **«هل حسابك عام (غير خاص)؟»**, each yes/no/not sure (requirements VERIFIED: professional account linked to a Page, research 2.5; public account needed for comment notifications, instagram-platform/webhooks);
  - checkbox "I added Albayan to my page in Meta Business Suite", with a guide [ASSUMPTION: steps checked by staff, P4-07].
  - This creates a `connection_request` ticket; staff link with the existing admin sheet after checking both answers.
- **Needs attention reasons:** token revoked / page role lost / permission missing / webhook not subscribed / Instagram not professional or not linked / **Instagram private** (confirmed by staff) / **Instagram comments not arriving** (heuristic, P4-03) / throttled.
  - Customer-fixable reasons offer one fix and "I did it, check again" (ticket). For Instagram the first fix step is «اجعل حسابك عاماً من إعدادات إنستغرام».
  - **"Webhook not subscribed" is a team action.**
  - **When Albayan's own token fails** (global state, confirmed by a direct token check, P3-18a), per-page reasons are suppressed and the customer sees the neutral banner.
- **Permissions:** customers cannot link or unlink (`test_social_studio.py:818`); staff/admin link.

**J8 Get help (ticket)**
- Help → New ticket: category (ad / payment / replies / connection / TikTok / account / other); related-item picker (pre-filled when opened from an item); message (≤2000). The thread shows customer and «فريق البيان» messages (no staff name or id), a status chip, `T-XXXXXXXX`, and **"We reply by <due time>"** (P3-16).
- **States:** waiting for team (amber) / waiting for you (blue, shown in Needs you) / resolved (green, reopen within 7 days) / closed.
- **Recovery:** a retry with the same `clientRequestId` never duplicates; logged out → login help line.
- **Permissions:** any logged-in studio customer, including lapsed ones, **in either layout**; payment/account tickets are admin-only.

**J9 TikTok service request (managed)**
- Pages & replies → TikTok. Card header: «خدمة تيك توك — مساعدة يدوية من فريق البيان، بدون ردود تلقائية».
- **Form:** handle `@name` (`^[A-Za-z0-9._]{2,24}$`) or profile URL; account type; wants (help setting up TikTok's own auto-messages / advice on comments / ask about TikTok ads); contact preference (ticket or WhatsApp); note. The "What you get today" box (§8.4) is shown before submit.
- **Card text per status** (never "connected"):

  | Status | Card text |
  |---|---|
  | requested | «أُرسل طلبك — سنتواصل خلال يوم عمل» |
  | contacted | «تواصلنا معك — افتح التذكرة» (Needs you) |
  | in_progress | «نساعدك الآن في الإعداد داخل تطبيق تيك توك» |
  | done | «اكتملت المساعدة — الرسائل التلقائية يشغّلها تيك توك نفسه من حسابك» |
  | not_possible | «غير ممكن حالياً: <السبب>» |
  | cancelled | «أُلغي الطلب» |

- **Permissions:** owner; plan inclusion per D14.

**J10 Staff: review → launch → track → settle (on a phone)**
1. **Staff pulse:** the desk polls `GET /api/studio/staff/pulse` every 20 s while visible (and immediately on focus). It updates counters and the title badge, and plays the sound for new urgent items. With no desk open, the alert channel carries urgent items (P3-21).
2. **`requests`:** reason picker; Approve sheet ("charges $X; runs N days; studio code ALB-S-XXXXXXXX"). The server recomputes the end from `durationDays` (P1-11) and assigns `studioRef` (P1-09). Legacy daily rows follow D33.
3. **`launch`:** build in Ads Manager **on the Studio ad account**, with **the studio code in the campaign name** and a lifetime budget ≤ paid, then **Link Meta campaign**. The server checks that:
   - the account is in `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` (non-empty) and in the admin allowlist;
   - the campaign exists there;
   - **its name contains this request's `studioRef`**;
   - it is not linked elsewhere.
   
   It warns if Meta's budget is above paid.
4. **Tracking:** the sync keeps stage and spend current; `health` lists problems.
5. **Finish & settle** when "Ended": pre-filled paid − confirmed Meta spend. The button is enabled only when no ad delivers and spend was read **≥ 48 h** (`spendDelayHours`, D28) after delivery ended. A read is scheduled exactly then (P3-03). Exception: an ad that Meta never delivered (0 impressions and $0 at the final check) may settle at once. An admin override needs a written reason (audited, kept forever).
6. **Time-critical items** show **Message on WhatsApp** (with consent) or **Email** (`mailto:`), audited.
- **Permissions:** `adCampaignRequests.review`. Payments, payment/account tickets and settle overrides are admin-only.

**J11 Lapsed subscription**
- Home shows "Plan ended". Money actions, tickets and the wallet stay available; new requests, rules and posts are blocked with Renew (LYD). Existing server rules: reads stay open, and self-stop skips the plan check (`ad_campaign_actions.py:218-221`).

---

## 6. Integration with the main application
- **Entry points (unchanged):** the `/studio` shell (`IS_STUDIO_SHELL`, `src/01-platform.js:17-21`); `/ads-studio` inside the manager (`src/08-data-audit.js:1323-1337`); the Smart Systems card `ad_maker` (`src/05-state-services.js:178-192`).
- **Return path:** the shell keeps "no way back to the manager" (`scripts/test-mobile-ui.js:1172-1176`); `/ads-studio` keeps its back logic (`15c:280-286`); phone Back works as in §5.1.
- **Startup-bundle byte budget** (`script.js` headroom 558 B [VERIFIED `scripts/test-architecture.js:40-42`]). This revision adds **0 bytes**: the staff pulse, jobs loop, lanes, hours, token health, polling and alerts are all lazy or server-only.

  | Change | File | Estimate [ASSUMPTION] |
  |---|---|---|
  | Arabic default in the shell (D2) | `05-state-services.js:714` | +~25 B |
  | Android Back hook (D21) | `01b-mobile-runtime.js:299-312` | +~70 B |
  | Login help hook, shell only (D21) | `12-views.js:1054` | +~60 B |
  | Shorter brand name (D1) | `05-state-services.js:181-182`, `12-views.js:757` | −~20 to −40 B |
  | **Net** | | **≈ +115 to +155 B; ≥400 B stay free** |

- **Identity and permissions:** the same `albayan_session` cookie and user (`main.py:536-542`); the same `walletTransactions` and `serviceSubscriptions`; presets `adsStudioCustomer`, `adsStudioReviewer`, admin. **No new permission module.** Staff features check `adCampaignRequests.review` server-side (`ad_campaign_actions.py:164-168`); admin-only items check `role == admin`.
- **Reuse vs new:**
  - **Reuse:** lifecycle endpoints, ledger keys, charge requests, plan purchase, Social Studio engine/scheduler/composer and `process_comment()`, `MetaAdsClient` (`appsecret_proof`, pacing, `get_account_funds`), `apiJson`, `adsStudioText`, `normalizeDigitsAscii`, the image pipeline, `.mobile-bottom-nav`, `ads-workspace.css`, the password-change route, the `ad_final_spend.py:10-40` evidence pattern, the PostgreSQL Barrier harness, `data_integrity.py`, **the operations alert sender (`operations.py:784-809`)**, and **the "Publish verified Docker image" workflow**.
  - **New:** studio router (`/api/studio/*`), studio jobs loop, withdraw, stop-request, results bridge, tickets, TikTok requests, activity feed, staff pulse, alerts, `studioProfiles`, service hours, Studio account configuration, Meta call lanes, **token health**, **Instagram comment reader/poller**, **webhook delivery counter**, and the v2 UI files.
- **Core books separation (D26) [RECOMMENDATION].**
  - **Problem [VERIFIED]:** the core worker imports every new ad on allowlisted accounts into `ads` as "needs setup / not paid" (`meta_ads.py:1020-1021, 3146-3206, 4064-4080, 5452-5463`). Discovery runs every 60 s by default (`:1041-1043`). A studio ad already paid from the wallet would look like unpaid agency work (`13-filters-helpers.js:22, 208-232`; `12b-control-center.js:39-45`; `operations.py:379`).
  - **Two protections, both always on:**
    1. **Studio account.** Studio campaigns run on **one dedicated USD "Studio" ad account** in `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` (a subset of `ALBAYAN_META_AD_ACCOUNT_IDS`, so the funds panel still shows it). Discovery, manual import and `import_meta_ad_draft` skip that account.
    2. **Studio code in the name.** Every studio campaign name contains the request's `studioRef` (`ALB-S-` + 8 no-lookalike characters, assigned at approval). Discovery already reads `campaign{id,name}` (`meta_ads.py:1387-1393`), so it skips any ad whose campaign name contains `ALB-S-` **before** importing, on any account. Link validation refuses a campaign whose name lacks this request's code (P0-09, P3-02).
  - **Fallback (D26 option c):** if a new account is impossible (P0-01(n2)), studio campaigns run on the current shared accounts, protected by the studio code alone. The old option (b), hiding drafts at link time, is dropped: discovery usually imports the ad before staff link it, and agency staff may already have touched the draft.
  - **Always:** a daily integrity check (P1-21) confirms that no core `ads` row:
    - has `metaCampaignName` containing `ALB-S-`,
    - shares a `metaCampaignId` with a studio request,
    - or has `metaAdAccountId` in the Studio list and was created after that account's `studioSince` date (so a repurposed account's old history is not flagged).
    
    Past collisions are cleaned by P0-10 (a developer task with the owner's sign-off).
  - **Rollback rule:** once the Studio account carries live campaigns, never redeploy an image older than the P0-09 release (§12.5).
- **Data ownership:** customers own requests, rules, posts, tickets, TikTok requests and their profile (`created_by` = owner, like `social_studio.py:10-12`). Albayan owns the ad accounts, Meta campaigns, the system ledger account, results snapshots, system alerts, Meta health state (`created_by` NULL) and settings.
- **Failure isolation:**
  - If `studio.js` fails, the existing retry card appears (`src/15c0-ads-studio-loader.js:79-95`); the main app is unaffected.
  - **Money jobs never depend on Meta:** the studio jobs loop starts from the studio router whether or not a Meta token is set (P1-21).
  - **Scheduled posts never wait for results syncing or polling:** results sync, page-health checks and Instagram polling run in the studio jobs loop with a per-tick budget, on their own Meta lanes. The Social Studio tick keeps only publishing and reply retries (P3-03).
  - **Meta call lanes (P3-00a–c), each with its own state:**
    - three lanes — `admin` (today's behaviour, unchanged), `studio_results`, `page` — each with **its own lock, pacing clock and back-off record**;
    - **app-wide signals** (codes 4, 17, 613; `x-app-usage` at or above the threshold; unknown usage types) pause **all** lanes, as Meta intends [VERIFIED rate-limiting page];
    - **ads signals** (80000/80003/80004/80014; `X-Business-Use-Case-Usage` entries of type `ads_insights`/`ads_management`/`custom_audience`; `X-Ad-Account-Usage`) pause only the `admin` lane (as today, pinned by `server/test_meta_ads.py:792-815`) or park only the Studio account named by the header's object-id key on the `studio_results` lane;
    - **page signals** (32/80001/80002/80006; `pages`/`instagram`/`messenger` types) park only the page named by the header key (P4-04);
    - so neither an admin `usage_high` pause nor a 15 s admin timeout blocks a reply.
  - Worker failures are caught per tick (`social_studio.py:1013-1022` pattern).
  - Until P4, the v2 Pages & replies tab embeds the existing 15f screens.
  - Switching the customer layout off never hides tickets, stop requests or the staff desk (§5.1).
- **Access boundaries:**
  - `/api/meta-ads/*` stays admin-only (`meta_ads.py:5593-5598`).
  - The results bridge requires a non-empty Studio list, the account in it **and** in the admin allowlist (`_ensure_allowed_account` fails open, `meta_ads.py:1093-1098`); otherwise it returns `not_allowed` with no call (P0-09).
  - The browser never calls Meta (CSP `connect-src 'self'`, `server/http_security.py:44-75`); `wa.me`/`mailto:`/`tel:` are user navigations.
  - The staff alert channel receives no customer personal data (kind, count and reference only).

---

## 7. Data model, modules, APIs, jobs, security, wallet

### 7.1 Entities (all rows in the generic `entities` table)
- New types are refused by the generic `/api/collections` API (extend `SOCIAL_STUDIO_COLLECTIONS`, `server/social_studio.py:50-52`, used by `main.py:3874-3876`). This costs **0 main.py lines**.
- **All new ids are fixed-length:** prefix + the first 40 hex characters of sha256 (entity ids must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$`, `main.py:717`).
- **`created_by` rule [VERIFIED reason: FK to `users.id`, `server/db.py:303`]:** every new row has `created_by` = a real user id (the owner, or the acting admin) **or NULL** for system rows. Never a made-up value such as `'system'`. A PostgreSQL scenario inserts a system alert (P1-19).

**`adCampaignRequests` (existing).** Additive fields; `schemaVersion` 2 on new writes.
- **Customer fields** (appended to `AD_CAMPAIGN_ALLOWED_FIELDS`, `main.py:4602-4630`; 0 net lines; otherwise PATCH refuses with 400, `ad_campaign_fields.py:298-306`, `main.py:11811-11821`): `locationKeys[]` (≤25), **`durationDays`** (1–90), **`goalDetail`** (`messages|page_likes|post_engagement|video_views|website_visits|leads|sales`).
- **Server-owned fields** (appended to `AD_CAMPAIGN_WORKFLOW_FIELDS`, `main.py:4564-4601`):
  - `closeReason` (`''|customer_stop|staff_stop|completed`);
  - `withdrawnAt`, `lastWithdrawOperationId`;
  - `changeReasons[]`;
  - `stopRequestedAt`, `stopRequestTicketId`, `lastStopRequestOperationId`;
  - `launchMode`;
  - **`studioRef`** (`ALB-S-` + 8 no-lookalike characters; unique; assigned at approval);
  - `metaAdAccountId`, `metaObjective`, `specialAdCategoryCountry`;
  - `resultsLinkedAt`;
  - `settledSpendMinorUSD`, `metaSpendAtSettleMinorUSD`, `settleOverrideReason`, **`settleBasis`** (`final_read|never_delivered|override|never_linked`);
  - `publishStatus` adds `meta_review`;
  - **`legacyRules`** (true when submitted before the P1 cutover, P1-18).
- **Status machine** (one new edge):
  ```
  Draft ─submit→ Submitted ─approve→ Approved ─stop/settle(closeReason)→ Stopped
    ↑   ←withdraw(NEW; keeps submittedAt)─┘ │ └reject(reasons)→ Rejected
    └─edit─ Changes Requested ←request changes(reasons)┘
  Approved: display stage derived (§5.4); publishStatus = manual marker for money rules only
  Approval (with durationDays): start = max(requested start, Libya today); end = start + durationDays − 1
  ```

**`adCampaignResults` (new; type defined in P1-20, filled by the Meta sync from P3).**
- **Id:** `acr_` + sha256(campaignId)[:40]; `created_by` = request owner; fields `campaignId`, `ownerId`.
- **Link:** `metaCampaignId`, `metaAdAccountId`, `metaCampaignName`.
- **Status:** `campaignEffectiveStatus`, `campaignStopTime`, `adStatusCounts`, `anyAdDelivering`, `adsetEndTime` [VERIFIED read, `meta_ads.py:2043`], `reviewFeedbackPublic`, `reviewFeedbackStaff` (staff only), `metaStage`.
- **Numbers:**
  - `spendMinorUSD` — the last confirmed value, never overwritten by an unreadable pass (same rule as `meta_ads.py:4280-4310`);
  - **`lifetimeImpressions`**;
  - `insightsState` (`never|ok|unavailable`) and `spendConfirmedAt`;
  - `deliveryEndedAt` — the first sync with nothing delivering; cleared if delivery resumes;
  - **`settleReadDueAt`** — `deliveryEndedAt` + `spendDelayHours` (48 h default); one read is scheduled for then;
  - **`neverDelivered`** — true when the final read shows 0 impressions and $0 over the ad's life;
  - **`driftWatchUntil`** — `deliveryEndedAt` + 28 days;
  - **`stopEffectiveAt`** — the first sync after `stopRequestedAt` with nothing delivering; feeds the stop p90 metric;
  - `reach`, `impressions`, `clicks`, `resultType`, `resultCount`, `costPerResultMinorUSD`;
  - `currency` (must be USD, otherwise `currency_mismatch`).
- **Sync:** `syncState` (`never|ok|throttled|parked|not_found|not_allowed|error`), `lastSyncedAt`, `lastErrorCode`, `nextSyncAt`, `syncClaimedUntil` (a claim written with a version check).

**`supportTickets` (new).**
- **Id:** `tkt_` + sha256(owner|clientRequestId)[:40]. **Number:** `T-` + 8 no-lookalike characters (the `PAY-` pattern, `wallet_payments.py:83-86`), unique inside the insert transaction under an advisory lock, with 3 retries.
- **Fields:** `ownerId`, `category` (`ad|payment|replies|connection|connection_request|stop_request|tiktok|account|other`), `audience` (`admin` for payment/account, else `team`), `priority` (`urgent` for stop_request), **`dueAt`** (from the service-hours helper, P3-16), `subject`, `relatedType`, `relatedId`, `status`, `lastCustomerAt`, `lastStaffAt`, **`firstStaffAt`**, `resolvedAt`, `closedAt`, `internalNote` (staff only).
- **Status machine:** `open(waiting_team) ⇄ waiting_customer → resolved ─(7 days)→ closed`; `resolved ─customer reopen ≤7d→ waiting_team`.

**`supportTicketMessages` (new, append-only).** Id `tkm_` + sha256(ticketId|clientMessageId)[:40]; `created_by` = ticket owner; `ticketId`, `ownerId`, `author` (`customer|team`), `authorUserId` (never returned to customers), `text` (≤2000), `at`, `clientMessageId`.

**`tiktokServiceRequests` (new).** Id `ttr_` + sha256(owner|clientRequestId)[:40]; `ownerId`, `handle`, `profileUrl`, `accountType`, `wants[]`, `contactPreference`, `note`, `status`, `customerNote`, `internalNote`, `timeline[]` (≤50). Status: `requested → contacted → in_progress → done | not_possible`; the customer can move `requested|contacted → cancelled`.

**`studioProfiles` (new; one per owner; usable when lapsed).** Id `stp_` + sha256(owner)[:40]; `whatsappNumber` (E.164), `whatsappConsentAt`, `activitySeenAt`. Stored outside `users` (there is no phone field there, `main.py:3218-3226`).

**`studioAlerts` (new).**
- Id `sal_` + sha256(kind|relatedId|day)[:40].
- **`created_by` = the affected owner when the alert concerns one customer, else NULL** (system). `ownerId` is repeated as a data field.
- `kind` is one of: `reply_failure_burst`, `page_health_drop`, `meta_overspend`, `post_settle_spend_drift`, `running_past_end`, `approval_interrupted`, `results_parked`, `studio_account_config`, `studio_funds_low`, `studio_account_inactive`, `meta_connection_down`, `meta_token_expiring`, `replies_parked`, `instagram_comments_not_arriving`, `integrity_violation`, `jobs_heartbeat_late`, `stop_request_overdue`, `payment_confirm_overdue`, `storage_threshold`, `studio_core_collision`.
- Other fields: `relatedType`, `relatedId`, `firstAt`, `lastAt`, `count`, `customerVisible`, `acknowledgedAt`, `acknowledgedBy` (staff only), **`channelSentAt`**.

**`studioJobState` (new, one row, `created_by` NULL).** `lastTickAt`, `lastSweepAt`, `lastIntegrityScanAt`, `lastIntegrityResult` (counts only), `lastStorageReadAt`, storage figures. Read by diagnostics, the heartbeat alert, and the operations worker's heartbeat watch (P3-21).

**`metaHealthState` (new, one row, `created_by` NULL; P0-13/P0-14).** Counts and flags only; never a token.
- `token`: `{isValid, type, appMatches, expiresAt, dataAccessExpiresAt, scopes[], missingScopes[], pagesCoveredByScope, checkedAt}`.
- `webhookCounters`: counts per day for the last 30 days, by object and field (e.g. `page.feed`, `instagram.comments`, `instagram.other`).
- `connection`: `{state: ok|down, since, lastDirectCheckAt}`.

**`socialPages` (existing).**
- New fields: `healthState`, `healthReason` (`token_revoked|page_role_lost|permission_missing|webhook_not_subscribed|instagram_not_professional_or_unlinked|instagram_private|instagram_comments_not_arriving|throttled`), `lastHealthCheckAt`, `webhookSubscribedAt`, `pageLaneParkedUntil`.
- Instagram only: **`igPollState`** (`off|on|error`), **`igPollNextAt`**, **`igPollCursor`** (per recent media: last seen comment time and `comments_count`, ≤10 entries), **`igLastCommentEventAt`**.
- `healthy` is **derived** as `healthState==='ok'`; both fields are written only by `_set_page_health()`, so the classic dot (`15f:256`) and v2 agree.

**`socialReplyRules` (existing).** Optional `pageRefs[]` (`fb:<metaPageId>` / `ig:<metaPageId>`); empty = all pages (backward compatible). Row ids (`spg_…`) are not used because a relink creates a new random id (`social_studio.py:1655-1657`).

**`socialReplyLog` (existing).** New fields:
- **`receivedAt`** (webhook arrival or poll read) and **`sentAt`** (reply acknowledged by Meta), for the latency metric (P4-02);
- **`source`** (`webhook|poll|manual_check`);
- **`parkedReason`** (`meta_connection_down`);
- **`giveUpAt`** — comment time + 7 days if a private message is pending, otherwise + 24 h (P3-18b).

**`studioSettings` (new, admin, versioned, append-only like `subscription_plans.py:541-576`).**

> **As built in P0 stages 3–4 (2026-09-25):** one row per key: `rollout`, `intake`, `capabilities`, `limits`, `settlement`, `hours`, `contact`, `targets`, `thresholds` (no `studio-accounts`, dropped by D26, see below). Each is saved with a version check (`expectedVersion`). History is kept in the audit log instead of extra rows: every save writes an audit entry with action `studio_setting` and the before/after values **in the same transaction**, and `studio_setting` is in the server's permanent keep list (`_AUDIT_KEEP_ACTIONS`). A stored value is always read back through today's rules: a field, entry or list item that fails keeps its safe default, so a hand-edited row never reaches a customer. The rollout record names its lists `uiAllowlist` and `staffAllowlist`. Services are `off|pilot|on` each (`help`, `stopRequest`, `tiktok`; `pilot` = the customer allowlist). `intake` is `open` (true/false) and `maxSubmissionsPerDay` (1–500). The **`STAFF_DESK_IN_USE`** guard (409 when `staffDesk` goes off while open tickets or stop requests exist) arrives with the tickets in P3-20. `/api/studio/me` shows only the public parts: `adLimits` (every limit except `p1CutoverAt`), `serviceHours` (plus `openNow`) and `contact` (without `urgentWhatsapp`).
- `studioRollout`: customer layout mode `off|pilot|on`, `userIds[]`; **`staffDesk`** mode `off|pilot|on`, `staffUserIds[]`; **`services`** mode `off|pilot|on` (follows the customer allowlist during the pilot).
- **`intake`:** `open|paused`, `pausedMessageAr/En`, **`maxSubmissionsPerDay`** (D29; starts at 5).
- `studioCapabilities`: `fbPublicReply`, `fbPrivateReply`, `igPublicReply`, `igPrivateReply`, `tiktokService`, each **`on|poll|gated|off|unavailable`** (`poll` only for `igPublicReply`).
- **`limits`** (D4 + D5; `/me` calls it `adLimits`): `minTotalMinorUSD` / `maxTotalMinorUSD` (the total one request costs: the lifetime amount, or daily × days; default $5–$2,000), `minPerDayMinorUSD` (the per-day floor; $1 until P0-01(f) reads Meta's `min_daily_budget`), `maxDays` (1–90); always minimum ≤ maximum and floor ≤ minimum total; **`p1CutoverAt`** (a time with its zone, kept in UTC; null until the P1 release stamps it, P1-18). `/me` shows every limit except `p1CutoverAt`, per-day floor included (client limits = server limits, P1-08b).
- **`studioAccounts`: dropped by D26** (studio ads stay on the same ad accounts as the agency): no `studio-accounts` key and no `STUDIO_ACCOUNTS_MISMATCH` check.
- `settlement`: **`spendDelayHours` (default 48, D28; 0–168)**, **`neverDeliveredImmediate`** (default true), **`driftWatchDays`** (28; 1–90). The drift watch must outlast the settle wait: `driftWatchDays` × 24 > `spendDelayHours` (equal is refused).
- **`hours`** (D11; `/me` calls it `serviceHours`): `timezone` fixed to `Africa/Tripoli`; **`week`** `{sun…sat: {open, close} | null}` (HH:MM on the same day, null = closed, at least one working day; default Sun–Thu 09:00–17:00 [ASSUMPTION: owner confirms in D11]); **`ramadan`**: null or one `{from, to, open, close}` window (at most 31 days) that replaces the hours of the working days; `holidays[]`: `{date, labelEn, labelAr}` (ISO dates, labels optional, one per date, at most 60); **`onDutyUntil`** (HH:MM or null, e.g. 23:00 for urgent stops, D29). `/me` adds `openNow` (Tripoli time), leaves out past holidays and a finished Ramadan window, and shows `onDutyUntil` only while an `urgentWhatsapp` exists.
- `contact`: public `whatsapp`, `phone` and `email` (in `/me`); **`urgentWhatsapp`** (the on-duty number, shown only in the after-hours stop sheet, never in `/me`). Each is optional; numbers are kept in international form (+218…; Arabic digits, spaces and dashes are accepted, 00 becomes +).
- **`targets`** (D11): `reviewBusinessDays` (1), `ticketFirstResponseMinutes` (240), `stopRequestMinutes` (120; never above the ticket target), **`paymentConfirmMinutes`** (240), `settlementBusinessDays` (2, measured from `settleReadDueAt`), `tiktokBusinessDays` (1). Minutes count only inside `hours` (P3-16).
- **`thresholds`** (D32; the §12.8 go/no-go numbers and the token alert days): `goConsecutiveWeeks` (2), `reconcileToleranceMinorUSD` (500) with `reconcileToleranceBasisPoints` (100 = 1%), `queueOnTargetPercent` (90), `resultsFreshPercent` (90) with `resultsFreshHours` (6), `webhookReplyP95Seconds` (120), `pollReplyP95Seconds` (600), `replyFailureMaxPercent` (5), `restoreProofMaxDays` (7), `tokenMinDaysLeft` (14), `strandedCaptureMaxMinutes` (60), `replyOutageMaxHours` (6), `heartbeatLateMaxMinutes` (15), `tokenExpiryWarnDays` (`[14, 7, 2]`; 1–5 day counts, largest first). The zero-tolerance rows are fixed rules, never stored; the storage and funds-margin numbers arrive with the storage read and D30 (P3).

### 7.2 Module boundaries

> **Since D36 (2026-09-24):** Ads Studio lives in `server/systems/ads_studio/` and `src/systems/ads_studio/` (see [docs/SMART_SYSTEMS.md](../SMART_SYSTEMS.md)). Every new Ads Studio module named in this plan (`studio_api.py`, `studio_jobs.py`, `studio_types.py`, `studio_errors.py`, `studio_hours.py`, `studio_ig_poll.py`, `15g-studio-core.js`, `15h-studio-shell.js`, …) is created inside those folders, and paths below that say `server/ad_campaign_actions.py`, `server/social_studio.py`, `src/15c-ads-studio.js` or `src/15f-social-studio.js` now mean their `systems/ads_studio/` location. `meta_token_health.py` and the Meta lanes are platform code.
| File | Responsibility |
|---|---|
| `server/audit_routes.py` (new, P0-02) | `/api/audit*`, moved word for word from `main.py:13231-13358` |
| `server/studio_errors.py` (new, P0-08) | `studio_error(status, code, message)` for `/api/studio/*` only, plus the code list |
| `server/studio_types.py` (new) | Type constants, `derived_id()`, the `created_by` rule helper, `studio_ref()` |
| `server/studio_hours.py` (new, P3-16) | `studio_due_at(start, target, settings)`, `is_working_time()`; pure and tested |
| `server/meta_token_health.py` (new, P0-14, P3-18a) | `read_token_debug()` (server-side `debug_token` with the app access token, built in memory from `ALBAYAN_META_APP_ID` and the app secret, never stored or logged); `check_token_now()` (cached 10 min); expiry-warning computation; writes `metaHealthState.token`. **As built:** platform code (the Meta key belongs to the platform, D36); each reading carries a one-way fingerprint of the key it checked, so a replaced key is shown as "not checked yet", never with the old key's health |
| `server/studio_ig_poll.py` (new, P1-23, P4-09) | `read_recent_ig_comments(page, since)` (recent media ≤10 from the last 7 days, only media whose `comments_count` changed, top-level comments newer than the cursor and the rule creation); feeds `process_comment(..., source)`; budgeted poll pass |
| `server/studio_alert_out.py` (new, P3-21) | `notify_staff(kind, ref, count)` → `operations._send_alert` with one kind per urgent item; no personal data |
| `server/studio_jobs.py` (new, P1-21) | The studio jobs loop: orphan sweep, stale-Submitted alert, overdue checks, daily money scan, storage read, heartbeat; results sync, page-health checks, token check and Instagram polling (Meta parts only if configured, budgeted) |
| `server/studio_api.py` (new) | `create_studio_router` (plus its startup/shutdown events that start the jobs loop): me, pulse, staff pulse, activity, profile, public contact, wallet summary, campaigns summary, results, staff lists, contact link, admin rollout/intake/capabilities/limits/settlement/hours/contact/targets/diagnostics/meta-token/fact tests/check-comments; the test-only seed route (e2e, guarded) |
| `server/studio_support.py` (new) | Tickets, stop-request tickets, TikTok requests, alerts; `scrub_studio_personal_data_conn()` |
| `server/studio_results.py` (new) | `derive_display_stage()` (pure, P1-20), link validation (account, `studioRef` in name), sync with claims, settlement gate checks, drift watch |
| `server/ad_campaign_actions.py` (existing) | Adds: submit (moved from `main.py:10313-10427`, then serialised, with the intake/cap check), review (moved from `main.py:10430-10609`, then self-release on 409, legacy-row rule, `studioRef`), withdraw, stop-request, `closeReason`, settlement gates, `meta_review`, `durationDays`, reason codes, the boost rule, budget limits |
| `server/wallet_payments.py` (existing) | Adds: `wallet_buckets_minor()`, the orphan sweep helper, staff-field redaction |
| `server/social_studio.py` (existing) | Adds: the private-reply fix; `pageRefs`; `/log`; the health helper; the subscribed_apps check/backfill (if P0-01(l) passes); per-page back-off; the capability gate; `receivedAt`/`sentAt`/`source`; **the webhook delivery counter (P0-13)**; **authorization-failure parking (P3-18b)**. Its worker tick is **not** given new work |
| `server/meta_ads.py` (existing) | Adds: the Studio account list, plus a discovery/import skip for the Studio account **and for `ALB-S-` campaign names**; per-lane request state (`lane=`); usage classification by documented header type and object key; `get_campaign_results()`; token-cache eviction on 190; optional `ad_review_feedback` |
| `server/operations.py` (existing) | Adds: a `text` field in the alert payload (additive, P3-21, if P0-01(u) needs it); a heartbeat watch on `studioJobState.lastTickAt` in its 300 s loop |
| `server/entity_projection.py` (existing) | Staff-identity redaction for non-staff viewers |
| `server/data_integrity.py` (existing) | Adds: wallet identity, capture/return pairing, Studio/core separation (account, name code, `studioSince`); a fast `scan_studio_money()` run daily |
| `privacy.html` (existing) | Factual corrections (P0-12); customer terms section (P5-06) |
| `.github/workflows/ci.yml`, `.github/workflows/publish-image.yml` (existing) | The missing test scripts; the PostgreSQL financial step in the publish workflow (P0-11) |
| `src/15g-studio-core.js` … `src/15l-studio-staff.js` (new, lazy) | v2 UI (§10) |

### 7.3 API contracts (new or changed)
- **Common rules.** Every route uses `current_user` unless marked public. Every mutation calls `require_same_origin`, then a rate limit, then `audit()`. Replays are keyed by `operationId` / `clientRequestId` (`[A-Za-z0-9][A-Za-z0-9._:-]{7,119}`, as in `ad_campaign_actions.py:33`).
- **Error shape by URL prefix:**
  - `/api/studio/*` → `{"detail":{"code","message"}}`. The client reads `err.payload.detail.code`; `apiJson` keeps the body (`src/09-api-auth.js:279-282`) [VERIFIED].
  - `/api/ad-studio/*`, `/api/wallet/*`, `/api/social-studio/*` → a string `detail` with a **stable English prefix** (`apiDetailMessage` stringifies dicts, `09-api-auth.js:165-179`). Each has an Arabic entry in `_ADS_STUDIO_REFUSAL_AR` (P1-08c) and a v2 code (P2-11). **The classic map only ever gains entries**, so older bundles keep their Arabic text (§12.1).
  - 429 has no body and is mapped by status.

**Customer and public routes**
| Method & path | Auth | Idempotency | Success | Errors |
|---|---|---|---|---|
| `GET /api/studio/me` | any user | — | `{ui, services:{help,stopRequest,tiktok}, staffDesk, intake, capabilities, adLimits, serviceHours, plan, isStaff, isAdmin}` | 401 |
| `GET /api/studio/public/contact` | **public** | — | `{whatsapp, phone}` | 429 (60/min/IP) |
| `GET /api/studio/pulse` | any | — | `{changedAt}` = `MAX(last_modified)` over the caller's studio rows, using **columns only** (index `entities_created_by`, `server/db.py:310`); polled every 30 s while visible | 401, 429 (120/min) |
| `GET /api/studio/activity?before=&limit=` | owner | — | derived items (§7.6) + `activitySeenAt` | 401 |
| `POST /api/studio/activity/seen` `{upTo}` | owner | idempotent (max) | `{activitySeenAt}` | 400 |
| `GET/PUT /api/studio/profile` | owner (lapsed OK) | PUT idempotent | profile | 400 `PHONE_INVALID`, `CONSENT_REQUIRED` |
| `GET /api/studio/wallet/summary` | owner (lapsed OK) | — | `{usd:{addedMinor, adjustmentsMinor, reservedMinor, inAdsMinor, metaUsedInAdsMinor, metaCheckedAt, beingReturnedMinor, spentMinor, availableMinor}, reserved, inAds, chains, lyd:{balanceMinor}, pendingPayments:[{reference, dueAt}]}` | 401 |
| `GET /api/studio/campaigns/summary` | owner | — | `{[campaignId]:{stage, checkedAt, metaUsedMinor, stopRequestedAt, dueAt, settleExpectedAt}}` | 401 |
| `GET /api/studio/campaigns/{id}/results` | owner / staff | — | snapshot + stage | 404 |
| `POST /api/ad-studio/campaigns/{id}/submit` (moved, serialised) | owner + plan | `operationId` | entity | 400 invalid / budget refusals / "Daily budgets are no longer accepted…"; 403; 404; **409 "New ad requests are paused…"** (intake or daily cap); 409 "Insufficient wallet balance…"; 409 version |
| `POST /api/ad-studio/campaigns/{id}/withdraw` | owner (lapsed OK) | `operationId` | Draft entity | 404; 409 "Only Submitted campaigns can be withdrawn…"; 409 "Conflict: record has changed"; 429 |
| `POST /api/ad-studio/campaigns/{id}/stop-request` `{operationId, note}` | owner (lapsed OK) | `operationId`; a repeat returns the same ticket | `{campaign, ticket, dueAt, afterHours, urgentWhatsapp?}` | 404; 409 "Only Approved campaigns can be stopped" |
| `POST /api/ad-studio/campaigns/{id}/stop` + `closeReason`, `overrideReason` | owner / staff (override: admin) | existing | entity | 403 when a customer sends `completed`/an amount/an override; 409 "Meta is still delivering this ad…"; 409 "Meta spend has not been confirmed since delivery ended…"; 400 "refundMinorUSD is above paid minus Meta spend…" (lifted only by an admin `overrideReason` ≥10 chars, audited) |
| `GET /api/studio/tickets?status=&before=` | owner | — | list (20/page) | — |
| `POST /api/studio/tickets` | owner (lapsed OK) | deterministic id; same payload → 200; different → 409 | ticket + first message + `dueAt` | 400; 404 related item not own; 409 `IDEMPOTENCY_MISMATCH`; 429 (10/h); 409 `TICKET_OPEN_LIMIT` |
| `GET /api/studio/tickets/{id}` | owner / staff (by audience) | — | ticket + messages (paged 50) | 404 |
| `POST /api/studio/tickets/{id}/messages` | owner / staff | deterministic message id | message; status flips | 400, 404, 409 closed, 429 |
| `POST /api/studio/tickets/{id}/status` | owner: resolve/reopen ≤7 d; staff: any | `operationId` | ticket | 403, 409 |
| `GET/POST /api/studio/tiktok/requests`, `POST …/{id}/cancel` | owner | `clientRequestId` | request | 400, 409 >3 open, 429 (5/day) |
| `GET /api/social-studio/log?before=&status=&days=` | owner (admin with `ownerId`) | — | rows `{at,platform,pageName,ruleName,actions,problemCode,source,latencySec}` | 401/403 |
| Rules POST/PATCH + `pageRefs` | owner | existing | rule | 400 "page is not linked to this account" |

**Staff and admin routes.** Lists are paged with a `before` cursor (`created_at,id`, 20/page). A reviewer asking for an admin-audience item gets **404**.
| Method & path | Auth | Idempotency | Success | Errors |
|---|---|---|---|---|
| **`GET /api/studio/staff/pulse`** | staff | — | `{changedAt, counts:{submitted, stopRequests, stopOverdue, ticketsTeam, ticketsAdmin (admin only), paymentsPending (admin only), alerts, launchPending, settlePending}}`; watermark = `MAX(last_modified)` per staff-visible type (index `entities_type_last_modified`); columns-only counts where possible | 403, 429 |
| `POST /api/ad-studio/campaigns/{id}/review` (moved) + `reasonCodes[]` | staff | existing | entity (with `studioRef` on approve) | 400 note/reason required; 409 |
| `POST /api/ad-studio/campaigns/{id}/publish-status` + `meta_review`, `metaAdAccountId` | staff | existing | entity + `warnings[]` | 409 already linked; 400 not a Studio account; 400 campaign not found; **400 "campaign name must contain ALB-S-XXXXXXXX"** |
| `GET /api/studio/staff/campaigns?queue=review\|launch\|running\|ended\|interrupted\|legacy&before=` | staff | — | projected rows, stage, due times, settle countdown | 403 |
| `GET /api/studio/staff/campaigns/summary?ids=` | staff | — | stage summary (workflow-visible rows) | 403 |
| `POST /api/studio/staff/campaigns/{id}/results/check` | staff | rate key per campaign | 200 + cached snapshot + `nextAllowedAt` if < 10 min | 403, 404 |
| `GET /api/studio/staff/tickets?queue=&before=` | staff (reviewers: `team` only) | — | urgent first, with `dueAt` | 403 |
| `GET /api/studio/staff/tiktok`, `POST …/{id}/status` | staff | `operationId` | list / request | 403, 409 |
| `GET /api/studio/staff/health` | staff | — | computed lists | 403 |
| `GET /api/studio/staff/alerts`, `POST …/{id}/ack` | staff | ack idempotent | alerts | 403, 404 |
| `GET /api/studio/staff/pages?health=` | staff | — | name, platform, reason, checked-at; no tokens | 403 |
| `POST /api/studio/staff/contact-link` | staff (payment/account: admin) | — | `{url}`; audited | 403, 404, 409 `NO_CONSENT` |
| `POST /api/social-studio/pages/{id}/check` | staff | rate key per page | health result | 403 |
| **`POST /api/studio/admin/pages/{id}/check-comments`** (P1-23) | **admin** | rate key per page (1/min) | `{read, processed, replied}`: reads the Instagram account's recent comments (newer than the cursor and the rule creation) and feeds `process_comment(source='manual_check')`; audited `check_comments` | 403, 404, 409 not Instagram, 429 |
| `POST /api/studio/admin/pages/{id}/subscribe-test (as built)` `{pageId}` | admin | once per page per day | Meta response summary; audited `subscribe_smoke_test` (P0-05d) | 403, 409 |
| **`POST /api/studio/admin/instagram/{id}/read-test (as built)`** `{pageId, replyToCommentId?}` (P0-05e) | admin | once per page per day for the reply part | `{commentsRead, replySent, errorCode}`; audited `ig_read_test` | 403, 404, 409 |
| **`GET /api/meta-ads/token-health`** (as built; was `/api/studio/admin/meta-token`) | admin; `?refresh=1` same-origin | 30/min; refresh 3/10 min | `{configured, checked, stale, checkedAt, isValid, type, expiresAt, daysLeft, dataAccessDaysLeft, scopes[], missingScopes[], pagesCoveredByScope, lastCheckError, webhookCounts}` — never the token | 403 `{"detail": "Admin only"}` (the platform shape), 429; refresh: 502 when Meta fails |
| **`POST /api/studio/admin/alert-channel/test`** | admin | 1/10 min | `{sent: bool}` (P0-01(u), P3-21) | 403, 429 |
| `GET/PUT /api/studio/admin/settings/{key}` (as built; key = `rollout`, `intake`, `capabilities`, later `limits`, `settlement`, `hours`, `contact`, `targets`, `thresholds`, `studio-accounts`) | admin | `expectedVersion` | record | 403 `ADMIN_ONLY`, 404 `UNKNOWN_SETTING`, 429 `RATE_LIMITED` (30/min), 409 version; **409 `STAFF_DESK_IN_USE`** when switching `staffDesk` off while open tickets or stop requests exist; 400 `STUDIO_ACCOUNTS_MISMATCH` (settings ≠ env list) |
| `GET /api/studio/admin/diagnostics` | admin | — | counts, B1–B6, pilot metrics, queue-target % (incl. payments, payment/account tickets, overrides), capacity, storage, USD owed vs Studio funds, reconciliation, go/no-go checklist, jobs heartbeat, webhook counters, token state; no personal data | 403 |
| `POST /api/studio/test/seed-results` | **exists only in the e2e server** | — | seeds an `adCampaignResults` row | Not mounted unless `ALBAYAN_E2E_STUDIO_SEED=true` **and** SQLite **and** `ALBAYAN_DB_PATH` under `.tmp/e2e`. The router refuses to start if the flag is set with PostgreSQL (production refuses SQLite anyway, `main.py:2424`) |

### 7.4 Background jobs and webhooks (only where justified)
- **Studio jobs loop (P1-21).** One daemon thread, started from `create_studio_router`'s startup event (the `social_studio.py:1479-1481` pattern; **0 main.py lines**), **whether or not Meta is configured**. It is disabled in pytest by env; the tests call the job functions directly. There is one process today (`server/Dockerfile:113`), but rows are claimed with version checks anyway. Every 30 s it runs:
  - **money (no Meta):** orphan sweep every 2 min; stale Submitted + capture > 15 min → `approval_interrupted` alert (never auto-released); overdue stop requests, tickets and **payment confirmations** → alerts;
  - **daily at 04:00 Tripoli:** `scan_studio_money()` (wallet identity, capture/return pairing, Studio/core separation) → an `integrity_violation` admin alert on any finding; storage figures (DB size, bytes by type, top owners) → `storage_threshold` alert; weekly, the full `scan_database()` [ASSUMPTION: cost measured in the pilot];
  - **heartbeat:** `studioJobState.lastTickAt`. Diagnostics shows `jobs_heartbeat_late` if > 5 min, **and the independent operations worker alerts the staff channel** (P3-21), because a dead loop cannot raise its own alert;
  - **Meta parts (only if configured), budgeted:** ≤5 results syncs, ≤5 page-health checks and ≤5 Instagram polls per tick, within ≤10 s wall time, on the `studio_results` and `page` lanes.
- **Results and status sync (P3-03).**
  - Linked Approved requests with `nextSyncAt ≤ now` are synced about every 30 min.
  - After delivery ends there is **one read at `settleReadDueAt` (48 h)**, then daily reads **until day 28** (`driftWatchUntil`), also after settle.
  - Each sync is one combined read per campaign (campaign + `ads{effective_status,ad_review_feedback}` + `adsets{end_time,effective_status}` + lifetime insights incl. impressions), with the slim-read fallback of `get_ad_snapshot` (`meta_ads.py:2036-2060, 2351-2366`). Claims use `syncClaimedUntil`.
  - Ads throttles park only the account named by the header key; app-wide signals follow the app-wide pause.
  - **After settle,** Meta spend above `settledSpendMinorUSD` + $0.50 raises `post_settle_spend_drift` and enters the reconciliation line.
- **Page health check.** Every 6 h per page (budgeted): page-token fetch; `GET /{page-id}?fields=id`; `GET /{page-id}/subscribed_apps` (must list Albayan's app with `feed`); Instagram professional-account check. **Instagram "comments not arriving" heuristic** [ASSUMPTION: no documented API field shows account privacy]: if `comments_count` on recent media grew while no Instagram comment event or poll read for that account occurred in 24 h, set `instagram_comments_not_arriving`. The first fix step is "make the account public"; staff set `instagram_private` after confirming.
- **Instagram polling (P4-09, only if P0-01(w) passed and `igPublicReply='poll'`).** Each linked Instagram account is polled every 5 min [ASSUMPTION; the interval grows automatically if the budget is exceeded]:
  - `GET /{ig-user-id}/media?fields=id,timestamp,comments_count&limit=10` (last 7 days);
  - `GET /{media-id}/comments?fields=id,text,timestamp,from` only for media whose count changed;
  - only top-level comments newer than both the cursor and the matching rule's creation are passed to `process_comment(source='poll')`.
  
  The existing log-id guard answers a comment once, even if a webhook also delivers it (finding 26). Limitation: comments on Instagram ads that are not profile posts are not covered by polling [ASSUMPTION].
- **Albayan–Meta token health (P3-18a).**
  - A daily `debug_token` read (P0-14) stores validity, expiry and scopes; alerts fire at **14, 7 and 2 days** before `expires_at` or `data_access_expires_at` (when non-zero).
  - **On any authorization failure**, `check_token_now()` runs (at most once per 10 min). Only if it fails (`is_valid=false`, or a 190 on the direct read) does the global state become `meta_connection_down`: a neutral customer banner, per-page "re-share" prompts suppressed, and alerts to admin and the channel.
  - Failures like 190.492 (Page role lost) and permission errors stay per-page health reasons.
  - The state clears after the next successful check.
- **Parked replies (P3-18b).** While the token check says invalid, authorization failures in `_execute_rule_actions` are kept (`retryable`, `parkedReason`, `retryAfter` = next check, `giveUpAt`). After recovery, the existing retry pass (`social_studio.py:1200-1293`) resends:
  - private messages only within Meta's 7-day window;
  - public replies only within 24 h [RECOMMENDATION];
  - past `giveUpAt` the row is finished with `missed_during_outage`, visible in the log.
- **Studio account funds (P3-18c).** Every 6 h via `get_account_funds` (`meta_ads.py:1625-1670`):
  - **prepaid:** alert `studio_funds_low` when `fundsMinor` or `capRemainingMinor` < Σ(approved-not-linked paid) + Σ(running: paid − Meta spend) + margin;
  - **card-funded** (`isPrepay` false or `fundsMinor` None): alert `studio_account_inactive` when `status` ≠ 1 (active), plus the cap check when a spend cap is set;
  - **funds hidden** (no Full control): "funds unreadable — check P0-01(n3)".
- **Webhook delivery counter (P0-13).** `handle_meta_webhook` counts each entry by object and field **before** any filtering, in memory. The counts are flushed to `metaHealthState.webhookCounters` at most once a minute (best effort, like `_save_funds_state`). Counts only.
- **subscribed_apps (if P0-01(l) passes).** On link: `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed` [VERIFIED 3.7]; backfill via the health run and "Check all pages". If it fails, staff subscribe by hand (§8.2).
- **Staff alert channel (P3-21).** Urgent, staff-only events go through `operations._send_alert` if `ALBAYAN_ALERT_WEBHOOK_URL` is set: new stop request (kind `studio_stop:<ticket number>`, so the 30-minute per-kind cooldown never hides a second one), `stop_request_overdue`, `meta_connection_down`, `meta_token_expiring`, `integrity_violation`, `studio_funds_low`/`studio_account_inactive`, jobs heartbeat late. The payload holds kind, count and reference only.
- **Ticket auto-close, overdue settlement, running past end:** evaluated lazily or by the jobs loop. **Webhooks:** none new. The existing Meta webhook (`meta_ads.py:5924-5953`) stays and stamps `receivedAt`.

### 7.5 Customer data isolation and server-side authorization
- Every customer list filters `created_by = :uid` in SQL. Staff queries filter by type/status and never return customer drafts (`REVIEWER_VISIBLE_STATUSES`, `ad_campaign_actions.py:36`). Another owner's row → **404**.
- **Reviewer vs admin:** `audience=admin` tickets, payment requests, settle overrides, rollout/diagnostics, the meta-token summary and fact tests are admin-only; reviewers get 404 (as built for the P0 routes: settings and diagnostics answer 403 `ADMIN_ONLY` and the token route 403 "Admin only", because those route names are public in the app code anyway).
- **Related-item checks:** `relatedId` and rule `pageRefs` must belong to the owner.
- **Staff-identity redaction (P1-05)** for non-staff viewers on every read path:
  - campaign `reviewedBy`, `approvedBy`, `rejectedBy`, `stoppedBy`, `publishedBy`, `reviewHistory[].reviewedBy`, `linkedBy` → `"team"`;
  - `walletTransactions` rows the viewer did not create → `createdBy:"team"`, no `createdByName` (stamps from `main.py:3971-3980`);
  - `walletPaymentRequests` `confirmedBy`/`canceledBy`/`receiptOverriddenBy` → `"team"`.
  
  Implemented via `_project_entity_contacts_for_user` (`main.py:1248-1254`, 0–1 net lines) + `entity_projection.py`, and in `wallet_payments.py`.
- **WhatsApp number:** only via the audited per-item contact link, with consent; scrubbed on anonymisation (P1-16).
- **Staff alert channel:** no names, emails, phones or message texts; only kind, count and `T-…`/`ALB-S-…` references.
- **Lapsed customers:** reads, withdraw, stop, stop-request, tickets and profile are allowed; creating requests, rules and posts is blocked.
- **Staff leaving:** the runbook removes the reviewer preset (deactivates the user) and removes their Business Manager, app and Studio ad-account roles (§12.6).

### 7.6 Notifications: in-app, staff pulse, staff alert channel, staff-initiated WhatsApp (no customer transport exists, VERIFIED report 2 §7)
- **Derived customer activity feed.** Built on read from durable fields using **SQL field projection only**. It never reads the full `data_json` of `adCampaignRequests`, which carries inline base64 images (`wallet_payments.py:97-104`).
  - On PostgreSQL each row's JSON is cast once in a subquery, and several fields are read from it, because `->>` on `data_json::jsonb` parses the whole row (`server/db.py:233-235`). Query cost is measured with `EXPLAIN ANALYZE` on a seeded PostgreSQL (P3-14).
  - **If slower than 200 ms p95**, the few feed fields (status, key timestamps, latest decision) are also kept on the slim `adCampaignResults` row, written by the transition routes.
  - Sources: campaign `submittedAt`, latest `reviewHistory[]`, `approvedAt`, `stopRequestedAt`, `stoppedAt`, `withdrawnAt`; results stage changes; payment `confirmedAt`/`canceledAt`; ledger returns; ticket `lastStaffAt`; TikTok `timeline`; page health changes; customer-visible alerts. Unread = newer than `activitySeenAt`.
- **Why polling:** `SERVER_SYNC_COLLECTIONS` is in the startup bundle (`src/09-api-auth.js:481-488`) and excludes the new types. The customer studio polls `GET /api/studio/pulse` (columns-only `MAX(last_modified)`): single-flight, only while visible, and immediately on focus. Known limit: an admin's manual credit appears on the next open or focus.
- **Staff pulse (P3-17).** Staff rows are not "theirs", so the desk polls `GET /api/studio/staff/pulse` every 20 s while visible. New urgent items (stop requests, overdue items, overdue payments for admins) → a counter badge, a count in the browser title, and a short in-page sound/vibration.
- **Staff alert channel (P3-21).** When no desk is open, urgent events reach the private business alert channel through the existing operations sender (finding 32), if it is configured and accepts the payload (P0-01(u)). If it is not configured, the fallback is the on-duty rule (D29), the after-hours urgent WhatsApp line for customers, and the overdue alarm on the next open.
- **Reaching a customer outside the app (M15):** staff "Message on WhatsApp" (`wa.me/<number>?text=<prefilled Arabic>`) only with consent, otherwise `mailto:`. Real sending to customers stays D13 (R2).

### 7.7 Tokens and secrets
- No token ever reaches the browser. The static test "social studio never handles Meta credentials" (`scripts/test-mobile-ui.js:1258-1266`) is extended to the new files.
- Page tokens stay in memory only (`meta_ads.py:1171-1192`) and are **evicted on 190/401/403** (P0-07). `appsecret_proof` is sent on every request.
- **The admin token's validity, type, expiry, data-access expiry and scopes are read automatically** with `debug_token` (P0-14) [VERIFIED endpoint]. The app access token (`<app id>|<app secret>`) is composed in memory for that call only and is never stored or logged. Only the Business Manager person who owns the token is recorded by hand (P0-01(p)).
- **Expiry handling:**
  - Meta recommends expiring system-user tokens (60 days from creation or refresh) as a security practice [VERIFIED].
  - Alerts fire at 14/7/2 days.
  - The runbook step is **"refresh within the window"**; creating a new token is the fallback after expiry.
  - D35 records the token choice.
- "Configured" today only means the variable is set (`meta_ads.py:998-1000`). P3-18a adds real checks.
- **New env:**
  - `ALBAYAN_STUDIO_V2` (`off|pilot|on`, kill switch for the customer layout);
  - `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` (a subset of `ALBAYAN_META_AD_ACCOUNT_IDS`; a mismatch makes the bridge fail closed);
  - **`ALBAYAN_META_APP_ID`** (P0-14);
  - `ALBAYAN_STUDIO_JOBS` (default on; off only in tests);
  - `ALBAYAN_E2E_STUDIO_SEED` (e2e only, guarded).
  - Reused: `ALBAYAN_ALERT_WEBHOOK_URL` (operations alerts).
- R3/R4 customer tokens (not in the MVP) would be encrypted at rest (AES-GCM pattern, `server/operations.py:583-707`).

### 7.8 Wallet: traceable ledger, the four numbers, duplicate and race safeguards
- **Definitions.** The server truth comes from `/api/studio/wallet/summary`, computed **from the ledger**.
  - Each `cpay:` row references its campaign (`referenceId`).
  - Returns (`rel:`, `stoprefund:`, admin `rev:`) reference the **cpay transaction id** (`referenceType:'reversalOf'`, `wallet_payments.py:259, 350`). So returns join to their cpay, and the cpay joins to its campaign, **including archived campaigns**.
  - The campaign's status for that cycle (cpay key `cpay:{id}:{submittedAt}`) decides the bucket.

  | Number (AR / EN) | Formula | Plain meaning |
  |---|---|---|
  | **متاح / Available** | USD ledger balance − Reserved (`wallet_payments.py:116-121`) | "You can use this now." |
  | **محجوز / Reserved** | Σ budgets of Submitted requests (`wallet_payments.py:89-114`), listed per request | "Held for requests waiting for our team. Still yours; withdraw any time." |
  | **في إعلاناتك / In your ads** | Σ over cpay rows whose campaign is Approved in that cycle: cpay − returns | "Paid for ads being set up, running or just ended. Unused money comes back about 2 days after the ad stops." Sub-line (only when linked): «استخدمت ميتا $Y حتى الآن · فُحص قبل X» |
  | **في طريقه إليك / Being returned** (only when non-zero) | Σ over cpay rows whose campaign left that cycle, with no return yet | "An approval was interrupted; this money is on its way back to you (usually within minutes)." |
  | **صُرف / Spent** | Σ over closed cpay rows: cpay − returns | "Final: what your ads used." |
  | Added | `payreq:` credits + admin `credit` + transfers received | own ledger labels |
  | Adjustments | transfers sent (−), admin `rev:` of non-campaign rows (±), other posted USD rows | only when non-zero |

- **Identity (tested and checked daily):** Added + Adjustments − In your ads − Being returned − Spent = Available + Reserved. The "where every dollar is" sheet says this in words; the LYD plan balance is shown separately.
- **Ledger labels:** `payreq:` «أضفت رصيداً (PAY-…)»; admin `credit` «رصيد أضافه فريق البيان»; transfers «تحويل وارد» / «تحويل صادر»; `cpay:` «دفع ميزانية إعلان: الاسم»; `rel:` «استرجاع ميزانية إعلان لم يُعتمد»; `stoprefund:` «استرجاع ما لم تصرفه ميتا من: الاسم»; `subpay:` «تجديد الاشتراك» (LYD); `rev:` «تصحيح من الإدارة».
- **Taps:** single-flight promise maps (existing `_adsStudioSubmitPromises` etc.). **Retries:** an `operationId` per (action, version) replays the committed result (`ad_campaign_actions.py:226-228`); ledger rows carry unique idempotency keys.
- **Lock table [VERIFIED for existing rows; planned rows marked].** This is the PostgreSQL order. On SQLite the same operations take the process locks in the order entity-patch lock → wallet lock (stop route `ad_campaign_actions.py:192-195`; delete `main.py:4940-4944`).

  | Operation | PostgreSQL locks, in order | Source |
  |---|---|---|
  | Plan purchase | user row → `subscription` key → `subpay:` key | `subscription_plans.py:310-311, 383` |
  | Payment confirm | user row → `payreq:` key | `wallet_payments.py:660-664` |
  | Transfer / admin credit | user rows (sorted ids) → idempotency key | `main.py:4200-4201, 4256-4257` |
  | **Submit (planned P1-02)** | user row → campaign row → `rel:` key (orphan of the previous cycle) | planned |
  | Approve — capture | `cpay:` key → campaign row (no user row) | `wallet_payments.py:156-168` |
  | Approve — status write | campaign row (`patch_entity`) | `main.py:2095` |
  | **Approve — self-release on 409 (planned P1-03b)** | campaign row → `rel:` key | planned |
  | Reject / Request changes | campaign row (status write); then a new transaction: `rel:` key | `main.py:10587-10594`; `wallet_payments.py:240` |
  | **Withdraw (planned P1-03)** | campaign row → `rel:` key | planned |
  | Stop / **settle (P3-06a)** | campaign row → `stoprefund:` key (the results row is read, not locked) | `ad_campaign_actions.py:196-202`; `wallet_payments.py:335` |
  | Archive (delete) | campaign row → `rel:` key | `main.py:4946-4993` |
  | **Orphan sweep (planned P1-21)** | campaign row → `rel:` key | planned |

  **Global order:** user rows (sorted) → `cpay:` key → one campaign row → other advisory keys (`rel:`, `stoprefund:`, `subscription`, `subpay:`, `payreq:`, transfer keys). Every operation takes a subset of this order and at most one campaign row, so the wait-for graph has no cycle. The capture does not lock the user row. This is safe because the campaign's budget stays inside "Reserved" until the Approved status is written; the ledger debit and the hold overlap briefly, which only *understates* Available. **Proof:** PostgreSQL Barrier scenarios in P1-19, both orders of each pair.
- **Concurrency rules:**
  1. **Submit is serialised per user (P1-02):** strict field/image validation before any lock; then one transaction following the table; intake and daily-cap check; Available and limits check; guarded write.
  2. **Withdraw (P1-03)** follows the stop-route pattern: lock the campaign row; require Submitted with the same `submittedAt` and baseline; write Draft + `withdrawnAt`, **keeping `submittedAt` and `lastSubmitOperationId`** (the orphan key, `wallet_payments.py:125-131`); release the cycle's capture in the same transaction. Whoever gets the row first wins.
  3. **Approval returns its own capture on a lost race (P1-03b):** the 409 path re-reads the row. If the row left the cycle, it releases (idempotent `rel:`), audits `wallet_release`, and returns 409. A concurrent identical approval is never released.
  4. **Stop-request vs staff stop:** a stop-request on a Stopped row → 409; its ticket closes automatically when settled.
  5. **Settlement gates (P3-06a):**
     - when linked, refuse while `anyAdDelivering`;
     - refuse unless `spendConfirmedAt ≥ deliveryEndedAt + spendDelayHours` (**48 h default**, D28), **except** when the final read shows `neverDelivered` (0 impressions and $0 over the ad's life), which allows an immediate full return [ASSUMPTION: low drift risk, watched by the drift reads];
     - cap the refund at paid − confirmed spend.
     
     An admin `overrideReason` lifts the gates (audited `settle_override`, kept forever). Settle stores `settledSpendMinorUSD`, the raw `metaSpendAtSettleMinorUSD` (`server/ad_final_spend.py:10-40` pattern) and `settleBasis`. For a request never linked, staff tick "This ad was never created in Meta" (audited). **During a Meta connection outage, settlements wait; the runbook forbids mass overrides.**
  6. **Meta overspend:** the customer is never charged more (owner answer 3; D27). The alerts `meta_overspend` and `post_settle_spend_drift` fire (drift reads until day 28), and the amount enters the owner's reconciliation and the monthly absorbed-cost figure.
  7. **The one-door refund rule is unchanged** (`wallet_payments.py:269-357`): one return per payment cycle. So we wait for Meta's numbers to settle rather than return in two steps.
  8. **Legacy in-flight rows (P1-18):** rows submitted before `adLimits.p1CutoverAt` (or with `schemaVersion` < 2) skip the new limits, per-day floor and total-only checks at approval; the staff card flags them (D33).
- **Integrity checks** (extend `server/data_integrity.py`; run daily by the jobs loop and on demand at `/api/admin/data-integrity`, `main.py:2727-2730`):
  - each `cpay:` has at most one return;
  - no Submitted request has a non-positive budget;
  - Available ≥ 0 per user;
  - **the identity holds per user**;
  - nothing sits in "Being returned" for more than 1 h;
  - no refund exceeds paid − confirmed spend without an audited override;
  - **Studio/core separation holds:** no core `ads` row has `metaCampaignName` containing `ALB-S-`, shares a `metaCampaignId` with a studio request, or has `metaAdAccountId` in the Studio list with a creation time after that account's `studioSince`.
  
  **Never silently repair:** a finding raises an alert and follows the runbook (`docs/RELEASE_AND_SAFETY.md:32-35`).

### 7.9 Known defects folded into the plan
| Defect | Evidence | Task |
|---|---|---|
| FB private replies use the removed `/{comment}/private_replies` | `social_studio.py:1162`; [VERIFIED] https://developers.facebook.com/docs/graph-api/reference/object/private_replies/ | P0-06 |
| Stale page token reused after revocation | `meta_ads.py:1179-1182` | P0-07 |
| **Comments lost for good during a token outage** | `meta_ads.py:1065, 1106-1107`; `social_studio.py:1196` | P3-18a, P3-18b |
| **One "authorization" bucket mixes per-page and token failures** | `meta_ads.py:1105-1107`; research 2.8 | P3-18a |
| **Token validity and expiry never checked** | `meta_ads.py:998-1000`; no app id env | P0-14, P3-18a |
| Arabic UI shows raw English server errors | `15c:615-633`; `ad_campaign_fields.py:497-513` | P0-08, P1-08c, P2-11 |
| Submit money check not serialised | `main.py:10369-10401` | P1-01, P1-02 |
| No customer withdraw; the hold never ends | sec review Round 8 #2 | P1-03 |
| An approval's capture could be stranded | `main.py:10513-10526, 10564-10594`; `schemas.py:286-291` | P1-03, P1-03b |
| Finished campaign has no customer exit | sec review Round 14 | P1-04 |
| Staff user ids exposed to customers | `main.py:10535-10552, 3971-3980`; `wallet_payments.py:652, 692, 734` | P1-05 |
| Daily budget holds one day; in-flight daily rows | `wallet_payments.py:89-151`, `15c:1242-1247, 1356`; approval re-validates (`main.py:10486-10500`) | P1-06, P1-18 |
| "Spent" would count unused money; archived ads vanish from sums | `wallet_payments.py:100-104, 146-208`; `ad_campaign_actions.py:296` | P1-07 |
| LYD rows with "$"; Arabic digits → 0 | `15c:1898,1903`; `15c:955,1693` | P1-08a, P1-08b |
| "Budget summary" counts Draft/Rejected/Stopped | `15c:396-401` | P1-08a, P2-03 |
| Dead "Open Ads and link" button | `15c:2017` | P1-08a |
| Client/server field-limit mismatches | report 1 §9 | P1-08b |
| Raw `publishStatus` value in the staff chip | `15c:526` | P1-09 |
| Late approval shortens the ad | `main.py:10488-10496` | P1-10, P1-11 |
| New fields refused by the allow-list | `main.py:4602-4630, 11811-11821`; `ad_campaign_fields.py:298-306` | P1-11, P1-14 |
| Free-text review note only | `15c:1592-1634` | P1-12 |
| Quick boost cannot submit without text/photo | `ad_campaign_fields.py:493-516` | P1-13, P2-05a |
| Two goals stored as one objective | `15c:67-73`, `ad_campaign_fields.py:349-357` | P1-14 |
| Budgets not checked against the per-day minimum | Meta `min_daily_budget` [VERIFIED] | P1-15 |
| Anonymisation leaves studio personal data | `main.py:13484-13600` | P1-16 |
| Audit keep-list hard-coded copy | `main.py:1202, 1232` | P1-04, P1-17 |
| Studio launches imported as unpaid core ads; empty allowlist allows every account | `meta_ads.py:1020-1021, 3146-3206, 1093-1098, 1387-1393` | P0-09, P0-10, D26 |
| Money-race tests never run on PostgreSQL | `scripts/test-backend.js:26`; `main.py:4124-4128`; `test_postgres_financial_review.py:32-34` | P1-19, P0-11 |
| **CI does not run the architecture, mobile-config and profitability tests** | `ci.yml:14-45`; `package.json:34` | P0-11 |
| `confirm()`/`prompt()` for money | `15c:572,657,675,762,1634` | P2-04, P3-06c |
| Phone Back leaves the studio | `15c:145…`; `01b:299-330` | P2-02b, P2-09 |
| No link from requests to Meta performance/status | report 1 §7 | P1-20, P3-01…P3-04 |
| One Meta lock and pause for all traffic, incl. preventive `usage_high`; headers merged | `meta_ads.py:193-320, 1115-1127, 1224-1242` | P3-00a–c, P4-04 |
| Money jobs would stop with the Meta worker | `social_studio.py:1022-1027` | P1-21 |
| Unreadable Meta results could pre-fill a full refund | `meta_ads.py:2351-2366, 4280-4310` | P3-01, P3-06a |
| **Settlement 3 h after end, while Meta's numbers change for days** | insights best practices [VERIFIED]; `wallet_payments.py:269-357` | P3-03, P3-06a, D28 |
| "Ended" shown while Meta still delivers | `meta_ads.py:2396` | P3-04a |
| Reply failures invisible; no reply-log route | report 2 §3, §9.8 | P4-02 |
| **Zero `ig` log rows read as "no webhooks"** | `social_studio.py:1312, 1320, 1347, 1352, 1371` | P0-13, P0-01(a) |
| Rules not scoped per page | `social_studio.py:586-632, 1655-1668` | P4-01 |
| `subscribed_apps` never called; two health sources | report 2 §4; `social_studio.py:851-853,1650` | P0-01(l), P4-03 |
| No staff alert for urgent items | `src/09-api-auth.js:481-488`; `operations.py:784-809` unused for this | P3-17, P3-21 |
| No working-hours calendar | grep, 0 matches | P3-16 |
| Old stopped ads would look like failures | §5.4 legacy rule | P3-04a |
| **Privacy page: wrong audience, 90 vs 365 days, reply-log data missing; no terms** | `privacy.html:29, 48`; `main.py:1199, 533-534` | P0-12, P3-22, P5-06 |
| Images inline; PostgreSQL JSON reads parse whole rows | `main.py:4558`; `db.py:233-235` | P3-14; file storage R2 (D12) |

---

## 8. External integrations: verified requirements

### 8.1 Meta: what the MVP relies on
| Need | Requirement | Label / source | MVP handling |
|---|---|---|---|
| Read status and results of Albayan-owned campaigns | Own ad accounts work with standard access to `ads_read` | VERIFIED 1.3 (https://developers.facebook.com/docs/marketing-api/overview/authorization) | Existing admin token + Studio account list (fail closed) |
| System user reaches the Studio account | System users only reach assets they are granted; funds need Full control | VERIFIED 1.8; `deploy/README.md:26-29` | P0-01(n2) assign; P0-01(n3) prove via `fundsHidden=false` |
| Campaign status values | ACTIVE, PAUSED, DELETED, ARCHIVED, IN_PROCESS, WITH_ISSUES | VERIFIED (ad-campaign-group reference, fetched 2026-09-24) | Not enough alone |
| Ad status values and review feedback | Adds PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ADSET_PAUSED; `ad_review_feedback` | VERIFIED (adgroup reference, fetched 2026-09-24) | Stages 5–9 |
| Ad set end time / campaign stop time | `adset.end_time`, `campaign.stop_time` | VERIFIED in code (`meta_ads.py:2036-2049, 2396`) | Ended signal |
| Campaign spend cap | Minimum $100 USD | VERIFIED (ad-campaign-group reference, fetched 2026-09-24) | Not used; lifetime budget ≤ paid on the launch checklist |
| Minimum daily budget | `min_daily_budget` | VERIFIED field (ad-account reference); value/unit ASSUMPTION until P0-01(f) | Per-day floor |
| Insights rate limits and usage headers | `ads_insights` BUC 600 (dev) / 190,000 (full) + 400 × active ads per hour; `X-Business-Use-Case-Usage` types `ads_insights, ads_management, custom_audience, instagram, leadgen, messenger, pages`, keyed by business object id; `X-Ad-Account-Usage` fields `acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier` | VERIFIED 1.7 + rate-limiting page (fetched 2026-09-24) | Per-lane classification by documented type and object key (P3-00b); unknown type → app-wide; P0-01(r) confirms only |
| Throttle code scopes | 4 app; 17 user; 32 Pages; 613 custom; 80000/80004/80003/80014 ads; 80001/80002/80006 page/IG/Messenger | VERIFIED (rate-limiting page, fetched 2026-09-24) | Meta call lanes |
| Token health | `debug_token` returns `is_valid`, `expires_at`, `data_access_expires_at`, `scopes`, `granular_scopes`; callable with an app access token | VERIFIED (debug_token reference, fetched 2026-09-24) | P0-14, P3-18a |
| Token lifetime / data access | System-user tokens: non-expiring, or 60 days from creation/refresh (recommended); long-lived user tokens ~60 days; data access can expire after 90 days of inactivity (`ads_read` exempt) | VERIFIED (system-users page, fetched 2026-09-24); VERIFIED 2.6, 2.7 | Expiry alerts 14/7/2 days; refresh runbook; D35 |
| Studio account funding | Prepaid "available funds" depends on country/currency; cards/PayPal otherwise | UNVERIFIED (excerpt) 5.2; existing accounts' flags readable from `metaFundsState` | P0-01(n1–n3), D30, funds/status alerts |
| Insights delay after delivery ends | "may continue to update for a couple of days after an ad has completed"; "do not change after 28 days" | VERIFIED (insights best practices, fetched 2026-09-24) | `spendDelayHours` 48 h; never-delivered exception; drift reads to day 28; P0-01(s) tunes from Albayan's own data |
| Ad review timing | Usually within 24 h; re-review any time | VERIFIED 1.13 | "Meta is reviewing"; re-rejection → stage 6 |
| Special ad categories | Required; `special_ad_category_country` | VERIFIED 1.12 | Launch checklist; stored for R3 |
| API version | v25 default; v24 expires 6 Oct 2026; v26 released 29 Jul 2026 | VERIFIED 1.14 | Keep v25; v26 check in R2 |
| Liability for client ads | Albayan is liable | VERIFIED 1.11 | Human review stays |
| LYD ad currency | Not supported | VERIFIED 5.1 | USD only |
| Creating a Studio ad account (D26) | API limit of 5 agency-owned accounts VERIFIED 1.10; the Business Manager UI limit for Albayan is not checked; only one account is needed | ASSUMPTION | P0-01(n2) |

### 8.2 Meta: comment auto-replies (capability labels)
| Channel | Requirement | Label / source | MVP label (default) |
|---|---|---|---|
| FB public reply `POST /{comment}/comments` | `pages_manage_engagement`, MODERATE task | VERIFIED 3.1 | **Working**, only after P0-01(g) proves delivery to commenters without an app role (first from existing log rows, then a staged test) **and** the page is subscribed. If (g) fails → D24b |
| FB page webhooks (subscribe) | A page token from someone with CREATE_CONTENT/MANAGE/MODERATE; `pages_manage_metadata` + `pages_show_list`; `POST /{page-id}/subscribed_apps`; ad-post comments are delivered | VERIFIED 3.7 + https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages/ | **MVP dependency.** P0-14 reads the scopes; P0-05d runs one audited subscribe test. If it fails, subscribing is a written staff step [ASSUMPTION: exact path confirmed in P0-01(l)] and `pages_manage_metadata` joins D8b |
| FB private reply `POST /{page-id}/messages` + `recipient.comment_id` | `pages_messaging`; one message within 7 days; Standard Access reaches only app-role people | VERIFIED 3.2 | **Waiting for Meta approval** until App Review, or until a smoke test proves delivery to a person without an app role |
| IG public reply `POST /{ig-comment}/replies` | `instagram_basic`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`; professional account linked to a Page | VERIFIED 3.3, 2.5 | Depends on how the comment is found (next two rows) |
| IG comment webhooks | "Advanced Access is required to receive `comments`…"; app "set to **Live**"; the account "must be public" | **VERIFIED** (instagram-platform/webhooks, fetched 2026-09-24) | **Waiting for Meta approval**, unless P0-01(a) (webhook counter) shows IG comment events already arriving and P0-01(t) shows Live mode |
| IG comments by polling (road 1) | Reads recent media and comments with the system-user token, under Standard Access. Standard Access covers "app users who have a role on the requesting app" | VERIFIED rule (access-levels page); **whether a system user reading a customer's shared account qualifies is ASSUMPTION** | **"Working — checked every 5 min"** only if P0-01(w) passes; otherwise gated. Policy risk (serving other businesses without Tech Provider) recorded; asked in P0-01(o) |
| IG private reply `POST /{ig-id}/messages` | `instagram_manage_messages`; one message within 7 days | VERIFIED 3.4 | **Waiting for Meta approval** |
| Token expiry / revocation | Error 190 with subcodes 458/460/463/467/492 | VERIFIED 2.8 | 492 and permission codes → per-page reasons (P4-03); a failed direct token check → global state and parked replies (P3-18a/b) |
| **App Review evidence** | Screen recordings showing how the app uses each permission, the complete login flow, an English UI; unverifiable → denied. Nothing requires a redesigned UI | **VERIFIED** (screen-recordings guide, fetched 2026-09-24) | Recorded on the **existing classic screens** in English (P1-24); IG replies shown via "check recent comments now" (P1-23), since IG webhooks need approval first |
| Whether a managed flow (assets shared through Business Manager, staff operating with a system-user token, no customer Facebook login) satisfies reviewers | Not stated on Meta's pages | **ASSUMPTION / risk** | P0-01(o) asked in parallel; **not blocking**: we submit and use the reviewers' feedback as the answer |
| Business Verification (needed for Advanced Access) | Documents for Libya unknown | VERIFIED need (research 1.4); UNVERIFIED Libya documents (5.3) | **D8a, week 1**; checkpoint week 8 → D34 |

**Permission list for App Review (D8b).** Built from the App Dashboard's dependency list for each feature:
- `pages_messaging`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_manage_metadata`;
- plus `pages_manage_engagement`, `pages_read_engagement`, `pages_show_list`, `instagram_basic` and `business_management` where the dashboard lists them as dependencies, or where P0-01(g)/(w) show that Standard Access is not enough.

**Critical path for owner requirement 2 (auto-replies), restated plainly.**
- **Facebook:** public replies can work at launch if P0-01(g) and (l) pass; P0-01(g) is usually answered in week 1 from existing reply records. If they fail and cannot be fixed, D24b decides.
- **Instagram, road 1 (week 2 test, P0-01(w)):** if it passes, Instagram public replies work at launch by polling (P4-09), labelled «يعمل — نفحص كل 5 دقائق».
- **Instagram, road 2 (approval):**
  - Business Verification starts in week 1 (D8a).
  - The App Review package is recorded on the classic screens at the end of P1 (P1-23, P1-24, ≈ week 6–7) and **submitted as soon as Business Verification completes**. We do not wait for P4.
  - Meta's review time is unknown [UNVERIFIED].
  - If approval arrives before release, instant IG webhooks (and private messages) are switched on with the capability switch, without a new release.
- **If Business Verification is refused or not finished by week 8:** D34. Instagram becomes «غير متاح حالياً» unless road 1 works; private messages are removed from the editor; R3 is re-planned.

### 8.3 Meta: later automation and self-connect (gated dependencies)
| Capability | Approvals | Label |
|---|---|---|
| Automatic launch (R3) | `ads_management` Full access (500 calls in 15 days, <15% errors), Business Verification | VERIFIED 1.1, 1.4 |
| Staff one-tap pause on the Studio account (R2) | `ads_management` on own accounts works with standard access; token scope read by P0-14 | VERIFIED 1.3 |
| More system users (D35) | Limited Access: 1 system user + 1 admin system user; Full Access: 10 + 1; Meta advises keeping the admin system user for admin actions | VERIFIED 1.2, 1.8 |
| Serving businesses without app roles | Tech Provider access verification (≈5-day decision, 60 days to complete) | VERIFIED 1.5 |
| Customer self-connect (R4) | Facebook Login for Business, business-type app, configuration id, Advanced Access | VERIFIED 2.1, 2.4 |
| Messenger/IG DM permissions and `pages_manage_metadata` | Not in the Tech Provider list; separate App Review | VERIFIED 1.6 |

### 8.4 TikTok: honest delivery
| Need | Finding | Label |
|---|---|---|
| Comment replies / DMs via Login Kit | **No such scopes** | VERIFIED 4.1 (https://developers.tiktok.com/doc/tiktok-api-scopes) |
| Organic comment replies (Accounts API) | Application form required since 20 Mar 2026 | UNVERIFIED 4.2–4.3 |
| Business Messaging API (DMs) | Open beta in listed regions; privacy review; via Messaging Partners | UNVERIFIED 4.4 |
| In-app auto messages | Set by the account owner in TikTok; 40-char keywords, 500-char replies | UNVERIFIED 4.5 |
| Libya availability | Unknown | UNVERIFIED 4.7, 5.4 |

**What the TikTok customer gets in the MVP** (copy approved in D14):
1. Their TikTok handle is **saved with a service request**, not as a connection. The card is labelled «خدمة تيك توك — مساعدة يدوية من فريق البيان، بدون ردود تلقائية».
2. **A staff member contacts them within one business day** (D11, service hours), in the ticket or on WhatsApp.
3. **Hands-on help setting up TikTok's own built-in auto-messages**, where their account has the feature. TikTok runs them, not Albayan. Availability is checked in P0-01(e); if the feature is unavailable, item 3 becomes "advice only" and the copy says so.
4. **Advice** on answering comments by hand and on TikTok ads.
5. **Status tracking** and in-app notifications.

Shown before submission: «لا يستطيع البيان حالياً الرد تلقائياً على تيك توك، لأن تيك توك لم يفتح هذه الخدمة لنا بعد. سنساعدك يدوياً ونخبرك فور توفرها.» Automation is deferred to R4. A text test forbids «متصل», «مربوط», «يدير» and "connected"/"linked"/"manages" on TikTok screens.

---

## 9. Implementation phases (ordered by dependency)

**Effort assumptions.**
- One developer working with an AI coding assistant; the owner reviews each release in plain language. 1 dev-day ≈ 6 focused hours incl. tests; 5 dev-days per week.
- **Release overhead per release ≈ 1–1.5 h once the GitHub publish workflow is the release path (P0-11), and 1.5–2 h before that.** This is included in phase effort. It covers the gate run (CI ≈ 8 min measured; the publish workflow adds the e2e, image build, smoke test and PostgreSQL step and is timed at its first dry run), the manual Jelastic redeploy, and `/api/health/ready` + smoke test (`docs/RELEASE_AND_SAFETY.md:36-77`).
- **Money-touching releases add ≈ 0.75 h:** a verified **production** backup and a restore proof by the named person (D29; default: the developer, with the owner watching once).
- Meta/TikTok approvals, Business Verification, Studio account creation and funding run in parallel and are **not** counted.
- **Contingency: +15–20%** on dev-days (Preview A rework, Meta surprises, PostgreSQL-only failures).
- **Browser-test matrix kept small:** widths × languages × themes run only on `mobile-chromium`; `desktop-chromium` and `mobile-webkit` run one smoke pass each (P2-13). This stops the gate growing without limit (`playwright.config.js:14-16, 39-52`: one worker, serial).
- **main.py line plan.** All main.py edits happen in P0–P1; afterwards D15 lowers the cap. New work in P0-11…P0-14, P1-18…P1-24, P3 and P4 lives in helper modules, workflows or `privacy.html` (0 lines). [ASSUMPTION: each move needs ~6 ctx lines.]

  | Step | Lines |
  |---|---|
  | P0-02 audit extraction (−~120, +~6 registration) | ≈ −114 |
  | P0-03 studio router registration | ≈ +8 |
  | P1-01 submit move (late-binding ctx) | ≈ −104 |
  | P1-10 review move | ≈ −170 |
  | Allow-list and workflow-field additions | 0 (appended to existing lines) |
  | Staff-id redaction in `_project_entity_contacts_for_user` | 0 to +2 |
  | Audit keep-list copy → constant (P1-17) | 0 |
  | Anonymisation hook (P1-16) | +2 |
  | Studio jobs loop start (P1-21) | 0 (router startup event) |
  | **Result** | **≈ 13,822 lines** (cap 14,200; D15 then lowers the cap to count + 30) |

| Phase | Goal | Contents (tasks) | Exit criteria | Effort |
|---|---|---|---|---|
| **P0 Foundations (dark)** | Room in main.py, switches, facts and baselines, urgent FB fix, error model, Studio/core separation incl. the name code, past collisions cleaned, **one-button verified release, corrected privacy facts, webhook counter, automatic token read** | P0-01…P0-14 | `npm test` green; **the publish workflow has run once (dry run) with the PostgreSQL step**; main.py ≤ ~14,100; `/api/studio/me` live; FB private-reply test on the new path; discovery never imports a Studio-account or `ALB-S-` ad; facts (a)–(w) recorded in §14 with owner and date; P0-10 report signed by the owner | 9–11 d + 1 release |
| **P1 Money & lifecycle truth; App Review package** | Correct money, dates, races, stage model and jobs loop before any new UI; all main.py edits done; Instagram App Review ready to submit | P1-01, P1-10 first; P1-19 alongside P1-02/P1-03; then the rest; P1-23/P1-24 at the end | SQLite logic tests **and PostgreSQL Barrier scenarios** pass (in both CI and the publish workflow); jobs loop runs with no Meta token; legacy in-flight rows handled; classic shows LYD, Arabic digits and the new refusals in Arabic; main.py cap lowered (D15); backup + restore proof; **App Review package complete, submitted once D8a completes** | 19–23 d + 2 releases |
| **P2 v2 shell, ads, wallet (flagged)** | Phone-first Home, My ads, wizard, wallet, account, Back, errors in Arabic, e2e harness | P2-01…P2-13 | v2 e2e green in AR/EN at 320/360/390/412/820 on `mobile-chromium` + smoke on the other two projects; Back tests pass; before any link the UI shows stage 4 and no "Meta used" line; flag off in production = no visible change | 11–14.5 d + 2 releases |
| **P3 Tracking, inbox, help, staff desk, operations** | Meta lanes, Meta-fed stages, results, settlement gates (48 h, never-delivered, 28-day drift), activity, tickets, stop requests, staff routes and pulse, service hours, **token health, parked replies, funds/status alerts, staff alert channel**, alerts, runbook, diagnostics, data inventory | P3-00a…P3-22 | Lane tests (usage_high, 15 s admin timeout) pass; staff link and settle on a phone; settle-gate PostgreSQL scenario passes; stop request visible in an open desk ≤60 s (e2e) **and in the alert channel** (if configured); **token-invalid → replies parked and resent** (test); rollout-off keeps tickets and stop requests usable (test); runbook v1 approved by the owner | 22–25 d + 2 releases |
| **Preview A (D20)** | Owner, one staff member and 2–3 friendly testers use ads + money + help for real; **staff time measured** | Allowlist only; Pages & replies embeds classic 15f; Studio account configured and funded (D26, D30); runbook rehearsed; pilot consent signed (D18) | 2–3 weeks; feedback logged; capacity numbers recorded; P4/P5 screens adjusted | 1–2 d fixes + 2–3 weeks calendar (parallel with P4/P5) |
| **P4 Pages & replies** | Reliable comment replies with honest labels; Instagram polling if road 1 passed | P4-01…P4-09 | Log visible to the owner; per-page back-off test; subscribe + backfill test (or staff step); gates enforced server-side; relinked page keeps its rules; reply latency recorded (webhook and poll); poll/webhook dedupe test | 5.75–9 d + 1 release |
| **P5 TikTok, guides, desk completion, terms** | TikTok requests, guides, full health desk, customer terms section | P5-01…P5-06 | Wording test; privacy coverage; desk complete; terms section live (if D18 text ready) | 3.25–4.5 d + 1 release |
| **P6 Pilot → first release** | Safe launch of all four owner items | P6-01…P6-05 | **Go/no-go table (§12.8) all green for 2 consecutive weeks**; rollback rehearsed; D24/D24b/D34 decided; classic removed only after sign-off | 2.5–3.5 d + 2 releases + 2–4 weeks calendar |
| **Total MVP** | | | | **≈73–92 dev-days before contingency (≈84–110 with 15–20%); ≈13–15 releases** |

**Calendar in plain words (dependency chain).**
1. P0 + P1 (money foundations, verified release pipeline, App Review package): ≈ weeks 1–6.5.
2. P2 (new customer screens): ≈ weeks 6.5–9.5. The owner and one staff account try it for a week.
3. P3 (tracking, help, staff desk, token health, alerts, runbook): ≈ weeks 9.5–14.5, plus a contingency of ≈ 2.5 weeks.
4. **Preview A** with 2–3 friendly customers: 2–3 weeks, while P4 (replies, Instagram polling if possible) and P5 (TikTok, terms) are built.
5. **Pilot** with 3–5 customers: 2 weeks, judged by the go/no-go table.
6. **First release to everyone ≈ week 19–23.** The classic view stays available 30 more days.

**Instagram track (parallel, not on the dev chain).** Business Verification from week 1 (D8a) → IG-poll test in week 2 (P0-01(w)) → App Review package ready ≈ week 6–7 → submitted when Business Verification completes → Meta's review time is unknown → capability switched on without a release. Checkpoint in week 8 (D34).

---

## 10. TASKS

Moved to [TASKS.md](TASKS.md).

## 11. Test strategy (risk-focused)

### 11.1 Meaningful risks and the proof for each
| Risk | Proof |
|---|---|
| Authorization / isolation | For every new route: customer A cannot read or modify B's rows (404); staff see only workflow-visible rows; reviewers get 404 on admin-audience items; admin routes return 403 for others. No staff id or name in any customer response (P1-05). Staff pulse counts respect the audience. Alert-channel payloads carry no personal data. Files: `test_studio_api.py`, `test_studio_support.py`, `test_studio_staff_routes.py`, `test_social_studio.py`, `test_studio_alerts_out.py`. |
| Duplicate requests | Replays by `operationId`/`clientRequestId` return the first result; a different payload with the same key → 409; ticket numbers unique under parallel creates (**PG**); client single-flight checked statically; **a comment seen by poll, manual check and webhook is answered once** (log-id guard). |
| Financial transactions | **Logic on SQLite (UT)** and **concurrency on PostgreSQL (PG)**: parallel submits; withdraw vs approve in both orders; approval self-release; orphan sweep; settle gates incl. **48 h and never-delivered**; lock order/deadlock (Barrier, `lock_timeout` 5 s); wallet identity property test; one-door refund; daily integrity checks. E2E money journey (`money-journeys.spec.js` extended: charge → submit → approve → **seeded** Meta spend → settle → labels). |
| Production-only database behaviour | FK on `created_by` (system alert insert, PG); JSON cast cost (`EXPLAIN ANALYZE`, PG); advisory locks (PG). Run in the publish workflow on every release (P0-11). |
| Core books separation | Discovery/import never create an `ads` row for a Studio account **or an `ALB-S-` campaign** (UT); link refused without the code (UT); daily integrity check; P0-10 reversible repair test. |
| Stage truth | Seeded rows (P1-20), then mocked Graph (P3-04a); re-review → stage 6; ACTIVE after end stays Running + alert; the staff marker never overrides Meta. |
| Integration failures | Mocked Graph: 190 subcodes (**492 per-page; invalid token global**); 4/17/32/613/80000/80001/80004 per lane; **`usage_high` per header type and object key; unknown type → app-wide**; 5xx; timeouts (never re-sent blindly); **a 15 s admin timeout**; not found; wrong account; empty Studio list; unsubscribed page; insights unavailable; **token invalid → replies parked and resent within windows**; **`debug_token` without an app id → unconfigured, no crash**; funds hidden/low; card-funded account inactive. |
| Background jobs | The sweep runs without a Meta token; heartbeat alert **raised by the independent operations worker**; scheduled posts not delayed by 50 due syncs; per-tick budget respected; the poll budget lengthens the interval. |
| Operations | Staff pulse e2e (≤60 s); alert channel payload per stop request; rollout-off keeps services and the desk; intake pause and daily cap; service-hours due times incl. payments; `STAFF_DESK_IN_USE` guard. |
| Release gate | CI runs the architecture test (main.py cap, script.js budget); the publish workflow runs npm test + e2e + PG + image smoke before pushing the SHA tag (P0-11). |
| Refactor safety | Moved submit/review keep the fault-injection test meaningful; the audit extraction keeps audit tests unchanged. |
| Performance | studio.js size guard; pulse columns-only; feed/summary < 200 ms p95 **on PostgreSQL**; lists paged; ≤1 combined Meta read per linked campaign per 30 min; polling ≤5 accounts per tick. |
| Arabic / RTL / phone widths | On `mobile-chromium`: AR/EN at 320/360/390/412/820, light/dark, no overflow, `dir="rtl"`, money LTR, long names and $1,000,000.00 wrap; Arabic-Indic digits; no raw English/JSON in Arabic (classic too); form ≥60% with the keyboard open; Back model; reviewer at 390 px. Smoke on `desktop-chromium` and `mobile-webkit`. Manual: real iPhone Safari and Android Chrome. |
| Honest wording | No automatic-reply promise and no "connected/managed" words on TikTok screens; Instagram labels match the capability state (`on/poll/gated/unavailable`); no raw `publishStatus`; no "24/7" claim; the privacy page retention matches the code. |
| Privacy | Anonymisation scrubs the WhatsApp number, ticket texts, TikTok data and alerts (P1-16, P3-12, P5-04); token never stored or logged (P0-14). |

### 11.2 Existing tests and pipelines that change (and how)
| Test / file | Change |
|---|---|
| `server/test_social_studio.py:471,495,576` | New FB private-reply path (P0-06); `pageRefs`, relink, latency, **webhook counter, parking, health heuristic** cases. |
| `server/test_ad_studio_backend.py:679-730` | A counter proving the simulated 409 fired (late-binding ctx, P1-01/P1-10). |
| `server/test_ad_studio_backend.py` (rest) | Unchanged after the moves; new cases listed in §10. |
| `server/test_postgres_financial_review.py` | **`SCENARIOS` extended** (P1-19, P3-06a, P3-07, P3-14). Run by CI `postgres-migration` and, after P0-11, by the publish workflow. |
| `server/test_meta_ads.py:792-815` (80004 sets the global pause) | **Unchanged**: the admin lane keeps today's behaviour. Lane tests live in `test_meta_lanes.py`; discovery-skip (account and `ALB-S-` name) and token-eviction tests are added. |
| `server/test_data_integrity.py` | Extended with the §7.8 checks (incl. name code and `studioSince`) and the collision repair. |
| `.github/workflows/ci.yml` | Frontend job adds `test:architecture`, `test:mobile-config`, `test:profitability` (P0-11). |
| `.github/workflows/publish-image.yml` | Adds a PostgreSQL 16 service, `alembic upgrade head` and the financial scenarios before the image build (P0-11). |
| `privacy.html` | Facts corrected (P0-12); terms section (P5-06). No existing test pins its text; a new ST check compares the retention figure with `main.py`. |
| `scripts/test-mobile-ui.js:1152-1160` | **Kept while classic exists** (the classic `help` tab is not a wallet/connections tab). Replaced at P6-04 (D10). |
| `scripts/test-mobile-ui.js:1166-1177` | Updated if D1 renames the brand. |
| `scripts/test-mobile-ui.js:1248-1266` | Kept; a parallel check for 15g–15l. |
| `scripts/test-mobile-ui.js:1491-1492` | Re-run after P1-08a. New checks: refusal-map completeness, `publishStatus` labels, daily-draft conversion notice, Android Back hook, privacy retention. |
| `tests/e2e/design-system.spec.js:317-322` | Kept for classic (the e2e admin is not in the allowlist); the v2 loop lives in `studio-v2.spec.js`. |
| `tests/e2e/critical-flows.spec.js:366-382` | Heading updated if D1; widths 360/412 added. |
| `scripts/start-e2e-server.js` | Adds `ALBAYAN_STUDIO_V2=pilot`, `ALBAYAN_E2E_STUDIO_SEED=true` (P2-13). |
| `playwright.config.js` | Unchanged; specs tag the full matrix to `mobile-chromium` and keep one smoke test for the other projects. |
| `scripts/test-architecture.js` | Unchanged until P1 ends; then the main.py cap = count + 30 (D15). Now also enforced in CI (P0-11). |
| Audit tests | Unchanged after P0-02; a limit-trim case for P1-17. |
| `scripts/test-permissions.js`, `scripts/test-design-shell.js:224-228`, `scripts/test-social-native-regressions.js:16-38` | Expected unchanged; re-run. |

### 11.3 Per-stage gate
- **Before P0-11 lands** (the first P0 release): the local `npm run release:quality` green **and** CI green on the pushed commit.
- **From P0-11 on, every release is published through the "Publish verified Docker image" GitHub workflow on the exact commit.** It runs `npm test` (incl. the architecture test), e2e on three projects, the PostgreSQL financial scenarios, the image smoke test, and then pushes `bashird/albayan:<sha>`. That SHA tag is what Jelastic deploys and what §14 records. CI on push remains the early warning; the local `release:quality` is optional before pushing.
- **Every money-touching release additionally needs a backup-and-restore proof of the production backup** by the named person (≈30 min, counted in §9). CI's restore step covers CI data only.
- The owner gets a 5-line plain-language note ("what changed / how to check / what to do if it breaks") plus Arabic screenshots at 390 px.

---

## 12. Gradual rollout and rollback

### 12.1 Scope of rollout: web only
- The switches below affect the **web** app (`/studio`, `/ads-studio`). The Capacitor app ships its own copy of the web files (`capacitor.config.json:4`) and is not published yet; this plan does not change it.
- Before any app build that includes the studio is distributed (R2/R4): keep the classic Arabic refusal map backward-compatible (entries only added), and add an "outdated build" check that tells old builds to update or opens `/studio` in the browser.

### 12.2 Switches
- (a) Env kill switch `ALBAYAN_STUDIO_V2=off|pilot|on` (customer layout; container restart).
- (b) Admin rollout record: **customer layout** (`off|pilot|on` + allowlist), **services** (Help, Ask to stop, TikTok), **staff desk** (`off|pilot|on` + staff allowlist). Effective on the next page load. Turning the customer layout off never hides services or the desk; the desk cannot be switched off while open tickets or stop requests exist (`STAFF_DESK_IN_USE`).
- (c) Capability switches per reply channel (`on/poll/gated/off/unavailable`) and for TikTok.
- (d) **Intake** open/paused, plus the daily submission cap (new submissions only).
- (e) Per-session "Classic view" link during preview, pilot and 30 days after.
- (f) `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` is set before Preview A and never removed while any studio campaign runs on that account.

### 12.3 Stages
1. **Dark deploys (P0–P5).** New routes are additive; v2 renders only when `me.ui==='v2'`; the production default is `off`. The P0/P1 fixes reach everyone because they are fixes: LYD "$", Arabic digits, dead button, Arabic refusals, withdraw/approval safety, legacy-row handling, the FB private-reply path, privacy facts.
2. Owner + one staff test account (1 week, after P2).
3. **Before Preview A:** D26 done (Studio account created, funded, system user assigned and proven, env set); P0-10 repair signed; runbook v1 rehearsed; staff desk `on` for staff; alert channel tested (if configured); pilot consent ready (P3-22).
4. **Preview A** (after P3, D20): owner, staff and 2–3 friendly testers; Pages & replies embeds classic; TikTok hidden; **staff time measured**.
5. **Pilot** (after P5; 2 weeks): 3–5 customers; go/no-go reviewed weekly (§12.8).
6. **Each widening step** (more customers, then everyone) happens only while every queue met its D11 target ≥90% over the previous week, **including admin payment confirmations** (§12.7 capacity). Otherwise pause intake, lower the cap, or hold the rollout.
7. **First release** to all (D24/D24b/D34 decided); the classic link is kept for 30 days. Retire classic (P6-04) only after sign-off.

### 12.4 Data safety
- All schema changes are additive; no rows are rewritten; `schemaVersion` bumps only on new writes.
- Classic tolerates new values (`meta_review` label map; `closeReason`, `durationDays`, `goalDetail`, `changeReasons`, `studioRef` ignored; a withdrawn request is a normal Draft); a static test covers the classic label fallbacks.
- Legacy rows follow P1-18 and the legacy Stopped rule (§5.4).
- A verified backup **and restore proof** before every money-touching release (`docs/RELEASE_AND_SAFETY.md:32-35, 81-86`).
- Any repair of existing records follows P0-10: backup, read-only report, the owner's written choice, one audited reversible transaction. Never silently repaired.

### 12.5 Rollback
- **Customer layout:** set rollout `off` → classic within one refresh. Services and the staff desk keep working. **Before switching off:** list open urgent stop requests in the desk and make sure each has an owner.
- **Server image:** redeploy the previous SHA tag (`bashird/albayan:<sha>`) in Jelastic (`docs/RELEASE_AND_SAFETY.md:55-58`), with this rule:
  - **Once the Studio account carries live campaigns, never redeploy a tag older than the P0-09 release** (its SHA is recorded in §14). An older image ignores `ALBAYAN_STUDIO_AD_ACCOUNT_IDS` and the `ALB-S-` skip, and the core auto-import (on by default, `meta_ads.py:1020-1021`) would turn studio ads into unpaid "needs setup" core ads.
  - If it is truly unavoidable: first set `ALBAYAN_META_AUTO_IMPORT=false` (accepting that core auto-import pauses), then redeploy, run the integrity check, roll forward as soon as possible, then re-enable auto-import. The daily check raises `studio_core_collision` if any core row appears.
- The ledger is append-only, and new endpoints only add rows through existing money doors, so rollback never loses money records. Withdraw and stop-request are harmless to old UIs; rows approved with `durationDays` keep valid dates.
- After a rollback past P1, the jobs loop (sweep, daily scan) stops. Orphans are released by the existing paths (resubmit, reject, delete), and the owner runs the on-demand integrity scan daily until the release is rolled forward. After a rollback past P3-18b, replies are no longer parked during an outage (today's behaviour).

### 12.6 Runbook v1 (task P3-15; one page each, Arabic and English)
| Incident | Who acts | First 3 steps | Switch off or redeploy? | Customer message (template) |
|---|---|---|---|---|
| A release breaks money screens | Developer; owner informed | 1. Pause intake. 2. If only v2 is broken: rollout off. 3. If classic or the server is broken: redeploy the previous SHA tag **not older than P0-09**; run the integrity check | v2 → switch; server → redeploy | «نعمل على إصلاح عطل مؤقت. رصيدك محفوظ ولم يتغير.» |
| Daily money scan or reconciliation fails | Developer + owner | 1. Pause intake. 2. Take a backup. 3. Read-only assessment; no repair without the P0-10 steps | Intake pause; rollout unchanged unless the UI shows wrong money | None unless a customer is affected; then a personal ticket reply |
| **Albayan's Meta token expiring** (14/7/2-day alert) | Owner (Business Manager) + developer | 1. Diagnostics → Meta token shows the days left (no Token Debugger needed). 2. **Refresh** the system-user token within its window. 3. Update the env, restart, confirm "valid, expires in 60 days" | Neither | None |
| **Albayan's Meta token revoked/expired** | Owner + developer | 1. Diagnostics shows "invalid" (direct check). 2. Create a new system-user token (refresh is no longer possible). 3. Update the env, restart, check `/api/health/ready`. Parked replies are resent automatically within their windows. **Settlements wait for fresh Meta reads; no mass admin overrides** | Neither; the global banner shows automatically | «نعمل على إصلاح اتصال البيان بميتا. ردودك وإعلاناتك ستتحدث تلقائياً بعد الإصلاح.» |
| Meta pauses Albayan (rate limit) | Nobody at first | 1. Check lane state in diagnostics. 2. If replies are paused > 6 h: the pilot stop rule applies. 3. Tell affected customers | Neither | «ميتا تبطئ الطلبات مؤقتاً؛ سنكمل تلقائياً.» |
| Studio account funds low / account not active | Owner | 1. Top up, or fix the payment method in Business Manager (D30). 2. Check ads in "Delivery problem". 3. Acknowledge the alert | Neither | None (staff fix it before customers see stage 7) |
| Stop request overdue / after hours | On-duty staff (D29), alerted by the desk or the channel | 1. Pause the ad in Ads Manager. 2. Mark the ticket. 3. Settle when the gates open (≈48 h after delivery ended) | Neither | «أوقفنا إعلانك. سنعيد ما لم تصرفه ميتا بعد أن تثبت أرقامها، عادةً خلال يومين إلى ثلاثة.» |
| Payments piling up | Owner (admin) | 1. Open Payments (overdue badge). 2. Confirm or cancel with a reason. 3. If there are often > 5 waiting: consider a second admin (D29) | Neither | None |
| **Business Verification or App Review refused** | Owner | 1. Record the reason in §14. 2. Apply D34 (labels to «غير متاح حالياً» unless polling works; private messages removed from the editor). 3. Owner and lawyer decide on resubmission or another legal entity | Capability switches | Instagram card text changes automatically |
| A staff member leaves | Owner | 1. Deactivate the Albayan user / remove the reviewer preset. 2. Remove Business Manager, app and Studio ad-account roles. 3. Review their audit log for the last 30 days | Neither | None |
| Customer disputes Meta spend | Staff, then admin | 1. Open the ad detail with the stored Meta evidence (`metaSpendAtSettleMinorUSD`, drift reads). 2. Compare with Ads Manager. 3. The admin decides on a credit (audited) | Neither | Personal ticket reply with the numbers |
| Studio jobs heartbeat late (channel alert from the operations worker) | Developer | 1. Check container logs. 2. Restart the container. 3. Run the integrity scan by hand | Redeploy only if the restart fails | None |
| Server down | Developer | 1. `/api/health/live` and Jelastic logs. 2. Restart. 3. If the DB is unreachable, follow `docs/RELEASE_AND_SAFETY.md` | Redeploy the last good SHA tag (P0-09 rule) | Banner on the login help line if > 1 h |

### 12.7 Operational risk register
| Risk | Trigger / metric | Mitigation | Owner | Review |
|---|---|---|---|---|
| Staff capacity exceeded | Submissions per reviewer per day above the D29 cap; any queue < 90% within target for a week | **Cap = floor(0.6 × reviewer desk minutes per day ÷ measured minutes per ad)**; starts at 5 (420 desk min, ≈45 min/ad [ASSUMPTION], recomputed from P0-01(v) and Preview A); intake pause; rollout gate; D29 | Owner | Weekly |
| **Admin bottleneck (payments only confirmable by admins)** | Payment confirmation time vs 4 working hours; payments waiting | Admin queue line and overdue badge; D11 target; a second admin account (D29) | Owner | Weekly |
| Stop requests missed after hours | `stop_request_overdue`; stop → paused p90 | On-duty rule and urgent WhatsApp line (D29); staff pulse; **alert channel** | Owner | Weekly |
| Alert channel silent | P0-01(u) failed; the test button fails | Monthly test alert; fallback to the on-duty rule | Developer | Monthly |
| Support load | Tickets per customer per week; first-response time | Guides (P5-03); contextual tickets; D11 targets | Staff lead | Weekly |
| Meta pauses (rate limits) | Lane parks/pauses in diagnostics; reply latency p95 | Per-lane state; documented header classification; one combined read per campaign; budgets per tick | Developer | Weekly |
| Admin token expiry/revocation | `debug_token` expiry (alerts 14/7/2 days); direct check fails | Refresh within the window; rotation runbook; parked replies; D35 | Owner | Monthly (expiry date) |
| **Business Verification refused or stuck** | Not approved by week 8 | D34; honest labels; Instagram road 1 (polling) if it passed | Owner | Checkpoint week 8, then monthly |
| App Review rejection / delay | Submission status | Honest labels; D24 release without Instagram webhooks; resubmit using the reviewers' feedback (P4-08) | Owner | Monthly |
| **Instagram polling treated as a policy problem** | Meta warning or restriction; P0-01(o) answer | Switch `igPublicReply` to `gated`; rely on App Review | Owner | Monthly |
| Studio account funds run out / account disabled | `studio_funds_low`, `studio_account_inactive` | Float amount and top-up routine (D30) | Owner | Weekly |
| FX float (USD owed to customers vs LYD received) | Diagnostics "USD owed" vs USD held + Studio funds | Buy USD against confirmed USD payments; rate stamped per payment (`wallet_payments.py:211-213`); D30 | Owner | Weekly |
| Absorbed overspend (D27) | `meta_overspend`, `post_settle_spend_drift` (to day 28); monthly total | Launch checklist; link warning; lifetime budget ≤ paid; 48 h settle wait | Owner | Monthly |
| Storage growth and backup size | `storage_threshold` (DB size, top owners, backup size) | Retention (D31); R2 media storage (D12); per-owner 48 MB quota | Developer | Monthly |
| Backup not restorable | Restore proof missing before a money release | Restore proof in every money release (§11.3) | Developer (named, D29) | Each release |
| PostgreSQL-only bug | PG scenario failure | P1-19 scenarios in CI and the publish workflow; gate §11.3 | Developer | Each release |
| Legal gaps | D18 not finished before the pilot | Corrected privacy facts (P0-12); data inventory (P3-22); pilot consent; terms section (P5-06) | Owner | Before Preview A and the pilot |
| Single developer dependency | Developer unavailable | Runbook in plain words; small releases; SHA tags recorded; one-button release | Owner | Quarterly |

### 12.8 Pilot go/no-go (D32)
**Go (all rows, for 2 consecutive weeks):**
- 0 daily integrity violations; 0 refunds above the cap without an audited override;
- reconciliation difference ≤ max($5, 1% of the month's studio spend) [RECOMMENDATION, D32];
- ≥90% of reviews, ≥90% of stop requests and **≥90% of payment confirmations** within the D11 targets;
- ≥90% of linked ads checked < 6 h ago;
- webhook reply latency p95 ≤ 2 min, and **poll reply latency p95 ≤ 10 min** if Instagram road 1 is used [ASSUMPTION targets]; reply failure rate < 5% excluding gated channels;
- 0 comments lost to a token outage within the windows;
- no open money incident; runbook rehearsed; restore proven in the last 7 days; token valid with > 14 days left (or non-expiring).

**Stop rules (any one):** switch intake to paused and the customer layout off, take a backup, investigate, **never silently repair**:
- any wallet identity break;
- a duplicate charge (two captures for one cycle, or two returns for one capture);
- a stranded capture ("Being returned") older than 1 h;
- a studio ad appearing in the core books;
- a comment-reply outage longer than 6 h;
- a studio jobs heartbeat late > 15 min.

---

## 13. DECISIONS & QUESTIONS for the owner

Moved to [DECISIONS.md](DECISIONS.md).

## 14. Iteration change log
- **Iteration 1, 2026-09-24 (initial plan):** read all six study parts; re-checked frames f022, f071, f083, f103; found the daily-budget one-day hold (`wallet_payments.py:89-151`, `15c:1247`); chose Direction A; main.py line plan; placeholders for the P0-01 facts.
- **Iteration 1 — product scope and user experience (2026-09-24):**
  - **Improved:** four-number money strip with identity (S1); ad-level Meta stages incl. rejected, delivery problem and ended (S2); exact quick-boost fields with P1-13/D19 (S3); error codes and complete map (M1); Arabic-Indic digits (M2); `durationDays` (M3); honest owner summary and D24 (M4); subscription check and single health source (M5); TikTok as a labelled service (M6); Help and Pages & replies in the bottom nav (M7); Back model and Android hook (M8); consented WhatsApp number (M9); J0 onboarding (M10); pending-payment state (M11); stop-request route (M12); reason picker (M13); baselines B1–B6 (M14); per-day floor (M15); Preview A and R2 cuts (M16); rename list, presets from own data, contradictions, `goalDetail`, focus mode, staff nav, legacy Stopped rule, Instagram pre-check (m1–m8).
  - **Rejected/adjusted:** the "COMPLETED" test was replaced by an end-date test (no such status); existing routes keep a string `detail`; no self sign-up in the MVP; the first release still includes all four owner items.
- **Iteration 2 — architecture, integration and data (2026-09-24):**
  - **Improved:** withdraw on the stop-route pattern + approval self-release + orphan sweep (ARCH2-01); dedicated Studio ad accounts skipped by core import (ARCH2-02); Meta call lanes and claims (ARCH2-03); settlement gates with `insightsState`/`spendConfirmedAt`/`deliveryEndedAt` (ARCH2-04); Running outranks Ended (ARCH2-05); missing main.py edits counted (ARCH2-06); late-binding ctx + counter (ARCH2-07); ledger/payment staff-id redaction (ARCH2-08); error shape by URL prefix (ARCH2-09); subscribe permissions and P0-01(l) (ARCH2-10); ledger-based buckets and "Being returned" (ARCH2-11); staff routes and alerts (ARCH2-12); fail-closed Studio list (ARCH2-13); `pageRefs` (ARCH2-14); fixed-length ids (ARCH2-15); `publishStatus` labels (ARCH2-16); SQL projection and indexed pulse (ARCH2-17).
  - **Rejected/adjusted:** studio results from core `ads` rows (needs studio ads in the core books); blanket 80xxx-per-account classification (page codes differ; admin lane pinned); Meta e2e (no Meta mock); stored watermark (indexed query instead).
- **Iteration 3 — operations, risks and implementation readiness (previous revision, 2026-09-24).** Every finding was checked against the code at `d7d627e`; Meta's App Review screen-recording page was fetched on 2026-09-24.
  - **Improved:** OPS3-01 PostgreSQL race proofs (P1-19); OPS3-02 per-lane locks, pacing and back-off incl. `usage_high`; OPS3-03 studio jobs loop independent of Meta (P1-21); OPS3-04 D8a/D8b split; OPS3-05 staff pulse, on-duty rule, after-hours line; OPS3-06 capacity lines, intake switch, rollout gate; OPS3-07 rollback rule "not older than P0-09"; OPS3-08 layout-independent services and desk; OPS3-09 risk register, funds alert, D30; OPS3-10 runbook v1, daily money scan, restore proofs; OPS3-11 legacy in-flight rows (P1-18, D33); OPS3-12 e2e harness (P2-13); OPS3-13 `created_by` rule; OPS3-14 global connection state; OPS3-15 explicit lock table; OPS3-16 stage model before screens (P1-20); OPS3-17 service hours (P3-16); OPS3-18 storage lines, single JSON cast, `EXPLAIN ANALYZE`; OPS3-19 effort and calendar; OPS3-20 task splits; OPS3-21 go/no-go (D32); OPS3-22 P0-10 repair procedure; OPS3-23 decision groups; OPS3-24 scheduled settle read, post-settle drift; OPS3-25 fact owners; OPS3-26 web-only rollout.
  - **Rejected/adjusted:** Postgres not added to the local gate (CI runs it); separate lane locks instead of a priority queue; results sync moved to the studio jobs loop rather than the Social Studio tick; feed digest fields only as a fallback.
- **Iteration 4 — resolving remaining significant issues (round 1), 2026-09-24.** Each finding of review 4 was verified before changing the plan:
  - against the code at `d7d627e`: `social_studio.py:1064-1066, 1196, 1208, 1294-1452`; `15f:1145`; `meta_ads.py:193-207, 321-345, 1003-1107, 1387-1393, 1625-1670, 3497-3511, 4071-4078, 4821-4860, 5924-5956`; `ad_final_spend.py:1-60`; `operations.py:125-140, 784-809, 925-980`; `wallet_payments.py:620-630`; `main.py:533-534, 600-608, 1196-1202, 2976-2998`; `privacy.html:29, 48`; `ci.yml`; `publish-image.yml`; `package.json:34-37`; `docs/OPERATIONS_SAFETY.md:85-102`; `gh run list`;
  - against Meta pages fetched on 2026-09-24: insights best practices, Instagram webhooks, ad-campaign-group, debug_token, system-user tokens, access levels, rate limiting.
  - **Improved:**
    - **R4-01 (App Review tied to P4):** confirmed. D8b is re-dated to "submit as soon as D8a completes", recorded on the classic screens in English (P1-24, moved from P4-08). A new "Check recent comments now" admin action (P1-23) shows a real Instagram reply without webhooks. The owner summary, §0 finding 19, §8.2 critical path, D24 and the calendar now say Instagram can arrive by the first release, depending on Business Verification and Meta's review time, not on P4.
    - **R4-02 (Instagram polling):** added as "road 1": fact P0-01(w) with an audited admin test (P0-05e); a conditional, budgeted polling source (P4-09) on the page lane, reading only recent media and comments newer than the cursor and the rule creation; duplicate-safe via the existing log-id guard; its own latency target (p95 ≤ 10 min); a capability state `poll` with its own label; policy risk recorded.
    - **R4-03 (no branch if Facebook fails; permission list incomplete; app mode unknown):** D24b (Group 1) added; the D8b permission list is built from the App Dashboard dependencies incl. `pages_manage_engagement`, `pages_read_engagement`, `pages_show_list`, `instagram_basic`, `business_management`; P0-01(t) records app mode, type and registered URLs.
    - **R4-04 (false negatives in facts a/g):** confirmed (`social_studio.py:1312, 1320, 1347, 1352, 1371`). Webhook delivery counter (P0-13) counts before filters; (a) reads it; (g) is answered first from positive log evidence.
    - **R4-05 (token expiry; comments lost in an outage):** confirmed. `ALBAYAN_META_APP_ID` + server-side `debug_token` (P0-14) answer P0-01(k)/(p)/(l-permissions) automatically; expiry alerts 14/7/2 days (P3-18a); the runbook says "refresh within the window"; authorization failures are parked while the token is invalid and resent after recovery within the 7-day (private) / 24-h (public) windows (P3-18b); settlements wait during an outage, with no mass overrides.
    - **R4-06 (global state misfires on per-page 190s):** the direct token check (≤1 per 10 min) decides the global state; 190.492 and permission codes stay per-page; tests added.
    - **R4-07 (3 h settlement unsafe):** confirmed with Meta's own words. `spendDelayHours` default is now 48 h (D28); a never-delivered exception allows an immediate full return; drift reads extended to day 28; P0-01(s) measures drift from Albayan's core ads; stage 10 copy and the D11 settlement target are now measured from `settleReadDueAt`; spend cap rejected as a limit ($100 minimum).
    - **R4-08 (Studio account facts; weak D26(b)):** P0-01(n) split into n1 (developer reads `metaFundsState` in week 1), n2 (owner creates **one** account) and n3 (prove Full control via `fundsHidden=false`). D26(b) is replaced by the studio code `ALB-S-…` in campaign names, skipped by discovery/import before importing and required at link time, on top of the dedicated account. The funds alert now also watches `account_status` for card-funded accounts. `studioSince` handles a repurposed account.
    - **R4-09 (staffing numbers):** D11 gains a payment-confirmation target (4 working hours); admin queue lines and an overdue badge (P3-19, §5.3); the cap is now a formula (starting at 5/day); the risk trigger matches the cap; P0-01(v) measures staff minutes on 10 agency ads in weeks 1–2.
    - **R4-10 (no alert when no desk is open):** the existing operations alert sender carries staff-only urgent events (P3-21), with one kind per stop request; the independent operations worker watches the jobs heartbeat; P0-01(u) checks the channel and payload; an admin test button is added.
    - **R4-11 (release gate):** P0-01(q) is answered (CI ≈ 8 min). P0-11 adds the missing test scripts to CI and a PostgreSQL step to the never-run publish workflow, which becomes the release path of record. Its SHA tag is the tag recorded for the P0-09 rollback rule. The gate in §11.3 is rewritten.
    - **R4-12 (usage header types):** P3-00b classifies by documented types and object keys; unknown → app-wide; P0-01(r) is non-blocking.
    - **R4-13 (legal pages):** the privacy facts are corrected now (P0-12, with a static test); data inventory and pilot consent (P3-22); a customer terms section in `privacy.html` (P5-06), no new route; D18 rewritten.
    - **R4-14 (no branch for a refused Business Verification):** D34 (Group 1) with a week-8 checkpoint in the risk register and a runbook row.
    - **R4-15 (private Instagram accounts):** the pre-check asks «هل حسابك عام؟»; health reasons `instagram_private` (staff-set) and `instagram_comments_not_arriving` (heuristic); first fix step "make the account public".
  - **Rejected or adjusted (with reason):**
    - **R4-01 "submit immediately":** adjusted to "submit as soon as Business Verification completes", because Advanced Access requires it [VERIFIED 1.4]. The package is still prepared earlier. P0-01(o) is kept as a parallel, non-blocking question.
    - **R4-05 "two system users":** adjusted (D35). Under Limited Access the second one would be the admin system user, which Meta advises keeping for admin actions only [VERIFIED 1.8]. So: one expiring token with alerts now; two system users after Full Access.
    - **R4-07 "return in two steps (part now, rest later)":** not adopted, because it would break the one-door refund rule (one return per cycle), which is a security property. The never-delivered exception is marked [ASSUMPTION: low drift risk] and watched by the drift reads.
    - **R4-09 "cap ≈ 5":** reproduced with explicit assumptions (420 desk minutes, ≈45 min per ad). With 35 min per ad the formula gives 7, so the start value is conservative and recomputed from P0-01(v).
    - **R4-11 "add `npm test` to CI":** the three missing scripts are added instead, because the backend job already runs pytest and a full `npm test` would double CI time. Either option closes the gap.
    - **R4-15 "check privacy in the 6-hourly health check":** no documented API field shows Instagram account privacy [ASSUMPTION], so a heuristic plus staff confirmation is used instead.
  - **Effort impact:** ≈73–92 dev-days before contingency (was 65–82); first release ≈ week 19–23 (was 17–21). The growth comes from P0-11…P0-14, P0-05e, P1-23, P3-18a–c, P3-21, P3-22, P4-09 and P5-06. P4-08's recording work moved to P1-24 (no net change). Per-release overhead drops by about 0.5 h once the publish workflow is used.
  - **Still unresolved:**
    - Business Verification for Libya: accepted documents and timing (D8a, D34).
    - Meta App Review outcome and timing, and whether a managed, login-free flow passes (D8b, P0-01(o)).
    - Whether Instagram polling with the system-user token works without Advanced Access and is acceptable to Meta (P0-01(w)).
    - Whether Facebook public replies reach commenters without an app role (P0-01(g), likely answered from logs in week 1).
    - Whether one USD Studio ad account can be created, funded and assigned (P0-01(n2)).
    - Albayan's own spend-drift pattern (P0-01(s)); 48 h is an informed default.
    - Real staff minutes per ad (P0-01(v), Preview A).
    - Whether the alert channel accepts the payload (P0-01(u)).
    - Whether the Docker Hub secrets exist for the publish workflow (P0-11).
    - TikTok in-app auto-messages in Libya (P0-01(e)); the `min_daily_budget` value and unit (P0-01(f)); legal reviews and the trademark search (D18).
  - **Release tags to record when shipped:** P0-09 release SHA tag (`bashird/albayan:<sha>`): _to be filled_; P1 cutover time (`adLimits.p1CutoverAt`): _to be filled_; App Review submission date and ID: _to be filled_; P0-01 fact results (a)–(w) with dates: _to be filled_.

---

### Critical Files for Implementation
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\ad_campaign_actions.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\wallet_payments.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\meta_ads.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\social_studio.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\test_postgres_financial_review.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\main.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\server\operations.py`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\.github\workflows\publish-image.yml`
- `C:\Users\bashi\Desktop\Start_V3_26_7_3\Start_V3_26_3_2\src\15c-ads-studio.js`
