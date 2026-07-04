# Android Release Signing — one-time setup

To publish on Google Play you must sign the app with your own keystore
(a password-protected certificate file). You create it ONCE and keep it
forever — losing it means you can never update the app on the Play Store,
so back it up somewhere safe (password manager + offline copy).

## 1. Create the keystore (once)

Requires Java (comes with Android Studio). In a terminal:

```
keytool -genkey -v -keystore albayan-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias albayan
```

Answer the questions (name/organization — anything reasonable), choose a
strong password, and move `albayan-release.jks` into the `android/` folder.

## 2. Create android/key.properties

Copy `key.properties.example` to `key.properties` in this folder and fill in
the passwords you chose. Both the keystore and key.properties are gitignored —
they must never be committed or shared.

## 3. Build the signed release

```
cd android
./gradlew bundleRelease
```

The signed bundle appears at
`android/app/build/outputs/bundle/release/app-release.aab` — that's the file
you upload in the Play Console.
