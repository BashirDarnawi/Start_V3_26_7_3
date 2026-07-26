# Deploy (Libyan Spider + PostgreSQL)

> **Which deployment is real?** Production is hosted with **Libyan Spider**, not
> AWS. The exact release method depends on whether the active Libyan Spider
> service is JPaaS Git, Docker Compose, or cPanel. Confirm the service in the
> hosting dashboard before deploying. The AWS document is historical guidance.

This folder contains **example** deployment files for running Albayan as an always‑online multi‑user app.

Recommended stack:
- **Ubuntu VPS**
- **PostgreSQL**
- **Caddy** (automatic HTTPS) or Nginx
- **systemd** service for the app

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
After deploying new code that changes the database schema, run once:

```
alembic upgrade head
```

(inside Docker: `docker compose exec albayan alembic upgrade head`).
Back up the database first (`pg_dump`). The app intentionally does NOT
auto-migrate at startup.

## Safe backups and restores

Albayan now includes a backup command that uses the same database settings as
the server. It creates an atomic backup, verifies that PostgreSQL can read it,
writes a SHA-256 checksum, and removes backups older than the chosen retention.

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

The manual GitHub workflow **Publish verified Docker image** runs the safety
tests, builds the production image, starts that exact image, checks database
readiness, and only then pushes:

- `bashird/albayan:<full-git-commit>` (immutable rollback version)
- `bashird/albayan:latest` (only when the workflow option is enabled)

Configure the GitHub `production` environment with repository secrets
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Use a Docker Hub access token, not
your account password. Jelastic still pulls the image from Docker Hub in a
separate manual deployment step. Keep the immutable tag shown by the workflow;
it is the safest way to roll back to the exact previous release.
