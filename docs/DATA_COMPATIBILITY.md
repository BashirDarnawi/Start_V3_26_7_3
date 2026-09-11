# Updates apply to existing data, too

## What this means for the owner

You should not need to delete and recreate a receipt, customer, page or ad to
get an updated feature. The application reads supported older formats using
current rules. A server update can now tell an already-open application that
unchanged records need refreshing. Actual repairs also appear in normal sync.

This does not manufacture information never saved in the first place. Unknown
historical cash, exchange rates, creators and refund funding cannot be safely
guessed. Those cases require review. Closed accounting periods remain protected.
No production records were accessed or changed to develop these improvements.

## Current compatibility paths

- `server/financial_compatibility.py` recalculates derived customer debt and
  company-funding summaries from existing canonical amounts/allocations. It is
  used at the shared response boundary for list, detail, bootstrap, sync and
  financial action responses. Raw stored money and historical baselines are
  not rewritten by a read. Locked company-coverage validation uses the same
  outstanding calculation, so the displayed amount can actually be used.
- `server/backfills.py` retains the narrowly scoped existing startup repairs.
  Each actual change now advances both modification cursors monotonically;
  rerunning a completed repair changes nothing. Creation attribution and
  saved media remain intact. Closed-period rows are not written.
- `server/meta_ads.py` retries old failed archive markers when the image data
  is missing, refreshes signed page-image URLs until a copy exists, and resolves
  supported legacy page-name placeholders. Saved uploads, real names and
  customer ownership are preserved; network access and permissions are still
  required to retrieve missing media.
- Frontend normalization runs on supported older records before rendering,
  using the existing persistence compatibility rules rather than a second
  independent financial migration system.

## Read-compatibility version contract

`GET /api/sync/watermarks` returns the existing visibility-scoped `watermarks`
and `dataCompatibilityVersion` from `server/data_compatibility.py`.

When the version differs from the one successfully loaded by a session, the
client refreshes permitted records. It acknowledges the version only after a
successful refresh. Failed refreshes remain retryable. Same-version polls do
not repeatedly download every record. Older servers without the field keep
working. Permission boundaries, tombstones and newer local edits are preserved.

Increase this positive integer whenever new read rules change the meaning of
an unchanged stored row. Do not use it as a substitute for a database migration,
do not use the browser's clock as a server cursor, and do not persist a success
marker before refreshed data is safely applied. Deploy compatible server and
client bundles together; a pre-feature client needs a page/app reload once.

## Checklist for every future feature or bug fix

1. Identify the authoritative fields and every historical shape still supported.
   A missing field is not necessarily zero or false. Do not overwrite valid
   explicit values, original timestamps, owners, photos or unknown extension fields.
2. Prefer a pure, idempotent reader for derived information. Reuse it in the
   relevant display and action paths. Keep raw backups/history lossless.
3. If a stored repair is needed, prove it unambiguous, use bounded discovery,
   lock/re-read the full candidate before writing, respect period locks and
   publish modification cursors. Financial changes require an audit trail and
   separate approval for any new live-data repair workflow.
4. Add an old-format fixture by inserting raw data, not by using the modern
   create API. Test old/new, missing/explicit values, list/detail/sync, edit
   round-trip, media preservation, repeat-run idempotency and permissions.
   Test an older backup/encryption fixture when changing backup formats.
5. Bump the compatibility version when required; test failed/retried refresh
   and an unchanged old row. Do not replace real money with a guessed default.
6. Run `npm test`, `npm run test:e2e`, rebuild/sync web/native assets and run
   `npm run verify:mobile`. For transaction changes, also run the explicitly
   isolated PostgreSQL scenarios in CI. Deployment remains a separate step.

## Regression coverage

- `server/test_data_compatibility.py`: old raw rows through current responses,
  no read-time database writes, old photos/rates preserved, modification
  cursors, repeated backfills and closed-period controls.
- `server/test_financial_compatibility.py`: derived financial readers and old
  row edit/coverage action round-trips.
- `server/test_meta_legacy_compatibility.py`: old failed image archives and
  page placeholders, with all external responses mocked.
- `scripts/test-legacy-data.js`: legacy browser normalization and refresh rules.

These tests run in the ordinary test suite. They protect the cases explicitly
covered; no test framework can guarantee that every future code change is safe
without adding and reviewing tests for that change.
