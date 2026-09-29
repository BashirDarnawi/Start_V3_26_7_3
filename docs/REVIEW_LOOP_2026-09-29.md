# Review loop 2026-09-29 — bugs found and fixed

The owner asked for a bug-hunting loop "until the weekly limit finishes", then
recommendations on how to scale and upgrade (see
[SCALING_AND_UPGRADE_PLAN.md](SCALING_AND_UPGRADE_PLAN.md)). The loop ran nine
rounds; the weekly limit stopped round 9 part-way and the owner asked to finish
only the last run.

## How each round worked

1. 6–9 read-only reviewers, each on one area (a "lens").
2. Every problem they reported went to a second reviewer whose job was to prove
   it wrong. Only problems that survived were fixed.
3. Fixes were made in separate copies of the code (one per batch), each checked
   again by a skeptical reviewer, corrected, then merged.
4. Before each release: every script check, then the full release gate
   (backend tests, 176 browser journeys on 3 browsers, PostgreSQL race tests).

## Numbers

| Round | Areas | Confirmed | Status |
|---|---|---|---|
| 1 | Studio money, permissions, Meta results, jobs, replies, tickets, customer screens, staff screens, Manager changes | 31 | Released |
| 2 | Meta sync, Clothes, database races, speed, wording, ad life cycle, web security, uploads | 36 | Released |
| 3 | Manager money, offline storage, staff roles, wallet/plans, data life cycle, books separation, test gaps, phone app | 30 | Released |
| 4 | Deliveries, import/export, admin tools, merge tools, sign-in, form checks, Social Studio screens, account/consent | 44 | Released |
| 5 | Today's changes, server 500s, time zones, Manager Arabic, print/share, v2 robustness, double submit, customer reach | 34 | Released |
| 6 | Receipt, customer and ad screens, reconciliation, old data, server helpers, user management | 35 | Released |
| 7 | Startup split review, deep-link reload, dead wiring, rounds 3–4 changes, settings, Clothes | 22 | Released |
| 8 | Round 5 changes, staff desk, Social Studio, Meta worker, request wizard, new routes, sign-out | 21 | Released (`release-82be09348da1`) |
| 9 | Receipt money, Arabic coverage (3 other lenses cut by the weekly limit) | 8 | Released (`release-d6e2a57f46fc`) |

About 260 confirmed problems fixed in 73 commits; 34 new backend test files
(`server/test_review_loop_*.py`) plus about 70 new client checks.

Also done: the Manager's Meta dialogs moved out of the startup bundle into a
lazy `meta-tools.js` (the startup budget had ~0.4 KB left; it now has ~21 KB).

## The most important fixes

- **Every server restart damaged receipts** (round 6): the startup repair
  shrank company-covered receipts and erased staff raises of grown receipts.
  Fixed (idempotent, covered floor, staff change kept as a delta). Receipts an
  older version already shrank are NOT grown back automatically — see "Owner".
- Covered receipts re-saved with the gross amount created free customer credit
  (rounds 3, 7) — fixed; round 9 found two more rare paths (open, below).
- Receipt balance transfer could move money twice after a lost reply (round 5);
  the first fix then silently dropped a later identical transfer (round 8) —
  both fixed.
- A driver could reopen a finished delivery with an empty status and record it
  again with less cash (round 4) — fixed.
- Any signed-in account could read staff emails/roles through an empty user
  PATCH (round 5) — fixed.
- A NUL character in the cookie made every page fail (round 5) — fixed.
- Android app lock asked again after every unlock (round 3) — fixed.
- A reviewer could lift the settlement cap by clearing and re-setting a Meta
  link; relinking after spend now needs an admin with a written reason — fixed.
- A stop request did not block launching the ad — fixed (desk shows the chip).
- Deleting an account stranded its wallet money — now refused while money is
  left.
- Closing a month froze ads still running — now a blocker unless forced.

## Round 9 — fixed after the loop (owner asked for it)

All 8 round-9 findings were fixed and released as `release-d6e2a57f46fc`
(commits 76fbfa5, 138ed3b, 9c5ec7e, d6e2a57). A final replay of every
covered-receipt money scenario with real numbers found 4 more problems (two
caused by the first fix): net cash in several rows refused, unsettle of a
cent-net receipt refused, an office-paid delivered receipt re-settled after an
unsettle minting the company share, and an echo re-save putting back the trimmed
house cent. All four are fixed and pinned by `server/test_review_loop_r9_M.py`
(28 tests).

Still not done from round 9: the three lenses that never ran (review of the
rounds 6–7 changes, Studio money second pass, health of the new tests) and the
unverified docs-vs-code findings.

## Owner decisions (not changed without you)

- **Check receipts damaged before the fix**: restarts before release
  `e1a7ec5` may have shrunk some company-covered receipts or undone staff raises.
  A one-time check (compare receipts' amounts with their ads and coverage) is
  recommended before month close.
- Manager "inventory" of ad dollars ignores Studio Meta spend on the shared ad
  accounts (round 3) — decide how Studio spend should count.
- Clothes product photos travel inside every list (round 2) — moving them out is
  safe only as a planned change (it can erase photos if done wrong).
- The admin "TikTok service label" setting is saved but not used — wire or remove.
- A one-time repair of old-debt payment dates (round 6, n=20) — data migration.
- Add User info text for staff who may add users but not grant permissions.

## For you to do

1. Click **Redeploy** on `latest` in Libyan Spider (env albayan). Each release
   today replaced `latest`; the newest includes everything above.
2. Then open `https://albayanhub.com/api/health/ready` and check the release
   name matches the newest one.
