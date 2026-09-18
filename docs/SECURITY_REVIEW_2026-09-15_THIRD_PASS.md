# Third review: responsiveness, consistent reads and sync safety

Review started September 15; final browser verification completed September 16,
2026 (Africa/Tripoli).

Scope: local, evidence-led improvements on top of the existing redesign and
two previous reviews. Existing business features and money formulas are kept.
No production data, migrations, financial repairs, Git release, Docker push or
deployment is part of this pass. This is not a claim that every possible bug
has been eliminated or that live performance is now guaranteed.

## Confirmed changes

### Consistent, cheaper local collection loading

`src/03-storage-idb.js` now reads collection metadata and data in one readonly
IndexedDB transaction. Previously a concurrent atomic save could replace chunks
between separate read transactions, yielding mixed generations, a false missing
chunk error, or `null` during a single-record/chunked-layout conversion.

Chunk requests run in batches of at most 32 inside request callbacks. This
keeps the transaction alive in Safari without synchronously enqueueing an
unbounded number of requests. Invalid chunk counts fail as corruption rather
than starting an unsafe load. Success is returned only when the transaction
completes. Existing incomplete-data protection, legacy single records, checksum
warning behavior, ordering and account-specific storage keys remain intact.
An old account's delayed corruption result cannot disable the new account's
saves.

Proof: the initial 18 real-browser cases produced 8 passes and 10 failures on
the original implementation. All 22 final cases pass in Chromium/WebKit,
including abort and malformed-metadata controls. A 101-chunk fixture uses **1
read transaction instead of 102**. This is a transaction-count improvement,
not a promised end-to-end startup time.

### Less repeated rendering work

`src/13-filters-helpers.js` memoizes customer totals only within the existing
synchronous render index, returning fresh result objects. A new render creates
a new index; action handlers without an index remain uncached. Filtering,
sorting, header totals and cards no longer repeat the same derived calculations.

Receipt cards in `src/12-views.js` reuse the existing linked-ad index for legacy
collection targets and pass that same computed target to company-coverage
eligibility. Money formulas and action-time validation do not change.

Deterministic fixture work counts:

- 200 ads: **1,600 to 400** spend evaluations through customer rendering.
- 24 legacy receipt cards, 1,024 ads: **73,728 to 24** candidate visits inside
  collection-target calculations; the existing one-pass index is still built.

Tests compare rendered HTML with the unoptimized path and cover old financial
formats, permissions, copied cache results, account changes, rate/amount edits,
transfers, relinking and deletions. These numbers describe particular code paths,
not the speed of the entire application.

### Fewer redundant saves and safer stopped sync work

`src/06-persistence.js` consumes a collection's pending dirty mark when that
collection's write begins. An edit already included in that write no longer
causes a duplicate save; edits arriving during a write still require another
durable save. The controlled reproduction drops from **3 writes to 2**.

`src/10-live-sync.js` fences queued delta pages, retries, collection fan-out and
poll completion by current session/poller identity. An old poll cannot clear a
replacement poll's running flag, replace its completion promise, or change its
health/backoff state. Canceled fan-out starts only the initial **4 of 14**
requests; no remaining queued requests are launched. Existing requests may
finish at the transport level, but cannot apply stale results. Normal paging,
error messages, bounded retry/backoff and deletion rules remain covered.

### Correct, lighter server reads

`server/main.py` uses a bound, uncorrelated referenced-customer membership
subquery for delivery list/watermark reads and bootstrap. Bootstrap no longer
reloads full assigned ad/receipt bodies or truncates referenced customer IDs at
1,000. A 1,005-customer legacy fixture returns all assigned customers in two
customer-page queries. A small fixture needs one query instead of three.
SQL query-plan checks verify the SQLite membership scan is not correlated.
Other drivers' data, deleted assignments and unreferenced customers remain
excluded. PostgreSQL execution still requires the isolated CI environment.

Campaign delta projection now preserves an owner's own private drafts and
revisions using authoritative creator identity. Other reviewers still receive
redacted removal markers when campaigns become private; true deletions and
tied-version pagination remain protected. Tests verify stored JSON, timestamps,
creation attribution and extension fields remain unchanged by reads.

Read-compatibility version is now 2. Important limitation: an older client
cache may already contain a false deletion marker for an owner's campaign.
Strict equal-version deletion protection cannot safely distinguish that marker
from a real deletion. Such a session needs the normal **Sync/full reload once**
to recover the unchanged active campaign. The new server prevents recurrence;
no code weakens general deletion protection or guesses financial data.

## Regression automation

- `scripts/test-indexeddb-snapshot.js`: 22 real IndexedDB cases, run by
  `npm run test:e2e` before application-browser scenarios.
- `scripts/test-render-performance.js`: 12 behavior/work-count checks.
- `scripts/test-sync-persistence-work.js`: 17 lifecycle/durability checks.
- `server/test_third_sync_review.py`: 16 scoped-read, legacy-data and cursor
  regressions, discovered by the regular backend suite.
- The render and sync/persistence scripts are included in `npm test` and CI.
  The pre-existing mobile structural test now also requires the new cancellation
  guard; its bounded concurrency and failure-label requirements remain intact.

## Integrated verification

`npm test` passed all configured frontend checks and the full backend suite:
**1,229 passed, 13 PostgreSQL-only cases skipped**, with 2,507 warnings. The
backend portion took 789.43 seconds. The first attempt stopped on a structural
test expecting the old three-argument concurrency helper; that assertion was
updated to also require cancellation, then the complete suite was rerun. No
behavioral assertion, timeout or money test was weakened.

The initial full application-browser run completed with **46 passed and five
mobile-WebKit timeouts** in 25.3 minutes. An unchanged isolated retry completed
with one pass and four aggregate timeouts in 7.4 minutes. Traces were preserved
before rerunning in `.tmp/third-e2e-initial-artifacts.zip` and
`.tmp/third-e2e-retry-artifacts.zip`.

Trace inspection found unfinished viewport matrices reaching their overall
45/90/120-second test deadlines, not failed layout assertions. In the forms
retry, ten Save trial clicks and ten Cancel clicks had succeeded; the final
null bounding box was requested 431 ms after timeout-driven context closure
began. The long-name retry's failing screenshot started 2,395 ms after closure
began. These traces do not establish that the unfinished cases pass.

The test harness now registers each viewport independently for those four
matrices, retaining every route, control, finance, permission and geometry
assertion and the existing per-test/assertion timeouts. Design screenshots
use CSS-pixel artifact resolution; device emulation and measured geometry
are unchanged. Receipt filter disclosure checks now additionally run at all
three directory widths. The full suite has 84 cases instead of 51 because
these matrices are independently reported, not because assertions were removed.
The final affected-case run passed **45 of 45 cases in 9.8 minutes**, across
desktop Chromium, mobile Chromium and mobile WebKit. No retries were needed
in that run. An independent source comparison against the archived original
confirmed assertion/route/viewport preservation. The other 39 browser cases
were verified by the initial full run and unchanged retry, not by a new full
84-case run. Evidence: `.tmp/third-e2e-matrix.log`.

Visual spot checks of the new 320-pixel Arabic/dark-mode receipt form and
expanded-ad screenshots also showed contained forms and reachable action
layouts. This is a limited screenshot inspection, not physical-device testing.

The browser prelude also passed **11 modal-presentation checks, 18 real-pointer
keyboard/modal checks and 22 real IndexedDB checks** in this pass.
All external Meta/payment responses in regression tests are synthetic;
browser contexts and the backend test database are disposable.

Completed build and security checks:

- `npm run build`: successful, startup bundle 2,506,563 bytes, within the
  existing 2.4 MiB budget. No budget increases or feature removals.
- `npm run sync:mobile` and `npm run verify:mobile`: source/root/www/Android/iOS
  web assets match. This is asset verification, not a signed native build.
  Artifact verification and `git diff --check` passed again after the final
  browser run; only test/report files changed after the successful build.
- Fresh npm audit: 212 dependency-tree entries, zero known vulnerabilities.
- Fresh Python requirements audit: 49 dependencies, zero known vulnerabilities.
- Bandit repeated over the same 43 runtime modules: 79 heuristic findings,
  matching the preceding pass (zero High, 51 Medium, 28 Low). This scan is not
  an all-clear: the existing SQL-composition/exception-handling/process/URL
  flags remain documented in the preceding reviews. Changed SQL fragments
  were independently reviewed for fixed identifiers and bound request values;
  no new finding category or scan errors appeared.

The existing local Docker engine is unavailable, so no production-container or
real PostgreSQL runtime result is claimed. Browser emulation does not substitute
for physical-device camera, biometric, OS notification or signed iOS testing.

Evidence logs are under `.tmp/third-*.log`; these are local verification aids,
not deployment artifacts. Changes remain local until a separate release.
