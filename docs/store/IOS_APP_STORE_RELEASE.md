# Albayan on the Apple App Store — beginner sequence

This is the iOS counterpart of [ANDROID_PERSONAL_PLAY_RELEASE.md](ANDROID_PERSONAL_PLAY_RELEASE.md).
Everything here was checked against Apple's pages in October 2026 and against
this project's files. Do the steps in order; each one says whether it is done
once or for every release.

## What is already true (nothing to do)

- The iPhone app exists (`ios/App/App.xcodeproj`, Capacitor 8, Swift packages,
  no CocoaPods) and CI compiles it for the simulator and for a real device on
  every push.
- Identity: bundle id `com.albayan.app`, display name **Albayan**, version
  `1.0`, build `1`, Apple team `DUZF57SA88`, automatic signing.
- The icon is a 1024×1024 PNG without transparency (the single-size format
  Xcode 27 wants). Launch screen, camera, photo library and Face ID purpose
  strings exist.
- `ITSAppUsesNonExemptEncryption = NO` is set (the app only uses HTTPS and the
  system keychain), so App Store Connect will not ask export-compliance
  questions for every build.
- Arabic and English are declared (`CFBundleLocalizations`), the binary is
  arm64-only, and no privacy manifest is needed in the app target: Capacitor
  ships its own and none of the linked plugins use a "required reason" API.
  If a future upload email mentions ITMS-91053, add
  `ios/App/App/PrivacyInfo.xcprivacy` with the reason code the email names.
- Public pages Apple asks for are live: privacy policy
  `https://albayanhub.com/privacy`, deletion request
  `https://albayanhub.com/delete-account`.
- Xcode 27 on macOS 27 satisfies Apple's rule that uploads use the iOS 26 SDK
  or newer (since 28 April 2026) and the iOS 27 SDK rule that starts April
  2027.

## Step 1 — Apple account (once)

1. The Apple Developer Program membership (99 USD a year) must be active on
   the Apple ID that owns team `DUZF57SA88`. Check at
   https://developer.apple.com/account. A free account cannot upload.
2. Two-factor authentication must be on for that Apple ID.
3. In App Store Connect → Business, the Account Holder must accept the latest
   agreements, or the "New App" button stays disabled.
4. On this Mac, once: Xcode → Settings → Accounts → "+" → sign in with that
   Apple ID. Xcode creates the certificates itself when you archive.
5. In Terminal, once (it asks for your Mac password):

   ```
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```

## Step 2 — iPad (decided: iPhone only)

The first release targets iPhone only (`TARGETED_DEVICE_FAMILY = 1`, decided
1 October 2026). App Review therefore tests on iPhone, only iPhone screenshots
are required, and the app still installs on iPads in compatibility mode. To
add iPad later: in Xcode, target `App` → General → Supported Destinations →
add iPad, test the layout on the "iPad Pro 13-inch" simulator in Arabic and
English, and add 13-inch iPad screenshots (2064×2752) to the listing.

## Step 3 — App Store Connect record (once)

https://appstoreconnect.apple.com → My Apps → "+" → New App:

- Platform iOS, Name **Albayan** (30 characters max), Primary language
  (Arabic if that is the main audience; add the other language later),
  Bundle ID `com.albayan.app` (register it first under Certificates,
  Identifiers & Profiles if the list does not show it), SKU `albayan-ios`.
- The bundle id can never change after the first upload.

Then fill, in the sidebar:

- **App Information:** subtitle (30), category **Business**, content rights
  ("does not contain third-party content"), age rating questionnaire (answer
  honestly; it will come out 4+), privacy policy URL
  `https://albayanhub.com/privacy`.
- **Pricing and Availability:** Free. Under App Availability choose the
  countries deliberately. If you do not select any EU country you do not
  need the EU Digital Services Act "trader" declaration; if you do, that
  declaration (business contact details shown publicly) is required.
- **App Privacy:** answer the questionnaire from the inventory table in
  [STORE_CHECKLIST.md](STORE_CHECKLIST.md). Expected answers for Albayan:
  data collected and linked to the user: Contact Info (name, email, phone),
  Financial Info (receipts, payments), Photos, User Content, Identifiers
  (user ID), Usage Data (audit history). Tracking: **No** (no ad SDK, no
  cross-app data sharing). Data is not used for third-party advertising.

## Step 4 — Version numbers (every upload)

Apple needs a **higher build number for every upload** of the same version.
The test suite keeps iOS and Android in step, so change both places:

| Where | Field | First upload | Next upload |
|---|---|---|---|
| Xcode → target App → General → Identity | Version / Build | 1.0 / 1 | 1.0 / 2 |
| `android/app/build.gradle` | versionName / versionCode | "1.0" / 1 | "1.0" / 2 |
| `package.json` | version (three numbers) | "1.0.0" | "1.0.0" |

Then `npm run test:mobile-config` must pass. Never reuse a build number.
Version stays `1.0` until the app changes for customers; then `1.0.1`, `1.1`, …
A version change goes in all three places (`1.0.1` everywhere; `1.1` in Xcode
and build.gradle is `1.1.0` in package.json).

## Step 5 — Build and upload (every upload, about 15 minutes)

The phone app talks to the live server, so release the server first (see
[deploy/README.md](../../deploy/README.md)) and confirm
`https://albayanhub.com/api/health/ready` shows the new release. A new app
against an old server cannot load data.

In Terminal, in the project folder:

```
npm run build
npm run sync:mobile
npm run verify:mobile
npx cap open ios
```

`sync:mobile` regenerates the app's web files inside the Xcode project (they
are not committed); `verify:mobile` must print "Verified source, root, www,
Android, and iOS web artifacts." before you continue. Xcode itself refuses to
build when those files are older than the project's (build phase "Web files
must be current"): the error names the command to run.

In Xcode:

1. Top bar: choose the destination **Any iOS Device (arm64)**.
2. Target `App` → Signing & Capabilities → "Automatically manage signing" is
   ticked and Team shows your team. The first time, Xcode creates the
   certificates; let it.
3. Menu **Product → Archive**. Wait for the Organizer window.
4. In the Organizer: **Distribute App → App Store Connect → Upload**, keep
   the default options (upload symbols, manage version and build number can
   stay off because you set them yourself), **Upload**.
5. Apple processes the build (usually 10–60 minutes) and emails you. If the
   email lists an ITMS warning, read it: most are informational.

## Step 6 — Screenshots and listing text (once, then only when the UI changes)

- iPhone 6.9-inch screenshots are mandatory: 1290×2796 pixels portrait, 1 to
  10 images, PNG or JPEG, no transparency. Take them on the "iPhone 17 Pro
  Max" simulator (Xcode → Open Developer Tool → Simulator; ⌘S saves a
  screenshot to the Desktop at the right size).
- Use the demo workspace with invented customers, never real data. Good
  screens: dashboard, customers, a receipt with its photo, ads, deliveries,
  and one Arabic view.
- Text: description (4,000 characters), promotional text (170), keywords
  (100, comma-separated), support URL (a page or email you answer), copyright
  ("2026 <your legal name or company>"). Add an Arabic localization with the
  same fields.
- Do not put "Meta", "Facebook" or "Instagram" in the app name, subtitle,
  icon or keywords. In the description say the app manages advertising
  campaigns; if you name the platforms, add: "Meta and Facebook are
  trademarks of Meta Platforms, Inc. Albayan is not affiliated with or
  endorsed by Meta."

## Step 7 — Demo account for App Review (once; re-check before every submission)

The app is login-only, so the reviewer needs an account that works without
you:

- A permanent user in a demo workspace filled with fake customers, receipts,
  ads, photos and deliveries; enough permissions to see the main screens; no
  one-time code, no expiring password, no admin approval.
- App Store Connect → the version page → **App Review Information** → tick
  "Sign-in required", enter the email and password, add a phone number in
  international format, and paste these notes (edit to match reality):

  > Albayan is a business tool for advertising-office teams in Libya.
  > Accounts are created only by a workspace administrator; there is no
  > public sign-up, so Guideline 5.1.1(v) account creation does not apply.
  > A deletion-request page is still provided at
  > https://albayanhub.com/delete-account and linked from Settings.
  > Sign in with the demo account above (the app opens on its own login
  > form). Camera and photo library are used to attach photos of receipts,
  > ads and delivery proof. Face ID only locks the app on the device.
  > The language toggle switches Arabic/English. There are no in-app
  > purchases and no third-party sign-in.

- Log in with the demo account yourself right before pressing Submit.

## Step 8 — TestFlight, then submit (every release)

1. After processing, the build appears under **TestFlight**. Add yourself
   (and colleagues) as internal testers: install the TestFlight app on the
   phone, accept the invitation, install Albayan, and try one receipt, one
   delivery, the camera, and Arabic. Internal testing needs no Apple review.
2. On the version page: pick the build, set **Version Release** to
   "Manually release this version" (so you can look at the approved listing
   before customers see it), fill "What's New", and press **Add for Review →
   Submit**.
3. Apple reviews most apps within 24 hours. A rejection arrives as a message
   in App Store Connect with the guideline number; answer in the same thread
   or fix and upload a new build (higher build number). The most common first
   rejection is 2.1 (something did not work for the reviewer: usually the demo
   account).
4. When the status is "Pending Developer Release", press **Release This
   Version**. The app is then on the App Store within a few hours.

## Later releases in one line

Release the server → bump Build (and Android versionCode) → `npm run build &&
npm run sync:mobile && npm run verify:mobile` → Xcode Archive → Upload →
TestFlight check → Submit with "What's New".
