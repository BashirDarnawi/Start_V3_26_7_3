# Second bug and security review — 2026-09-15

This is an additional, local review following `SECURITY_REVIEW_2026-09-15.md`.
The existing design changes, restored Ads presentation, and first-pass fixes
are preserved. This review did not publish a Docker image, push Git, deploy,
or modify production records. It is not a claim of exhaustive security.

## Confirmed defects fixed

### Current authorization on saved-request retries

- Ad funding retries previously returned the current ad before rechecking the
  caller's current permissions. A saved key could expose new private photos
  after ordinary ad access was removed. Retries now check current ownership,
  permissions, and deletion state. Read-only confirmation is still permitted;
  action-only grants retain their existing mutation-response contract.
- Clothes order/shipment retries similarly bypassed current read access.
  Replays now check current view/own scope and omit inaccessible product
  details, without repeating inventory movements.
- Ad stopping and debt growth could return full linked receipts to an actor
  who could perform the ad action but could not read those receipts. Secondary
  receipt responses now use receipt read/owner/driver scope. The authorized
  money adjustment itself still succeeds.
- Delivery users explicitly granted ad financial actions could create, edit,
  stop, or replay unassigned ads. These routes now enforce the same assignment
  boundary as normal reads and generic edits, including locked and final-plan
  checks. Assigned-driver, employee, and administrator controls are tested.

### Delayed imports and form completion

- Permission and audit imports could finish after account, session, permission,
  or local/server-mode changes. File selection, reads and relevant asynchronous
  persistence boundaries now check the original context.
- A local backup could overwrite a new session or a more recently started
  backup import. Context and import-generation checks discard stale work.
- Legacy backup password migration previously placed plaintext/partially
  prepared users into live state before asynchronous hashing completed.
  It now prepares detached user records, then publishes only if the import is
  still current. Default password-migration callers retain their behavior.
- Saving a Clothes product/order/shipment and opening another form before
  completion could close the replacement form. Completion now checks the
  original form node, modal identity and session before closing anything.
- Browser repeats exposed another real phone interaction race: losing input
  focus changed dialog alignment between pointer-down and pointer-up, moving
  Cancel/Save/Close away from the press. A deterministic test with production
  CSS and keyboard handling reproduced six failures across mobile Chromium
  and WebKit. Phone panels now latch their typing alignment until that panel
  is removed; a newly opened panel starts fresh. Existing keyboard/nav and
  visual-viewport scrolling behavior is retained.

### Payment and subscription sync versions

- Attaching payment proof, confirming payment, canceling payment, and canceling
  old subscriptions used wall-clock-only modification versions. A same-time
  update or backward clock could disappear from incremental synchronization.
  Updates now advance from the locked previous version, use compare-and-swap,
  and return matching outer and inner modification metadata.
- No historical balance or ledger was rewritten. Tests include old stored
  records, forward/backward clocks, duplicate confirmation, and rollback.

### Social Studio background work

- Scheduled publishing and automatic comment replies did not recheck whether
  the owner was deleted or the subscription had expired/canceled. Both now
  check current access, including the existing administrator/staff exemptions.
  Blocked posts keep their content and prior results with an explanatory failed
  status, allowing explicit retry after renewal rather than surprise posting.
- `oncePerPerson` could reply twice while the first network request was still
  running, and forgot people outside the latest 1,000 displayed log entries.
  A durable in-progress reservation now precedes Meta calls. Selection and
  reservation are serialized with the existing in-process SQLite guard and a
  PostgreSQL owner advisory lock. The person/page history lookup uses compact,
  bounded keyset batches and includes older records. Network calls are outside
  the reservation lock; normal repeated-reply rules remain available.
- If execution crashes after reserving a reply and its external outcome is
  unknown, the in-progress reservation deliberately remains. It is not
  automatically retried on a timer, because doing so could duplicate a message.
  This is conservative duplicate protection, not an exactly-once guarantee
  across database and Meta outages.

## Regression evidence

The new tests were run against the original behavior first and demonstrated
the defects before runtime changes. Targeted verification after fixes:

- `server/test_second_media_authorization.py`: 33 cases passed.
- `server/test_wallet_clothes_second_review.py`: 22 new cases passed; 90 cases
  passed when combined with existing Clothes/subscription/Ads Studio tests.
- `server/test_social_studio.py`: 54 passed, including 11 second-pass cases.
- `scripts/test-import-boundaries.js`: 53 passed.
- `scripts/test-clothes-submit-boundaries.js`: 27 passed.
- Existing frontend permissions, session privacy and legacy-data tests passed
  again during focused testing. The new frontend suites are wired into
  `npm test` and CI.
- The 80 new frontend import/form checks also passed three additional
  consecutive runs (240 repeated checks).
- Browser assets rebuilt successfully. `npm run sync:mobile` and
  `npm run verify:mobile` passed for source, root, www, Android and iOS web
  artifacts. The startup bundle remains under the existing size guard at
  2,501,095 bytes after the final keyboard fix; architecture and whitespace
  checks passed. All configured frontend suites were rerun successfully after
  that final frontend-only change.
- Fresh dependency audits reported zero known advisories: npm's 212-package
  tree and 49 resolved Python requirements. This does not cover the container
  operating system or prove that unknown vulnerabilities are absent.
- A fresh Bandit pass reported no high-severity findings (79 medium/low
  heuristic flags). New/changed SQL flags were inspected: interpolated names
  and lock clauses are internal constants, and request values remain bound
  parameters. Existing flags retain the first review's triage; a scanner flag
  alone is not a confirmed vulnerability or proof of safety.
- Full `npm test` passed, including every configured frontend suite and
  **1,213 backend tests passed, 13 PostgreSQL-only tests skipped**. Pytest
  reported 2,507 warnings. The backend portion took 717.59 seconds while the
  browser run was executing alongside it.

Browser verification:

- First full run: 46 passed and 5 mobile-WebKit failures (18.8 minutes).
  Four exhausted the whole workflow's timeout; one Cancel/navigation case
  kept its dialog visible after a click. These failures were retained, not
  silently counted as passes.
- Traces of the long workflows showed successful individual checks followed
  by total-budget cancellation. Some apparent missing-control errors occurred
  only after the timed-out browser context was closed.
- After the parallel backend run finished, an unchanged `--last-failed` run
  passed all five cases (5.5 minutes). No assertions, timeouts or application
  code were changed to obtain that pass. However, this alone did not establish
  that the intermittent Cancel failure was resolved.
- Three extra unchanged Cancel/navigation repeats produced one pass and two
  failures. Traces showed the focus-driven dialog movement described above.
  The deterministic production-CSS/pointer regression then reproduced it in
  both mobile engines, leading to the narrow alignment-latch fix.
- `scripts/test-modal-keyboard-stability.js`: before the latch, 12 passed and
  6 failed; after it, all 18 passed across desktop Chromium, mobile Chromium
  and mobile WebKit. It uses real pointer down/up and preserves production
  focus tracking, and checks Save/Cancel/Close, reopening and short viewports.
  This suite is part of `npm run test:e2e` and thus the browser CI job.
- After rebuilding, all 9 targeted application-browser scenarios passed
  (4.5 minutes): screen-size/landscape coverage, editable record forms, and
  keyboard/Cancel/navigation behavior in desktop Chromium, mobile Chromium,
  and mobile WebKit. Assertions and test timeouts were not loosened. This was
  a focused post-fix run, not another complete 51-scenario run.

Local verification logs: `.tmp/second-full-tests.log`, `.tmp/second-e2e.log`,
`.tmp/second-browser-state-repeat.log`, `.tmp/second-build.log`,
`.tmp/second-mobile-sync.log`, `.tmp/second-verify-mobile.log`,
`.tmp/second-npm-audit.json`, `.tmp/second-pip-audit.json`, and
`.tmp/second-bandit.json`. These scratch logs are not release artifacts.
The initial browser failure traces/screenshots/videos are archived in
`.tmp/second-e2e-initial-artifacts.zip`; the unchanged rerun is recorded in
`.tmp/second-e2e-retry.log`.
The final UI build/verification and frontend run are in
`.tmp/second-final-ui-build.log` and `.tmp/second-final-frontend.log`.
Pointer regression evidence is in `.tmp/second-modal-keyboard-before.log` and
`.tmp/second-modal-keyboard-after.log`.
The final application-browser results are in `.tmp/second-final-ui-e2e.log`.

## Limits and deployment

- PostgreSQL could not run locally: Docker's engine pipe is unavailable and
  no `postgres`, `pg_ctl`, `initdb`, installation, or Windows service was found.
  No Docker reset, data deletion, or production database fallback was attempted.
  PostgreSQL-only tests must run in the configured CI/disposable environment.
- Meta calls in regression tests are faked. No real posts, messages, payments,
  or customer records were created by the tests.
- Browser emulation does not replace physical iOS/Android hardware tests.
- The fixes apply when existing records are read or operated on; no financial
  backfill is needed. These response authorization/background-work changes do
  not change ordinary cached-row compatibility semantics.
- Local code and rebuilt browser/mobile assets are not the live site. A
  separate reviewed release to Docker Hub and Jelastic is still required.
