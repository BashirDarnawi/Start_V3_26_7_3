# Deep-review fixes — 11 September 2026

This implements the findings in `DEEP_SECURITY_REVIEW_2026-09-11.md` on top of
the earlier local fixes. Existing features and earlier uncommitted work were
preserved. No production financial records were repaired or rewritten.

## Changes

| Finding | Implemented change |
| --- | --- |
| D1: refunds + company coverage | Coverage updates saved refund/stop funding baselines. Undo no longer restores customer debt already replaced by company funds. |
| D2: unused paid money unavailable | Paid-cash capacity excludes the company-funded share while gross unpaid capacity still reserves it. Both ad funding and receipt transfers use the appropriate capacity. |
| D3: direct receipt edits | Relevant money edits recompute outstanding customer debt, including delivered receipts with partial cash. Note-only edits do not silently rewrite historical accounting. |
| D4: concurrent-operation errors | Customer coverage follows the financial row-lock order and verifies its candidate ad set. Ordinary edits take nonblocking shared month guards; close/unlock remain exclusive. Both reproduced deadlocks and the close/write protocol pass real PostgreSQL tests. |
| D5: payment retry currency | A retry must match user, amount, currency, and method. Exact retries still reuse the original operation. Legacy missing currency retains the established USD interpretation. |
| D6: private dialogs after sign-out | Central cleanup closes sensitive dialogs, removes stale drafts/photos, and releases scrolling on logout, session expiry, and access changes. |
| D7: late camera photos | Camera results retain owner, server/session, form, and operation identity across awaits and retries. Late results cannot enter another form. |
| D8: stale identity cache | Identity requests and caches are session/access-bound; concurrent same-session lookups share one request. Startup and permission refresh also reject stale results. |
| D9: slow photo work blocks sync | Media/name processing runs separately from ad discovery. Bounded batches and backoff avoid repeatedly hammering failing image URLs. |
| H1: unsafe media redirects | Server downloads accept known Meta CDNs only, validate and pin public IPs, retain TLS/Host identity, reject redirects and proxy inheritance, and cap downloaded data. |
| H2: local data inside images | Docker excludes runtime data, backups, environment files, and private keys. A build-stage guard checks the actual copied image and stops publication if forbidden paths appear. |

Additional safeguards:

- A photo downloaded while Meta changes its creative URL cannot overwrite the
  newer creative with the old one.
- Worker stop/restart cannot create overlapping worker generations.
- Ordinary writes to the same open month no longer serialize behind an
  exclusive month lock. If a close is in progress, the operation returns a
  clear retryable conflict instead of waiting while holding financial rows.
- Media-worker health is reported separately from primary synchronization.
- New financial, media, packaging, and session tests run in the normal test
  pipeline; CI also runs the new session checks.
- Browser coverage verifies the outside admin coverage button and removal of
  the real financial dialog on both logout and expiry in all three browser
  profiles. The saved-account chooser remains available.
- The web bundle was rebuilt and synchronized into the Android and iOS web
  assets. This is not a signed native-store release.

## Important behavior and limitations

- A refund cannot reduce an ad's net amount below company funding already
  recorded against it. The system returns an explanatory conflict instead of
  silently moving company money into customer debt. Company funding must be
  reconciled separately in that case.
- Inconsistent historical baselines are not guessed or silently repaired.
  Relevant operations return a review/refresh message. No live-data migration
  or repair was performed in this task.
- Normal camera use is preserved. After Android destroys the entire app
  process, a result can be restored only to the same identified owner and saved
  record. Unsaved forms without a stable record identity cannot safely restore
  that result; the user must reopen the form and retake/select the photo.
- OS DNS resolution may still block the media thread. It no longer occupies
  the ad-discovery thread. Meta response times and rate limits still apply;
  this is not a guarantee of instant synchronization.
- Media destination restrictions affect server archiving. They do not delete
  user-uploaded photos or remove existing browser image fallbacks.
- No real Meta accounts, payment gateways, live customer records, or physical
  phone camera/biometric hardware were used for testing.

## Verification

| Final check | Result |
| --- | --- |
| Complete `npm test` pipeline | Passed |
| Complete backend suite | **940 passed, 11 skipped**; all 11 opt-in PostgreSQL scenarios passed separately below |
| Real PostgreSQL financial suite | **16 passed**: 8 real scenarios and 8 test-target/isolation guards |
| PostgreSQL backup + frozen encryption compatibility | **17 passed**: 3 real PostgreSQL export cases, 7 target guards, and 7 encryption compatibility cases |
| Browser suite | **33 passed**: desktop Chromium, mobile Chromium, and mobile WebKit |
| New financial lifecycle regression module | **227 passed**, included in backend total |
| New media/worker regression module | **42 passed**, included in backend total |
| New image packaging regression module | **21 passed**, included in backend total |
| Payment retry currency cases | **2 passed**, included in backend total |
| New frontend session/privacy cases | **39 passed** |
| Existing frontend regression checks | Permissions **223**, mobile UI **139**, money **43 + 6**, profitability **10**, prior review **15** passed |
| Selected tests inside the final Linux Docker image | **471 passed** (finance, media, packaging, wallet/Studio, backups, operations) |
| Web and native artifact verification | Source/root/www/Android/iOS match |
| npm and Python dependency scans | No known vulnerabilities reported |
| Actual image packaging guard | Passes new image; correctly rejected the older diagnostic image containing a local database |
| Actual image startup | Non-root UID 999; readiness reports connected database and expected local release identifier |
| Image/source comparison | SHA-256 matches for changed server runtime modules and the web bundle |
| Whitespace/diff check | Passed |

The PostgreSQL tests covered the original customer/ad lock cycle, the additional
coverage/settlement period-lock cycle, concurrent coverage with settlement,
relinking and creation, simultaneous ordinary writers, month closing waiting for
active writers, snapshots including their commits, and rejection of later edits
to closed months. Temporary schemas and audit-owned containers/volumes were
removed; pre-existing user containers were left alone.

An independent read-only review also reran the 227 lifecycle cases and found no
additional confirmed money-conservation regression in these changes.

Earlier audit probes are retained as evidence; their intentionally bad-behavior
assertions are not release tests. Permanent regression tests now assert the
corrected behavior instead. An initial new browser assertion expected a password
form immediately after sign-out, but this app intentionally shows a saved-account
chooser. The assertion was corrected to preserve that feature; all six new
logout/expiry browser cases then passed.

The backend suite still emits dependency deprecation warnings, and the Windows
browser server logged a connection-reset callback warning while all cases passed.
Those warnings are not a claim of a clean production load test. Dependency scans
do not certify the app or operating system against every possible vulnerability.

Local final logs: `.tmp/deep-fixes-final-tests.log`,
`.tmp/deep-fixes-all-browser.log`, `.tmp/deep-fixes-linux-tests.log`,
`.tmp/deep-fixes-final-build.log`, and `.tmp/deep-fixes-final-image.log`.

## Release state

Changes are local and uncommitted. No GitHub push, Docker Hub push, or Jelastic
deployment was performed. A separate local diagnostic image is used only for
verification; `bashird/albayan:latest` was not replaced or published by this task.
The local-only diagnostic tag is `albayan-deep-fixes:20260911` and its readiness
release label is `local-deep-fixes-20260911`. Use the normal versioned publishing
workflow for deployment; this task did not publish a Jelastic-ready release.
