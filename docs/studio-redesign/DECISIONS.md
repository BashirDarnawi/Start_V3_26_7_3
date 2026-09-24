# Albayan Studio redesign — DECISIONS

Part of the approved plan ([PLAN.md](PLAN.md)). Each decision lists the options and a recommendation. The owner's answers are recorded in the log below with the date.

## Answers log

| Decision | Answer | Date | Notes |
|---|---|---|---|
| Ads model | Managed now, automatic later | 2026-09-24 | Binding owner answer |
| First release scope | Ad requests + tracking, comment auto-replies, support tickets, TikTok | 2026-09-24 | Binding owner answer |
| Ad pricing | Budget only from the USD wallet; Albayan earns from LYD plans | 2026-09-24 | Binding owner answer |
| Platform | Phone-friendly web first (/studio) | 2026-09-24 | Binding owner answer |
| D4 + D5 (budgets) | Customer chooses **daily or lifetime** budget. The **total** the customer pays (lifetime amount, or daily × days) must be **$5 – $2,000**. Hold and charge = that total (fixes the one-day-hold bug). Meta's per-day minimum is still checked. | 2026-09-24 | Owner answer; replaces the plan's 'total-only' recommendation for D5 |
| D26 (studio vs core books) | **Same ad accounts** (no new Studio account). Every studio request gets a **unique name generated automatically** at approval (`ALB-S-XXXXXX · <request name>`). Staff create the ad in Meta with any name; when they **link** the campaign in the studio desk, Albayan **renames it in Meta automatically** and claims it: discovery/import skip claimed campaigns and `ALB-S-` names, untouched copies already imported into Albayan Manager are removed, and a daily check flags any studio campaign edited or billed in Manager. Studio ads show only in Albayan Studio. | 2026-09-24 | Owner answer. Automatic rename needs `ads_management` on Albayan's own ad accounts (the integration is read-only today); P0-14 reads the token scopes. If the permission is missing, fallback = a one-tap "Copy name" button for staff until the owner grants it. |
| D8a (Business Verification) | **Later** (not started now). | 2026-09-24 | Owner answer. Consequences: D8b (App Review) and P1-24 are deferred; Instagram replies at launch only via the polling road if P0-01(w) passes; private messages stay switched off and are labelled «غير متاح حالياً» (not "waiting for Meta", because nothing was submitted). |
| D19 (boosting) | Two choices for the customer: (1) **pick one of the linked page's posts from a list** (the studio reads the page's recent Facebook posts / Instagram media) and boost it; (2) **make a new ad without a post** with their own photo and text. Pasting a post link stays as a fallback when the page is not linked yet. | 2026-09-24 | Owner answer. Adds an owner-scoped "recent posts of my linked page" read (page lane). |
| D24b, D33, D34 | Recommended defaults adopted until the owner says otherwise: D24b (a) release on time with replies labelled if the Facebook check fails; D33 (a) legacy daily requests already waiting are sent back with an Arabic note so they are resubmitted under the new total rule; D34 superseded by D8a = later (labels «غير متاح حالياً»). | 2026-09-24 | Defaults, changeable |
| **D36 (system boundaries)** | **Option A: every Smart System is a separate module inside one Albayan platform.** Albayan Manager, Albayan Ads Studio, Clothes System and every future system (CRM, Store, ...) each has its own code folder (server + screens + own bundle), its own record types, its own API prefix, its own switch and tests. They share only the platform (login/users, wallet, subscriptions, Meta connection, notifications, design look) through fixed doors, and an automatic guard test forbids one system touching another system's code or data. Customers keep one login and one wallet. | 2026-09-24 | Owner answer (option B, fully separate apps, rejected). Adds tasks P0-15…P0-17 (Ads Studio) and CL-01 (Clothes, separate job). |

## 13. DECISIONS & QUESTIONS for the owner

**Group 1 — ask now (before P0/P1):** D4, D5, **D8a**, D19, **D24b**, D26, D33, **D34**.
**Group 2 — before the P2/P3 build:** D1, D2, D6, **D8b** (timing set by D8a), D10, D11, D15 (end of P1), D16, D21, D22, D23, D25, D27, D28, D29, D30, **D35**.
**Group 3 — before Preview A / pilot:** D17, D18, D20, D32.
**Group 4 — before the first release or later:** D3, D9, D12, D13, D14 (before P5), D24, D31.

| ID | Group | Question | Options | Recommendation |
|---|---|---|---|---|
| D1 | 2 | Product name | (a) «استوديو البيان» Albayan Studio; (b) keep «استوديو إعلانات البيان»; (c) «البيان للنمو» | **(a)**: shorter, original, covers more than ads |
| D2 | 2 | Arabic by default in `/studio` (~25 B) | Yes / No | **Yes** |
| D3 | 4 | Arabic web font | System fonts (MVP) / self-host an OFL font | **System fonts in the MVP** |
| D4 | 1 | Min/max ad budget per request and the per-day floor | e.g. min $5, max $2,000; floor from P0-01(f) | **Min $5, max $2,000; floor from Meta** |
| D5 | 1 | Customer budgets total-only? | Yes / keep daily with hold = daily × days | **Yes, total-only** |
| D6 | 2 | Show an LYD estimate next to USD budgets? | Yes, labelled "estimate" / No | **Yes** |
| D7 | — | ~~Show "Meta is reviewing"?~~ | Resolved (§5.4) | — |
| **D8a** | 1 | Start Meta **Business Verification** now | Now / later | **Now (week 1)**: it gates Advanced Access for Instagram and private messages; the week-8 checkpoint feeds D34 |
| **D8b** | 2 | **App Review**: when and what | (a) Submit as soon as D8a completes, recorded on the **existing classic screens** in English (P1-24), with the permissions from the App Dashboard dependency list (`pages_messaging`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_manage_metadata`, plus `pages_manage_engagement`, `pages_read_engagement`, `pages_show_list`, `instagram_basic`, `business_management` where listed or where P0-01(g)/(w) show Standard Access is not enough); (b) wait for the v2 screens (≈ week 13–16) | **(a)** (earliest ≈ week 6–7). Don't wait for the answer to P0-01(o); use the reviewers' feedback |
| D9 | 4 | Show the private-message option before approval? | Hidden / "waiting for approval" / enabled | **"Waiting for approval"** (hidden if D34 fires) |
| D10 | 2 | Wallet as its own tab (reverses `test-mobile-ui.js:1152` at P6-04) | Own tab + Home strip / Overview only | **Own tab + Home strip** |
| **D11** | 2 | Targets and **working hours** | Review ≤1 business day; tickets ≤4 working hours; stop requests ≤2 working hours (outside hours: next working morning, or the urgent line until `onDutyUntil`); **payment confirmation ≤4 working hours (admin)**; settlement ≤2 business days **after the final Meta read** (`settleReadDueAt`); TikTok ≤1 business day. Hours default Sun–Thu 09:00–17:00 Tripoli [ASSUMPTION], Ramadan override, holiday list | **As listed; the owner confirms days, hours, Ramadan hours and holidays** |
| D12 | 4 | Photo storage | Inline (MVP) / file storage (R2) | **Inline in the MVP; file storage in R2** |
| D13 | 4 | Automatic sending to customers beyond in-app | In-app + staff button / SMS or WhatsApp provider | **In-app + staff button for the MVP** (staff alerts use the existing operations channel) |
| D14 | 4 | TikTok included or a paid add-on; approve the copy | Included / add-on | **Included during the pilot; review after 2 months** |
| D15 | 2 | Lower the main.py cap after P1 | Yes (count + 30) / No | **Yes** |
| D16 | 2 | Show Albayan's WhatsApp in Help too? | Yes / tickets only | **Yes, as secondary** |
| D17 | 3 | Preview and pilot customers | Names from the owner | 2–3 for Preview A; 3–5 for the pilot |
| D18 | 3 | Legal: privacy corrections, customer terms, data inventory | (a) Correct the privacy facts now (P0-12); lawyer reviews the data inventory (P3-22) and writes the customer terms section (P5-06); a signed plain-Arabic pilot consent for Preview A if the review is not finished; (b) wait for the lawyer for everything | **(a)**: facts now, lawyer review before the pilot |
| D19 | 1 | Quick "Promote a post" with a link only | Yes (P1-13) / No | **Yes** |
| D20 | 3 | Preview A with friendly customers before replies/TikTok | Yes / only owner and staff | **Yes** |
| D21 | 2 | Spend ~130 of the 558 free startup bytes on the Android Back hook and login help line | Yes / No | **Yes** |
| D22 | 2 | Optional WhatsApp number (with consent) | Yes / No | **Yes** |
| D23 | 2 | Accounts, passwords and resets stay staff-assisted; numbers on the login page | Staff-assisted / self sign-up (R2) | **Staff-assisted; the owner provides the numbers** |
| D24 | 4 | If Instagram is neither approved nor working by polling on release day, release with Facebook replies and Instagram labelled «بانتظار موافقة ميتا»? | Release / wait | **Release** (switched on later by capability, without a new release) |
| **D24b** | 1 | If **Facebook** replies fail P0-01(g) and cannot be fixed by week 8 | (a) Release ads, money, help and TikTok on schedule, with all replies labelled «بانتظار موافقة ميتا», switched on by capability when approved; (b) delay the whole first release until a reply channel works | **(a)**: the other three owner items don't depend on replies; requirement 2 is then delivered as "built and waiting for Meta", stated honestly |
| D25 | 2 | Top-up presets | From history / fixed | **From history** |
| D26 | 1 | Keep studio ads out of the agency books | (a) **One** dedicated USD Studio ad account (more later if needed) **plus** the studio code `ALB-S-…` in every studio campaign name; (c) current shared accounts protected by the studio code only (discovery and import skip tagged campaigns; linking refuses untagged ones) | **(a)**; (c) only if P0-01(n2) shows a new account is impossible. The old option (b), hiding drafts at link time, is dropped: discovery runs every 60 s and usually imports first |
| D27 | 2 | Meta spends more than the customer paid | Albayan absorbs / bill the customer | **Albayan absorbs** (budget-only promise); tracked monthly |
| D28 | 2 | Settlement wait and who can override the gates | (a) Admin only, written reason; wait **48 h** after delivery ends; never-delivered ads at once; drift watched to day 28; (b) 3 h (returns faster, but Albayan absorbs later spend changes and can never correct them); (c) 7 days | **(a)**, tuned from P0-01(s) and the pilot. Meta says numbers may change "for a couple of days" and are final after 28 days [VERIFIED] |
| **D29** | 2 | **Staffing:** who staffs the desk and when; on-duty person and urgent WhatsApp number until what time; who does backup-restore proofs; daily submission cap; second admin for payments? | Named people / hours / cap formula | **One named reviewer during working hours with the desk open on a phone; on-duty until 23:00 for urgent stops; the developer does restore proofs; cap = floor(0.6 × desk minutes ÷ minutes per ad), starting at 5/day, recomputed from P0-01(v) and Preview A; consider a second admin account for payment confirmations if they often exceed 4 working hours** |
| **D30** | 2 | **Funding float and FX:** how much USD to keep in the Studio account, who tops up, how often USD is bought against customer payments | Amount / person / cadence | **Float ≈ 1.5 × average weekly approved budgets; the owner tops up weekly; buy USD for every confirmed USD payment within 2 working days** (funding method chosen from P0-01(n1)) |
| **D31** | 4 | **Retention** | Reply log / alerts / closed tickets periods | **Reply log 12 months; acknowledged alerts 6 months; closed ticket texts anonymised after 24 months; results rows kept with the ad** (goes into the data inventory, P3-22) |
| **D32** | 3 | **Pilot go/no-go thresholds** (§12.8), incl. the reconciliation tolerance | As proposed / other | **As proposed; tolerance max($5, 1%)** |
| **D33** | 1 | **Legacy daily-budget requests** already Submitted when P1 ships | (a) Request changes (reason "budget_dates") so the customer re-enters a total; (b) approve and launch at lifetime budget = captured amount (one day's budget) | **(a)**, with a prepared Arabic note; (b) only if the customer asks for it |
| **D34** | 1 | **If Meta Business Verification is refused or not finished by week 8** | (a) Instagram shows «غير متاح حالياً» (unless Instagram road 1, polling, works); private messages are removed from the rule editor rather than shown as waiting; R3 is re-planned; the owner and lawyer consider verifying through another legal entity; (b) keep the "waiting" labels indefinitely | **(a)**: honest labels; review monthly |
| **D35** | 2 | **Meta token choice** | (a) One system user with a 60-day expiring token (Meta's security recommendation) + expiry alerts 14/7/2 days and the refresh runbook; (b) one non-expiring token (no scheduled outage, weaker security); (c) two system users (pages/replies vs ads read) so one expired token doesn't stop both — under Limited Access the second would be the admin system user, which Meta advises keeping for admin actions only [VERIFIED 1.2, 1.8] | **(a) now; (c) after Full Access allows more system users (R2/R3)** |

---

## Task changes caused by the answers

- **P0-09** Studio separation: no Studio account env; skip `ALB-S-` names and claimed campaign ids in discovery / manual import / `import_meta_ad_draft`; link-time claim removes untouched imported copies; add automatic rename on link (new sub-task P0-09b, needs `ads_management`; fallback Copy-name button).
- **P1-06** Budgets: keep **daily and lifetime**; hold and capture = the total (lifetime amount, or daily × days); total must be $5–$2,000; Meta per-day minimum still checked.
- **P1-13** Boost: post picker from the linked page (new owner-scoped read of recent page posts / IG media) + "new ad without a post"; link-only submit rule kept.
- **P1-24 / D8b** App Review package: deferred with D8a.
- **P4-09** Instagram polling remains the only launch road for Instagram replies.

## Still unknown (answered by live checks or third parties)

1. Meta Business Verification for Albayan in Libya: accepted documents and timing are unverified (research 5.3). It gates Advanced Access for Instagram comment webhooks and all private messages. Handled by D8a (start week 1) and D34 (week-8 checkpoint), but the outcome cannot be known now.
2. Meta App Review outcome and timing, and whether a managed, login-free flow (assets shared through Business Manager, system-user token) passes review. P0-01(o) asks in parallel, and P1-24 submits on the classic screens. Meta's review time is unknown.
3. Whether Albayan's system-user token can read and answer comments on customers' shared Instagram accounts under Standard Access, and whether Meta accepts this polling. Testable only live in week 2 (P0-01(w)); decides whether Instagram replies work at launch without approval.
4. Whether Facebook public replies reach commenters who have no app role (P0-01(g)). Likely answered from existing reply logs in week 1; if it fails, D24b decides whether requirement 2 ships as 'waiting for Meta'.
5. Whether Albayan can create, fund (USD; prepaid or card) and assign one dedicated Studio ad account with Full control for the system user (P0-01(n2)/(n3)). The fallback D26(c), studio code on shared accounts, exists.
6. How long Meta spend actually keeps changing for Albayan's ads (P0-01(s)). The 48-hour settlement wait and the never-delivered exception are informed defaults, not measurements.
7. Real staff minutes per ad and the resulting capacity and daily cap (P0-01(v), Preview A). A single admin is also the only person who can confirm payments.
8. Legal review: customer terms, privacy notice coverage (commenter data, tickets, WhatsApp numbers, TikTok handles), Libyan data-protection duties, and a trademark search for 'Albayan Studio' (D18). This needs a lawyer.
9. Whether TikTok's in-app auto-messages are available to Libyan business accounts (P0-01(e)). This decides whether the TikTok service includes set-up help or advice only.
10. Operational prerequisites that depend on the owner's accounts: whether the operations alert channel is configured and accepts the JSON payload (P0-01(u)), and whether the Docker Hub secrets exist in the GitHub 'production' environment for the publish workflow (P0-11).
