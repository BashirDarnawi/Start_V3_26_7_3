# Editing, testing, and releasing Albayan safely

This is the current workflow for contributors and AI assistants. `START_HERE.md`
is the entry point; reports in `docs/archive/` describe historical snapshots.

## Source and tests

- Edit JavaScript in `src/`; `src/manifest.json` owns ordering and lazy outputs.
- Run `npm run build`, not edits to `script.js`, `studio.js`, or `clothes.js`.
- Run `npm test` for architecture, permissions, mobile wiring, money, review
  regression tests, build safety, and the isolated backend suite.
- Run `npm run test:e2e` for desktop Chromium, mobile Chromium, and mobile WebKit.
  Its database is disposable under `.tmp/e2e`. Do not point it at production.
- Run `npm run sync:mobile` and `npm run verify:mobile` before mobile packaging.
  Verification checks every bundle, including lazy features, in root/web/native.
- Real phone tests are still required for biometrics, camera, sharing, keyboard,
  and app background/foreground behavior. Windows cannot validate an Xcode build.

## Financial rules

1. Count paid, customer-debt, and company-funded allocations consistently. Company
   coverage relieves customer liability; it does not create customer cash.
2. Re-saving a refund or changing only its status must not move money again.
3. Growing or shrinking a receipt must recompute all authoritative outstanding
   summaries in the same transaction.
4. Use the same currency basis on both sides of an allocation. Mixed receipt
   rates must not produce LYD credit when a customer's USD funding is consumed.
5. Preserve transaction/version protections, permissions, and audit trails.
6. Test combinations: coverage → edit → stop → refund → settlement; different
   exchange rates; repeated requests; concurrent attempts to use one receipt.

Never silently repair old records. First obtain a proven restorable backup and
produce a read-only before/after assessment. Any authorized repair must be
transactional, auditable, reversible, and must explain its business assumptions.

## Web release — only after explicit authorization

```text
npm run release:image:push
```

The publisher always runs `release:quality`, even when invoked directly. This
builds the frontend, checks generated assets, runs the test suites and browser
flows, and rejects high-severity npm dependency findings. It publishes a single
Linux/amd64 Docker manifest compatible with the existing Jelastic workflow.

Two tags are published: `bashird/albayan:latest` and a unique
`bashird/albayan:release-<git-revision>-<timestamp>[-dirty]` rollback reference.
`dirty` means the build includes uncommitted changes; it is not a claim that
GitHub contains that exact source. Save/review/commit source separately when
authorized. Keep the previous good release tag for rollback.

Jelastic must then explicitly redeploy from Docker Hub. Verify the expected
release via `/api/health/ready` and check the key live workflows. Never assume
that pushing Git, pushing an image, or a healthy HTTP response proves the new
version was deployed. A failed push may have partially updated registry tags;
inspect the tags/digests before retrying. Never put passwords or tokens in chat.

## Backup readiness

A file download is not enough. Check the export's completion footer, and prove
that a backup from the actual application image can be restored on PostgreSQL.
The Docker `pg_dump` major must be at least the database server major. CI must
exercise the application's backup code, not only a separate database toolbox.
Canceling a download must release its connection and download slot.

## Controlled future improvements

Keep separating large modules behind tested interfaces instead of a whole-app
rewrite. Moving photos out of JSON records is a separate storage migration,
not a safe incidental edit: plan compatibility, permissions, backups, and a
rollback before migrating existing media. Introduce cross-process Meta sync
coordination before changing the deployment to multiple worker processes.
