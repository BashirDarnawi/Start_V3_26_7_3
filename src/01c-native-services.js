// ==========================================
// NATIVE DEVICE SERVICES
// ==========================================
// This module is the single bridge between Albayan's shared web code and the
// iOS/Android shell. Every feature has a browser fallback, so the website and
// PWA remain fully usable without Capacitor plugins.

const NATIVE_SECURE_PREFIX = 'albayan_secure_v1_';
const NATIVE_PHOTO_PENDING_KEY = 'albayan_native_photo_pending';
const NATIVE_APP_LOCK_AFTER_MS = 30 * 1000;
const NATIVE_REMINDER_LIMIT = 50;

let _nativeServicesPromise = null;
let _nativeViewportFrame = 0;
let _nativeBackgroundedAt = 0;
let _nativeUnlockBusy = false;
let _nativeReminderTimer = null;
let _nativePrefs = {
  ready: false,
  biometricEnabled: false,
  remindersEnabled: false,
  biometricInfo: null
};

function getCapacitorPlugin(name) {
  if (!isPackagedMobileApp()) return null;
  try { return window.Capacitor?.Plugins?.[name] || null; }
  catch (_) { return null; }
}

function nativeFeatureAvailable(name, method = '') {
  const plugin = getCapacitorPlugin(name);
  return !!(plugin && (!method || typeof plugin[method] === 'function'));
}

async function _addNativeListener(plugin, eventName, handler) {
  if (!plugin?.addListener) return null;
  try {
    return await plugin.addListener(eventName, handler);
  } catch (error) {
    if (ALBAYAN_DEBUG_MODE) console.warn(`[NativeServices] ${eventName} listener unavailable:`, error?.message || error);
    return null;
  }
}

// Raw bridge calls are intentional here. The app is vanilla JS (not bundled
// ESM), while the plugin's JavaScript wrapper normally performs these same
// calls. ThisDeviceOnly prevents secrets migrating to a different iPhone.
async function nativeSecureGet(key) {
  const plugin = getCapacitorPlugin('SecureStorage');
  if (!plugin?.internalGetItem) return null;
  try {
    const result = await plugin.internalGetItem({
      prefixedKey: NATIVE_SECURE_PREFIX + String(key || ''),
      sync: false
    });
    if (result?.data == null || result.data === '') return null;
    return JSON.parse(result.data);
  } catch (error) {
    if (ALBAYAN_DEBUG_MODE) console.warn('[NativeSecure] Read failed:', error?.message || error);
    return null;
  }
}

async function nativeSecureSet(key, value) {
  const plugin = getCapacitorPlugin('SecureStorage');
  if (!plugin?.internalSetItem) return false;
  try {
    await plugin.internalSetItem({
      prefixedKey: NATIVE_SECURE_PREFIX + String(key || ''),
      data: JSON.stringify(value),
      sync: false,
      access: 1 // KeychainAccess.whenUnlockedThisDeviceOnly; ignored on Android.
    });
    return true;
  } catch (error) {
    console.warn('[NativeSecure] Write failed:', error?.message || error);
    return false;
  }
}

async function nativeSecureRemove(key) {
  const plugin = getCapacitorPlugin('SecureStorage');
  if (!plugin?.internalRemoveItem) return false;
  try {
    await plugin.internalRemoveItem({
      prefixedKey: NATIVE_SECURE_PREFIX + String(key || ''),
      sync: false
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function openNativeBrowser(url) {
  const safeUrl = String(url || '');
  if (!/^https:\/\//i.test(safeUrl)) return false;
  const browser = getCapacitorPlugin('Browser');
  if (browser?.open) {
    try {
      await browser.open({
        url: safeUrl,
        toolbarColor: '#0f4cdb',
        presentationStyle: 'fullscreen'
      });
      return true;
    } catch (error) {
      console.warn('[NativeBrowser] Open failed:', error?.message || error);
    }
  }
  try { return !!window.open(safeUrl, '_blank', 'noopener,noreferrer'); }
  catch (_) { return false; }
}

async function closeNativeBrowser() {
  const browser = getCapacitorPlugin('Browser');
  if (!browser?.close) return;
  try { await browser.close(); } catch (_) {}
}

async function nativeHaptic(kind = 'light') {
  const haptics = getCapacitorPlugin('Haptics');
  if (!haptics) return false;
  try {
    if (kind === 'success' && haptics.notification) {
      await haptics.notification({ type: 'SUCCESS' });
    } else if (kind === 'warning' && haptics.notification) {
      await haptics.notification({ type: 'WARNING' });
    } else if (haptics.impact) {
      await haptics.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
    }
    return true;
  } catch (_) { return false; }
}

async function nativeWriteClipboardText(value) {
  const clipboard = getCapacitorPlugin('Clipboard');
  if (!clipboard?.write) return false;
  try {
    await clipboard.write({ string: String(value ?? '') });
    await nativeHaptic('light');
    return true;
  } catch (_) { return false; }
}

function _nativeDataUrlToFile(dataUrl, fallbackName = 'photo') {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const extension = /png/i.test(match[1]) ? 'png' : /webp/i.test(match[1]) ? 'webp' : /gif/i.test(match[1]) ? 'gif' : 'jpg';
    const blob = new Blob([bytes], { type: match[1] });
    return typeof File === 'function'
      ? new File([blob], `${fallbackName}.${extension}`, { type: match[1], lastModified: Date.now() })
      : blob;
  } catch (_) { return null; }
}

async function readNativeClipboardImage() {
  const clipboard = getCapacitorPlugin('Clipboard');
  if (!clipboard?.read) return null;
  try {
    const result = await clipboard.read();
    if (!String(result?.type || '').toLowerCase().startsWith('image/')) return null;
    return _nativeDataUrlToFile(result.value, 'clipboard-photo');
  } catch (_) { return null; }
}

async function readNativeClipboardText() {
  const clipboard = getCapacitorPlugin('Clipboard');
  if (!clipboard?.read) return '';
  try {
    const result = await clipboard.read();
    if (String(result?.type || '').toLowerCase().startsWith('image/')) return '';
    return String(result?.value || '');
  } catch (_) { return ''; }
}

async function nativeShareContent({ title = 'Albayan', text = '', url = '' } = {}) {
  const share = getCapacitorPlugin('Share');
  if (share?.share) {
    try {
      await share.share({
        title: String(title || 'Albayan').slice(0, 120),
        text: String(text || '').slice(0, 8000),
        ...(url ? { url: String(url) } : {}),
        dialogTitle: String(title || 'Albayan').slice(0, 120)
      });
      await nativeHaptic('success');
      return true;
    } catch (error) {
      // Closing the native share sheet is a normal cancellation, not an error.
      if (!/cancel/i.test(String(error?.message || error))) console.warn('[NativeShare] Failed:', error?.message || error);
      return false;
    }
  }
  if (navigator?.share) {
    try {
      await navigator.share({ title, text, ...(url ? { url } : {}) });
      return true;
    } catch (_) { return false; }
  }
  return false;
}

function _nativePhotoFallbackInput(target) {
  const zone = document.querySelector(`[data-photo-paste-target="${String(target || '')}"]`);
  return zone?.querySelector('input[type="file"]') || null;
}

async function _nativeCameraResultToFile(result) {
  const source = String(result?.webPath || result?.path || '').trim();
  if (!source) return null;
  try {
    const response = await fetch(source);
    const blob = await response.blob();
    const type = blob.type || `image/${String(result?.format || 'jpeg').replace('jpg', 'jpeg')}`;
    return typeof File === 'function'
      ? new File([blob], `albayan-camera-${Date.now()}.${/png/i.test(type) ? 'png' : 'jpg'}`, { type, lastModified: Date.now() })
      : blob;
  } catch (error) {
    console.warn('[NativeCamera] Could not read photo:', error?.message || error);
    return null;
  }
}

async function _deliverNativeCameraResult(result, target, context, attempts = 0) {
  const resolvedTarget = String(target || '');
  if (context != null && typeof capturePhotoPasteContext === 'function' && attempts === 0 && context !== capturePhotoPasteContext(resolvedTarget)) return false;
  if (typeof _photoPasteTargetIsAvailable === 'function' && !_photoPasteTargetIsAvailable(resolvedTarget)) {
    if (attempts < 40) {
      setTimeout(() => _deliverNativeCameraResult(result, resolvedTarget, null, attempts + 1), 250);
      return true;
    }
    showNotification(
      state.language === 'ar' ? 'افتح النموذج مرة أخرى' : 'Open the form again',
      state.language === 'ar' ? 'عاد التطبيق من الكاميرا، لكن نموذج الصورة لم يعد مفتوحاً.' : 'Albayan returned from the camera, but the photo form is no longer open.',
      'warning'
    );
    return false;
  }
  const file = await _nativeCameraResultToFile(result);
  if (!file) return false;
  const routed = typeof _routePastedPhotoFiles === 'function' && _routePastedPhotoFiles(resolvedTarget, [file]);
  if (routed) {
    try { localStorage.removeItem(NATIVE_PHOTO_PENDING_KEY); } catch (_) {}
    await nativeHaptic('success');
  }
  return !!routed;
}

async function takeNativePhoto(requestedTarget = '') {
  const target = typeof resolvePhotoPasteTarget === 'function'
    ? resolvePhotoPasteTarget(document.activeElement, requestedTarget)
    : String(requestedTarget || '');
  if (!target) return false;
  const camera = getCapacitorPlugin('Camera');
  if (!camera?.getPhoto) {
    const input = _nativePhotoFallbackInput(target);
    input?.click?.();
    return !!input;
  }
  if (target === 'delivery' && typeof _flushDeliveryCompletionDraftNow === 'function') {
    _flushDeliveryCompletionDraftNow();
  }
  const context = typeof capturePhotoPasteContext === 'function' ? capturePhotoPasteContext(target) : null;
  try {
    localStorage.setItem(NATIVE_PHOTO_PENDING_KEY, JSON.stringify({ target, createdAt: Date.now() }));
  } catch (_) {}
  try {
    const result = await camera.getPhoto({
      quality: 88,
      width: 1600,
      height: 1600,
      allowEditing: false,
      resultType: 'uri',
      source: 'CAMERA',
      direction: 'REAR',
      saveToGallery: false,
      correctOrientation: true,
      presentationStyle: 'fullscreen'
    });
    return await _deliverNativeCameraResult(result, target, context);
  } catch (error) {
    if (!/cancel/i.test(String(error?.message || error))) {
      showNotification(
        state.language === 'ar' ? 'تعذّر فتح الكاميرا' : 'Camera unavailable',
        state.language === 'ar' ? 'تحقق من إذن الكاميرا ثم حاول مرة أخرى.' : 'Check the camera permission and try again.',
        'error'
      );
    }
    return false;
  }
}

function _updateVisualViewportVariables() {
  _nativeViewportFrame = 0;
  const viewport = window.visualViewport;
  const height = Math.max(1, Math.round(viewport?.height || window.innerHeight || 1));
  const width = Math.max(1, Math.round(viewport?.width || window.innerWidth || 1));
  const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
  document.documentElement.style.setProperty('--app-visual-height', `${height}px`);
  document.documentElement.style.setProperty('--app-visual-width', `${width}px`);
  document.documentElement.style.setProperty('--app-visual-offset-top', `${top}px`);
  const keyboardLikelyOpen = height < Math.max(360, (window.innerHeight || height) * 0.72);
  document.body.classList.toggle('keyboard-open', keyboardLikelyOpen || document.body.classList.contains('native-keyboard-open'));
}

function queueVisualViewportUpdate() {
  if (_nativeViewportFrame) return;
  _nativeViewportFrame = requestAnimationFrame(_updateVisualViewportVariables);
}

function setupAdaptiveViewport() {
  queueVisualViewportUpdate();
  window.addEventListener('resize', queueVisualViewportUpdate, { passive: true });
  window.addEventListener('orientationchange', queueVisualViewportUpdate, { passive: true });
  window.visualViewport?.addEventListener('resize', queueVisualViewportUpdate, { passive: true });
  window.visualViewport?.addEventListener('scroll', queueVisualViewportUpdate, { passive: true });
}

function _setNativeKeyboardOpen(open, keyboardHeight = 0) {
  document.body.classList.toggle('native-keyboard-open', open === true);
  document.body.classList.toggle('keyboard-open', open === true);
  document.documentElement.style.setProperty('--app-keyboard-height', `${Math.max(0, Number(keyboardHeight) || 0)}px`);
  queueVisualViewportUpdate();
}

async function getNativeBiometricInfo(refresh = false) {
  if (_nativePrefs.biometricInfo && !refresh) return _nativePrefs.biometricInfo;
  const biometric = getCapacitorPlugin('BiometricAuthNative');
  if (!biometric?.checkBiometry) return null;
  try {
    _nativePrefs.biometricInfo = await biometric.checkBiometry();
    return _nativePrefs.biometricInfo;
  } catch (_) { return null; }
}

async function authenticateNativeDevice(reason = '') {
  const biometric = getCapacitorPlugin('BiometricAuthNative');
  if (!biometric?.internalAuthenticate) return false;
  const info = await getNativeBiometricInfo(true);
  if (!info?.isAvailable && !info?.deviceIsSecure) return false;
  try {
    await biometric.internalAuthenticate({
      reason: reason || (state.language === 'ar' ? 'افتح تطبيق البيان' : 'Unlock Albayan'),
      cancelTitle: state.language === 'ar' ? 'إلغاء' : 'Cancel',
      allowDeviceCredential: true,
      iosFallbackTitle: state.language === 'ar' ? 'استخدم رمز الجهاز' : 'Use device passcode',
      androidTitle: state.language === 'ar' ? 'افتح البيان' : 'Unlock Albayan',
      androidSubtitle: state.language === 'ar' ? 'استخدم البصمة أو رمز الجهاز' : 'Use biometrics or your device credential',
      androidConfirmationRequired: false,
      androidBiometryStrength: 0
    });
    return true;
  } catch (error) {
    if (!/cancel|systemCancel|appCancel/i.test(String(error?.code || error?.message || error))) {
      console.warn('[NativeSecurity] Authentication failed:', error?.code || error?.message || error);
    }
    return false;
  }
}

function renderNativeAppLock() {
  if (!isPackagedMobileApp() || !_nativePrefs.biometricEnabled || !state?.currentUser) return;
  let lock = document.getElementById('native-app-lock');
  if (!lock) {
    lock = document.createElement('section');
    lock.id = 'native-app-lock';
    lock.className = 'native-app-lock';
    lock.setAttribute('role', 'dialog');
    lock.setAttribute('aria-modal', 'true');
    document.body.appendChild(lock);
  }
  const isAr = state.language === 'ar';
  lock.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  lock.innerHTML = `
    <div class="native-app-lock-card">
      <div class="native-app-lock-icon"><i data-lucide="scan-face" class="h-9 w-9"></i></div>
      <h1>${isAr ? 'البيان مقفل' : 'Albayan is locked'}</h1>
      <p>${isAr ? 'استخدم البصمة أو Face ID أو رمز قفل الهاتف لحماية بيانات العمل.' : 'Use biometrics or your phone passcode to protect business data.'}</p>
      <button type="button" onclick="unlockNativeApp()" class="native-app-lock-button" ${_nativeUnlockBusy ? 'disabled' : ''}>
        ${_nativeUnlockBusy ? (isAr ? 'جارٍ التحقق...' : 'Checking...') : (isAr ? 'فتح التطبيق' : 'Unlock app')}
      </button>
    </div>`;
  try { IconQueue.schedule(lock); } catch (_) {}
  document.body.classList.add('native-app-locked');
}

function removeNativeAppLock() {
  document.getElementById('native-app-lock')?.remove();
  document.body.classList.remove('native-app-locked');
}

async function unlockNativeApp() {
  if (_nativeUnlockBusy) return false;
  _nativeUnlockBusy = true;
  renderNativeAppLock();
  const ok = await authenticateNativeDevice();
  _nativeUnlockBusy = false;
  if (ok) {
    removeNativeAppLock();
    await nativeHaptic('success');
  } else {
    renderNativeAppLock();
  }
  return ok;
}

async function setNativeBiometricLockEnabled(enabled) {
  if (!isPackagedMobileApp()) return false;
  const next = enabled === true;
  if (next) {
    const info = await getNativeBiometricInfo(true);
    if (!info?.isAvailable && !info?.deviceIsSecure) {
      showNotification(
        state.language === 'ar' ? 'حماية الهاتف غير جاهزة' : 'Device protection unavailable',
        state.language === 'ar' ? 'فعّل بصمة أو Face ID أو رمز قفل للهاتف أولاً.' : 'Set up biometrics or a phone passcode first.',
        'warning'
      );
      return false;
    }
    if (!(await authenticateNativeDevice(state.language === 'ar' ? 'فعّل حماية البيان' : 'Enable Albayan protection'))) return false;
  } else if (_nativePrefs.biometricEnabled) {
    if (!(await authenticateNativeDevice(state.language === 'ar' ? 'أوقف حماية البيان' : 'Disable Albayan protection'))) return false;
  }
  const saved = await nativeSecureSet('biometric_lock_enabled', next);
  if (!saved) return false;
  _nativePrefs.biometricEnabled = next;
  if (!next) removeNativeAppLock();
  if (state.currentView === 'settings') render();
  showNotification(
    state.language === 'ar' ? 'تم تحديث حماية الجهاز' : 'Device protection updated',
    next
      ? (state.language === 'ar' ? 'سيُقفل البيان عند مغادرة التطبيق.' : 'Albayan will lock after you leave the app.')
      : (state.language === 'ar' ? 'تم إيقاف قفل التطبيق على هذا الجهاز.' : 'App lock is off on this device.'),
    'success'
  );
  return true;
}

function nativeSecuritySettingsStatus() {
  return {
    isNative: isPackagedMobileApp(),
    ready: _nativePrefs.ready,
    biometricEnabled: _nativePrefs.biometricEnabled,
    remindersEnabled: _nativePrefs.remindersEnabled,
    biometricAvailable: !!(_nativePrefs.biometricInfo?.isAvailable || _nativePrefs.biometricInfo?.deviceIsSecure)
  };
}

function _nativeReminderId(adId) {
  const value = String(adId || '');
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 100000 + (Math.abs(hash >>> 0) % 1900000000);
}

async function syncNativeReconciliationReminders() {
  if (!isPackagedMobileApp() || !_nativePrefs.remindersEnabled || !state?.currentUser) return false;
  const notifications = getCapacitorPlugin('LocalNotifications');
  if (!notifications?.schedule || !notifications?.getPending) return false;
  const now = new Date();
  const candidates = (Array.isArray(state.ads) ? state.ads : [])
    .filter(ad => ad && !ad._deleted && typeof getAdReconciliationAvailableDay === 'function')
    .map(ad => ({ ad, at: getAdReconciliationAvailableDay(ad) }))
    .filter(item => item.at instanceof Date && Number.isFinite(item.at.getTime()) && item.at.getTime() > now.getTime())
    .sort((a, b) => a.at - b.at)
    .slice(0, NATIVE_REMINDER_LIMIT);
  const desired = new Map();
  for (const item of candidates) {
    const at = new Date(item.at);
    at.setHours(9, 0, 0, 0);
    if (at.getTime() <= now.getTime()) at.setTime(now.getTime() + 60 * 1000);
    const id = _nativeReminderId(item.ad.id);
    desired.set(id, {
      id,
      title: state.language === 'ar' ? 'إعلان يحتاج تسوية' : 'Ad ready for reconciliation',
      body: state.language === 'ar' ? 'أدخل المصروف الفعلي وأرجع المتبقي للعميل.' : 'Enter the actual spend and return any remainder to the customer.',
      schedule: { at, allowWhileIdle: true },
      extra: { albayanType: 'reconciliation', adId: String(item.ad.id) }
    });
  }
  try {
    const pending = await notifications.getPending();
    const old = (pending?.notifications || []).filter(note => note?.extra?.albayanType === 'reconciliation');
    if (old.length && notifications.cancel) await notifications.cancel({ notifications: old.map(note => ({ id: note.id })) });
    if (desired.size) await notifications.schedule({ notifications: Array.from(desired.values()) });
    return true;
  } catch (error) {
    console.warn('[NativeNotifications] Sync failed:', error?.message || error);
    return false;
  }
}

function queueNativeReminderSync() {
  if (!isPackagedMobileApp() || !_nativePrefs.remindersEnabled) return;
  clearTimeout(_nativeReminderTimer);
  _nativeReminderTimer = setTimeout(() => syncNativeReconciliationReminders(), 900);
}

async function setNativeRemindersEnabled(enabled) {
  if (!isPackagedMobileApp()) return false;
  const notifications = getCapacitorPlugin('LocalNotifications');
  if (!notifications) return false;
  const next = enabled === true;
  if (next) {
    try {
      let permission = await notifications.checkPermissions();
      if (permission?.display !== 'granted') permission = await notifications.requestPermissions();
      if (permission?.display !== 'granted') {
        showNotification(
          state.language === 'ar' ? 'الإشعارات غير مسموحة' : 'Notifications not allowed',
          state.language === 'ar' ? 'اسمح بالإشعارات من إعدادات الهاتف ثم حاول مرة أخرى.' : 'Allow notifications in your phone settings, then try again.',
          'warning'
        );
        return false;
      }
    } catch (_) { return false; }
  }
  if (!(await nativeSecureSet('reconciliation_reminders_enabled', next))) return false;
  _nativePrefs.remindersEnabled = next;
  if (next) queueNativeReminderSync();
  else {
    try {
      const pending = await notifications.getPending();
      const old = (pending?.notifications || []).filter(note => note?.extra?.albayanType === 'reconciliation');
      if (old.length) await notifications.cancel({ notifications: old.map(note => ({ id: note.id })) });
    } catch (_) {}
  }
  if (state.currentView === 'settings') render();
  return true;
}

async function syncNativeSystemBarsTheme() {
  const bars = getCapacitorPlugin('SystemBars');
  if (!bars?.setStyle) return;
  const dark = document.documentElement.classList.contains('dark');
  try { await bars.setStyle({ style: dark ? 'DARK' : 'LIGHT' }); } catch (_) {}
}

async function initializeNativeSessionProtection() {
  await setupNativeServices();
  if (!isPackagedMobileApp() || !state?.currentUser || !_nativePrefs.biometricEnabled) {
    removeNativeAppLock();
    queueNativeReminderSync();
    return true;
  }
  renderNativeAppLock();
  const unlocked = await unlockNativeApp();
  queueNativeReminderSync();
  return unlocked;
}

async function setupNativeServices() {
  if (_nativeServicesPromise) return _nativeServicesPromise;
  _nativeServicesPromise = (async () => {
    setupAdaptiveViewport();
    if (!isPackagedMobileApp()) {
      _nativePrefs.ready = true;
      return;
    }

    _nativePrefs.biometricEnabled = (await nativeSecureGet('biometric_lock_enabled')) === true;
    _nativePrefs.remindersEnabled = (await nativeSecureGet('reconciliation_reminders_enabled')) === true;
    if (typeof hydrateAppLoginPendingFromSecureStorage === 'function') {
      await hydrateAppLoginPendingFromSecureStorage();
    }
    await getNativeBiometricInfo(true);
    _nativePrefs.ready = true;
    if (_nativePrefs.biometricEnabled) renderNativeAppLock();

    const keyboard = getCapacitorPlugin('Keyboard');
    await _addNativeListener(keyboard, 'keyboardWillShow', event => _setNativeKeyboardOpen(true, event?.keyboardHeight));
    await _addNativeListener(keyboard, 'keyboardWillHide', () => _setNativeKeyboardOpen(false, 0));

    const network = getCapacitorPlugin('Network');
    await _addNativeListener(network, 'networkStatusChange', status => {
      if (!status?.connected) showMobileConnectivityNotice({ serverReachable: false });
      else retryMobileConnection().catch(() => showMobileConnectivityNotice({ serverReachable: false }));
    });

    const app = getCapacitorAppPlugin();
    await _addNativeListener(app, 'appStateChange', event => {
      if (!event?.isActive) {
        _nativeBackgroundedAt = Date.now();
        if (_nativePrefs.biometricEnabled && state?.currentUser) renderNativeAppLock();
        return;
      }
      const protectedSession = _nativePrefs.biometricEnabled && state?.currentUser;
      if (protectedSession && Date.now() - _nativeBackgroundedAt >= NATIVE_APP_LOCK_AFTER_MS) {
        renderNativeAppLock();
        unlockNativeApp();
      } else {
        // Keep private data hidden in the app-switcher snapshot, but do not
        // make a quick return wait for biometrics before the lock timeout.
        removeNativeAppLock();
      }
      queueNativeReminderSync();
    });
    await _addNativeListener(app, 'appRestoredResult', event => {
      if (event?.pluginId !== 'Camera' || event?.methodName !== 'getPhoto' || !event?.data) return;
      let pending = null;
      try { pending = JSON.parse(localStorage.getItem(NATIVE_PHOTO_PENDING_KEY) || 'null'); } catch (_) {}
      if (pending?.target) _deliverNativeCameraResult(event.data, pending.target, null);
    });

    const notifications = getCapacitorPlugin('LocalNotifications');
    await _addNativeListener(notifications, 'localNotificationActionPerformed', async action => {
      if (action?.notification?.extra?.albayanType !== 'reconciliation') return;
      if (_nativePrefs.biometricEnabled && state?.currentUser) await unlockNativeApp();
      if (state?.currentUser && typeof navigateToInternal === 'function') navigateToInternal('reconciliation');
    });

    const browser = getCapacitorPlugin('Browser');
    await _addNativeListener(browser, 'browserFinished', () => {
      // Keep the pending PKCE request: the external login may still return
      // through a deep link after the browser view finishes.
      try { if (typeof render === 'function') render(); } catch (_) {}
    });
    await syncNativeSystemBarsTheme();
  })().catch(error => {
    console.warn('[NativeServices] Setup failed:', error?.message || error);
    _nativePrefs.ready = true;
  });
  return _nativeServicesPromise;
}
