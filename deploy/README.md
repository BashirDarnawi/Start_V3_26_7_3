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



## Database migrations

Schema changes are managed with Alembic (see `server/MIGRATIONS.md`).
After deploying new code that changes the database schema, run once:

```
alembic upgrade head
```

(inside Docker: `docker compose exec albayan alembic upgrade head`).
Back up the database first (`pg_dump`). The app intentionally does NOT
auto-migrate at startup.
