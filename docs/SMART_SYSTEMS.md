# Smart Systems — how systems are separated (owner decision D36)

Every Smart System is a **separate module inside one Albayan platform**. The customer keeps one login,
one wallet and one set of subscriptions; the code of each system is kept apart.

## Who is what

| Part | Where the code lives | Record types it owns |
|---|---|---|
| Platform (shared) | `server/*.py` platform modules (db, security, rbac, user_directory, wallet_payments, payment_methods, subscription_plans, meta_ads client, operations, audit_routes, http_security, …); startup bundle `script.js` (login, routing, design, wallet/plan screens) | `users`, `walletTransactions`, `walletPaymentRequests`, `serviceSubscriptions`, `appSettings` |
| Albayan Manager | `server/main.py` core routes; startup bundle views | `ads`, `receipts`, `customers`, `pages`, `exchangeRateHistory`, `dollarPurchases`, financial closes |
| **Albayan Ads Studio** (`ad_maker`) | `server/systems/ads_studio/`, `src/systems/ads_studio/` → `studio.js` | see `server/systems/ads_studio/__init__.py` `OWNED_TYPES` |
| Clothes System (`clothes_system`) | still `server/main.py` + `src/15b-clothes.js` → `clothes.js` (moves in task CL-01) | `clothesProducts`, `clothesShipments`, `clothesOrders`, `clothesSettings`, clothes mutation markers |

## The rules

1. **Own folder.** Server code in `server/systems/<name>/`; screens in `src/systems/<name>/`, built into the system's own lazy bundle (listed in `src/manifest.json` → `lazy`). Only a tiny loader lives in the startup bundle.
2. **Own data.** A system reads and writes only the record types in its `OWNED_TYPES`, and its SQL names no table but `entities`. Anything else goes through a platform door (users: `server/user_directory.py`; audit: `ctx["audit"]`). A platform record type (`walletPaymentRequests`, `walletTransactions`, …) never appears in a system's SQL, neither as text nor as a bound value (not even through the door's constant): a door *function* reads those rows (e.g. `wallet_payments.payment_request_belongs_to`, `wallet_ledger_rows`).
3. **Platform doors only.** Login/users/permissions, the wallet ledger and payment requests, subscriptions and plans, the Meta client, notifications, audit, design tokens. A system never imports `main.py`; main.py hands it helpers through the router factory's `ctx`.
4. **No system touches another system.** No imports of another system's package, no calls into another system's screen functions, no SQL on another system's record types.
5. **Own switch and tests.** Each system can be switched on/off and tested on its own.

`server/test_system_boundaries.py` and `scripts/test-system-boundaries.js` (in `npm test` and CI) fail the build when a rule is broken.

## The owner dashboard and the systems

The owner dashboard (Control Center, `src/12b-control-center.js`) is a platform screen. It shows a few
numbers from each system and follows the same separation:

- **A system hands over a summary through its own door, and nothing else.** The Ads Studio's door is on the
  server: the team desk counter `GET /api/studio/staff/pulse` (counts only, never a name or an amount). The
  Clothes System's door is `clothesOwnerSummary()` in its own bundle: how many items are low and what
  customers still owe, taken from the sums its own dashboard shows. The dashboard asks for the Clothes
  bundle only when there are Clothes records to count.
- **The dashboard never reads a system's records itself** and never calls a system's screen functions.
- **It opens a system by its address** (`/ads-studio?tab=review&section=tickets`,
  `/clothes-system?tab=products`), the way a bookmark would. The system reads its own tab from the address.
- A new system that wants a line on the dashboard adds its own door in the same way.

## The shared frame and the systems

The frame (the sidebar with the area switcher, the sections and the account menu) is a platform part.
A system sits inside it and keeps its own screens:

- **A system hands the frame its list of sections through its own door.** The Clothes System's door is
  `clothesFrameSections()` in its own bundle: `[tab, icon, name, is it on screen]` for each section, and
  none while its subscription gate is up. The sidebar draws those lines and opens each by its address
  (`openAddress('clothes-system', 'tab=orders')`); it never sets a system's tab itself.
- **A system keeps its own header, and on phones and tablets its own navigation.** The frame's phone
  header and tab bar are not drawn over a system. The Clothes System marks its own back link, tab bar
  and account strip with `clothes-own-nav`; `style.css` leaves them out from 901 px, where the sidebar
  is on the screen.
- **The Ads Studio keeps its own list of sections in the page.** Beside it the frame stays a narrow
  rail (`.frame-rail`: the area switcher, the owner dashboard, the account menu) at every wide size.
  The Studio's own door (`/studio`) has no frame at all: there is only one area there.
  The same holds for an account whose only area is the Ads Studio, at any address: no rail is
  drawn, because it would hold nothing but a switcher with one entry.

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
