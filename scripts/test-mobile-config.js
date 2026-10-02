#!/usr/bin/env node
/** Prevent Android/iOS identity and release versions from drifting apart. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const failures = [];
const capacitor = JSON.parse(read('capacitor.config.json'));
const packageJson = JSON.parse(read('package.json'));
const android = read('android/app/build.gradle');
const iosProject = read('ios/App/App.xcodeproj/project.pbxproj');
const iosPlist = read('ios/App/App/Info.plist');
const androidManifest = read('android/app/src/main/AndroidManifest.xml');

function one(text, regex, label) {
  const match = text.match(regex);
  if (!match) failures.push(`Could not read ${label}.`);
  return match?.[1] || '';
}
function uniqueMatches(text, regex) {
  return [...new Set([...text.matchAll(regex)].map(match => match[1]))];
}

const androidId = one(android, /applicationId\s+["']([^"']+)["']/, 'Android applicationId');
const androidVersion = one(android, /versionName\s+["']([^"']+)["']/, 'Android versionName');
const androidCode = one(android, /versionCode\s+(\d+)/, 'Android versionCode');
const iosIds = uniqueMatches(iosProject, /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g);
const iosVersions = uniqueMatches(iosProject, /MARKETING_VERSION\s*=\s*([^;]+);/g);
const iosBuilds = uniqueMatches(iosProject, /CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g);
// package.json carries a 3-segment version ("1.0.0", "1.0.1"); the stores show
// "1.0" / "1.0.1". Only a trailing ".0" patch is dropped, so a patch release
// ("1.0.1") must be written in all three places and a mismatch is reported as
// what it is, not hidden by cutting the version to two segments.
const marketingVersion = version => String(version || '').trim().replace(/^(\d+\.\d+)\.0$/, '$1');
const packageMarketingVersion = marketingVersion(packageJson.version);

if (androidId !== capacitor.appId) failures.push(`Android applicationId (${androidId}) differs from Capacitor appId (${capacitor.appId}).`);
if (iosIds.length !== 1 || iosIds[0] !== capacitor.appId) failures.push(`iOS bundle ID must be exactly ${capacitor.appId}.`);
if (iosVersions.length !== 1 || marketingVersion(iosVersions[0]) !== marketingVersion(androidVersion)) failures.push('Android versionName and iOS MARKETING_VERSION differ.');
if (marketingVersion(androidVersion) !== packageMarketingVersion) failures.push(`Native version ${androidVersion} differs from package.json version ${packageJson.version} (the same version must be written in Xcode, build.gradle and package.json).`);
if (iosBuilds.length !== 1 || iosBuilds[0] !== androidCode) failures.push('Android versionCode and iOS build number differ.');
if (!Number.isInteger(Number(androidCode)) || Number(androidCode) < 1) failures.push('Native build number must be a positive integer.');
if (!androidManifest.includes('android:scheme="albayan"') || !androidManifest.includes('android:host="auth"')) failures.push('Android app-login deep link is missing.');
if (!iosPlist.includes('<string>albayan</string>')) failures.push('iOS app-login URL scheme is missing.');

// Android 12+ ignores allowBackup="false" for phone-to-phone transfer: a copied
// phone opened signed in, with the business cache and the fingerprint lock
// silently off. Both rule sections must exclude every domain (a section with
// no exclude means "copy everything"; root also covers the WebView's data).
const androidApplication = androidManifest.replace(/<!--[\s\S]*?-->/g, '').match(/<application\b[^>]*>/)?.[0] || '';
if (!androidApplication.includes('android:allowBackup="false"')) failures.push('Android <application> must keep android:allowBackup="false" (Android 11 and older).');
if (!androidApplication.includes('android:dataExtractionRules="@xml/data_extraction_rules"')) {
  failures.push('Android <application> must set android:dataExtractionRules="@xml/data_extraction_rules" (Android 12+ copies app data to a new phone otherwise).');
}
const extractionRulesFile = 'android/app/src/main/res/xml/data_extraction_rules.xml';
if (!fs.existsSync(path.join(ROOT, extractionRulesFile))) {
  failures.push(`${extractionRulesFile} is missing (a copied Android phone would open signed in).`);
} else {
  const rules = read(extractionRulesFile).replace(/<!--[\s\S]*?-->/g, '');
  if (/<include\b/.test(rules)) failures.push(`${extractionRulesFile} must not include anything: no app data leaves the phone.`);
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = rules.match(new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`))?.[1];
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
      if (!new RegExp(`<exclude\\s+domain="${domain}"\\s+path="\\."\\s*/>`).test(body || '')) {
        failures.push(`${extractionRulesFile} <${section}> must exclude domain="${domain}" path=".".`);
      }
    }
  }
}

const requiredNativeDependencies = [
  '@capacitor/browser', '@capacitor/camera', '@capacitor/clipboard',
  '@capacitor/haptics', '@capacitor/keyboard', '@capacitor/local-notifications',
  '@capacitor/network', '@capacitor/share',
  '@aparajita/capacitor-biometric-auth', '@aparajita/capacitor-secure-storage'
];
for (const dependency of requiredNativeDependencies) {
  if (!packageJson.dependencies?.[dependency]) failures.push(`Missing native dependency: ${dependency}.`);
}
if (capacitor.plugins?.SystemBars?.insetsHandling !== 'css') failures.push('SystemBars must expose CSS safe-area insets.');
if (capacitor.plugins?.Keyboard?.resize !== 'body') failures.push('Keyboard must resize the body to keep forms visible.');
if (!iosPlist.includes('<key>NSFaceIDUsageDescription</key>')) failures.push('iOS Face ID privacy explanation is missing.');
if (!iosPlist.includes('<key>NSCameraUsageDescription</key>')) failures.push('iOS camera privacy explanation is missing.');

// App Store Connect rejects an upload (ITMS-91053) when code inside the app
// uses a "required reason" API that no privacy manifest declares. The camera
// plugin's IONCameraLib.framework contains code that reads file creation dates
// (URLResourceKey.creationDateKey), and Swift Package Manager does not package
// that library's own manifest, so the app ships one and copies it into App.app.
const privacyManifestFile = 'ios/App/App/PrivacyInfo.xcprivacy';
if (!fs.existsSync(path.join(ROOT, privacyManifestFile))) {
  failures.push(`${privacyManifestFile} is missing (App Store Connect rejects the upload with ITMS-91053).`);
} else {
  const manifest = read(privacyManifestFile).replace(/<!--[\s\S]*?-->/g, '');
  if (!/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(manifest)) failures.push('iOS privacy manifest must set NSPrivacyTracking to false (the app does not track).');
  const fileTimestamp = [...manifest.matchAll(/<dict>((?:(?!<\/?dict>)[\s\S])*)<\/dict>/g)].map(match => match[1])
    .find(body => /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryFileTimestamp<\/string>/.test(body));
  const reasons = fileTimestamp?.match(/<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] || '';
  for (const reason of ['C617.1', '3B52.1']) {
    if (!reasons.includes(`<string>${reason}</string>`)) failures.push(`iOS privacy manifest must declare NSPrivacyAccessedAPICategoryFileTimestamp with reason ${reason} (the camera library's own reasons).`);
  }
}
const pbxObject = id => iosProject.match(new RegExp(`\\b${id} /\\*[^*]*\\*/ = \\{\\r?\\n([\\s\\S]*?)\\r?\\n\\t\\t\\};`))?.[1] || '';
const privacyBuildFile = iosProject.match(/\b([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy in Resources \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/; \};/);
if (!privacyBuildFile
  || !new RegExp(`\\b${privacyBuildFile[2]} /\\* PrivacyInfo\\.xcprivacy \\*/ = \\{isa = PBXFileReference;[^}]*\\bpath = PrivacyInfo\\.xcprivacy; sourceTree = "<group>"; \\};`).test(iosProject)
  || !pbxObject('504EC3061FED79650016851F').includes(`${privacyBuildFile[2]} /* PrivacyInfo.xcprivacy */,`)
  || !pbxObject('504EC3021FED79650016851F').includes(`${privacyBuildFile[1]} /* PrivacyInfo.xcprivacy in Resources */,`)) {
  failures.push("Xcode must copy App/PrivacyInfo.xcprivacy into the app: list it in the App group and in the App target's Copy Bundle Resources phase.");
}
if (/no privacy manifest is needed/i.test(read('docs/store/IOS_APP_STORE_RELEASE.md').replace(/\s+/g, ' '))) {
  failures.push('docs/store/IOS_APP_STORE_RELEASE.md still says no privacy manifest is needed.');
}

if (failures.length) {
  console.error(`Mobile configuration failed (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
  failures.forEach(problem => console.error(`  - ${problem}`));
  process.exit(1);
}

console.log(`Mobile configuration passed: ${capacitor.appId} v${androidVersion} build ${androidCode}.`);
