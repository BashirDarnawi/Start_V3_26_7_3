# Platform Foundation (Services + Wallet + Subscriptions)

This project is now structured as a **multi‑service platform** (Services Hub) with a reusable **Wallet** + **Subscriptions** core, designed so you can keep adding services without breaking existing ones (including **Albayan Manager**).

## What’s the “core”?

All future services share the same platform primitives:

- **Service Catalog**: `SERVICES` (and `SMART_SYSTEMS_CHILDREN`) define what exists, how it looks, and where it opens.
- **Subscriptions**: `state.serviceSubscriptions` is the source of truth for who has access to what.
- **Wallet Ledger**: `state.walletTransactions` stores immutable money movements (top-ups, transfers, payments).

Both `walletTransactions` and `serviceSubscriptions` are persisted in **IndexedDB** so they can scale to large datasets.

## Adding a new service (future‑proof way)

Edit `script.js` → find `const SERVICES = { ... }` and add a new entry:

- **Required fields**:
  - `id` (stable string, never change after launch)
  - `order` (sorting on Services Hub)
  - `name` / `nameAr`
  - `icon` / `color`
  - `description` / `descriptionAr`
- **Navigation**:
  - `openView`: where it opens (default is `service-placeholder`)
    - Example: `openView: 'service-placeholder'`
    - For Smart Systems: `openView: 'smart-systems'`
- **Access control**:
  - `requiresSubscription: true|false`
  - `subscription: { price: number, durationDays: number }`

If the service is unfinished, set `comingSoon: true` and it will show a “Coming soon” badge.

## How access works

When a user clicks a service card:

- **Coming soon** → the UI blocks access.
- **Requires subscription** → a modal prompts to subscribe.
- **Subscribed** → navigation proceeds.

Access checks use:

- **Primary**: `state.serviceSubscriptions` (ledger of subscription records)
- **Fallback**: `currentUser.subscriptions` for older backups/compatibility

## Wallet model (safe + portable)

The wallet is **ledger-based** (event-sourced):

- Transactions are **append-only** (`walletTransactions`)
- Balance is computed from history, not stored as a mutable field
- Wallet transactions are **blocked from update/delete** in the generic CRUD helpers

This is the same approach used by payment systems because it prevents “wrong edits” from silently destroying balances.

## Mobile + multi-language portability

To port later (mobile apps, different language, or a new backend):

- Treat these as your platform tables/collections:
  - `users`
  - `walletTransactions`
  - `serviceSubscriptions`
  - (existing business collections: `ads`, `receipts`, `customers`, `pages`, ...)
- Keep the same record shapes (plain JSON), and rebuild only UI + transport layer.

## AI integration (future)

When you add AI to any service:

- AI should **suggest** actions, not directly write data.
- Final writes should go through:
  - validation
  - permissions
  - audit logs

That keeps the platform safe even if AI output is wrong.

## Future roadmap (guiding plan)

This is the long-term direction so every new change keeps the same goal in mind:

- **Mobile apps**: build Android/iOS apps that connect to the same backend and reuse the same data shapes.
- **Billing & payments**: turn wallet + subscriptions into real billing (with proper receipts, refunds, and compliance).
- **More services**: keep adding services in the hub without rewriting the app (config-driven services + isolated views).
- **AI per service**: AI assists inside each service (suggest/preview), but writes must go through validation + permissions + logs.
- **Portability**: keep platform logic (wallet/subscriptions/access rules) portable so it can be re-implemented in any language if needed.

## Non‑negotiables (do not break)

- **Stable service IDs**: never rename service `id`s after launch.
- **Ledger-only money**: never store “balance” as a mutable field; compute from `walletTransactions`.
- **Immutable history**: do not delete wallet/subscription history; use reversals/cancellations.
- **Security always**: no plaintext secrets; audit logs must redact.
- **Huge data safe**: any large collection must be persisted in IndexedDB (`PERSISTED_COLLECTIONS`).


