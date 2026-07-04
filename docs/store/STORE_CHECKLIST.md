# App Store & Play Store Submission Checklist — Albayan

Everything needed to submit. Items marked ✅ are already done in the code;
items marked 👤 need an action from you (the owner).

## Already done in the project ✅

- ✅ One app identity everywhere: `com.albayan.app` (iOS Debug+Release, Android, Capacitor config)
- ✅ Branded app icon + splash screens (light & dark), all densities, both platforms
- ✅ Privacy policy page served at `https://albayanhub.com/privacy` (bilingual EN/AR)
- ✅ App works offline and connects to the backend from inside the apps
- ✅ Android release signing scaffold (`android/RELEASE_SIGNING.md`)
- ✅ Android 15 edge-to-edge safe areas handled

## One-time owner setup 👤

1. **Apple Developer portal**: register the App ID `com.albayan.app`
   (Identifiers → +), then create the app entry in App Store Connect.
2. **Android keystore**: follow `android/RELEASE_SIGNING.md` once, keep the
   `.jks` file backed up forever.
3. **Rotate the database password** if not done yet.

## Store listing content (both stores) 👤

- App name: **Albayan / البيان**
- Short description (~80 chars) + full description — describe: customer,
  ads, receipts and delivery management for advertising offices; Arabic +
  English; works offline.
- Privacy policy URL: `https://albayanhub.com/privacy`
- Support email: your contact email
- Category: Business
- Screenshots (see below)

## Screenshots needed 👤

Take these on real devices/simulators, in Arabic (your main market) and
optionally English:

| Platform | Sizes required |
|---|---|
| iPhone | 6.7" (1290×2796) and 6.5" (1284×2778 or 1242×2688) |
| iPad (if you enable iPad) | 12.9" (2048×2732) |
| Android phone | at least 2, 16:9 or 9:16, ≥1080px |
| Android tablet (optional) | 7" and 10" |

Good shots: dashboard/analytics, receipts list, receipt creation with
split payments, deliveries board, dark mode example.

## Google Play "Data safety" form answers 👤

Based on what the app actually does:

- **Does your app collect or share user data?** Yes, collects. No sharing.
- Data types collected:
  - Personal info → Name, Email address (account) — required, not shared
  - Photos → user-attached receipt/ad photos — required for the feature, not shared
  - App activity → in-app audit log (actions history) — required, not shared
- **Is data encrypted in transit?** Yes (HTTPS).
- **Can users request deletion?** Yes — via admin or the email on the
  privacy policy. (Play requires a working deletion path; the policy
  documents 30-day deletion.)
- **Independent security review?** No.

## Apple "App Privacy" labels 👤

- Contact Info → Name, Email Address (linked to user, app functionality)
- User Content → Photos (linked to user, app functionality)
- Identifiers → none (no advertising IDs, no trackers)
- Usage Data → none sold/shared; audit log is app functionality
- Tracking: **No tracking** (no ads, no third-party analytics)

## Review notes to include (helps approval) 👤

Provide the reviewer a demo login (create a dedicated demo workspace user
first) and note: "Business tool for advertising-office teams. Accounts are
created by a workspace administrator; there is no public sign-up. Demo
credentials: <email> / <password>."

## Version bumping for updates

- Android: increase `versionCode` (integer) and `versionName` in
  `android/app/build.gradle` for every upload.
- iOS: increase Build number (CFBundleVersion) for every upload; Version
  (CFBundleShortVersionString) for user-visible releases.
