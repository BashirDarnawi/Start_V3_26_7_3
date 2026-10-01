// META ADS — SECURE READ-ONLY SYNCHRONIZATION. Albayan stays the source of
// truth for customers, receipts, payments, rates, photos and notes; Meta facts
// live only in server-controlled meta* fields, shown beside Albayan's values.
// STARTUP half: what ad rows/cards/headers draw, the dialog state sign-out
// resets, the two closers. The dialogs ship in lazy meta-tools.js
// (src/15d-meta-ads.js) via 15d1-meta-tools-loader.js.

const metaAdsUi = {
  open: false, // the renderer draws only while open: a late load never reopens a closed dialog
  adsSeq: 0, // newest ads request; an older reply is dropped
  targetAdId: '',
  status: null,
  accounts: [],
  ads: [],
  selectedAccountId: '',
  search: '',
  loading: false,
  loadingAds: false,
  busyAction: '',
  error: '',
  pendingOperations: new Map()
};
let metaAdsViewportResizeHandler = null;

function metaAdsIsArabic() {
  return state.language === 'ar';
}

function metaAdsFindLocalAd(adId) {
  return (state.ads || []).find(ad => ad && !ad._deleted && String(ad.id) === String(adId || '')) || null;
}

function metaAdsFormatMoney(minor, currency) {
  const amount = Math.max(0, Number(minor) || 0) / 100;
  const code = String(currency || 'USD').toUpperCase().slice(0, 12);
  try {
    return new Intl.NumberFormat('en-US', {  // en-US in Arabic too: ar-LY prints 1.250,00
      style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(amount);
  } catch (_) {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function metaAdsFormatDate(value, withTime = false) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(appDateLocale(), withTime
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium' });
  } catch (_) {
    return date.toLocaleDateString(appDateLocale());
  }
}

function metaAdsDurationDays(ad) {
  const stored = Number(ad?.metaDurationDays);
  if (Number.isSafeInteger(stored) && stored > 0) return stored;
  const start = ad?.metaStartTime ? new Date(ad.metaStartTime) : null;
  const end = ad?.metaEndTime ? new Date(ad.metaEndTime) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const milliseconds = end.getTime() - start.getTime();
  return milliseconds > 0 ? Math.max(1, Math.ceil(milliseconds / 86400000)) : 0;
}

function metaAdsPlannedTotalMinor(ad) {
  const stored = Number(ad?.metaTotalBudgetMinor) || 0;
  if (stored > 0) return Math.round(stored);
  const lifetime = Number(ad?.metaLifetimeBudgetMinor) || 0;
  if (lifetime > 0) return Math.round(lifetime);
  const daily = Number(ad?.metaDailyBudgetMinor) || 0;
  const days = metaAdsDurationDays(ad);
  return daily > 0 && days > 0 ? Math.round(daily * days) : 0;
}

function metaAdsTotalRemainingMinor(ad) {
  const stored = Number(ad?.metaTotalRemainingBudgetMinor);
  if (Number.isFinite(stored) && stored >= 0) return Math.round(stored);
  const total = metaAdsPlannedTotalMinor(ad);
  const spent = Math.max(0, Number(ad?.metaSpendMinor) || 0);
  return total > 0 ? Math.max(Math.round(total - spent), 0) : 0;
}

function metaAdCurrencyIsKnownUSD(ad) {
  // Must be KNOWN dollars. A draft carries Meta's budget minors before the ad
  // account's currency is read, so guessing USD would lock EUR 30 in as $30 of
  // customer debt. Unknown stays manual until a later sync learns it.
  return String(ad?.metaCurrency || '').trim().toUpperCase() === 'USD';
}

function metaAdAutoBudgetUSD(ad) {
  // Meta's REAL planned total in dollars: a linked ad's automatic budget, so a typed one cannot
  // drift from what Meta runs. 0 when unknown: not linked, not known USD, or open-ended (no end).
  if (!ad?.metaAdId) return 0;
  if (!metaAdCurrencyIsKnownUSD(ad)) return 0;
  const minor = metaAdsPlannedTotalMinor(ad);
  return minor > 0 ? Math.round(minor) / 100 : 0;
}

function metaAdRealSpendUSD(ad) {
  // Meta's actual spend in dollars, or null when it cannot be trusted: not
  // linked, never synced (a 0 before the first sync would wrongly promise
  // "nothing was spent"), or an ad account that is not known to be in USD.
  if (!ad?.metaAdId || !ad.metaSyncedAt) return null;
  if (!metaAdCurrencyIsKnownUSD(ad)) return null;
  const minor = Number(ad.metaSpendMinor);
  return Number.isFinite(minor) && minor >= 0 ? Math.round(minor) / 100 : null;
}

function metaAdsIsPlaceholderPageName(value, pageId) {
  const name = String(value || '').trim().toLocaleLowerCase();
  const id = String(pageId || '').trim().toLocaleLowerCase();
  return !name || name === id || name === 'facebook page' || name === `facebook page ${id}` || name === `page ${id}`;
}

function renderMetaAdPageSummary(ad, adPage, adPageDeleted, isAr) {
  const pageId = String(ad?.metaPageId || adPage?.metaPageId || '').trim();
  const localName = String(adPage?.name || '').trim();
  const metaName = String(ad?.metaPageName || adPage?.metaPageName || '').trim();
  // Never display the imported placeholder ("Facebook Page 123…") as if it
  // were the page's name: it just repeats the page ID a second time.
  const realLocalName = metaAdsIsPlaceholderPageName(localName, pageId) ? '' : localName;
  const realMetaName = metaAdsIsPlaceholderPageName(metaName, pageId) ? '' : metaName;
  const pageName = realLocalName || realMetaName;
  const genericLabel = isAr ? 'صفحة فيسبوك' : 'Facebook Page';
  const displayName = pageName || genericLabel;
  const category = String(adPage?.category || ad?.metaPageCategory || '').trim();
  const displayCategory = category && category.toLocaleLowerCase() !== displayName.toLocaleLowerCase() ? category : '';
  if (!pageName && !pageId && !localName) return '<span class="text-xs text-slate-400">-</span>';
  // The ad's own Facebook page vs its local page: flag a mismatch so a mislink is visible at a glance.
  const adFacebookId = String(ad?.metaPageId || '').trim();
  const linkedFacebookId = String(adPage?.metaPageId || '').trim();
  const pageMismatch = !!(adFacebookId && linkedFacebookId && adFacebookId !== linkedFacebookId);
  // Layout (user request): the Facebook page ID first, the page NAME directly
  // below it — the ID must appear exactly once.
  return `<div data-role="meta-page-summary">
    ${pageId ? `<div class="break-all font-mono text-[11px] font-semibold text-slate-500 dark:text-slate-400" title="${isAr ? 'معرف صفحة فيسبوك' : 'Facebook Page ID'}">#${Security.escapeHtml(pageId)}</div>` : ''}
    <div class="${pageId ? 'mt-0.5 ' : ''}break-words text-sm font-semibold ${adPageDeleted ? 'text-slate-500 dark:text-slate-400' : 'text-indigo-700 dark:text-indigo-300'}" ${pageName ? '' : `title="${isAr ? 'اسم الصفحة يُحمَّل من Meta تلقائياً' : 'The page name is loading automatically from Meta'}"`}>${Security.escapeHtml(displayName)}</div>
    ${pageMismatch ? `<div data-role="meta-page-mismatch" class="mt-0.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" title="${isAr ? `الإعلان نُشر على صفحة فيسبوك ${Security.escapeHtml(adFacebookId)} لكنه مرتبط بصفحة محلية لصفحة فيسبوك أخرى (${Security.escapeHtml(linkedFacebookId)})` : `This ad ran on Facebook page ${Security.escapeHtml(adFacebookId)} but is attached to a local page of a different Facebook page (${Security.escapeHtml(linkedFacebookId)})`}">${isAr ? 'صفحة غير مطابقة' : 'Page mismatch'}</div>` : ''}
    ${adPageDeleted ? `<div class="mt-0.5 inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">${isAr ? 'محذوفة' : 'Deleted'}</div>` : ''}
    ${displayCategory ? `<div class="text-xs text-slate-500">${Security.escapeHtml(displayCategory)}</div>` : ''}
  </div>`;
}

function adPagePictureUrl(ad, adPage) {
  // Our OWN archived copy wins: signed fbcdn links expire (and stop working
  // entirely once the Meta link is gone), the stored data URL does not.
  const stored = String(adPage?.metaPagePictureData || ad?.metaPagePictureData || '').trim();
  if (stored.indexOf('data:image/') === 0) return stored;
  // Lean page record (server lists omit the archived picture): the picture
  // route serves it by id, through the native interceptor on the phone.
  if (adPage && adPage._mediaOmitted === true && adPage.id && String(adPage.metaPagePictureArchivedFrom || '').trim() && typeof isServerModeEnabled === 'function' && isServerModeEnabled()) {
    return protectedImageUrl(`/api/collections/pages/${encodeURIComponent(String(adPage.id))}/picture?v=${Math.max(0, Number(adPage._lastModified) || 0)}`);
  }
  // Server-synced Facebook Page profile picture: the ad's own copy first
  // (refreshed by every Meta sync pass, so its signed URL stays fresh), then
  // the linked page record's copy for ads the sync has not revisited yet.
  const url = String(ad?.metaPagePictureUrl || adPage?.metaPagePictureUrl || '').trim();
  return /^https:\/\//i.test(url) ? url : '';
}

// The ad creative to display: archived copy first, signed link as fallback.
function metaAdThumbnailSrc(ad) {
  const stored = String(ad?.metaThumbnailData || '').trim();
  if (stored.indexOf('data:image/') === 0) return stored;
  return String(ad?.metaThumbnailUrl || '').trim();
}

function renderAdPageAvatar(ad, adPage, isAr, besideTile = true) {
  const url = adPagePictureUrl(ad, adPage);
  if (!url) return '';
  // The main tile already shows the page picture (page_avatar, no visible uploads): no second copy.
  const photoCount = getAdPhotoCount(ad);
  const uploadedVisible = photoCount > 0 && can('ads', 'viewPhotos');
  if (!uploadedVisible && String(ad?.metaThumbnailSource || '') === 'page_avatar') return '';
  const pageName = String(adPage?.name || ad?.metaPageName || '').trim();
  const label = pageName
    ? (isAr ? `صورة صفحة ${pageName}` : `${pageName} page picture`)
    : (isAr ? 'صورة صفحة فيسبوك' : 'Facebook Page picture');
  // is-solo: no photo tile renders beside the avatar (manual ad without
  // uploads), so the tile-centering offset would just push it out of line.
  return `<span class="ad-page-avatar${besideTile ? '' : ' is-solo'}" role="img" title="${Security.escapeHtml(label)}" aria-label="${Security.escapeHtml(label)}">
    <img src="${Security.escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="adPageAvatarError(this)">
  </span>`;
}

function adPageAvatarError(img) {
  // Signed avatar URLs expire between syncs. A dead one disappears quietly
  // instead of leaving a broken-image circle beside the ad photo; the next
  // sync pass stores a fresh URL.
  img?.closest?.('.ad-page-avatar')?.remove();
}

function renderMetaAdThumbnail(ad, isAr) {
  if (!ad?.metaAdId) return '';
  if (!metaAdThumbnailSrc(ad)) {
    // Real photo not resolved yet: an honest "photo loading" tile (never the page logo);
    // admins see which Meta doors were closed in the tooltip.
    const pending = isAr ? 'صورة الإعلان قيد التحميل من Meta' : 'Ad photo is loading from Meta';
    const trace = isCurrentUserAdmin() && ad.metaMediaTrace ? ` · ${String(ad.metaMediaTrace)}` : '';
    return `<div class="meta-ad-thumbnail-button meta-ad-thumbnail-placeholder" role="img" title="${Security.escapeHtml(pending + trace)}" aria-label="${Security.escapeHtml(pending)}"><i data-lucide="image" class="h-5 w-5"></i></div>`;
  }
  // A page_avatar photo is the Facebook page's picture standing in for the
  // real ad photo (which Meta refuses to expose to the read-only key).
  const isPageAvatar = String(ad.metaThumbnailSource || '') === 'page_avatar';
  const label = isPageAvatar
    ? (isAr ? 'صورة الصفحة — صورة الإعلان الأصلية غير متاحة من Meta' : "Page picture — Meta does not expose this ad's original photo")
    : (isAr ? 'عرض صورة إعلان Meta' : 'View Meta ad image');
  return `<button type="button" data-meta-preview-ad-id="${Security.escapeHtml(String(ad.id || ''))}" onclick="openMetaAdPreview(this.dataset.metaPreviewAdId)" class="meta-ad-thumbnail-button" title="${Security.escapeHtml(label)}" aria-label="${Security.escapeHtml(label)}">
    <img src="${Security.escapeHtml(metaAdThumbnailSrc(ad))}" alt="${label}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="metaAdsThumbnailError(this)">
    <span class="meta-ad-thumbnail-badge"><i data-lucide="maximize-2" class="h-3 w-3"></i></span>
  </button>`;
}

function renderAdPrimaryThumbnail(ad, isAr) {
  const photoCount = getAdPhotoCount(ad);
  // Albayan uploads are private business documents. Show them only to users
  // who already have the same View Photos permission used by the full viewer.
  if (!photoCount || !can('ads', 'viewPhotos')) return renderMetaAdThumbnail(ad, isAr);

  const primaryIndex = getAdPrimaryPhotoIndex(ad, photoCount);
  let source = '';
  let credentialAttribute = '';
  if (isServerModeEnabled()) {
    const version = Math.max(0, Number(ad?._lastModified) || 0);
    source = protectedImageUrl(`/api/collections/ads/${encodeURIComponent(String(ad.id || ''))}/primary-photo?index=${primaryIndex}&v=${version}`);
    // Required by the packaged iOS/Android app because its WebView origin is
    // different from albayanhub.com and the protected image uses the session.
    if (getServerBaseUrl()) credentialAttribute = ' crossorigin="use-credentials"';
  } else {
    source = getAdPhotoSources(ad)[primaryIndex] || '';
  }
  if (!source) return renderMetaAdThumbnail(ad, isAr);

  const label = isAr
    ? `عرض الصورة الرئيسية المرفوعة (${primaryIndex + 1} من ${photoCount})`
    : `View uploaded main photo (${primaryIndex + 1} of ${photoCount})`;
  return `<button type="button" data-ad-id="${Security.escapeHtml(String(ad.id || ''))}" data-photo-index="${primaryIndex}" onclick="openAdPhotoViewer(this.dataset.adId, Number(this.dataset.photoIndex), this)" class="meta-ad-thumbnail-button" title="${Security.escapeHtml(label)}" aria-label="${Security.escapeHtml(label)}">
    <img src="${Security.escapeHtml(source)}" alt="${Security.escapeHtml(label)}" loading="lazy" decoding="async"${credentialAttribute} onerror="adUploadedThumbnailError(this)">
    <span class="meta-ad-thumbnail-badge" aria-hidden="true"><i data-lucide="maximize-2" class="h-3 w-3"></i></span>
    <span class="absolute bottom-0 left-0 rounded-tr-md bg-emerald-600/90 px-1 py-0.5 text-[9px] font-black leading-none text-white">${primaryIndex + 1}/${photoCount}</span>
  </button>`;
}

function adUploadedThumbnailError(img) {
  // Never replace a failed Albayan upload with a Meta/page picture: that can
  // show a believable but wrong image. Keep the failure explicit and retryable
  // through View Photos / Choose main photo.
  const button = img?.closest?.('.meta-ad-thumbnail-button');
  if (!button || button.classList.contains('meta-ad-thumbnail-placeholder')) return;
  const unavailable = metaAdsIsArabic() ? 'الصورة المرفوعة غير متاحة' : 'Uploaded photo unavailable';
  button.classList.add('meta-ad-thumbnail-placeholder');
  button.title = unavailable;
  button.setAttribute('aria-label', unavailable);
  button.innerHTML = '<i data-lucide="image-off" class="h-5 w-5"></i>';
  IconQueue.schedule(button);
}

function metaAdsThumbnailError(img) {
  // Signed Meta photo URLs expire: degrade to the "photo loading" tile, never hide the tile.
  const button = img?.closest?.('.meta-ad-thumbnail-button');
  if (!button || button.classList.contains('meta-ad-thumbnail-placeholder')) return;
  const pending = metaAdsIsArabic() ? 'صورة الإعلان قيد التحميل من Meta' : 'Ad photo is loading from Meta';
  button.classList.add('meta-ad-thumbnail-placeholder');
  button.disabled = true;
  button.title = pending;
  button.setAttribute('aria-label', pending);
  button.innerHTML = '<i data-lucide="image" class="h-5 w-5"></i>';
  IconQueue.schedule(button);
}

function openMetaAdPreview(adId) {
  const ad = metaAdsFindLocalAd(adId);
  if (!metaAdThumbnailSrc(ad)) return;
  const isAr = metaAdsIsArabic();
  document.getElementById('meta-ad-preview-modal')?.remove();
  const title = ad.metaAdName || (isAr ? 'صورة إعلان Meta' : 'Meta ad image');
  document.body.insertAdjacentHTML('beforeend', `<div id="meta-ad-preview-modal" role="dialog" aria-modal="true" aria-labelledby="meta-ad-preview-title" class="mobile-dialog-overlay fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm" onclick="if(event.target === this) this.remove()">
    <div class="w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between gap-3 border-b border-slate-200 p-3 dark:border-slate-700 sm:p-4">
        <div class="min-w-0"><h2 id="meta-ad-preview-title" class="truncate font-black text-slate-800 dark:text-white">${Security.escapeHtml(title)}</h2><p class="truncate text-xs text-slate-500">${Security.escapeHtml(ad.metaAdAccountName || '')}</p></div>
        <button type="button" onclick="document.getElementById('meta-ad-preview-modal').remove()" class="touch-target inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
      </div>
      <div class="flex max-h-[75dvh] items-center justify-center overflow-auto bg-slate-100 p-2 dark:bg-slate-950 sm:p-4"><img src="${Security.escapeHtml(metaAdThumbnailSrc(ad))}" alt="${Security.escapeHtml(title)}" class="max-h-[70dvh] max-w-full rounded-xl object-contain" referrerpolicy="no-referrer"></div>
    </div>
  </div>`);
  lucide.createIcons();
}

function metaAdsStatusTone(value) {
  const status = String(value || '').toUpperCase();
  if (['ACTIVE'].includes(status)) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (['PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'].includes(status)) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  if (['DISAPPROVED', 'WITH_ISSUES', 'ERROR'].includes(status)) return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300';
  return 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
}

function renderMetaAdsHeaderButton(isAr) {
  if (!isCurrentUserAdmin() || !isServerModeEnabled()) return '';
  // The dialogs behind this header live in meta-tools.js: warm it while an Admin sees the Ads list.
  if (typeof preloadMetaTools === 'function') preloadMetaTools();
  return `<button type="button" onclick="openMetaAdsConnectionModal()" class="btn-shine inline-flex min-h-11 items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 font-bold text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200" title="${isAr ? 'اتصال آمن للقراءة فقط مع إعلانات Meta' : 'Secure read-only Meta Ads connection'}"><i data-lucide="facebook" class="h-4 w-4"></i><span>${isAr ? 'ربط Meta' : 'Meta Sync'}</span></button>`;
}

// ==========================================
// META INSIGHTS — ACTIVE PAGES & REMAINING BUDGET TRACKERS
// ==========================================

const metaInsightsUi = {
  open: false,
  loading: false,
  refreshing: false,
  error: '',
  stats: null,
  loadedAtMs: 0,
  requestSeq: 0,
  funds: null,
  fundsLoading: false,
  fundsError: '',
  fundsAtMs: 0,
  fundsSeq: 0
};

function metaAdsActiveRemainingSummary() {
  // Combined remaining budget of every Albayan ad whose linked Meta ad is
  // currently ACTIVE, grouped per ad account. Pure local computation.
  // Open-ended ads (daily budget, no end date) have no total budget, so they
  // are reported separately instead of silently contributing 0.
  const byAccount = new Map();
  let totalMinor = 0;
  let count = 0;
  let openEnded = 0;
  let currency = 'USD';
  let currencySet = false;
  (state.ads || []).forEach(ad => {
    if (!ad || ad._deleted || ad.recordType === 'receipt' || !ad.metaAdId) return;
    if (String(ad.metaEffectiveStatus || '').toUpperCase() !== 'ACTIVE') return;
    if (!currencySet && ad.metaCurrency) { currency = String(ad.metaCurrency); currencySet = true; }
    if (metaAdsPlannedTotalMinor(ad) <= 0) {
      openEnded += 1;
      return;
    }
    const remaining = metaAdsTotalRemainingMinor(ad);
    totalMinor += remaining;
    count += 1;
    const key = String(ad.metaAdAccountId || ad.metaAdAccountName || 'unknown');
    const row = byAccount.get(key) || {
      name: String(ad.metaAdAccountName || '').trim() || `#${key}`,
      totalMinor: 0,
      count: 0
    };
    row.totalMinor += remaining;
    row.count += 1;
    byAccount.set(key, row);
  });
  return {
    totalMinor,
    count,
    openEnded,
    currency,
    byAccount: [...byAccount.values()].sort((a, b) => b.totalMinor - a.totalMinor)
  };
}

function renderMetaInsightsHeaderButton(isAr) {
  if (!isCurrentUserAdmin() || !isServerModeEnabled()) return '';
  const summary = metaAdsActiveRemainingSummary();
  return `<button type="button" onclick="openMetaInsightsModal()" class="btn-shine inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 font-bold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200" title="${isAr ? 'الصفحات النشطة (100$ / 90 يوم) والميزانية المتبقية للإعلانات النشطة' : 'Active pages ($100 / 90 days) and remaining budget of active ads'}">
    <i data-lucide="gauge" class="h-4 w-4"></i>
    <span>${isAr ? 'مؤشرات Meta' : 'Meta Insights'}</span>
    <span class="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-black text-white" title="${isAr ? `المتبقي لـ ${summary.count} إعلان نشط` : `Remaining for ${summary.count} active ad(s)`}">${Security.escapeHtml(metaAdsFormatMoney(summary.totalMinor, summary.currency))}</span>
  </button>`;
}

function closeMetaInsightsModal() {
  metaInsightsUi.open = false;
  document.getElementById('meta-insights-modal')?.remove();
}

function renderMetaAdStatusSummary(ad, isAr) {
  if (!ad || !ad.metaAdId) return '';
  const liveStatus = String(ad.metaEffectiveStatus || ad.metaConfiguredStatus || 'UNKNOWN');
  const synced = metaAdsFormatDate(ad.metaSyncedAt, true);
  const errorCode = String(ad.metaSyncErrorCode || '');
  // Meta throttling is one shared provider pause, not a failure of this ad.
  // Older rows may still contain the previous per-ad error; hide it here and
  // show the single safe retry state in the Meta Sync dialog instead.
  const providerThrottle = errorCode.toLowerCase().includes('rate_limited');
  const error = providerThrottle ? '' : String(ad.metaSyncError || '');
  const accountName = String(ad.metaAdAccountName || '').trim();
  const accountId = String(ad.metaAdAccountId || '').trim();
  const historyCount = typeof getMetaAdHistoryCount === 'function' ? getMetaAdHistoryCount(ad) : (Number(ad.metaChangeCount) || 0);
  return `<div data-role="meta-ad-status" class="mt-2 max-w-[15rem] rounded-lg border border-blue-100 bg-blue-50/70 p-2 text-[10px] leading-4 dark:border-blue-900 dark:bg-blue-950/30">
    <div class="flex flex-wrap items-center gap-1"><span class="font-bold text-blue-700 dark:text-blue-300">Meta</span><span class="rounded-full px-1.5 py-0.5 font-bold ${metaAdsStatusTone(liveStatus)}">${Security.escapeHtml(liveStatus)}</span></div>
    ${ad.metaAdName ? `<div class="mt-1 truncate font-medium text-slate-700 dark:text-slate-200" title="${Security.escapeHtml(ad.metaAdName)}">${Security.escapeHtml(ad.metaAdName)}</div>` : ''}
    ${(accountName || accountId) ? `<div data-role="meta-ad-account" class="mt-1 flex items-start gap-1 text-slate-600 dark:text-slate-300" title="${Security.escapeHtml(accountName || `Ad account ${accountId}`)}"><i data-lucide="briefcase-business" class="mt-0.5 h-3 w-3 shrink-0"></i><span class="min-w-0 break-words"><strong>${isAr ? 'حساب الإعلانات' : 'Ad account'}:</strong> ${Security.escapeHtml(accountName || `#${accountId}`)}${accountName && accountId ? ` <span class="text-slate-400">#${Security.escapeHtml(accountId)}</span>` : ''}</span></div>` : ''}
    ${synced ? `<div class="text-slate-500">${isAr ? 'آخر مزامنة' : 'Last sync'}: ${Security.escapeHtml(synced)}</div>` : ''}
    <button type="button" data-meta-history-ad-id="${Security.escapeHtml(String(ad.id || ''))}" onclick="showMetaAdHistory(this.dataset.metaHistoryAdId)" class="meta-ad-history-button" title="${isAr ? 'عرض سجل تغييرات Meta' : 'View Meta change history'}" aria-label="${isAr ? 'عرض سجل تغييرات Meta' : 'View Meta change history'}"><i data-lucide="history" class="h-3.5 w-3.5"></i><span>${isAr ? 'سجل Meta' : 'Meta history'}</span><strong>${historyCount}</strong></button>
    ${error ? `<div class="mt-1 text-rose-600 dark:text-rose-300" title="${Security.escapeHtml(error)}">${Security.escapeHtml(error)}${errorCode ? ` <span class="font-mono opacity-70">[${Security.escapeHtml(errorCode)}]</span>` : ''}</div>` : ''}
  </div>`;
}

function renderMetaAdBudgetSummary(ad, isAr) {
  if (!ad || !ad.metaAdId) return '';
  const currency = ad.metaCurrency || 'USD';
  const daily = Number(ad.metaDailyBudgetMinor) || 0;
  const lifetime = Number(ad.metaLifetimeBudgetMinor) || 0;
  const total = metaAdsPlannedTotalMinor(ad);
  const remaining = metaAdsTotalRemainingMinor(ad);
  const totalKind = lifetime > 0 || ad.metaTotalBudgetKind === 'lifetime' ? 'lifetime' : (total > 0 ? 'estimated_daily' : 'open_ended');
  return `<div data-role="meta-ad-budget" class="mt-1 text-[10px] font-medium text-blue-600 dark:text-blue-300">
    ${daily ? `<div>${isAr ? 'ميزانية Meta اليومية' : 'Meta daily'}: ${Security.escapeHtml(metaAdsFormatMoney(daily, currency))}</div>` : ''}
    ${total ? `<div class="font-bold">${totalKind === 'lifetime' ? (isAr ? 'ميزانية Meta الكلية' : 'Meta total') : (isAr ? 'الإجمالي المخطط' : 'Planned total')}: ${Security.escapeHtml(metaAdsFormatMoney(total, currency))}</div>` : (daily ? `<div>${isAr ? 'الإجمالي' : 'Total'}: ${isAr ? 'مفتوح بدون تاريخ انتهاء' : 'Open-ended (no end date)'}</div>` : '')}
    <div>${isAr ? 'مصروف Meta' : 'Meta spent'}: ${Security.escapeHtml(metaAdsFormatMoney(ad.metaSpendMinor, currency))}</div>
    ${total ? `<div class="font-bold text-emerald-700 dark:text-emerald-300">${isAr ? 'المتبقي من الميزانية الكلية' : 'Total remaining'}: ${Security.escapeHtml(metaAdsFormatMoney(remaining, currency))}</div>` : ''}
  </div>`;
}

function renderMetaAdScheduleSummary(ad, isAr) {
  if (!ad || !ad.metaAdId) return '';
  const start = metaAdsFormatDate(ad.metaStartTime);
  const end = metaAdsFormatDate(ad.metaEndTime);
  const days = metaAdsDurationDays(ad);
  if (!start && !end) return '';
  return `<div data-role="meta-ad-schedule" class="mt-2 border-t border-blue-100 pt-1 text-[10px] text-blue-600 dark:border-blue-900 dark:text-blue-300">
    <div class="font-bold">Meta</div>
    ${days ? `<div class="font-bold">${isAr ? 'المدة' : 'Duration'}: ${days} ${isAr ? 'يوم' : `day${days === 1 ? '' : 's'}`}</div>` : ''}
    ${start ? `<div>${isAr ? 'بدء' : 'Start'}: ${Security.escapeHtml(start)}</div>` : ''}
    ${end ? `<div>${isAr ? 'انتهاء' : 'End'}: ${Security.escapeHtml(end)}</div>` : ''}
  </div>`;
}

function renderMetaAdActionButton(ad, isAr) {
  if (!isCurrentUserAdmin() || !isServerModeEnabled() || !ad) return '';
  const linked = !!ad.metaAdId;
  return `<button type="button" data-action="meta-ad-link" data-ad-id="${Security.escapeHtml(String(ad.id || ''))}" onclick="openMetaAdsConnectionModal(this.dataset.adId)" class="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold ${linked ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200' : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300'}" title="${linked ? (isAr ? 'عرض ومزامنة رابط Meta' : 'View and sync Meta link') : (isAr ? 'ربط هذا الإعلان بإعلان Meta' : 'Link this ad to Meta')}"><i data-lucide="${linked ? 'refresh-cw' : 'link'}" class="h-4 w-4"></i><span>${linked ? 'Meta' : (isAr ? 'ربط' : 'Link')}</span></button>`;
}

function closeMetaAdsConnectionModal() {
  metaAdsUi.open = false;
  document.getElementById('meta-ads-modal')?.remove();
  if (metaAdsViewportResizeHandler) {
    window.removeEventListener('resize', metaAdsViewportResizeHandler);
    window.visualViewport?.removeEventListener('resize', metaAdsViewportResizeHandler);
    metaAdsViewportResizeHandler = null;
  }
  metaAdsUi.busyAction = '';
}
