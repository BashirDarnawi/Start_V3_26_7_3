# Albayan — how to scale and upgrade (recommendations, 2026-09-29)

Written at the owner's request at the end of the 2026-09-29 review loop.
Plain words first, the technical detail for the developer underneath each step.
Nothing here is built yet: each step is a proposal for the owner to approve.

## Where the system stands today

| Part | Today | Limit it will hit first |
|---|---|---|
| Server | ONE container on Libyan Spider (Jelastic), ONE uvicorn process, `--limit-concurrency 128` | CPU of one process; a slow request delays others; a redeploy = a short outage |
| Background work | Runs INSIDE the web process as threads: Meta sync + media download, Social Studio scheduler, Ads Studio jobs loop, backups, staff-alert sender | Cannot run two containers yet: every container would run every loop twice |
| Database | PostgreSQL; most business data in ONE generic `entities` table (`type`, `id`, `data_json` as TEXT); expression indexes cast `data_json::jsonb` | Every read parses JSON text; photos stored as base64 INSIDE the JSON make rows, backups and sync payloads heavy |
| Connection pool | 3 + 2 overflow (default) | Five simultaneous DB users; the jobs threads share the same pool |
| Rate limits | In memory (Redis supported through `REDIS_URL` but not set) | Lost on restart; not shared between containers |
| Sessions | In the database (good: already works with several containers) | — |
| Browser app | Downloads every collection the user may see into IndexedDB, then syncs changes (offline-first) | First load and phone storage grow with the business; big tenants will feel it |
| Code size | `server/main.py` 13.7k lines (cap 14.2k); startup bundle `script.js` has ~350 bytes of budget left | Every new Manager feature must first move code out |
| Releases | Built and pushed from the owner's laptop (`npm run release:image:push`), Redeploy clicked by hand | Depends on one machine; no staging environment |

## Step 0 — this week, no code (settings only)

1. **Database pool 5 + 5.** Set `ALBAYAN_DB_POOL_SIZE=5` and `ALBAYAN_DB_MAX_OVERFLOW=5` in Jelastic. The jobs threads and the web requests stop competing for 5 connections.
2. **Proxy headers and origin secret.** Set `ALBAYAN_TRUST_PROXY_HEADERS=true` and `ALBAYAN_ORIGIN_SECRET` + the Cloudflare Transform Rule (docs/OPERATIONS_SAFETY.md section 7). Rate limits and audit IPs then see the real customer, not Cloudflare.
3. **Give the container and the database more room** (vertical scaling is the cheapest first step): about 2 vCPU / 2–4 GB for the app node, and enough cloudlets for PostgreSQL that the whole working set fits in memory.
4. **Backups you have actually restored.** Keep the nightly dump plus off-site copy (`ALBAYAN_BACKUP_S3_BUCKET`), and once a month restore it into a throw-away environment (runbook RUNBOOK.md). A backup that was never restored is only a hope.
5. **Alerts to a phone.** Set the staff alert channel so money-scan, Meta-key and heartbeat alerts reach someone within minutes.

## Step 1 — next 1–2 months (makes the current single server much lighter)

1. **Move photos and videos out of the database** into object storage (S3-compatible: Libyan Spider object storage, Cloudflare R2 or AWS S3). Store only the file key in the JSON. Effect: rows shrink from hundreds of KB to a few hundred bytes, sync and backups become many times faster, the database stops growing with every picture. Serve through short-lived signed URLs (already used for media today).
2. **Turn `data_json` into a real `JSONB` column** (one additive migration: new column, backfill in batches, switch reads, drop the text column later). PostgreSQL then stops parsing JSON text on every query and can use GIN / expression indexes directly.
3. **Finish the module split (decision D36):** CL-01 (Clothes out of `main.py` into `server/systems/clothes/`), then the Manager core into `server/systems/manager/`. `main.py` becomes a thin app that mounts routers. This is what makes safe changes possible again; today every Manager change fights the 14,200-line cap.
4. **Lazy-load more of the startup bundle** (forms/modals and import/export into their own bundles, like `admin-tools.js`). Frees budget and makes the first screen faster on phones.
5. **Measure before tuning:** turn on `pg_stat_statements` and the slow-query log (for example over 500 ms), and add an error tracker (a self-hosted GlitchTip/Sentry) so real slow paths and errors are seen, not guessed.

## Step 2 — when one server is not enough (run two or more containers)

Do these in this order; skipping the first one would double every background action.

1. **One leader for background work.** Either
   - a PostgreSQL advisory-lock lease per loop (`pg_try_advisory_lock`) so only one container runs the Meta sync, Social Studio scheduler, studio jobs, backups and alert sender, or
   - better: a separate **worker container** from the same image with a switch such as `ALBAYAN_ROLE=worker` (web containers set `ALBAYAN_ROLE=web` and start no threads).
   The ledger idempotency keys already stop double money moves, but double Meta calls and double alerts would still happen without this.
2. **Redis for rate limits and short caches** (`REDIS_URL` is already supported by `server/rate_limiter.py`).
3. **Two web containers behind the Jelastic load balancer**, health check `/api/health/live`, readiness `/api/health/ready`. Redeploys become zero-downtime (one container at a time).
4. **PgBouncer** (transaction pooling) in front of PostgreSQL once there are several containers, so connections stay few and cheap.

## Step 3 — growth (thousands of customers, years of data)

1. **Stop sending the whole dataset to every browser.** Keep offline-first for the current month and open work, and read older months page by page with server-side search/filters (the list routes already support `limit`/keyset paging).
2. **Archive closed months** into cold tables (or a read-only archive schema); month-close already freezes them.
3. **Partition `audit_logs` by month** and drop old partitions instead of deleting rows.
4. **A read replica** for reports, exports and the integrity scan, so they never slow the live screens.
5. **Queue for Meta calls** with per-account budgets (the call lanes are the first step), and webhooks instead of polling wherever Meta approves them (App Review).

## Step 4 — product and platform upgrades

1. **Meta:** Business Verification → App Review (`ads_management`, `pages_messaging`, Instagram) → automatic campaign creation (created PAUSED for staff) and private replies at scale. One system-user key with expiry alerts (decision D35).
2. **Releases without the laptop:** the GitHub publish workflow (task P0-11) with Docker Hub secrets, plus a **staging** environment (a Jelastic clone) where every image runs before `latest` is redeployed.
3. **Security upgrades:** two-step login for admins and staff, idle-session timeout, CSP nonces (remove `unsafe-inline`), hash-locked Python requirements, automatic dependency updates.
4. **Customers:** WhatsApp/SMS notifications (decision D13), self sign-up, the store app (Capacitor build exists), Arabic web font (D3).
5. **Money:** daily automatic reconciliation report to the owner (the integrity scan already computes it), and monthly statements for customers.

## Suggested order and rough effort

| When | What | Effort |
|---|---|---|
| This week | Step 0 (settings, restore drill, alerts) | hours, owner + ops |
| Month 1 | Media to object storage; JSONB column; CL-01 | ~2–3 weeks developer |
| Month 2 | Manager module split; lazy bundles; error tracker + slow-query log | ~2–3 weeks |
| When traffic needs it | Worker role + Redis + 2 web containers + PgBouncer | ~1–2 weeks |
| Later | Paged history, archives, audit partitions, replica, Meta approvals, CI + staging, 2FA | ongoing |
