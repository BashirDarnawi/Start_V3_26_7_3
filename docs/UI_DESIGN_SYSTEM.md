# Responsive workspace design

This refresh extends the user's September 14 video reference to the existing
Albayan application. It is a presentation update, not a new app or a data
migration. Existing records use the new views automatically.

## Visual language

- Pale grey-blue canvas, solid rounded surfaces, blue primary actions.
- Green means paid/success; rose means debt/danger; amber means attention.
- The `--ui-*` tokens in `style.css` cover light and dark surfaces and text.
- The existing 900px phone breakpoint remains shared by the header, drawer,
  bottom bar and dialogs. Short landscape dialogs also use
  the single-scroll layout. Native safe-area and keyboard variables remain
  owned by the mobile runtime.
- No fake device frame, status bar, external UI library or web font dependency
  is introduced. Icons, fonts and application files remain bundled locally.

## Finding existing features

- Search and quick filters stay above each record list. **Filters & sort**
  expands the complete filter panel. Closing it never clears selected filters.
  This is not a separate Simple mode; all tools remain available.
- Customers, receipts, pages and users use directory cards on every width.
  Labelled facts and permitted photo/link/edit/company-funds shortcuts are
  visible outside. **Details / Hide** retains all advanced controls, including
  print, collection, transfer, permissions and deletion. The overview's repeated
  facts/actions are removed while the full card is open.
- At the user's September 15 request, Ads use their previous compact desktop
  table and expandable phone summaries, not the tall campaign-card redesign.
  Photos, creator, customer charge, Meta budget/spend, dates, account/history,
  and all existing actions remain. Direct receipt links sit with the other
  actions, subject to the same receipt visibility and navigation permissions.
- Deliveries use job cards, a driver overview and a collection summary.
  Reconciliation uses planned/actual/remaining cards and the existing customer
  notification confirmation. Search still swaps only its result region.
- Control Center groups priority tasks and financial/protection work. Settings
  has a section navigation rail; Audit uses a filterable activity timeline.
  No setting or financial tool is removed to simplify the page.
- Ad previews use the existing media viewer and Meta budget helpers. An
  unknown budget or remaining amount never creates a guessed progress bar.
- **More** retains the other manager destinations. Services Hub, wallet,
  subscriptions, clothes, Ads Studio and social tools remain separate routes.
- Studio section buttons and its setup progress fit phones without horizontal
  dragging. Wallet activity and clothes KPI values wrap instead of truncating.

## Editing safely

`src/12-views.js` owns layout and filter disclosure. `src/12d-manager-shell.js`
owns directory cards and the home overview. `src/15-modals.js` decorates shared dialog titles,
close buttons and unambiguous label associations without changing form values
or submission logic. `src/15c-ads-studio.js` owns Studio presentation.

Component layout styles load after the Tailwind utility bundle:
`assets/workspace-layout.css`, `assets/ads-workspace.css`,
`assets/operations-workspace.css`, `assets/management-workspace.css`.
The existing asset sync and Docker copy include them recursively.

Services/Plans/Wallet, Clothes and Studio already had card-based layouts; this
pass preserves them and corrects their remaining narrow-screen problems. It
does not claim each legacy dialog was rewritten from scratch.

Do not hide features with broad selectors such as all buttons, all grids,
all form labels or all table cells. Do not clip dropdowns to achieve rounded
corners. Keep the phone overlay as the single main scroll surface; dropdown
results may retain their own bounded scroll area.

Build with `npm run build`. Propagate with `npm run sync:mobile` and verify
with `npm run verify:mobile`. Do not hand-edit generated JavaScript or native
copies. These commands do not publish Docker images or redeploy the live site.

## Regression coverage

- `npm test`: existing permission, money, session, compatibility, backend and
  source-wiring suites; new compact-shell behavior tests.
- `npm run test:modal-presentation`: real-DOM dialog tests, including stable
  IDs/values/actions, localized labels, touch targets and long-form scrolling.
- `npm run test:e2e`: modal checks plus critical and design-system browser
  flows on desktop Chromium, Android-sized Chromium and iPhone-sized WebKit.
- `tests/e2e/design-system.spec.js`: all manager routes and lazy subsystem
  tabs; populated small-screen rows; long bilingual names and large balances;
  filter persistence; existing edit/photo/link actions; dark/RTL layouts;
  portrait and landscape forms; keyboard-aware bottom navigation.

## Verified structural redesign (September 14, 2026)

- Full application suite passed: 1,078 backend tests, with 13 environment-specific
  PostgreSQL tests skipped; the JavaScript regression suites also passed.
- All 51 browser scenarios passed across desktop Chromium, Android-sized
  Chromium and iPhone-sized WebKit, including all 24 routes and the new
  populated operational-card checks at 1440px and 390px.
- 223 permission, 161 mobile UI, 26 shell presentation, 11 real-DOM modal,
  43 money invariant, 10 profitability, 15 review behavior, 39 session/privacy,
  and 52 legacy-data compatibility checks passed.
- Build and source/root/www/Android/iOS artifact matching passed.
- `npm audit --audit-level=high`: zero reported vulnerabilities.
- Desktop and Arabic/dark phone screenshots of Ads, Deliveries,
  Reconciliation, Control Center and Customers were visually inspected.
  The inspection caught and corrected Add Ad contrast and clipped summary
  amounts. Other route and form bounds were checked by browser assertions.
- Test fixtures use valid S-prefixed receipt numbers without leading zeroes;
  the receipt photo check exercises the existing outside-card viewer.

The earlier shared-shell release was published before these structural
changes. This redesign is saved locally and synced into the mobile web
assets. On September 14 it was built and pushed to Docker Hub as
`bashird/albayan:latest` and
`bashird/albayan:release-b1c4ef76b1dd-20260914T195018844Z-dirty`.
Verified image digest:
`sha256:56293b2ba5e80adece4439f4ba61dc93e5a84bc74f6b920f255a79326d65bc1a`.
The image uses a single Docker-format Linux/amd64 manifest, runs as `albayan`,
and all 11 frontend files (including the four workspace stylesheets) match
the tested local files. The gated publisher reran the full passing suite.

Jelastic redeployment was not performed. Source changes are still uncommitted;
the `dirty` tag records that fact. Previous image retained for rollback:
`bashird/albayan:release-b1c4ef76b1dd-20260914T170639807Z-dirty`.
Existing data needs no recreation or financial migration for these
presentation changes. Backend source and the production database were not
changed in this redesign pass.

Browser emulation does not replace physical-device testing of camera,
biometrics, native sharing, keyboards or app background/foreground behavior.
An App Store/Xcode build still requires macOS and the normal signing workflow.

## Ads layout restoration (September 15, 2026)

The user requested the previous Ads look instead of tall campaign cards.
Only the Ads presentation was restored; the other redesigned views remain.
The desktop table and expandable phone rows keep the current thumbnail safety
guard, receipt shortcuts, manual-ad duration, and existing financial/action
helpers. Receipt shortcuts use the wider Actions cell, not the narrow Serial
column. No production data or backend code was changed.

Verification:

- `npm test` passed, including 1,078 backend tests (13 PostgreSQL-specific
  environment skips), 224 permission tests, and 161 mobile UI checks.
- The complete 51-scenario browser suite passed. After the final shortcut
  placement change, the dedicated Ads layout/navigation test passed again in
  all three browser projects at 1440px, 1024px, and 390px, including dark/RTL.
- Final permission/mobile checks and source/root/www/Android/iOS artifact
  verification passed. Desktop and phone screenshots were inspected.

This restoration is saved locally and synced to the mobile web assets. On
September 15 it was built and pushed to Docker Hub as `bashird/albayan:latest`
and `bashird/albayan:release-b1c4ef76b1dd-20260915T001641085Z-dirty`.
Both remote tags resolve to
`sha256:32b33781694b8e9d405a2ee930ed470cada825821dff3214b4deebc98b7ae508`.
The gated publisher reran the passing application/browser suites and found
zero npm vulnerabilities. Verification confirmed the single Docker v2
Linux/amd64 manifest, non-root `albayan` user, restored table (not campaign
cards), and exact matches for all 11 frontend file hashes in the image.

No Git commit or Jelastic redeployment was performed. The previous rollback
image remains `bashird/albayan:release-b1c4ef76b1dd-20260914T195018844Z-dirty`.
