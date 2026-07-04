# Contributing / Editing Guide (Albayan Platform)

This repository is not “just a single dashboard” anymore. It is a **platform foundation** intended to grow into:

- A **multi‑service web platform** (Services Hub)
- A **mobile app** connected to the same backend (future)
- A **wallet + subscription** system that powers paid services
- Future AI features (assistive, not destructive)

If you are a developer **or an AI** making changes: read this first.

## How to edit the frontend (IMPORTANT)

`script.js` is a **GENERATED file** — never edit it directly. The real source
code lives in `src/` (17 ordered files, see `src/README.md` for what's where).
Workflow:

```
# 1. edit the right file in src/
npm run build:js      # 2. rebuild script.js
npm run sync:mobile   # 3. push to the iOS/Android app folders
```

If you add/change Tailwind classes built from data (like `bg-${color}-50`),
also update the safelist in `tailwind.config.js` and run `npm run build:css`.

## Non‑negotiable rules (do not break)

- **Stable IDs**: never change service `id`s (they become routing, mobile deep links, subscription keys).
- **Wallet is a ledger**:
  - no `balance` field stored anywhere
  - never edit/delete `walletTransactions` (use a new compensating/reversal transaction)
- **Subscription history is audit data**:
  - never delete subscription records
  - cancellations must be recorded, not removed
- **Large data** must remain IndexedDB-friendly:
  - new big arrays must be added to `PERSISTED_COLLECTIONS`
- **Security**:
  - never store plaintext passwords/tokens
  - never log secrets (audit logs must redact)
- **Isolation**:
  - services should not tightly couple to each other’s internal data
  - shared behavior goes into platform helpers, not copy/paste

## Where the platform “truth” lives

- **Services catalog**: `src/05-state-services.js` → `const SERVICES`, `const SMART_SYSTEMS_CHILDREN`
- **Subscriptions source of truth**: `state.serviceSubscriptions` + `SUBSCRIPTIONS.*`
- **Wallet source of truth**: `state.walletTransactions` + `WALLET.*`
- **Access checks**: `hasSubscription()` + `checkServiceAccess()`
- **Persistence**: `PERSISTED_COLLECTIONS` + IndexedDB helpers (`saveCollectionToIndexedDB` / `loadCollectionFromIndexedDB`)

## Adding a new service (future‑proof way)

1) Add a record to `SERVICES`:
- `id`, `order`, `name/nameAr`, `icon`, `color`, `description/descriptionAr`
- `requiresSubscription: true|false`
- `subscription: { price, durationDays }`
- `openView: 'service-placeholder'` (or a real view key if you implement one)

2) If the service is not ready: set `comingSoon: true`.

3) If you need a new page/view:
- Add a new `case` in `renderView()`
- Keep it self-contained and avoid changing existing views

## Adding a new persisted collection

When you add a new “big” feature that stores many records:

1) Add `state.<collectionName> = []`
2) Add `<collectionName>` to `PERSISTED_COLLECTIONS`
3) Ensure it’s initialized in `loadState()` compatibility section (if needed)
4) Add it to import/export if it should be portable across devices

## Mobile-ready mindset (so we don’t restart later)

Keep “core logic” portable:

- Prefer pure functions (inputs → outputs) for platform logic (wallet, subscriptions, validation)
- Keep UI-specific code (DOM) separate from data and rules
- Avoid hardcoding flows that assume “desktop only”

## AI features (future)

AI should be used as an **assistant**:

- AI can suggest edits/actions
- Human confirmation + validation must happen before writes
- Always log important platform actions into audit logs (with redaction)

## Related docs

- `PLATFORM_FOUNDATION.md` (architecture + portability)
- `MONEY_PLATFORM_ROADMAP.md` (payments/POS/cards roadmap + money safety rules)


