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


---

# Round 3 (same day)

Four more hunters on areas nobody had examined: the analytics and month-close
maths, the Clothes stock and order invariants, the driver's daily delivery
flow, and the Social Studio rule engine and scheduler. Several findings came
with scratch tests, now permanent in `server/test_deep_scan_round3.py`
(and the Clothes shipment flow was re-verified in a browser).

## Fixed

### Reporting (what the owner sees)

| Problem | Fix |
| --- | --- |
| The month-close snapshot and the analytics screen disagreed: the close counted every ad's full budget as sales (stopped ads at $500 instead of the $100 they spent), ignored staff-confirmed final spend in favour of a later Meta reading, counted a canceled receipt that had once been paid as paid revenue, kept canceled/lost/destroyed receipts in the volume and as "unpaid" blockers, and counted legacy receipt rows stored in the ads collection as ads. | The snapshot now uses the same money vocabulary as the screen (status-aware sales, frozen final spend first, canceled receipts neither revenue nor debt, legacy rows skipped) and reports `adSalesPendingUSD` and `adSpendUSD` (actual). |
| Records were assigned to a month by the UTC date, so a receipt written at 00:30 on the 1st in Libya belonged to the previous month on the server but to the new month on the screen, and closing the old month locked it. | Timestamps are converted to the business time zone (Africa/Tripoli) before taking the calendar day. |
| A freshly imported Meta ad awaiting setup counted as a paid ad and the profit panel priced its spend at today's default exchange rate, inventing revenue that moved whenever the default rate was edited. | `pending_setup` is unpaid; an ad with no agreed local price is never priced at the default rate (it stays under "missing sale rate"). |
| The home hero counted "collected this month" by the date the receipt was written, not when the money came in, and "ad spend" was booked budget. | Collected uses the paid date; ad spend uses actual spend and the same month rule as analytics. |
| The dollar cost of spend on unpaid ads was invisible. | The profit panel lists it under "needs attention". |
| Control Center month check said "Meta spend". | Says "Ad spend (actual)". |

### Social Studio

| Problem | Fix |
| --- | --- |
| The composer's "Auto-reply on this post" choice was stored but never used; only a rule's own scope decided. | That rule is evaluated first for comments on that post. |
| A comment arriving during a Meta pause or outage was claimed and never answered ("will resume automatically" was untrue). | Temporary failures keep the claim with a retry time; the scheduler retries with backoff for up to seven days. |
| A scheduled post hit by a temporary Meta problem became a permanent failure. | The worker keeps it scheduled and retries with backoff (5, 10, 20 … minutes, up to five attempts per save; a manual publish or an edit starts a fresh budget). The card shows the last error with a "Retrying automatically" label. |
| A "chosen posts" rule missed a post whose other page had failed (status `failed` even though this page was live), and only the newest 500 posts were scanned. | Both statuses are scanned. |
| "Once per person" was page-wide: a generic thank-you consumed the person's one price reply; a bare like counted as an answer. | Per rule; only a sent DM or public reply counts; pre-existing history rows keep their page-wide meaning. |
| Replies inside a thread (usually to our own auto-reply) got another auto-reply. | Nested replies are skipped. |
| Short Latin keywords matched inside other words ("hi" in "Benghazi"). | Three-letter-or-shorter Latin keywords need word boundaries; Arabic prefixes still match. |
| Editing a post after a failed detail load could save it without its photos. | The save omits the photo field when the photos were never loaded. |

### Clothes

| Problem | Fix |
| --- | --- |
| Editing a product while a colleague sold from it could silently restore the sold quantity: the form saved with whatever version live-sync had refreshed. | The form keeps the version it opened with; a concurrent sale now produces a conflict. |
| Order numbers were one global sequence across all businesses (a new shop's first order was numbered after other tenants' orders, revealing their volume). | The sequence follows what the user can see: staff with `clothesOrders.view` share one sequence; a subscriber with view-own numbering starts at 1 and never sees other tenants' volume. |
| Changing an order's payment status required product-edit permission on every product in it. | Payment changes need no product permission. |
| Overpayment was accepted in local mode and rejected by the server with a raw message. | Validated before saving, bilingual. |

### Deliveries (driver flow)

| Problem | Fix |
| --- | --- |
| A duplicate final receipt number trapped the driver in a "receipt changed, tap again" loop: every 409 was treated as a version conflict. | Only real version conflicts are rebased; a used number shows "Receipt number already used". |
| A staff member with `receipts.edit` could reopen a Delivered or Canceled job or move it backwards, with no validation. | A finished job cannot be handed back to a driver and an accepted job cannot go back to "Needs Delivery"; office edits that end the workflow (paid in office, refund, cancel, "Delete mission") stay allowed. |
| When the office canceled or reassigned a job while the driver's form was open, the driver saw a raw error and a dead form. | The app re-reads the job and closes the form with a clear message. |
| A dollar collected on a dollar debt was converted at today's default rate instead of the receipt's own rate, producing false over- or under-payment. | The receipt's rate seeds the conversion. |

### Also

- Control Center toasts and dialogs are bilingual.
- The customer-merge lock order (left open in round 2) was fixed earlier today.

## Still open for the owner (round 3)

1. Clothes: a product variant that was ever shipped or sold cannot be renamed
   and such a product cannot be deleted (the server refuses); the client text
   promises otherwise. Needs a rename operation.
2. Clothes: cancel/return records no refund, so "money collected" drops by the
   full paid amount whether or not money was returned.
3. Deliveries: "Delete mission" and some dropdown moves are refused for staff
   holding only `deliveries.assign`; the overpay cap is only known server-side;
   deleting a driver leaves their in-progress jobs assigned to a ghost.
4. Social Studio: captions and replies lose `<` and `>` (the write-time
   sanitiser strips them everywhere); Instagram requires JPEG and specific
   aspect ratios, which the composer does not enforce; partial publishing
   success is shown as total failure.
5. Analytics: users with view-own scopes see partial totals presented as
   business totals; paused paid ads count $0 revenue while the profit panel
   counts their spend.
6. Round-2 items still open: startup repair passes on every boot, backup-now
   inside the request, hash-locked Python dependencies, no idle session
   timeout, finished ads never leave the Meta sync queue.

## Review of the round-3 fixes (same day)

An adversarial reviewer read the round-3 diff before release and found eleven
problems in the fixes themselves; all are corrected in the released build.

| Reviewer finding | Correction |
| --- | --- |
| The staff `receipts.edit` state machine was too strict: it blocked normal office edits (marking an In Progress job paid in the office, refunding a Delivered job, "Delete mission"). | Only re-opening a finished job (Delivered/Canceled → Needs Delivery/In Progress) and moving an accepted job backwards (In Progress → Needs Delivery) are refused. |
| The driver's completion form treated any 400 as "reassigned" for admins, because an admin is never the assigned driver. | An admin counts as the job's owner; only a real driver can be reassigned away. |
| Per-creator order numbers split one shop's Admin and Employee into two sequences in the same list. | The sequence follows visibility (see the Clothes table above). |
| Timezone re-bucketing (UTC → Africa/Tripoli) can move a record written between 22:00 and 00:00 UTC on the last day of a month into the next month. **One-time effect on existing data:** a closed month's membership may differ from the snapshot taken at closing time; the snapshot itself is unchanged. Owners who closed months before this release should treat the stored snapshot as the record. | Documented; no automatic rewrite of closed snapshots. |
| Reply retries stopped after five attempts (about eight hours), not the promised seven days. | No attempt cap; the delay is capped at four hours and the pass gives up after seven days. |
| A post's `publishAttempts` never reset, so a post that once exhausted its retries could never be retried by the scheduler again. | Every save and every manual publish resets the budget. |
| `spentUSD: null` was "no recorded spend" on the server but "spent 0" on the screen. | The server mirrors the client (a stored null/empty value is 0). |
| The home hero's ad spend depended on whether the lazy profit bundle had loaded. | A startup-bundle twin (`getAdActualSpendUSDLite`) with the same precedence is used always. |
| A reply parked for retry did not count as "answered" for once-per-person, so a second rule could answer the same person while the first was waiting. | Parked rows count as answered. |
| A rescheduled post hid the reason it moved. | The card shows the last error with a "Retrying automatically" label. |
| The reply retry pass scanned the log on every 20-second tick. | Every sixth tick (about two minutes). |

A second pass over these corrections found four more, also fixed: an empty or
misspelled `deliveryStatus` could slip past the reopen guard (now only the
listed moves are accepted for finished or accepted jobs); an office edit of a
driver-canceled receipt silently re-queued it for delivery (the form now keeps
"Canceled" like it keeps "Delivered"); a reply whose seven-day window had
passed stayed parked forever and counted as "answered" (now released with
"Reply window expired"); a non-numeric recorded spend froze a finished ad at
$0 on the server while the screen used the Meta reading.

Known limits, on purpose:

- The reopen guard stops the one-step mistake. A staff editor can still move a
  finished job to Office and then send it for delivery again; the deliberate
  refund route (`/api/receipts/{id}/unsettle`) also creates a real pending
  delivery. Both are office decisions, not driver ones.
- Clothes order numbers are unique within a business. The platform admin's
  list shows every business, so the same number can appear twice there from
  two different businesses.


---

# Round 4 (same day)

Four hunters on lenses not yet covered: money movement in the services wallet
and campaign captures, data durability (backup / restore / import), offline
and live-sync conflict handling, and a full sweep of uploads, media and every
HTML sink in the frontend. Backend findings come with permanent tests in
`server/test_deep_scan_round4.py`; frontend fixes have static guards in
`scripts/test-mobile-ui.js`.

## Fixed

### Wallet and campaign money

| Problem | Fix |
| --- | --- |
| A capture left behind by an approval that crashed half-way had a recovery door only while the campaign was still Submitted. Once the campaign was Rejected or Changes Requested, archiving it stranded the customer's money with the system, and resubmitting charged the customer a second time on the next approval (proven with a scratch test: $50 wallet ended at $25). | Archiving any non-Approved campaign returns an open capture; resubmitting returns the previous cycle's capture before the new hold; a capture already refunded by a stop is never released again; every such release is audited. |
| The LYD payment instruction was computed with floating-point ceil: a $1.00 charge at rate 4.9 asked for 4.91 LYD. | Integer arithmetic on the server and the same on the client preview (`lyd_minor_for`). |

### Data durability

| Problem | Fix |
| --- | --- |
| The plan catalog (what customers are charged) could be replaced through the raw admin restore route or a generic PATCH of the live catalog record, skipping the catalog endpoint's immutability, version and audit rules. | Both paths answer 405 and point to the catalog endpoint. |
| A per-record restore refused any record created by staff who had since left (400), while the bulk importer accepted them. | Restore keeps history attributed to deleted staff, like the importer. |
| A backup containing company-coverage fields was refused with a message blaming the server version ("update the server first"). | The refusal names the real reason (the online importer cannot restore coverage fields; use the encrypted database backup) and the client shows it. |

### Live sync and conflicts

| Problem | Fix |
| --- | --- |
| Customer, page, shipment and campaign edit forms saved against the version live-sync had installed in the meantime, not the version the form opened with, so a colleague's change in those three seconds was silently overwritten (receipts and products already did this right). | Each form saves with its open-time version; a concurrent change now conflicts. |
| Navigating to another screen aborted in-flight writes, and the retry re-sent them: a committed delete came back as "Failed to delete" with the record reappearing, and a committed save as a false "changed by another user". | Navigation aborts reads only; a delete answered "not found" counts as done. |
| The local tombstone of a deleted record kept the device's clock time as its version, so on a fast clock a later restore from another device was ignored. | The server's delete answer carries the tombstone stamp and the client adopts it (generic collections included). |
| A catch-up delta of more than about 65,000 records threw inside the sync tick (argument-list limit), leaving "Sync failed" every three seconds. | Records are inserted in chunks. |

## Verified sound (no change)

- Uploads and media: every stored image path validates format, size and
  pixel count before decoding; served media is raster-only with `nosniff`;
  signed URLs, rate limits and ownership checks hold; Meta image archival is
  SSRF-guarded.
- XSS: every `innerHTML`/`insertAdjacentHTML` sink and every interpolated
  handler in `src/` was enumerated; all user-controlled text is escaped at
  render and stripped of angle brackets at write time; URLs go through
  `safeUrl` or an https/wa.me allow-list.
- Wallet: idempotency keys, holds, replays, admin-only operations and
  server-side paywall enforcement for `clothes_system` and `ad_maker` hold.
- Backups: encrypted per-record backups, retention, the full NDJSON snapshot,
  month-close locking and CSV formula escaping hold.

## Still open for the owner (round 4)

1. **Permissions are saved as a whole map.** Two admins editing the same
   user's permissions within a minute overwrite each other; a revoke can be
   undone silently. Fix: send grant/revoke deltas, or a version check on the
   user row (server + client change).
2. **Admin "subscribe another user" debits that user's wallet**, not the
   admin's. Decide whether that is the intended meaning and label it.
3. The global `adCampaignRequests.stop` grant behaves like a customer stop
   (full refund only, refused after launch); the grant text promises more.
4. The online importer cannot restore backups that contain company-coverage
   fields (by design, pinned by a test) and refuses while any month is closed.
   The encrypted database backup is the restore path.
5. The local-mode daily device backup is written but nothing restores it; the
   owner's NDJSON snapshot has no restore script either (data copy only).
6. Small photos and GIFs keep their EXIF/GPS data (large ones are
   re-encoded); generic `photos` fields are not decoded server-side (served
   only as raster, so not exploitable).
7. Mutation echoes are installed without a "not older" check, and an ad
   create that times out twice can duplicate if the user edits before
   retrying (rare; both self-heal within the sync overlap).
8. Self-stop "not started yet" uses the UTC day, not the Libya day.

## Review of the round-4 fixes (same day)

An adversarial pass over the round-4 diff found five problems in the fixes,
all corrected before release: the widened archive-time release would have
refunded a **Stopped** campaign whose budget was fully spent (a stop with
refund 0 writes no refund marker) - Stopped cycles are now excluded; the
campaign editor kept its open-time version after a successful save, so a
second save or Submit in the same session would always report "changed by
another user" - the version now follows every save and is cleared with the
editor; the server rounded the exchange rate half-to-even while the client
rounds half-up (5-decimal rates ending in 5 disagreed by one) - the server now
rounds like the client; the restore guard looked only at the incoming
`settingKey`, so the live plan-catalog row could still be overwritten by id -
it now checks the row being replaced too; a test cleaned up its forged catalog
row only on success. Minor and left as is: the catalog guard on generic PATCH
runs before the permission gate, so an authenticated user could learn that a
guessed appSettings id is the catalog row (same class as the existing Meta
field guards).
