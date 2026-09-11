# Review fixes completed — 11 September 2026

Implemented against the local working tree based on `4e3df8c`. The original
`PROJECT_REVIEW_2026-09-11.md` remains a record of the findings before these fixes.
No commit, GitHub push, Docker Hub push, Jelastic redeploy, or historical money
repair was performed.

## Implemented

| Review finding | Change |
| --- | --- |
| F1: biometric bypass | An unmet authentication challenge survives quick app switches. Successful authentication is required to clear it. |
| F2: repeated refunds | Refund amounts and spend use the same pre-refund baseline; repeated saves/status changes no longer subtract again. |
| F3: shrinking covered budget | Paid/debt derivation and top-ups include existing company funding, including full company coverage. |
| F4: stale growing debt | Receipt growth and stop-driven release recompute outstanding liability and existing debt currency mirrors. |
| F5: PostgreSQL full export | Snapshot isolation is set before streaming SELECTs; error handling does not expose database details. |
| F6: incompatible backup client | The Dockerfile installs PostgreSQL client 16 from the signed official PostgreSQL repository. |
| F7: canceled download blocking later backups | Unconditional cleanup handles generator and actual ASGI cancellation, including a stream that never starts. |
| F8: phantom LYD credit | Spending and coverage are valued at matching funding-specific currency rates, preserving saved receipt rounding. |
| F9: stale data after role changes | Shared visibility-change logic clears memory, request caches, persisted collections, and dialogs before scoped reload. |
| F10: missing lazy-feature styles | Tailwind scans every source module; new browser checks cover Clothes and Studio responsive rules. |
| F11: stale native web copies | All web bundles/CSS were rebuilt and synchronized into Android and iOS; native verification passes. |
| F12: tests inheriting live connections | Test runners force disposable SQLite and clear database/integration overrides. Browser tests reject remote targets. |

Additional improvements:

- Backups fetch one media row at a time and encode it in bounded chunks. A
  64 MiB synthetic media test verifies additional Python allocations stay below
  its 8 MiB regression budget. This is a test result, not a production memory SLA.
- Downloaded `.gz` backups remain genuine gzip files rather than being decoded
  as HTTP transport compression while retaining the gzip filename.
- The download-start message explicitly says that starting is not proof of a
  complete, restorable backup.
- Corrected the clipboard test fixture without removing the owner's Meta-only
  page restriction or any manual-creation code.
- Build, sync, and verification share a validated bundle manifest. Lazy bundles
  are now included in web/native artifact checks.
- Publishing directly or through npm runs the same quality gate. Releases get
  `latest` plus a unique version/rollback tag; uncommitted builds are labeled
  `dirty`. No publishing was performed during this implementation.
- CI now checks the new behavioral regressions, real PostgreSQL finance and
  export behavior, native asset copies, and the actual application's backup
  client rather than relying on an unrelated PostgreSQL toolbox image.
- Updated affected npm lockfile packages. An additional Python audit found the
  old cryptography constraint vulnerable; it is now pinned to `50.0.1`, a patched
  stable release. See the [official changelog](https://cryptography.io/en/latest/changelog/)
  and [OpenSSL-wheel advisory](https://github.com/advisories/GHSA-537c-gmf6-5ccf).
  Frozen synthetic V1/V2 files made with the old `47.0.0` library still decrypt
  with the same keys; wrong keys/tampering remain rejected. No encryption format
  or live key was changed.
- Corrected conflicting contributor instructions and added
  `RELEASE_AND_SAFETY.md` as the release/data-safety guide.

## Final verification

| Check | Result |
| --- | --- |
| Complete backend suite with cryptography 50.0.1 | **648 passed, 7 skipped**; the skips are opt-in PostgreSQL cases, run separately below |
| PostgreSQL financial/export modules plus frozen crypto compatibility | **29 passed**, including all 7 actual PostgreSQL cases and connection-safety guards |
| Backend money/backup tests inside the production Linux image | **63 passed** |
| Real browser suite | **27 passed** across desktop Chromium, mobile Chromium, and mobile WebKit |
| Frontend regression suites | Permission **223**, mobile UI **139**, money **43 + 6**, profitability **10**, review behaviors **15** passed |
| Build safety and architecture | Passed |
| Root, web, Android, iOS generated-asset verification | Passed, including lazy bundles |
| npm audit | No known vulnerabilities reported |
| pip-audit of server requirements | No known vulnerabilities reported |
| Docker runtime smoke | Image builds; non-root service starts and readiness endpoint responds |
| Production-image encrypted PostgreSQL round trip | Actual `_dump_database` → encryption → decryption → `pg_restore` recovered the expected synthetic value `42` |
| Whitespace/diff check | Passed |

The local validation image is `albayan-review:20260911`. It is a diagnostic build,
not a Docker Hub/Jelastic release. The deployment path remains Docker Hub
`bashird/albayan` → Jelastic, with a separate authorized release command.

## Boundaries and remaining deployment work

- Live customer records were not rewritten. Previously damaged records may
  require a separate read-only reconciliation and an explicitly approved,
  backed-up repair. New safeguards cannot reconstruct missing historical facts.
- Native web assets are current, but an App Store/Play Store binary was not
  produced. Real-device biometric/camera/share testing and an Xcode build still
  require the appropriate devices/build environment.
- CI configuration was improved and local equivalents tested; the hosted CI
  run awaits a separately authorized Git push.
- Framework deprecation warnings remain; they are not suppressed or represented
  as failures. A lifecycle/framework migration should be a separately tested
  change, not mixed into accounting repairs.
- Moving existing media out of JSON, rewriting the application, or enabling
  multi-worker Meta synchronization are future migrations, not silently applied
  changes. The new guide records their compatibility and rollback requirements.

These results cover the reviewed findings and tested workflows. They are not a
claim that every possible defect or security vulnerability has been eliminated.
