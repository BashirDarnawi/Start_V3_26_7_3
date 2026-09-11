# Albayan project review — 11 September 2026

Reviewed local commit `4e3df8c`, including the newer Claude changes. This is an audit, not a release. No application source, business records, Git history, Docker Hub images, or live deployment were changed. This document is the only added project file.

## Bottom line

The project has substantial permission checks, financial safeguards, and automated tests. However, combinations of newer features still produce important bugs. Prioritize the biometric lock, working backups, and financial corrections before adding more features.

Passing tests do not mean every workflow is correct: the review reproduced money errors that the existing tests do not exercise. Reproductions used isolated test data, not customer records.

## Checks completed

| Check | Result |
| --- | --- |
| Backend pytest suite, isolated SQLite | **602 passed**, 1,920 warnings |
| JavaScript permission checks | **223 passed** |
| Mobile UI regression checks | **139 passed**; these are largely source/wiring checks, not physical-phone tests |
| Money checks | **43 invariants + 6 target-behavior checks passed** |
| Profitability checks | **10 passed** |
| Architecture and mobile configuration | Passed |
| Source/root/`www` generated-asset verification | Passed within the verifier's coverage; see improvement I2 |
| Desktop Chromium, mobile Chromium, mobile WebKit browser suite | **21 passed, 3 failed**; all failures are the same outdated clipboard fixture, explained below |
| Native copied-asset verification | **Failed:** Android and iOS each have stale `script.js` and `assets/tailwind.css` |
| npm dependency audit | **4 high-severity package findings**, zero critical; affected installed chains are development/build tools |
| Targeted extra probes | Real financial API sequences, actual frontend functions in an isolated VM, native lifecycle mocks, backup-generator cancellation, and PostgreSQL 16 cursor syntax |

Coverage included authentication, permissions, sync, Meta integration paths, customer/receipt/ad accounting, company debt coverage, delivery, refunds, frontend forms and rendering, native services, backups, build artifacts, Docker, and CI. This was not a production penetration test or a physical iOS/Android-device certification. The complete financial suite was not run against PostgreSQL; the targeted PostgreSQL backup probe was run in a disposable container, then removed.

## Fix first — high-priority confirmed findings

### F1. Failed biometric authentication can be bypassed by reopening the app

**Priority: P1.** Location: `src/01c-native-services.js:590-603`.

When biometric protection is enabled, authentication can fail and correctly leave the lock visible. But pressing Home and immediately reopening the app resets the background timer and takes the quick-return branch, which removes the lock without successful authentication.

The actual bundled lifecycle functions, with a mocked native bridge, produced:

```text
After rejected authentication: locked=true, authenticationCalls=1
After Home + immediate reopen: locked=false, authenticationCalls=1
```

Fix direction: preserve an explicit authentication-required state. A quick return may remove an app-switcher privacy cover, but must never remove an authentication lock left by failure. Add lifecycle tests for cancellation, failure, repeated backgrounding, and successful unlock. Verify on real Android and iOS devices before shipping.

### F2. Saving the same refund again subtracts it again from ad spending

**Priority: P1.** Locations: `server/main.py:7494-7504`, spend assignment at `7639`; form submission at `src/13-filters-helpers.js:7327-7330`.

Real API reproduction:

1. Create a paid $100 ad and stop it after $10 actual spend.
2. Record a $2 partial refund. Spending becomes $8 and receipt funding becomes $8.
3. Change the refund status to `Refunded`, keeping the same $2 refund.
4. The API succeeds, but spending becomes **$6 while funding remains $8**.

The refund allocation uses its original baseline, but the spending calculation subtracts from an already-refunded value. A status change must not apply the refund a second time.

Fix direction: use one stable, authoritative pre-refund baseline for both spend and allocations. Re-saving the same refund must leave money unchanged. Cover partial/full refunds, status-only edits, refund removal, and repeated requests in regression tests.

### F3. Editing notes can shrink the budget after the company covers some debt

**Priority: P1.** Location: `server/main.py:7335-7338`; the paid-conversion path around `7176` has the same omission.

Real API reproduction:

1. Create a $100 unpaid ad linked to a $100 unpaid receipt.
2. Have the company cover $40: the ad budget remains $100, customer debt is $60, and company funding is $40.
3. Submit an ordinary ad update containing only a note.
4. The API succeeds but changes the budget to **$60**, even though its funding still totals $100.

The budget is reconstructed from paid and due receipt allocations, omitting company allocations. Settling the remaining $60 with a paid receipt reproduced the same shrinkage.

Fix direction: consistently include all authorized funding sources in budget derivation and conversion. Add tests proving notes-only edits, settlement, stopping, and refunds preserve company-funded value.

### F4. Reusing a partly company-covered unpaid receipt understates the new debt

**Priority: P1.** Location: `server/unpaid_receipt_growth.py:613-616`. Consumers of the stale summary include `src/13-filters-helpers.js:951-956` and `4676-4678`.

Real API reproduction:

1. A receipt has $100 debt; the company covers $40, leaving $60.
2. Reuse that receipt for a second $50 ad through the supported debt-growth operation.
3. The receipt gross amount correctly becomes $150, but its stored customer outstanding amount stays **$60 instead of $110**.
4. Trying to cover the actual remaining $110 fails with HTTP 409: outstanding liability is smaller than the requested amount.

The growth operation updates gross USD/LYD but not the company-coverage debt summaries.

Fix direction: recompute the authoritative debt/coverage summary inside the same transaction as every receipt growth or shrink operation. Add tests combining growth, company coverage, stopping, and later collection. Assess affected existing records with a read-only reconciliation before any repair.

### F5. The full downloadable backup fails on PostgreSQL

**Priority: P1.** Location: `server/full_backup.py:193-199`; error/footer handling at `286-301`.

The backup enables server-side streaming before issuing `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`. With the installed SQLAlchemy/psycopg combination, that becomes:

```sql
DECLARE backup_probe CURSOR FOR SET TRANSACTION ISOLATION LEVEL REPEATABLE READ
```

PostgreSQL 16 rejected the generated statement with a syntax error near `SET`. The endpoint catches the error and can still return an HTTP 200 download containing `complete:false` and no exported records. Downloading a file therefore does not prove a usable backup was created.

Fix direction: establish transaction isolation before enabling streaming, test the actual export on PostgreSQL, and make incomplete backup status unmistakable. Validate a complete file and a restore before treating backups as healthy.

### F6. The Docker image's backup client does not match the supplied PostgreSQL server

**Priority: P1 for the supplied PostgreSQL 16 deployment.** Locations: `server/Dockerfile:5,11-12`, `docker-compose.yml:8`, and `server/operations.py:556-577`.

The Dockerfile uses Debian Bookworm's default `postgresql-client`, which installs PostgreSQL client 15. The provided Compose database is PostgreSQL 16. Version 15 `pg_dump` refuses to dump a version 16 server. This affects the encrypted database-backup route separately from F5.

The package version is documented by [Debian](https://packages.debian.org/bookworm/postgresql-client); the incompatibility rule is documented by [PostgreSQL](https://www.postgresql.org/docs/16/app-pgdump.html).

Fix direction: install a client compatible with the intended database major version, then prove backup and restore using the actual application image. The live server/database version was not inspected in this audit, so this is not a claim about the success of any existing production backup.

## Other confirmed problems

### F7. Closing a backup download can block subsequent downloads

**Priority: P2.** Location: `server/full_backup.py:294-315`.

The generator yields footer/compressed bytes inside `finally` before releasing its connection and single-download semaphore. Closing the actual generator after its first chunk reproduced `RuntimeError: generator ignored GeneratorExit`; the semaphore remained occupied. Later requests can receive 503 until the process restarts.

Fix direction: never yield while handling generator cancellation; put resource and semaphore release in unconditional cleanup. Test a canceled download followed by a successful new download.

### F8. Different exchange rates can create LYD credit that does not exist

**Priority: P2.** Locations: `src/13-filters-helpers.js:1125-1127`, `1221`, and `1253-1254`.

Reproduction using the actual customer-statistics function:

- Paid receipt: $50 at 5 LYD/$.
- Unpaid receipt: $50 at 10 LYD/$, fully company-covered.
- Ad: $100, fully consuming both funding sources.

The customer correctly has a $0 USD balance, but the screen calculates **+250 LYD**: `250 paid - 500 spend + 500 company relief`. Spending and company relief use different conversion bases.

Fix direction: value each funding/debt allocation consistently at its applicable rate rather than converting the entire ad at the average paid-receipt rate. Add mixed-rate tests across customer cards, analytics, and debt filters.

### F9. Changing a delivery user's role can leave old, out-of-scope records cached

**Priority: P2.** Location: `src/10-live-sync.js:418-425`.

Reproduction: a Delivery user holds an assigned receipt created by someone else, then becomes an Employee allowed to view only their own records. The permission refresh and next sync both succeed, but the old non-owned receipt remains; no cache purge or scoped reload occurs.

Direct card filters offer some protection. However, the record remains in local state and totals that read raw receipt arrays can still include its amounts. A delta response cannot remove records that the server simply omits under the new scope.

Fix direction: reuse the existing permission-scope-change cleanup for this branch, close stale dialogs, clear cached data, and perform an authoritative scoped reload. Test changes between all roles, not only sign-in permissions.

### F10. Some Clothes and Ads Studio layout styles are never built

**Priority: P2.** Location: `tailwind.config.js:20`.

Tailwind scans only `index.html` and `script.js`, while Clothes and Ads Studio are separate lazy bundles. Examples present in source but absent from both generated Tailwind CSS and custom CSS:

- `sm:flex-wrap` at `src/15b-clothes.js:203`.
- `md:grid-cols-[1fr_auto]` at `src/15c-ads-studio.js:399`.
- `lg:grid-cols-[1.4fr_1fr]` at `src/15c-ads-studio.js:427`.

These responsive rules silently do nothing. The current asset verifier still passes because it rebuilds with the same incomplete scan configuration.

Fix direction: include all source/lazy modules in Tailwind's content configuration. Check Clothes and Studio separately at phone, tablet, and desktop sizes; core-manager route checks do not cover them adequately.

### F11. Native app copies are behind the current web source

**Priority: P2, before the next mobile build.** `npm run verify:mobile` found stale `script.js` and `assets/tailwind.css` in both `android/app/src/main/assets/public/` and `ios/App/App/public/`.

The root and `www` files passed the ordinary verification. This finding concerns the bundled native copies; it does not establish which version is installed on any customer's phone.

Fix direction: rebuild/sync through the release preparation workflow before native packaging, then require native verification in CI. Do not manually patch generated copies.

### F12. Browser tests can inherit a non-test database connection

**Priority: P2 developer/data-safety risk.** Locations: `scripts/start-e2e-server.js:43-46` and `server/db.py:55-95`.

The test launcher inherits the environment and sets only `ALBAYAN_DB_PATH`. But `DATABASE_URL`, `ALBAYAN_DATABASE_URL`, or discrete PostgreSQL settings take precedence. If a shell contains a production database configuration, the browser-test server can use it instead of the intended test database. Browser tests create records and configure a test admin.

Fix direction: explicitly force a disposable database URL, remove conflicting connection variables, and reject non-test targets. For this review, the database URL was explicitly forced to the local test database; production data was not used.

## Test and maintenance improvements

### I1. Update the clipboard browser-test fixture

All three browser failures stop before photo pasting is tested. `tests/e2e/critical-flows.spec.js:100-130` seeds a page without `metaPageId`, but the current owner-requested admin filter at `src/15-modals.js:371-377` allows only Meta pages. The result is a "No Pages Found" modal, not the ad form containing the Paste photo button.

Update the fixture to satisfy the current rule, then rerun the clipboard tests. Do not remove the admin restriction merely to make the test pass. Test that restriction and the empty-state wording separately. Clipboard functionality remains unverified by this failed test.

### I2. Verify every generated bundle and gate every release the same way

`scripts/verify-artifacts.js:88-112` checks `manifest.files`, but not `manifest.lazy`; its root-to-`www` list at `151` also omits `studio.js` and `clothes.js`. Extend source/root/web/native verification to all generated bundles.

Use one documented release route that requires tests, dependency checks, all artifact checks, an immutable version tag, and a rollback reference. A web-image build, mobile build, and redeployment are different operations and should each report their version clearly.

### I3. Exercise the actual production database and backup implementation in CI

The PostgreSQL CI job checks migrations and a dump/restore using a separate PostgreSQL 16 tool container. It does not exercise the application's downloadable backup or the `pg_dump` installed inside the application image. This is why the current backup mistakes escape it.

Add production-dialect tests for money transactions, concurrent receipt use, duplicate requests, backup cancellation, and backup/restore round trips. Include the operation sequences in F2-F4, not only isolated feature tests.

### I4. Bound backup memory by bytes, not just by record count

`server/full_backup.py:218-225` loads 200 complete rows with `.mappings().all()`. Rows can contain inline photos. A probe with 200 x 64 KiB records retained about 12.6 MiB of row data; at 2 MiB per row, the same batch would contain roughly 400 MiB before overhead. The latter is an extrapolation, not a production measurement.

Use one-row or byte-bounded streaming and measure realistic media sizes. Longer term, moving images out of ordinary JSON records would reduce sync and backup memory costs, but should be a separate migration with compatibility and restore tests.

### I5. Update vulnerable build dependencies

The current npm audit identifies four high-severity packages in installed development/build-tool chains:

- `sharp@0.35.3`: [maintainer advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
- `@xmldom/xmldom@0.9.10`, via Capacitor CLI: [advisory](https://github.com/advisories/GHSA-965w-775f-mr7g).
- `brace-expansion@5.0.8`, via Capacitor CLI: [advisory](https://github.com/advisories/GHSA-rgw5-rvv9-x895).
- `nanoid@3.3.16`, via Tailwind/PostCSS: [advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8).

Updates are available. These findings do not by themselves prove the live site is exploitable. Update the lockfile in a controlled change, test builds, and rerun the audit. CI currently runs `npm audit --audit-level=high`, so this dependency state does not meet that gate. The Python dependency audit was not rerun during this review.

### I6. Give future AI work one accurate project guide

`START_HERE.md:11-12` says there is no build step, and `PLATFORM_FOUNDATION.md:17` tells contributors to edit `script.js`. Both conflict with the actual generated-source workflow. Correct these instructions and document source locations, financial invariants, tests, and the real Docker Hub-to-Jelastic release path in one canonical guide.

Keep gradually extracting business operations from the large `server/main.py` and frontend helper files behind tested interfaces. Avoid a whole-app rewrite while financial fixes are pending.

## Suggested implementation order

1. Fix the biometric lock and establish backups that can actually be restored.
2. Fix F2-F4 and F8, with regression tests first and a read-only assessment of existing affected records.
3. Fix permission-scope cleanup, test-database isolation, and backup cancellation.
4. Correct responsive CSS, clipboard fixtures, mobile copies, and release verification.
5. Update dependencies and documentation; expand PostgreSQL, native lifecycle, and realistic-media tests.

Do not silently rewrite old financial records. Any historical repair should have a verified backup, an explicit before/after report, transaction protection, and an audit trail.
