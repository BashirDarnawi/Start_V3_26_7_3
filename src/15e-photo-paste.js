
// ==========================================
// PHOTO CLIPBOARD SUPPORT
// ==========================================
// Clipboard images always flow through the existing feature upload handlers.
// This is important: pasted photos must receive the same compression, format
// checks, payload limits, permission checks and stale-modal protection as files
// selected with the picker.

const PHOTO_PASTE_TARGETS = new Set(['ad', 'receipt', 'delivery', 'ads-studio', 'clothes-product']);
let _photoPasteListenerInstalled = false;
let _photoClipboardReadInProgress = false;

function isPhotoPasteTextEntry(element) {
  if (!element) return false;
  try {
    if (element.isContentEditable || element.closest?.('[contenteditable="true"], [role="textbox"]')) return true;
  } catch (_) {}
  const tag = String(element.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = String(element.type || 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image'].includes(type);
}

function _looksLikeClipboardImageFile(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  const name = String(file?.name || '').toLowerCase();
  return /\.(?:png|jpe?g|webp|gif)$/i.test(name);
}

function getClipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const images = [];
  const seen = new Set();
  const fingerprints = new Set();
  const add = (file) => {
    if (!file || !_looksLikeClipboardImageFile(file) || seen.has(file)) return;
    const fingerprint = [file.name, file.type, file.size, file.lastModified]
      .map(value => String(value ?? '')).join('\u0000');
    if (fingerprint !== '\u0000\u0000\u0000' && fingerprints.has(fingerprint)) return;
    seen.add(file);
    fingerprints.add(fingerprint);
    images.push(file);
  };

  try {
    for (const item of Array.from(clipboardData.items || [])) {
      if (String(item?.kind || '').toLowerCase() !== 'file') continue;
      const itemType = String(item?.type || '').toLowerCase();
      if (itemType && !itemType.startsWith('image/')) continue;
      add(item.getAsFile?.());
    }
  } catch (_) {}

  // Some Android/WebView clipboard implementations expose only files, not
  // DataTransferItem objects. Keep this fallback without duplicating entries.
  try { Array.from(clipboardData.files || []).forEach(add); } catch (_) {}
  return images;
}

function _photoPasteTargetIsAvailable(target) {
  if (!PHOTO_PASTE_TARGETS.has(target)) return false;
  if (target === 'delivery') {
    return Boolean(document.getElementById('delivery-complete-modal') && document.getElementById('delivery-receipt-image-data'));
  }
  if (target === 'ad') {
    return state.activeModal === 'ad' && Boolean(document.getElementById('ad-photo-previews')) && canModifyAdPhotosInCurrentModal();
  }
  if (target === 'receipt') {
    return state.activeModal === 'receipt' && Boolean(document.getElementById('receipt-photo-previews'));
  }
  if (target === 'clothes-product') {
    return state.activeModal === 'clothes-product' && Boolean(document.getElementById('clothes-product-photo-input'));
  }
  return state.currentView === 'ads-studio'
    && typeof uploadAdsStudioCreativeFiles === 'function'
    && Boolean(document.getElementById('ads-studio-image-input'))
    && (typeof _adsStudioActiveTab === 'undefined' || _adsStudioActiveTab === 'builder');
}

function resolvePhotoPasteTarget(origin = null, requestedTarget = '') {
  const requested = String(requestedTarget || '').trim();
  if (requested && _photoPasteTargetIsAvailable(requested)) return requested;

  try {
    const marked = origin?.closest?.('[data-photo-paste-target]')?.dataset?.photoPasteTarget || '';
    if (_photoPasteTargetIsAvailable(marked)) return marked;
  } catch (_) {}

  // A delivery dialog can sit above the main page, so it has first priority.
  if (_photoPasteTargetIsAvailable('delivery')) return 'delivery';
  if (state.activeModal === 'ad' && _photoPasteTargetIsAvailable('ad')) return 'ad';
  if (state.activeModal === 'receipt' && _photoPasteTargetIsAvailable('receipt')) return 'receipt';
  if (state.activeModal === 'clothes-product' && _photoPasteTargetIsAvailable('clothes-product')) return 'clothes-product';
  if (_photoPasteTargetIsAvailable('ads-studio')) return 'ads-studio';
  return '';
}

function _routePastedPhotoFiles(target, files) {
  const images = Array.from(files || []).filter(_looksLikeClipboardImageFile);
  if (!images.length || !_photoPasteTargetIsAvailable(target)) return false;
  if (target === 'ad') uploadAdPhotos(images);
  else if (target === 'receipt') uploadReceiptPhotos(images);
  else if (target === 'delivery') handleDeliveryReceiptPhotoUpload(images);
  else if (target === 'ads-studio') uploadAdsStudioCreativeFiles(images);
  else if (target === 'clothes-product') uploadClothesProductPhotoFiles(images);
  else return false;
  return true;
}

function _focusPhotoPasteZone(target) {
  try {
    const zone = document.querySelector(`[data-photo-paste-target="${target}"]`);
    zone?.focus?.({ preventScroll: true });
  } catch (_) {}
}

function capturePhotoPasteContext(target) {
  if (target === 'ad') return `${state.activeModal}|${_adPhotoUploadGeneration}`;
  if (target === 'receipt') return `${state.activeModal}|${_receiptPhotoUploadGeneration}`;
  if (target === 'delivery') return document.getElementById('delivery-complete-modal');
  if (target === 'ads-studio') return _adsStudioDraft;
  if (target === 'clothes-product') return `${state.activeModal}|${_clothesPhotoToken}`;
  return null;
}

function _showPhotoPasteInstruction(titleKind = 'ready') {
  const isAr = state.language === 'ar';
  showNotification(
    isAr ? (titleKind === 'blocked' ? 'الصق الصورة يدوياً' : 'جاهز للصق') : (titleKind === 'blocked' ? 'Paste manually' : 'Ready to paste'),
    isAr
      ? 'انسخ صورة، ثم اضغط Ctrl+V هنا. على الهاتف اضغط مطولاً واختر «لصق». ويمكنك دائماً استخدام زر الرفع.'
      : 'Copy an image, then press Ctrl+V here. On a phone, long-press and choose Paste. You can always use Upload too.',
    titleKind === 'blocked' ? 'warning' : 'info'
  );
}

async function pastePhotoFromClipboard(requestedTarget = '') {
  const target = resolvePhotoPasteTarget(document.activeElement, requestedTarget);
  if (!target) return;
  const pasteContext = capturePhotoPasteContext(target);
  _focusPhotoPasteZone(target);

  if (isPackagedMobileApp() && typeof readNativeClipboardImage === 'function') {
    const nativeImage = await readNativeClipboardImage();
    if (nativeImage) {
      if (pasteContext === capturePhotoPasteContext(target)) {
        _routePastedPhotoFiles(target, [nativeImage]);
        if (typeof nativeHaptic === 'function') nativeHaptic('success');
      }
      return;
    }
  }

  if (!navigator?.clipboard || typeof navigator.clipboard.read !== 'function') {
    _showPhotoPasteInstruction('ready');
    return;
  }
  if (_photoClipboardReadInProgress) return;
  _photoClipboardReadInProgress = true;
  try {
    const clipboardItems = await navigator.clipboard.read();
    const images = [];
    for (const item of Array.from(clipboardItems || [])) {
      const imageType = Array.from(item?.types || []).find(type => String(type || '').toLowerCase().startsWith('image/'));
      if (!imageType) continue;
      try {
        const blob = await item.getType(imageType);
        if (blob) images.push(blob);
      } catch (_) {}
    }
    if (!images.length) {
      showNotification(
        state.language === 'ar' ? 'لا توجد صورة منسوخة' : 'No copied image',
        state.language === 'ar' ? 'انسخ صورة أولاً ثم حاول مرة أخرى.' : 'Copy an image first, then try again.',
        'warning'
      );
      return;
    }
    // A clipboard permission prompt can remain open while the user closes one
    // form and opens another. Never deliver its late result into that new form.
    if (pasteContext !== capturePhotoPasteContext(target)) return;
    _routePastedPhotoFiles(target, images);
  } catch (_) {
    // Permission prompts and WebView clipboard restrictions vary by platform.
    // Keep the keyboard paste event available as a reliable fallback.
    _focusPhotoPasteZone(target);
    _showPhotoPasteInstruction('blocked');
  } finally {
    _photoClipboardReadInProgress = false;
  }
}

function handlePhotoPasteEvent(event) {
  // Never steal ordinary text paste from names, phone numbers, notes or money
  // fields, even if that field lives inside a photo-enabled form.
  if (isPhotoPasteTextEntry(event?.target) || isPhotoPasteTextEntry(document.activeElement)) return false;
  const images = getClipboardImageFiles(event?.clipboardData);
  if (!images.length) return false;
  const target = resolvePhotoPasteTarget(event?.target);
  if (!target) return false;
  event.preventDefault?.();
  return _routePastedPhotoFiles(target, images);
}

function setupPhotoPasteSupport() {
  if (_photoPasteListenerInstalled) return;
  _photoPasteListenerInstalled = true;
  document.addEventListener('paste', handlePhotoPasteEvent);
}
