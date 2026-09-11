# Deeper bug and security review — 11 September 2026

Follow-up: the findings below were subsequently implemented and tested locally.
See `DEEP_REVIEW_FIXES_2026-09-11.md` for the changes, final verification, and
release limitations. This document preserves the original audit evidence.

## Result in plain language

The normal test suite passes, but additional edge-case tests found more problems.
The most important ones concern company-paid customer debt, refunds, and unused
receipt money. There are also privacy/session timing bugs and a background task
that can delay Facebook synchronization.

This report records **nine confirmed code/behavior findings** and **two separate
security-hardening concerns with explicit limitations**. These findings are not
evidence that anyone has hacked the site.

The review used the current local working tree based on `4e3df8c`, including the
previous review's uncommitted fixes. No application-source fixes were applied in
this second audit. Only this report and isolated audit probes were added. No
production customer data was changed, and nothing was committed, pushed, or
deployed. Earlier local implementation changes remain intact.

## Fix first: financial correctness

### D1 — P1: refund undo can charge company-covered money to the customer again

Locations: `server/company_debt_coverage.py:174–179` and
`server/main.py:7561–7563`.

Reproduced using the actual APIs with an in-memory test database:

1. A $200 unpaid receipt backs a $100 ad.
2. Apply a $20 partial refund.
3. Record that the company covers $40 of the debt.
4. Undo the refund.

Every request succeeds, but the final $100 ad has **$100 customer debt plus $40
company funding**. The coverage operation changes current allocations without
updating the saved pre-refund allocation baseline. Undo restores that stale
baseline while retaining the company allocation.

Suggested fix: treat refund baselines and current funding as one financial
lifecycle. Coverage during an active refund must either adjust the baseline
correctly or be explicitly rejected with a clear explanation. Validate the sum
of all funding sources before committing. Do not blindly rewrite old records.

### D2 — P1: settling company coverage makes real unused customer money unavailable

Locations: `server/main.py:6948–6954`; transfer counterpart at
`server/main.py:6753–6765`.

Reproduction: a $200 receipt funds a $100 ad, the company covers $40, and the
customer settles. The receipt correctly records $160 customer cash, while the
ad uses $60 customer cash plus $40 company funding. The customer therefore has
**$100 unused cash**.

Both spending that $100 on another ad and transferring it to another customer
fail with HTTP 409, reporting insufficient balance. The validators count company
funding against a receipt total that now represents customer cash only.

Suggested fix: make capacity checks distinguish customer cash, unpaid liability,
and company funds. Use the same definitions in ad funding, receipt transfers,
settlement, and the displayed balances. Add tests before changing shared helpers
because unpaid-receipt capacity follows different rules.

### D3 — P1: editing a receipt directly leaves its outstanding debt incorrect

Locations: `server/main.py:9278` and `server/settlement_truth.py:193–196`.

Reproduction: create a $100 unpaid receipt, cover $40 from company funds, then
edit its gross amount/debt to $150 with matching LYD fields. The edit succeeds,
but `customerOutstandingUSD` remains **$60 instead of $110**.

The settlement helper exits when paid/unpaid status has not changed. The prior
review fixed ad-driven receipt growth, but not this direct receipt-edit path.
Other financial readers trust the saved outstanding summary.

Suggested fix: recompute derived debt fields whenever a relevant money field
changes, using one canonical calculation shared across mutation paths. Keep
historical customer receipts intact until any repair is previewed and approved.

### D4 — P2: simultaneous coverage and ad editing can produce a server error

Locations: `server/company_debt_coverage.py:1327,1349` and
`server/main.py:8075,8250`.

Confirmed against disposable PostgreSQL 16 with two real concurrent API calls:
company coverage locks the customer before the ad; ad editing locks the ad before
the customer. A synchronization hook controlled only the timing of those real
locks. PostgreSQL detected a deadlock: coverage returned **HTTP 500**, while the
ordinary ad-note edit returned 200. The failed transaction rolled back; no
corruption was observed.

Suggested fix: establish one lock order across financial operations. Consider
bounded transaction retries for recognized deadlocks, preserving idempotency
and returning an actionable conflict rather than an unexplained server error.

### D5 — P2: payment-request retries do not verify the currency

Location: `server/wallet_payments.py:425–432`.

A request for `amountMinor=1000`, currency USD, and method `adfali` was repeated
with the same operation key and amount but currency LYD. The server returned
HTTP 200 and the original **USD** request instead of rejecting the changed
instruction. The duplicate-operation comparison omits currency.

Suggested fix: include currency in the operation comparison and test both exact
retries and conflicting retries. This proof did not call a payment provider or
move any real money.

## Privacy and session timing

### D6 — P2: the company-debt dialog remains visible after session expiry

Locations: `src/10-live-sync.js:1537–1595` and
`src/13-filters-helpers.js:4800–4927`.

An isolated Chromium test opened the real company-debt coverage dialog with a
synthetic customer and $120 debt, then invoked the real session-expiry handler.
The application became signed out and cleared its data, but the body-mounted
dialog still displayed the customer's name and debt over the signed-out page.

Suggested fix: centrally remove all sensitive body-mounted dialogs and clear
their local drafts on logout, expiry, and permission changes, before asynchronous
storage work. Test the complete dialog inventory, not just the main app region.

### D7 — P2: a delayed native photo can enter a different receipt/user's form

Location: `src/01c-native-services.js:233–260`.

The camera result's form/session context is checked before awaiting photo-file
conversion, but not again afterward. The isolated proof started conversion for
receipt A, changed the user and form to receipt B while conversion was pending,
then released the result. The actual routing function sent the old photo to
receipt B's upload handler under the new user's state.

Suggested fix: carry an immutable user/session/form identity through the camera
operation and retries; revalidate after each await and immediately before routing.
Do not discard the identity during a retry. Reject stale results safely.

This is a source-function proof with a stubbed file conversion/upload boundary,
not a real iPhone/Android camera capture or an observed live data leak.

### D8 — P2: a late identity response can refill a cleared session cache

Location: `src/09-api-auth.js:304–324`; cache reset at
`src/10-live-sync.js:1537–1539`.

An isolated proof held an old administrator's `/auth/me` result, advanced the
session epoch, cleared caches, and installed a different current user. Releasing
the old result repopulated `_sessionCache`; the next identity lookup returned the
old administrator even though the current user was different.

Suggested fix: bind identity requests and cached identity to the session epoch
and user, discard stale responses, and ensure callers recheck identity before
applying asynchronous results.

The confirmed scope is incorrect client-side cache identity. **No bypass of
server authorization or successful unauthorized API action was demonstrated.**
Additional authentication paths still need deeper validation.

## Reliability

### D9 — P2: photo archiving blocks the main Facebook synchronization worker

Locations: `server/meta_ads.py:4606`, `server/meta_ads.py:4621–4702`, and
`server/meta_ads.py:4944–4955`.

The worker periodically performs page-name lookup and a batch of up to 20 image
downloads synchronously on the same thread that discovers and synchronizes ads.
Each image fetch has a 20-second timeout. There is no separate execution lane,
despite comments describing one.

A deterministic fake-clock test of the real worker loop modeled a 400-second
archive batch. Discovery was delayed by 402 seconds, even with a configured
10-second discovery interval. No real waits or Meta requests were used. This
demonstrates scheduling blockage, **not a measured live delay or a guarantee
that a batch finishes within 400 seconds**; HTTP timeouts are not necessarily a
whole-job deadline.

Suggested fix: use a separate bounded media/name worker or a strict short work
budget that yields to discovery. Expose last successful discovery, backlog,
rate-limit backoff, and media failure status separately.

## Security-hardening concerns — separate from demonstrated attacks

### H1 — Redirect validation is missing from the server-side media fetch

Locations: `server/meta_ads.py:449–470` and `server/meta_ads.py:4595–4617`.

The initial URL check rejects literal private IPs and non-HTTPS URLs, but
`httpx.Client(follow_redirects=True)` follows redirects without repeating those
checks. A completely mocked transport showed an accepted HTTPS media URL
redirecting to a loopback HTTP URL and returning archived data. **No real
internal-network request was made.** DNS results are also not checked by the
initial string validator.

Important limitation: normal ad/page mutation APIs protect these Meta-owned URL
fields. No ordinary user's path for injecting a malicious URL into them was
demonstrated. Therefore this is a conditional server-side request-forgery risk,
not a confirmed unauthenticated exploit.

Suggested hardening: restrict media destinations appropriately; reject redirects
or validate every hop and resolved destination; enforce an overall byte/time
budget and network egress restrictions. Preserve legitimate Facebook CDN images
when designing the restriction.

### H2 — Local runtime database files can enter the Docker image

Locations: `.dockerignore` and `server/Dockerfile:50`.

The Dockerfile copies the entire server directory. Docker exclusions do not
exclude `server/data/` or database files. The existing local diagnostic image
contains `/app/server/data/albayan.db` (110,592 bytes), copied from the workspace.
Read-only row-count checks found **zero users, sessions, entities, audit logs,
password resets, and stored password hashes** in that particular database.

Thus no actual customer-data/credential exposure was observed here. The packaging
rule could still include real local data in a future build.

Suggested hardening: exclude runtime databases, backups, key material, and other
local state explicitly. Add an image-content regression check; do not delete
the user's database as a workaround.

## Tests and checks performed in this audit

| Check | Result |
| --- | --- |
| Full `npm test` pipeline | Passed |
| Backend pytest suite | **648 passed, 7 skipped**; skipped cases require explicit disposable PostgreSQL configuration |
| Browser suite | **27 passed** across desktop Chromium, mobile Chromium, and mobile WebKit |
| Frontend permission checks | **223 passed** |
| Mobile UI checks | **139 passed** |
| Money checks | **43 + 6 passed** |
| Profitability checks | **10 passed** |
| Prior review behavior regressions | **15 passed** |
| Architecture, mobile configuration, build-safety checks | Passed |
| Source/root/www/Android/iOS asset consistency | Passed |
| Additional financial cases | **200 passed, 5 failed**; failures reproduce D1–D3 and D5, with two independent D2 operations |
| Actual PostgreSQL concurrent-operation probe | Confirmed D4; disposable schemas and audit-owned containers/volumes removed |
| Additional frontend probes | Three successfully reproduced D6–D8 |
| Mocked media redirect and worker scheduling probes | Two successfully reproduced H1 and D9 |
| JavaScript syntax | **53 files passed** `node --check` |
| Python static security scan | **90 files, 50,204 code lines**, no parser errors; raw warnings manually triaged |
| `npm audit --audit-level=low` | No known vulnerabilities reported |
| `pip-audit -r server/requirements.txt` | No known vulnerabilities reported |
| Focused credential-marker search | 246 source/config/document files checked; no candidate strong-token/private-key markers found |
| `git diff --check` | Passed |

The new probes that return success intentionally assert the observed bad behavior;
their success does **not** mean the affected feature is fixed. The financial
tests instead assert the desired invariant, so five currently fail. They remain
isolated from the normal passing release suite and should become permanent
regression tests when the corresponding fixes are implemented.

The Python scanner produced 3,694 raw warnings, mostly test assertions and
low-severity patterns. It reported zero high-severity scanner findings, which is
not a safety certificate. Dynamic SQL and subprocess warnings were inspected;
this review did not establish SQL injection or command injection from those
warnings. The environment-configured operational webhook was not treated as an
ordinary user-controlled URL.

The browser run also logged one Windows connection-reset callback warning while
all 27 cases passed. The backend run emitted 1,960 warnings. Deprecation/warning
cleanup is worthwhile, but these counts are not additional confirmed security
vulnerabilities.

## Evidence and reproduction notes

Local ignored audit files:

- `.tmp/security-audit-20260911/test_finance_adversarial.py`
- `.tmp/security-audit-20260911/financial-results.log`
- `.tmp/security-audit-20260911/probe_financial_pg_deadlock.py`
- `.tmp/security-audit-20260911/frontend-proofs.js`
- `.tmp/security-audit-20260911/test_meta_audit.py`
- `.tmp/deep-audit-npm-test.log`
- `.tmp/deep-audit-browser.log`
- `.tmp/bandit-security-20260911.json`

The financial and media probes force in-memory SQLite. The browser privacy proof
routes all network traffic locally/mocks it; the media proof uses MockTransport.
The PostgreSQL probe requires an explicitly configured, guarded loopback test
database and creates/removes its own random schema. Never aim these probes at
production. Pre-existing containers not owned by this audit were left alone.

## Coverage limits and recommended next work

This was a broad inventory, automated parsing/scanning, complete existing-test
run, and targeted manual review with additional adversarial cases. It was **not
an exhaustive manual sign-off on every line**, nor proof that every business
workflow or security boundary is correct. Generated copies were verified instead
of being counted as separate independently reviewed applications.

No live penetration test, live-data audit, real Meta account operation, payment
gateway charge, real-device camera/biometric test, or Jelastic infrastructure
inspection was performed. Dependency scans cover known published advisories at
scan time, not unknown vulnerabilities or every deployed configuration. The
credential scan did not inspect all Git history or all possible secret formats.

Recommended implementation order:

1. Correct D1–D3 and add invariant tests for every combination of receipt edits,
   stop/refund/undo, company coverage, settlement, and paid-balance transfer.
2. Fix shared transaction lock ordering and payment retry currency checks.
3. Centralize session/dialog cleanup and guard all asynchronous photo/identity
   results against a changed user or form.
4. Isolate slow Meta work and harden media egress and Docker packaging.
5. Promote the new proofs into permanent tests, rerun PostgreSQL concurrency and
   all browser suites, then prepare a versioned release separately.

Do not run automatic historical financial repairs or deploy these unfinished
audit findings without a separate verified implementation and release step.
