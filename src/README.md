# src/ — the app's source code (edit HERE, not script.js)

`script.js` at the project root is a **generated file**: it is built by
joining these files in order. To change the app:

1. Edit the right file below.
2. Run `npm run build:js` (rebuilds script.js).
3. Run `npm run sync:mobile` (pushes it to the iOS/Android app folders).

The build is a plain join — every function stays global, exactly like the
old single file, so all `onclick="..."` buttons keep working. The build
refuses to run if it detects that someone edited `script.js` directly, so
edits can't be silently lost.

## What's in each file

| File | Contents |
|---|---|
| `01-platform.js` | Device detection (web/iOS/Android), role helpers, battery-saver hook |
| `02-security.js` | XSS escaping/sanitizing, password hashing, sessions, input validation |
| `03-storage-idb.js` | IndexedDB storage layer (large data, chunking, auto-backup) |
| `04-permissions.js` | Permission system, templates, subscriptions, password reset, passkeys |
| `05-state-services.js` | The global `state` object, services catalog, wallet ledger rules |
| `06-persistence.js` | Saving/loading state, old-data migrations, sequential numbering |
| `07-i18n-render-core.js` | Translations (EN/AR), theme, render/icon/notification queues |
| `08-data-audit.js` | Add/update/delete records, audit logging, receipt usage/transfers |
| `09-api-auth.js` | Server API calls, request tracing, login/logout |
| `10-live-sync.js` | 3-second live sync with the server (delta polling) |
| `11-routing-cloud.js` | URL routing, command palette, legacy cloud sync (disabled) |
| `12-views.js` | `render()` and all screens (dashboard, customers, receipts, ads…) |
| `13-filters-helpers.js` | Search/filter logic, customer stats, permissions UI, photo compression |
| `14-forms.js` | Form widgets: customer search, receipt/ad forms, funding, validation |
| `15-modals.js` | The big modal dialogs (`renderModal`) and their submit handling |
| `16-actions-io.js` | Stop/delete actions, data export/import (backups) |
| `17-init.js` | App startup (`init()`), first-run setup, event wiring |

`manifest.json` defines the build order — don't reorder it unless you know
a file's top-level code doesn't depend on an earlier file.
