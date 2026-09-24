# Smart Systems — how systems are separated (owner decision D36)

Every Smart System is a **separate module inside one Albayan platform**. The customer keeps one login,
one wallet and one set of subscriptions; the code of each system is kept apart.

## Who is what

| Part | Where the code lives | Record types it owns |
|---|---|---|
| Platform (shared) | `server/*.py` platform modules (db, security, rbac, wallet_payments, payment_methods, subscription_plans, meta_ads client, operations, audit_routes, http_security, …); startup bundle `script.js` (login, routing, design, wallet/plan screens) | `users`, `walletTransactions`, `walletPaymentRequests`, `serviceSubscriptions`, `appSettings` |
| Albayan Manager | `server/main.py` core routes; startup bundle views | `ads`, `receipts`, `customers`, `pages`, `exchangeRateHistory`, `dollarPurchases`, financial closes |
| **Albayan Ads Studio** (`ad_maker`) | `server/systems/ads_studio/`, `src/systems/ads_studio/` → `studio.js` | see `server/systems/ads_studio/__init__.py` `OWNED_TYPES` |
| Clothes System (`clothes_system`) | still `server/main.py` + `src/15b-clothes.js` → `clothes.js` (moves in task CL-01) | `clothesProducts`, `clothesShipments`, `clothesOrders`, `clothesSettings`, clothes mutation markers |

## The rules

1. **Own folder.** Server code in `server/systems/<name>/`; screens in `src/systems/<name>/`, built into the system's own lazy bundle (listed in `src/manifest.json` → `lazy`). Only a tiny loader lives in the startup bundle.
2. **Own data.** A system reads and writes only the record types in its `OWNED_TYPES`. Anything else goes through a platform door.
3. **Platform doors only.** Login/users/permissions, the wallet ledger and payment requests, subscriptions and plans, the Meta client, notifications, audit, design tokens. A system never imports `main.py`; main.py hands it helpers through the router factory's `ctx`.
4. **No system touches another system.** No imports of another system's package, no calls into another system's screen functions, no SQL on another system's record types.
5. **Own switch and tests.** Each system can be switched on/off and tested on its own.

`server/test_system_boundaries.py` and `scripts/test-system-boundaries.js` (in `npm test` and CI) fail the build when a rule is broken.

## Adding a new system (template)

1. `server/systems/<name>/__init__.py` with a docstring and `OWNED_TYPES = frozenset({...})` (new, unique record type names).
2. `server/systems/<name>/routes.py` with a router factory:
   ```python
   from typing import Any, Callable
   from fastapi import APIRouter, Depends, Request

   def create_router(*, current_user_dependency: Callable[..., Any], require_same_origin: Callable[[Request], None], ctx: dict[str, Any]) -> APIRouter:
       router = APIRouter(prefix="/api/<name>")
       # every route: permission check, require_same_origin on writes, ctx["audit"](...) on changes
       return router
   ```
3. Register it once in `server/main.py` next to the other routers (before the SPA catch-all).
4. Screens in `src/systems/<name>/NN-<name>.js`; add a lazy bundle `"<name>.js": ["systems/<name>/NN-<name>.js"]` to `src/manifest.json`, a small loader in the startup bundle (copy `src/15c0-ads-studio-loader.js`), the bundle to the Dockerfile `COPY` line, and the lazy-bundle list in `scripts/test-permissions.js`.
5. A registry entry in `SMART_SYSTEMS_CHILDREN` (`src/05-state-services.js`) with a **new, never-renamed service id** and its subscription.
6. Tests: `server/test_<name>_*.py` and a screens check; `npm test` must stay green, including the two boundary guards.
