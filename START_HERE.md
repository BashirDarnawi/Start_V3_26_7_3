# START HERE — Albayan Platform

Albayan is a business-management platform for an advertising office:
customers, ads, pages, receipts (with split payments, refunds, serial
numbers, exchange rates), deliveries with driver reconciliation, a wallet
ledger, user roles/permissions, audit log, backups, Arabic/English (RTL),
and dark mode.

## The important facts

- **Frontend:** vanilla JavaScript source modules in `src/`, ordered by
  `src/manifest.json`. `npm run build` generates `script.js`, lazy bundles
  (`studio.js`, `clothes.js`), and Tailwind CSS. Never edit generated bundles.
  `index.html` and `style.css` remain editable root files.
- **Backend:** `server/` — Python FastAPI + PostgreSQL (SQLite for dev).
  Serves the frontend and a JSON API with cookie-session login.
- **Two data modes, detected automatically at startup:**
  - *Server mode* — the app is served by the backend; all devices share the
    database and live-sync every few seconds.
  - *Local mode* — no backend found; everything is stored in the browser
    (IndexedDB) and works offline.
- **Mobile:** `android/` and `ios/` are Capacitor shells that load the copy
  of the frontend in `www/`. Run `npm run build` then `npm run sync:mobile`
  and `npm run verify:mobile` before packaging, so mobile gets the same code.
- **Docs:** `PLATFORM_FOUNDATION.md`, `MONEY_PLATFORM_ROADMAP.md`, and
  `CONTRIBUTING.md` hold the platform rules (stable service IDs, append-only
  wallet ledger, etc.). Anything in `docs/archive/` is a historical report —
  do not trust it as a description of the current code.

## Run it

```bash
# Frontend only (local mode)
npx serve
# First run shows a setup screen to create your admin account.

# Full stack (server mode) — requires Docker
docker compose up --build
# Visit http://127.0.0.1:8000
```

There are **no default credentials**. Create the first admin via the
first-run setup screen (local mode), `server/create_admin.py`, or the
`ALBAYAN_BOOTSTRAP_ADMIN_*` environment variables (server mode).

## Tests

```bash
# Backend tests (from the project root; needs Python + server/requirements.txt)
npm test
# Real browser flows use a disposable LOCAL database, never your live server:
npm run test:e2e
# Confirm web AND Android/iOS copies include every generated bundle:
npm run verify:mobile
```

## Safe changes and releases

Read `CONTRIBUTING.md` and `docs/RELEASE_AND_SAFETY.md` before edits or publishing.
Money must remain consistent across receipts, ads, customers, company coverage,
refunds, and currency conversion. Test combinations and repeated saves, not just
each feature alone. Do not automatically rewrite historical money records.

Production uses **Docker Hub `bashird/albayan` → Libyan Spider Jelastic**.
A Git commit, an image push, a Jelastic redeploy, and a mobile-app build are
different steps. `npm run release:image:push` runs checks, builds, and pushes a
versioned rollback tag plus `latest`; it does not redeploy Jelastic. Only run
publishing commands with the owner's explicit authorization.
