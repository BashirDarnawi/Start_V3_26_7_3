# Deploy (Libyan Spider + PostgreSQL)

> **Which deployment is real?** Production is the Docker image
> `bashird/albayan` running on Libyan Spider Jelastic (JPaaS Docker), behind
> Cloudflare, with a separate PostgreSQL node. You publish with
> `npm run release:image:push` and then press Redeploy in Jelastic - see
> `docs/RELEASE_AND_SAFETY.md`. Variables live in Jelastic under
> Application Servers > Variables; `albayan.env.example` lists them.
> The Caddy/systemd files here are for self-hosting on a plain Linux server
> and are NOT used in production. The AWS document is historical.

This folder contains **example** deployment files for self-hosting Albayan on a plain Linux server.

Files:
- `Caddyfile.example` — HTTPS reverse proxy → `127.0.0.1:8000`
- `albayan.env.example` — environment variables (DATABASE_URL, cookie secure, etc.)
- `albayan.service` — systemd unit (reads env file, runs uvicorn)

## Meta Ads read-only synchronization

Albayan can link one local ad to one real Meta ad and automatically read its
live status, name, campaign, ad set, budget, dates, spend, reach, impressions,
clicks, and results. It is intentionally **read-only**. It does not publish,
pause, edit, or delete anything in Meta, and it never replaces Albayan's
customer, receipt, debt, exchange rate, local status, photos, or notes.

1. Create or select a Meta app that can access your business ad accounts.
2. Create a long-lived server/system-user access token with read access to the
   required ad accounts (`ads_read`). Do not use your Facebook password.
3. In the Jelastic container environment, add:

   ```text
   ALBAYAN_META_ACCESS_TOKEN=your-token
   ALBAYAN_META_APP_SECRET=your-app-secret
   ALBAYAN_META_AD_ACCOUNT_IDS=123456789,987654321
   ALBAYAN_META_BACKGROUND_SYNC=true
   ALBAYAN_META_SYNC_INTERVAL_MINUTES=15
   ```

   The account allowlist is strongly recommended. Enter account IDs without
   the `act_` prefix. `ALBAYAN_META_APP_SECRET` enables Meta's app-secret proof
   on every request and should be configured in production.
4. Restart/redeploy the container. Sign in to Albayan as Admin, open **Ads**,
   press **Meta Sync**, and confirm the connection says **Ready**.
5. Press the small **Link** button on an Albayan ad. Choose the ad account and
   real Meta ad, or paste the real numeric Meta ad ID.

Secrets stay in the server environment. Never enter them into the Albayan web
page, Android/iOS app, GitHub source, a screenshot, or a chat. If a token is
ever exposed, revoke it in Meta immediately and create a replacement.

The worker checks linked ads in small batches. Failed requests use increasing
retry delays; a manual **Sync now** remains available. In a deployment with
multiple app containers, run the background worker in only one container by
setting `ALBAYAN_META_BACKGROUND_SYNC=false` on the other replicas.



## Database migrations

Schema changes are managed with Alembic (see `server/MIGRATIONS.md`).
After deploying code that changes the database schema, run the migration
once. On Jelastic: open the app container's Web SSH, then

```
cd /app && alembic upgrade head
```

(on a local Docker Compose stack: `docker compose exec albayan alembic upgrade head`).
New tables are created by the app itself at start; changed columns are not -
that is what the migration does. Back up the database first (Control Center
> Create encrypted backup now). The app intentionally does NOT auto-migrate.

## Safe backups and restores

Production backups are made by the app itself: encrypted, every 24 hours, on
the /var/lib/albayan volume, optionally copied off-site. Set them up with
`docs/OPERATIONS_SAFETY.md` sections 1-3 and check them in Control Center.

The command below is a second tool for a machine that has `pg_dump` and can
reach the database (for example before a migration). It writes a plain,
unencrypted dump, verifies it and deletes dumps older than the retention:

```bash
python -m server.ops_backup backup --output-dir /secure/albayan-backups --retention-days 30
```

Run it every night from the Libyan Spider/Jelastic scheduler. Store the backup
directory outside the application container (mounted storage or encrypted
off-site storage), because a container replacement can erase local files.
PostgreSQL client tools (`pg_dump` and `pg_restore`) must be available where the
command runs. Verify any saved file without changing the database:

```bash
python -m server.ops_backup verify /secure/albayan-backups/albayan-YYYYMMDDTHHMMSSZ.dump
```

Do not restore over the live database while people are using the app. Restore
first into a separate database, check `/api/health/ready`, sign in, and inspect
customers, receipts, ads, delivery balances, and reconciliation. GitHub CI also
performs a real dump-and-restore drill on every change so the restore procedure
cannot silently rot.

## Publishing Docker Hub images

The normal path is on your computer:

```
npm run release:image:push
```

It runs every check, builds the image and pushes two tags:
`bashird/albayan:latest` and `bashird/albayan:release-<git-sha>-<time>` (the
rollback tag; it is printed at the end). It refuses to run with uncommitted
changes. Docker Desktop must be logged in to Docker Hub with an access token,
never the account password.

Alternative: the manual GitHub workflow **Publish verified Docker image**
builds on GitHub's machines and pushes `bashird/albayan:<full-git-commit>`
(and `latest` only when its option is ticked). It needs the repository secrets
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Use one path or the other for a
release, not both. Jelastic still pulls the image in a separate manual step.
