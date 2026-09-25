# Albayan Studio redesign — TASKS

Part of the approved plan ([PLAN.md](PLAN.md)). Task ids (P0-01 … P6-05) are referenced from the plan, the decisions and commit messages.
Each task lists its expected outcome, acceptance criteria and how it is verified.

## Progress

| Task | Status | Commit / release | Notes |
|---|---|---|---|
| P0-02 | Done | 8c082d7 / release-8c082d71ed38-20260924T195027485Z | Audit routes in `server/audit_routes.py`; main.py 14,199 → 14,074 lines; behaviour proven identical (54-request differential run) |
| P0-06 | Done | 8c082d7 | FB private replies on `POST /{page-id}/messages`; one retry with a fresh Page token; Meta code 1200 temporary; Meta error code kept in the reply log |
| P0-07 | Done | 8c082d7 | Dead Page token (code 190 / HTTP 401) is forgotten; selective eviction test |
| P0-15 | Done | stage 2 | `server/systems/`, `src/systems/`, docs/SMART_SYSTEMS.md with the template for new systems |
| P0-16 | Done | stage 2 | Ads Studio server modules moved into `server/systems/ads_studio/` (all importers updated, no shims needed) |
| P0-17 | Done | stage 2 | Boundary guards: `server/test_system_boundaries.py` + `scripts/test-system-boundaries.js` in npm test and CI |
| P2-00 | Done | stage 2 | Ads Studio screens moved into `src/systems/ads_studio/`; studio.js byte-identical |
| P0-03 | Done | stage 3 | `studio_types.py`, `/api/studio/me`, router registered (+5 main.py lines) |
| P0-04 | Done (except P3 part) | stages 3–4 | `rollout`, `intake`, `capabilities`, `limits` ($5–$2,000 total), `settlement` (48 h), `hours` (Sun–Thu 09:00–17:00 Tripoli, holidays, Ramadan), `contact`, `targets`, `thresholds` + `ALBAYAN_STUDIO_V2`; `/me` shows public limits, hours (open now) and contact. `studio-accounts` dropped (D26: same ad accounts). `STAFF_DESK_IN_USE` waits for tickets (P3-20) |
| P0-05c | Done | stage 4 | `GET /api/studio/admin/facts`: facts b, c, d, f, g, i, m, n1, s (counts/flags only; Meta read only on Refresh, cached 24 h). Tests in `server/test_studio_facts.py` |
| P0-05d | Done | stage 4 | `POST /api/studio/admin/pages/{id}/subscribe-test` (admin, once per page per Tripoli day, audited) |
| P0-05e | Done | stage 4 | `POST /api/studio/admin/instagram/{id}/read-test` (admin, once per account per day; one public reply at most, audited) |
| P0-10 | Tooling done | stage 4 | `server/meta_collisions.py` report (`GET /api/meta-ads/collisions`) + `scripts/studio_collision_repair.py` (owner-signed choices with a per-row decision fingerprint, dry run by default, never removes rows with money, reversal refused for a closed month, reversal files kept outside the repo, kept forever in the audit log). **Running it needs the owner** |
| P0-11 | Done (local) | stage 4 | Every release runs the PostgreSQL money-race tests on a throwaway PostgreSQL 16 (`npm run test:postgres`, ~40 s) before the image push; `publish-image.yml` has the same steps. The GitHub dry run needs the Docker Hub secrets (owner) |
| P0-05a | Done | stage 3 | `GET /api/studio/admin/diagnostics` (admin only, counts only) |
| P0-05b | Done | stage 3 | Baselines B1–B6 (archived requests included in the history baselines) + top-up preset source (most common confirmed top-up amounts, counts only) |
| P0-08 | Done | stage 3 | `studio_errors.py`; `scripts/studio_detail_inventory.py` lists studio, wallet and plan refusals (report only) |
| P0-09a | Done | stage 3 | Discovery, import and link skip or refuse `ALB-S-` campaigns (fail closed when the name is unknown); Manager's ad picker hides them (best effort: not in Meta's slim fallback read, where the link refusal still holds). Rename on link = P0-09b |
| P0-11a | Done | stage 3 | CI runs the architecture, mobile-config, profitability and system-boundary guards |
| P0-12 | Done | stage 3 | Privacy page: 365-day audit retention, the exact kept entries (test compares with the server's keep list), Ads Studio data and comment processing |
| P0-13 | Done | stage 3 | Webhook delivery counter (counts only, after the signature check, flushed once a minute) |
| P0-14 | Done | stage 3 | `GET /api/meta-ads/token-health` (platform route), reading tied to the key it checked, at most one Meta check per 10 min except the admin refresh; needs `ALBAYAN_META_APP_ID` |
| P1-01 + P1-10 | Done | stage 5 | Submit and review moved word for word into `ad_campaign_actions.py` (62-request before/after comparison identical); main.py 14,082 → 13,749 lines |
| P1-04 | Done | stage 5 | `closeReason` (customer_stop / staff_stop / completed — completed is staff-only); lifecycle and staff-test audit actions kept forever (privacy page names them) |
| P1-07 | Done | stage 5 | `GET /api/studio/wallet/summary`: Available, Reserved, In your ads (Meta used), Spent, Being returned, per-ad money chains; LYD separate; one PostgreSQL snapshot; property test of the identity |
| P1-08a + P1-08b | Done | stage 5 | Classic screen: LYD rows in LYD, budget summary counts Submitted/Approved only, dead Connections button replaced by text, form limits = server limits from `/me`, Arabic digits |
| P1-17 | Done | stage 2–3 | The row-limit cleanup reads the same keep list (`_AUDIT_KEEP_ACTIONS`) |
| P1-20 | Done | stage 5 | `adCampaignResults` type, pure `derive_display_stage()` (13 stages), shared fixture `stage_cases.json` (54 cases), `GET /api/studio/campaigns/summary` |
| P1-06 (changed, D4+D5) | Done | stage 6 | Daily OR lifetime; `totalBudgetMinorUSD` = lifetime amount or daily × days; hold at submit and charge at approval = the total; refunds use what was really charged |
| P1-08c | Done | stage 6 | Arabic entries for every new refusal (T1–T14 + Meta busy); a check keeps client and server texts in step |
| P1-11 | Done | stage 6 | `durationDays` (1..maxDays); a late approval keeps the number of days |
| P1-12 | Done | stage 6 | Review reasons (budget_dates, creative_quality, text_policy, targeting, page_access, payment, other) required for send-back/reject, shown to the customer |
| P1-13 (changed, D19) | Done | stage 6 | Post picker from the customer's linked page (Facebook posts + Instagram media), or a new ad without a post, or a pasted link as fallback |
| P1-14 | Done | stage 6 | Goal detail ↔ objective rules, Libya location chips (34 keys), result type map |
| P1-15 | Done | stage 6 | Total limits, per-day floor and max days from the `limits` setting, for new rows only |
| P1-18 | Part done | stage 6 | (a) legacy rows keep their old rules (`legacyRules`, `schemaVersion` 2 for new sends). (b) not needed (daily kept, D4+D5). (c) staff send back waiting daily rows (D33) — manual, owner/staff |
| P1-22 | Done | stage 6 | Intake pause switch + Tripoli-day cap (default effectively off until the owner decides D29; plan start value 5) |
| Studio health screen | Done | stage 4 | Admin-only section in the studio review tab: facts, Meta key health, page subscription test, Instagram read test |
| D36 door | Done | stage 3 | `server/user_directory.py`: systems read users only through this door; the guard refuses SQL on any table other than `entities` inside a system (incl. comma joins, USING, TRUNCATE and SQL kept in a variable; SQL built by `+`/`%`/`.format()` is not parsed) |

## 10. TASKS

**Verification legend:**
- **UT** = backend pytest on SQLite (`npm run test:backend`) — **logic tests, not concurrency proof**.
- **PG** = a PostgreSQL scenario in `server/test_postgres_financial_review.py`. It runs in the CI `postgres-migration` job on every push (`.github/workflows/ci.yml:101-134`) **and, after P0-11, in the publish workflow**.
- **ST** = static script test (`npm test`).
- **E2E** = Playwright (project named).
- **MAN** = manual check on a real phone or in production admin.

Every task is ≤ ~1 day and can ship on its own behind the switches.

### Added by owner decision D36 (system boundaries, 2026-09-24)

| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P0-15 | System-module standard: `server/systems/__init__.py`, `server/systems/ads_studio/` package, `src/systems/ads_studio/` folder, template folder + short guide (`docs/SMART_SYSTEMS.md`) | A new system can be scaffolded by copying the template; build and Docker image include the folders | `npm run build`, `npm test`, image smoke test |
| P0-16 | Move Ads Studio server modules (`ad_campaign_actions.py`, `ad_campaign_fields.py`, `social_studio.py`) into `server/systems/ads_studio/` with thin re-export shims at the old paths during the move; later remove the shims | Behaviour unchanged; all Ads Studio / Social Studio tests pass unchanged | Full backend suite; e2e |
| P0-17 | Boundary guard: a server test (no system module imports another system or queries another system's record types outside the platform doors) + extend `scripts/test-import-boundaries.js` for `src/systems/*` | The guard fails on a deliberate violation and passes on the tree | New guard tests |
| P2-00 | Move `15c-ads-studio.js` / `15f-social-studio.js` into `src/systems/ads_studio/`; new `15g`/`15h` files created there | `studio.js` byte-identical before/after the move | `npm run build` diff, guards |
| CL-01 | (Separate job, after the Ads Studio MVP) Move Clothes System server code out of `main.py` into `server/systems/clothes/` and `15b-clothes.js` into `src/systems/clothes/` | Behaviour unchanged; frees many main.py lines | Clothes tests + e2e clothes journey |

### Phase 0
**P0-01 Fact check** (recorded in §14 with the date). Owner = who does it; the method is in brackets.
| Fact | Owner (method) | Due |
|---|---|---|
| (a) IG comment webhooks arriving? Read the **webhook delivery counter** (P0-13) by object and field after 7 days. Zero `ig` log rows prove nothing (finding 26) | Developer | week 2 |
| (b) FB DM failures and error class | Developer (diagnostics) | week 1 |
| (c) daily-budget requests by status (feeds P1-18) | Developer (diagnostics) | week 1 |
| (d) ad-account allowlist non-empty | Developer (diagnostics) | week 1 |
| (e) TikTok in-app auto-messages on a Libyan business account? | Staff (own TikTok business account) | week 2 |
| (f) `min_daily_budget` per account, with unit | Developer (diagnostics read) | week 1 |
| (g) FB public replies reach commenters without an app role: **first from positive evidence** (fb log rows with a `public` action and no error in the last 30 days, from commenters who are not staff/test accounts); staged helper-account test only if there are none | Developer; staff only if needed | week 1 (week 2 if staged) |
| (i) `subscribed_apps` for every linked page | Developer (diagnostics read) | week 1 |
| (j) baselines B1–B6 | Developer (P0-05b) | week 1 |
| (k) admin token holds `ads_management`? **Answered automatically** from `debug_token` scopes (P0-14) | Developer | week 1 |
| (l) page permissions (`pages_manage_metadata`, `pages_show_list`, `pages_manage_engagement`) per page from `granular_scopes` (P0-14) + one subscribe test on one shared page | Developer reads; **admin presses the audited test button (P0-05d)** | week 2 |
| (m) core `ads` rows colliding with studio requests; any with customer/receipt/collection | Developer (read-only report, feeds P0-10) | week 1 |
| (n1) existing allowlisted accounts: `isPrepay`, funds text present, currency, `fundsHidden` (from `metaFundsState`; flags only) — does Albayan already fund USD prepaid accounts? | Developer | week 1 |
| (n2) create **one** USD Studio ad account; choose the funding method; assign the system user with `ads_read` + Full control; are studio campaigns today on shared accounts? | **Owner in Business Manager**, with a short illustrated guide written by the developer | week 2 |
| (n3) prove Full control: `get_account_funds` on the Studio account returns `fundsHidden=false` | Developer | after (n2) |
| (o) is a managed, login-free flow acceptable for App Review? (asked in parallel; **does not block submission**) | Owner asks Meta developer support (developer drafts the question) | week 3 |
| (p) token type, `expires_at`, `data_access_expires_at` (**automatic**, P0-14); which Business Manager person owns the token | Developer (automatic) + owner (owner name only) | week 1 |
| (q) release-gate duration: **ANSWERED** — CI ≈ 8 min at `d7d627e` (run 35995177433, 7m58s); the publish workflow is timed at its first dry run (P0-11) | Developer | week 1 |
| (r) shapes of Meta usage headers — **non-blocking confirmation** of the documented types (counts-only log) | Developer | weeks 2–4 |
| (s) Meta spend drift on core ads: `finalSpendMetaMinorAtConfirmation` vs the later `metaSpendMinor`, and hours between Meta end and confirmation (counts and percentiles only) | Developer | week 1 |
| (t) app mode (Live/Development), app type, registered privacy-policy and data-deletion URLs, app roles | Developer + owner (App Dashboard) | week 1 |
| (u) operations alert channel: is `ALBAYAN_ALERT_WEBHOOK_URL` set? Which channel? Does it accept the JSON payload (or need a `text` field)? | Developer + owner | week 1 |
| (v) staff minutes per ad: log the next 10 agency ads built in Ads Manager (review, build, link-equivalent, check) | Staff (a simple sheet) | weeks 1–2 |
| (w) **IG-poll:** a person without an app role comments on a shared customer Instagram (public, professional); the system token reads the comment and posts a reply (admin button P0-05e, audited) | Staff helper + admin | week 2 |

| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P0-02 | Extract `/api/audit`, `/api/audit/cleanup`, `/api/audit/stats` into `server/audit_routes.py` | Behaviour unchanged; main.py net −≥105; audit tests unchanged (`test_main.py:460-481`, `test_permissions_flow.py:391-408`, `test_simple.py:367-373`, `test_deep_scan_round14.py:115`) | UT, ST (architecture) |
| P0-03 | `studio_types.py` (`derived_id`, `created_by` rule, `studio_ref`), `studio_api.py` skeleton, registered (≤8 lines, before the SPA catch-all); new types in `SOCIAL_STUDIO_COLLECTIONS` | `/api/studio/me` works; generic `/api/collections/supportTickets` refused; ids ≤80 chars | UT `test_studio_api.py::test_me_requires_login`, `::test_generic_api_refuses_studio_types`, `::test_derived_ids_fit_entity_id_rule` |
| P0-04 | Settings records (rollout incl. `staffDesk`/`services`, intake + daily cap, capabilities with `poll`/`unavailable`, limits, settlement, studio accounts, hours, contact, targets, thresholds) + `ALBAYAN_STUDIO_V2` kill switch | Admin-only PUT; version conflict 409; env `off` forces classic layout; pilot allowlist works | UT `test_studio_api.py::test_rollout_admin_only`, `::test_kill_switch_wins`, `::test_staff_desk_switch_independent` |
| P0-05a | Diagnostics endpoint skeleton (admin-only, no personal data) | Non-admin 403; payload has no names/emails/phones | UT `test_studio_api.py::test_diagnostics_admin_only_no_pii` |
| P0-05b | Baselines B1–B6 + top-up preset source | Computed from existing timestamps on seeded rows | UT `test_studio_api.py::test_baselines_from_timestamps` |
| P0-05c | Fact reads (b, c, d, f, g-evidence, i, m, n1, s) + Studio account config check | Each read returns counts/flags only; config mismatch flagged | UT `test_studio_api.py::test_fact_reads_counts_only`, `::test_studio_config_mismatch_flagged` |
| P0-05d | Admin "subscribe test" button for one page (audited `subscribe_smoke_test`, once per page per day) | Admin only; audited; second press the same day → 409 | UT `test_studio_api.py::test_subscribe_test_admin_audited` |
| **P0-05e** | **Admin "IG read test" button** for one Instagram account: read recent comments; optionally reply to one chosen comment (audited `ig_read_test`, once per account per day) | Admin only; result counts/error code only; the reply is sent at most once | UT `test_studio_api.py::test_ig_read_test_admin_audited_once` |
| P0-06 | FB private reply → `POST /{page-id}/messages` with `recipient={"comment_id":…}`; "outside 7 days / already replied" treated as permanent | Tests at `test_social_studio.py:471,495,576` updated | UT `test_social_studio.py::test_fb_private_reply_uses_page_messages`, `::test_private_replies_endpoint_never_called` |
| P0-07 | Evict the cached page token on authorization errors | A revoked token is not reused | UT `test_meta_ads.py::test_page_token_evicted_on_authorization_error` |
| P0-08 | `studio_errors.py` + a `detail=` inventory script | Inventory printed; `/api/studio/*` uses codes | ST (report-only until P1-08c/P2-11) |
| P0-09 | **[Changed by owner 2026-09-24: same ad accounts + automatic unique name + rename on link; see DECISIONS D26]** Studio separation: env parsed; `studioAccounts` settings; discovery, manual import and `import_meta_ad_draft` skip the Studio account **and any ad whose `campaign.name` contains `ALB-S-`** before importing; `studio_account_allowed()` requires both lists non-empty | Discovery never creates an `ads` row for a Studio account or a tagged campaign on any account; import refused; empty list → `not_allowed`, no Graph call; `test_meta_ads.py:792-815` unchanged. **The release SHA tag is recorded in §14** | UT `test_meta_ads.py::test_discovery_skips_studio_accounts`, `::test_discovery_skips_studio_tagged_campaigns`, `test_studio_results.py::test_empty_studio_allowlist_fails_closed` |
| P0-10 | **Past collision repair (developer, owner sign-off):** (1) backup + restore proof; (2) read-only report of colliding core rows with receipts/collections/customers; (3) the owner's written choice per row; (4) one audited, reversible transaction. Rows with money records are never auto-deleted | Report and signed choices stored; after the transaction the daily check reports 0 collisions; reversal script tested on a copy | MAN + UT `test_data_integrity.py::test_collision_repair_reversible` |
| **P0-11** | **Verified release pipeline:** (1) `ci.yml` frontend job adds `npm run test:architecture`, `test:mobile-config`, `test:profitability`; (2) `publish-image.yml` adds a PostgreSQL 16 service, `alembic upgrade head` and `server/test_postgres_financial_review.py` before the image build; (3) one dry run with `publish_latest=false` [ASSUMPTION: Docker Hub secrets exist in the GitHub `production` environment; owner checks]; the run's duration is recorded as P0-01(q) | CI fails if main.py exceeds the cap or script.js exceeds its budget; the publish run pushes `bashird/albayan:<sha>` only after all tests including PG pass | CI run log; MAN (one dry run) |
| **P0-12** | **Privacy page facts** (`privacy.html`): audience includes studio customers; audit retention "365 days by default; money-history actions are kept permanently" (matches `main.py:1199-1202`) [ASSUMPTION: the production env does not override it; checked]; mentions studio data (ad requests, tickets, TikTok handles, optional WhatsApp number, commenter ids and texts processed from linked pages) | Page states only true facts; no new route | ST `test-mobile-ui.js::privacy retention matches server default` |
| **P0-13** | **Webhook delivery counter** in `handle_meta_webhook`: counts by object and field **before** filters; flushed ≤1/min to `metaHealthState` (best effort) | Counts appear even when no rule exists; no ids or texts stored | UT `test_social_studio.py::test_webhook_counter_counts_before_filters`, `::test_webhook_counter_stores_counts_only` |
| **P0-14** | **Token health read:** `ALBAYAN_META_APP_ID`; `meta_token_health.read_token_debug()` via `debug_token` with the app access token; stores validity, type, expiries, scopes and per-page scope coverage in `metaHealthState`; `GET /api/studio/admin/meta-token` | Answers P0-01(k), (p) and the permission part of (l) without the Token Debugger; the token never appears in stored data, logs or responses | UT `test_meta_token_health.py::test_debug_token_parsed`, `::test_token_never_stored_or_logged`, `::test_missing_app_id_reports_unconfigured` |

### Phase 1 (P1-01 and P1-10 first; P1-19 alongside P1-02 and P1-03)
| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P1-01 | Move submit into `ad_campaign_actions.py` word for word; late-binding ctx (`lambda *a, **k: patch_entity(*a, **k)`, the `main.py:14025` pattern) | All `test_ad_studio_backend.py` tests pass; `test_workflow_operation_recovers_when_identical_request_wins_lock_race` (`:679-730`) gets a counter proving the simulated 409 fired; main.py ≈ −104 | UT, ST |
| P1-10 | Move review the same way | Review tests unchanged; the counter proves the conflict fired; main.py ≈ −170 | UT, ST |
| P1-02 | Serialise submit per the lock table | Two parallel submits exceeding Available: exactly one 409 | UT `test_ad_studio_backend.py::test_two_parallel_submits_cannot_overreserve` (logic); PG scenario `campaign_submit_serialisation` |
| P1-03 | Withdraw (one transaction; keeps `submittedAt`/`lastSubmitOperationId`; releases the cycle's capture) | Submitted → Draft; replay gives the same result; other owner → 404 | UT `test_ad_studio_backend.py::test_withdraw_*`, `::test_withdraw_after_capture_returns_money` |
| P1-03b | Approval self-release on 409 | Capture → withdraw → approval 409 → ledger = pre-submit; an identical concurrent approval is never released | UT `::test_capture_then_withdraw_then_approval_conflict_returns_money`; PG `campaign_approval_self_release` |
| P1-04 | `closeReason`; add `stop`, `withdraw`, `publish_status`, `stop_request`, `settle_override`, `contact_link`, `subscribe_smoke_test`, `ig_read_test`, `check_comments` to `_AUDIT_KEEP_ACTIONS` | Finished requests archivable; customer `completed` → 403 | UT `test_ad_studio_backend.py::test_close_reason_completed_staff_only`, `::test_finished_request_can_be_archived` |
| P1-05 | Staff-identity redaction (campaigns, ledger rows, payment requests) | No customer response contains a staff id or name | UT `test_studio_api.py::test_customer_never_sees_staff_ids` |
| P1-06 | **[Changed by owner 2026-09-24: daily AND lifetime kept; hold = total; $5–$2,000 total; see DECISIONS D4+D5]** Total-only budgets for new customer submissions (D5); classic hides Daily | A new daily submit → 400 "Daily budgets are no longer accepted…"; staff unaffected | UT `test_ad_studio_backend.py::test_daily_budget_refused_for_new_submit` |
| P1-07 | `GET /api/studio/wallet/summary` from the ledger | Scenario 1 (charge 100 → submit 30 → approve → seeded results row spend 3): available 70, reserved 0, in ads 30 (Meta used 3), spent 0. Scenario 2: settle with 27 return → available 97, spent 3; archive → spent still 3. Scenario 3: pending submit 20 → reserved 20. Property test incl. orphan, withdraw, archive, transfers, admin credit/reversal, partial settle | UT `test_studio_wallet.py::test_wallet_summary_*`, `::test_wallet_identity_property` |
| P1-07b | Data-integrity additions + `scan_studio_money()` (incl. the name-code and `studioSince` separation rules) | Seeded violations reported; a clean DB reports none | UT `test_data_integrity.py::test_studio_money_checks_*` |
| P1-08a | Classic fixes: currency-aware charge rows; budget summary counts only Submitted/Approved; Connections card text replaces the dead button (keep `renderAdsStudioConnections`) | No "$" on LYD rows | ST `test-mobile-ui.js` checks "LYD rows use LYD", "no navigateTo('ads') in studio" |
| P1-08b | Classic limits = server limits; Arabic digits at `15c:955`, `15c:1693` via `normalizeDigitsAscii` | `'٥٠'` → $50.00; static limit comparison | ST |
| P1-08c | Arabic entries in `_ADS_STUDIO_REFUSAL_AR` for every new P1 refusal (withdraw, daily refused, per-day floor, min/max, reason required, settle gates, intake paused/cap, missing studio code); entries are only ever added | Static test: every new English prefix has an Arabic entry | ST |
| P1-09 | publish-status `meta_review` + `metaAdAccountId`; unique `metaCampaignId`; **`studioRef` assigned at approval and shown with a copy button**; bilingual `publishStatus` labels in 15c | A double link → 409; no raw value rendered; `studioRef` unique | UT `test_ad_studio_backend.py::test_meta_campaign_linked_once`, `::test_studio_ref_assigned_on_approve_unique`; ST |
| P1-11 | `durationDays` allow-list + approval recompute | PATCH accepts it; a request approved 2 days late keeps 7 days | UT `::test_patch_accepts_duration_days`, `::test_late_approval_keeps_duration` |
| P1-12 | Review reason codes | Validated, stored, returned to the owner; required for changes/reject | UT `test_ad_studio_backend.py::test_review_reason_codes_required_and_stored` |
| P1-13 | **[Changed by owner 2026-09-24: post picker from the linked page + ad without a post; see DECISIONS D19]** Quick-boost rule (if D19 = yes) | A boost with a link only passes strict validation | UT `::test_boost_post_link_only_submits` |
| P1-14 | `goalDetail` + `locationKeys` validators; objective consistency; `resultType` map | An invalid combination → 400 | UT `test_ad_studio_backend.py::test_goal_detail_objective_consistency` |
| P1-15 | Budget limits from `adLimits` at submit and approval (new rows only, see P1-18) | Below the floor → 400 "Budget per day is below the minimum…"; readable via `/me` | UT `test_ad_studio_backend.py::test_budget_limits_enforced_for_new_rows` |
| P1-16 | Anonymisation hook (2 lines) → `scrub_studio_personal_data_conn` | WhatsApp number gone; ticket texts scrubbed; ledger untouched | UT `::test_anonymise_scrubs_studio_personal_data` |
| P1-17 | Limit-trim uses `_AUDIT_KEEP_ACTIONS` (`main.py:1232`) | Trim never deletes a kept action | UT `test_main.py::test_audit_limit_trim_keeps_money_actions` |
| P1-18 | **In-flight legacy rows:** (a) `adLimits.p1CutoverAt` is set at deploy; rows submitted before it (or with `schemaVersion` < 2) skip limits/floor/total-only at approval and are flagged `legacyRules`; (b) when classic opens a daily Draft/Changes Requested, it converts it to a total (daily × days) and shows «حوّلنا ميزانيتك اليومية إلى إجمالي: $X لمدة N أيام — راجعها قبل الحفظ» before Save; (c) before the P1 release, staff clear the P0-01(c) list of Submitted daily rows by the D33 rule | A legacy Submitted daily row approves without a new-limit refusal; a daily draft shows the notice and saves as lifetime; a new daily submit still gets 400 | UT `test_ad_studio_backend.py::test_legacy_submitted_row_skips_new_limits`, ST `test-mobile-ui.js::daily draft conversion notice`, MAN (staff list empty before release) |
| P1-19 | **PostgreSQL race proofs:** add scenarios `campaign_submit_serialisation`, `campaign_withdraw_vs_approve` (both orders, Barrier), `campaign_approval_self_release`, `campaign_orphan_sweep`, `studio_system_alert_insert` (`created_by` NULL passes; `'system'` would fail the FK) | All pass in CI and in the publish workflow; no deadlock within `lock_timeout` 5 s; the money identity holds after each | PG |
| P1-20 | **Stage model before screens:** `adCampaignResults` type; pure `derive_display_stage()`; shared fixture; `GET /api/studio/campaigns/summary` from seeded rows | Unlinked Approved → stage 4 with no Meta-used value; seeded results rows map per §5.4; fixture exported for the client | UT `test_studio_results.py::test_stage_mapping_seeded_*`, `::test_unlinked_approved_is_stage_4` |
| P1-21 | **Studio jobs loop** (`studio_jobs.py`, started from the studio router): orphan sweep, stale-Submitted alert, daily `scan_studio_money()` → admin alert, heartbeat; `studioAlerts` and `studioJobState` types | The sweep runs with **no Meta token**; the sweep is idempotent; a stale capture > 15 min → alert, never released; a violation → `integrity_violation` alert | UT `test_studio_jobs.py::test_sweep_runs_without_meta_token`, `::test_orphan_sweep_idempotent`, `::test_daily_scan_raises_alert`; PG `campaign_orphan_sweep` |
| P1-22 | **Intake switch and daily cap:** submit refused while paused or when today's count reaches `maxSubmissionsPerDay` ("New ad requests are paused…"); drafts still save | Paused/capped → 409 with Arabic mapping; draft PATCH OK | UT `test_ad_studio_backend.py::test_intake_paused_blocks_submit_not_drafts`, `::test_daily_cap_blocks_submit` |
| **P1-23** | **"Check recent comments now" (admin, Instagram):** `studio_ig_poll.read_recent_ig_comments()` + `POST /api/studio/admin/pages/{id}/check-comments`; only comments newer than the cursor and the rule creation; feeds `process_comment(source='manual_check')`; 1/min per account; audited | A seeded comment gets exactly one reply even if the webhook later delivers it; old comments are never answered | UT `test_studio_ig_poll.py::test_manual_check_feeds_process_comment_once`, `::test_old_comments_ignored` |
| **P1-24** | **[Deferred: Business Verification later, DECISIONS D8a]** **App Review package (D8b) on the classic screens, in English:** a demo on a test page and an Instagram professional, **public** account held by an app-role user; one recording per permission (Albayan login → admin link sheet → rule → comment → "Check recent comments now" → reply; FB private message via the P0-06 path); a written use case per permission; permission list from the App Dashboard dependencies; **submitted as soon as D8a completes** | Package stored; submission receipt logged in §14 when submitted; reviewer feedback logged | MAN (2–3 d) |

### Phase 2
| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P2-01 | `15g-studio-core.js`: `apiJson` wrapper, `me` loader, pulse poller, stage consumer (fixture parity), `studioUsd()`/`studioLyd()`, `studioParseAmount()`, `studioParsePhone()`, error map (codes, prefixes, 429 by status); appended to `manifest.lazy["studio.js"]` | studio.js < 1 MiB; no token words; parser cases pass | ST |
| P2-02a | `15h-studio-shell.js`: frame, customer nav, side rail, header; `renderAdsStudioView` delegates when `me.ui==='v2'`; `setAdsStudioTab` still drives `?tab=` | Classic untouched when off | E2E `studio-v2.spec.js` (`mobile-chromium`) "frame renders" |
| P2-02b | URL model `?tab/section/id/step` + Back model | Back at step 3 → step 2; Wallet → Home; Home leaves | E2E `studio-v2.spec.js` "back model" (`mobile-chromium`) |
| P2-02c | Builder focus mode | Nav hidden in the builder; ≥60% of 360×640 with the keyboard open (MAN on phones) | E2E, MAN |
| P2-02d | Staff nav frame (sections filled in P3) | A reviewer sees the staff nav, with no wallet items | E2E `studio-staff.spec.js` "reviewer nav" |
| P2-03 | Home: strip + definitions; Needs you; Getting started; tracker rows; quick actions; intake-paused banner | Numbers equal the wallet summary; **no "Meta used" line before a link** | E2E |
| P2-04 | My ads list + detail + sheets (withdraw, stop, ask to stop, archive) | No `confirm(`/`prompt(` in 15g–15l | ST, E2E |
| P2-05a | Quick boost (3 screens) | Submits end to end in AR at 390 px | E2E |
| P2-05b | Full request steps 1–2 (goal, page picker) | `goalDetail` saved; the page picker lists linked pages | E2E |
| P2-05c | Steps 3–4 (content, audience with city chips) | Inputs have ids, so they survive the 3 s re-render (`src/12-views.js:223-244`) | E2E, ST |
| P2-05d | Budget & days: per-day floor, wallet line, pending-payment state | `٥٠` → $50.00; a short wallet → Add money link | E2E |
| P2-05e | Fix-reason deep links; keyboard behaviour | "Fix: photo" opens step 3 with the field highlighted | E2E + MAN (iPhone/Android) |
| P2-06 | Wallet v2 (incl. pending-payment due time) | Correct currency symbols; purpose confirm screen | E2E, ST |
| P2-07 | Account + `GET/PUT /api/studio/profile` | E.164 only with consent; others cannot read it | UT `test_studio_api.py::test_profile_phone_requires_consent`, E2E |
| P2-08 | CSS in `assets/ads-workspace.css`; `npm run build:css` | No overflow at 320/360/390/412/820, light/dark, AR/EN (`mobile-chromium`) | E2E |
| P2-09 | Startup hooks (§6) + public contact endpoint | `script.js` < 2,516,582 B; the login help line shows the admin numbers | ST (architecture), MAN |
| P2-10 | `tests/e2e/studio-v2.spec.js` journeys | draft → submit → reserved → withdraw → available restored; RTL; no console errors; ≤2 taps | E2E |
| P2-11 | Error-map completeness | Every inventoried string and code maps to AR/EN; the fallback is never raw English | ST |
| P2-12 | Rename (if D1 = a) | script.js change is negative; `ad_maker` unchanged | ST, E2E |
| P2-13 | **E2E harness:** `start-e2e-server.js` sets `ALBAYAN_STUDIO_V2=pilot` and `ALBAYAN_E2E_STUDIO_SEED=true`; specs create dedicated pilot users and add them to the allowlist (never global `on`); the e2e admin stays classic, so `design-system.spec.js:317-322` and `critical-flows.spec.js:366-382` keep testing classic; seed route guarded (§7.3); full matrix only on `mobile-chromium`, one smoke pass on `desktop-chromium` and `mobile-webkit`; unique ids per project (`testInfo.project.name`) | Classic pins pass unchanged; the seed route returns 404 without the flag; the router refuses to start with the flag on PostgreSQL | UT `test_studio_api.py::test_seed_route_guarded`; E2E |

### Phase 3
| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P3-00a | Per-lane lock and pacing clock (`admin`, `studio_results`, `page`) in `meta_ads.py` | A page-lane call is not blocked by an admin call stuck for 15 s (mocked transport): it completes in ≤ ~1 s | UT `test_meta_lanes.py::test_admin_timeout_does_not_delay_page_lane` |
| P3-00b | Per-lane back-off records + classification from **documented header types and object-id keys**: app-wide (4/17/613, `x-app-usage`, unknown types) → all lanes; ads codes and ads types → admin lane (unchanged) or park the named Studio account; page codes and `pages`/`instagram`/`messenger` types → park the named page | Admin 80004 still sets the admin pause (`test_meta_ads.py:792-815` unchanged) while a reply sends; an admin `usage_high` from an ad-account header does not block a reply; a 17 pauses everything; an unknown type → app-wide | UT `test_meta_lanes.py::test_usage_high_ads_header_does_not_block_reply`, `::test_app_wide_code_pauses_all_lanes`, `::test_buc_keyed_by_object_parks_one_page`, `::test_unknown_usage_type_is_app_wide` |
| P3-00c | Lane state persisted (like `metaProviderState`) and shown in diagnostics | A restart keeps parks; diagnostics lists them | UT `test_meta_lanes.py::test_lane_state_persists` |
| P3-01 | `get_campaign_results()` on the `studio_results` lane (incl. lifetime impressions) | Non-Studio account → `not_allowed`, no call; unreadable insights → spend unchanged | UT `test_studio_results.py::test_results_*` |
| P3-02 | Link validation on publish-status | Studio account only (or any allowlisted account under D26(c)); campaign exists; **name contains this request's `studioRef`**; not linked elsewhere; `meta_budget_above_paid` warning | UT `test_studio_results.py::test_link_validation_*`, `::test_link_refused_without_studio_ref` |
| P3-03 | Sync in the studio jobs loop: claims, per-account parking, budget (≤5/tick, ≤10 s), **`settleReadDueAt` read at 48 h**, **drift reads daily until day 28**, post-settle drift alert | A lost claim skips; a due scheduled post publishes on time with 50 due syncs (separate thread and lane); drift > $0.50 on day 20 → alert | UT `test_studio_results.py::test_sync_claims_and_budget`, `::test_settle_read_scheduled_at_48h`, `::test_drift_watch_until_day_28`; `test_studio_jobs.py::test_scheduled_post_not_delayed_by_sync` |
| P3-04a | Meta-fed stages in `derive_display_stage()` + legacy Stopped rule | PENDING_REVIEW → 5; DISAPPROVED → 6; WITH_ISSUES → 7; ACTIVE after end → 8 + alert; PAUSED → 9; nothing delivering + end signal → 10 | UT `test_studio_results.py::test_stage_mapping_meta_*` |
| P3-04b | Results endpoint + customer results card | Owner/staff only; last good values on errors | UT, E2E (seeded) |
| P3-04c | Staff "Check Meta now" (200 + cached) | A second press within 10 min returns the cache | UT `test_studio_results.py::test_check_now_cached` |
| P3-05 | Activity feed + inbox + seen marker | Order, isolation, unread reset | UT `test_studio_api.py::test_activity_*`, E2E |
| P3-06a | **Server settle gates** in the staff stop branch: 48 h after `deliveryEndedAt`; **never-delivered exception**; cap | Refused while delivering; refused before the 48 h read; never-delivered (0 impressions, $0) → full return allowed at once with `settleBasis=never_delivered`; over-cap → 400 | UT `test_studio_results.py::test_settle_gates_*`, `::test_never_delivered_settles_immediately`; PG `campaign_settle_gates` |
| P3-06b | Staff `launch`: link sheet + checklist (studio code, lifetime budget) | Only Studio accounts in the picker; the code has a copy button | E2E `studio-staff.spec.js` (390 px) |
| P3-06c | Ended list + Finish & settle sheet (countdown to the final read) | Pre-filled, capped, no native dialogs | E2E |
| P3-06d | Admin override + `meta_overspend` alert | An override with a reason works and is audited; a reviewer cannot override | UT `test_studio_results.py::test_settle_override_admin_only_audited` |
| P3-07 | Tickets backend (after P3-16) | Isolation, replay, caps, transitions, `dueAt`; numbers unique under 50 parallel creates; reviewer 404 on a payment ticket | UT `test_studio_support.py`; PG `studio_ticket_numbers` |
| P3-08 | Help UI in **both layouts** + "Ask about this" | Classic gets a `help` tab; the related item is pre-filled | E2E (classic + v2), ST |
| P3-09 | Staff tickets section | A reply flips the status; no staff id exposed | UT, E2E |
| P3-10 | `POST …/stop-request` + marker + urgent ticket + chip + auto-close + after-hours line; the classic toast is replaced by the sheet | Replay returns the same ticket; the after-hours response includes the urgent number | UT `test_studio_support.py::test_stop_request_*`, E2E |
| P3-11 | Staff contact link | No number without consent; audited | UT, E2E |
| P3-12 | Scrub extension (results, alerts) | Anonymising scrubs these rows | UT |
| P3-13 | Staff list routes | Auth, paging, 404 rather than 403 | UT `test_studio_staff_routes.py` |
| P3-14 | SQL projection everywhere; a single JSON cast per row on PostgreSQL; `EXPLAIN ANALYZE` of feed/summary/pulse on a seeded PostgreSQL (50 campaigns × 5 MB images) | SQL spy: no campaign `data_json` read in pulse; feed/summary p95 < 200 ms on PostgreSQL, otherwise the digest fields are adopted (§7.6) | UT (spy), PG `studio_feed_explain` |
| P3-15 | **Runbook v1** (Arabic/English, one page per incident, §12.6), approved by the owner and rehearsed once before Preview A | The owner can follow each first-3-steps list; rehearsal logged | MAN |
| P3-16 | **Service hours:** `studio_hours.py` + admin screen; due times for tickets, stop requests, reviews, settlements and **payment confirmations** | A weekend, the evening before a holiday and a Ramadan override each give the right due time | UT `test_studio_hours.py::test_weekend`, `::test_eve_of_holiday`, `::test_ramadan_override` |
| P3-17 | **Staff pulse** route + desk badge, title count, sound/vibration (admins also see pending payments) | A customer stop request appears in an open desk ≤60 s | UT `test_studio_staff_routes.py::test_staff_pulse_counts_by_audience`; E2E `studio-staff.spec.js` "stop request reaches desk" (two browser contexts) |
| **P3-18a** | **Token health and connection state:** daily `debug_token`; expiry alerts at 14/7/2 days; on an authorization failure `check_token_now()` (≤1 per 10 min); `meta_connection_down` only if that check fails; 190.492 and permission codes stay per-page; neutral customer copy; admin + channel alert | Two pages failing with 190.492 → no global state; token invalid → global state; expiry in 7 days → alert | UT `test_meta_token_health.py::test_page_role_lost_is_not_global`, `::test_invalid_token_sets_global_state`, `::test_expiry_warnings_14_7_2` |
| **P3-18b** | **Parked replies:** while the token check says invalid, authorization failures are kept with `parkedReason`, `retryAfter` and `giveUpAt` (private: comment + 7 d; public-only: + 24 h); after recovery the existing retry pass resends; past `giveUpAt` → `missed_during_outage` in the log | No comment is lost to a short outage; no private message is sent after 7 days; per-page failures are not parked | UT `test_social_studio.py::test_auth_failure_parked_while_token_invalid`, `::test_parked_reply_resent_after_recovery_within_window`, `::test_page_role_lost_not_parked` |
| **P3-18c** | **Studio account funds/status alert:** prepaid → funds vs exposure; card-funded → `account_status ≠ 1`; hidden → "funds unreadable" | Low prepaid funds → `studio_funds_low`; a disabled card-funded account → `studio_account_inactive` | UT `test_studio_results.py::test_studio_funds_low_alert`, `::test_card_funded_inactive_alert` |
| P3-19 | **Diagnostics lines:** queue targets met % (incl. **payments waiting, payment/account tickets, overrides**), staff elapsed times (review, link, settle, ticket first response, stop → paused p90, **payment confirmation**), capacity vs the D29 cap, storage (DB size, bytes by type, top owners, backup size), USD owed to customers vs Studio funds, absorbed overspend, webhook counters, token expiry | Lines computed on seeded data; no personal data | UT `test_studio_api.py::test_diagnostics_operations_lines` |
| P3-20 | **Layout independence:** `services` and `staffDesk` independent of the customer layout; `STAFF_DESK_IN_USE` guard | Rollout off → staff still see and act on an open stop request; the customer still opens their ticket in classic | UT `test_studio_api.py::test_rollout_off_keeps_services`; E2E |
| **P3-21** | **Staff alert channel:** `studio_alert_out.notify_staff()` → `operations._send_alert` (one kind per stop request); a `text` field in the payload if P0-01(u) requires it (additive); the operations worker watches `studioJobState.lastTickAt` (alert if > 5 min); admin "test alert" button | A stop request and a stale heartbeat each produce one payload with no personal data; two stop requests within 30 min produce two alerts | UT `test_studio_alerts_out.py::test_payload_has_no_personal_data`, `::test_each_stop_request_alerts`, `::test_heartbeat_watch_alerts`; MAN (test button) |
| **P3-22** | **Legal inputs:** a one-page data inventory for the lawyer (data, purpose, retention per D31, who sees it) and a plain-Arabic pilot consent form for Preview A | Owner has both documents before Preview A | MAN |

### Phase 4
| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P4-01 | Rule `pageRefs`, ownership check, "page removed" | Unlink + relink keeps the rule firing | UT `test_social_studio.py::test_page_refs_*` |
| P4-02 | **[Also: save each reply action (dm/public/like) to the log row as soon as it succeeds, so a server killed mid-reply is never replayed in full (found in the P0 stage 1 review, 2026-09-24).]** `GET /api/social-studio/log` + counters + `receivedAt`/`sentAt`/`source` latency | Owners see only their rows; p95 latency per source in diagnostics | UT `test_social_studio.py::test_reply_log_owner_only`, `::test_reply_latency_recorded` |
| P4-03 | `_set_page_health()`; subscribed_apps check; subscribe on link + backfill only if P0-01(l) passed; **Instagram "comments not arriving" heuristic and staff-set `instagram_private`** | Unsubscribed → `webhook_not_subscribed`; 190.460 → `token_revoked`; growing `comments_count` with no events for 24 h → `instagram_comments_not_arriving`; classic dot and v2 agree | UT `test_social_studio.py::test_page_health_*`, `::test_ig_comments_not_arriving_heuristic` |
| P4-04 | Per-page back-off on the page lane | Page A throttled → page B still replies | UT `test_meta_lanes.py::test_page_park_is_per_page` |
| P4-05 | Capability gates (`on/poll/gated/off/unavailable`) in the executor and editor | A gated DM/IG reply is never sent; the log shows the reason; labels match the state | UT, E2E |
| P4-06 | Pages & replies screens replace the embedded 15f screens | 15f keeps exactly one `apiJson` | ST, E2E |
| P4-07 | Page-link request + Instagram pre-check (professional, linked, **public**) + a verified guide | The request appears in the desk with both answers | E2E, MAN |
| P4-08 | **App Review follow-up** (only if needed): answer reviewer questions; re-record with v2 screens only if reviewers ask | Resubmission logged | MAN |
| **P4-09** | **Instagram polling source** (only if P0-01(w) passed): budgeted poll pass in the jobs loop on the page lane; 5-min interval; cursors; `igPublicReply='poll'` | Each new comment is answered once (poll + webhook dedupe); comments older than the rule or the cursor are ignored; p95 latency ≤ 10 min on seeded runs; a budget overrun lengthens the interval rather than skipping accounts | UT `test_studio_ig_poll.py::test_poll_and_webhook_answer_once`, `::test_poll_respects_cursor_and_rule_creation`, `::test_poll_budget_extends_interval` |

### Phase 5
| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P5-01 | TikTok backend | Validation; ≤3 open; transitions | UT `test_studio_support.py::test_tiktok_*` |
| P5-02 | TikTok UI + staff section + copy | Forbidden words absent | ST, E2E |
| P5-03 | Help guides (money numbers, stages, "why the final amount takes 2–3 days", page sharing, Instagram professional **public** account, TikTok today, **our working hours**) | Present in AR/EN | ST |
| P5-04 | Scrub TikTok requests and Social Studio rows [ASSUMPTION: not covered today] | Rows anonymised | UT |
| P5-05 | Health section complete | Each item links to its fix | E2E |
| **P5-06** | **Customer terms section in `privacy.html`** (advertiser responsibility, managed service, refund timing, support hours), text from the lawyer (D18); linked from Account and the login help line | Present in AR/EN; no new route | ST, MAN |

### Phase 6
| ID | Task | Expected outcome / acceptance | Verify |
|---|---|---|---|
| P6-01 | Pilot: 3–5 customers; weekly owner review of diagnostics | The owner sees queues, stop requests, payments, pages, reconciliation, token expiry | MAN |
| P6-02 | Pilot metrics vs B1–B6 and reconciliation | The §4.1 metrics can be computed | UT |
| P6-03 | Rollout `on`; Classic view for 30 days; rollback rehearsal (incl. the P0-09 image rule) | Layout off → classic within one refresh; services and the desk stay | MAN |
| P6-04 | Retire classic after sign-off; update pins (§11.2) | Old render paths removed deliberately | ST, E2E |
| P6-05 | **Go/no-go review** against §12.8 | All "go" rows green for 2 consecutive weeks; no stop rule fired | MAN (owner signs) |

---
