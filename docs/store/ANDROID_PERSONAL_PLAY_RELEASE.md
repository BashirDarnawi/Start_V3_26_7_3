# Google Play release guide for a Personal account

This is the safe beginner sequence for publishing Albayan. Do the phases in
order. Google approving a developer account does **not** mean the app itself is
approved or ready for production.

The mandatory 12-tester process applies to newly created Personal developer
accounts. Google currently requires at least 12 testers to remain opted in to a
closed test continuously for 14 days before the developer can apply for
production access. Keep 15-20 reliable testers in the group so one person
leaving does not put the requirement at risk. See Google's official
[Personal-account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en-EN).

## One-time Windows computer setup

Install the current stable Android Studio from the official
[Android Studio download page](https://developer.android.com/studio). During
its Setup Wizard, personally review and accept the Android SDK licences and
install the recommended SDK tools. An AI should not accept legal terms for you.
This project currently uses `targetSdkVersion 36` and `compileSdkVersion 36`,
so install Android SDK Platform 36, Build Tools, Platform Tools and a Java 21
runtime. Do not download Android SDK files from unofficial websites.

On this computer, the web/mobile source checks work, but the native Gradle
build cannot finish until the Android SDK is installed. The local
`android/local.properties` is already set to Android Studio's normal Windows
SDK location: `C:\Users\bashi\AppData\Local\Android\Sdk`.

## Phase 1: make the app submission-ready

1. Confirm that the permanent package name will be `com.albayan.app`.
2. Correct and deploy the privacy policy. It must say Libyan Spider/Jelastic,
   not AWS, and accurately describe the released app.
3. Implement and deploy both an in-app account-deletion request path and a
   public deletion-request page. See Google's official
   [account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
4. Verify the Data safety inventory in `STORE_CHECKLIST.md` against the actual
   production code, server logs, providers, and retention rules.
5. Create a dedicated reviewer login using fictional data.
6. Test on at least one real Android phone: login/logout, Arabic/RTL, small
   screens, receipt/ad photos, forms, printing/sharing if exposed, connection
   loss and recovery, Android Back, and session expiry.
7. Confirm the exact developer/operator name shown in the Personal Play
   Console account and make the public privacy policy identify that same person
   or legal entity. This owner-supplied identity is still unresolved; do not
   guess it or publish a placeholder.
8. Confirm whether any customer pays real money to unlock digital app features,
   content, or subscriptions. The internal wallet/subscription code makes this
   a required owner decision before the payments declarations are finalized.

Do not move to Closed testing while the privacy/deletion paths or reviewer
login are incomplete. Closed testing triggers the store-policy declarations.

## Phase 2: create the upload key and enable Play App Signing

Google Play uses two signing concepts:

- The **app signing key** signs the APKs delivered to users. With Play App
  Signing, Google protects this key.
- The **upload key** proves that an uploaded `.aab` came from you. The local
  `albayan-release.jks` is intended to be this upload key.

Follow `android/RELEASE_SIGNING.md` to generate the keystore and local
`android/key.properties`. Then:

1. Store the `.jks`, alias, and passwords in a password manager and a separate
   secure backup.
2. Never commit them to GitHub, include them in Docker, attach them to an issue,
   or send them to an AI/chat.
3. Enrol in **Play App Signing** when Play Console asks during the first app
   setup/release.
4. Keep using the same upload key for future releases. If it is ever lost,
   follow Play Console's upload-key reset process instead of creating a new app.
5. Build the release only on your trusted computer. If Gradle reports missing
   signing configuration or `CHANGE_ME`, stop and finish the signing guide;
   do not try to bypass the safety check.

Android App Bundles are the Play publishing format for new apps. See the
official [Android App Bundle guidance](https://developer.android.com/guide/app-bundle/faq?hl=en).

## Phase 3: prepare and build the first `.aab`

From the project root in PowerShell:

```powershell
npm ci
npm run release:prepare
Set-Location android
.\gradlew.bat bundleRelease
```

The file to upload is:

```text
android/app/build/outputs/bundle/release/app-release.aab
```

Before building, confirm the numbers in `android/app/build.gradle`. The first
upload can use `versionCode 1` and `versionName "1.0"`. Increment `versionCode`
before **every later upload to any Play track**.

The `.aab` is the Android client. It is not the Docker image. The Docker image
continues to run the backend on Libyan Spider/Jelastic.

## Phase 4: create the Play Console app

1. In Play Console, choose **Create app**.
2. Set the name, default language, app/game type, free/paid choice, and required
   declarations.
3. Confirm that Play Console shows the package `com.albayan.app` after the
   first `.aab` upload.
4. Complete the Store listing, App content, Content rating, Target audience,
   Ads declaration, Data safety, Privacy policy and App access sections.
5. In **App access**, enter the dedicated reviewer credentials and simple
   instructions. Test those credentials again from a clean phone/browser.
6. Verify that the developer name in the listing and the operator identity in
   the privacy policy match the exact Personal-account identity confirmed by
   the owner.

Use the declaration notes in `STORE_CHECKLIST.md`. In particular, do not confuse
Albayan's customer ad-management records with ads displayed inside the app.
Confirm with the owner whether the internal wallet/service subscription code is
only bookkeeping/free access or whether real payments unlock digital features;
the answer changes the required Play payments review.

Answer every declaration from the released product, not from intention. If a
feature or policy page has not been deployed yet, do not claim that it exists.

## Phase 5: Internal testing first

Internal testing is the fast safety check and does not satisfy the 12-testers/
14-days production requirement.

1. Open **Testing > Internal testing**.
2. Create a tester email list. Use Google accounts the testers can open on their
   Android phones.
3. Create a release and upload `app-release.aab`.
4. Add release notes, review warnings, and start the internal rollout.
5. Send testers the Play opt-in link. A tester must opt in before the Play
   install link works for that account.
6. Install from Google Play, not only by USB, and test the production backend.
7. Fix problems, increment `versionCode`, build a new `.aab`, and upload again.

Remain on Internal testing until the main mobile workflows and store
declarations are trustworthy.

## Phase 6: Closed testing — 12 testers for 14 continuous days

1. Open **Testing > Closed testing** and create the required track.
2. Add at least 15-20 reliable testers even though the minimum is 12.
3. Upload the tested `.aab` (or a newer build with a higher `versionCode`).
4. Finish all declarations required to submit the closed release for review.
5. Send each tester the closed-test opt-in link.
6. Confirm in Play Console that at least 12 testers are opted in.
7. Keep at least 12 opted in continuously for the full 14 days. If the count
   drops below 12, do not assume the requirement is still satisfied.
8. Ask testers to genuinely use the app during the period and report issues.
   Test both Arabic and English and more than one phone size/Android version.
9. Record feedback, fixes, dates and resulting version codes. Google asks about
   testing quality and changes when production access is requested.

Do not buy testers or use fake accounts merely to reach the number. Use staff,
trusted customers, friends, or other legitimate testers who can keep the app
installed and provide real feedback.

## Phase 7: apply for production access

After Play Console confirms the testing criterion:

1. Choose **Apply for production access**.
2. Describe who tested, how they used Albayan, what feedback they gave, what
   was fixed, and why the app is ready.
3. Answer truthfully and include concrete examples from the testing notes.
4. Submit the application and wait for Google's decision. Completing 14 days
   makes the account eligible to apply; it does not guarantee approval.
5. If Google asks for more testing, follow the requested additional work before
   applying again.

## Phase 8: production release

1. Resolve every blocking Play Console item.
2. Build the final `.aab` from the exact tested commit with a new higher
   `versionCode` if the bundle changed.
3. Re-test reviewer credentials, privacy/deletion URLs, login, photos and core
   money workflows against production.
4. Create the Production release, add release notes and select countries.
5. Prefer a staged rollout when Play Console offers it, then watch Android
   vitals, crashes, reviews and server errors before expanding.

For later updates, keep backend/API changes compatible with the currently
installed Android version. When an update needs both sides, deploy a compatible
backend first, verify it, then roll out the new `.aab`.

## Stop and ask for help if

- Play Console displays a signing certificate or package-name mismatch;
- the `.aab` was built from unknown/uncommitted code;
- the privacy policy, deletion page, or reviewer login is unavailable;
- the required `versionCode` is unclear;
- the 12-tester count or 14-day status shown by Play Console does not match your
  records;
- a Data safety answer would be a guess.
