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
- Arabic and English are declared (`CFBundleLocalizations`) and the binary is
  arm64-only.
- The app ships its own privacy manifest, `ios/App/App/PrivacyInfo.xcprivacy`
  (no tracking). Apple requires one because the camera plugin's
  `IONCameraLib.framework` contains code that reads file creation dates, one
  of Apple's "required reason" APIs, and that library's own manifest is not
  packaged into the app. The app's manifest therefore declares file
  timestamps with the library's reasons `C617.1` and `3B52.1`. Without it App
  Store Connect rejects the upload (ITMS-91053). `npm run test:mobile-config`
  checks that the file exists and that the Xcode project copies it into the
  app.
- Nothing is sold inside the iPhone app (owner decision, 2 October 2026).
  Apple requires its own payment system, called In-App Purchase, for plans,
  subscriptions and wallet credit sold inside an iPhone app. Instead of
  adding it, the iPhone app hides every button that buys, subscribes,
  renews or activates a plan or adds money to your own wallet, and shows
  one line in their place: "Purchases are not available in this app."
  Balances, plans already in use and history stay visible. The line names
  no other way or place to pay and has no link, because Apple also forbids
  telling users inside the app where else to pay. The website and the
  Android app are unchanged, so a customer with an iPhone still buys on the
  website or through the office, as before. `npm run
  test:review-regressions` checks the iPhone screens (the lines that start
  with "F-iap").
  One office tool is unchanged on the iPhone: on the Users screen an admin
  can still record money that a customer paid at the office (the banknote
  icon, "Top up wallet"). That is the office's bookkeeping, not a purchase,
  and the account you give Apple cannot reach it.
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
- **In-App Purchases and Subscriptions:** leave both sections empty. The
  iPhone app sells nothing, so do not create any product there.
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
5. Apple processes the build (usually 10–60 minutes) and emails you. Read
   every ITMS line in that email. ITMS-91053 ("Missing API declaration")
   means the build is invalid and cannot be tested or submitted: add the API
   category and reason code the email names to
   `ios/App/App/PrivacyInfo.xcprivacy`, raise the build number and upload
   again.

## Step 6 — Screenshots and listing text (once, then only when the UI changes)

- iPhone 6.9-inch screenshots are mandatory: 1290×2796 pixels portrait, 1 to
  10 images, PNG or JPEG, no transparency. Take them on the "iPhone 17 Pro
  Max" simulator (Xcode → Open Developer Tool → Simulator; ⌘S saves a
  screenshot to the Desktop at the right size).
- The app has no practice copy with fake data: every account, on every
  phone, opens the one live system at `https://albayanhub.com`. So never
  take a screenshot while signed in as yourself: an admin screenshot would
  publish real customers on the App Store. Sign in on the simulator with
  the App Review account from Step 7, which sees only its own made-up DEMO
  records. Good screens: the customer list with the DEMO customers, one
  DEMO customer opened, the Receipts screen, the More page, and one Arabic
  view.
- Text: description (4,000 characters), promotional text (170), keywords
  (100, comma-separated), support URL (a page or email you answer), copyright
  ("2026 <your legal name or company>"). Add an Arabic localization with the
  same fields.
- Do not put "Meta", "Facebook" or "Instagram" in the app name, subtitle,
  icon or keywords. In the description say the app manages advertising
  campaigns; if you name the platforms, add: "Meta and Facebook are
  trademarks of Meta Platforms, Inc. Albayan is not affiliated with or
  endorsed by Meta."

## Step 7 — Account for App Review (once; re-check before every submission)

The app is login-only, so the reviewer needs an account that works without
you. Read these three points first; an earlier version of this guide had
them wrong.

- **The app has no demo copy.** The iPhone app always talks to the live
  server `https://albayanhub.com`, and that server holds one shared set of
  data: your real customers, receipts and ads. Any account you give Apple
  is an account inside your real business.
- **Never give Apple an admin account.** Also never an account with the
  "Sales employee" preset or the "Sales Agent", "Manager", "Accountant" or
  "Read Only" template: each of those can see every real customer.
- The safe account is an ordinary, non-admin user with the permission
  template **App Review demo**. It can see only the records that it created
  itself. It cannot see anyone else's customers, any phone number, totals,
  analytics, pages, users, settings or the wallet, and it cannot edit or
  delete any customer, receipt or ad. To Apple the app is empty except for
  the made-up records you add below.

The other way would be a second, separate server filled with fake data. It
needs hosting that has not been set up, so it is not described here.

### 7a. Create the account (signed in as admin, on the website)

1. Open **Users** and press **Add User**.
2. Name: `App Review`. Email: an address you use only for this. Password:
   long, and used nowhere else. Role: **Employee**. The reviewer must be
   able to sign in alone: no one-time code, no password that expires, no
   approval from you.
3. Access preset: choose **Ads Studio customer — own campaigns only**. It
   gives no access to your office records, and the next steps replace it.
4. Press **Create User**. The **Permissions Manager** opens by itself. (If
   it does not, press the shield icon on the new user's card.)
5. Under **Quick Templates** press **App Review demo**.
6. Check it. The counter at the top must read **5/98**, and exactly these
   five boxes are ticked: View Own Ads, View Own Receipts, View Own
   Customers, Add Customers, View Own Deliveries. Press **Done**.

### 7b. Add the made-up records (signed in as App Review)

1. Sign out, then sign in with the App Review email and password.
2. First check: the app opens on **Customers** and the list is **empty**.
   If it opens anywhere else, or you see even one real customer, stop: the
   permissions are wrong. Sign in as admin and repeat 7a from step 5.
3. Press **Add Customer** and create three customers whose names start with
   the word DEMO, for example `DEMO Customer One`. Give each a made-up phone
   number that belongs to nobody, for example `0900000001`, `0900000002`
   and `0900000003`. (If the app says a number is already in use, pick
   another made-up one.)
4. Open Receipts, Ads and Deliveries. They open and are empty. **New
   Receipt** and **Add Ad** answer "Access Denied" for this account. That
   is correct: the reviewer can look, but cannot create money records.
5. Do not tick anything under Ads or Pages for this account. An ad needs a
   page, and an account that can see pages sees every customer's page.

Optional, and better skipped: one DEMO receipt. A receipt is real
bookkeeping. It takes a real receipt number, and it counts in your real
totals until you delete it. If you still want Apple to see one: as admin,
open the App Review user's permissions (shield icon) and tick **Create
Receipts**; as App Review, create one small receipt for a DEMO customer; as
admin, untick **Create Receipts** again. Before you submit, the counter
must be back to **5/98**.

### 7c. Give the account to Apple

App Store Connect → the version page → **App Review Information** → tick
"Sign-in required", enter the App Review email and password, add a phone
number in international format, and paste these notes (edit them to match
reality):

  > Albayan is the business tool of an advertising office in Libya. It is
  > used by the office's staff and by business owners who are the office's
  > customers. Accounts are created only by the office's administrator;
  > there is no public sign-up, so Guideline 5.1.1(v) account creation does
  > not apply. A deletion-request page is still provided at
  > https://albayanhub.com/delete-account and linked from the app (More,
  > then Delete Account).
  >
  > Nothing can be bought in the iPhone app. It has no In-App Purchase and
  > no other way to pay. A plan cannot be bought, renewed or activated in
  > it, and a customer cannot add credit in it. It does not link to or
  > mention any other place to pay. Where the web version has such
  > buttons, the iPhone app shows "Purchases are not available in this
  > app." A tool without an active plan shows "This service is not active
  > on your account." Plans and credit are arranged with the office outside
  > the app, so we understand the app to be a free companion to a web-based
  > tool (Guideline 3.1.3(f)).
  >
  > The receipts and balances in the app are the office's own records of
  > work it does for its customers outside the app (advertising campaigns
  > on social media, deliveries). The office's staff record there the
  > payments customers made to the office in cash or by bank transfer. A
  > customer who already holds credit with the office can prepare an
  > advertising request in the app; the office's staff review it and run
  > the campaign outside the app, and its budget is taken from that credit.
  >
  > The app has no demo mode: it always connects to the office's live
  > system. The demo account above is a limited staff account that can see
  > only the records it created itself. Those records are fictional and
  > their names start with "DEMO". The account can add customers. It cannot
  > create receipts or ads, so New Receipt and Add Ad answer "Access
  > Denied" for this account; that is the permission system working, not a
  > fault.
  >
  > Sign in with the demo account (the app opens on its own login form).
  > Camera and photo library are used to attach photos of receipts, ads and
  > delivery proof. Face ID only locks the app on the device. The language
  > toggle switches Arabic/English. There is no third-party sign-in.

Apple asks for an account that reaches the whole app, and this one is
limited on purpose. If Apple writes that it could not test a feature, do
not answer by sending an admin account. Either tick **Create Receipts** for
the App Review account for the days of the review (every receipt the
reviewer makes is real bookkeeping until you delete it), or stop and get
help.

### 7d. Before every submission, and after approval

Before you press Submit, on a phone:

- Sign in as App Review. The app must open on Customers and show only the
  DEMO customers.
- Sign in as yourself in the build from TestFlight and open the Services
  Hub. There must be no "Top up" button and no "Plans & bundles" link, and
  the line "Purchases are not available in this app." must be under the
  wallet balance. Look through Clothes and Ads Studio too. If you find, on
  the iPhone, any button that buys, subscribes, renews or adds money to
  your own wallet, do not submit: it must be fixed first.
  One button is expected and is not a problem: the banknote icon ("Top up
  wallet") on the Users screen. It is the office tool described at the top
  of this guide, where an admin records money a customer paid at the office.
  Only admins see it, and the App Review account cannot open the Users
  screen at all.

After Apple approves:

1. If you made a DEMO receipt, delete it (Receipts, signed in as admin).
2. Lock the account. In Users, press the shield icon on App Review, then
   **Clear All**; then press the pencil icon and save a new password. The
   account can no longer open any of your records. Do not delete the user:
   every later update is reviewed again and needs it.
3. Delete the DEMO customers, and any customer the reviewer added. (You may
   keep the DEMO customers for the next review instead. They are not money
   records, but they show in your own customer list and counts.)

For the next submission: press **App Review demo** again in its
permissions, save a new password, put that password into App Review
Information, and repeat 7b if the DEMO customers are gone.

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
   account). If the message names 3.1.1 (payments), answer with the second
   paragraph of the Step 7 notes. Never add text or a link to the app that
   tells users where else to pay.
4. When the status is "Pending Developer Release", press **Release This
   Version**. The app is then on the App Store within a few hours.

## Later releases in one line

Release the server → bump Build (and Android versionCode) → `npm run build &&
npm run sync:mobile && npm run verify:mobile` → Xcode Archive → Upload →
TestFlight check → Submit with "What's New".
