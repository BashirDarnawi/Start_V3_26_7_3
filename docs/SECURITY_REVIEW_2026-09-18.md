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


---

# Round 5 (same day)

Four hunters on the session lifecycle, the native app surface, receipt
money-state sequences, and resource exhaustion plus log privacy. Backend
findings come with permanent tests in `server/test_deep_scan_round5.py` and
`server/test_deep_scan_round5_money.py`; frontend fixes have static guards.

## Fixed

### Receipt money (conservation)

| Problem | Fix |
| --- | --- |
| Marking a receipt "Delivered" without the driver's completion form (paid in office, goods handed over) ran the delivery-completion maths with "collected = 0" and turned a Paid $100 receipt into an unpaid, zeroed one; the settle route did the same for a Not Paid office receipt collected in the office. | The completion maths runs only when a verified completion supplies the collected amount, and never re-derives a receipt that is already paid. |
| Deleting a canceled receipt stripped the company's funding rows from its ad: the ad forgot the money the company had spent, and the "cover" button offered the same amount again. | The released company money moves to the ad's direct-coverage bucket, so the ad's funded total is unchanged and nothing is offered twice. |
| A company-covered ad whose receipt was canceled could not record its real spend (the coverage alone capped it). | The cap applies only while a live customer pool backs the ad. |
| Canceling or deleting a receipt silently rewrote linked ads that live in a closed month. | Those cascades assert the ad's month is open (423 like every other closed-month edit). |

### Resource exhaustion and log privacy

| Problem | Fix |
| --- | --- |
| Any caller, signed in or not, could send a 10 MB JSON body that the server fully parsed before checking the session (150 MB of objects per request; a handful in parallel could exhaust the container). | Without a session cookie, an API write body over 256 KB is refused before it is read (every sign-in-free route sends a small body; the Meta webhook is exempt). |
| Validation errors echoed the offending input, including a password sent in the wrong shape. | The 422 body carries only the field location, message and type. |
| A receipts viewer could ask for every receipt with all photos in one request (hundreds of megabytes; pins the whole connection pool). | Receipt listings with media of more than 25 rows are throttled to 30 per minute per user (a refusal would break older clients; the app hydrates photos by id anyway). |
| The phone-collision check on every customer write loaded every customer's whole record. | It reads only the three phone fields. |
| A user could hammer the full-reload endpoint. | Throttled to 30 per minute per user. |
| Startup and backup error logs could carry bound SQL parameters (password hashes, receipt JSON). | Every such message goes through the parameter-redacting formatter. |

### Sessions and the native app

| Problem | Fix |
| --- | --- |
| Signing the app in through the phone's browser left a second, fully valid (up to 30-day) session in that browser, outside the app's lock. | The fresh-login handoff caps the browser tab's own session to ten minutes; the "continue to the app" path for an existing session is unchanged. |
| Plain `http://localhost` was a trusted, credentialed origin in production (any local process could call the API with a signed-in user's cookie). | Removed; `capacitor://localhost` and `https://localhost` stay for the packaged app. |
| The app lock accepted weak-class biometrics (photo-spoofable face unlock on some phones). | Strong biometrics only; the device PIN fallback stays. |
| Any page or app could open the sign-in deep link with a wrong state and cancel a real pending sign-in. | A non-matching link is ignored; the pending request survives. |
| The origin check passed any Origin when the Host header was missing (non-browser bypass). | Missing Host is refused. |
| The logout / password-change cookie deletion lacked the live cookie's attributes, so the app's WebView kept a dead cookie. | Deleted with matching attributes. |

## Verified sound (no change)

- Sessions: password change, admin reset, reset-by-token, deletion and
  anonymisation revoke every session and pending code in one transaction;
  role and permission changes apply on the next request; reset tokens are
  256-bit, hashed, single-use, 15 minutes; no session-bearing query tokens;
  every cookie-authenticated mutation checks the origin; CORS is an explicit
  list.
- Native: no cleartext traffic, no exported components beyond the launcher,
  the deep-link handler never navigates the WebView, PKCE binds the one-time
  code, secrets are not in the bundle, sessions never touch JS storage, the
  lock overlay paints before any data.
- Money: transfers, settle replays, deletes of funding receipts, refunds
  across two receipts, merges during transfers, lock ordering and rounding
  all conserve money; server invariants match the client's test-money rules.
- Logs: the access log carries no query strings, emails or phones; Meta
  tokens never reach logs or responses; the webhook verifies its signature
  before any work; workers survive a poisoned record.

## Still open for the owner (round 5)

1. Sessions are static bearer tokens: never rotated, no per-user cap, and a
   new login leaves older sessions alive (no "sign out other devices" yet).
2. The app sign-in return link is a custom scheme (`albayan://auth`); a
   verified App Link / Universal Link would stop impostor apps from
   intercepting it (the code is useless without the verifier, so the risk is
   a cancelled sign-in, not a stolen session).
3. Set `ALBAYAN_COOKIE_SECURE=true` on the app node so the cookie's Secure
   flag never depends on a forwarded-proto header.
4. Failed logins are not audited; the login-timing equaliser uses the default
   work factor (legacy-hash accounts answer slightly faster).
5. Every receipt or ad money write still scans the whole ads collection under
   lock (bounded variant exists); an authenticated user can keep the pool
   busy with large but legal listings.
6. The driver's completion form on a receipt already paid in the office, with
   nothing collected, still records it as unpaid and zeroed (pre-existing; the
   form pre-computes the money before the server's guard).
7. First-run setup can be reopened when every account has been soft-deleted
   and the setup token is known (kept so a wiped office can recover).

## Review of the round-5 fixes (same day)

The adversarial pass found: the narrowed phone-collision scan crashed on a
legacy scalar `phones` value (fixed: non-JSON text stays a candidate); the
coverage settlement pass assumed the delivery pass had run whenever a receipt
turned Delivered, so an office "paid + delivered" on a company-covered
receipt would have settled gross (fixed: the two passes share one gate); the
receipts-with-media refusal broke thirteen existing tests and would have
broken older clients (changed to a per-user throttle before release); the
setup-admin count change contradicted login and needs-setup (reverted).


---

# Round 6 (same day)

Four hunters on lenses that are about correctness and operations rather than
attackers: how production can fail or lose data, the accuracy of reports and
exports, how lists, search and reminders behave, and client-side date, number
and language logic. Backend fixes come with tests in
`server/test_deep_scan_round6_ops.py`; frontend fixes have static guards.

## Fixed

### Deployment and operations

| Problem | Fix |
| --- | --- |
| A container that lost its `DATABASE_URL` (a variable edit on the platform) started on an empty SQLite file inside the container, looked healthy and offered the first-run admin screen; a day of records entered there died with the next redeploy. | Production refuses to start on SQLite (`ALBAYAN_ALLOW_SQLITE=true` or debug mode opts in; every test runner sets it). The image no longer ships a SQLite default path, and `/var/lib/albayan` is a declared volume. |
| The container health probe used the readiness route, which needs a worker thread and a pooled database connection; under a morning burst the probe starved and the platform could restart a merely busy container, killing in-flight money writes. | The probe uses the async, database-free liveness route; the startup grace period is honest (120 s) about index and backfill work on big tables. |
| Boot-time index creation took table locks with no timeout: an idle-in-transaction session could stall the boot forever, and every write waited during a full scan. Two keyset-pagination indexes existed only in an alembic migration that never runs on the platform. | Each index statement runs with a 5 s lock timeout and a statement timeout (skip, retry next boot); the two keyset indexes are created idempotently at boot. |
| Shutdown closed the database pool before stopping the three worker threads, and the worker joins plus the request drain exceeded Docker's 10 s kill budget; a redeploy during a backup could leave a partial temp file forever. | Workers stop first, joins are capped (1 + 1 + 2 s) with a 5 s drain; leftover temp files older than an hour are swept. |
| The plaintext database dump was written to the container's writable layer (a second, smaller filesystem), and retention ran only after a successful backup, so a full disk failed every day the same way. | The dump is written next to its target on the volume; old backups are pruned before the dump. |
| Every health probe and polling request printed an access-log line; a wrong non-numeric environment value (a trailing space) crashed the boot; Postgres connections had no connect timeout or keepalives; the release script would push an image built from uncommitted changes. | Probe lines are dropped; integer settings log and fall back; Postgres connects with a 5 s timeout and TCP keepalives; the release script refuses a dirty tree unless `--allow-dirty` is passed. A boot summary line prints the effective configuration. |

### Reports and exports

| Problem | Fix |
| --- | --- |
| The analytics screen counted canceled and lost receipts as volume and as "collected", while the month-close excluded them; its paid/pending split read the raw status text and missed legacy rows. | Analytics uses the same payment-state vocabulary as the month-close. |
| A "carried balance" (a customer's pre-tracking credit) counted as money collected this month on the home hero and in the closed month. | Excluded from collected and volume totals (still part of the customer's balance). |
| The local backup round trip dropped the dollar-purchase ledger, so a restore priced every ad's spend as "unknown"; deleted purchases leaked into a visible-only export. | The ledger is exported and restored (a pre-feature backup keeps the device's ledger). |
| The delivery report CSV disagreed with the deliveries screen for canceled and null-collected rows, and international phone numbers exported with a visible apostrophe. | The CSV uses the screen's own cash rules; a leading `+` is written as `00`. |
| The audit CSV omitted the metadata column (where money entries carry amounts); the Control Center's last-backup time ignored the app locale. | Both fixed. |
| The receipts list called rolling 7- and 30-day windows "This Week" and "This Month" while the hero and analytics use calendar months. | Relabelled "Last 7 days" / "Last 30 days" (the window itself is unchanged, pending the owner's choice). |

### Lists, search, reminders

| Problem | Fix |
| --- | --- |
| Opening the app between midnight and 09:00 on a reminder day cancelled that day's native reconciliation reminder (the candidate filter compared midnight, not 09:00). | The 09:00 moment is compared. |
| Receipts, ads and deliveries search compared phone text only: `0912345678` did not find `+218 91 234 5678`; a phone stored as an object matched nothing; the `#1234` shown on cards did not match. | Phone digits are compared canonically; `#` is stripped. |
| The phone canonicaliser missed the `0218…` spelling and every landline, so duplicates slipped through and WhatsApp links pointed at `wa.me/0…`; a number that cannot be dialled still stamped the customer as reminded. | Both spellings fold to the international form; an undialable number produces no link. |
| The Collect view counted receipt age in 24-hour buckets, so "overdue" and "days" were off by one around midnight. | Calendar days. |
| The ads status filter could not select "Active", the state every ad starts in; customers without a join date sorted unstably. | "Active" is a filter option (empty status counts as Active); the sort uses the creation stamp. |

### Client logic

| Problem | Fix |
| --- | --- |
| Meta-imported ads store full UTC timestamps; the edit form and the reconciliation day read the UTC day, so completing an imported draft in the office shifted its start and end one day early. | The form shows the local calendar day and a timestamp is never read as its UTC day. |
| The funding-receipt picker's sort mixed numeric and non-numeric serials in an order-dependent comparator, so its order changed with live sync. | Newest first, numeric tail as tiebreak. |
| Arabic mode: an "invalid record" toast and the analytics period labels were English; Arabic WhatsApp text ended an RTL line with a stray `)`; two admin prompts rejected Arabic digits; the page duplicate guard missed Arabic spelling variants; the liquidity start date was stored as UTC midnight; a null recorded spend could blank the ads page. | All fixed. |

## Still open for the owner (round 6)

1. The company-funds dialog and its toasts are English-only (a full translation
   does not fit the startup bundle budget; needs lazy-loading first).
2. Receipts "Last 7 / 30 days" versus calendar periods: decide which the office
   wants; the labels are now honest either way.
3. The delivery report CSV exports every delivery, not the filtered list on
   screen; a job assigned to a user who is no longer a driver looks unassigned
   but is not counted as such.
4. Encrypted backups carry no key fingerprint and are never restore-verified
   automatically; the NDJSON snapshot has no restore script.
5. Alembic migrations still have no path to the platform (boot creates the
   known indexes idempotently); CI never boots the image against PostgreSQL.
6. Every money write scans the whole ads collection under lock (bounded
   variant exists); backups are attributed to no key version.

## Review of the round-6 fixes (same day)

The adversarial pass found: the SQLite refusal ran after the database
initialisation, so a container without `DATABASE_URL` would have died in a
misleading "database not ready" retry loop instead of printing the refusal
(fixed: the check runs first, on the resolved URL, and resolving the default
path never raises); the client's new phone spellings (`0218…`, landlines) were
not mirrored by the server's identity key, so the two would have disagreed
about duplicates and merges (fixed: same rules on both sides, tested); the
app's own date encoding (`T00:00:00.000Z`) would have drifted one day per
save in browsers west of UTC (fixed: only real timestamps take the local-day
path); the CSV phone `00218…` would have lost its leading zeros in Excel
(fixed: a space after the country code keeps it text); a carried balance that
is still unpaid no longer slipped past the month-close blocker (fixed: only
the sale totals exclude it); two integer settings the regex missed; a
tautological test assertion; documentation that still promised a silent
SQLite fallback; the index-build timeout now fits inside the probe's grace.


---

# Round 7 (same day)

Four hunters: a clothes shop's normal day end to end, the mapping between
what Meta reports and what the app stores, an audit of the test suite itself,
and client performance at office scale. Backend fixes come with tests in
`server/test_deep_scan_round7.py`.

## Fixed

### Clothes, day to day

| Problem | Fix |
| --- | --- |
| A product sold without colour or size (bags, one-size items) owns an "unspecified" variant; the product form dropped that empty-looking row once it sold out, so every later edit (even a price change) was refused with a message about variants the user never created. | The form keeps the unspecified variant when the product already has it. |
| Adding a piece to an order already marked Paid re-stamped the whole new total as collected, so the dashboard showed money never received. | Server and form downgrade to Partially Paid with the recorded amount; the extra is still to collect. |
| An order whose product (or variant) had been deleted could never be canceled, returned, edited or deleted, though the delete dialog promised exactly that. | Missing products and variants restore nothing; a local-mode oversell that never took stock restores nothing either. |
| Moving a Delivered order back kept its delivery stamp, so a later real delivery was reported in the wrong month. | Leaving Delivered clears the stamp; the re-delivery stamps afresh. |
| A phone-number fix on an order rewrote every product in it, so a colleague's open product form hit a version conflict for nothing. | Only products whose stock actually changed are written. |
| The payment dropdown's "Partially Paid" kept the full amount; removing a variant that still held stock was silent; stock refusals showed a raw product id in English; orders could not be found by their number; a canceled or returned slip printed like a live one. | The dropdown asks for the amount (server validates it); removal with stock asks first; refusals name the product in the user's language; `#0042` or `42` finds the order; inactive slips carry a CANCELED / RETURNED stamp. |

### Meta mapping

| Problem | Fix |
| --- | --- |
| A new ad added to an old ad set inherited the set's start date; when that month was closed the import failed silently on every pass and the ad never appeared. | An ad never starts before it was created. |
| A first link whose insights read was throttled stored "$0 spent, synced now" as if healthy. | Unreadable insights are never stored as zero, first link included. |
| The priority media-repair lane retried one failing fresh draft every 20 seconds and left every older draft "loading" indefinitely. | Any failed repair (except a throttle) consumes its single priority try; retries follow the normal backoff. |
| Two live rows linked to one Meta ad were retried first on every pass, silently, starving the queue; "Import existing ads" re-created drafts the office had deleted; Graph error 100 ("invalid parameter") was treated as a permanent "ad not found". | The duplicate is parked with a clear reason; deleted drafts stay deleted; only subcode 33 / 803 / 404 mean not found. |
| The profit panel dated active Meta spend by a field the server never writes; the Control Center counted informational sync states as failures. | It reads the real sync stamp; informational states are not counted. |

### The safety net itself

| Problem | Fix |
| --- | --- |
| Six core one-pot money invariants in the money suite were labelled "known broken" and could never fail the build, although they all pass. | Promoted to must-pass. |
| One test module discarded the suite's shared in-memory database at teardown, so ten later modules ran on an empty database and passed only by file order. | It restores the previous engine. |
| A tautological assertion, two "either outcome" assertions, an untested admin route that creates ads, a runner that treated a signal-killed pytest as "no Python here", and hidden collection warnings. | Pinned, tested, failed properly, and surfaced. |

### Performance at office scale (measured at 3,000 ads / 5,000 receipts / 2,000 customers)

| Problem | Fix |
| --- | --- |
| The analytics screen (the landing page for staff with analytics access) rescanned every ad for every paid receipt, twice: about 20 seconds per render on a desktop, repeated on every changed sync tick. | Both loops use the existing receipt-usage index (milliseconds). |
| Customer totals (customers header, home hero, Collect view) rescanned all ads for zero-amount delivery receipts; the deliveries screen did the same per row. | The customer-stats index and the deliveries pass carry the usage index. |
| The receipts sort parsed two dates per comparison (about 40 % of the render); the reconciliation screen rendered every finished ad ever with a customer and page lookup per card; every save wrote the server-owned audit log into the local snapshot; every replayed sync row was sanitised before its version was checked. | Dates are parsed once; reconciliation uses maps and shows 150 cards; the audit log is refetched, not persisted; replayed rows are dropped first. |

## Still open for the owner (round 7)

1. A shared ad-set or campaign budget is copied to every ad in it, so two
   ads under one $100 ad set lock $200 of customer debt. Needs a "shared
   budget" rule (divide, or leave manual with a warning).
2. Subscription expiry hides orders already out for delivery (reads are
   gated like writes; campaigns keep reads open). Decide whether reads stay
   available after expiry.
3. A blank Meta account currency is counted as dollars in totals; open-ended
   imports get an end date equal to the start; Meta-deleted ads keep syncing
   and still count as sales; the media-archive lane re-downloads closed-month
   rows every pass.
4. Tests: PostgreSQL-only modules never run in the release gate; the e2e
   suite drives no money journey; several money guards are source-string
   pins; the startup path is never exercised by a test.
5. Performance, structural: every changed 3-second tick rebuilds and swaps the
   whole current view; IndexedDB writes whole collections per edit and
   checksums them on every save and load; the startup bundle carries the
   forms and modals (a lazy bundle would cut first paint); the users view is
   unpaginated.

## Review of the round-7 fixes (same day)

The adversarial pass found: the product form's new unspecified-variant check
read a variable before it was declared, so every product save would have
thrown (fixed; the e2e suite does not save a product, which is now on the
list of missing journeys); a live product whose variant had been renamed or
removed would have lost the pieces an order held (fixed: they come back under
the original name); a relink whose insights were throttled would have
inherited the previous Meta ad's money (fixed); a cancelled partial-payment
prompt left the dropdown showing an unsaved status (fixed); the Paid-order
downgrade now keys on the order growing, not on the recorded amount; a dead
condition in the media-repair stamp was simplified; the auto-import test now
proves the admin gate.


---

# Round 8 (same day)

Four agents: Social Studio publishing and media end to end, the Ads Studio
campaign lifecycle from both chairs, a client/server permission drift and
message-honesty sweep, and an author for Playwright money journeys. Backend
fixes come with tests in `server/test_deep_scan_round8.py`.

## Fixed

### Social Studio publishing

| Problem | Fix |
| --- | --- |
| A post claimed as "publishing" when the server restarted or hit an error mid-publish stayed that way forever: no buttons, every edit refused. | Claims carry a timestamp; claims older than 15 minutes are released as failed with a clear message; any server error inside a publish marks the post failed before re-raising. |
| An ambiguous timeout on the final create call (Facebook feed, Instagram publish, replies, DMs) was retried as a fresh call, so Meta could receive the post or reply twice. | Timeouts on content-creating calls are not retried blindly; the post asks a human to check the page. |
| Editing and republishing a partially published post silently diverged the live Facebook post from the record; unticking a live page dropped its post id and re-ticking posted again; delete claimed "deleted" while the live post stayed on Meta. | Text and photos of a post with a live page cannot be edited from here; an unticked live page keeps its id (marked removed); delete says the live post stays on Meta. |
| The reply retry pass ignored the owner's master switch and the rule's quiet hours. | Both are honoured; parked replies wait. |
| Every Meta rejection reached the customer as ad-sync wording; "Publish now" gave up after 20 seconds while the server kept publishing. | Meta's own rejection text (Instagram format and aspect rules) is shown; the publish call waits up to 120 seconds. |

### Ads Studio lifecycle

| Problem | Fix |
| --- | --- |
| A reviewer could create, submit, approve and launch their own campaign. | Nobody reviews their own campaign (admins excepted). |
| The approve dialog, the queue header and the wizard said no money moves; approval captures the held budget. | The words match the money. |
| A start date that passed while the request waited made approval impossible (400) until the customer re-dated and resubmitted. | It starts on approval day. |
| A second tap after a lost reply on submit or review was reported as a failure though the first tap had landed. | Both reconcile with the server's current state, like stop and launch already did. |
| Soft-deleting a customer with campaigns under review or approved trapped captured money in a wallet nobody could use; a stopped campaign still showed "live"; the wizard accepted more targeting items than the server. | Deletion is refused while campaigns are open; stop clears the live flag; the caps match. |

### Permissions and messages

| Problem | Fix |
| --- | --- |
| Every permission refusal was shown as "Server Error" with raw English text. | "Not allowed" in both languages. |
| The duplicate-record and user-deleted toasts were English only; the edit-user form offered a password field to editors who cannot set passwords; a driver granted page viewing could list pages but not open one; a bundle error named the file on disk. | All fixed. |

## Still open for the owner (round 8)

1. Social Studio: one customer's page-level Meta throttle pauses publishing for every customer; a scheduled time cannot be edited within a minute of its slot; Instagram publishing does not poll container status; the platform token failing turns into customer-facing permanent failures.
2. Ads Studio: no customer-side withdrawal of a Submitted campaign (the hold is open-ended); staff user ids are returned to customers in review fields; a photo picked while "Save draft" is finishing can be dropped silently.
3. Permission drift (documented by the sweep, not yet changed): the deliveries assign grant's Cancel and Delete-mission buttons send fields the server only accepts with receipt editing; the "mark collected" grant and button do not match; driver-role toggles for accept/complete are not enforced; several offered grants are checked nowhere; the role dropdown ignores the change-role grant.
4. Messages: driver-facing refusals and the company-funds dialog remain English-only; internal ids still appear in a few server messages.
5. Playwright money journeys (`tests/e2e/money-journeys.spec.js`: driver completion, settle/unsettle, transfer, company coverage, month close and unlock, Clothes stock, wallet plan purchase) are in the suite and green.

## Review of the round-8 fixes (same day)

The adversarial pass found: the edit-user form referenced a variable that
did not exist (every Edit User dialog would have failed to render) - fixed;
the "ambiguous timeout" rule covered every transport failure, so a
connection blip at the scheduled minute would have failed a post for good -
now only a timeout after the request was sent is ambiguous (posts and
replies); the edit guard on partially published posts keyed on field
presence, which the composer always sends - it now keys on an actual text or
photo change; the delete toast mentioned Meta for never-published drafts;
the generic "Not allowed" hid the server's specific refusal reasons; a server
error mid-publish could lose the page ids already obtained (duplicate on
retry) - they now travel with the interruption; a re-ticked page carried a
stale "removed" flag; the review queue still offered a reviewer their own
campaign.


## Round 9 (2026-09-18, evening): audit trail, operations, holistic review, permission drift

Four more agents: an ops/audit hunter, a holistic reviewer over the whole day's diff (rounds 1-8 together), a test-suite cross-module reviewer, and a permission-drift fixer working in its own worktree. Tests: `server/test_deep_scan_round9.py` (14) and `server/test_permission_drift_fixes.py` (10); 8 new checks in `scripts/test-permissions.js`.

### Fixed

**Audit trail**
- Company-funds coverage (receipt and customer routes) now writes an audit row inside the money transaction, with the amount, the reason and the ad ids. Before, the only trace was the coverage record itself.
- Audit cleanup keeps 365 days and 500,000 rows (the UI says "keeps last 1 year"; the old defaults were 90 days / 100,000). Month close/unlock, imports, restores, company money, wallet releases and campaign reviews are never auto-deleted. The cleanup writes its own audit row saying what it removed.
- Wallet transfer/top-up/reversal rows carry the amount, currency and counterparties; receipt deletes carry the amounts and customer; campaign reviews carry the wallet transaction and budget.
- A re-closed month keeps every previous close's snapshot in its history (before, only the latest snapshot survived).
- Client: "Export" and the device backup page the whole trail from the server instead of the 500 rows on screen; the category filter (auth/data/financial/general) now matches real categories; the "Restore" button is hidden in server mode (the server trail cannot be replaced from a file).

**Operations**
- Backup pruning keeps the newest three files whatever their age, so a week of failed dumps can never empty the directory. An overdue backup (more than two intervals late) is a setup task. The pre-dump sweep runs inside the backup lease so it can never delete a running dump's temp directory.
- Control Center uses the rolling error rate (not since-boot) and lists ads linked to the same Meta ad as their own "unlink" task instead of counting them as sync failures.

**Holistic-review corrections**
- The boot composite index now uses the same 5 s lock timeout as the other boot DDL. Before, one idle-in-transaction session (pgAdmin left open, the old container draining) could hold the new container's boot and every write forever.
- Worker stop functions are single-shot. The app shutdown hook stopped the workers and the routers' own hooks then joined the same threads again, which could exceed Docker's 10 s SIGKILL budget during a backup. `--limit-concurrency` is 128 and the liveness probe allows 6 retries, so a short burst does not restart a healthy container.
- A campaign whose start day is today, with no publish marker and no spend, counts as not started: approval bumps a passed start date to the approval day, and the customer could no longer self-stop with a full refund the same morning.
- A mixed edit (phone, notes...) from an older app build that re-derives deliveryStatus keeps a finished (Delivered/Canceled) job finished and saves the rest; a pure status move is still refused with 400.
- Deleting an account releases any capture left by a crashed approval on its Rejected/Changes-Requested campaigns (round 4 established the release; round 8's delete guard only counted Submitted/Approved).
- The online importer refuses the plan catalog row like PATCH/POST/restore already did.
- Receipts delta polls with media are not throttled (old app builds poll every 3 s; a delta carries few rows).
- The body-size gate takes the cookie name from the app instead of hardcoding it.
- The Arabic decimal point (U+066B) folds to a dot before the thousands/decimal decision, so "1،250٫50" is 1250.50 (before: 1.25).
- `tzdata` is pinned so the Libya business zone exists on every platform.

**Permission drift**
- Holders of `deliveries.assign` can Cancel and "Delete mission" (the two buttons the UI already showed them). The server writes the history entry itself and ignores forged history/actor/timestamps; the delivery workflow rules moved to `server/delivery_workflow.py`.
- The edit-user modal follows the server: the role select is enabled by `users.changeRole` (never on self-edit), the Admin option is disabled for non-admins, the detailed-permissions link follows `users.managePermissions`, and grants the editor does not hold are disabled with a toast before anything is written.

**Test hygiene (cross-module reviewer)**
- `conftest.py` resets the extra login buckets (two more source IPs and the fixed fixture emails); `test_setup_admin` disposes its file engine so Windows can delete the file; the two backfill tests heal other modules' rows first; the unfunded-scan tests tolerate the example caps; the third-sync test reads with a wide limit.

**Review of these fixes (same evening, 8 findings, all corrected)**
- The receipts media-listing throttle exempts only a recent delta poll (last 24 h); an "everything since time zero" delta is a full listing and stays throttled.
- The reopen-guard strip applies only when no other delivery field (driver, collection method, office handover) changes; an edit that re-points a canceled job at a driver is still refused with 400.
- The orphan release on account delete holds the SQLite wallet lock like every other money path (PostgreSQL uses its advisory lock).
- Single-shot worker stops keep a still-running thread known, so a later start cannot overlap two worker generations; a "stopped" flag replaces nulling the thread.
- Audit cleanup measures the by-limit count from the DELETE instead of assuming the excess, so kept actions never produce a false "cleanup" row.
- The start-day rule uses the Libya business day, not the UTC day.
- The unreadable-ads test measures its own row; the Control Center badge counts duplicate links and an overdue backup gets its own icon and advice instead of the "Jelastic setting" text.

### Verified sound (no change)
- Client/server money twins (`getReceiptPaymentState`, ad spend, phone key, LYD rounding) are identical; social publishing recovery, absent-field tolerance and the bundle/www parity all hold (holistic reviewer).
- The test-suite modules that now run against the shared database (after `test_setup_admin` stopped wiping it) use scoped assertions; the social autouse wipe fixture is the one load-bearing guard (documented).

### Still open for the owner
- `In Progress -> Office` ("Delete mission" on an accepted job) stays refused for assign-only holders (product decision).
- Old Capacitor builds cut the 120 s publish wait at 30 s (needs a new native build).
- Per-email login ceiling is not reset between test modules (no failure today).
- The test-suite reviewer's remaining medium items (wallet listings read without a limit, duplicate fixed phone numbers across two modules, the plan catalog left mutated by `test_subscription_plans`) are latent, not failing.
