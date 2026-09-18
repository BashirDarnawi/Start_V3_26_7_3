# Deep scan — 18 September 2026

Scope: bugs, errors and security across the backend (`server/`), the frontend
(`src/`), deployment files and dependencies, on top of the three 15–16 September
reviews (which were found uncommitted and landed as commit `89a323d`). Six
independent read-only hunters (frontend XSS, backend auth/web hardening,
uploads/SSRF/injection/webhooks, wallet/paywall/Social Studio logic, a
regression review of the uncommitted batch, and frontend/native robustness)
reported findings with file/line evidence; each fix below was re-read in code
before it was made and is covered by a regression test or a static guard.

No production data was read or changed. Only the public health endpoint, the
login error shape and response headers of the live site were inspected.

## Fixed

### Backend

| Area | Problem | Fix |
| --- | --- | --- |
| API docs | `/docs`, `/redoc` and `/openapi.json` were public on production, describing every route, body field and idempotency namespace. | Docs routes exist only when `ALBAYAN_DEBUG_MODE` is on (`server/main.py`). |
| Signature checks | `hmac.compare_digest` raises on non-ASCII strings, so a garbage media signature, webhook signature, verify token or origin-secret header from an anonymous caller became a 500 with a traceback (and fed the error-rate alert). | `constant_time_equal` in `server/security.py` compares UTF-8 bytes; used in `social_studio.py`, `meta_ads.py`, `http_security.py`. |
| Webhook comments | Every public comment loaded all of the owner's published posts including base64 photos, under the global comment lock. | `process_comment` uses the media-free `_lean_posts` projection. |
| Media rate limit | The Social Studio media route keyed its limit on the leftmost `X-Forwarded-For` entry, which the client controls. | Shares `auth_limits._client_ip`. |
| Signed media URLs | Signed with the raw Meta app secret, never expired, and a random per-boot key when the secret was unset. | Dedicated derived key, `exp` parameter (default 48 h, `ALBAYAN_SOCIAL_MEDIA_URL_TTL_SECONDS`), signature covers post, index and expiry. |
| Rate-limit identity | Session/reset/app-login rows and the password-change limit used the raw peer address instead of the shared resolver. | All use `_client_ip`. When proxy headers arrive while `ALBAYAN_TRUST_PROXY_HEADERS` is off, the server logs one warning; deploy docs updated. |
| Error logs | Unhandled-exception logs could include SQLAlchemy `[parameters: …]` (bound values such as password hashes). | `_safe_exception_text` redacts parameters; the traceback no longer repeats the raw message. |
| Stylesheets | The four new workspace stylesheets were served without cache-busting (1 h at the browser and the Cloudflare edge) while `script.js` was versioned. | Added to the `?v=` loop in `_serve_versioned_index`. |
| `/studio/` | A trailing slash made the shell resolve `script.js` relative to `/studio/`, which does not exist: "Loading…" forever. | 308 redirect to the slash-less route, query preserved. |

### Frontend

| Area | Problem | Fix |
| --- | --- | --- |
| Lazy bundles | When `clothes.js`, `studio.js` or `admin-tools.js` failed to load, every render re-requested it (offline phone: a tight request loop, spinner forever, Retry card unreachable). | 30 s cooldown after a failure in all three loaders; the Retry button resets it. |
| Filter panels | The 15 September batch collapsed every list's "Filters & sort" panel by default and forgot the choice on reload. | Choice persisted per list in `localStorage`; wide screens default open, phones default folded. |
| Phone header | The current view title had been replaced by a static label. | Shows the view title again, brand name beneath. |
| WhatsApp reminders | Arabic-digit phones produced an empty link (the app opened itself), and local `09…` numbers were not international; the customer was still marked "reminded". | Uses the existing phone normaliser (`218…`), refuses unreadable numbers, reminder log is per account. |
| Sign-out | Search boxes, the receipt customer filter, the charge-wallet reference card and Control Center data survived into the next sign-in on the same device. | Cleared in the sign-out teardown. |
| Sidebar | Staff with `analytics` view saw "Control Center", which the router then refused. | Platform-owner views never listed for non-admins. |
| Driver tab | Removing `deliveries.viewOwn` from a driver left a Deliveries tab that bounced back. | Permission gate mirrors the router exemption. |
| Blank screen | A first render that threw left an empty page. | Bilingual "reload" card, only when the page is blank. |
| Plans page | A failed price fetch spun "Loading prices…" forever. | Failure state with retry. |
| Social composer | A keystroke during a slow save silently dropped the result. | Saved-as-draft notice; a completed publish always shows its result. |
| Deliveries | The Cancel action was hidden for the rare `Office` status. | Negative condition restored. |
| Plan manager | A half-typed or malformed price became 0 and saved an active free plan. | Invalid input keeps the previous price. |
| LYD previews | Ads Studio preview/estimate used floating-point rounding that disagreed with the server's LYD instruction by a piastre. | Same integer arithmetic as the server. |
| Idempotency keys | Wallet top-up keys were `paycreate-<uid>-<ms>` (guessable, cross-user existence oracle). | Random secure ids. |
| Paywall | The Subscribe button state came from a possibly stale local ledger. | One live-sync tick when the paywall opens. |
| XSS hardening | One unescaped customer name (transfer modal); Meta page ids inside an inline `onclick` string; the client stripper could be bypassed by doubling (`oonclick=nclick=`). | Escaped; data attributes; strip-until-stable loop. No exploitable XSS was found — output encoding is applied consistently and the server strips angle brackets on every write. |

## Verified and left as is

- Cookies (HttpOnly, SameSite, Secure), CSRF via strict same-origin checks on
  every mutation, PBKDF2-HMAC-SHA256 600k, hashed tokens, single-use reset
  codes, PKCE app login, CORS allowlist, HSTS/CSP/frame denial, request size
  limit 10 MB, image validation by magic bytes and pixel limits, Meta Graph
  SSRF guards, webhook HMAC (503 when unsigned), backups with constant names
  and AES-GCM, bound SQL parameters everywhere, no `eval`/`pickle`/shell.
- `npm audit`: 0 advisories. `pip-audit` (49 packages): 0 advisories. Bandit
  medium+/medium+: one flag, the operator-configured alert webhook URL.
- Git history of source files: no credential markers.
- The native-reminder pause deliberately survives sign-out (fail-closed; pinned
  by `scripts/test-social-native-regressions.js`).

## Needs the owner's decision (not changed)

1. **Smart Systems plan is a client-only paywall.** No server route checks a
   `smart_systems` subscription; the Albayan Manager APIs are RBAC-only. If this
   plan is ever priced, it is unenforceable. Either add a server gate (admin and
   staff exempt) or keep the plan presentation-only.
2. **Customer self-stop refunds** the full captured budget whenever the campaign
   has no launch marker and its start date is in the future — including an ad
   staff launched by hand and forgot to mark. Consider requiring the launch
   marker before an approved campaign counts as live.
3. **Global `adCampaignRequests.submit`** lets staff submit a customer's draft,
   which places a hold on the customer's wallet with no customer action.
4. **Deliveries compact rows** from 12 September were replaced by job cards in
   the 15 September batch; the helper `shellDeliverySummaryRow` is now unused.
   Keep the cards or restore the rows.
5. **Deployment:** set `ALBAYAN_TRUST_PROXY_HEADERS=true` on the Jelastic app
   node (the container is only reachable through Cloudflare and the platform
   load balancer). Without it all visitors share one login-attempt allowance and
   one stranger can lock the office out of signing in. Optionally add
   `ALBAYAN_ORIGIN_SECRET` with a matching Cloudflare header rule.
6. **CSP** still allows inline scripts (`'unsafe-inline'`) because the UI uses
   inline handlers; moving to delegated handlers with a nonce is a larger
   refactor.
7. Sessions have no idle timeout and no "sign out other devices" action.


---

# Round 2 (same day)

Six further hunters with new lenses: frontend/backend API contracts,
database concurrency and dialect differences, forms/dates/Arabic input,
the Meta integration, operations/deployment and supply chain, and a
route-by-route permission matrix. Findings were verified against the code
(several with scratch tests that are now permanent regression tests in
`server/test_deep_scan_round2.py`). The browser suite was also run three
extra times (252 cases) with no flaky failure.

## Fixed

### Permissions (proven by tests)

| Problem | Fix |
| --- | --- |
| A driver holding a broad grant could delete, batch-delete or create ads/receipts outside their assignment, and edit customers not referenced by their deliveries, through the generic collection routes (reads were already scoped). | The write routes apply the same assignment boundary as reads. |
| A staff member holding only `users.resetPassword` could set the password of a more privileged colleague and sign in as them. | Password reset is refused when the target holds any permission the actor lacks. |
| A user with `users.changeRole` could change their own role. | Self role change refused. |
| `ads.edit` / `receipts.edit` alone could hand a delivery to a non-driver. | The generic edit path validates the target is an active Delivery user. |

### Meta integration (proven by tests)

| Problem | Fix |
| --- | --- |
| An ad dated in a closed accounting month stayed first in the spend-sync queue forever: every pass asked Meta about it, the write was refused (423), nothing changed, and live ads behind it never synced. A failure on such an ad even aborted the whole batch. | The ad is parked for 30 days without touching its version; failure recording cannot raise out of the loop. |
| When discovery failed (expired token, outage) the background worker retried it every two seconds and never ran the spend sync; the reason was invisible in the status. | The discovery interval applies to failures too; the last error is stored for the connection status. |
| Every Page/Instagram comment webhook also triggered an ad-account discovery read. | Comment webhooks return after the Social Studio dispatch. |
| "Sync due now" returned an opaque 500 when discovery raised. | The sync still runs; the discovery error is returned as text. |
| A pass whose results could not be read was stored as a successful "$0 spent" sync, which the stop/reconciliation forms prefilled. | Such a pass keeps the previous synced-at stamp and records `insights_unavailable`. |
| Month totals and profit analytics treated Meta spend in any currency as dollars. | Only USD accounts are summed. |
| Meta reporting slightly more than the budget left the spend prefill blank/zero. | The prefill starts at the budget (the most that can be booked). |

### Database and operations

| Problem | Fix |
| --- | --- |
| The temp receipt counter, the USD charge-request rate lookup, and receipt-number collision scans opened a second pooled connection inside a locked transaction (proven to time out with a small pool); the number scans also loaded every receipt's photos. | The open connection is reused; the scans select only the number fields. Pool sizing (5+5) documented for the Jelastic node. |
| Campaign hold totals loaded every campaign with its images on every wallet debit. | Filtered and projected in SQL. |
| `COALESCE()` around indexed JSON expressions defeated the wallet indexes on PostgreSQL. | Bare expressions. |
| Bulk import and anonymisation locked rows in heap order. | `ORDER BY` before `FOR UPDATE`. |
| Month preview/close loaded every receipt and ad with their photos under the exclusive period lock. | Media-stripped projection. |
| A briefly unreachable database at boot exited the container (the platform does not restart it). | Ten retries with a three-second pause. |
| `create_indexes.py` used PostgreSQL syntax that cannot work on a text column, and one failure aborted every later index in the same transaction. | Only the composite index remains; every index statement runs in its own transaction. |
| Backups restarted their schedule from zero on every boot. | The schedule continues from the newest file on disk. |
| The error-rate alert judged the ratio since boot and counted health probes. | Rolling window; probes excluded. |
| Alembic autogenerate would propose dropping the startup-created indexes. | Name filter in the migration environment. |
| Container logs were block-buffered; no graceful-shutdown bound. | `PYTHONUNBUFFERED=1`, `--timeout-graceful-shutdown 8`. |
| Readiness could not tell an empty SQLite fallback from PostgreSQL. | Readiness reports the dialect; startup warns on SQLite. |

### Frontend

| Problem | Fix |
| --- | --- |
| Marking a Clothes shipment received in server mode added the stock, then the shipment update was refused (405); a retry added the stock again. Deleting a shipment was impossible. | Status and delete go through the transactional shipment route; verified in a browser (3 → 7 → 7 → 3, delete accepted). |
| Server validation errors showed as "[object Object]". | Field and reason are named. |
| A pasted "1,250" in any money box saved 1.25. | Commas in groups of three or next to a dot are thousands separators; "12,5" stays a decimal. |
| Deliveries WhatsApp/Call links broke for local `09…` and Arabic-digit numbers. | International digits everywhere. |
| Typing a local number did not find a customer stored internationally. | Search compares the canonical phone key. |
| The refund prompt rejected Arabic digits. | Digits folded. |
| Clothes dates showed the UTC day (a day early after midnight). | Local calendar day. |
| Stop / Mark-launched minted a new operation id per click with no retry; a lost reply became a false "Conflict". | One operation per campaign version, retried, 409 checked against the server. |
| Wallet charge requests regenerated their idempotency key per click. | One key per amount/currency/method until created. |
| The phone's keepalive permission flush lacked the request-id header the CSRF check needs. | Header added. |
| A refused permission grant stayed on screen for 30 s. | Users reload on the next tick. |
| Ads Studio wizard fields had no ids, so a live-sync repaint closed the keyboard mid-typing. | Stable ids. |
| Native HTTP read timeout (30 s) was shorter than the app's own budgets. | 120 s (needs a new native build). |
| Removed dead code: two unused security helpers and an unreachable receipt-submit branch (kept the startup bundle inside its budget). | |

## Verified and left as is (round 2)

- Money paths: row locks, compare-and-swap writes, idempotency namespaces,
  single-transaction captures/refunds, receipt→ads→customers lock order.
- Meta Graph: pagination bounds, rate-limit backoff, token never logged,
  SSRF guards, snapshot idempotency, staff fields never overwritten by sync.
- Route map: every frontend call resolves to a server route; dead server
  routes listed in the hunter report are external or diagnostic by design.

## Still open for the owner (round 2)

1. ~~Customer merge lock order~~ — fixed in the follow-up commit: the merge
   now discovers linked rows with a media-stripped scan, locks receipts,
   then ads, then pages, then the two customers (the same order as every
   money path), re-verifies under the locks and returns a retryable 409 if a
   link appeared meanwhile. Four tests in
   `server/test_customer_merge_lock_order.py` pin the order, the money
   conservation, the photo handling and the race.
2. **Startup repair passes** run in full on every boot; consider a
   "done for this release" marker.
3. **Backup now** runs inside the HTTP request (can exceed the 100 s edge
   timeout on large databases); off-site backups are never pruned.
4. **Python dependencies** are pinned only at the top level; a hash-locked
   requirements file and digest-pinned base image would make builds
   reproducible.
5. **Control Center** toasts are English-only.
6. Linked ads are never retired from the Meta sync queue (finished ads still
   refresh every 15 minutes).
7. Sessions: no idle timeout; `users.edit` lets a non-admin change another
   non-admin's email; audit log entries include emails and amounts for any
   `auditLogs.view` holder.
8. The startup bundle sits ~5 KB under its 2.4 MiB budget and
   `server/main.py` is 111 lines under its cap: the next feature must
   lazy-load or extract something first.

## Review of the fixes themselves

An adversarial reviewer re-read every change from both rounds. It found and
these were corrected before release: the password-reset guard could crash on
a legacy permissions row and would have blocked managers from resetting
drivers' passwords (now tolerant, and Delivery accounts are exempt because
their grants are scoped to their own jobs); the alembic name filter would have hidden
the metadata's own indexes; the charge-request idempotency key was not per
user and survived sign-out; the driver delete guard reached collections that
have their own checks; a driver holding `receipts.add` could no longer create
an unassigned office receipt (only assigning a job to another driver is
refused now); the Arabic comma did not follow the thousands rule; and the
clothes date helper handled date-only values wrongly. The customer-merge
lock-order fix landed in the same follow-up commit.
