# Security and regression review — 15 September 2026

## Scope and safety

This review examined backend authorization, authentication, financial lifecycles,
Social Studio, asynchronous frontend state, native notifications, dependency
advisories, build exclusions, and browser/mobile compatibility. It preserved the
pre-existing redesign and restored Ads layout. It is not a claim that every line
is bug-free or a substitute for a production penetration test.

All reproductions used disposable local records or mocked browser/device/Meta
boundaries. No production financial records, subscriptions, Facebook posts,
notifications, or hosting configuration were changed. No Git commit, registry
push, or live deployment was performed.

## Confirmed defects fixed

| Area | Reproduced problem | Protection now applied |
| --- | --- | --- |
| Authentication | A mobile handoff or password-reset code issued before a password change could restore access afterward. Credential issuance could also race with revocation. | Password changes/resets/deletion revoke sessions and both one-time code types atomically. Issuance and exchange lock the user and validate the credential snapshot. Normal remembered and mobile login remain supported. |
| Ad photo permissions | Editors lacking Upload Photos could add/remove photos through generic and financial APIs. | Actual changes to both current and legacy photo fields require upload permission; editing existing photos also requires view permission. The check uses locked data. Text-only edits preserve hidden photos, and choosing a main photo remains available with view/edit permission. |
| Personal wallet access | Delivery users could list their own payment proofs but received 403 when opening the same record. | Detail reads apply the same own-record restriction as list reads. Other users' records and unassigned business records remain blocked. |
| Private Studio state | A delayed post response could put a previous user's private caption/photos into a new user's composer. | Responses are bound to the authenticated session/access context and composer identity. Replacement drafts and changed settings are not overwritten by stale work. |
| Publish retry | Creating a post and then failing to publish left the draft without its saved ID; retry could create another post. | Preserve the saved post ID before publishing and retry against the same record. This does not promise exactly-once external publishing after an unknown network failure. |
| Native reminders | Late scheduling could recreate reminders after sign-out or disabling; another sync could schedule while the disabling preference write was pending. | Session generations, serialized OS operations, immediate disable suppression, and late-operation cancellation. Failed preference writes are reported honestly and keep scheduling paused for the current session. |
| Scheduled publishing | A stale edit/cancel/delete could overwrite a worker's publishing claim. | Expected-revision checks reject the conflicting mutation without changing the post. Shared soft deletion uses monotonic revisions and a conditional update. |
| Scheduler queue | 500 older future-scheduled posts hid later records that were already due. | Compact keyset batches scan past future work without loading photo payloads. Historical date offsets are still parsed rather than compared as raw strings. |
| Stopped-ad funding | Settling a stopped unpaid ad onto a paid receipt left an unpaid stop baseline, breaking subsequent spend corrections. | Preserve the original customer budget in an unambiguous paid baseline during authorized mutation. Later corrections do not revive old debt. |
| Company coverage | Final spend could be saved below the amount already covered by company funds, leaving contradictory totals. | Reject the inconsistent change with a reviewable conflict; preserve company funding rather than silently rewriting its ledger. |
| Batch deletion | An unrelated or nonexistent row with a matching ID in a different collection could bypass customer-reference checks. | Batch membership is identified by both collection and ID. Genuine linked-record deletion still works, and failed batches leave records unchanged. |

## Existing data and financial safeguards

- Tests insert older raw rows without using current creation routes, including
  legacy photo fields, one-time codes, and stale stopped-ad funding baselines.
- The financial compatibility helper runs only during authorized mutations. It
  does not backfill on startup or rewrite records merely because they are read.
- Historical multi-receipt allocations are corrected only when their original
  distribution is certain. Ambiguous partial-spend settlements produce a clear
  conflict; receipt rates and unknown allocations are never guessed.
- Exact-cent conservation, mixed paid/unpaid funding, different exchange rates,
  retries, spend increases/decreases, and insufficient-balance rollback are
  covered by regression tests.

## Validation

New regression coverage: 68 backend defect cases, one login-test isolation case,
and 42 browser/native boundary cases.
Confirmed reproductions failed before their fixes. Focused suites were rerun
afterward, and separate reviewers inspected authentication and scheduler changes.

The 51-case Playwright sweep passed across desktop Chromium, mobile Chromium,
and mobile WebKit. After rebuilding the final frontend assets, 12 critical
privacy, photo-paste, and lazy-subsystem cases were repeated across all three
browser profiles and passed.

The 42 Social Studio/native boundary cases also passed in three additional
consecutive runs. An independent repeat of Social Studio, stopped-ad funding,
and typed batch-deletion backend tests passed all 69 cases.

The first combined run passed 1,143 backend cases and skipped 13 explicit
PostgreSQL cases, but exposed three test-isolation failures: two collision-test
pages survived into a whole-collection backup assertion, and accumulated shared
test-client login counts blocked two unrelated permission tests. The fixes are
limited to test isolation, not weaker production rate limits or changed import
semantics. The final full `npm test` rerun succeeded:

| Check | Final result |
| --- | --- |
| Backend pytest | 1,147 passed; 13 explicit PostgreSQL cases skipped; zero failures |
| Frontend permissions | 224 passed |
| Responsive/mobile UI | 161 passed |
| Shell presentation | 26 passed |
| Money invariants / profitability | 43 / 10 passed |
| Review / session privacy / existing-data regressions | 15 / 39 / 52 passed |
| Social Studio/native delayed-operation regressions | 42 passed |
| Modal presentation | 11 passed before the browser sweep |
| Browser sweep / final critical-flow repeat | 51 / 12 passed |

The backend run emitted 2,482 warnings (including existing test/framework
deprecations); passing does not mean warning-free. It used local Python 3.13.14.
The production Python 3.12 Docker runtime was not executed because Docker was
unavailable. Generated source/root/www/Android/iOS web artifacts matched after
the final rebuild; architecture and whitespace checks passed.

Local verification logs (not release artifacts):
`.tmp/audit-sep15-full-tests-final.log`, `.tmp/audit-sep15-e2e.log`,
`.tmp/audit-sep15-e2e-final-repeat.log`,
`.tmp/audit-sep15-social-native-repeat.log`,
`.tmp/audit-sep15-reviewed-repeat.log`, and
`.tmp/audit-sep15-final-build.log`.

Additional completed checks:

- `npm audit`: zero known advisories across the reported 212-package tree.
- `pip-audit` against `server/requirements.txt`: zero known advisories across
  49 resolved dependencies; ephemeral audit tooling did not change app packages.
- `uv pip check`: all 43 packages in the local Python environment compatible.
- All 58 authoritative JavaScript source/test/build files parsed; Python server
  files passed compilation checks.
- Bandit scanned backend files. Its initial runtime triage output contained no
  high-severity flags; lower-level flags included constant SQL construction,
  defensive exception handlers, backup subprocesses, and the operator-configured
  alert URL. These scanner flags are not proof of an exploitable vulnerability
  or of complete safety. Dependency scanning does not audit Docker OS packages.
- A targeted private-key/access-token marker scan found no matching markers in
  the inspected source, server, scripts, and workflow directories. This is not
  an exhaustive secret audit of Git history or the computer.
- Build, source/www/native artifact consistency, architecture budgets, and
  private-data image-exclusion checks were exercised.

## Limits and release status

The local Docker engine was unavailable. A normal startup attempt failed with a
Docker Desktop inference-manager socket error. No factory reset or Docker-data
deletion was attempted. Consequently, real PostgreSQL integration/concurrency
tests and container OS/image scanning could not be run in this review. Existing
PostgreSQL tests remain opt-in and must use a disposable loopback test database.

Mobile browser emulation and mocked native APIs are not physical-device testing.
Camera, biometric hardware, OS notification delivery, signed iOS/Android builds,
live Meta behavior, production TLS/proxy configuration, backup restoration on the
production platform, and a live penetration test remain outside this verification.

Generated web assets are local changes only. A later approved release must run
the release gate, build/push the Docker Hub image, and separately redeploy in
Libyan Spider/Jelastic. Packaged mobile changes require a fresh native app build.
