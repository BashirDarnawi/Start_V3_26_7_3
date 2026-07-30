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

The backup directory must be on a persistent Jelastic volume. After applying
the variables, redeploy or restart the application container. Use **Control
Center > Create encrypted backup now** once to verify the setup.

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
