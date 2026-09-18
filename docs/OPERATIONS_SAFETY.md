# Albayan operations safety

This guide configures the protections shown in **Daily Control Center**. The
application never sends these secrets to the browser.

## 1. Encrypted daily PostgreSQL backups

Generate one permanent 32-byte encryption key on your own computer:

```powershell
.\.venv\Scripts\python.exe -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('='))"
```

Save that value in a password manager. Losing it means encrypted backups cannot
be restored. In Jelastic, open **Application Servers > Variables** and add:

```text
ALBAYAN_BACKUP_ENABLED=true
ALBAYAN_BACKUP_KEY=<the generated key>
ALBAYAN_BACKUP_DIR=/var/lib/albayan/backups
ALBAYAN_BACKUP_INTERVAL_HOURS=24
ALBAYAN_BACKUP_RETENTION_DAYS=30
```

Keep ALBAYAN_BACKUP_DIR inside /var/lib/albayan. The image declares that
folder as a volume, so Jelastic keeps it when you press Redeploy; a folder
anywhere else is wiped with the container. In Jelastic you can see it under
the container's Volumes tab.

After applying the variables, Redeploy or Restart the application container.
The container log then prints a line starting with "[albayan] boot:" - it must
say backup_key=set. Use **Control Center > Create encrypted backup now** once
to verify the setup (this button allows 6 runs per hour per admin).

How cleaning works: files older than ALBAYAN_BACKUP_RETENTION_DAYS are
deleted before each new backup, but the newest three files are always kept,
even if they are old. A backup more than two intervals late shows up as a
task in Control Center.

## 2. Private off-site backup copy

Use a private S3-compatible bucket with versioning and object retention enabled.
Give its access key permission only to write/read that one backup bucket. Add:

```text
ALBAYAN_BACKUP_S3_BUCKET=<private bucket name>
ALBAYAN_BACKUP_S3_ENDPOINT_URL=<provider endpoint, blank only for AWS S3>
ALBAYAN_BACKUP_S3_REGION=<bucket region>
ALBAYAN_BACKUP_S3_ACCESS_KEY=<restricted access key>
ALBAYAN_BACKUP_S3_SECRET_KEY=<restricted secret>
ALBAYAN_BACKUP_S3_PREFIX=albayan-production
```

The Control Center reports whether the off-site copy succeeded. Never put these
values into chat, Git, frontend JavaScript, or screenshots.

## 3. Restore drill (does not overwrite production)

Copy one encrypted backup to a temporary maintenance machine with the same
`ALBAYAN_BACKUP_KEY`, then run:

```powershell
.\.venv\Scripts\python.exe scripts\restore-encrypted-backup.py albayan.backup.aesgcm restored.dump
```

For PostgreSQL, validate the output with `pg_restore --list restored.dump` and
restore it only into a new empty test database. The helper never touches the
live database.

## 4. Meta instant webhook

Generate a long random verify token and add it only in Jelastic:

```text
ALBAYAN_META_WEBHOOK_VERIFY_TOKEN=<your random verify token>
```

In the Meta app, set the callback URL to:

```text
https://albayanhub.com/api/meta-ads/webhook
```

Use the same verify token in Meta. Subscribe the app to the advertising-account
changes available to your app. The signed webhook is only a wake-up signal;
Albayan still reads the authoritative ad from Meta. Safe polling stays active as
a fallback.

## 5. Operations alerts

Create a private incoming webhook in the business alert channel and add:

```text
ALBAYAN_ALERT_WEBHOOK_URL=<private incoming webhook URL>
ALBAYAN_ALERT_COOLDOWN_SECONDS=1800
ALBAYAN_ALERT_MIN_REQUESTS=50
ALBAYAN_ALERT_ERROR_RATE=0.05
ALBAYAN_ALERT_P95_MS=3000
```

Alerts cover failed backups, failed off-site copies, high server error rate, and
slow server responses. The cooldown prevents repeated alert spam.

## 6. Monthly financial close

At the start of each month, open **Daily Control Center**, select the previous
month, and click **Check month**. Fix the listed problems, then click **Close
month**. Closed receipts, ads, and dollar purchases cannot be edited or deleted.
An Admin can unlock a month only by writing a reason; the action is recorded in
the audit log. Close it again after the correction.

## 7. Lock the server to Cloudflare (origin secret)

Cloudflare sits in front of albayanhub.com. Without this step, anyone who
discovers the Jelastic load-balancer hostname can call the server directly,
skipping Cloudflare's protections and inventing visitor addresses for the
login limits.

Do the steps IN THIS ORDER. If you set the variable before the Cloudflare
rule exists, every page answers "Forbidden" until the rule is added.

1. Make one long random value on your computer and save it in a password
   manager:

   .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))"

2. In Cloudflare: open the albayanhub.com zone > Rules > Transform Rules >
   Modify Request Header > Create rule.
   - Name: Albayan origin secret
   - When: Hostname equals albayanhub.com (add www.albayanhub.com if used)
   - Then: Set static header  X-Albayan-Origin  =  <the value from step 1>
   - Deploy the rule.

3. In Jelastic: Application Servers > Variables, add
   ALBAYAN_ORIGIN_SECRET=<the same value>
   then press Redeploy (or Restart) on the app container.

4. Check: https://albayanhub.com/api/health/ready must still open. A direct
   call to the Jelastic hostname (not through Cloudflare) must now answer 403.

Notes
- These paths stay open without the header on purpose: /api/health,
  /api/health/live, /api/health/ready, /privacy, /delete-account and the
  /.well-known app-link files (Google and Apple crawlers cannot send it).
- To change the secret without downtime: set BOTH values comma-separated
  (ALBAYAN_ORIGIN_SECRET=old,new), redeploy, switch the Cloudflare rule to the
  new value, then remove the old one and redeploy again.
- The phone apps are not affected; they also go through Cloudflare.
- After this is set, the server believes Cloudflare's visitor address only on
  requests that carry the secret, so the login limits cannot be fooled from
  the load-balancer side.

## 8. Health-check addresses

- Uptime monitors, Jelastic health checks and any "is it alive" probe must use
  https://albayanhub.com/api/health/live
  It answers without touching the database, so a busy server is not restarted
  by mistake.
- After a deploy, or when you want to know WHICH release is running, open
  https://albayanhub.com/api/health/ready
  It checks the database and shows `release`, `dialect` and metrics. Do not
  point an automatic monitor at it.
