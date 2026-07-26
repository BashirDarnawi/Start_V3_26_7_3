# Albayan store submission checklist

This checklist separates what is already in the project from what must be
completed before a public store release. For the beginner-friendly Google Play
sequence, use [ANDROID_PERSONAL_PLAY_RELEASE.md](ANDROID_PERSONAL_PLAY_RELEASE.md).

## Important: Docker is not the Android app

- The Docker image runs the Albayan backend on Libyan Spider/Jelastic.
- Google Play does **not** accept a Docker image or the project source code.
- Google Play accepts a signed Android App Bundle (`.aab`). The Android app then
  connects to the live backend at `https://albayanhub.com`.
- Deploying a Docker image does not update the installed Android app. Uploading
  a new `.aab` does not deploy the backend.

## Already present in the project

- [x] The Capacitor Android shell exists.
- [x] The package/application ID is currently `com.albayan.app` across Android
  and Capacitor.
- [x] Branded app icon and splash resources exist for Android and iOS.
- [x] Android release-signing support exists; see
  `android/RELEASE_SIGNING.md`.
- [x] `android/variables.gradle` sets both target SDK and compile SDK to API
  level 36.
- [x] The production API uses HTTPS.

Confirm `com.albayan.app` before the first Play upload. A published package name
cannot be renamed; changing it later creates a different app.

## Must be completed before Google Play submission

- [ ] Correct the public privacy policy. It must describe the actual
  Libyan Spider/Jelastic hosting setup, not AWS, and every retention/deletion
  claim must match the implemented system.
- [ ] Add an easy-to-find in-app **Request account deletion** action and a
  working public deletion-request page. Email/admin deletion alone should not
  be marked complete until the Play account-deletion requirements are met.
- [ ] Do not advertise the app as fully offline. Albayan needs an internet
  connection for login, synchronization, and core server data. Any cached or
  temporary offline behavior should be described only after it is deliberately
  tested.
- [ ] Create and safely back up the Android upload keystore. Never commit or
  send the `.jks`, `key.properties`, or their passwords.
- [ ] Build and test a signed release `.aab`.
- [ ] Complete the Play Console Data safety form from the verified inventory
  below.
- [ ] Confirm the exact Personal Play Console developer/operator name and make
  the privacy policy identify that same person or legal entity. Do not guess or
  publish a placeholder.
- [ ] Create a permanent reviewer demo account with fake business data.
- [ ] Prepare the store listing and graphics.
- [ ] Finish Internal testing, the required Closed test, and the production
  access application for a new Personal developer account.

For a new Personal account, Internal testing is only the first safety check.
Move next to Closed testing, keep at least 12 testers opted in continuously for
14 days, and then apply for production access. Passing the 14-day requirement
makes the account eligible to apply; it does not automatically approve the app.

## Google Play Data safety inventory

This is an inventory to verify, **not a set of answers to copy blindly**. The
developer is responsible for declaring what the released app and its backend
actually collect, use, retain, and share. Include data entered by staff about
customers, not only the signed-in staff member's data.

| Possible Play data category | Albayan examples | What to verify before answering |
|---|---|---|
| Personal info | Account/customer name, email, phone number, user ID | Required or optional; account management and app-functionality purposes |
| Financial info | Receipts, payments, balances and ad spending | Exact Play subcategory and whether all fields are needed |
| Photos and videos | Receipt and ad photo attachments | Optional feature, retention and deletion behavior |
| App activity | Audit history and actions performed in the app | Exact events retained and their purpose |
| Device or other identifiers | IP/browser or server access logs, if retained | Whether collected, retained, or only processed ephemerally |

Also verify and declare:

- whether any data is shared outside the user's organization, including every
  SDK and service provider;
- that data is encrypted in transit with HTTPS;
- whether users can request deletion through the implemented in-app and public
  web paths;
- the actual retention rules and any legal/security exceptions;
- whether an independent security review was completed (do not claim one if it
  was not).

Google requires a Data safety form and privacy policy for apps on closed, open,
or production tracks. Internal-testing-only apps are exempt while they remain
only on that track. See the official
[Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).

## Store listing assets and text

- [ ] App name: **Albayan / البيان** (confirm the final displayed name).
- [ ] Default language and Arabic translation.
- [ ] Short description (up to 80 characters).
- [ ] Full description (up to 4,000 characters). Describe the real online
  customer, ad, receipt, payment, and delivery workflow; do not claim full
  offline operation.
- [ ] 512 x 512 Play Store app icon.
- [ ] 1024 x 500 feature graphic.
- [ ] At least two clear Android phone screenshots. Use a consistent modern
  phone size, avoid real customer information, and follow the current size
  checks shown by Play Console.
- [ ] Support email.
- [ ] Public privacy-policy URL: `https://albayanhub.com/privacy` after its
  content is corrected and deployed.
- [ ] Public account-deletion URL after it is implemented and deployed.
- [ ] Business category, content rating, countries/regions, and pricing.

Useful screenshots: dashboard/analytics, customers, receipt photo viewing,
ads, deliveries, and a mobile Arabic/RTL view. Use invented demo information.

## Play Console declarations that are easy to misunderstand

Verify the release before selecting these answers:

- **Contains ads:** likely **No**. Albayan manages customers' advertising
  campaigns, but that is different from displaying Google AdMob, banner,
  interstitial, native, or other monetized ads inside the app. Change this
  answer if an ad SDK or sponsored placement is added.
- **Health apps declaration:** likely **No health features**. Albayan does not
  appear to provide health functionality or collect health data.
- **Financial features declaration:** likely **My app doesn't provide any
  financial features** only if receipts, balances, and payments are internal
  business bookkeeping and the app offers no banking, lending, wallet,
  remittance, investment, insurance, cryptocurrency, or similar service.
  Review Google's current
  [Financial features declaration guidance](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en)
  before selecting it.

**Stop for owner confirmation:** the project contains internal wallet/service
subscription concepts. Confirm how they work in production. If users pay real
money—by cash, bank transfer, or another route—to unlock digital app features,
subscriptions, or content, Google Play's payments/billing policy needs a
separate review. Do not finalize the financial or payments declarations merely
because the current catalog price is zero or payment is recorded by an admin.

## Reviewer access

Albayan is login-gated, so the Google reviewer must be able to reach all main
features without contacting you.

- [ ] Create a dedicated reviewer account that will stay active throughout
  review.
- [ ] Give it enough permissions to test the submitted features.
- [ ] Fill it with fake, non-sensitive customers, receipts, ads, and photos.
- [ ] Do not require an OTP, expiring password, internal network, or manual
  approval unless exact working instructions are supplied.
- [ ] Put the username, password, and short navigation instructions in Play
  Console's **App access** section. Do not put production administrator
  credentials in the public store description.
- [ ] Re-test the credentials immediately before every submission.

Suggested review note:

> Albayan is a business-management tool for advertising-office teams. Accounts
> are created by a workspace administrator; there is no public sign-up. Use the
> provided dedicated demo account to test customers, receipts, ads, photos and
> deliveries. All records in the demo workspace are fictional.

## Version numbers

Android versions are set in `android/app/build.gradle`.

- `versionCode` is an integer used by Google Play. Every uploaded `.aab` for
  this package must use a value higher than every previous upload, including
  internal and closed-test uploads.
- `versionName` is the user-visible version. Change it when the displayed
  release version should change.
- First example: `versionCode 1`, `versionName "1.0"`.
- Next uploaded build example: `versionCode 2`, `versionName "1.0.1"`.

Never reuse an old `versionCode`, even if its release was rejected or removed.

## iOS notes

The Google Play workflow does not publish the iOS app. For a later Apple
release, register `com.albayan.app` in the Apple Developer portal, create its
App Store Connect entry, complete Apple's privacy labels, and increment the
iOS build number for every upload.
