// ==========================================
// META ADS — SECURE READ-ONLY SYNCHRONIZATION
// ==========================================
// Albayan remains the source of truth for customers, receipts, payments,
// exchange rates, photos and notes. Meta facts live only in server-controlled
// meta* fields and are displayed beside (never over) Albayan's own values.

const metaAdsUi = {
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
    return new Intl.NumberFormat(metaAdsIsArabic() ? 'ar-LY' : 'en-US', {
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
  // The ad's REAL planned total from Meta, in dollars — used as the automatic
  // ad budget for a linked ad so the typed budget can never drift from what
  // Meta actually runs (e.g. $50 entered for a $30 ad). Returns 0 when the
  // budget cannot be known: not Meta-linked, an ad account that is not known to
  // be in USD, or an open-ended ad (daily budget with no end date has no total).
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
  // Layout (user request): the Facebook page ID first, the page NAME directly
  // below it — the ID must appear exactly once.
  return `<div data-role="meta-page-summary">
    ${pageId ? `<div class="break-all font-mono text-[11px] font-semibold text-slate-500 dark:text-slate-400" title="${isAr ? 'معرف صفحة فيسبوك' : 'Facebook Page ID'}">#${Security.escapeHtml(pageId)}</div>` : ''}
    <div class="${pageId ? 'mt-0.5 ' : ''}break-words text-sm font-semibold ${adPageDeleted ? 'text-slate-500 dark:text-slate-400' : 'text-indigo-700 dark:text-indigo-300'}" ${pageName ? '' : `title="${isAr ? 'اسم الصفحة يُحمَّل من Meta تلقائياً' : 'The page name is loading automatically from Meta'}"`}>${Security.escapeHtml(displayName)}</div>
    ${adPageDeleted ? `<div class="mt-0.5 inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">${isAr ? 'محذوفة' : 'Deleted'}</div>` : ''}
    ${displayCategory ? `<div class="text-xs text-slate-500">${Security.escapeHtml(displayCategory)}</div>` : ''}
  </div>`;
}

function adPagePictureUrl(ad, adPage) {
  // Our OWN archived copy wins: signed fbcdn links expire (and stop working
  // entirely once the Meta link is gone), the stored data URL does not.
  const stored = String(adPage?.metaPagePictureData || ad?.metaPagePictureData || '').trim();
  if (stored.indexOf('data:image/') === 0) return stored;
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
  // When the main tile already shows the page picture standing in for the ad
  // photo (page_avatar substitute, no uploaded photos visible), a second copy
  // of the same image beside it would be pure noise.
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
    // A linked ad whose real photo has not been resolved yet: show an honest
    // "photo loading" tile instead of nothing (and never the page logo).
    // Admins see the technical trace (which Meta doors were closed) in the
    // tooltip so a stuck photo can be diagnosed from a screenshot.
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
    source = `${getServerBaseUrl()}/api/collections/ads/${encodeURIComponent(String(ad.id || ''))}/primary-photo?index=${primaryIndex}&v=${version}`;
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
  // Meta photo URLs are signed and expire. When one dies before the next
  // sync refreshes it, degrade to the same "photo loading" tile instead of
  // hiding the tile (which silently removed the photo column for that ad).
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
  requestSeq: 0
};
const META_INSIGHTS_CLIENT_CACHE_MS = 5 * 60 * 1000;

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

function openMetaInsightsModal() {
  const isAr = metaAdsIsArabic();
  if (!isCurrentUserAdmin() || !isServerModeEnabled()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access denied', isAr ? 'مؤشرات Meta متاحة للمدير فقط.' : 'Meta insights are available to administrators only.', 'error');
    return;
  }
  metaInsightsUi.open = true;
  metaInsightsUi.error = '';
  metaInsightsRenderModal();
  // The server already caches the statistics; do not spend a request (or the
  // rate budget) when this browser fetched them moments ago.
  if (metaInsightsUi.stats && Date.now() - metaInsightsUi.loadedAtMs < META_INSIGHTS_CLIENT_CACHE_MS) return;
  metaInsightsLoad(false);
}

async function metaInsightsLoad(refresh) {
  // Single flight: one request at a time, and a response that was overtaken
  // by a newer request (e.g. Refresh clicked during a slow load) is dropped.
  if (metaInsightsUi.loading || metaInsightsUi.refreshing) return;
  const seq = ++metaInsightsUi.requestSeq;
  if (refresh || metaInsightsUi.stats) metaInsightsUi.refreshing = true;
  else metaInsightsUi.loading = true;
  metaInsightsUi.error = '';
  metaInsightsRenderModal();
  try {
    const stats = await apiMetaPartnerPages(refresh === true);
    if (seq !== metaInsightsUi.requestSeq) return;
    metaInsightsUi.stats = stats;
    metaInsightsUi.loadedAtMs = Date.now();
  } catch (error) {
    if (seq === metaInsightsUi.requestSeq) metaInsightsUi.error = metaAdsErrorMessage(error);
  } finally {
    if (seq === metaInsightsUi.requestSeq) {
      metaInsightsUi.loading = false;
      metaInsightsUi.refreshing = false;
      metaInsightsRenderModal();
    }
  }
}

function metaInsightsPageRow(page, isAr, currency) {
  const spendText = metaAdsFormatMoney(Number(page.spendMinor) || 0, currency || 'USD');
  return `<div class="flex items-center justify-between gap-3 rounded-xl border p-2.5 ${page.qualified ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20' : 'border-slate-200 dark:border-slate-700'}">
    <div class="min-w-0">
      <div class="break-words text-sm font-bold text-slate-800 dark:text-white">${Security.escapeHtml(String(page.pageName || ''))}</div>
      <div class="break-all font-mono text-[10px] text-slate-500">#${Security.escapeHtml(String(page.pageId || ''))}</div>
    </div>
    <div class="shrink-0 text-end">
      <div class="text-sm font-black ${page.qualified ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300'}">${Security.escapeHtml(spendText)}</div>
      ${page.qualified
        ? `<div class="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white"><i data-lucide="check" class="h-3 w-3"></i>${isAr ? 'مؤهلة' : 'Qualified'}</div>`
        : `<div class="text-[10px] font-medium text-slate-400">${isAr ? 'أقل من 100$' : 'Under $100'}</div>`}
    </div>
  </div>`;
}

function metaInsightsRenderModal() {
  // Never re-create the dialog after the user closed it: an in-flight load
  // finishing later must not resurrect a dismissed overlay.
  if (!metaInsightsUi.open) return;
  const isAr = metaAdsIsArabic();
  let modal = document.getElementById('meta-insights-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'meta-insights-modal';
    modal.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-start justify-center overflow-hidden bg-slate-900/60 p-2 backdrop-blur-sm sm:items-center sm:p-4';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.onclick = event => { if (event.target === modal) closeMetaInsightsModal(); };
    document.body.appendChild(modal);
  }
  const summary = metaAdsActiveRemainingSummary();
  const stats = metaInsightsUi.stats;
  const pages = Array.isArray(stats?.pages) ? stats.pages : [];
  const qualifiedPages = pages.filter(page => page && page.qualified);
  const otherPages = pages.filter(page => page && !page.qualified);
  const targetCount = Number(stats?.targetCount) || 500;
  const qualifiedCount = Number(stats?.qualifiedCount) || qualifiedPages.length;
  const progressPercent = Math.max(0, Math.min(100, (qualifiedCount / targetCount) * 100));
  const computedText = stats?.computedAt ? metaAdsFormatDate(stats.computedAt, true) : '';
  const shownOthers = otherPages.slice(0, 15);
  const accountErrors = Array.isArray(stats?.accountErrors) ? stats.accountErrors : [];

  modal.innerHTML = `<div class="glass-panel w-full max-w-2xl overflow-y-auto rounded-2xl p-4 shadow-2xl custom-scrollbar sm:p-6" style="max-height:85dvh" dir="${isAr ? 'rtl' : 'ltr'}" onclick="event.stopPropagation()">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-xl font-black text-slate-800 dark:text-white"><i data-lucide="gauge" class="h-6 w-6 text-emerald-600"></i>${isAr ? 'مؤشرات Meta' : 'Meta Insights'}</h2>
        <p class="mt-1 text-sm text-slate-500">${isAr ? 'قراءة فقط — من حسابات الإعلانات المرتبطة.' : 'Read-only — from the connected ad accounts.'}</p>
      </div>
      <button type="button" onclick="closeMetaInsightsModal()" class="touch-target rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>

    <div data-role="meta-active-remaining" class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800 dark:bg-emerald-950/20">
      <div class="flex items-center gap-2 font-black text-emerald-800 dark:text-emerald-200"><i data-lucide="wallet" class="h-4 w-4"></i>${isAr ? 'الميزانية المتبقية — كل الإعلانات النشطة معاً' : 'Total remaining budget — all active ads combined'}</div>
      <div class="mt-2 text-3xl font-black text-emerald-700 dark:text-emerald-300">${Security.escapeHtml(metaAdsFormatMoney(summary.totalMinor, summary.currency))}</div>
      <div class="mt-1 text-xs text-slate-500">${isAr ? `${summary.count} إعلان نشط على Meta الآن (المستوردة تلقائياً + المربوطة يدوياً)` : `${summary.count} ad(s) currently ACTIVE on Meta (auto-imported + manually linked)`}${summary.openEnded ? ` · ${isAr ? `${summary.openEnded} إعلان مفتوح بدون ميزانية إجمالية (غير محسوب)` : `${summary.openEnded} open-ended ad(s) without a total budget (not counted)`}` : ''}</div>
      ${summary.byAccount.length ? `<div class="mt-3 space-y-1.5">${summary.byAccount.map(account => `<div class="flex items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-1.5 text-xs dark:bg-slate-900/40"><span class="min-w-0 break-words font-bold text-slate-700 dark:text-slate-200">${Security.escapeHtml(account.name)} <span class="font-normal text-slate-400">(${account.count})</span></span><span class="shrink-0 font-black text-emerald-700 dark:text-emerald-300">${Security.escapeHtml(metaAdsFormatMoney(account.totalMinor, summary.currency))}</span></div>`).join('')}</div>` : ''}
    </div>

    <div data-role="meta-active-pages" class="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-800 dark:bg-indigo-950/20">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 font-black text-indigo-800 dark:text-indigo-200"><i data-lucide="files" class="h-4 w-4"></i>${isAr ? 'الصفحات النشطة (معيار شريك Meta)' : 'Active pages (Meta partner metric)'}</div>
        <button type="button" onclick="metaInsightsLoad(true)" ${metaInsightsUi.refreshing || metaInsightsUi.loading ? 'disabled' : ''} class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-indigo-200 px-2.5 text-xs font-bold text-indigo-700 disabled:opacity-60 dark:border-indigo-700 dark:text-indigo-200"><i data-lucide="${metaInsightsUi.refreshing ? 'loader-circle' : 'refresh-cw'}" class="h-3.5 w-3.5 ${metaInsightsUi.refreshing ? 'animate-spin' : ''}"></i>${isAr ? 'تحديث' : 'Refresh'}</button>
      </div>
      <p class="mt-1 text-xs text-slate-500">${isAr ? 'عدد الصفحات المرتبطة بحسابات الإعلانات التي تجاوز إنفاقها 100$ خلال آخر 90 يوماً.' : 'Pages connected to the ad accounts with over $100 in spend over the last 90 days.'}</p>
      ${metaInsightsUi.error ? `<div role="alert" class="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-200">${Security.escapeHtml(metaInsightsUi.error)}</div>` : ''}
      ${metaInsightsUi.loading ? `<div class="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white/60 p-6 text-slate-500 dark:bg-slate-900/40"><i data-lucide="loader-circle" class="h-5 w-5 animate-spin"></i>${isAr ? 'حساب الصفحات النشطة...' : 'Calculating active pages...'}</div>` : ''}
      ${!metaInsightsUi.loading && stats ? `
        <div class="mt-3 flex items-end gap-2"><span class="text-3xl font-black text-indigo-700 dark:text-indigo-300">${qualifiedCount}</span><span class="pb-1 text-sm font-bold text-slate-500">/ ${targetCount} ${isAr ? 'هدف الشارة' : 'badge target'}</span></div>
        <div class="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div class="h-full rounded-full bg-indigo-600" style="width:${progressPercent.toFixed(1)}%"></div></div>
        ${computedText ? `<div class="mt-1 text-[10px] text-slate-400">${isAr ? 'آخر حساب' : 'Last calculated'}: ${Security.escapeHtml(computedText)}</div>` : ''}
        ${accountErrors.length ? `<div class="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">${Security.escapeHtml(accountErrors[0])}</div>` : ''}
        ${Array.isArray(stats.notes) && stats.notes.length ? `<div class="mt-2 text-xs text-slate-500">${Security.escapeHtml(stats.notes[0])}</div>` : ''}
        ${Number(stats.unmatchedAdCount) ? `<div class="mt-2 text-xs text-slate-500">${isAr ? `لا يزال ${Number(stats.unmatchedAdCount)} إعلان قديم قيد التحليل — الرقم يقترب من رقم Meta مع كل تحديث.` : `${Number(stats.unmatchedAdCount)} older ad(s) still being analyzed — the number converges to Meta's with each refresh.`}</div>` : ''}
        <div class="mt-3 space-y-2">
          ${qualifiedPages.length ? `<div class="text-xs font-black text-emerald-700 dark:text-emerald-300">${isAr ? `الصفحات المؤهلة (${qualifiedPages.length})` : `Qualified pages (${qualifiedPages.length})`}</div>` : `<div class="rounded-xl bg-white/60 p-4 text-center text-sm text-slate-500 dark:bg-slate-900/40">${isAr ? 'لا توجد صفحات مؤهلة بعد.' : 'No qualified pages yet.'}</div>`}
          ${qualifiedPages.map(page => metaInsightsPageRow(page, isAr, stats.currency)).join('')}
          ${shownOthers.length ? `<div class="pt-1 text-xs font-black text-slate-500">${isAr ? 'الأقرب إلى التأهل' : 'Closest to qualifying'}</div>` : ''}
          ${shownOthers.map(page => metaInsightsPageRow(page, isAr, stats.currency)).join('')}
          ${otherPages.length > shownOthers.length ? `<div class="text-center text-[10px] text-slate-400">${isAr ? `و${otherPages.length - shownOthers.length} صفحة أخرى أقل إنفاقاً` : `and ${otherPages.length - shownOthers.length} more lower-spend page(s)`}</div>` : ''}
        </div>
      ` : ''}
    </div>
  </div>`;
  IconQueue.schedule(modal);
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

function metaAdsErrorMessage(error) {
  const raw = String(error?.message || error?.detail || '').trim();
  return raw || (metaAdsIsArabic() ? 'تعذّر الاتصال بـ Meta. حاول مرة أخرى.' : 'Could not connect to Meta. Please try again.');
}

function metaAdsOperationId(action, adId, value = '') {
  const key = `${action}:${adId}:${value}`;
  if (!metaAdsUi.pendingOperations.has(key)) {
    metaAdsUi.pendingOperations.set(key, Security.generateSecureId(`meta_${action}`));
  }
  return { key, value: metaAdsUi.pendingOperations.get(key) };
}

function metaAdsFinishOperation(key) {
  metaAdsUi.pendingOperations.delete(key);
}

function closeMetaAdsConnectionModal() {
  document.getElementById('meta-ads-modal')?.remove();
  if (metaAdsViewportResizeHandler) {
    window.removeEventListener('resize', metaAdsViewportResizeHandler);
    window.visualViewport?.removeEventListener('resize', metaAdsViewportResizeHandler);
    metaAdsViewportResizeHandler = null;
  }
  metaAdsUi.busyAction = '';
}

function metaAdsInteractiveHeight() {
  const values = [Number(window.innerHeight), Number(window.visualViewport?.height)].filter(value => Number.isFinite(value) && value > 0);
  return Math.max(240, Math.floor(values.length ? Math.min(...values) : 640));
}

function metaAdsFitModalToViewport() {
  const panel = document.querySelector('#meta-ads-modal > div');
  // Reserve room for mobile browser chrome that can appear without firing a
  // reliable resize event (observed in iOS Safari when its bottom bar settles).
  if (panel) {
    // The shared phone-dialog stylesheet normally lets the entire overlay
    // scroll. This connection manager keeps its close button in view and uses
    // its own scroll area, so these two scoped rules intentionally win.
    panel.style.setProperty('max-height', `${metaAdsInteractiveHeight() - 48}px`, 'important');
    panel.style.setProperty('overflow-y', 'auto', 'important');
  }
}

function openMetaAdsConnectionModal(adId = '') {
  const isAr = metaAdsIsArabic();
  if (!isCurrentUserAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access denied', isAr ? 'ربط Meta متاح للمدير فقط.' : 'Only an administrator can link Meta ads.', 'error');
    return;
  }
  if (!isServerModeEnabled()) {
    showNotification(isAr ? 'يتطلب السيرفر' : 'Server required', isAr ? 'مزامنة Meta تعمل فقط مع السيرفر المباشر.' : 'Meta synchronization only works with the live server.', 'warning');
    return;
  }
  const target = adId ? metaAdsFindLocalAd(adId) : null;
  if (adId && !target) {
    showNotification(isAr ? 'غير موجود' : 'Not found', isAr ? 'لم يتم العثور على الإعلان.' : 'The Albayan ad was not found.', 'error');
    return;
  }
  metaAdsUi.targetAdId = target ? String(target.id) : '';
  metaAdsUi.status = null;
  metaAdsUi.accounts = [];
  metaAdsUi.ads = [];
  metaAdsUi.selectedAccountId = target?.metaAdAccountId || '';
  metaAdsUi.search = '';
  metaAdsUi.error = '';
  metaAdsUi.loading = true;
  metaAdsUi.loadingAds = false;
  metaAdsUi.busyAction = '';
  metaAdsRenderModal();
  metaAdsLoadConnection();
}

function metaAdsRenderModal() {
  const isAr = metaAdsIsArabic();
  const target = metaAdsFindLocalAd(metaAdsUi.targetAdId);
  let modal = document.getElementById('meta-ads-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'meta-ads-modal';
    modal.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-start justify-center overflow-hidden bg-slate-900/60 p-2 backdrop-blur-sm sm:items-center sm:p-4';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.onclick = event => { if (event.target === modal) closeMetaAdsConnectionModal(); };
    document.body.appendChild(modal);
    metaAdsViewportResizeHandler = () => metaAdsFitModalToViewport();
    window.addEventListener('resize', metaAdsViewportResizeHandler, { passive: true });
    window.visualViewport?.addEventListener('resize', metaAdsViewportResizeHandler, { passive: true });
  }
  const status = metaAdsUi.status;
  const configured = status?.configured === true;
  const importState = status?.importState && typeof status.importState === 'object' ? status.importState : {};
  const providerState = status?.providerState && typeof status.providerState === 'object' ? status.providerState : {};
  const retryAfterSeconds = Math.max(0, Number(providerState.retryAfterSeconds || status?.remoteBackoffSeconds) || 0);
  const providerPaused = providerState.paused === true || retryAfterSeconds > 0;
  const retryMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const importError = /temporarily limiting|paused safely|rate.?limit/i.test(String(importState.lastError || '')) ? '' : String(importState.lastError || '');
  const lastDiscoveryText = metaAdsFormatDate(importState.lastDiscoveryAt, true);
  // iOS Safari's CSS vh/dvh can describe the layout viewport while the address
  // bar leaves a shorter interactive viewport. A measured pixel cap keeps the
  // close button and the panel's own scrollbar inside what the user can touch.
  const interactiveHeight = metaAdsInteractiveHeight();
  const currentName = target ? (target.metaAdName || `Meta #${target.metaAdId || ''}`) : '';
  const accountsOptions = metaAdsUi.accounts.map(account => `<option value="${Security.escapeHtml(String(account.id || ''))}" ${String(account.id) === String(metaAdsUi.selectedAccountId) ? 'selected' : ''}>${Security.escapeHtml(account.name || `Ad account ${account.id}`)} (${Security.escapeHtml(account.currency || '')})</option>`).join('');
  const adsRows = metaAdsUi.ads.map(metaAd => {
    const alreadySelected = target && String(target.metaAdId || '') === String(metaAd.id || '');
    return `<button type="button" data-meta-ad-id="${Security.escapeHtml(String(metaAd.id || ''))}" onclick="metaAdsLinkSelected(this.dataset.metaAdId)" ${!target || metaAdsUi.busyAction ? 'disabled' : ''} class="w-full rounded-xl border p-3 text-start transition-colors ${alreadySelected ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50 dark:border-slate-700 dark:hover:border-blue-700 dark:hover:bg-blue-950/30'} disabled:cursor-not-allowed disabled:opacity-60">
      <div class="flex items-start justify-between gap-2"><span class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(metaAd.name || `Meta ad ${metaAd.id}`)}</span><span class="rounded-full px-2 py-0.5 text-[10px] font-bold ${metaAdsStatusTone(metaAd.effectiveStatus || metaAd.status)}">${Security.escapeHtml(metaAd.effectiveStatus || metaAd.status || 'UNKNOWN')}</span></div>
      <div class="mt-1 text-xs text-slate-500">#${Security.escapeHtml(String(metaAd.id || ''))}${metaAd.campaignName ? ` · ${Security.escapeHtml(metaAd.campaignName)}` : ''}</div>
      ${alreadySelected ? `<div class="mt-1 text-xs font-bold text-emerald-600">${isAr ? 'مرتبط حالياً' : 'Currently linked'}</div>` : ''}
    </button>`;
  }).join('');

  modal.innerHTML = `<div class="meta-ads-dialog-panel glass-panel w-full max-w-3xl overflow-y-auto rounded-2xl p-4 shadow-2xl custom-scrollbar sm:p-6" style="max-height:${interactiveHeight - 48}px" dir="${isAr ? 'rtl' : 'ltr'}" onclick="event.stopPropagation()">
    <div class="flex items-start justify-between gap-3">
      <div><h2 class="flex items-center gap-2 text-xl font-black text-slate-800 dark:text-white"><i data-lucide="facebook" class="h-6 w-6 text-blue-600"></i>${isAr ? 'مزامنة إعلانات Meta' : 'Meta Ads Sync'}</h2><p class="mt-1 text-sm text-slate-500">${isAr ? 'قراءة فقط — معلومات Albayan المالية والصور لا تتغير.' : 'Read-only — Albayan accounting and photos are never changed.'}</p></div>
      <button type="button" onclick="closeMetaAdsConnectionModal()" class="touch-target rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="h-5 w-5"></i></button>
    </div>

    ${metaAdsUi.loading ? `<div class="mt-6 flex items-center justify-center gap-2 rounded-xl bg-slate-50 p-8 text-slate-500 dark:bg-slate-800/50"><i data-lucide="loader-circle" class="h-5 w-5 animate-spin"></i>${isAr ? 'فحص الاتصال الآمن...' : 'Checking the secure connection...'}</div>` : ''}
    ${metaAdsUi.error ? `<div role="alert" class="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-200">${Security.escapeHtml(metaAdsUi.error)}</div>` : ''}

    ${!metaAdsUi.loading && status ? `<div class="mt-4 grid gap-3 sm:grid-cols-3">
      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div class="text-xs text-slate-500">${isAr ? 'الاتصال' : 'Connection'}</div><div class="mt-1 font-bold ${configured ? 'text-emerald-600' : 'text-amber-600'}">${configured ? (isAr ? 'جاهز' : 'Ready') : (isAr ? 'يحتاج إعداد' : 'Setup needed')}</div></div>
      <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div class="text-xs text-slate-500">Meta Graph API</div><div class="mt-1 font-bold">${Security.escapeHtml(status.graphApiVersion || '—')}</div></div>
      <div class="rounded-xl border ${providerPaused ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20' : 'border-slate-200 dark:border-slate-700'} p-3"><div class="text-xs text-slate-500">${isAr ? 'المزامنة التلقائية' : 'Automatic sync'}</div><div class="mt-1 font-bold ${providerPaused ? 'text-amber-700 dark:text-amber-300' : ''}">${providerPaused ? (isAr ? `متوقفة بأمان · إعادة المحاولة خلال ${retryMinutes} دقيقة` : `Paused safely · retry in ${retryMinutes} min`) : (status.backgroundSync ? `${Number(status.syncIntervalMinutes) || 15} ${isAr ? 'دقيقة' : 'minutes'}` : (isAr ? 'متوقفة' : 'Off'))}</div></div>
    </div>` : ''}

    ${!metaAdsUi.loading && configured && providerPaused ? `<div role="status" class="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"><div class="flex items-start gap-2"><i data-lucide="shield-check" class="mt-0.5 h-5 w-5 shrink-0"></i><div><div class="font-black">${isAr ? 'Albayan يحمي اتصال Meta' : 'Albayan is protecting the Meta connection'}</div><div class="mt-1">${isAr ? `وصل الاستخدام إلى ${Number(providerState.usagePercent) || 0}٪، لذلك توقفت الطلبات مؤقتاً وستستأنف تلقائياً خلال حوالي ${retryMinutes} دقيقة. لا تحتاج إلى فعل شيء.` : `Usage reached ${Number(providerState.usagePercent) || 0}%, so requests are paused temporarily and will resume automatically in about ${retryMinutes} minute(s). You do not need to do anything.`}</div></div></div></div>` : ''}

    ${!metaAdsUi.loading && configured ? `<div class="mt-3 rounded-xl border ${providerPaused ? 'border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20' : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20'} p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div class="flex items-center gap-2 font-black text-emerald-800 dark:text-emerald-200"><i data-lucide="sparkles" class="h-4 w-4"></i>${isAr ? 'الاستيراد التلقائي للإعلانات والصفحات' : 'Automatic ad and page import'}</div>
          <div class="mt-1 text-xs text-emerald-700 dark:text-emerald-300">${status.autoImport ? (isAr ? `يعمل كل ${Number(status.discoveryIntervalSeconds) || 60} ثانية` : `Runs every ${Number(status.discoveryIntervalSeconds) || 60} seconds`) : (isAr ? 'متوقف' : 'Off')} · ${isAr ? 'الحسابات' : 'Accounts'}: ${Number(importState.accountCount || status.allowedAccountCount) || 0}</div>
          <div class="mt-1 text-xs text-slate-500">${lastDiscoveryText ? `${isAr ? 'آخر فحص' : 'Last check'}: ${Security.escapeHtml(lastDiscoveryText)} · ` : ''}${isAr ? 'تم استيراد' : 'Imported'}: ${Number(importState.totalImported) || 0}${Number(importState.lastImportedCount) ? ` (${isAr ? 'آخر فحص' : 'last check'}: ${Number(importState.lastImportedCount)})` : ''}</div>
          ${importError ? `<div class="mt-1 text-xs font-medium text-rose-600 dark:text-rose-300">${Security.escapeHtml(importError)}</div>` : ''}
        </div>
        <button type="button" onclick="metaAdsCheckForNewAds()" ${metaAdsUi.busyAction || providerPaused ? 'disabled' : ''} class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"><i data-lucide="${metaAdsUi.busyAction === 'discover' ? 'loader-circle' : 'radar'}" class="h-4 w-4 ${metaAdsUi.busyAction === 'discover' ? 'animate-spin' : ''}"></i>${providerPaused ? (isAr ? 'سيستأنف تلقائياً' : 'Resumes automatically') : (isAr ? 'فحص الإعلانات الجديدة الآن' : 'Check for new ads now')}</button>
      </div>
    </div>` : ''}

    ${!metaAdsUi.loading && status && !configured ? `<div class="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100"><div class="font-black">${isAr ? 'أضف هذه المتغيرات في Jelastic ثم أعد تشغيل الحاوية:' : 'Add these environment variables in Jelastic, then restart the container:'}</div><code class="mt-2 block select-all whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-emerald-300" dir="ltr">ALBAYAN_META_ACCESS_TOKEN=your_token\nALBAYAN_META_APP_SECRET=your_app_secret\nALBAYAN_META_AD_ACCOUNT_IDS=123456789</code><p class="mt-2">${isAr ? 'لا تكتب رمز الدخول في Albayan أو في المحادثة. ضعه فقط داخل إعدادات Jelastic.' : 'Never type the access token into Albayan or chat. Put it only in Jelastic settings.'}</p></div>` : ''}

    ${target ? `<div class="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-800 dark:bg-indigo-950/20"><div class="text-xs font-bold text-indigo-600">${isAr ? 'إعلان Albayan المحدد' : 'Selected Albayan ad'}</div><div class="mt-1 font-black text-slate-800 dark:text-white">#${Security.escapeHtml(String(target.id))} · ${Security.escapeHtml(target.customerName || target.pageName || (isAr ? 'إعلان' : 'Ad'))}</div>${target.metaAdId ? `<div class="mt-2 text-sm text-slate-600 dark:text-slate-300">${isAr ? 'مرتبط بـ' : 'Linked to'}: <strong>${Security.escapeHtml(currentName)}</strong> (#${Security.escapeHtml(String(target.metaAdId))})</div><div class="mt-3 flex flex-wrap gap-2"><button type="button" onclick="metaAdsSyncCurrent()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-60"><i data-lucide="refresh-cw" class="h-4 w-4 ${metaAdsUi.busyAction === 'sync' ? 'animate-spin' : ''}"></i>${isAr ? 'مزامنة الآن' : 'Sync now'}</button><button type="button" onclick="metaAdsUnlinkCurrent()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-200 px-4 py-2 font-bold text-rose-600 disabled:opacity-60"><i data-lucide="unlink" class="h-4 w-4"></i>${isAr ? 'إلغاء الربط' : 'Unlink'}</button></div>` : `<div class="mt-2 text-sm text-slate-500">${isAr ? 'غير مرتبط حتى الآن.' : 'Not linked yet.'}</div>`}</div>` : `<div class="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">${isAr ? 'لفتح الربط: أغلق هذه النافذة واضغط زر «ربط» الصغير بجانب إعلان Albayan.' : 'To link an ad: close this window and press the small Link button beside an Albayan ad.'}</div>`}

    ${configured && target ? `<div class="mt-5 space-y-3"><h3 class="font-black text-slate-800 dark:text-white">${target.metaAdId ? (isAr ? 'تغيير إعلان Meta المرتبط' : 'Change linked Meta ad') : (isAr ? 'اختر إعلان Meta' : 'Choose a Meta ad')}</h3>
      <div class="grid gap-2 sm:grid-cols-[1fr_auto]"><select id="meta-account-select" onchange="metaAdsSelectAccount(this.value)" class="glass-input min-h-11 w-full rounded-xl px-3"><option value="">${isAr ? 'اختر حساب الإعلانات...' : 'Choose an ad account...'}</option>${accountsOptions}</select><button type="button" onclick="metaAdsReloadAccounts()" class="min-h-11 rounded-xl border border-slate-200 px-3 font-bold dark:border-slate-700"><i data-lucide="refresh-cw" class="mx-auto h-4 w-4"></i></button></div>
      ${metaAdsUi.selectedAccountId ? `<div class="grid gap-2 sm:grid-cols-[1fr_auto]"><input id="meta-ads-search" type="search" value="${Security.escapeHtml(metaAdsUi.search)}" onkeydown="if(event.key==='Enter'){event.preventDefault();metaAdsSearch(this.value)}" placeholder="${isAr ? 'ابحث بالاسم أو رقم الإعلان...' : 'Search name or ad ID...'}" class="glass-input min-h-11 w-full rounded-xl px-3"><button type="button" onclick="metaAdsSearch(document.getElementById('meta-ads-search').value)" class="min-h-11 rounded-xl bg-slate-800 px-4 font-bold text-white dark:bg-slate-600">${isAr ? 'بحث' : 'Search'}</button></div>` : ''}
      ${metaAdsUi.loadingAds ? `<div class="flex items-center justify-center gap-2 p-6 text-slate-500"><i data-lucide="loader-circle" class="h-5 w-5 animate-spin"></i>${isAr ? 'تحميل إعلانات Meta...' : 'Loading Meta ads...'}</div>` : ''}
      ${!metaAdsUi.loadingAds && metaAdsUi.selectedAccountId ? `<div class="max-h-72 space-y-2 overflow-y-auto pr-1 custom-scrollbar">${adsRows || `<div class="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500 dark:bg-slate-800/50">${isAr ? 'لم يتم العثور على إعلانات.' : 'No Meta ads found.'}</div>`}</div>` : ''}
      <div class="rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-700"><label for="meta-direct-ad-id" class="block text-xs font-bold text-slate-500">${isAr ? 'أو الصق رقم إعلان Meta مباشرة' : 'Or paste the numeric Meta ad ID'}</label><div class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]"><input id="meta-direct-ad-id" inputmode="numeric" pattern="[0-9]*" placeholder="123456789012345" class="glass-input min-h-11 w-full rounded-xl px-3" dir="ltr"><button type="button" onclick="metaAdsLinkDirect()" ${metaAdsUi.busyAction ? 'disabled' : ''} class="min-h-11 rounded-xl bg-blue-600 px-4 font-bold text-white disabled:opacity-60">${isAr ? 'ربط' : 'Link'}</button></div></div>
    </div>` : ''}

    ${configured && !metaAdsUi.loading ? `<div class="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-700"><p class="text-xs text-slate-500">${isAr ? 'يعمل الاستيراد والمزامنة في السيرفر حتى عندما تغلق هذه الصفحة.' : 'Automatic import and sync run on the server even when this page is closed.'}</p><button type="button" onclick="metaAdsSyncAllDue()" ${metaAdsUi.busyAction || providerPaused ? 'disabled' : ''} class="min-h-11 rounded-xl border border-blue-200 px-3 text-sm font-bold text-blue-700 disabled:opacity-60 dark:border-blue-800 dark:text-blue-200">${providerPaused ? (isAr ? 'إعادة المحاولة تلقائياً' : 'Automatic retry pending') : (isAr ? 'مزامنة المستحق الآن' : 'Sync due now')}</button></div>` : ''}
  </div>`;
  metaAdsFitModalToViewport();
  window.requestAnimationFrame(() => metaAdsFitModalToViewport());
  IconQueue.schedule(modal);
}

async function metaAdsLoadConnection() {
  try {
    metaAdsUi.status = await apiMetaAdsStatus();
    metaAdsUi.loading = false;
    metaAdsUi.error = '';
    metaAdsRenderModal();
    if (metaAdsUi.status?.configured) await metaAdsReloadAccounts();
  } catch (error) {
    metaAdsUi.loading = false;
    metaAdsUi.error = metaAdsErrorMessage(error);
    metaAdsRenderModal();
  }
}

async function metaAdsReloadAccounts() {
  metaAdsUi.loadingAds = true;
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    metaAdsUi.accounts = await apiMetaAdsAccounts();
    if (!metaAdsUi.selectedAccountId && metaAdsUi.accounts.length === 1) metaAdsUi.selectedAccountId = String(metaAdsUi.accounts[0].id || '');
    if (metaAdsUi.selectedAccountId && !metaAdsUi.accounts.some(a => String(a.id) === String(metaAdsUi.selectedAccountId))) metaAdsUi.selectedAccountId = '';
    metaAdsUi.loadingAds = false;
    metaAdsRenderModal();
    if (metaAdsUi.selectedAccountId) await metaAdsLoadAds();
  } catch (error) {
    metaAdsUi.loadingAds = false;
    metaAdsUi.error = metaAdsErrorMessage(error);
    metaAdsRenderModal();
  }
}

async function metaAdsSelectAccount(accountId) {
  metaAdsUi.selectedAccountId = String(accountId || '');
  metaAdsUi.search = '';
  metaAdsUi.ads = [];
  metaAdsRenderModal();
  if (metaAdsUi.selectedAccountId) await metaAdsLoadAds();
}

async function metaAdsSearch(value) {
  metaAdsUi.search = String(value || '').slice(0, 100);
  await metaAdsLoadAds();
}

async function metaAdsLoadAds() {
  if (!metaAdsUi.selectedAccountId) return;
  metaAdsUi.loadingAds = true;
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    metaAdsUi.ads = await apiMetaAdsForAccount(metaAdsUi.selectedAccountId, metaAdsUi.search);
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
    metaAdsUi.ads = [];
  } finally {
    metaAdsUi.loadingAds = false;
    metaAdsRenderModal();
  }
}

async function metaAdsRefreshAfterConflict(adId) {
  try {
    const latest = await apiGetEntity('ads', adId);
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: latest }], 'metaConflictRefresh');
  } catch (_) {}
}

async function metaAdsRunMutation(action, metaAdId = '') {
  const isAr = metaAdsIsArabic();
  const target = metaAdsFindLocalAd(metaAdsUi.targetAdId);
  if (!target || metaAdsUi.busyAction) return;
  const expected = Number(target._lastModified);
  if (!Number.isFinite(expected)) {
    showNotification(isAr ? 'حدّث الصفحة' : 'Refresh needed', isAr ? 'حدّث البيانات ثم حاول مرة أخرى.' : 'Refresh the data and try again.', 'warning');
    return;
  }
  const operation = metaAdsOperationId(action, target.id, metaAdId);
  metaAdsUi.busyAction = action;
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    let response;
    if (action === 'link') response = await apiLinkMetaAd(target.id, metaAdId, expected, operation.value);
    else if (action === 'sync') response = await apiSyncMetaAd(target.id, expected, operation.value);
    else response = await apiUnlinkMetaAd(target.id, expected, operation.value);
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: response.ad }], `meta${action}`);
    metaAdsFinishOperation(operation.key);
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
    showNotification(isAr ? 'تم بنجاح' : 'Success', action === 'unlink'
      ? (isAr ? 'تم إلغاء ربط إعلان Meta.' : 'The Meta ad was unlinked.')
      : (isAr ? 'تم تحديث معلومات Meta بدون تغيير الحسابات.' : 'Meta information updated without changing accounting.'), 'success');
  } catch (error) {
    metaAdsUi.busyAction = '';
    if (Number(error?.status) === 409 || String(error?.message || '').toLowerCase().includes('conflict')) {
      await metaAdsRefreshAfterConflict(target.id);
      metaAdsUi.error = isAr ? 'تغيّر الإعلان أثناء العمل. تم تحميل النسخة الجديدة؛ راجعها وحاول مرة أخرى.' : 'The ad changed while you were working. The latest version was loaded; review it and try again.';
    } else {
      metaAdsUi.error = metaAdsErrorMessage(error);
    }
    metaAdsRenderModal();
  }
}

function metaAdsLinkSelected(metaAdId) {
  const target = metaAdsFindLocalAd(metaAdsUi.targetAdId);
  if (!target) return;
  const isChanging = target.metaAdId && String(target.metaAdId) !== String(metaAdId);
  if (isChanging && !confirm(metaAdsIsArabic() ? 'هل تريد تغيير إعلان Meta المرتبط؟ لن تتغير الأموال أو الوصل أو الصور.' : 'Change the linked Meta ad? Money, receipts and photos will not change.')) return;
  metaAdsRunMutation('link', String(metaAdId || ''));
}

function metaAdsLinkDirect() {
  const value = String(document.getElementById('meta-direct-ad-id')?.value || '').trim();
  if (!/^[0-9]{1,40}$/.test(value)) {
    showNotification(metaAdsIsArabic() ? 'رقم غير صحيح' : 'Invalid ID', metaAdsIsArabic() ? 'الصق رقم إعلان Meta فقط.' : 'Paste the numeric Meta ad ID only.', 'warning');
    return;
  }
  metaAdsLinkSelected(value);
}

function metaAdsSyncCurrent() {
  metaAdsRunMutation('sync');
}

function metaAdsUnlinkCurrent() {
  if (!confirm(metaAdsIsArabic() ? 'إلغاء الربط؟ ستبقى كل أموال ووصل وصور Albayan كما هي.' : 'Unlink Meta? All Albayan money, receipts and photos will remain unchanged.')) return;
  metaAdsRunMutation('unlink');
}

async function metaAdsCheckForNewAds() {
  if (metaAdsUi.busyAction) return;
  const isAr = metaAdsIsArabic();
  metaAdsUi.busyAction = 'discover';
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    const result = await apiRunMetaAutoImport();
    if (result.imported.length) {
      applyValidatedServerEntityBatch(result.imported.map(entity => ({ collection: 'ads', entity })), 'metaAutoImport');
    }
    if (metaAdsUi.status) metaAdsUi.status.importState = result.state;
    const count = result.imported.length;
    showNotification(
      isAr ? 'اكتمل فحص Meta' : 'Meta check complete',
      count
        ? (isAr ? `تم إنشاء ${count} إعلان جديد كمسودة آمنة تحتاج إكمال.` : `${count} new ad(s) were created as safe drafts that need completion.`)
        : (isAr ? 'لا توجد إعلانات جديدة الآن.' : 'There are no new ads right now.'),
      'success'
    );
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
  } finally {
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
  }
}

async function metaAdsSyncAllDue() {
  if (metaAdsUi.busyAction) return;
  const isAr = metaAdsIsArabic();
  metaAdsUi.busyAction = 'all';
  metaAdsUi.error = '';
  metaAdsRenderModal();
  try {
    const result = await apiSyncDueMetaAds(4);
    const entities = [...result.ads, ...result.imported];
    if (entities.length) applyValidatedServerEntityBatch(entities.map(entity => ({ collection: 'ads', entity })), 'metaSyncDue');
    if (metaAdsUi.status) metaAdsUi.status.importState = result.importState;
    showNotification(isAr ? 'اكتملت المزامنة' : 'Sync complete', isAr ? `تم تحديث ${result.ads.length} واستيراد ${result.imported.length} إعلان.` : `Updated ${result.ads.length} and imported ${result.imported.length} ad(s).`, 'success');
  } catch (error) {
    metaAdsUi.error = metaAdsErrorMessage(error);
  } finally {
    metaAdsUi.busyAction = '';
    metaAdsRenderModal();
  }
}
