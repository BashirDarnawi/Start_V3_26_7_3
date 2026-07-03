# Albayan Money Platform (Roadmap + Security Rules)

This document exists so **every future edit** (human or AI) keeps the same long‑term goal in mind:

> Build a secure, scalable **multi‑currency wallet** that supports: P2P transfers, paying merchants (shops/grocery), service purchases (ads, subscriptions), digital goods (gift cards مثل iTunes), and future integrations (POS terminals, prepaid cards, banks).

## Reality check (important)

- A **pure client-side** wallet (opening `index.html`) can never be “bank-secure”. A user can modify local data.
- “Impossible even for the owner to fake money” is not achievable if one person controls the servers + database.
  - What we *can* do is make fraud **extremely hard + always detectable** using: separation of duties, append‑only ledgers, strong audit trails, approvals, and external reconciliation.
- For real money, you will need: **server mode**, strong ops controls, and **compliance** (KYC/AML, licensing, etc.).

## Non‑negotiable core architecture

### 1) Ledger-based accounting (no mutable balances)

- Never store a “balance” number as truth.
- Store an **append-only ledger** and compute balances from it.
- Corrections use **reversal/compensation** entries, never edits/deletes.

### 2) Idempotency everywhere (no double charging)

Any action that could be retried must include an **idempotency key**:

- Card charge / bank top‑up
- Merchant payment
- P2P transfer
- Gift card purchase
- Refund

The server must guarantee: **same idempotency key → same result**.

### 3) Strong invariants (system must never “lose” money)

For a real money system, implement **double-entry ledger**:

- Every posted transaction has entries whose sum per currency is \(0\).
- You can’t create money unless it is backed by an external funding source (bank settlement, card processor confirmation).

### 4) Multi-currency

- Store amounts in **minor units integers** (no floats).
- Keep balances per currency per user/merchant.
- FX conversions must be explicit transactions with an FX rate captured at time of trade.

## Roadmap (phased, realistic)

### Phase A — In-app wallet (foundation)

- P2P transfers inside the app
- Service purchases (subscriptions, ads) using wallet
- Refunds as reversals
- Limits (daily/monthly) tied to KYC level

### Phase B — Merchants (shops/grocery)

- Merchant accounts + stores
- QR / payment request flow (customer approves payment)
- Receipts + dispute flow
- Settlement rules

### Phase C — Top-ups / cash-out (real rails)

Integrate one or more:

- Bank transfer rails
- Local mobile money / aggregator
- Card payments (requires PCI DSS scope management)

### Phase D — Gift cards / digital goods (iTunes, etc.)

- Inventory source (supplier integration)
- Orders + idempotency + fraud controls
- Delivery of codes + secure storage

### Phase E — POS terminals

- Terminal identity (device keys)
- Merchant/terminal onboarding
- Secure transaction protocol (online-first, offline with strict limits)

### Phase F — Prepaid cards

- BIN sponsor / issuer partner
- Card lifecycle APIs
- AML monitoring + chargeback workflows

## Security & controls (how to make fraud hard + detectable)

- **Separation of duties**: no single admin can mint funds + approve + settle.
- **Approvals**: large adjustments require 2-person approval (4‑eyes principle).
- **External reconciliation**:
  - daily reconciliation against bank/processor statements
  - alerts for mismatches
- **Tamper-evident logs**:
  - hash chaining + anchoring to external immutable storage (WORM/QLDB/etc.)
- **HSM / key management**:
  - signing keys not stored in app code or plaintext env vars

## Compliance (must plan early)

- KYC/AML requirements vary by country.
- Expect: user verification, transaction monitoring, sanctions screening, suspicious activity reporting, data retention, privacy controls.

## Code pointers in this repo

- Services catalog: `script.js` → `SERVICES`, `SMART_SYSTEMS_CHILDREN`
- Wallet: `script.js` → `WALLET` + `state.walletTransactions`
- Subscriptions: `script.js` → `SUBSCRIPTIONS` + `state.serviceSubscriptions`
- Platform docs: `PLATFORM_FOUNDATION.md`, `CONTRIBUTING.md`


