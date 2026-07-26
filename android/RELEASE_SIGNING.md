# Android release signing - one-time setup

To publish on Google Play you must sign the app with your own keystore
(a password-protected certificate file). Create it once and back it up in a
password manager plus a separate secure location. With Google Play App Signing,
this local key is normally your **upload key**; Google protects the app-signing
key and provides an upload-key reset process if the upload key is ever lost.

Never send the keystore or its passwords to an AI/chat, email them to yourself,
or commit them to GitHub.

## 1. Create the keystore (once)

Requires Java (comes with Android Studio). In a terminal:

```
keytool -genkey -v -keystore albayan-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias albayan
```

Answer the identity questions truthfully, choose a strong password, and move
`albayan-release.jks` into the `android/` folder. Only type the passwords into
your own computer. Never paste a password into ChatGPT, Codex, Claude, GitHub,
email, or a support message.

## 2. Create android/key.properties

In PowerShell from the project root:

```powershell
Copy-Item android\key.properties.example android\key.properties
```

Open `android/key.properties` on your own computer and replace every
`CHANGE_ME` value. Both the keystore and `key.properties` are gitignored; they
must never be committed or shared. Back up the `.jks`, alias, and passwords in
a password manager plus one separate secure location.

## 3. Build the signed release

```powershell
Set-Location android
.\gradlew.bat bundleRelease
```

The signed bundle appears at
`android/app/build/outputs/bundle/release/app-release.aab`. That is the file you
upload in Play Console. Enrol in **Play App Signing** when Play Console asks
during the first release setup.

The build now stops with a clear error if `key.properties` is missing, contains
`CHANGE_ME`, or points to a missing keystore. This is a safety check: an
unsigned bundle must never be treated as the Play release. GitHub CI uses a
narrowly named environment flag to create an unsigned bundle only to confirm
that release compilation works; never upload a CI validation bundle.

## Before running the build

Install Android Studio from the official Android developer website. Let its
Setup Wizard install Android SDK Platform 36, Build Tools, Platform Tools, and
a compatible Java 21 runtime. You must personally review and accept the Android
SDK licence prompts on your computer; an AI should not accept legal terms for
you.
