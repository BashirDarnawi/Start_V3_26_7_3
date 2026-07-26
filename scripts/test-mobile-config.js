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
const packageMarketingVersion = String(packageJson.version || '').split('.').slice(0, 2).join('.');

if (androidId !== capacitor.appId) failures.push(`Android applicationId (${androidId}) differs from Capacitor appId (${capacitor.appId}).`);
if (iosIds.length !== 1 || iosIds[0] !== capacitor.appId) failures.push(`iOS bundle ID must be exactly ${capacitor.appId}.`);
if (iosVersions.length !== 1 || iosVersions[0] !== androidVersion) failures.push('Android versionName and iOS MARKETING_VERSION differ.');
if (androidVersion !== packageMarketingVersion) failures.push(`Native version ${androidVersion} differs from package version ${packageJson.version}.`);
if (iosBuilds.length !== 1 || iosBuilds[0] !== androidCode) failures.push('Android versionCode and iOS build number differ.');
if (!Number.isInteger(Number(androidCode)) || Number(androidCode) < 1) failures.push('Native build number must be a positive integer.');
if (!androidManifest.includes('android:scheme="albayan"') || !androidManifest.includes('android:host="auth"')) failures.push('Android app-login deep link is missing.');
if (!iosPlist.includes('<string>albayan</string>')) failures.push('iOS app-login URL scheme is missing.');

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

if (failures.length) {
  console.error(`Mobile configuration failed (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
  failures.forEach(problem => console.error(`  - ${problem}`));
  process.exit(1);
}

console.log(`Mobile configuration passed: ${capacitor.appId} v${androidVersion} build ${androidCode}.`);
