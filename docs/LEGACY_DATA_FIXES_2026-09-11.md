# Existing-data compatibility fixes — 2026-09-11

## Outcome

Current code now applies deterministic financial summaries and supported old
record formats when reading existing records, not only when creating records.
Previously failed Meta image archives can retry. Existing backfills now publish
their changes through modification cursors. Read-rule version changes trigger
a bounded, one-time refresh in updated clients, even for unedited old records.

The owner does not need to recreate those records. Deployment and a client
reload/update are still required to receive the code. No production data was
accessed or modified, and no commit, Git push, Docker push or deployment was
performed during this compatibility task.

## What changed

1. Receipt customer-outstanding summaries and ad funding summaries derive from
   canonical saved values on list/detail/bootstrap/sync/action responses. These
   read projections do not rewrite saved cash, exchange rates, creation metadata,
   refund/stop baselines or historical reports. Exact projected values can be
   echoed during an ordinary edit without a false server-field error.
2. Covered receipt actions use the same trustworthy outstanding calculation.
   Old delivered receipts carrying an office marker use explicit gross debt,
   not the already-collected cash as their original debt.
3. Startup customer-name, covered-settlement and relink-baseline repairs advance
   modification cursors only on actual changes. Repeating a repair is a no-op;
   saved photos and creation metadata survive; closed-period rows are not written.
4. Meta retries old successful-looking markers with missing image data, accepts
   refreshed signed page-image links until a copy exists, and repairs known
   legacy page-name placeholders without replacing real manual names or owners.
5. Existing browser normalization runs before rendering incoming rows and no
   longer schedules repeated delayed whole-collection migration. Known delivery
   aliases are normalized; unknown statuses and missing/malformed exchange rates
   remain unknown, rather than becoming Office or today's exchange rate.
6. `dataCompatibilityVersion` tells current clients to refresh allowed records
   once. Failures retain the old version for retry; newer records, deleted rows,
   local unsynced rows and drafts are preserved. Session/access/poller changes
   abort stale results. Version checks are bounded to once per minute.
7. Added the compatibility contract in `docs/DATA_COMPATIBILITY.md`, contributor
   instructions and an automatic frontend old-data test step in npm/CI. Future
   changes still need specific old-record fixtures and an appropriate version bump.

## Verification

- Full `npm test`: all frontend/build guards passed; **1,036 backend tests passed**.
  The **13 PostgreSQL-only scenarios** skipped by SQLite were run successfully
  against disposable PostgreSQL16, alongside 15 guards (**28 checks passed**).
- Final review added three contradictory-payment-marker controls, then reran
  **317 financial/compatibility tests**, all passing. Conflicting old paid/unpaid
  markers must not create new debt through a guessed read correction.
- **52 frontend legacy-data regressions**, **39 session/privacy regressions** and
  **15 previous-review regressions** passed, alongside the existing permission,
  mobile UI, money and profitability suites.
- **36 Playwright tests passed** across desktop Chromium, mobile Chromium and
  mobile WebKit. The new browser scenario verifies an existing receipt refreshes
  at the same server revision, without a database write or recreation.
- JavaScript/CSS rebuilt; root/www/Android/iOS web artifacts verified identical
  to current source. The existing startup bundle budget was retained.
- `git diff --check` passed. Owned PostgreSQL schemas/container were removed;
  existing user containers were left untouched.

Logs are in ignored `.tmp/compat-final-tests.log`, `compat-final-financial.log`,
`compat-browser-tests.log` and `compat-build.log`. A Windows connection-reset
callback warning appeared when a browser connection closed; browser tests passed.
Existing backend deprecation warnings remain.

## Safety limits

Missing or contradictory historical financial evidence is not guessed. In
particular, this does not retrospectively redistribute uncertain refund/stop
funding or decide whether an old paid receipt's amount was gross or net cash.
Closed accounting snapshots remain unchanged. Closed-period protection can also
prevent storing newly retrieved Meta media on those rows. Real Meta access,
payment providers and physical phone hardware were not exercised by these tests.

No software can automatically make every unknown future change compatible;
the added refresh protocol, reusable readers, checklist and regression tests
make compatibility an explicit part of future development.
