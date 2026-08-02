// ==========================================
// MERGE TOOLS — one real page, one real ad
// ==========================================
// The Meta import leaves two kinds of doubles behind, and both were previously
// dead ends: showPageDuplicates could only LIST repeated pages, and an imported
// draft that described an ad the staff had already recorded by hand could only
// be completed a second time or thrown away.
//
//  1. PAGE: the row someone typed by hand before the import existed, beside the
//     row the Meta sync created. Only the Meta row carries metaPageId, which is
//     the identity the server writes to, so the hand-made row is always the one
//     that gives up its ads and goes. The opposite direction would strand every
//     future imported ad on a fresh page row and re-create the duplicate
//     immediately (server/meta_ads.py only re-points an imported ad at its own
//     Meta-derived page, and _ensure_import_page only looks at live pages).
//
//  2. AD: the ad the staff recorded with the customer's money, beside the empty
//     draft the importer created for the same Meta ad. Combining them is really
//     a RE-LINK: the Meta identity moves onto the record that holds the money,
//     and the empty draft is removed.
//
// Neither flow moves money. Both are built only out of writes the server
// already accepts on their own: ad.pageId is an ordinary relationship field,
// and the Meta link travels through the existing transactional
// /api/meta-ads/ads/{id}/unlink + /link endpoints, which are the only writers
// allowed to move a metaAdId. Nothing here PATCHes a server-controlled meta*
// field, so no new backend surface is required.
//
// Both flows are also re-runnable on purpose. They do the harmless work first
// and remove the losing record LAST, so a connection that drops halfway leaves
// a visibly unfinished merge that finishes correctly when repeated — never a
// half-deleted one.

// Guards the two dialogs against a double submit (and against a second merge
// starting while the first is still writing).
let _mergeToolsBusy = '';
let _pageMergeReturnFocus = null;
let _adMergeReturnFocus = null;

function isMergeToolsAdmin() {
  return typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
}

function getPageMetaIdValue(page) {
  return String(page?.metaPageId || '').trim();
}

// ------------------------------------------------------------------
// 1. Merge a hand-made page into the Meta page with the same name
// ------------------------------------------------------------------

// Same grouping key the duplicate finder and the category picker already use
// (Arabic hamza/ة/ى folding, tashkeel stripped, digits folded, spaces
// collapsed), so "حج وعمرة" and "حج وعمره" land in one group here too.
function findPageMergeGroups(pages = getPagesVisibleToCurrentUser()) {
  const active = getVisibleRecords(Array.isArray(pages) ? pages : [])
    .filter(page => page && !page._deleted && page.id);
  const groups = new Map();
  for (const page of active) {
    const key = pageCategoryKey(page.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  const mergeable = [];
  for (const group of groups.values()) {
    const metaPages = group.filter(page => getPageMetaIdValue(page));
    const manualPages = group.filter(page => !getPageMetaIdValue(page));
    // Exactly one Meta row is the only unambiguous case. Two Meta rows for one
    // name is a different problem (two real Facebook pages, or a server-side
    // import bug) and must not be guessed at here.
    if (metaPages.length !== 1 || manualPages.length === 0) continue;
    mergeable.push({ keepPage: metaPages[0], manualPages });
  }
  return mergeable.sort((a, b) => String(a.keepPage?.name || '').localeCompare(String(b.keepPage?.name || '')));
}

function countPageMergeGroups() {
  return isMergeToolsAdmin() ? findPageMergeGroups().length : 0;
}

// Everything the dialog needs, plus the single reason a merge is refused.
// Recomputed immediately before the write so a dialog left open on a stale
// screen cannot merge something that changed underneath it.
function getPageMergePlan(keepPageId, losePageId) {
  const isAr = state.language === 'ar';
  const pages = getVisibleRecords(state.pages);
  const keepPage = pages.find(page => String(page.id) === String(keepPageId || '')) || null;
  const losePage = pages.find(page => String(page.id) === String(losePageId || '')) || null;
  const plan = { keepPage, losePage, ads: [], blocked: '' };
  if (!keepPage || !losePage) {
    plan.blocked = isAr ? 'إحدى الصفحتين لم تعد موجودة. حدّث الصفحة وحاول مرة أخرى.' : 'One of the two pages no longer exists. Refresh and try again.';
    return plan;
  }
  if (String(keepPage.id) === String(losePage.id)) {
    plan.blocked = isAr ? 'اختر صفحتين مختلفتين.' : 'Choose two different pages.';
    return plan;
  }
  if (!getPageMetaIdValue(keepPage)) {
    plan.blocked = isAr ? 'الصفحة الباقية يجب أن تكون صفحة Meta.' : 'The surviving page must be the Meta page.';
    return plan;
  }
  if (getPageMetaIdValue(losePage)) {
    plan.blocked = isAr ? 'لا يمكن دمج صفحة Meta في صفحة أخرى. تُدمج الصفحة اليدوية فقط.' : 'A Meta page cannot be merged away. Only the hand-made page is merged.';
    return plan;
  }
  if (pageCategoryKey(keepPage.name) !== pageCategoryKey(losePage.name)) {
    plan.blocked = isAr ? 'الصفحتان ليس لهما نفس الاسم.' : 'The two pages do not share the same name.';
    return plan;
  }
  plan.ads = getAdsForPage(losePage.id);
  return plan;
}

function closePageMergeDialog(restoreFocus = true) {
  document.getElementById('page-merge-dialog')?.remove();
  const target = _pageMergeReturnFocus?.isConnected === false ? null : _pageMergeReturnFocus;
  _pageMergeReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

function showPageMergeDialog(keepPageId, losePageId, triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الصفحات متاح للمدير فقط.' : 'Only an administrator can merge pages.', 'error');
    return;
  }
  const plan = getPageMergePlan(keepPageId, losePageId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }
  closePageMergeDialog(false);
  _pageMergeReturnFocus = triggerButton || document.activeElement;

  const adCount = plan.ads.length;
  const keepAdCount = getAdsForPage(plan.keepPage.id).length;
  const customersById = new Map((state.customers || []).map(customer => [String(customer.id), customer]));
  const describeOwners = page => getPageCustomerIds(page)
    .map(id => customersById.get(String(id))?.name || '')
    .filter(Boolean).join(', ');
  const loseOwners = describeOwners(plan.losePage);
  const keepOwners = describeOwners(plan.keepPage);
  const movedOwners = getPageCustomerIds(plan.losePage)
    .map(String)
    .filter(id => !getPageCustomerIds(plan.keepPage).map(String).includes(id));

  const dialog = document.createElement('div');
  dialog.id = 'page-merge-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'page-merge-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-2xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="flex items-start gap-3 min-w-0">
          <span class="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
            <i data-lucide="combine" class="w-6 h-6"></i>
          </span>
          <div class="min-w-0">
            <h2 id="page-merge-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${isAr ? 'دمج الصفحة القديمة في صفحة Meta' : 'Merge the old page into the Meta page'}</h2>
            <p class="text-sm text-slate-500 break-words">${isAr ? 'تنتقل كل الإعلانات إلى صفحة Meta، ولا يتغير أي مبلغ.' : 'Every ad moves to the Meta page. No money changes.'}</p>
          </div>
        </div>
        <button type="button" onclick="closePageMergeDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
        <div class="grid gap-3 md:grid-cols-2">
          <section class="rounded-xl border-2 border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300">${isAr ? 'ستُزال' : 'Will be removed'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(plan.losePage.name || '')}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300 break-words">
              ${Security.escapeHtml(plan.losePage.category || (isAr ? 'بدون فئة' : 'No category'))}
              ${loseOwners ? ` • ${Security.escapeHtml(loseOwners)}` : ` • ${isAr ? 'بدون مالك' : 'No owner'}`}
            </div>
            <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-slate-900/50 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">
              ${isAr ? `${adCount} إعلان سينتقل` : `${adCount} ad${adCount === 1 ? '' : 's'} will move`}
            </div>
          </section>
          <section class="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">${isAr ? 'ستبقى' : 'Will be kept'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(plan.keepPage.name || '')}</div>
            <div class="mt-1 font-mono text-[11px] text-slate-500 break-all">#${Security.escapeHtml(getPageMetaIdValue(plan.keepPage))}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300 break-words">
              ${Security.escapeHtml(plan.keepPage.category || (isAr ? 'بدون فئة' : 'No category'))}
              ${keepOwners ? ` • ${Security.escapeHtml(keepOwners)}` : ` • ${isAr ? 'بدون مالك' : 'No owner'}`}
            </div>
            <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-slate-900/50 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">
              ${isAr ? `${keepAdCount} إعلان الآن` : `${keepAdCount} ad${keepAdCount === 1 ? '' : 's'} today`}
            </div>
          </section>
        </div>

        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <div class="font-bold text-slate-800 dark:text-white">${isAr ? 'ماذا سيحدث' : 'What will happen'}</div>
          <div>• ${isAr ? `تنتقل ${adCount} إعلان إلى صفحة Meta.` : `${adCount} ad${adCount === 1 ? '' : 's'} move to the Meta page.`}</div>
          ${movedOwners.length ? `<div>• ${isAr ? 'يُضاف مالك الصفحة القديمة إلى صفحة Meta.' : 'The old page owner is added to the Meta page.'}</div>` : ''}
          <div>• ${isAr ? 'تُحذف الصفحة القديمة بعد انتقال كل إعلان.' : 'The old page is removed after every ad has moved.'}</div>
          <div>• ${isAr ? 'لا يتغير أي مبلغ أو وصل أو صورة.' : 'No amount, receipt or photo changes.'}</div>
        </div>
      </div>
      <div class="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 p-4 flex flex-col sm:flex-row gap-2">
        <button type="button" id="page-merge-confirm" onclick="runPageMerge('${Security.escapeHtml(String(plan.keepPage.id))}','${Security.escapeHtml(String(plan.losePage.id))}')" class="flex-1 btn-shine bg-amber-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-amber-700 min-h-11">
          <i data-lucide="combine" class="w-4 h-4 inline mr-2"></i>${isAr ? 'دمج الآن' : 'Merge now'}
        </button>
        <button type="button" onclick="closePageMergeDialog()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closePageMergeDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

async function runPageMerge(keepPageId, losePageId) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الصفحات متاح للمدير فقط.' : 'Only an administrator can merge pages.', 'error');
    return;
  }
  if (_mergeToolsBusy) return;
  // Re-checked against live state, not against what the dialog was drawn from.
  const plan = getPageMergePlan(keepPageId, losePageId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }

  _mergeToolsBusy = 'page';
  const confirmButton = document.getElementById('page-merge-confirm');
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = isAr ? 'جارٍ الدمج…' : 'Merging…';
  }

  let moved = 0;
  try {
    // Ads first. The old page is only removed once every one of them has landed
    // on the Meta page, so an interrupted merge is always safe to repeat.
    for (const ad of plan.ads) {
      const updates = { pageId: String(plan.keepPage.id) };
      // Only refresh the denormalised copy when the ad actually carries one —
      // writing it onto rows that never had it would invent a new field.
      if (String(ad.pageName || '').trim()) updates.pageName = String(plan.keepPage.name || '');
      const expected = Number(ad._lastModified);
      const saved = await updateRecord(state.ads, ad.id, updates, Number.isFinite(expected) ? expected : undefined);
      if (!saved) {
        showNotification(
          isAr ? 'توقف الدمج' : 'Merge stopped',
          isAr
            ? `تم نقل ${moved} من ${plan.ads.length} إعلان. لم تُحذف الصفحة القديمة، أعد المحاولة لإكمال الباقي.`
            : `${moved} of ${plan.ads.length} ads moved. The old page was kept — run the merge again to finish the rest.`,
          'warning'
        );
        return;
      }
      moved += 1;
    }

    // Carry the hand-made page's owner across. An imported page arrives with no
    // owner at all, so this is usually the only place that knowledge exists.
    const keepOwnerIds = getPageCustomerIds(plan.keepPage).map(String);
    const addedOwnerIds = getPageCustomerIds(plan.losePage).map(String).filter(id => !keepOwnerIds.includes(id));
    if (addedOwnerIds.length) {
      const keepExpected = Number(plan.keepPage._lastModified);
      await updateRecord(
        state.pages,
        plan.keepPage.id,
        { customerIds: [...keepOwnerIds, ...addedOwnerIds] },
        Number.isFinite(keepExpected) ? keepExpected : undefined
      );
    }

    const removed = await deleteRecord(state.pages, plan.losePage.id);
    if (!removed) {
      showNotification(
        isAr ? 'انتقلت الإعلانات' : 'Ads moved',
        isAr ? 'انتقلت كل الإعلانات، لكن تعذّر حذف الصفحة القديمة. احذفها يدوياً.' : 'Every ad moved, but the old page could not be removed. Delete it by hand.',
        'warning'
      );
      return;
    }

    showNotification(
      isAr ? 'تم الدمج' : 'Merged',
      isAr
        ? `تم نقل ${moved} إعلان إلى «${plan.keepPage.name}» وحُذفت الصفحة القديمة.`
        : `${moved} ad${moved === 1 ? '' : 's'} moved to "${plan.keepPage.name}" and the old page was removed.`,
      'success'
    );
  } catch (error) {
    showNotification(
      isAr ? 'تعذّر الدمج' : 'Merge failed',
      error?.message || (isAr ? 'حدث خطأ أثناء الدمج. أعد المحاولة.' : 'Something went wrong during the merge. Try again.'),
      'error'
    );
  } finally {
    _mergeToolsBusy = '';
    closePageMergeDialog(false);
    closePageDuplicatesDialog(false);
    render();
  }
}

// ------------------------------------------------------------------
// 2. Link a hand-made ad to the Meta draft that describes the same ad
// ------------------------------------------------------------------

// A row is "imported" when the automation made it, whatever its current link
// state. Used to tell the two sides of a pair apart.
function isImportedMetaAd(ad) {
  return !!ad && (
    !!String(ad.metaImportState || '').trim()
    || !!String(ad.metaImportedAt || '').trim()
    || !!String(ad.metaImportSource || '').trim()
  );
}

// Every way this ad names a page, so the two sides can be recognised as the
// same page even while the manual ad still points at the old page record and
// the draft already points at the Meta one.
function _adPageMergeKeys(ad, pagesById) {
  const keys = new Set();
  const pageId = String(ad?.pageId || '').trim();
  const page = !pageId
    ? null
    : (pagesById
      ? (pagesById.get(pageId) || null)
      : ((state.pages || []).find(item => item && !item._deleted && String(item.id) === pageId) || null));
  if (pageId) keys.add(`id:${pageId}`);
  const metaPageId = String(ad?.metaPageId || page?.metaPageId || '').trim();
  if (metaPageId) keys.add(`meta:${metaPageId}`);
  const rawName = String(page?.name || ad?.pageName || ad?.metaPageName || '').trim();
  // "Facebook Page 1234…" is the importer's stand-in, not a name. Matching on it
  // would pair two unrelated ads that are both waiting for their real name.
  if (rawName && !metaAdsIsPlaceholderPageName(rawName, metaPageId || pageId)) {
    const nameKey = pageCategoryKey(rawName);
    if (nameKey) keys.add(`name:${nameKey}`);
  }
  return keys;
}

function adsShareAPage(left, right) {
  const leftKeys = _adPageMergeKeys(left);
  if (!leftKeys.size) return false;
  for (const key of _adPageMergeKeys(right)) {
    if (leftKeys.has(key)) return true;
  }
  return false;
}

// The draft must be genuinely empty. Money on both sides is a decision a person
// has to make one receipt at a time, so it is refused rather than guessed.
function metaDraftCarriesMoney(ad) {
  if (!ad) return false;
  if ((Number(ad.amountUSD) || 0) > 0) return true;
  if (getAdLinkedReceiptIds(ad).length > 0) return true;
  if (Array.isArray(ad.topUps) && ad.topUps.length > 0) return true;
  return !!String(ad.customerId || '').trim();
}

// The ads table asks about every row, so the WHOLE pairing is resolved in one
// pass and cached for the render — never once per row. Comparing each ad with
// every other ad (and re-finding its page each time) is O(ads² × pages) and was
// measurably the wrong shape for a list this long. Cleared at the top of
// renderAdsView and after a merge, so it can never describe stale data.
let _adMergePairCache = null;

function resetAdMergePairCache() {
  _adMergePairCache = null;
}

function _buildAdMergePairIndex() {
  const pairs = new Map();
  if (!isMergeToolsAdmin() || !isServerModeEnabled()) return pairs;

  const pagesById = new Map(
    (state.pages || [])
      .filter(page => page && !page._deleted && page.id)
      .map(page => [String(page.id), page])
  );
  const manualAds = [];
  const draftAds = [];
  const keysByAdId = new Map();
  for (const ad of getVisibleRecords(state.ads)) {
    if (!ad || ad.recordType === 'receipt' || !ad.id) continue;
    const linked = !!String(ad.metaAdId || '').trim();
    const imported = isImportedMetaAd(ad);
    if (imported && linked) {
      // A draft that already grew a customer, an amount or a receipt is a real
      // ad in its own right and must never be absorbed.
      if (metaDraftCarriesMoney(ad)) continue;
      draftAds.push(ad);
    } else if (!imported && !linked) {
      manualAds.push(ad);
    } else {
      // Already linked by hand, or imported and since unlinked: neither half.
      continue;
    }
    keysByAdId.set(String(ad.id), _adPageMergeKeys(ad, pagesById));
  }
  if (!manualAds.length || !draftAds.length) return pairs;

  const draftsByKey = new Map();
  for (const draft of draftAds) {
    for (const key of keysByAdId.get(String(draft.id))) {
      if (!draftsByKey.has(key)) draftsByKey.set(key, []);
      draftsByKey.get(key).push(draft);
    }
  }

  // Several hand-made ads of the same price on one page, beside several drafts,
  // is the NORMAL shape of this problem — refusing everything that is not a
  // clean one-to-one would hide the feature exactly where it is needed. So every
  // ad keeps its full candidate list and the owner picks; only the pick itself
  // is ever written, and getAdMergePlan re-checks it.
  for (const manual of manualAds) {
    const found = new Map();
    for (const key of keysByAdId.get(String(manual.id))) {
      for (const draft of draftsByKey.get(key) || []) found.set(String(draft.id), draft);
    }
    if (!found.size) continue;
    const partners = [...found.values()];
    pairs.set(String(manual.id), { role: 'manual', ad: manual, partners });
    for (const draft of partners) {
      const entry = pairs.get(String(draft.id)) || { role: 'draft', ad: draft, partners: [] };
      entry.partners.push(manual);
      pairs.set(String(draft.id), entry);
    }
  }
  return pairs;
}

function getAdMergePartnersFor(adId) {
  const wanted = String(adId || '');
  if (!wanted) return null;
  if (!_adMergePairCache) _adMergePairCache = _buildAdMergePairIndex();
  const entry = _adMergePairCache.get(wanted) || null;
  return entry && entry.partners.length ? entry : null;
}

// One button in the ads-table Actions column, on BOTH halves of a possible pair.
// "Link" is already taken there by the ad -> Meta connection manager, so this
// says Merge/دمج like the customer flow does.
function renderAdMergeActionButton(ad, isAr) {
  const entry = getAdMergePartnersFor(ad?.id);
  if (!entry) return '';
  const count = entry.partners.length;
  const label = isAr ? 'دمج' : 'Merge';
  const title = entry.role === 'manual'
    ? (isAr ? 'دمج هذا الإعلان مع نسخته المستوردة من Meta على نفس الصفحة' : 'Merge this ad with its Meta-imported copy on the same page')
    : (isAr ? 'دمج هذه النسخة المستوردة مع الإعلان الأصلي على نفس الصفحة' : 'Merge this imported copy into the original ad on the same page');
  return `<button type="button" data-action="merge-meta-twin" data-ad-id="${Security.escapeHtml(String(ad.id))}" onclick="openAdMergePicker(this.dataset.adId, this)" class="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-purple-200 bg-purple-50 px-2 text-xs font-bold text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-200" title="${Security.escapeHtml(title)}"><i data-lucide="combine" class="h-4 w-4"></i><span>${label}${count > 1 ? ` (${count})` : ''}</span></button>`;
}

// One candidate goes straight to the confirmation. Several means the owner has
// to say which two ads are really the same ad — the app must not guess.
function openAdMergePicker(adId, triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الإعلانات متاح للمدير فقط.' : 'Only an administrator can merge ads.', 'error');
    return;
  }
  const entry = getAdMergePartnersFor(adId);
  if (!entry) {
    showNotification(isAr ? 'لا يوجد ما يُدمج' : 'Nothing to merge', isAr ? 'لم يعد هناك إعلان مطابق على نفس الصفحة.' : 'There is no matching ad on the same page any more.', 'warning');
    return;
  }
  const pairFor = partner => (entry.role === 'manual'
    ? { keepId: String(entry.ad.id), draftId: String(partner.id) }
    : { keepId: String(partner.id), draftId: String(entry.ad.id) });
  if (entry.partners.length === 1) {
    const only = pairFor(entry.partners[0]);
    showAdMergeDialog(only.keepId, only.draftId, triggerButton);
    return;
  }

  closeAdMergeDialog(false);
  _adMergeReturnFocus = triggerButton || document.activeElement;
  const dialog = document.createElement('div');
  dialog.id = 'ad-merge-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ad-merge-picker-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <h2 id="ad-merge-picker-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${entry.role === 'manual' ? (isAr ? 'أي نسخة Meta هي نفس هذا الإعلان؟' : 'Which Meta copy is the same ad?') : (isAr ? 'أي إعلان هو نفس هذه النسخة؟' : 'Which ad is this copy?')}</h2>
          <p class="text-sm text-slate-500 break-words">${isAr ? 'كلها على نفس الصفحة. اختر واحداً لمراجعة الدمج قبل تنفيذه.' : 'They are all on the same page. Pick one to review the merge before it runs.'}</p>
        </div>
        <button type="button" onclick="closeAdMergeDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-2">
        ${entry.partners.map(partner => {
          const ids = pairFor(partner);
          const money = (Number(partner.amountUSD) || 0).toFixed(2);
          const when = partner.startDate ? new Date(partner.startDate) : null;
          const dateText = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString(appDateLocale()) : '';
          return `<button type="button" onclick="showAdMergeDialog('${Security.escapeHtml(ids.keepId)}','${Security.escapeHtml(ids.draftId)}', this)" class="w-full text-start rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20">
            <div class="font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(_describeMergeAdCustomer(partner, isAr))}</div>
            <div class="mt-0.5 text-xs text-slate-500 break-all">
              ${String(partner.metaAdId || '').trim() ? `Meta #${Security.escapeHtml(String(partner.metaAdId))}` : `${isAr ? 'المبلغ' : 'Amount'}: $${money}`}
              ${dateText ? ` • ${Security.escapeHtml(dateText)}` : ''}
            </div>
          </button>`;
        }).join('')}
      </div>
      <div class="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 p-4">
        <button type="button" onclick="closeAdMergeDialog()" class="w-full bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closeAdMergeDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

// Re-validates an explicitly chosen pair (the dialog and the write both use it,
// so a stale dialog can never merge two ads that stopped being a pair).
function getAdMergePlan(keepAdId, draftAdId) {
  const isAr = state.language === 'ar';
  const ads = getVisibleRecords(state.ads);
  const keepAd = ads.find(item => String(item.id) === String(keepAdId || '')) || null;
  const draftAd = ads.find(item => String(item.id) === String(draftAdId || '')) || null;
  const plan = { keepAd, draftAd, metaAdId: '', blocked: '' };
  if (!keepAd || !draftAd || String(keepAd.id) === String(draftAd.id)) {
    plan.blocked = isAr ? 'أحد الإعلانين لم يعد موجوداً. حدّث الصفحة وحاول مرة أخرى.' : 'One of the two ads no longer exists. Refresh and try again.';
    return plan;
  }
  if (!isServerModeEnabled()) {
    plan.blocked = isAr ? 'الدمج يحتاج الاتصال بالخادم.' : 'Merging needs a live server connection.';
    return plan;
  }
  plan.metaAdId = String(draftAd.metaAdId || '').trim();
  if (!plan.metaAdId || !isImportedMetaAd(draftAd)) {
    plan.blocked = isAr ? 'الإعلان الثاني ليس نسخة مستوردة من Meta.' : 'The second ad is not a Meta-imported copy.';
    return plan;
  }
  if (String(keepAd.metaAdId || '').trim()) {
    plan.blocked = isAr ? 'الإعلان الأساسي مرتبط بـ Meta بالفعل. ألغِ ربطه أولاً.' : 'The main ad is already linked to Meta. Unlink it first.';
    return plan;
  }
  if (isImportedMetaAd(keepAd)) {
    plan.blocked = isAr ? 'الإعلانان كلاهما مستورد من Meta.' : 'Both ads were imported from Meta.';
    return plan;
  }
  if (metaDraftCarriesMoney(draftAd)) {
    plan.blocked = isAr
      ? 'النسخة المستوردة عليها عميل أو مبلغ أو وصل. أفرغها أو احذفها بنفسك أولاً.'
      : 'The imported copy already has a customer, an amount or a receipt. Empty or delete it yourself first.';
    return plan;
  }
  if (!adsShareAPage(keepAd, draftAd)) {
    plan.blocked = isAr ? 'الإعلانان ليسا على نفس الصفحة.' : 'The two ads are not on the same page.';
    return plan;
  }
  return plan;
}

function closeAdMergeDialog(restoreFocus = true) {
  document.getElementById('ad-merge-dialog')?.remove();
  const target = _adMergeReturnFocus?.isConnected === false ? null : _adMergeReturnFocus;
  _adMergeReturnFocus = null;
  if (restoreFocus && target?.focus) target.focus();
}

function _describeMergeAdCustomer(ad, isAr) {
  const customer = (state.customers || []).find(item => String(item.id) === String(ad?.customerId || ''));
  return String(customer?.name || ad?.customerName || ad?.metaAdName || (isAr ? 'بدون عميل' : 'No customer')).trim();
}

function showAdMergeDialog(keepAdId, draftAdId, triggerButton) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الإعلانات متاح للمدير فقط.' : 'Only an administrator can merge ads.', 'error');
    return;
  }
  const plan = getAdMergePlan(keepAdId, draftAdId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }
  closeAdMergeDialog(false);
  _adMergeReturnFocus = triggerButton || document.activeElement;

  const keepAmount = (Number(plan.keepAd.amountUSD) || 0).toFixed(2);
  const keepReceipts = getAdLinkedReceiptIds(plan.keepAd).length;
  const dialog = document.createElement('div');
  dialog.id = 'ad-merge-dialog';
  dialog.className = 'mobile-dialog-overlay fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ad-merge-dialog-title');
  dialog.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  dialog.tabIndex = -1;
  dialog.innerHTML = `
    <div class="glass-panel w-full max-w-2xl max-h-[90dvh] overflow-hidden rounded-2xl shadow-2xl flex flex-col animate-slide-up">
      <div class="sticky top-0 z-10 bg-white dark:bg-slate-900 flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200 dark:border-slate-700">
        <div class="flex items-start gap-3 min-w-0">
          <span class="w-11 h-11 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 flex items-center justify-center shrink-0">
            <i data-lucide="combine" class="w-6 h-6"></i>
          </span>
          <div class="min-w-0">
            <h2 id="ad-merge-dialog-title" class="text-xl font-bold text-slate-800 dark:text-white break-words">${isAr ? 'دمج الإعلان مع نسخة Meta' : 'Merge this ad with its Meta copy'}</h2>
            <p class="text-sm text-slate-500 break-words">${isAr ? 'ينتقل ربط Meta إلى الإعلان الذي يحمل المال، وتُحذف النسخة الفارغة.' : 'The Meta link moves to the ad that holds the money, and the empty copy is removed.'}</p>
          </div>
        </div>
        <button type="button" onclick="closeAdMergeDialog()" class="min-w-11 min-h-11 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center flex-shrink-0" aria-label="${isAr ? 'إغلاق' : 'Close'}">
          <span class="text-2xl leading-none" aria-hidden="true">&times;</span>
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
        <div class="grid gap-3 md:grid-cols-2">
          <section class="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">${isAr ? 'سيبقى' : 'Will be kept'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(_describeMergeAdCustomer(plan.keepAd, isAr))}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300">${isAr ? 'المبلغ' : 'Amount'}: $${keepAmount}</div>
            <div class="text-xs text-slate-600 dark:text-slate-300">${isAr ? `${keepReceipts} وصل مرتبط` : `${keepReceipts} linked receipt${keepReceipts === 1 ? '' : 's'}`}</div>
            <div class="mt-2 inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-slate-900/50 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">${isAr ? 'سيأخذ ربط Meta' : 'Gains the Meta link'}</div>
          </section>
          <section class="rounded-xl border-2 border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-900/10 p-3">
            <div class="text-xs font-bold uppercase tracking-wide text-rose-700 dark:text-rose-300">${isAr ? 'ستُزال' : 'Will be removed'}</div>
            <div class="mt-1 font-bold text-slate-800 dark:text-white break-words">${Security.escapeHtml(String(plan.draftAd.metaAdName || (isAr ? 'مسودة Meta' : 'Meta draft')))}</div>
            <div class="mt-1 font-mono text-[11px] text-slate-500 break-all">Meta #${Security.escapeHtml(plan.metaAdId)}</div>
            <div class="mt-1 text-xs text-slate-600 dark:text-slate-300">${isAr ? 'بدون عميل أو مبلغ أو وصل' : 'No customer, amount or receipt'}</div>
          </section>
        </div>

        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <div class="font-bold text-slate-800 dark:text-white">${isAr ? 'ماذا سيحدث' : 'What will happen'}</div>
          <div>• ${isAr ? 'يُفك ربط Meta عن النسخة الفارغة.' : 'The empty copy releases the Meta link.'}</div>
          <div>• ${isAr ? 'يُربط الإعلان الباقي بنفس إعلان Meta ويأخذ الصورة والميزانية والمصروف.' : 'The surviving ad is linked to the same Meta ad and picks up its photo, budget and spend.'}</div>
          <div>• ${isAr ? 'تُحذف النسخة الفارغة في النهاية.' : 'The empty copy is removed last.'}</div>
          <div>• ${isAr ? 'لا يتغير أي مبلغ أو وصل أو صورة في الإعلان الباقي.' : 'No amount, receipt or photo on the surviving ad changes.'}</div>
        </div>
      </div>
      <div class="sticky bottom-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 p-4 flex flex-col sm:flex-row gap-2">
        <button type="button" id="ad-merge-confirm" onclick="runAdMerge('${Security.escapeHtml(String(plan.keepAd.id))}','${Security.escapeHtml(String(plan.draftAd.id))}')" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-purple-700 min-h-11">
          <i data-lucide="combine" class="w-4 h-4 inline mr-2"></i>${isAr ? 'دمج الآن' : 'Merge now'}
        </button>
        <button type="button" onclick="closeAdMergeDialog()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300 min-h-11">${isAr ? 'إلغاء' : 'Cancel'}</button>
      </div>
    </div>`;
  dialog.addEventListener('click', event => { if (event.target === dialog) closeAdMergeDialog(); });
  document.body.appendChild(dialog);
  IconQueue.schedule(dialog);
  dialog.focus();
}

function _liveMergeAd(adId) {
  return (state.ads || []).find(item => item && String(item.id) === String(adId || '')) || null;
}

async function runAdMerge(keepAdId, draftAdId) {
  const isAr = state.language === 'ar';
  if (!isMergeToolsAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج الإعلانات متاح للمدير فقط.' : 'Only an administrator can merge ads.', 'error');
    return;
  }
  if (_mergeToolsBusy) return;
  const plan = getAdMergePlan(keepAdId, draftAdId);
  if (plan.blocked) {
    showNotification(isAr ? 'تعذّر الدمج' : 'Cannot merge', plan.blocked, 'warning');
    return;
  }

  _mergeToolsBusy = 'ad';
  const confirmButton = document.getElementById('ad-merge-confirm');
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = isAr ? 'جارٍ الدمج…' : 'Merging…';
  }

  const metaAdId = plan.metaAdId;
  const draftId = String(plan.draftAd.id);
  const keepId = String(plan.keepAd.id);
  let released = false;
  try {
    // 1. Release the link. Meta allows one Albayan ad per Meta ad and the check
    //    ignores deleted rows, so the draft has to let go before the real ad can
    //    take over.
    const draftBefore = _liveMergeAd(draftId);
    // Without a known version the server cannot detect that someone else edited
    // the ad first, so refuse rather than overwrite blindly.
    if (!Number.isFinite(Number(draftBefore?._lastModified))) {
      throw new Error(isAr ? 'حدّث البيانات ثم أعد المحاولة.' : 'Refresh the data and try again.');
    }
    const unlinked = await apiUnlinkMetaAd(
      draftId,
      Number(draftBefore._lastModified),
      Security.generateSecureId('merge_unlink')
    );
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: unlinked.ad }], 'adMergeUnlink');
    released = true;

    // 2. Give the link to the ad that actually holds the money. This also pulls
    //    the Meta photo, budget, spend and schedule onto it.
    const keepBefore = _liveMergeAd(keepId);
    if (!Number.isFinite(Number(keepBefore?._lastModified))) {
      throw new Error(isAr ? 'حدّث البيانات ثم أعد المحاولة.' : 'Refresh the data and try again.');
    }
    const linked = await apiLinkMetaAd(
      keepId,
      metaAdId,
      Number(keepBefore._lastModified),
      Security.generateSecureId('merge_link')
    );
    applyValidatedServerEntityBatch([{ collection: 'ads', entity: linked.ad }], 'adMergeLink');
    released = false;

    // 3. Only now is the empty draft redundant. A draft carries no money, so
    //    removing it returns nothing and unwinds nothing.
    const removed = await deleteRecord(state.ads, draftId);
    if (!removed) {
      showNotification(
        isAr ? 'تم الربط' : 'Linked',
        isAr ? 'انتقل ربط Meta بنجاح، لكن تعذّر حذف النسخة الفارغة. احذفها يدوياً.' : 'The Meta link moved successfully, but the empty copy could not be removed. Delete it by hand.',
        'warning'
      );
      return;
    }
    showNotification(
      isAr ? 'تم الدمج' : 'Merged',
      isAr ? 'أصبح الإعلان مرتبطاً بـ Meta وحُذفت النسخة المكررة.' : 'The ad is now linked to Meta and the duplicate copy was removed.',
      'success'
    );
  } catch (error) {
    // The draft gave up its link and the real ad never took it. Put it back so
    // the pair is exactly as it was and the merge can simply be retried.
    if (released) {
      try {
        const draftNow = _liveMergeAd(draftId);
        const restored = await apiLinkMetaAd(
          draftId,
          metaAdId,
          Number(draftNow?._lastModified),
          Security.generateSecureId('merge_restore')
        );
        applyValidatedServerEntityBatch([{ collection: 'ads', entity: restored.ad }], 'adMergeRestore');
      } catch (_) {
        showNotification(
          isAr ? 'يحتاج انتباهك' : 'Needs your attention',
          isAr
            ? `لم يكتمل الدمج وبقيت النسخة المستوردة بدون ربط. اربطها يدوياً بإعلان Meta رقم ${metaAdId}.`
            : `The merge did not finish and the imported copy is left unlinked. Link it back to Meta ad ${metaAdId} by hand.`,
          'error'
        );
      }
    }
    showNotification(
      isAr ? 'تعذّر الدمج' : 'Merge failed',
      error?.message || (isAr ? 'حدث خطأ أثناء الدمج. أعد المحاولة.' : 'Something went wrong during the merge. Try again.'),
      'error'
    );
  } finally {
    _mergeToolsBusy = '';
    resetAdMergePairCache();
    closeAdMergeDialog(false);
    render();
  }
}
