# Deploy (VPS + Domain + PostgreSQL)

> **Which deployment is real?** There are three deployment descriptions in this
> repo: `docker-compose.yml` (local/simple), this folder's VPS + systemd + Caddy
> examples, and `INFRA_RECOMMENDATIONS_AWS.md` (AWS ECS + ALB + Cloudflare,
> domain `albayanhub.com`) — the AWS document describes the actual production
> setup. The others are alternatives/examples.

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


