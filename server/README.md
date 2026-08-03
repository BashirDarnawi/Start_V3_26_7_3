# Albayan Server (Multi‑User Internet Backend)

This folder adds a **real backend** so your app can be safely used by **multiple users on the internet**.

Client‑side security (localStorage/IndexedDB) is not sufficient for internet use because anyone can bypass it using DevTools. The backend enforces:
- **Authentication** (HTTP‑only cookie sessions)
- **Password hashing** (PBKDF2‑SHA256)
- **RBAC permissions** (Admin / Employee / Delivery)
- **Server‑side validation + sanitization**
- **Audit logs**
- **Database storage** (**PostgreSQL recommended**; SQLite still works for local testing)

---

## Quick start (local)

### 1) Create a virtual environment + install deps

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2) Create an admin user

```bash
python -m server.create_admin --email admin@yourdomain.com --name Admin
```

### 3) Run the server

From the project root:

```bash
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Open:
- `http://localhost:8000/` (serves `index.html`)

---

## Production deployment (internet) — the safe way

### 1) Run behind HTTPS (required)
Use a reverse proxy like **Caddy** or **Nginx** with TLS.

**Important:** when using HTTPS, set:
- `ALBAYAN_COOKIE_SECURE=true`

Example files are provided in `deploy/`:
- `deploy/Caddyfile.example`
- `deploy/albayan.env.example`
- `deploy/albayan.service`

---

## No domain yet? (Protect data now)

If you don’t have a domain yet, **do not expose the app publicly** over plain HTTP.

The safest approach is:
- Run the stack on the VPS
- Keep it bound to **localhost only**
- Access it through an **SSH tunnel** (encrypted)

Using Docker Compose (recommended), this repo already binds port 8000 to `127.0.0.1` by default.

### Access via SSH tunnel

On your laptop/PC:

```bash
ssh -L 8000:127.0.0.1:8000 root@YOUR_VPS_IP
```

Then open in your browser:
- `http://localhost:8000`

This protects your logins and data traffic **even without a domain/HTTPS**.

### 2) Set env vars

- **ALBAYAN_COOKIE_SECURE**: set to `true` behind HTTPS
- **DATABASE_URL**: PostgreSQL connection string (recommended)
- **ALBAYAN_DB_HOST/PORT/NAME/USER/PASSWORD**: safer alternative to
  `DATABASE_URL` when credentials contain URL punctuation; the Docker Compose
  setup uses these fields automatically
- **ALBAYAN_DB_PATH**: SQLite path (only used if DATABASE_URL is not set)
- **ALBAYAN_SESSION_MS**: session duration in milliseconds
- **ALBAYAN_TRUST_PROXY_HEADERS**: leave `false` unless the API is reachable only
  through a trusted reverse proxy that overwrites `CF-Connecting-IP` and
  `X-Forwarded-For`; otherwise clients can spoof rate-limit identities
- **ALBAYAN_ENABLE_ONLINE_IMPORT**: maintenance-only whole-backup replacement;
  defaults to `false` and should never be enabled while users are writing data
- **ALBAYAN_SETUP_TOKEN**: optional random secret (minimum 16 characters) that
  enables the one-time browser form for creating the first Admin. Generate one
  with `openssl rand -hex 32`, enter it in the setup form, then remove it after
  the first Admin exists. Without it, initialize with `python -m server.create_admin`

### Verified app sign-in links (optional, recommended once the apps ship)

The phone apps receive their sign-in result at `albayan://auth?code=...`. Any
app on the phone can register that scheme, so the sign-in can be claimed by an
impostor app. Setting these publishes the files Android and iOS use to verify
that only the real Albayan app may handle links for this domain. Each route
returns 404 until its variable is set, so leaving them unset changes nothing.

- **ALBAYAN_ANDROID_PACKAGE**: defaults to `com.albayan.app`
- **ALBAYAN_ANDROID_CERT_FINGERPRINTS**: the app's SHA-256 signing
  fingerprints, comma separated, exactly as the Play Console shows them under
  *App signing* (`AB:CD:...`, 32 byte pairs). Include both the upload and the
  Play app-signing certificate. Serves `/.well-known/assetlinks.json`.
- **ALBAYAN_IOS_APP_ID**: `<TeamID>.<bundle id>`, e.g.
  `ABCDE12345.com.albayan.app`. Serves `/.well-known/apple-app-site-association`.

A malformed value is dropped rather than published, because a file that fails
to parse would silently leave verification off. Publishing the files is only
half of the change: the Android manifest also needs an `autoVerify` https
intent-filter and the iOS build needs the Associated Domains entitlement, so
both apps must be rebuilt and resubmitted before verification takes effect.

Example:

```bash
export ALBAYAN_COOKIE_SECURE=true
export DATABASE_URL=postgresql+psycopg://albayan:CHANGE_ME@127.0.0.1:5432/albayan
export ALBAYAN_SESSION_MS=28800000
```

### 3) Backups
For PostgreSQL, use `pg_dump` (nightly recommended).  
For SQLite (dev only), back up the DB file.

---

## Docker (optional)

Build + run:

```bash
docker compose up --build
```

This starts:
- `db` (PostgreSQL)
- `albayan` (FastAPI app on port 8000)

Update the password in `docker-compose.yml` before production:
- `POSTGRES_PASSWORD`
- `DATABASE_URL`

Then create an admin user **inside the container** (example):

```bash
docker compose exec albayan python -m server.create_admin --email admin@yourdomain.com --name Admin
```

---

## API overview

- **POST** `/api/auth/login`
- **POST** `/api/auth/logout`
- **GET** `/api/auth/me`
- **GET** `/api/collections/{collection}`
- **POST** `/api/collections/{collection}`
- **PATCH** `/api/collections/{collection}/{id}`
- **DELETE** `/api/collections/{collection}/{id}`
- **GET** `/api/audit` (Admin only)

Collections used by the frontend:
- `ads`
- `receipts`
- `customers`
- `pages`
- `exchangeRateHistory`
