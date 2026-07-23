let _customerMergeReturnFocus = null;

function getCustomerMergeRelationshipCounts(customerId) {
  const id = String(customerId || '');
  const pages = getVisibleRecords(state.pages).filter(page => {
    if (Array.isArray(page.customerIds)) return page.customerIds.map(String).includes(id);
    return String(page.customerId || page.customer || '') === id;
  }).length;
  const receipts = getVisibleRecords(state.receipts)
    .filter(receipt => String(receipt.customerId || receipt.customer || '') === id).length;
  const ads = getVisibleRecords(state.ads)
    .filter(ad => ad.recordType !== 'receipt' && String(ad.customerId || ad.customer || '') === id).length;
  return { pages, receipts, ads, total: pages + receipts + ads };
}

function getRecommendedCustomerToKeep(customers) {
  return (Array.isArray(customers) ? customers : []).slice().sort((left, right) => {
    const rightLinks = getCustomerMergeRelationshipCounts(right?.id).total;
    const leftLinks = getCustomerMergeRelationshipCounts(left?.id).total;
    if (rightLinks !== leftLinks) return rightLinks - leftLinks;
    // On equal link counts, keep the older identity. It is more likely to be
    // the record staff and historical exports already recognize.
    const leftCreated = Number(left?._created || Date.parse(left?.joinDate || '') || Number.MAX_SAFE_INTEGER);
    const rightCreated = Number(right?._created || Date.parse(right?.joinDate || '') || Number.MAX_SAFE_INTEGER);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  })[0] || null;
}

function setCustomerMergePairFromGroup(groupIndex) {
  const groups = findDuplicateCustomerGroups(state.customers);
  const safeIndex = Math.max(0, Math.min(Number(groupIndex) || 0, Math.max(0, groups.length - 1)));
  const group = groups[safeIndex];
  if (!group || group.customers.length < 2) return false;
  const keep = getRecommendedCustomerToKeep(group.customers);
  const duplicate = group.customers.find(customer => String(customer.id) !== String(keep?.id));
  state.modalData = {
    duplicateGroupIndex: safeIndex,
    keepCustomerId: String(keep?.id || ''),
    duplicateCustomerId: String(duplicate?.id || ''),
    idempotencyKey: Security.generateSecureId('customer-merge')
  };
  return true;
}

function showCustomerDuplicateMerge(preferredCustomerId = '') {
  const isAr = state.language === 'ar';
  if (!isCurrentUserAdmin()) {
    showNotification(isAr ? 'تم رفض الوصول' : 'Access Denied', isAr ? 'دمج العملاء متاح للمدير فقط.' : 'Only an administrator can merge customers.', 'error');
    return;
  }
  if (!isServerModeEnabled()) {
    showNotification(
      isAr ? 'يتطلب اتصال الخادم' : 'Server connection required',
      isAr ? 'الدمج الآمن ينقل كل الروابط في معاملة واحدة، لذلك يجب الاتصال بالخادم أولاً.' : 'Safe merge moves every link in one transaction, so connect to the server first.',
      'warning'
    );
    return;
  }
  const groups = findDuplicateCustomerGroups(state.customers);
  if (groups.length === 0) {
    showNotification(isAr ? 'لا يوجد تكرار' : 'No duplicates found', isAr ? 'لا توجد أرقام هاتف مشتركة بين العملاء الحاليين.' : 'No active customers share the same normalized phone number.', 'success');
    return;
  }
  const preferred = String(preferredCustomerId || '');
  const groupIndex = preferred
    ? Math.max(0, groups.findIndex(group => group.customers.some(customer => String(customer.id) === preferred)))
    : 0;
  _customerMergeReturnFocus = document.activeElement && typeof document.activeElement.focus === 'function'
    ? document.activeElement
    : null;
  state.activeModal = 'customer-merge';
  if (!setCustomerMergePairFromGroup(groupIndex)) return;
  renderModal();
}

function selectCustomerDuplicateGroup(groupIndex) {
  if (!isCurrentUserAdmin() || state.activeModal !== 'customer-merge') return;
  if (setCustomerMergePairFromGroup(groupIndex)) renderModal();
}

function selectCustomerMergeKeep(customerId) {
  if (!isCurrentUserAdmin() || state.activeModal !== 'customer-merge') return;
  const groups = findDuplicateCustomerGroups(state.customers);
  const group = groups[Number(state.modalData?.duplicateGroupIndex) || 0];
  if (!group) return;
  const keepId = String(customerId || '');
  if (!group.customers.some(customer => String(customer.id) === keepId)) return;
  let duplicateId = String(state.modalData?.duplicateCustomerId || '');
  if (duplicateId === keepId || !group.customers.some(customer => String(customer.id) === duplicateId)) {
    duplicateId = String(group.customers.find(customer => String(customer.id) !== keepId)?.id || '');
  }
  state.modalData.keepCustomerId = keepId;
  state.modalData.duplicateCustomerId = duplicateId;
  state.modalData.idempotencyKey = Security.generateSecureId('customer-merge');
  renderModal();
}

function selectCustomerMergeDuplicate(customerId) {
  if (!isCurrentUserAdmin() || state.activeModal !== 'customer-merge') return;
  const groups = findDuplicateCustomerGroups(state.customers);
  const group = groups[Number(state.modalData?.duplicateGroupIndex) || 0];
  const duplicateId = String(customerId || '');
  if (!group || duplicateId === String(state.modalData?.keepCustomerId || '') || !group.customers.some(customer => String(customer.id) === duplicateId)) return;
  state.modalData.duplicateCustomerId = duplicateId;
  state.modalData.idempotencyKey = Security.generateSecureId('customer-merge');
  renderModal();
}

function renderModal() {
  const existingModal = document.getElementById('app-modal');
  const previousCustomerMergeFocusId = existingModal && state.activeModal === 'customer-merge'
    && existingModal.contains(document.activeElement)
    ? String(document.activeElement?.id || '')
    : '';
  if (existingModal) existingModal.remove();
  
  if (!state.activeModal) return;
  
  const isEdit = state.modalData !== null;
  let modalContent = '';
  switch (state.activeModal) {
    case 'customer':
      const custData = state.modalData || {};
      const phones = getCustomerPhoneEntries(custData).map(entry => entry.value);
      if (phones.length === 0) phones.push('');
      const profileLinks = custData.profileLinks || [];
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="user" class="w-6 h-6 mr-2 text-indigo-600"></i>
          ${state.language === 'ar' ? (isEdit ? 'تعديل عميل' : 'إضافة عميل') : `${isEdit ? 'Edit' : 'Add'} Customer`}
        </h2>
        <form id="modal-form" class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar pr-2">
          <!-- Name -->
          <div>
            <label class="block text-sm font-medium mb-2">${state.language === 'ar' ? 'الاسم *' : 'Name *'}</label>
            <input type="text" id="customer-name" value="${Security.escapeHtml(custData.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${state.language === 'ar' ? 'اسم العميل' : 'Customer name'}" />
          </div>

          <!-- Platform -->
          <div>
            <label class="block text-sm font-medium mb-2">${state.language === 'ar' ? 'المنصة *' : 'Platform *'}</label>
            <select id="customer-platform" class="w-full glass-input px-4 py-2 rounded-xl">
              ${PLATFORMS.map(p => `<option value="${p}" ${custData.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>

          <!-- Join Date -->
          <div>
            <label class="block text-sm font-medium mb-2">${state.language === 'ar' ? 'تاريخ الانضمام' : 'Join Date'}</label>
            <input type="date" id="customer-joindate" value="${Security.escapeHtml(custData.joinDate ? custData.joinDate.split('T')[0] : getTodayDateString())}" class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>

          <!-- Phone Numbers -->
          <div>
            <div class="flex justify-between items-center mb-2">
              <label class="block text-sm font-medium">${state.language === 'ar' ? 'أرقام الهاتف *' : 'Phone Numbers *'}</label>
              <button type="button" onclick="addPhoneField()" class="text-indigo-600 hover:text-indigo-700 text-sm font-medium flex items-center space-x-1">
                <i data-lucide="plus-circle" class="w-4 h-4"></i>
                <span>${state.language === 'ar' ? 'إضافة هاتف' : 'Add Phone'}</span>
              </button>
            </div>
            <div id="phone-fields-container" class="space-y-2">
              ${phones.map((phone, index) => `
                <div class="flex items-center space-x-2 phone-field-group">
                  <input type="tel" class="customer-phone flex-1 glass-input px-4 py-2 rounded-xl" value="${Security.escapeHtml(phone || '')}" placeholder="${state.language === 'ar' ? 'رقم الهاتف' : 'Phone number'}" ${index === 0 ? 'required' : ''} />
                  ${index > 0 ? `
                    <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  ` : `<div class="w-8"></div>`}
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Profile Links -->
          <div>
            <div class="flex justify-between items-center mb-2">
              <label class="block text-sm font-medium">${state.language === 'ar' ? 'روابط الملف الشخصي' : 'Profile Links'}</label>
              <button type="button" onclick="addProfileLinkField()" class="text-indigo-600 hover:text-indigo-700 text-sm font-medium flex items-center space-x-1">
                <i data-lucide="plus-circle" class="w-4 h-4"></i>
                <span>${state.language === 'ar' ? 'إضافة رابط' : 'Add Link'}</span>
              </button>
            </div>
            <div id="profile-links-container" class="space-y-2">
              ${profileLinks.length > 0 ? profileLinks.map((link, index) => `
                <div class="flex items-center space-x-2 link-field-group">
                  <input type="url" class="customer-link flex-1 glass-input px-4 py-2 rounded-xl" value="${Security.escapeHtml(link || '')}" placeholder="https://facebook.com/..." />
                  <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              `).join('') : `
                <div class="text-center py-4 text-sm text-slate-400">
                  <i data-lucide="link" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
                  <p>${state.language === 'ar' ? 'لا توجد روابط بعد. اضغط "إضافة رابط" لإضافة واحد.' : 'No profile links yet. Click "Add Link" to add one.'}</p>
                </div>
              `}
            </div>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button type="submit" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${state.language === 'ar' ? (isEdit ? 'حفظ التغييرات' : 'إنشاء عميل') : (isEdit ? 'Save Changes' : 'Create Customer')}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300">${state.language === 'ar' ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </form>
      `;
      break;
    case 'customer-merge': {
      const isArMerge = state.language === 'ar';
      const duplicateGroups = findDuplicateCustomerGroups(state.customers);
      const selectedGroupIndex = Math.max(0, Math.min(
        Number(state.modalData?.duplicateGroupIndex) || 0,
        Math.max(0, duplicateGroups.length - 1)
      ));
      const selectedGroup = duplicateGroups[selectedGroupIndex];
      if (!isCurrentUserAdmin() || !selectedGroup) {
        modalContent = `<h2 id="customer-merge-title" tabindex="-1" class="text-center py-8 text-slate-500">${isArMerge ? 'لا توجد مجموعة تكرار متاحة.' : 'No duplicate group is available.'}</h2>`;
        break;
      }
      const groupCustomers = selectedGroup.customers;
      const recommendedKeep = getRecommendedCustomerToKeep(groupCustomers);
      let keepCustomerId = String(state.modalData?.keepCustomerId || recommendedKeep?.id || '');
      if (!groupCustomers.some(customer => String(customer.id) === keepCustomerId)) {
        keepCustomerId = String(recommendedKeep?.id || groupCustomers[0]?.id || '');
      }
      let duplicateCustomerId = String(state.modalData?.duplicateCustomerId || '');
      if (duplicateCustomerId === keepCustomerId || !groupCustomers.some(customer => String(customer.id) === duplicateCustomerId)) {
        duplicateCustomerId = String(groupCustomers.find(customer => String(customer.id) !== keepCustomerId)?.id || '');
      }
      state.modalData.keepCustomerId = keepCustomerId;
      state.modalData.duplicateCustomerId = duplicateCustomerId;
      const keepCustomer = groupCustomers.find(customer => String(customer.id) === keepCustomerId);
      const duplicateCustomer = groupCustomers.find(customer => String(customer.id) === duplicateCustomerId);
      const keepCounts = getCustomerMergeRelationshipCounts(keepCustomerId);
      const duplicateCounts = getCustomerMergeRelationshipCounts(duplicateCustomerId);
      const describeCustomer = customer => {
        const firstPhone = getCustomerPhoneEntries(customer)[0]?.value || (isArMerge ? 'بدون هاتف' : 'No phone');
        const counts = getCustomerMergeRelationshipCounts(customer?.id);
        return `${customer?.name || (isArMerge ? 'عميل بدون اسم' : 'Unnamed customer')} · ${firstPhone} · ${counts.total} ${isArMerge ? 'سجل مرتبط' : 'linked'}`;
      };
      const sharedPhones = selectedGroup.sharedPhoneKeys
        .map(key => key.startsWith('218') ? `+${key}` : key)
        .join(', ');
      modalContent = `
        <div class="mb-5">
          <div class="flex items-start gap-3">
            <span class="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
              <i data-lucide="combine" class="w-6 h-6"></i>
            </span>
            <div>
              <h2 id="customer-merge-title" tabindex="-1" class="text-2xl font-bold text-slate-900 dark:text-white">${isArMerge ? 'دمج العملاء المكررين' : 'Merge duplicate customers'}</h2>
              <p class="text-sm text-slate-500 mt-1">${isArMerge ? 'اختر السجل الذي سيبقى. سيتم نقل كل الصفحات والوصولات والإعلانات بأمان.' : 'Choose the record to keep. Every page, receipt and ad will be moved safely.'}</p>
            </div>
          </div>
        </div>
        <form id="modal-form" class="space-y-5 pr-1">
          ${duplicateGroups.length > 1 ? `
          <div>
            <label for="customer-duplicate-group" class="block text-sm font-bold mb-2">${isArMerge ? 'مجموعة التكرار' : 'Duplicate group'}</label>
            <select id="customer-duplicate-group" onchange="selectCustomerDuplicateGroup(this.value)" class="w-full glass-input px-4 py-3 rounded-xl">
              ${duplicateGroups.map((group, index) => `<option value="${index}" ${index === selectedGroupIndex ? 'selected' : ''}>${Security.escapeHtml(`${index + 1}. ${group.customers.map(customer => customer.name || 'Unnamed').join(' / ')}`)}</option>`).join('')}
            </select>
          </div>` : ''}

          <div class="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm">
            <div class="font-bold text-amber-800 dark:text-amber-200">${isArMerge ? 'سبب اكتشاف التكرار' : 'Why these records match'}</div>
            <div class="mt-1 text-amber-700 dark:text-amber-300 break-all">${isArMerge ? 'رقم هاتف مشترك:' : 'Shared phone:'} ${Security.escapeHtml(sharedPhones || (isArMerge ? 'تم العثور على تطابق' : 'match found'))}</div>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            <div class="rounded-xl border-2 border-emerald-300 dark:border-emerald-700 p-4 bg-emerald-50/60 dark:bg-emerald-900/10">
              <label for="customer-merge-keep" class="block text-sm font-bold text-emerald-800 dark:text-emerald-300 mb-2">${isArMerge ? '1. العميل الذي سيبقى' : '1. Customer to keep'}</label>
              <select id="customer-merge-keep" onchange="selectCustomerMergeKeep(this.value)" class="w-full glass-input px-3 py-3 rounded-xl">
                ${groupCustomers.map(customer => `<option value="${Security.escapeHtml(String(customer.id || ''))}" ${String(customer.id) === keepCustomerId ? 'selected' : ''}>${Security.escapeHtml(describeCustomer(customer))}</option>`).join('')}
              </select>
              ${String(recommendedKeep?.id || '') === keepCustomerId ? `<div class="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300"><i data-lucide="sparkles" class="w-3 h-3"></i>${isArMerge ? 'موصى به: لديه سجلات مرتبطة أكثر' : 'Recommended: more linked records'}</div>` : ''}
              <div class="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
                <div class="rounded-lg bg-white/70 dark:bg-slate-900/40 p-2"><strong class="block text-base">${keepCounts.pages}</strong>${isArMerge ? 'صفحات' : 'Pages'}</div>
                <div class="rounded-lg bg-white/70 dark:bg-slate-900/40 p-2"><strong class="block text-base">${keepCounts.receipts}</strong>${isArMerge ? 'وصولات' : 'Receipts'}</div>
                <div class="rounded-lg bg-white/70 dark:bg-slate-900/40 p-2"><strong class="block text-base">${keepCounts.ads}</strong>${isArMerge ? 'إعلانات' : 'Ads'}</div>
              </div>
            </div>

            <div class="rounded-xl border-2 border-rose-200 dark:border-rose-800 p-4 bg-rose-50/60 dark:bg-rose-900/10">
              <label for="customer-merge-duplicate" class="block text-sm font-bold text-rose-800 dark:text-rose-300 mb-2">${isArMerge ? '2. السجل المكرر الذي سيُؤرشف' : '2. Duplicate to archive'}</label>
              <select id="customer-merge-duplicate" onchange="selectCustomerMergeDuplicate(this.value)" class="w-full glass-input px-3 py-3 rounded-xl">
                ${groupCustomers.filter(customer => String(customer.id) !== keepCustomerId).map(customer => `<option value="${Security.escapeHtml(String(customer.id || ''))}" ${String(customer.id) === duplicateCustomerId ? 'selected' : ''}>${Security.escapeHtml(describeCustomer(customer))}</option>`).join('')}
              </select>
              <div class="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
                <div class="rounded-lg bg-white/70 dark:bg-slate-900/40 p-2"><strong class="block text-base">${duplicateCounts.pages}</strong>${isArMerge ? 'صفحات' : 'Pages'}</div>
                <div class="rounded-lg bg-white/70 dark:bg-slate-900/40 p-2"><strong class="block text-base">${duplicateCounts.receipts}</strong>${isArMerge ? 'وصولات' : 'Receipts'}</div>
                <div class="rounded-lg bg-white/70 dark:bg-slate-900/40 p-2"><strong class="block text-base">${duplicateCounts.ads}</strong>${isArMerge ? 'إعلانات' : 'Ads'}</div>
              </div>
            </div>
          </div>

          <div class="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4 text-sm text-blue-800 dark:text-blue-200">
            <div class="font-bold">${isArMerge ? `سيتم نقل ${duplicateCounts.total} سجل مرتبط إلى «${Security.escapeHtml(keepCustomer?.name || '')}»` : `${duplicateCounts.total} linked record(s) will move to “${Security.escapeHtml(keepCustomer?.name || '')}”`}</div>
            <p class="mt-1 text-xs">${isArMerge ? 'لن تُحذف الوصولات أو الإعلانات ولن تتغير مبالغها. بعد نجاح النقل فقط، سيُؤرشف سجل العميل المكرر.' : 'No receipt or ad is deleted and no amount is changed. The duplicate customer is archived only after the move succeeds.'}</p>
          </div>

          <label class="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-4 cursor-pointer">
            <input id="customer-merge-confirm" type="checkbox" required class="mt-1 w-5 h-5 rounded border-slate-300 text-indigo-600" />
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200">${isArMerge ? 'راجعت السجلين وأؤكد أنهما لنفس العميل.' : 'I reviewed both records and confirm they belong to the same customer.'}</span>
          </label>

          <div class="flex flex-col-reverse sm:flex-row gap-3 pt-2">
            <button type="button" onclick="closeModal()" class="flex-1 min-h-12 bg-slate-200 dark:bg-slate-700 px-5 py-3 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600">${isArMerge ? 'إلغاء' : 'Cancel'}</button>
            <button type="submit" class="flex-1 min-h-12 btn-shine bg-indigo-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-indigo-700 inline-flex items-center justify-center gap-2"><i data-lucide="combine" class="w-5 h-5"></i>${isArMerge ? 'دمج بأمان' : 'Merge safely'}</button>
          </div>
        </form>
      `;
      break;
    }
    case 'ad':
      const visibleCustomers = getVisibleRecords(state.customers);
      const visiblePages = getVisibleRecords(state.pages);
      const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      const adData = state.modalData || {};
      // Copy (not alias) the live record's photos — the receipt modal already
      // does this (see state.tempReceiptPhotos below). Aliasing meant adding or
      // removing a photo mutated the SAVED ad immediately, even on Cancel.
      _adPhotoUploadGeneration++;
      _adPhotoUploadsInFlight = 0;
      state.tempAdPhotos = (!isEdit || can('ads', 'viewPhotos')) ? getAdPhotoSources(adData) : [];
      state.tempAdPhotosDirty = false;
      const durationDaysDefault = (adData.days !== undefined ? adData.days : (adData.startDate && adData.endDate ? Math.max(0, Math.round((new Date(adData.endDate) - new Date(adData.startDate)) / (1000 * 60 * 60 * 24))) : ''));
      const isAdminUser = isCurrentUserAdmin();
      const adCreator = isEdit && adData.creatorId ? state.users.find(u => u.id === adData.creatorId) : state.currentUser;
      const isArAd = state.language === 'ar';
      const adPaymentState = getAdPaymentState(adData);
      const hasLinkedShopReceipt = adPaymentState === 'not_paid'
        && adData.collectionMethod === 'in_shop'
        && Array.isArray(adData.dueAllocations)
        && adData.dueAllocations.some(row => row && row.receiptId && Number(row.amountUSD) > 0);

      if (visiblePages.length === 0) {
        modalContent = `
          <div class="text-center py-8">
            <div class="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-xl">
              <i data-lucide="file-text" class="w-10 h-10 text-white"></i>
            </div>
            <h2 class="text-xl font-bold text-slate-800 dark:text-white mb-2">${isArAd ? 'لا توجد صفحات' : 'No Pages Found'}</h2>
            <p class="text-slate-500 mb-4">${isArAd ? 'الرجاء إضافة صفحة فيسبوك أولاً قبل إنشاء إعلان.' : 'Please add a Facebook Page first before creating an ad.'}</p>
            <button onclick="closeModal(); navigateTo('pages')" class="btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-3 rounded-xl font-bold">
              <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>${isArAd ? 'إضافة صفحة' : 'Add Page'}
            </button>
          </div>
        `;
        break;
      }
      
      // NEW DESIGN: Full-height scrollable modal with clear sections
      modalContent = `
        <div class="flex flex-col h-full max-h-[85vh]">
          <!-- FIXED HEADER -->
          <div class="flex-shrink-0 flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-700">
            <div class="flex items-center space-x-3">
              <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
                <i data-lucide="megaphone" class="w-5 h-5 text-white"></i>
              </span>
              <div>
                <h2 class="text-lg font-bold text-slate-800 dark:text-white">${isArAd ? (isEdit ? 'تعديل إعلان' : 'إعلان جديد') : `${isEdit ? 'Edit' : 'New'} Ad`}</h2>
                <p class="text-slate-400 text-xs">${isArAd ? 'املأ جميع الأقسام أدناه' : 'Fill all sections below'}</p>
              </div>
            </div>
            <button type="button" onclick="closeModal()" class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-rose-100 hover:text-rose-600 transition-colors">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          <!-- SCROLLABLE FORM BODY -->
          <form id="modal-form" class="flex-1 overflow-y-auto py-4 space-y-4" style="max-height: calc(85vh - 140px);">
            
            <!-- SECTION 1: Basic Info -->
            <div class="bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-800/50 dark:to-slate-800/30 rounded-xl p-4 space-y-3 border border-slate-200 dark:border-slate-700">
              <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[10px]">1</span>
                ${isArAd ? 'معلومات أساسية' : 'Basic Info'}
              </div>
              
              <!-- Creator -->
              <div class="flex items-center justify-between p-2 bg-white dark:bg-slate-900 rounded-lg">
                <div class="flex items-center space-x-2">
                  <div class="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 font-bold text-xs">
                    ${adCreator?.name?.charAt(0) || 'U'}
                  </div>
                  <span class="text-sm text-slate-600 dark:text-slate-300">${Security.escapeHtml(adCreator?.name || (isArAd ? 'غير معروف' : 'Unknown'))}</span>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[9px] font-bold ${isAdminUser ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'}">
                  ${isAdminUser ? (isArAd ? 'أدمن' : 'ADMIN') : (isArAd ? 'مستخدم' : 'USER')}
                </span>
              </div>
              <input type="hidden" id="ad-creator-id" value="${adCreator?.id || state.currentUser?.id || ''}" />
              
              <!-- Page Selection -->
              <div>
                <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">${isArAd ? 'الصفحة *' : 'Page *'}</label>
                <div class="relative">
                  <input type="text" id="ad-page-search" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-3 py-2 rounded-lg text-sm" placeholder="${isArAd ? 'ابحث في الصفحات...' : 'Search pages...'}" oninput="filterAdPages()" onfocus="showAdPageDropdown()" value="${Security.escapeHtml((state.pages.find(p => p.id === adData.pageId)?.name) || '')}" autocomplete="off" />
                  <div id="ad-page-dropdown" class="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 rounded-lg shadow-xl max-h-48 overflow-y-auto hidden border border-slate-200 dark:border-slate-600">
                    ${visiblePages.map(p => `
                      <div class="page-option px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer text-sm" data-name="${Security.escapeHtml((p.name || '').toLowerCase())}" data-record-action="select-ad-page" data-record-id="${Security.escapeHtml(String(p.id || ''))}">
                        ${Security.escapeHtml(p.name || '')}
                      </div>
                    `).join('')}
                  </div>
                  <input type="hidden" id="ad-page" value="${adData.pageId || ''}" required />
                </div>
              </div>
              
              <!-- Customer -->
              <div id="ad-customer-section" class="${adData.pageId ? '' : 'hidden'}">
                <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">${isArAd ? 'العميل' : 'Customer'} <span class="text-slate-400" id="ad-customer-hint">${isArAd ? '(يُختار تلقائياً)' : '(auto-selected)'}</span></label>
                <div id="ad-customer-display" class="bg-white dark:bg-slate-900 rounded-lg p-2"></div>
                <input type="hidden" id="ad-customer-id" value="${adData.customerId || ''}" required />
              </div>
            </div>

            <!-- SECTION 2: Payment Status -->
            <div class="bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 space-y-3 border border-emerald-200 dark:border-emerald-800">
              <div class="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[10px]">2</span>
                ${isArAd ? 'حالة الدفع' : 'Payment Status'}
              </div>
              <div class="grid grid-cols-3 gap-2">
                <button type="button" onclick="setAdPaymentStatus('paid')" id="ad-pay-status-paid"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adPaymentState === 'paid' ? 'border-emerald-500 bg-emerald-100 dark:bg-emerald-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="check-circle" class="w-5 h-5 ${adPaymentState === 'paid' ? 'text-emerald-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adPaymentState === 'paid' ? 'text-emerald-700' : 'text-slate-500'}">${trStatus('Paid')}</span>
                </button>
                <button type="button" onclick="setAdPaymentStatus('not_paid')" id="ad-pay-status-not-paid"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adPaymentState === 'not_paid' ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="clock" class="w-5 h-5 ${adPaymentState === 'not_paid' ? 'text-amber-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adPaymentState === 'not_paid' ? 'text-amber-700' : 'text-slate-500'}">${isArAd ? 'غير مدفوع' : 'Not Paid'}</span>
                </button>
                <button type="button" onclick="setAdPaymentStatus('wont_pay')" id="ad-pay-status-wont"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adPaymentState === 'wont_pay' ? 'border-rose-500 bg-rose-100 dark:bg-rose-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="x-octagon" class="w-5 h-5 ${adPaymentState === 'wont_pay' ? 'text-rose-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adPaymentState === 'wont_pay' ? 'text-rose-700' : 'text-slate-500'}">${isArAd ? 'لن يدفع' : "Won't Pay"}</span>
                </button>
              </div>
              <input type="hidden" id="ad-payment-status" value="${adPaymentState}" />
            </div>

            <!-- NOT PAID OPTIONS -->
            <div id="ad-not-paid-options" class="${adPaymentState === 'not_paid' ? '' : 'hidden'}">
              <div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-3">
                <label class="block text-xs font-bold text-amber-700">${isArAd ? 'كيف سيتم تحصيل الدفع؟' : 'How will payment be collected?'}</label>
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" onclick="setAdCollectionMethod('in_shop')" id="ad-collect-shop"
                    class="p-3 rounded-lg border-2 flex flex-col items-center ${adData.collectionMethod === 'in_shop' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'}">
                    <i data-lucide="store" class="w-5 h-5 ${adData.collectionMethod === 'in_shop' ? 'text-blue-600' : 'text-slate-400'}"></i>
                    <span class="text-xs font-medium mt-1">${isArAd ? 'في المحل' : 'In Shop'}</span>
                  </button>
                  <button type="button" onclick="setAdCollectionMethod('driver')" id="ad-collect-driver"
                    class="p-3 rounded-lg border-2 flex flex-col items-center ${adData.collectionMethod === 'driver' ? 'border-violet-500 bg-violet-50' : 'border-slate-200 bg-white'}">
                    <i data-lucide="truck" class="w-5 h-5 ${adData.collectionMethod === 'driver' ? 'text-violet-600' : 'text-slate-400'}"></i>
                    <span class="text-xs font-medium mt-1">${isArAd ? 'سائق' : 'Driver'}</span>
                  </button>
                </div>
                <input type="hidden" id="ad-collection-method" value="${adData.collectionMethod || ''}" />
                <div id="ad-collection-details" class="${adData.collectionMethod ? '' : 'hidden'} pt-2 border-t border-amber-200">
                  <div id="ad-driver-budget-section" class="${adData.collectionMethod === 'driver' ? '' : 'hidden'} mb-3 p-3 bg-violet-50 dark:bg-violet-900/20 rounded-lg border border-violet-200 dark:border-violet-800 space-y-2">
                    <label for="ad-driver-budget-usd" class="block text-xs font-bold text-violet-700 dark:text-violet-300">${isArAd ? 'ميزانية الإعلان (USD) *' : 'Ad Budget (USD) *'}</label>
                    <input
                      type="text"
                      inputmode="decimal"
                      id="ad-driver-budget-usd"
                      value="${Security.escapeHtml(Number(adData.amountUSD || 0) > 0 ? Number(adData.amountUSD).toFixed(2) : '')}"
                      class="w-full border border-violet-300 dark:border-violet-700 bg-white dark:bg-slate-900 px-3 py-2 rounded-lg text-sm font-bold"
                      placeholder="0.00"
                      oninput="sanitizeMoneyInput(this); updateAdDriverBudgetSummary()"
                      onfocus="this.select()"
                    />
                    <input type="hidden" id="ad-driver-budget-rate" value="${Security.escapeHtml(String(adData.exchangeRate || state.defaultExchangeRate || 1))}" />
                    <div id="ad-driver-budget-summary" class="text-[11px] text-violet-600 dark:text-violet-300"></div>
                    <div class="text-[11px] text-amber-700 dark:text-amber-300">
                      ${isArAd
                        ? 'سيظهر هذا المبلغ كدين على العميل حتى تسجيل الدفع. لاحقاً عدّل الإعلان إلى «مدفوع» واربط وصل العميل.'
                        : 'This amount appears as customer debt until payment is recorded. Later edit the ad to Paid and link the customer receipt.'}
                    </div>
                  </div>
                  <div id="ad-driver-select" class="hidden"></div>
                  <div id="ad-temp-receipt-link" class="hidden mt-2 p-3 bg-white dark:bg-slate-900 rounded-lg border border-violet-200 dark:border-violet-800 space-y-3">
                    <label for="ad-temp-receipt-id" id="ad-linked-receipt-label" class="block text-xs font-bold text-violet-700 dark:text-violet-300">${adData.collectionMethod === 'in_shop' ? (isArAd ? 'ربط وصل غير مدفوع في المحل' : 'Link Unpaid In-Shop Receipt') : (isArAd ? 'ربط وصل توصيل (D#)' : 'Link Delivery Receipt (D#)')}</label>
                    <select id="ad-temp-receipt-id" aria-describedby="ad-temp-receipt-hint ad-linked-receipt-help ad-linked-receipt-change" class="w-full min-h-11 border border-slate-200 px-3 py-2 rounded-lg text-sm" onchange="onAdTempReceiptChange(this.value)">
                      <option value="">${isArAd ? 'اختر وصلاً معلقاً...' : 'Select pending receipt...'}</option>
                    </select>
                    <div id="ad-temp-receipt-hint" class="text-xs text-slate-500"></div>
                    <div id="ad-linked-receipt-help" class="hidden text-[11px] text-amber-700 dark:text-amber-300"></div>
                    <div id="ad-linked-receipt-change" role="status" aria-live="polite" class="hidden rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-2 text-[11px] font-medium text-blue-800 dark:text-blue-200"></div>
                    <input type="hidden" id="ad-linked-receipt-id" value="${adData.linkedDeliveryReceiptId || adData.receiptId || ''}" />
                    
                    <!-- Due Amount Usage Section -->
                    <div id="ad-due-amount-section" class="hidden p-3 bg-violet-50 rounded-lg border border-violet-200 space-y-2">
                      <div class="flex items-center justify-between">
                        <span id="ad-due-title" class="text-xs font-semibold text-violet-700">${isArAd ? 'استخدام رصيد من الوصل المستحق' : 'Use Credit from Due Receipt'}</span>
                        <span id="ad-due-available" class="text-xs text-violet-600 font-medium">${isArAd ? 'المتاح: $0.00' : 'Available: $0.00'}</span>
                  </div>
                      <div class="grid grid-cols-2 gap-2">
                        <div>
                          <label id="ad-due-amount-label" class="block text-[10px] text-slate-500 mb-1">${isArAd ? 'الصرف المخطط (USD)' : 'Planned Spend (USD)'}</label>
                          <input type="text" id="ad-due-amount-to-use" inputmode="decimal" class="w-full border border-violet-300 px-3 py-2 rounded-lg text-sm bg-white" placeholder="0.00" oninput="sanitizeMoneyInput(this); onAdDueAmountChange()" onfocus="this.select()" />
                </div>
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-1">${isArAd ? 'استخدام الكل' : 'Use All'}</label>
                          <button type="button" onclick="useAllDueAmount()" class="w-full bg-violet-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-violet-700">
                            ${isArAd ? 'استخدام كامل الرصيد' : 'Use Full Credit'}
                          </button>
                        </div>
                      </div>
                      <div id="ad-due-summary" class="text-[10px] text-slate-500"></div>
                    </div>
                    
                    <!-- Merge with Paid Funds Toggle -->
                    <div id="ad-merge-funds-toggle" class="hidden">
                      <button type="button" onclick="toggleMergePaidFunds()" class="flex items-center gap-2 text-xs text-blue-600 hover:text-blue-700 font-medium">
                        <i data-lucide="plus-circle" class="w-4 h-4" id="ad-merge-icon"></i>
                        <span id="ad-merge-text">${isArAd ? 'إضافة أموال من وصل مدفوع' : 'Add Paid Receipt Funds'}</span>
                      </button>
                    </div>
                    
                    <!-- Merged Paid Funds Section (hidden by default) -->
                    <div id="ad-merged-paid-funds" class="hidden mt-2 p-3 bg-blue-50 rounded-lg border border-blue-200 space-y-2">
                      <div class="flex items-center justify-between">
                        <span class="text-xs font-bold text-blue-700">${isArAd ? 'استخدام أموال وصل مدفوع أيضاً' : 'Also Use Paid Receipt Funds'}</span>
                        <button type="button" onclick="addAdFundingAllocationForMerge()" class="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-blue-700">
                          ${isArAd ? '+ إضافة وصل' : '+ Add Receipt'}
                        </button>
                      </div>
                      <div id="ad-merged-funding-list" class="space-y-2 bg-white rounded-lg p-2 min-h-[40px]">
                        <div class="text-xs text-slate-400 text-center py-1">${isArAd ? 'اضغط "+ إضافة وصل" لاستخدام الأموال المدفوعة' : 'Click "+ Add Receipt" to use paid funds'}</div>
                      </div>
                      <div id="ad-merged-funding-summary" class="text-xs text-blue-600 font-medium"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- UNPAID FINANCIAL -->
            <div id="ad-unpaid-financial" class="${adPaymentState === 'paid' ? 'hidden' : (adPaymentState === 'not_paid' && (adData.collectionMethod === 'driver' || hasLinkedShopReceipt) ? 'hidden' : '')}">
              <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="flex justify-between items-center">
                  <span class="text-xs font-bold text-slate-600">${isArAd ? 'التفاصيل المالية' : 'Financial Details'}</span>
                  <button type="button" onclick="addReceiptPaymentSplit()" class="text-xs text-emerald-600 font-medium">${isArAd ? '+ إضافة تقسيم' : '+ Add Split'}</button>
                </div>
                <div id="receipt-financial-section">
                  ${renderReceiptFinancials(
                    adData.collectionPayments && adData.collectionPayments.length ? adData.collectionPayments : [{
                      // Reconstruct a row that round-trips to the SAME USD credit
                      // as the paid ad. amount = the LYD figure, rate1 = 1,
                      // rate2 = the ad's own rate — so both USD-based and
                      // LYD-based methods recompute amountUSD correctly.
                      // Previously amount=amountUSD with rate2=defaultRate made a
                      // LYD method divide the USD figure by the rate again,
                      // gutting the recorded amount ~10x (audit recheck HIGH #3).
                      method: adData.paymentMethod || PAYMENT_METHODS[0],
                      amount: adData.amountLocal || ((adData.amountUSD || 0) * (adData.exchangeRate || state.defaultExchangeRate || 1)),
                      rate: 1,
                      rate2: adData.exchangeRate || state.defaultExchangeRate,
                      collectionType: 'office',
                      deliveryPersonId: adData.deliveryPersonId || ''
                    }],
                    adData.collectionPayments && adData.collectionPayments.length ? adData.collectionPayments : [{
                      // Reconstruct a row that round-trips to the SAME USD credit
                      // as the paid ad. amount = the LYD figure, rate1 = 1,
                      // rate2 = the ad's own rate — so both USD-based and
                      // LYD-based methods recompute amountUSD correctly.
                      // Previously amount=amountUSD with rate2=defaultRate made a
                      // LYD method divide the USD figure by the rate again,
                      // gutting the recorded amount ~10x (audit recheck HIGH #3).
                      method: adData.paymentMethod || PAYMENT_METHODS[0],
                      amount: adData.amountLocal || ((adData.amountUSD || 0) * (adData.exchangeRate || state.defaultExchangeRate || 1)),
                      rate: 1,
                      rate2: adData.exchangeRate || state.defaultExchangeRate,
                      collectionType: 'office',
                      deliveryPersonId: adData.deliveryPersonId || ''
                    }],
                    deliveryUsers
                  )}
                </div>
              </div>
            </div>

            <!-- SECTION 3: Receipt Funding (PAID ONLY) -->
            <div id="ad-receipt-funding-section" class="${adPaymentState === 'paid' ? '' : 'hidden'} bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl p-4 space-y-3 border border-blue-200 dark:border-blue-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px]">3</span>
                  ${isArAd ? 'تمويل من الوصولات' : 'Receipt Funding'}
                </div>
                <button type="button" onclick="addAdFundingAllocation()" class="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-blue-700">
                  ${isArAd ? '+ إضافة وصل' : '+ Add Receipt'}
                </button>
              </div>
              <div id="ad-driver-settlement-hint" class="hidden p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
                ${isArAd
                  ? `المبلغ المطلوب تسويته: <strong>$${Number(adData.amountUSD || 0).toFixed(2)}</strong>. يجب أن يساوي مجموع الوصولات المدفوعة هذا المبلغ.`
                  : `Amount to settle: <strong>$${Number(adData.amountUSD || 0).toFixed(2)}</strong>. Paid receipt funding must total this amount.`}
              </div>
              <div id="ad-funding-list" class="space-y-2 bg-white dark:bg-slate-900 rounded-lg p-2 min-h-[60px]">
                <div class="text-xs text-slate-400 text-center py-2">${isArAd ? 'اختر صفحة وعميلاً أولاً' : 'Select a page & customer first'}</div>
              </div>
              <div id="ad-funding-change-notice" role="status" aria-live="polite" class="hidden rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-2 text-xs font-medium text-blue-800 dark:text-blue-200"></div>
              <div class="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1">
                <button type="button" onclick="startAdMixedReceiptFunding()" class="w-full flex items-center justify-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:text-amber-800 py-1">
                  <i data-lucide="split" class="w-4 h-4"></i>
                  ${isArAd ? 'استخدام وصل غير مدفوع لتغطية الفرق' : 'Use an Unpaid Receipt for the Difference'}
                </button>
                <p class="text-[10px] text-center text-amber-600 dark:text-amber-400">
                  ${isArAd ? 'إذا كان رصيد الوصل المدفوع أقل من ميزانية الإعلان، سيبقى الفرق ديناً على العميل.' : 'If paid receipt credit is short, only the difference stays as customer debt.'}
                </p>
              </div>
              <div id="ad-funding-summary" class="text-xs text-blue-600 font-medium"></div>
            </div>

            <!-- SECTION 4: Dates -->
            <div class="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-xl p-4 space-y-3 border border-purple-200 dark:border-purple-800">
              <div class="text-xs font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center text-[10px]">4</span>
                ${isArAd ? 'مدة الإعلان' : 'Ad Duration'}
              </div>
              <div class="grid grid-cols-3 gap-2">
                <div>
                  <label class="block text-xs text-slate-500 mb-1">${isArAd ? 'البداية' : 'Start'}</label>
                  <input type="date" id="ad-start-date" value="${Security.escapeHtml(adData.startDate ? adData.startDate.split('T')[0] : getTodayDateString())}" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" onchange="updateAdDays()" />
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1">${isArAd ? 'النهاية' : 'End'}</label>
                  <input type="date" id="ad-end-date" value="${Security.escapeHtml(adData.endDate ? adData.endDate.split('T')[0] : getTodayDateString())}" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" onchange="updateAdDays()" />
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1">${isArAd ? 'الأيام' : 'Days'}</label>
                  <input type="number" id="ad-days" min="0" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(durationDaysDefault || ''))}" oninput="updateAdEndDateFromDays()" />
                </div>
              </div>
            </div>

            <!-- SECTION 5: Photos -->
            <div class="bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-900/20 dark:to-amber-900/20 rounded-xl p-4 space-y-3 border border-orange-200 dark:border-orange-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-orange-600 text-white flex items-center justify-center text-[10px]">5</span>
                  ${isArAd ? 'الصور' : 'Photos'}
                </div>
                ${canModifyAdPhotosInCurrentModal() ? `<label class="text-xs bg-orange-600 text-white px-2 py-1 rounded-lg font-medium cursor-pointer hover:bg-orange-700">
                  ${isArAd ? '+ رفع' : '+ Upload'}
                  <input type="file" accept="image/*" multiple class="hidden" onchange="uploadAdPhotos(this.files)" />
                </label>` : ''}
              </div>
              <div id="ad-photo-previews" class="grid grid-cols-4 gap-2 min-h-[40px] bg-white dark:bg-slate-900 rounded-lg p-2">
                <div class="text-xs text-slate-400 col-span-4 text-center py-2">${isArAd ? 'لا توجد صور بعد' : 'No photos yet'}</div>
              </div>
            </div>

            <!-- SECTION 6: Links -->
            <div class="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-cyan-900/20 dark:to-teal-900/20 rounded-xl p-4 space-y-3 border border-cyan-200 dark:border-cyan-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-cyan-700 dark:text-cyan-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-cyan-600 text-white flex items-center justify-center text-[10px]">6</span>
                  ${isArAd ? 'روابط الإعلان' : 'Ad Links'}
                </div>
                <button type="button" onclick="addAdLinkInput('')" class="text-xs bg-cyan-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-cyan-700">
                  ${isArAd ? '+ إضافة رابط' : '+ Add Link'}
                </button>
              </div>
              <div id="ad-links-list" class="space-y-2">
                ${(adData.adLinks || (adData.adLink ? [adData.adLink] : [''])).map(link => `
                  <div class="ad-link-row flex space-x-2 items-center">
                    <input type="url" class="ad-link-input flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-3 py-2 rounded-lg text-sm" placeholder="https://..." value="${Security.escapeHtml(link || '')}" />
                    <button type="button" class="text-rose-500 hover:text-rose-700 p-1" onclick="this.closest('.ad-link-row').remove()">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  </div>
                `).join('')}
              </div>
            </div>

          </form>

          <!-- FIXED FOOTER -->
          <div class="flex-shrink-0 pt-4 border-t border-slate-200 dark:border-slate-700 flex gap-3">
            <button type="submit" form="modal-form" class="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-4 py-3 rounded-xl font-bold text-sm shadow-lg">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isArAd ? (isEdit ? 'حفظ التغييرات' : 'إنشاء إعلان') : (isEdit ? 'Save Changes' : 'Create Ad')}
            </button>
            <button type="button" onclick="closeModal()" class="px-6 py-3 rounded-xl font-medium text-sm bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200">
              ${isArAd ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </div>
      `;
      break;
    case 'user':
      const userData = state.modalData || {};
      const isAdminEditor = isCurrentUserAdmin();
      const isSelfEdit = isEdit && String(userData.id || '') === String(state.currentUser?.id || '');
      const userPermSummary = isEdit && !isAdminRole(userData.role) ? getPermissionSummary(userData.permissions || {}) : null;
      const isArU = state.language === 'ar';
      modalContent = `
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-lg">
              ${userData.name ? userData.name.charAt(0) : '<i data-lucide="user-plus" class="w-6 h-6"></i>'}
            </div>
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white">${isArU ? (isEdit ? (isSelfEdit ? 'تعديل الملف الشخصي' : 'تعديل مستخدم') : 'إضافة مستخدم جديد') : (isEdit ? (isSelfEdit ? 'Edit Profile' : 'Edit User') : 'Add New User')}</h2>
              <p class="text-xs text-slate-500">${isArU ? (isEdit ? (isSelfEdit ? 'حدّث بيانات ملفك الشخصي' : 'حدّث بيانات المستخدم وصلاحياته') : 'إنشاء حساب مع صلاحيات') : (isEdit ? (isSelfEdit ? 'Update your profile details' : 'Update user details and access') : 'Create account with permissions')}</p>
            </div>
          </div>
          <button type="button" onclick="closeModal()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            <i data-lucide="x" class="w-4 h-4 text-slate-500"></i>
          </button>
        </div>
        
        <form id="modal-form" class="space-y-5">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${isArU ? 'الاسم الكامل *' : 'Full Name *'}</label>
              <input type="text" id="user-name" value="${Security.escapeHtml(userData.name || '')}" required class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="John Doe" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${isArU ? 'البريد الإلكتروني *' : 'Email Address *'}</label>
              <input type="email" id="user-email" value="${Security.escapeHtml(userData.email || '')}" required class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="john@company.com" />
            </div>
          </div>
          
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${isArU ? `كلمة المرور ${isEdit ? '(اتركها فارغة للإبقاء عليها)' : '*'}` : `Password ${isEdit ? '(leave blank to keep)' : '*'}`}</label>
              <input type="password" id="user-password" ${!isEdit ? 'required' : ''} class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="${isEdit ? '••••••••' : (isArU ? '8 أحرف على الأقل' : 'Min. 8 characters')}" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${isArU ? 'الدور *' : 'Role *'}</label>
              <select id="user-role" onchange="updateUserRoleInfo(this.value)" class="w-full glass-input px-4 py-2.5 rounded-xl" ${isAdminEditor ? '' : 'disabled'}>
                ${USER_ROLES.map(r => `<option value="${r}" ${userData.role === r ? 'selected' : ''}>${isArU ? ({ 'Admin': 'أدمن', 'Employee': 'موظف', 'Delivery': 'توصيل' }[r] || r) : r}</option>`).join('')}
              </select>
              ${!isAdminEditor ? `
                <div class="mt-1 text-[11px] text-slate-400">
                  ${state.language === 'ar' ? 'تغيير الدور والصلاحيات للأدمن فقط' : 'Role & permissions can be changed by Admin only'}
                </div>
              ` : ''}
            </div>
          </div>
          
          ${!isEdit && isAdminEditor ? `
            <div class="rounded-xl border border-cyan-200 bg-cyan-50 p-4 dark:border-cyan-800 dark:bg-cyan-900/20">
              <label class="mb-2 block text-xs font-bold uppercase text-cyan-800 dark:text-cyan-200">${isArU ? 'نوع الوصول' : 'Access preset'}</label>
              <select id="user-access-preset" class="glass-input min-h-12 w-full rounded-xl px-4">
                <option value="adsStudioCustomer" ${window._newUserAccessPreset === 'adsStudioCustomer' ? 'selected' : ''}>${isArU ? 'عميل استوديو الإعلانات — يرى حملاته فقط' : 'Ads Studio customer — own campaigns only'}</option>
                <option value="salesAgent" ${window._newUserAccessPreset !== 'adsStudioCustomer' ? 'selected' : ''}>${isArU ? 'موظف مبيعات' : 'Sales employee'}</option>
                <option value="adsStudioReviewer">${isArU ? 'مراجع حملات العملاء' : 'Ads Studio reviewer'}</option>
                <option value="clothesSubscriber">${isArU ? 'مشترك نظام الملابس' : 'Clothes System subscriber'}</option>
                <option value="viewer">${isArU ? 'قراءة فقط' : 'Read only'}</option>
              </select>
              <p class="mt-2 text-xs text-cyan-700 dark:text-cyan-300">${isArU ? 'حساب عميل استوديو الإعلانات لا يحصل على صلاحية الإعلانات الداخلية أو الوصلات أو بيانات العملاء.' : 'An Ads Studio customer receives no access to internal Ads, Receipts, or customer records.'}</p>
            </div>
          ` : ''}

          <!-- Role Info -->
          <div id="role-info" class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="flex items-center space-x-3">
              <div id="role-icon" class="w-10 h-10 rounded-xl flex items-center justify-center ${isAdminRole(userData.role) ? 'bg-amber-100 dark:bg-amber-900/30' : isDeliveryRole(userData.role) ? 'bg-cyan-100 dark:bg-cyan-900/30' : 'bg-emerald-100 dark:bg-emerald-900/30'}">
                <i data-lucide="${isAdminRole(userData.role) ? 'crown' : isDeliveryRole(userData.role) ? 'truck' : 'user-check'}" class="w-5 h-5 ${isAdminRole(userData.role) ? 'text-amber-600' : isDeliveryRole(userData.role) ? 'text-cyan-600' : 'text-emerald-600'}"></i>
              </div>
              <div class="flex-1">
                <div id="role-title" class="font-bold text-sm text-slate-700 dark:text-slate-300">
                  ${isAdminRole(userData.role) ? (isArU ? 'أدمن كامل الصلاحيات' : 'Full Administrator') : isDeliveryRole(userData.role) ? (isArU ? 'سائق توصيل' : 'Delivery Driver') : (isArU ? 'موظف' : 'Employee')}
                </div>
                <div id="role-desc" class="text-xs text-slate-500">
                  ${isAdminRole(userData.role) ? (isArU ? 'وصول كامل لجميع الميزات. بلا قيود.' : 'Complete access to all features. No restrictions.') : isDeliveryRole(userData.role) ? (isArU ? 'وصول لعمليات التوصيل فقط.' : 'Access to delivery operations only.') : (isArU ? 'وصول موظف قياسي. يمكن تخصيص الصلاحيات بعد الإنشاء.' : 'Standard employee access. Customize permissions after creation.')}
                </div>
              </div>
              ${isAdminRole(userData.role) ? `
                <span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">${isArU ? 'وصول كامل' : 'ALL ACCESS'}</span>
              ` : ''}
            </div>
          </div>
          
          ${isEdit && !isAdminRole(userData.role) && userPermSummary ? `
            <!-- Current Permissions Summary -->
            <div class="p-4 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <i data-lucide="shield" class="w-4 h-4 text-purple-600"></i>
                  <span class="text-sm font-bold text-purple-700 dark:text-purple-300">${isArU ? 'الصلاحيات الحالية' : 'Current Permissions'}</span>
                </div>
                <span class="text-xs font-bold text-purple-600">${userPermSummary.granted}/${userPermSummary.total} ${isArU ? 'ممنوحة' : 'granted'}</span>
              </div>
              <div class="w-full h-2 bg-purple-200 dark:bg-purple-800 rounded-full overflow-hidden mb-3">
                <div class="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full" style="width: ${userPermSummary.percentage}%"></div>
              </div>
              ${isAdminEditor ? `
              <button type="button" onclick="closeModal(); setTimeout(() => showPermissionsModal('${userData.id}'), 200)" class="w-full py-2 rounded-lg text-xs font-bold text-purple-600 hover:bg-purple-100 dark:hover:bg-purple-800/30 transition-colors flex items-center justify-center space-x-2">
                <i data-lucide="settings" class="w-3 h-3"></i>
                <span>${isArU ? 'إدارة الصلاحيات التفصيلية' : 'Manage Detailed Permissions'}</span>
              </button>
              ` : `
                <div class="text-[11px] text-slate-500 text-center">
                  ${state.language === 'ar' ? 'الصلاحيات لا يمكن تعديلها إلا بواسطة الأدمن' : 'Permissions can only be changed by Admin'}
                </div>
              `}
            </div>
          ` : !isEdit ? `
            <!-- New User Permission Info -->
            <div class="p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
              <div class="flex items-start space-x-3">
                <i data-lucide="info" class="w-5 h-5 text-blue-600 mt-0.5"></i>
                <div>
                  <div class="text-sm font-bold text-blue-700 dark:text-blue-300">${isArU ? 'إعداد الصلاحيات' : 'Permissions Setup'}</div>
                  <p class="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    ${isArU ? 'بعد إنشاء هذا المستخدم، يمكنك ضبط صلاحياته التفصيلية. سيتم تعيين صلاحيات افتراضية حسب دوره.' : `After creating this user, you'll be able to configure their detailed permissions. Default permissions will be assigned based on their role.`}
                  </p>
                </div>
              </div>
            </div>
          ` : ''}
          
          <div class="flex space-x-3 pt-2">
            <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="${isEdit ? 'save' : 'user-plus'}" class="w-4 h-4"></i>
              <span>${isArU ? (isEdit ? 'حفظ التغييرات' : 'إنشاء مستخدم') : (isEdit ? 'Save Changes' : 'Create User')}</span>
            </button>
            <button type="button" onclick="closeModal()" class="px-6 py-3 bg-slate-200 dark:bg-slate-700 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">${isArU ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </form>
      `;
      break;
    case 'page':
      const pageData = state.modalData || {};
      const pageCustomers = getVisibleRecords(state.customers);
      const existingCustomerIds = pageData.customerIds || [];
      const isAdminPage = isAdminRole(state.currentUser?.role);
      const isArP = state.language === 'ar';

      if (pageCustomers.length === 0) {
        modalContent = `
          <h2 class="text-2xl font-bold mb-4">${isArP ? 'إضافة صفحة' : 'Add Page'}</h2>
          <div class="text-center py-8">
            <i data-lucide="alert-circle" class="w-12 h-12 mx-auto text-amber-500 mb-4"></i>
            <p class="text-slate-600 dark:text-slate-400 mb-4">${isArP ? 'لا يوجد عملاء. الرجاء إضافة عميل أولاً.' : 'No customers found. Please add a customer first.'}</p>
            <button onclick="closeModal(); navigateTo('customers')" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">${isArP ? 'الذهاب إلى العملاء' : 'Go to Customers'}</button>
          </div>
        `;
      } else {
      modalContent = `
        <h2 class="text-2xl font-bold mb-4">${isArP ? (isEdit ? 'تعديل صفحة' : 'إضافة صفحة') : `${isEdit ? 'Edit' : 'Add'} Page`}</h2>
        <form id="modal-form" class="space-y-4">
          <div>
              <label class="block text-sm font-medium mb-2">${isArP ? 'اسم الصفحة *' : 'Page Name *'}</label>
            <input type="text" id="page-name" value="${Security.escapeHtml(pageData.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>
          <div>
              <label class="block text-sm font-medium mb-2">${isArP ? 'الفئة *' : 'Category *'}</label>
            <input type="text" id="page-category" list="page-category-suggestions" autocomplete="off" value="${Security.escapeHtml(pageData.category || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" />
            <!-- Suggest previously-used categories while typing (user request):
                 picking an existing one avoids near-duplicate categories like
                 "cars" / "car". Deduped case-insensitively, first spelling wins. -->
            <datalist id="page-category-suggestions">
              ${(() => {
                const seen = new Map();
                getVisibleRecords(state.pages || []).forEach(p => {
                  const c = String(p.category || '').trim();
                  if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
                });
                return [...seen.values()].sort((a, b) => a.localeCompare(b))
                  .map(c => `<option value="${Security.escapeHtml(c)}"></option>`).join('');
              })()}
            </datalist>
          </div>
            
            <!-- Customer Linking Section -->
            <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
              <div class="flex items-center space-x-2 mb-3">
                <i data-lucide="users" class="w-4 h-4 text-blue-600"></i>
                <label class="text-sm font-bold text-blue-900 dark:text-blue-100">${isArP ? 'ربط بعميل (أو عملاء) *' : 'Link to Customer(s) *'}</label>
              </div>
              
              ${!isAdminPage ? `
                <div class="mb-3 p-2 bg-amber-100 dark:bg-amber-900/20 rounded-lg">
                  <p class="text-xs text-amber-800 dark:text-amber-200">
                    <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
                    ${isArP ? 'يمكنك ربط الصفحة بعميل واحد فقط' : 'You can only link a page to one customer'}
                  </p>
                </div>
              ` : ''}
              
              <div class="relative mb-3">
                <input 
                  type="text" 
                  id="page-customer-search" 
                  placeholder="${isArP ? 'ابحث عن عميل...' : 'Search for customer...'}"
                  class="w-full glass-input px-4 py-2 rounded-xl"
                  oninput="filterPageCustomers()"
                  onfocus="showPageCustomerDropdown()"
                />
                <div id="page-customer-dropdown" class="absolute z-20 mt-1 w-full glass-panel rounded-lg shadow-xl max-h-60 overflow-y-auto hidden">
                  ${pageCustomers.map(c => `
                    <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" data-record-action="select-page-customer" data-record-id="${Security.escapeHtml(String(c.id || ''))}" data-admin="${isAdminPage}">
                      <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
                      <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || (isArP ? 'لا يوجد هاتف' : 'No phone'))}</div>
                    </div>
                  `).join('')}
                </div>
              </div>
              
              <div id="page-selected-customers" class="space-y-2">
                ${existingCustomerIds.map(cid => {
                  const customer = state.customers.find(c => c.id === cid);
                  return customer ? `
                    <div class="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-lg border border-indigo-200 dark:border-indigo-800 page-customer-item" data-customer-id="${Security.escapeHtml(String(cid || ''))}">
                      <div>
                        <div class="font-medium text-sm text-slate-800 dark:text-white">${Security.escapeHtml(customer.name || '')}</div>
                        <div class="text-xs text-slate-500">${Security.escapeHtml(customer.platform || '')}</div>
                      </div>
                      <button type="button" data-record-action="remove-page-customer" data-record-id="${Security.escapeHtml(String(cid || ''))}" class="text-rose-500 hover:text-rose-700">
                        <i data-lucide="x-circle" class="w-4 h-4"></i>
                      </button>
                    </div>
                  ` : '';
                }).join('')}
                <div id="page-no-customers" class="${existingCustomerIds.length > 0 ? 'hidden' : ''} text-sm text-slate-400 text-center py-4 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                  ${isArP ? 'لم يتم اختيار عملاء بعد. الرجاء البحث واختيار عميل واحد على الأقل أعلاه.' : 'No customers selected yet. Please search and select at least one customer above.'}
                </div>
              </div>
              
                ${isAdminPage ? `
                <div id="page-multi-customer-warning" class="hidden mt-3 p-3 bg-rose-50 dark:bg-rose-900/20 rounded-lg border border-rose-200 dark:border-rose-800">
                  <div class="flex items-start space-x-2">
                    <i data-lucide="alert-triangle" class="w-4 h-4 text-rose-600 mt-0.5"></i>
                    <div>
                      <p class="text-xs font-bold text-rose-900 dark:text-rose-100">${isArP ? 'تحذير: عدة عملاء' : 'Warning: Multiple Customers'}</p>
                      <p class="text-xs text-rose-700 dark:text-rose-300 mt-1">${isArP ? 'هذه الصفحة مرتبطة بعدة عملاء. هذا غير شائع وقد يسبب التباساً. هل أنت متأكد أن هذا ما تريده؟' : 'This page is linked to multiple customers. This is uncommon and may cause confusion. Are you sure this is what you want?'}</p>
                    </div>
                  </div>
                </div>
              ` : ''}
            </div>
            
          <div class="flex space-x-3">
            <button type="submit" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">${isArP ? (isEdit ? 'حفظ التغييرات' : 'إنشاء صفحة') : (isEdit ? 'Save Changes' : 'Create Page')}</button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold">${isArP ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </form>
      `;
      }
      break;
    case 'receipt':
      const receiptCustomers = getCustomersVisibleToCurrentUser();
      const receiptData = state.modalData || {};
      const isAdminReceipt = isCurrentUserAdmin();
      const defaultRate1 = getDefaultRate1(PAYMENT_METHODS[0]);
      const existingPayments = receiptData.payments || [{ method: PAYMENT_METHODS[0], amount: 0, rate: defaultRate1, rate2: state.defaultExchangeRate, collectionType: 'office', deliveryPersonId: '' }];
      const receiptDeliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      const isArR = state.language === 'ar';
      // Copy (not alias) the live record's photos so add/remove in the modal
      // does not mutate the saved receipt when the user cancels.
      _receiptPhotoUploadGeneration++;
      _receiptPhotoUploadsInFlight = 0;
      state.tempReceiptPhotos = getReceiptPhotoSources(receiptData);
      state.tempReceiptPhotosDirty = false;
      
      if (receiptCustomers.length === 0) {
        modalContent = `
          <h2 class="text-2xl font-bold mb-4">${isArR ? 'إضافة وصل' : 'Add Receipt'}</h2>
          <div class="text-center py-8">
            <i data-lucide="alert-circle" class="w-12 h-12 mx-auto text-amber-500 mb-4"></i>
            <p class="text-slate-600 dark:text-slate-400 mb-4">${isArR ? 'لا يوجد عملاء. الرجاء إضافة عميل أولاً.' : 'No customers found. Please add a customer first.'}</p>
            <button onclick="closeModal(); navigateTo('customers')" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">${isArR ? 'الذهاب إلى العملاء' : 'Go to Customers'}</button>
          </div>
        `;
      } else {
        // Build phone list for search
        const phoneCustomerMap = [];
        receiptCustomers.forEach(c => {
          c.phones.forEach(phone => {
            phoneCustomerMap.push({ phone, customer: c });
          });
        });
        
        modalContent = `
          <div class="space-y-3 max-h-[75vh] overflow-y-auto custom-scrollbar pr-1">
            <!-- The record this form edits, FROZEN at render time. Save reads
                 THIS, not the mutable global state.modalData, so a stray
                 browser-back/refresh that reloads a different receipt into
                 state.modalData can never redirect this save onto the wrong
                 record. Empty value = create a brand-new receipt. -->
            <input type="hidden" id="receipt-editing-id" value="${Security.escapeHtml(String(receiptData.id || ''))}" />
            ${(_newReceiptCarried && !receiptData.id) ? `
            <!-- Existing-balance mode: same full form, only tagged on save. -->
            <div class="p-3 rounded-lg" style="background:#fffbeb;border:1px solid #fcd34d">
              <div class="flex items-center gap-2 text-sm font-extrabold" style="color:#b45309">
                <i data-lucide="history" class="w-4 h-4"></i>
                ${isArR ? 'رصيد سابق' : 'Existing Balance'}
              </div>
              <div class="text-xs mt-1" style="color:#92400e">
                ${isArR
                  ? 'أدخل المبلغ المتبقّي لعميلٍ استهلك جزءاً من رصيده سابقاً. يُحتسب كإيراد ويمكنه تمويل الإعلانات.'
                  : "Enter the customer's REMAINING amount (they already used part of their balance elsewhere). It counts as revenue and can fund ads."}
              </div>
            </div>
            ` : ''}
            <!-- Phone Search Section -->
            <div class="receipt-phone-search grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2 flex items-center">
                  <i data-lucide="phone" class="w-3 h-3 mr-1"></i>
                  ${isArR ? 'بحث برقم الهاتف...' : 'Search phone...'}
                </label>
                <input
                  type="text"
                  id="receipt-phone-search"
                  placeholder="${isArR ? 'اكتب رقم الهاتف...' : 'Type phone number...'}"
                  class="w-full glass-input px-3 py-2 rounded-lg text-sm"
                  oninput="filterReceiptPhones()"
                  onfocus="showReceiptPhoneDropdown()"
                />
                <div id="receipt-phone-dropdown" class="absolute z-20 mt-1 w-full sm:w-80 max-w-[calc(100vw-2rem)] glass-panel rounded-lg shadow-xl max-h-40 overflow-y-auto hidden">
                  ${phoneCustomerMap.map(item => `
                    <div class="touch-target px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer phone-option" role="button" tabindex="0" data-phone="${Security.escapeHtml(item.phone)}" data-customer-id="${Security.escapeHtml(item.customer.id)}" onclick="selectReceiptPhone(this.dataset.phone, this.dataset.customerId)" onkeydown="if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); selectReceiptPhone(this.dataset.phone, this.dataset.customerId); }">
                      <div class="text-sm font-medium">${Security.escapeHtml(item.phone)}</div>
                      <div class="text-xs text-slate-500">${Security.escapeHtml(item.customer.name)} - ${Security.escapeHtml(item.customer.platform)}</div>
                    </div>
                  `).join('')}
                </div>
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2">${isArR ? 'اختر الهاتف أولاً...' : 'Select phone first...'}</label>
                <input type="text" id="receipt-customer-name" readonly class="w-full glass-input px-3 py-2 rounded-lg text-sm bg-slate-100 dark:bg-slate-800" placeholder="${isArR ? 'سيظهر العميل هنا' : 'Customer will appear here'}" />
                <input type="hidden" id="receipt-customer-id" value="${receiptData.customerId || ''}" />
              </div>
            </div>

            <!-- Receipt Number -->
            <div class="px-1">
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5">${isArR ? 'رقم الوصل' : 'Receipt Number'}</label>
              <input type="text" id="receipt-serial" value="${receiptData.serialNumber || receiptData.finalReceiptNo || receiptData.tempReceiptNo || ''}" 
                class="w-full glass-input px-3 py-2 rounded-lg text-sm" 
                placeholder="${isArR ? 'مثال: 12345' : 'e.g., 12345'}"
                oninput="validateReceiptNumberInput(this)"
                onblur="checkReceiptNumberDuplicate(this)" />
              <div id="receipt-serial-error" class="hidden mt-1 text-xs text-rose-500 font-medium"></div>
              <div id="receipt-temp-hint" class="hidden mt-1 text-xs text-indigo-600 font-medium"></div>
            </div>

            <!-- Status Tabs -->
            <div class="px-1">
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5">${isArR ? 'الحالة' : 'Status'}</label>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5" id="receipt-status-tabs">
                <button type="button" onclick="setReceiptStatus(this, 'Paid')" class="receipt-status-btn px-2 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all ${!receiptData.status || receiptData.status === 'Paid' ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Paid">${trStatus('Paid')}</button>
                <button type="button" onclick="setReceiptStatus(this, 'Not Paid')" class="receipt-status-btn px-2 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Not Paid' ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Not Paid">${isArR ? 'غير مدفوع' : 'Not Paid'}</button>
                <button type="button" onclick="setReceiptStatus(this, 'Canceled')" class="receipt-status-btn px-2 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Canceled' ? 'bg-rose-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Canceled">${isArR ? 'ملغي' : 'Canceled'}</button>
                <button type="button" onclick="setReceiptStatus(this, 'Lost')" class="receipt-status-btn px-2 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Lost' ? 'bg-slate-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Lost">${isArR ? 'مفقود' : 'Lost'}</button>
              </div>
              <input type="hidden" id="receipt-status" value="${receiptData.status || 'Paid'}" />

              <!-- Paid controls -->
              <div id="status-paid" class="${(!receiptData.status || receiptData.status === 'Paid') ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-blue-200 dark:border-blue-800 bg-gradient-to-br from-blue-50 via-indigo-50 to-cyan-50 dark:from-blue-900/40 dark:via-indigo-900/30 dark:to-cyan-900/20 shadow-lg space-y-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30">
                      <i data-lucide="check-circle-2" class="w-5 h-5 text-white"></i>
                    </span>
                    <div>
                      <div class="text-sm font-bold text-blue-900 dark:text-blue-100">${isArR ? 'تم تحصيل الدفع' : 'Payment Collected'}</div>
                      <div class="text-xs text-blue-600/80 dark:text-blue-300/80">${isArR ? 'اختر كيف تم تحصيل الدفع' : 'Choose how the payment was collected'}</div>
                    </div>
                  </div>
                </div>

                <input type="hidden" id="paid-collection-value" value="${receiptData.statusDetail?.paidCollection || 'office'}" />

                <div class="grid grid-cols-2 gap-3">
                  <button type="button" onclick="selectPaidCollection('office')" class="paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-lg'}" data-value="office">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'bg-white/20' : 'bg-gradient-to-br from-blue-100 to-indigo-200 dark:from-blue-900/50 dark:to-indigo-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="store" class="w-6 h-6 ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white' : 'text-blue-600 dark:text-blue-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'في المكتب' : 'In Office'}</div>
                        <div class="text-[10px] ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">${isArR ? 'تم الدفع في المحل/المكتب' : 'Paid in shop/office'}</div>
                      </div>
                    </div>
                  </button>

                  <button type="button" onclick="selectPaidCollection('delivery')" class="paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="delivery">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="truck" class="w-6 h-6 ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'عبر التوصيل' : 'By Delivery'}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">${isArR ? 'السائق حصّل الدفع' : 'Driver collected payment'}</div>
                      </div>
                    </div>
                  </button>
                </div>

                <div id="paid-delivery-person-section" class="${receiptData.statusDetail?.paidCollection === 'delivery' ? '' : 'hidden'} mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                  <label class="block text-xs font-bold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center space-x-2">
                    <i data-lucide="user-check" class="w-4 h-4"></i>
                    <span>${isArR ? 'موظف التوصيل (اختياري)' : 'Delivery Person (optional)'}</span>
                  </label>
                  <select id="paid-delivery-person" class="w-full glass-input px-3 py-2 rounded-lg text-sm border border-emerald-200 dark:border-emerald-700 focus:ring-2 focus:ring-emerald-500/20">
                    <option value="">${isArR ? 'اختر موظف التوصيل...' : 'Select delivery person...'}</option>
                    ${getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role)).map(u =>
                      `<option value="${u.id}" ${receiptData.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`
                    ).join('')}
                  </select>
                </div>
              </div>

              <!-- Not Paid controls -->
              <div id="status-not-paid" class="${receiptData.status === 'Not Paid' ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-amber-200 dark:border-amber-700 bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50 dark:from-amber-900/40 dark:via-yellow-900/30 dark:to-orange-900/20 shadow-lg space-y-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg shadow-amber-500/30">
                      <i data-lucide="clock" class="w-5 h-5 text-white"></i>
                    </span>
                    <div>
                      <div class="text-sm font-bold text-amber-900 dark:text-amber-100">${isArR ? 'الدفع معلّق' : 'Payment Pending'}</div>
                      <div class="text-xs text-amber-600/80 dark:text-amber-300/80 flex items-center space-x-1">
                        <i data-lucide="lock" class="w-3 h-3"></i>
                        <span>${isArR ? 'رقم الوصل مقفل حتى يتم الدفع' : 'Receipt # locked until paid'}</span>
              </div>
                </div>
                  </div>
                  ${isAdminReceipt ? `
                    <label class="flex items-center space-x-2 px-3 py-2 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-amber-200 dark:border-amber-700 cursor-pointer hover:bg-white dark:hover:bg-slate-800 transition-all">
                      <input type="checkbox" id="status-not-paid-admin-override" class="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500" onchange="updateReceiptStatusUI('Not Paid')" ${receiptData.statusDetail?.allowSerialOverride ? 'checked' : ''}/>
                      <span class="text-xs font-bold text-amber-800 dark:text-amber-200">${isArR ? 'تجاوز الأدمن' : 'Admin Override'}</span>
                    </label>
                  ` : ''}
                      </div>

                <div class="pt-3 border-t border-amber-200/60 dark:border-amber-700/40">
                  <div class="text-xs font-bold text-amber-800 dark:text-amber-200 mb-3 flex items-center space-x-2">
                    <i data-lucide="map-pin" class="w-3 h-3"></i>
                    <span>${isArR ? 'كيف سيدفع العميل؟' : 'How will customer pay?'}</span>
                  </div>
                  <input type="hidden" id="notpaid-collection-value" value="${receiptData.statusDetail?.notPaidCollection || 'office'}" />
                        <div class="grid grid-cols-2 gap-3">
                    <button type="button" onclick="selectNotPaidCollection('office')" class="notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-lg'}" data-value="office">
                      <div class="flex flex-col items-center space-y-2">
                        <span class="w-12 h-12 rounded-2xl ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'bg-white/20' : 'bg-gradient-to-br from-blue-100 to-indigo-200 dark:from-blue-900/50 dark:to-indigo-900/50'} flex items-center justify-center shadow-inner">
                          <i data-lucide="store" class="w-6 h-6 ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white' : 'text-blue-600 dark:text-blue-400'}"></i>
                        </span>
                          <div>
                          <div class="font-bold text-sm ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'في المحل' : 'In Shop'}</div>
                          <div class="text-[10px] ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">${isArR ? 'العميل يزور المكتب' : 'Customer visits office'}</div>
                          </div>
                      </div>
                    </button>
                    <button type="button" onclick="selectNotPaidCollection('delivery')" class="notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="delivery">
                      <div class="flex flex-col items-center space-y-2">
                        <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                          <i data-lucide="truck" class="w-6 h-6 ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                        </span>
                          <div>
                          <div class="font-bold text-sm ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'توصيل' : 'Delivery'}</div>
                          <div class="text-[10px] ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">${isArR ? 'السائق يحصّل الدفع' : 'Driver collects payment'}</div>
                        </div>
                      </div>
                    </button>
                  </div>
                  
                  <!-- Delivery Person Selection (shown when Delivery is selected) -->
                  <div id="notpaid-delivery-person-section" class="${receiptData.statusDetail?.notPaidCollection === 'delivery' ? '' : 'hidden'} mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                    <label class="block text-xs font-bold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center space-x-2">
                      <i data-lucide="user-check" class="w-4 h-4"></i>
                      <span>${isArR ? 'تعيين موظف التوصيل' : 'Assign Delivery Person'}</span>
                    </label>
                    <select id="notpaid-delivery-person" class="w-full glass-input px-3 py-2 rounded-lg text-sm border border-emerald-200 dark:border-emerald-700 focus:ring-2 focus:ring-emerald-500/20">
                      <option value="">${isArR ? 'اختر موظف التوصيل...' : 'Select delivery person...'}</option>
                      ${getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role)).map(u => 
                        `<option value="${u.id}" ${receiptData.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`
                      ).join('')}
                    </select>
                  </div>

                  <!-- Delivery Info (Required for Temp Delivery Receipts) -->
                  <div id="receipt-delivery-info" class="hidden mt-3 p-3 rounded-xl bg-white/70 dark:bg-slate-800/60 border border-emerald-200 dark:border-emerald-800 space-y-3">
                    <div class="text-xs font-bold text-emerald-700 dark:text-emerald-300 flex items-center space-x-2">
                      <i data-lucide="map-pin" class="w-4 h-4"></i>
                      <span>${isArR ? 'معلومات التوصيل (مطلوبة)' : 'Delivery Info (Required)'}</span>
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">${isArR ? 'اسم المكان *' : 'Place name *'}</label>
                      <input type="text" id="receipt-delivery-place" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="${isArR ? 'الحي / العنوان / الوجهة' : 'Neighborhood / address / destination'}" value="${Security.escapeHtml(receiptData.deliveryPlaceName || '')}" maxlength="200" />
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">${isArR ? 'سعر التوصيل المتفق عليه (دينار) *' : 'Quoted delivery fee (LYD) *'}</label>
                      <input type="text" inputmode="decimal" id="receipt-quoted-delivery-fee" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${(receiptData.quotedDeliveryFee ?? '')}" oninput="sanitizeMoneyInput(this)" />
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">${isArR ? 'تعليمات (اختياري)' : 'Instructions (optional)'}</label>
                      <textarea id="receipt-delivery-instructions" rows="2" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="${isArR ? 'معالم، ملاحظات...' : 'Landmarks, notes...'}">${Security.escapeHtml(receiptData.deliveryInstructions || '')}</textarea>
                    </div>
                  </div>
                          </div>
                        </div>

              <!-- Canceled controls -->
              <div id="status-canceled" class="${receiptData.status === 'Canceled' ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-rose-200 dark:border-rose-800 bg-gradient-to-br from-rose-50 via-pink-50 to-orange-50 dark:from-rose-900/40 dark:via-pink-900/30 dark:to-orange-900/20 shadow-lg space-y-4">
                <div class="flex items-center space-x-3">
                  <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 shadow-lg shadow-rose-500/30">
                    <i data-lucide="rotate-ccw" class="w-5 h-5 text-white"></i>
                  </span>
                          <div>
                    <div class="text-sm font-bold text-rose-900 dark:text-rose-100">${isArR ? 'ماذا حدث؟' : 'What happened?'}</div>
                    <div class="text-xs text-rose-600/80 dark:text-rose-300/80">${isArR ? 'اختر نتيجة الإلغاء' : 'Choose the cancellation outcome'}</div>
                          </div>
                          </div>
                <input type="hidden" id="status-cancel-refund-action" value="${receiptData.statusDetail?.refundAction || ''}" />
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" onclick="selectCancelOption('full')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'full' ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700 hover:shadow-md'}" data-value="full">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'full' ? 'bg-white/20' : 'bg-emerald-100 dark:bg-emerald-900/40'} flex items-center justify-center">
                        <i data-lucide="banknote" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                          <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'استرجاع كامل' : 'Full Refund'}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white/80' : 'text-slate-500'}">${isArR ? 'إرجاع كل المال' : 'Return all money'}</div>
                          </div>
                          </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('partial')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'partial' ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-amber-300 dark:hover:border-amber-700 hover:shadow-md'}" data-value="partial">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'partial' ? 'bg-white/20' : 'bg-amber-100 dark:bg-amber-900/40'} flex items-center justify-center">
                        <i data-lucide="pie-chart" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white' : 'text-amber-600 dark:text-amber-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'استرجاع جزئي' : 'Partial Refund'}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white/80' : 'text-slate-500'}">${isArR ? 'إرجاع جزء من المال' : 'Return some money'}</div>
                        </div>
                    </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('forgiven')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-violet-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md'}" data-value="forgiven">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'bg-white/20' : 'bg-violet-100 dark:bg-violet-900/40'} flex items-center justify-center">
                        <i data-lucide="heart-handshake" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white' : 'text-violet-600 dark:text-violet-400'}"></i>
                      </span>
                        <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'متسامَح عنه' : 'Forgiven'}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white/80' : 'text-slate-500'}">${isArR ? 'لا حاجة لاسترجاع' : 'No refund needed'}</div>
                          </div>
                        </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('undecided')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'undecided' ? 'bg-gradient-to-r from-slate-500 to-slate-600 text-white shadow-lg shadow-slate-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600 hover:shadow-md'}" data-value="undecided">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'undecided' ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center">
                        <i data-lucide="clock" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white' : 'text-slate-600 dark:text-slate-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'غير محسوم' : 'Undecided'}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white/80' : 'text-slate-500'}">${isArR ? 'يُقرر لاحقاً' : 'Decide later'}</div>
                      </div>
                    </div>
                  </button>
                </div>
                <div id="cancel-refund-status-section" class="${(receiptData.status === 'Canceled' && (receiptData.statusDetail?.refundAction === 'full' || receiptData.statusDetail?.refundAction === 'partial')) ? '' : 'hidden'} pt-3 border-t border-rose-200 dark:border-rose-800/50 space-y-2">
                  <div class="text-xs font-bold text-rose-800 dark:text-rose-200 flex items-center space-x-2">
                    <i data-lucide="loader" class="w-3 h-3"></i>
                    <span>${isArR ? 'حالة الاسترجاع' : 'Refund Progress'}</span>
              </div>
                  <input type="hidden" id="status-cancel-refund-status" value="${receiptData.statusDetail?.refundStatus || 'pending'}" />
                  <div class="flex space-x-2">
                    <button type="button" onclick="selectRefundStatus('pending')" class="refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300 ${receiptData.statusDetail?.refundStatus !== 'refunded' ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30' : 'bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-amber-300'}" data-value="pending">
                      <i data-lucide="hourglass" class="w-4 h-4 inline mr-1.5"></i>${trStatus('Pending')}
                    </button>
                    <button type="button" onclick="selectRefundStatus('refunded')" class="refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300 ${receiptData.statusDetail?.refundStatus === 'refunded' ? 'bg-gradient-to-r from-emerald-400 to-green-500 text-white shadow-lg shadow-emerald-500/30' : 'bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-emerald-300'}" data-value="refunded">
                      <i data-lucide="check-circle" class="w-4 h-4 inline mr-1.5"></i>${isArR ? 'تم الاسترجاع' : 'Refunded'}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Lost controls -->
              <div id="status-lost" class="${receiptData.status === 'Lost' ? '' : 'hidden'} mt-3 p-4 rounded-2xl border-2 border-indigo-200 dark:border-indigo-800 bg-gradient-to-br from-indigo-50 via-blue-50 to-cyan-50 dark:from-indigo-900/40 dark:via-blue-900/30 dark:to-cyan-900/20 shadow-lg space-y-4">
                <div class="flex items-center space-x-3">
                  <span class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-500/30">
                    <i data-lucide="help-circle" class="w-5 h-5 text-white"></i>
                  </span>
                  <div>
                    <div class="text-sm font-bold text-indigo-900 dark:text-indigo-100">${isArR ? 'ما هو الوضع؟' : "What's the situation?"}</div>
                    <div class="text-xs text-indigo-600/80 dark:text-indigo-300/80">${isArR ? 'هل كان هذا الوصل مدفوعاً أم فارغاً؟' : 'Was this receipt paid or empty?'}</div>
                  </div>
                </div>
                <input type="hidden" id="status-lost-resolution" value="${receiptData.statusDetail?.lostResolution || ''}" />
                <div class="grid grid-cols-2 gap-3">
                  <button type="button" onclick="selectLostOption('empty')" class="lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.lostResolution === 'empty' ? 'bg-gradient-to-br from-slate-600 to-slate-700 text-white shadow-xl shadow-slate-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500 hover:shadow-lg'}" data-value="empty">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.lostResolution === 'empty' ? 'bg-white/20' : 'bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-800'} flex items-center justify-center shadow-inner">
                        <i data-lucide="inbox" class="w-6 h-6 ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white' : 'text-slate-500 dark:text-slate-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${isArR ? 'فارغ' : 'Empty'}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">${isArR ? 'لم يُستلم أي دفع' : 'No payment received'}</div>
                      </div>
                    </div>
                  </button>
                  <button type="button" onclick="selectLostOption('paid')" class="lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.lostResolution === 'paid' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="paid">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.lostResolution === 'paid' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="wallet" class="w-6 h-6 ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">${trStatus('Paid')}</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">${isArR ? 'الوصل فُقد' : 'Receipt was lost'}</div>
                      </div>
                    </div>
                  </button>
                </div>
                </div>
                </div>

            <!-- Financial Details Section -->
            <div class="px-1">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center space-x-2">
                  <i data-lucide="wallet" class="w-4 h-4 text-slate-600 dark:text-slate-400"></i>
                  <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">${isArR ? 'التفاصيل المالية' : 'Financial Details'}</h3>
                </div>
                <button type="button" onclick="addReceiptPaymentSplit()" class="text-emerald-600 hover:text-emerald-700 text-xs font-bold flex items-center space-x-1">
                  <i data-lucide="plus-circle" class="w-3 h-3"></i>
                  <span>${isArR ? 'إضافة تقسيم' : 'Add Split'}</span>
                </button>
              </div>

              <!-- Payment Methods Label -->
              <div class="mb-2">
                <label class="text-[10px] font-bold text-slate-500 uppercase">${isArR ? 'طرق الدفع' : 'Payment Methods'}</label>
                </div>

              <!-- Dynamic Financial Content -->
              <div id="receipt-financial-section">
                ${renderReceiptFinancials(existingPayments, existingPayments, receiptDeliveryUsers)}
                </div>
            </div>

            <!-- Photos -->
            <div class="px-1">
              <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="flex items-center justify-between">
                  <label class="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center space-x-1">
                    <i data-lucide="image" class="w-3 h-3"></i>
                    <span>${isArR ? 'الصور' : 'Photos'}</span>
                  </label>
                  <label class="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center space-x-1 cursor-pointer">
                    <i data-lucide="upload" class="w-3 h-3"></i><span>${isArR ? 'إضافة صورة' : 'Add Photo'}</span>
                    <input type="file" accept="image/*" multiple class="hidden" onchange="uploadReceiptPhotos(this.files)" />
                  </label>
                </div>
                <div id="receipt-photo-previews" class="grid grid-cols-4 gap-2"></div>
              </div>
            </div>

            <!-- Action Buttons -->
            <div class="flex space-x-2 px-1 pt-3 border-t border-slate-200 dark:border-slate-700">
              <button type="button" onclick="saveReceiptFromModal()" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-purple-700">
                <i data-lucide="check" class="w-4 h-4 inline mr-1.5"></i>${isArR ? (isEdit ? 'حفظ' : 'إنشاء') : (isEdit ? 'Save' : 'Create')}
              </button>
              <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">${isArR ? 'إلغاء' : 'Cancel'}</button>
            </div>
          </div>
        `;
      }
      break;
    case 'receipt-transfer':
      const transferReceipt = state.modalData;
      const transferCustomers = getVisibleRecords(state.customers).filter(c => c.id !== transferReceipt.customerId);
      const transferUsage = getReceiptUsageStats(transferReceipt);
      const availableUSD = transferUsage.remainingUSD;
      const isArT = state.language === 'ar';
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="swap" class="w-6 h-6 mr-2 text-blue-600"></i>
          ${isArT ? 'تحويل رصيد الوصل' : 'Transfer Receipt Balance'}
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
            <div class="text-xs text-slate-500 mb-1">${isArT ? 'الرصيد المتاح' : 'Available Balance'}</div>
            <div class="text-lg font-bold text-blue-700 dark:text-blue-200">$${availableUSD.toFixed(2)} USD</div>
            <div class="text-xs text-slate-500">~ ${(availableUSD * (transferReceipt.exchangeRate || state.defaultExchangeRate || 1)).toFixed(2)} LYD</div>
          </div>

          ${transferCustomers.length === 0 ? `
            <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-200 text-sm">
              ${isArT ? 'لا يوجد عملاء آخرون للتحويل إليهم. الرجاء إضافة عميل آخر أولاً.' : 'No other customers available to transfer to. Please add another customer first.'}
                </div>
          ` : `
            <div>
              <label class="block text-sm font-medium mb-2">${isArT ? 'التحويل إلى العميل *' : 'Transfer to Customer *'}</label>
              <select id="transfer-target-customer" class="w-full glass-input px-4 py-2 rounded-xl">
                <option value="">${isArT ? 'اختر العميل' : 'Select customer'}</option>
                ${transferCustomers.map(c => `<option value="${c.id}">${Security.escapeHtml(c.name || '')}</option>`).join('')}
              </select>
                </div>
            <div>
              <label class="block text-sm font-medium mb-2">${isArT ? 'المبلغ (USD) *' : 'Amount (USD) *'}</label>
              <input type="text" inputmode="decimal" id="transfer-amount-usd" value="${availableUSD.toFixed(2)}" class="w-full glass-input px-4 py-2 rounded-xl" min="0" max="${availableUSD.toFixed(2)}" oninput="sanitizeMoneyInput(this)" />
              <p class="text-xs text-slate-500 mt-1">${isArT ? 'المتاح:' : 'Available:'} $${availableUSD.toFixed(2)}</p>
              </div>
            <div>
              <label class="block text-sm font-medium mb-2">${isArT ? 'ملاحظة (اختياري)' : 'Note (optional)'}</label>
              <textarea id="transfer-note" class="w-full glass-input px-4 py-2 rounded-xl" rows="3" placeholder="${isArT ? 'لماذا تقوم بالتحويل؟' : 'Why are you transferring?'}"></textarea>
            </div>
          `}

          ${transferReceipt.transfers && transferReceipt.transfers.length > 0 ? `
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
              <div class="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2 flex items-center space-x-1">
                <i data-lucide="history" class="w-3 h-3"></i><span>${isArT ? 'سجل التحويلات' : 'Transfer History'}</span>
              </div>
              <div class="space-y-1 text-xs text-slate-600 dark:text-slate-300 max-h-24 overflow-y-auto custom-scrollbar pr-1">
                ${transferReceipt.transfers.map(t => {
                  const targetCustomer = state.customers.find(c => c.id === t.toCustomerId);
                  const name = targetCustomer ? targetCustomer.name : (isArT ? 'غير معروف' : 'Unknown');
                  return `<div class="flex justify-between">
                    <span>${new Date(t.date).toLocaleString(appDateLocale())}</span>
                    <span class="font-medium">$${(t.amountUSD || 0).toFixed(2)} → ${name}</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
          ` : ''}

          <div class="flex space-x-3 pt-2 border-t border-slate-200 dark:border-slate-700 mt-2">
            <button type="button" id="receipt-transfer-submit" onclick="saveReceiptTransfer()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold disabled:opacity-50 disabled:cursor-not-allowed" ${transferCustomers.length === 0 ? 'disabled' : ''}>
              <i data-lucide="check" class="w-4 h-4 inline mr-1.5"></i>${isArT ? 'تحويل' : 'Transfer'}
              </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold">${isArT ? 'إلغاء' : 'Cancel'}</button>
            </div>
          </div>
        `;
      break;
    case 'split-payments':
      const splitReceipt = state.modalData;
      const splitExistingPayments = splitReceipt.payments || [];
      const splitDeliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      const isArS = state.language === 'ar';

      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="credit-card" class="w-6 h-6 mr-2 text-purple-600"></i>
          ${isArS ? 'إدارة تقسيمات الدفع' : 'Manage Split Payments'}
        </h2>
        <div class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar pr-2">
          <!-- Target receipt id frozen at render time (same defense as the main
               receipt form): saveSplitPayments reads THIS, not state.modalData. -->
          <input type="hidden" id="split-payments-receipt-id" value="${Security.escapeHtml(String(splitReceipt.id || ''))}" />
          <div class="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl">
            <div class="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-2">${isArS ? 'إجمالي الوصل' : 'Receipt Total'}</div>
            <div class="text-2xl font-bold text-indigo-600">$${splitReceipt.amountUSD?.toFixed(2)} = ${splitReceipt.amountLocal?.toFixed(2)} LYD</div>
            <div class="text-xs text-slate-500 mt-1">${isArS ? 'سعر الصرف:' : 'Exchange Rate:'} ${splitReceipt.exchangeRate}</div>
          </div>

          <div id="split-payments-container" class="space-y-3">
            ${splitExistingPayments.map((payment, idx) => `
              <div class="split-payment-item p-4 rounded-lg">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs font-medium mb-1">${isArS ? 'طريقة الدفع' : 'Payment Method'}</label>
                    <select class="split-method w-full glass-input px-3 py-2 rounded-lg text-sm">
                      ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${trMethod(m)}</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">${isArS ? 'المبلغ (دينار)' : 'Amount (LYD)'}</label>
                    <input type="text" inputmode="decimal" class="split-amount w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.amount}" oninput="sanitizeMoneyInput(this)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">${isArS ? 'سعر الصرف' : 'Exchange Rate'}</label>
                    <input type="text" inputmode="decimal" class="split-rate w-full glass-input px-3 py-2 rounded-lg text-sm" value="${paymentRate1Value(payment)}" oninput="sanitizeMoneyInput(this, 4)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">${isArS ? 'سعر الدولار (سعر 2)' : 'USD Rate (Rate 2)'}</label>
                    <input type="text" inputmode="decimal" class="split-rate2 w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.rate2 !== undefined && payment.rate2 !== null && payment.rate2 !== '' ? payment.rate2 : paymentRate1Value(payment)}" oninput="sanitizeMoneyInput(this, 4)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">${isArS ? 'نوع التحصيل' : 'Collection Type'}</label>
                    <select class="split-collection w-full glass-input px-3 py-2 rounded-lg text-sm">
                      <option value="office" ${payment.collectionType === 'office' ? 'selected' : ''}>${trStatus('office')}</option>
                      <option value="delivery" ${payment.collectionType === 'delivery' ? 'selected' : ''}>${trStatus('delivery')}</option>
                      <option value="bank" ${payment.collectionType === 'bank' ? 'selected' : ''}>${trStatus('bank')}</option>
                    </select>
                  </div>
                  ${splitDeliveryUsers.length > 0 ? `
                    <div class="col-span-2">
                      <label class="block text-xs font-medium mb-1">${isArS ? 'موظف التوصيل' : 'Delivery Person'}</label>
                      <select class="split-delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm">
                        <option value="">${isArS ? 'بدون' : 'None'}</option>
                        ${splitDeliveryUsers.map(u => `<option value="${u.id}" ${payment.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
                      </select>
                    </div>
                  ` : ''}
                  <div class="col-span-2 flex justify-end">
                    <button type="button" onclick="this.closest('.split-payment-item').remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700 text-sm font-medium flex items-center space-x-1">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                      <span>${isArS ? 'إزالة' : 'Remove'}</span>
                    </button>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

          <button type="button" onclick="addSplitPayment()" class="w-full btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center space-x-2">
            <i data-lucide="plus-circle" class="w-4 h-4"></i>
            <span>${isArS ? 'إضافة تقسيم دفع' : 'Add Payment Split'}</span>
          </button>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveSplitPayments()" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isArS ? 'حفظ تقسيمات الدفع' : 'Save Split Payments'}
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">${isArS ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </div>
      `;
      break;
    case 'top-ups':
      const topUpAd = state.modalData;
      // Render from the working copy (tempTopUps) so existing AND just-added
      // top-ups both show and can be removed. The "New total" is computed live
      // from the base amount + the working list.
      const existingTopUps = tempTopUps;
      const topUpBase = topUpAd.initialAmountUSD || topUpAd.amountUSD;
      const topUpWorkingTotal = existingTopUps.reduce((sum, t) => sum + (t.amount || 0), 0);
      // End-date preview: base end (before any top-up) + every extension day
      // in the working list — live, so the user sees the new end before saving.
      const topUpBaseEnd = topUpAd.initialEndDate || topUpAd.endDate || '';
      const topUpWorkingDays = existingTopUps.reduce((sum, t) => sum + (parseInt(t.extendDays, 10) || 0), 0);
      const topUpBaseEndOk = topUpBaseEnd && !isNaN(new Date(topUpBaseEnd).getTime());
      const topUpNewEnd = topUpBaseEndOk ? new Date(new Date(topUpBaseEnd).getTime() + topUpWorkingDays * 86400000) : null;
      const isArTU = state.language === 'ar';
      // Receipt money still spendable given the working list — shown so the
      // user always knows how much they CAN top up (null = not receipt-funded).
      const topUpAvailable = _topUpAvailableNow(existingTopUps);

      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="trending-up" class="w-6 h-6 mr-2 text-blue-600"></i>
          ${isArTU ? 'إدارة الشحنات الإضافية' : 'Manage Top-ups'}
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
            <div class="text-sm font-medium text-blue-700 dark:text-blue-300">${isArTU ? 'تفاصيل الإعلان' : 'Ad Details'}</div>
            <div class="text-lg font-bold text-blue-600 mt-1">${isArTU ? 'الأصلي' : 'Original'}: $${(parseFloat(topUpBase) || 0).toFixed(2)} → ${isArTU ? 'الجديد' : 'New'}: <span id="topup-preview-new">$${((parseFloat(topUpBase) || 0) + topUpWorkingTotal).toFixed(2)}</span></div>
            ${topUpBaseEndOk ? `<div class="text-sm font-medium text-blue-700 dark:text-blue-300 mt-1">${isArTU ? 'النهاية' : 'End'}: <span id="topup-preview-end" class="font-bold">${topUpNewEnd.toLocaleDateString(appDateLocale())}</span> <span id="topup-preview-end-extra" class="text-xs">${topUpWorkingDays > 0 ? (isArTU ? `(الأصلية ${new Date(topUpBaseEnd).toLocaleDateString(appDateLocale())} + ${topUpWorkingDays} يوم)` : `(original ${new Date(topUpBaseEnd).toLocaleDateString(appDateLocale())} + ${topUpWorkingDays} day${topUpWorkingDays > 1 ? 's' : ''})`) : ''}</span></div>` : ''}
            ${topUpAvailable !== null ? `<div class="text-sm font-bold mt-1 text-blue-700 dark:text-blue-300">${isArTU ? 'المتاح من وصولات التمويل' : 'Available on funding receipt(s)'}: <span id="topup-preview-available" class="${topUpAvailable < 0.01 ? 'text-rose-600' : 'text-emerald-600'}">$${topUpAvailable.toFixed(2)}</span></div>` : ''}
            ${existingTopUps.length > 0 ? `<div class="text-xs text-slate-500 mt-1">${isArTU ? 'إجمالي الشحنات' : 'Total top-ups'}: $${topUpWorkingTotal.toFixed(2)}</div>` : ''}
          </div>

          <div id="topups-container" class="space-y-2">
            ${existingTopUps.map((topup, idx) => `
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <div class="font-medium">$${topup.amount}${(parseInt(topup.extendDays, 10) || 0) > 0 ? ` <span class="text-xs font-bold text-emerald-600">${isArTU ? `+${topup.extendDays} يوم` : `+${topup.extendDays} day${topup.extendDays > 1 ? 's' : ''}`}</span>` : ''}</div>
                  <div class="text-xs text-slate-500">${new Date(topup.date).toLocaleDateString(appDateLocale())} - ${Security.escapeHtml(topup.note || '')}</div>
                </div>
                <button type="button" onclick="removeTopUp(${idx})" class="text-rose-500 hover:text-rose-700">
                  <i data-lucide="x-circle" class="w-4 h-4"></i>
                </button>
              </div>
            `).join('')}
          </div>

          <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl space-y-3">
            <h4 class="text-sm font-medium">${isArTU ? 'إضافة شحنة جديدة' : 'Add New Top-up'}</h4>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <label class="block text-xs mb-1">${isArTU ? 'المبلغ (USD)' : 'Amount (USD)'}</label>
                <input type="text" inputmode="decimal" id="topup-amount" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="0.00" oninput="sanitizeMoneyInput(this); _refreshTopUpPreview()" />
              </div>
              <div>
                <label class="block text-xs mb-1">${isArTU ? 'التاريخ' : 'Date'}</label>
                <input type="date" id="topup-date" value="${getTodayDateString()}" class="w-full glass-input px-3 py-2 rounded-lg" />
              </div>
              <div>
                <label class="block text-xs mb-1">${isArTU ? 'تمديد (أيام)' : 'Extend (days)'}</label>
                <input type="number" min="0" step="1" id="topup-extend-days" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="0" oninput="_refreshTopUpPreview()" />
              </div>
            </div>
            <div>
              <label class="block text-xs mb-1">${isArTU ? 'ملاحظة' : 'Note'}</label>
              <input type="text" id="topup-note" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="${isArTU ? 'سبب الشحنة...' : 'Reason for top-up...'}" />
            </div>
            <button type="button" onclick="addNewTopUp()" class="w-full btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold">
              <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>${isArTU ? 'إضافة شحنة' : 'Add Top-up'}
            </button>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveTopUps()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isArTU ? 'حفظ الشحنات' : 'Save Top-ups'}
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">${isArTU ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </div>
      `;
      break;
    case 'refund':
      const refundAd = state.modalData;
      const isArRf = state.language === 'ar';

      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="arrow-left-circle" class="w-6 h-6 mr-2 text-rose-600"></i>
          ${isArRf ? 'إدارة الاسترجاع' : 'Manage Refund'}
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-rose-50 dark:bg-rose-900/20 rounded-xl">
            <div class="text-sm font-medium text-rose-700 dark:text-rose-300">${isArRf ? 'مبلغ الإعلان' : 'Ad Amount'}</div>
            <div class="text-2xl font-bold text-rose-600">$${refundAd.amountUSD} (${refundAd.amountLocal} LYD)</div>
            ${refundAd.refundType && refundAd.refundType !== 'None' ? `
              <div class="text-xs text-slate-500 mt-2">${isArRf ? 'الاسترجاع الحالي' : 'Current Refund'}: ${trStatus(refundAd.refundType)} - $${refundAd.refundAmount || 0} (${trStatus(refundAd.refundStatus || 'Pending')})</div>
            ` : ''}
          </div>

          <div>
            <label class="block text-sm font-medium mb-2">${isArRf ? 'نوع الاسترجاع' : 'Refund Type'}</label>
            <select id="refund-type" class="w-full glass-input px-4 py-2 rounded-xl" onchange="toggleRefundAmount(this.value)">
              ${REFUND_TYPES.map(t => `<option value="${t}" ${refundAd.refundType === t ? 'selected' : ''}>${trStatus(t)}</option>`).join('')}
            </select>
          </div>

          <div id="refund-amount-section" class="${!refundAd.refundType || refundAd.refundType === 'None' ? 'hidden' : ''}">
            <label class="block text-sm font-medium mb-2">${isArRf ? 'مبلغ الاسترجاع (USD)' : 'Refund Amount (USD)'}</label>
            <input type="text" inputmode="decimal" id="refund-amount" value="${refundAd.refundAmount || (refundAd.refundType === 'Full' ? refundAd.amountUSD : 0)}" class="w-full glass-input px-4 py-2 rounded-xl" oninput="sanitizeMoneyInput(this)" />
          </div>

          <div id="refund-status-section" class="${!refundAd.refundType || refundAd.refundType === 'None' ? 'hidden' : ''}">
            <label class="block text-sm font-medium mb-2">${isArRf ? 'حالة الاسترجاع' : 'Refund Status'}</label>
            <select id="refund-status" class="w-full glass-input px-4 py-2 rounded-xl">
              <option value="Pending" ${refundAd.refundStatus === 'Pending' ? 'selected' : ''}>${trStatus('Pending')}</option>
              <option value="Refunded" ${refundAd.refundStatus === 'Refunded' ? 'selected' : ''}>${isArRf ? 'تم الاسترجاع' : 'Refunded'}</option>
            </select>
          </div>

          <div class="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl flex items-start space-x-2">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-600 mt-0.5"></i>
            <p class="text-xs text-amber-700 dark:text-amber-300">${isArRf ? 'الاسترجاع سيغيّر حالة الإعلان إلى ملغي وسيتتبع مبلغ الاسترجاع.' : 'Refunds will mark the ad status as Canceled and track the refund amount.'}</p>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveRefund()" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isArRf ? 'حفظ الاسترجاع' : 'Save Refund'}
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">${isArRf ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </div>
      `;
      break;
    case 'recovery-key': {
      const rtl = state.language === 'ar';
      const key = String(state.modalData?.recoveryKey || '');
      modalContent = `
        <div class="text-center">
          <div class="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-4">
            <i data-lucide="key" class="w-8 h-8 text-white"></i>
          </div>
          <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${rtl ? 'مفتاح الاستعادة' : 'Recovery Key'}</h2>
          <p class="text-slate-600 dark:text-slate-300 mb-4 text-sm">
            ${rtl
              ? 'احفظ هذا المفتاح في مكان آمن. يمكنك استخدامه لإعادة تعيين كلمة المرور في الوضع المحلي.'
              : 'Save this key in a safe place. It can reset passwords in local mode.'}
          </p>
          <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 mb-4">
            <div class="text-xs text-slate-400 mb-2">${rtl ? 'المفتاح' : 'Key'}</div>
            <div class="font-mono text-sm break-all select-all text-slate-800 dark:text-slate-200">${Security.escapeHtml(key)}</div>
          </div>
          <div class="flex space-x-3">
            <button type="button" onclick="copyTextToClipboard('${key}').then(ok => showNotification(ok ? '${rtl ? 'تم النسخ' : 'Copied'}' : '${rtl ? 'فشل النسخ' : 'Copy Failed'}', ok ? '${rtl ? 'تم نسخ مفتاح الاستعادة' : 'Recovery key copied'}' : '${rtl ? 'الرجاء النسخ يدوياً' : 'Please copy manually'}', ok ? 'success' : 'error'))" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="copy" class="w-4 h-4 inline mr-2"></i>${rtl ? 'نسخ' : 'Copy'}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${rtl ? 'تم' : 'Done'}
            </button>
          </div>
        </div>
      `;
      break;
    }
    case 'password-reset': {
      const rtl = state.language === 'ar';
      const step = String(state.modalData?.step || (isServerModeEnabled() ? 'request' : 'local'));
      const emailVal = String(state.modalData?.email || '');
      const tokenVal = String(state.modalData?.token || '');

      if (isServerModeEnabled()) {
        if (step === 'confirm') {
          modalContent = `
            <div class="text-center mb-4">
              <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="shield-check" class="w-7 h-7 text-white"></i>
              </div>
              <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('resetPassword')}</h2>
              <p class="text-sm text-slate-500">${rtl ? 'أدخل رمز الاستعادة وكلمة المرور الجديدة' : 'Enter your reset code and new password'}</p>
            </div>

            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('resetCode')}</label>
                <input type="text" id="pwreset-token" value="${Security.escapeHtml(tokenVal)}" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? 'أدخل الرمز' : 'Enter code'}" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('newPassword')}</label>
                <input type="password" id="pwreset-new" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? '8 أحرف على الأقل' : 'Min. 8 characters'}" minlength="8" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('confirmPassword')}</label>
                <input type="password" id="pwreset-confirm" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" minlength="8" />
              </div>
              <div class="flex space-x-3 pt-2">
                <button type="button" onclick="passwordResetConfirmServer()" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
                  <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${t('resetPassword')}
                </button>
                <button type="button" onclick="state.modalData.step='request'; state.modalData.token=''; renderModal();" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
                  ${rtl ? 'رجوع' : 'Back'}
                </button>
              </div>
            </div>
          `;
        } else {
          modalContent = `
            <div class="text-center mb-4">
              <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-3">
                <i data-lucide="mail" class="w-7 h-7 text-white"></i>
              </div>
              <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('resetPassword')}</h2>
              <p class="text-sm text-slate-500">${rtl ? 'سنرسل رمز استعادة إلى بريدك' : 'We will send a reset code to your email'}</p>
            </div>

            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('email')}</label>
                <input type="email" id="pwreset-email" value="${Security.escapeHtml(emailVal)}" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="name@company.com" />
              </div>
              <div class="flex space-x-3 pt-2">
                <button type="button" onclick="passwordResetRequestServer()" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
                  <i data-lucide="send" class="w-4 h-4 inline mr-2"></i>${t('sendResetCode')}
                </button>
                <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
                  ${t('cancel')}
                </button>
              </div>
              <div class="text-[11px] text-slate-400">
                ${rtl ? 'لن نخبرك إن كان البريد موجوداً أم لا.' : 'We do not reveal whether an email exists.'}
              </div>
            </div>
          `;
        }
      } else {
        // Local mode reset: requires Recovery Key
        const hasRecovery = !!(state.localRecovery?.hash && state.localRecovery?.salt);
        modalContent = `
          <div class="text-center mb-4">
            <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center mx-auto mb-3">
              <i data-lucide="key" class="w-7 h-7 text-white"></i>
            </div>
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('resetPassword')}</h2>
            <p class="text-sm text-slate-500">${rtl ? 'وضع محلي: استخدم مفتاح الاستعادة' : 'Local mode: use the Recovery Key'}</p>
          </div>

          ${!hasRecovery ? `
            <div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200 mb-4">
              <div class="font-bold mb-1">${rtl ? 'لا يوجد مفتاح استعادة' : 'No Recovery Key set'}</div>
              <div>${rtl ? 'اطلب من الأدمن إنشاء مفتاح: الإعدادات → الأمان.' : 'Ask Admin to create one: Settings → Security.'}</div>
            </div>
          ` : ''}

          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">${t('email')}</label>
              <input type="email" id="pwreset-email" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="name@company.com" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">${t('recoveryKey')}</label>
              <input type="text" id="pwreset-recovery" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? 'ألصق مفتاح الاستعادة' : 'Paste recovery key'}" ${hasRecovery ? '' : 'disabled'} />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">${t('newPassword')}</label>
              <input type="password" id="pwreset-new" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? '8 أحرف على الأقل' : 'Min. 8 characters'}" minlength="8" ${hasRecovery ? '' : 'disabled'} />
            </div>
            <div>
              <label class="block text-sm font-medium mb-2">${t('confirmPassword')}</label>
              <input type="password" id="pwreset-confirm" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" minlength="8" ${hasRecovery ? '' : 'disabled'} />
            </div>
            <div class="flex space-x-3 pt-2">
              <button type="button" onclick="passwordResetConfirmLocal()" class="flex-1 btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700 ${hasRecovery ? '' : 'opacity-50 cursor-not-allowed'}" ${hasRecovery ? '' : 'disabled'}>
                <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${t('resetPassword')}
              </button>
              <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
                ${t('cancel')}
              </button>
            </div>
          </div>
        `;
      }
      break;
    }
    case 'change-password': {
      const rtl = state.language === 'ar';
      modalContent = `
        <div class="text-center mb-4">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center mx-auto mb-3">
            <i data-lucide="lock" class="w-7 h-7 text-white"></i>
          </div>
          <h2 class="text-2xl font-bold text-slate-800 dark:text-white">${t('changePassword')}</h2>
          <p class="text-sm text-slate-500">
            ${rtl ? 'أدخل كلمة المرور الحالية ثم كلمة المرور الجديدة' : 'Enter your current password and your new password'}
          </p>
        </div>

        <form id="modal-form" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-2">${t('currentPassword')}</label>
            <input type="password" id="cp-current" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('newPassword')}</label>
            <input type="password" id="cp-new" required minlength="8" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${rtl ? '8 أحرف على الأقل' : 'Min. 8 characters'}" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('confirmPassword')}</label>
            <input type="password" id="cp-confirm" required minlength="8" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="••••••••" />
          </div>
          <div class="flex space-x-3 pt-2">
            <button type="submit" class="flex-1 btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${t('save')}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${t('cancel')}
            </button>
          </div>
          <div class="text-[11px] text-slate-400">
            ${isServerModeEnabled()
              ? (rtl ? 'في وضع السيرفر: سيتم تسجيل الخروج من الجلسات الأخرى.' : 'Server mode: other sessions will be logged out.')
              : (rtl ? 'في الوضع المحلي: التغيير ينطبق على هذا المتصفح.' : 'Local mode: applies to this browser data.')}
          </div>
        </form>
      `;
      break;
    }
    case 'subscription-lock':
      const lockServiceId = state.modalData?.serviceId || '';
      const lockSubscribeToId = state.modalData?.subscribeToId || lockServiceId;
      const lockServiceName = state.modalData?.serviceName || 'Service';
      const isRTL = state.language === 'ar';
      const subscribeTarget = SERVICES[lockSubscribeToId];
      const subscribeTargetName = subscribeTarget ? (isRTL ? subscribeTarget.nameAr : subscribeTarget.name) : '';
      const offer = getServiceSubscriptionOffer(lockSubscribeToId);
      const walletBalanceMinor = state.currentUser?.id ? WALLET.getBalanceMinor(state.currentUser.id, offer.currency) : 0;
      const walletBalanceLabel = walletFormatMinor(walletBalanceMinor, offer.currency);
      const offerLabel = offer.priceMinor > 0
        ? `${walletFormatMinor(offer.priceMinor, offer.currency)} / ${offer.durationDays}d`
        : (isRTL ? 'مجاني' : 'Free');
      modalContent = `
        <div class="text-center">
          <div class="w-16 h-16 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4">
            <i data-lucide="lock" class="w-8 h-8 text-white"></i>
          </div>
          <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">
            ${isRTL ? 'غير مشترك' : 'Not Subscribed'}
          </h2>
          <p class="text-slate-600 dark:text-slate-300 mb-6">
            ${isRTL 
              ? `أنت غير مشترك في <strong>${lockServiceName}</strong>. هل تريد الاشتراك؟`
              : `You are not subscribed to <strong>${lockServiceName}</strong>. Would you like to subscribe?`
            }
          </p>
          ${lockSubscribeToId !== lockServiceId && subscribeTargetName ? `
            <div class="mb-5 text-xs text-slate-500 dark:text-slate-400">
              ${isRTL ? `سيتم الاشتراك في: <strong>${subscribeTargetName}</strong>` : `You will subscribe to: <strong>${subscribeTargetName}</strong>`}
            </div>
          ` : ''}
          <div class="mb-6 p-4 rounded-2xl bg-white/40 dark:bg-slate-800/30 border border-white/30">
            <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>${isRTL ? 'رصيد المحفظة' : 'Wallet balance'}</span>
              <span class="font-bold">${walletBalanceLabel}</span>
            </div>
            <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>${isRTL ? 'سعر الاشتراك' : 'Subscription price'}</span>
              <span class="font-bold">${offerLabel}</span>
            </div>
          </div>
          <div class="flex space-x-3">
            <button onclick="handleSubscribe('${lockSubscribeToId}', '${lockServiceId}')" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>
              ${isRTL ? 'اشترك' : 'Subscribe'}
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${isRTL ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </div>
      `;
      break;

    case 'clothes-product':
      modalContent = renderClothesProductModal();
      break;

    case 'clothes-shipment':
      modalContent = renderClothesShipmentModal();
      break;

    case 'clothes-order':
      modalContent = renderClothesOrderModal();
      break;

    case 'wallet-topup': {
      const isArW = state.language === 'ar';
      const topupUser = state.users.find(u => u.id === state.modalData?.userId);
      const balanceLabel = topupUser ? walletFormatMinor(WALLET.getBalanceMinor(topupUser.id), WALLET.currency) : '';
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center gap-2">
          <i data-lucide="banknote" class="w-6 h-6 text-emerald-600"></i>
          ${isArW ? 'شحن محفظة' : 'Top Up Wallet'}
        </h2>
        <form id="modal-form" class="space-y-4">
          <div class="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
            <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(topupUser?.name || '')}</div>
            <div class="text-sm text-slate-500 dark:text-slate-400">${isArW ? 'الرصيد الحالي:' : 'Current balance:'} <span class="font-bold">${balanceLabel}</span></div>
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${isArW ? 'المبلغ (دينار) *' : 'Amount (LYD) *'}</label>
            <input type="text" inputmode="decimal" id="topup-amount" oninput="sanitizeMoneyInput(this)" required class="w-full glass-input px-4 py-2 rounded-xl" placeholder="0.00" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${isArW ? 'ملاحظة (مثال: دفع نقدي)' : 'Note (e.g. cash payment)'}</label>
            <input type="text" id="topup-memo" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isArW ? 'اختياري' : 'Optional'}" />
          </div>
          <p class="text-xs text-slate-400 dark:text-slate-500">
            ${isArW ? 'سجّل هنا المال الذي استلمته من العميل خارج التطبيق (نقداً أو تحويلاً).' : 'Record money you received from this client outside the app (cash or transfer).'}
          </p>
          <div class="flex gap-3 pt-2">
            <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-emerald-500 to-teal-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg">
              ${isArW ? 'إضافة الرصيد' : 'Add Credit'}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600">
              ${isArW ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </form>
      `;
      break;
    }
  }

  const modal = document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'mobile-dialog-overlay fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  // Smaller, more compact modal sizes
  let modalSize = 'max-w-md';
  if (state.activeModal === 'split-payments' || state.activeModal === 'top-ups' || state.activeModal === 'refund') {
    modalSize = 'max-w-4xl';
  } else if (state.activeModal === 'customer-merge') {
    modalSize = 'max-w-3xl';
  } else if (state.activeModal === 'ad') {
    modalSize = 'max-w-xl'; // Wider modal for new Ad design with sections
  } else if (state.activeModal === 'receipt') {
    modalSize = 'max-w-lg'; // Compact size for receipts
  } else if (state.activeModal === 'clothes-product') {
    modalSize = 'max-w-xl'; // Room for the color/size/qty rows
  } else if (state.activeModal === 'clothes-shipment') {
    modalSize = 'max-w-2xl'; // Room for the shipment line rows
  } else if (state.activeModal === 'clothes-order') {
    modalSize = 'max-w-2xl'; // Room for the order line rows
  }
  // Make Ad/Receipt modals scroll on the whole panel (header + content) to avoid "nothing shows" confusion.
  const modalScrollable = state.activeModal === 'customer-merge'
    ? ' max-h-[90dvh] overflow-y-auto custom-scrollbar'
    : (state.activeModal === 'receipt' || state.activeModal === 'ad')
      ? ' max-h-[90vh] overflow-y-auto custom-scrollbar'
      : '';
  const modalAccessibility = state.activeModal === 'customer-merge'
    ? ' role="dialog" aria-modal="true" aria-labelledby="customer-merge-title"'
    : '';
  modal.innerHTML = `<div class="glass-panel rounded-2xl p-6 w-full ${modalSize}${modalScrollable}"${modalAccessibility} onclick="event.stopPropagation()">${modalContent}</div>`;
  modal.onclick = closeModal;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);

  if (state.activeModal === 'customer-merge') {
    const dialog = modal.firstElementChild;
    dialog?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.querySelector('#customer-merge-title')?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!focusable.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    setTimeout(() => {
      if (!dialog?.isConnected) return;
      const previousControl = previousCustomerMergeFocusId
        ? dialog.querySelector(`#${previousCustomerMergeFocusId}`)
        : null;
      const focusTarget = previousControl || dialog.querySelector('#customer-merge-title');
      if (focusTarget && typeof focusTarget.focus === 'function') {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch (_) {
          focusTarget.focus();
        }
      }
    }, 0);
  }
  
  // Initialize receipt totals if it's a receipt modal
  if (state.activeModal === 'receipt') {
    setTimeout(() => {
      updateReceiptTotals();
      // Auto-serial: fill the number for a NEW receipt whose payment method is
      // auto-numbered, and lock the field whenever such a method is selected
      // (including when EDITING a receipt that already uses one). Opening the
      // form never renumbers an existing receipt.
      initReceiptSerialOnOpen();
      updateReceiptStatusUI(document.getElementById('receipt-status')?.value || 'Paid');
      // Pre-populate customer if editing. Use the RECEIPT's own stored phone —
      // seeding the customer's first phone rewrote receipt.phoneNumber on save
      // for any receipt taken on a second number.
      if (state.modalData && state.modalData.customerId) {
        const customer = state.customers.find(c => c.id === state.modalData.customerId);
        if (customer && Array.isArray(customer.phones) && customer.phones.length > 0) {
          const stored = String(state.modalData.phoneNumber || '').trim();
          const phone = (stored && customer.phones.includes(stored)) ? stored : customer.phones[0];
          selectReceiptPhone(phone, customer.id);
        }
      }
      renderReceiptPhotoPreviews();
    }, 100);
  } else if (state.activeModal === 'ad') {
    setTimeout(() => {
      initAdFunding(state.modalData || {});
      // If editing, select the page to populate customer
      const adData = state.modalData || {};
      if (adData.pageId) {
        const preserveFunding = state.modalData !== null; // keep existing allocations during edit init
        selectAdPage(adData.pageId, preserveFunding);
        // If there's already a customer, select it
        if (adData.customerId) {
          selectAdCustomer(adData.customerId, true);
        }
      }
      // Initialize payment status UI (default to 'paid' for new ads)
      const initialPaymentStatus = getAdPaymentState(adData);
      setAdPaymentStatus(initialPaymentStatus);
      updateAdDriverBudgetSummary();
      // Render funding list right away so the user always sees guidance / first allocation row
      renderAdFundingList();
      updateAdLocalAmount();
      refreshAdFundingSummary();
      renderAdPhotoPreviews();
      // Initialize financial details for unpaid flows
      if (initialPaymentStatus !== 'paid') {
        updateAdUnpaidTotals();
      }
    }, 100);
  } else if (state.activeModal === 'clothes-product') {
    setTimeout(() => {
      refreshClothesVariantRows();
      refreshClothesPhotoPreview();
    }, 50);
  } else if (state.activeModal === 'clothes-shipment') {
    setTimeout(() => {
      refreshClothesShipLines();
    }, 50);
  } else if (state.activeModal === 'clothes-order') {
    setTimeout(() => {
      refreshClothesOrderLines();
    }, 50);
  }
  
  const form = document.getElementById('modal-form');
  if (form) {
    // Reentrancy guard: user/customer/page creation awaits async work
    // (apiCreateUser / password hashing) before the modal closes, so a
    // double-click on Create ran handleModalSubmit twice and created
    // duplicate records. Also disable the submit button for visible feedback.
    let submitting = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;
      submitting = true;
      const submitBtn = e.submitter || document.querySelector('button[type="submit"][form="modal-form"], #modal-form button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        await handleModalSubmit();
      } catch (err) {
        console.error('Modal submit error:', err);
        // Surface the server's actual reason (e.g. "A user with this email
        // already exists") instead of a generic message that hides it.
        const detail = String(err?.message || '').trim();
        showNotification(
          state.language === 'ar' ? 'خطأ' : 'Error',
          detail || (state.language === 'ar' ? 'فشل حفظ التغييرات' : 'Failed to save changes'),
          'error'
        );
      } finally {
        submitting = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

// Keep one request identity across response-loss retries. Volatile audit
// timestamps are excluded from the fingerprint and the first prepared payload
// is reused, so an identical retry cannot accidentally create a second ad.
const _pendingAdMutationAttempts = new Map();

function getAdMutationFingerprint(action, adId, expectedLastModified, data) {
  const stable = Security.sanitizeObject(data || {});
  delete stable.createdAt;
  delete stable.updatedAt;
  delete stable.collectionDate;
  if (Array.isArray(stable.editHistory)) {
    stable.editHistory = stable.editHistory.map(row => ({ ...row, editedAt: '' }));
  }
  if (Array.isArray(stable.topUps)) {
    stable.topUps = stable.topUps.map(row => ({ ...row, date: '' }));
  }
  return JSON.stringify({ action, adId, expectedLastModified: expectedLastModified ?? null, data: stable });
}

function getAdMutationAttempt(action, adId, expectedLastModified, data) {
  const act = String(action || '');
  const existingId = String(adId || '');
  const slot = act === 'create' ? 'create' : `${act}:${existingId}`;
  const fingerprint = getAdMutationFingerprint(act, existingId, expectedLastModified, data);
  const prior = _pendingAdMutationAttempts.get(slot);
  if (prior?.fingerprint === fingerprint) return prior;
  if (prior?.promise) return prior;
  const attempt = {
    slot,
    fingerprint,
    adId: existingId || Security.generateSecureId('ad'),
    idempotencyKey: ensureOperationIdempotencyKey('', `ad-${act || 'mutate'}`),
    expectedLastModified,
    data: Security.sanitizeObject(data || {}),
    promise: null
  };
  _pendingAdMutationAttempts.set(slot, attempt);
  return attempt;
}

function completeAdMutationAttempt(attempt) {
  if (attempt && _pendingAdMutationAttempts.get(attempt.slot) === attempt) {
    _pendingAdMutationAttempts.delete(attempt.slot);
  }
}

function resolveAdPrimaryReceiptId({ paymentStatus, collectionMethod, linkedDeliveryReceiptId, allocations, dueAllocations } = {}) {
  const normalizedStatus = getAdPaymentState({ paymentStatus });
  const normalizedCollection = String(collectionMethod || '').toLowerCase();
  if (normalizedStatus === 'not_paid' && normalizedCollection === 'driver') {
    return String(linkedDeliveryReceiptId || '');
  }
  if (normalizedStatus === 'not_paid' && normalizedCollection === 'in_shop') {
    return String((Array.isArray(dueAllocations) ? dueAllocations[0]?.receiptId : '') || '');
  }
  if (normalizedStatus === 'paid') {
    return String(Array.isArray(allocations) ? (allocations[0]?.receiptId || '') : '');
  }
  return '';
}

function buildServerAdMutationData(adUpdates, { create = false } = {}) {
  const data = Security.sanitizeObject(adUpdates || {});
  const hasPaymentStatus = Object.prototype.hasOwnProperty.call(adUpdates || {}, 'paymentStatus');
  const normalizedPaymentStatus = getAdPaymentState(adUpdates);
  if (hasPaymentStatus) data.paymentStatus = normalizedPaymentStatus;
  // Paid ads remain server-derived from receipt allocations. Not Paid + Driver
  // is different: its positive budget is real customer debt even when no
  // receipt credit funds it yet, so send one narrowly-scoped request value.
  if (hasPaymentStatus && normalizedPaymentStatus === 'not_paid' && String(adUpdates?.collectionMethod || '').toLowerCase() === 'driver') {
    data.driverBudgetUSD = normalizeAdDriverBudgetUSD(adUpdates?.amountUSD);
  } else {
    delete data.driverBudgetUSD;
  }
  // These values are materialized from allocations/payment rows by the server.
  // Sending them would invite a forged total that disagrees with the funding
  // rows. The allocation requests themselves remain explicit inputs.
  for (const field of [
    'amountUSD', 'amountLocal', 'receiptIds', 'fundingReceiptId',
    'dueAmountToUseUSD', 'hasMergedPaidFunds', 'isPaid', 'initialAmountUSD',
    'spentUSD', 'canceledBy'
  ]) delete data[field];
  if (create) {
    data.recordType = 'ad';
    data.topUps = [];
  }
  return data;
}

async function saveAdThroughAtomicServer(action, adId, expectedLastModified, data) {
  if (action === 'update' && (!Number.isSafeInteger(expectedLastModified) || expectedLastModified < 0)) {
    throw new Error('This ad is missing its server version. Refresh and try again.');
  }
  const attempt = getAdMutationAttempt(action, adId, expectedLastModified, data);
  if (attempt.promise) return await attempt.promise;
  attempt.promise = (async () => {
    const payload = {
      action,
      adId: attempt.adId,
      idempotencyKey: attempt.idempotencyKey,
      data: attempt.data
    };
    if (action === 'update') payload.expectedLastModified = attempt.expectedLastModified;
    const response = await apiMutateAd(payload);
    const [savedAd] = applyValidatedServerEntityBatch([
      { collection: 'ads', entity: response.ad }
    ], 'adMutation');
    if (!savedAd) throw new Error('Invalid ad mutation response');
    completeAdMutationAttempt(attempt);
    return savedAd;
  })();
  try {
    return await attempt.promise;
  } finally {
    attempt.promise = null;
  }
}

async function handleModalSubmit() {
  const isEdit = state.modalData !== null;
  
  switch (state.activeModal) {
    case 'clothes-product': {
      const saved = await saveClothesProductFromModal();
      if (!saved) return; // keep modal open on validation errors
      break;
    }
    case 'clothes-shipment': {
      const saved = await saveClothesShipmentFromModal();
      if (!saved) return; // keep modal open on validation errors
      break;
    }
    case 'clothes-order': {
      const saved = await saveClothesOrderFromModal();
      if (!saved) return; // keep modal open on validation errors
      break;
    }
    case 'wallet-topup': {
      const isArW = state.language === 'ar';
      const targetUserId = String(state.modalData?.userId || '');
      const amountRaw = document.getElementById('topup-amount')?.value;
      const amount = parseFloat(String(amountRaw || '').trim());
      if (!Number.isFinite(amount) || amount <= 0) {
        showNotification(isArW ? 'تنبيه' : 'Validation', isArW ? 'أدخل مبلغاً أكبر من صفر.' : 'Enter an amount greater than zero.', 'error');
        return;
      }
      const memo = Security.sanitizeInput(String(document.getElementById('topup-memo')?.value || ''), { maxLength: 180 }).trim();
      try {
        const tx = await WALLET.credit(targetUserId, amount, {
          memo: memo || (isArW ? 'شحن محفظة' : 'Wallet top-up'),
          idempotencyKey: String(state.modalData?.idempotencyKey || '') || Security.generateSecureId('topup')
        });
        showNotification(
          isArW ? 'تم الشحن' : 'Credited',
          isArW ? `تمت إضافة ${walletFormatMinor(tx.amountMinor, tx.currency)} إلى المحفظة.` : `${walletFormatMinor(tx.amountMinor, tx.currency)} added to the wallet.`,
          'success'
        );
      } catch (e) {
        showNotification(isArW ? 'خطأ' : 'Error', e?.message || 'Top-up failed', 'error');
        return;
      }
      break;
    }
    case 'change-password': {
      const isArCP = state.language === 'ar';
      if (!state.currentUser?.id) {
        showNotification(isArCP ? 'خطأ' : 'Error', isArCP ? 'لم يتم تسجيل الدخول' : 'Not logged in', 'error');
        return;
      }

      const currentPw = String(document.getElementById('cp-current')?.value || '');
      const newPw = String(document.getElementById('cp-new')?.value || '');
      const confirmPw = String(document.getElementById('cp-confirm')?.value || '');

      if (!currentPw) {
        showNotification(isArCP ? 'تنبيه' : 'Validation', isArCP ? 'كلمة المرور الحالية مطلوبة' : 'Current password is required', 'error');
        return;
      }
      if (!newPw || newPw.length < 8) {
        showNotification(isArCP ? 'تنبيه' : 'Validation', isArCP ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
        return;
      }
      if (newPw !== confirmPw) {
        showNotification(isArCP ? 'تنبيه' : 'Validation', isArCP ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match', 'error');
        return;
      }

      if (isServerModeEnabled()) {
        try {
          await apiChangePassword(currentPw, newPw);
          showNotification(isArCP ? 'نجاح' : 'Success', isArCP ? 'تم تغيير كلمة المرور بنجاح' : 'Password changed successfully', 'success');
        } catch (e) {
          showNotification(isArCP ? 'خطأ' : 'Error', e.message || (isArCP ? 'فشل تغيير كلمة المرور' : 'Failed to change password'), 'error');
          return;
        }
        break;
      }

      // Local mode
      const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id) || state.currentUser;
      if (!user) {
        showNotification(isArCP ? 'خطأ' : 'Error', isArCP ? 'المستخدم غير موجود' : 'User not found', 'error');
        return;
      }

      let ok = false;
      if (user.passwordHash && user.salt) {
        const algo = user.passwordAlgo || 'sha256';
        const iterations = user.passwordIterations || null;
        ok = await Security.verifyPassword(currentPw, user.passwordHash, user.salt, algo, iterations);
      } else if (user.password) {
        ok = user.password === currentPw;
      }

      if (!ok) {
        showNotification(isArCP ? 'خطأ' : 'Error', isArCP ? 'كلمة المرور الحالية غير صحيحة' : 'Current password is incorrect', 'error');
        addSecurityLog('password_change_bad_current', user.email || user.id);
        return;
      }

      const hashed = await Security.hashPassword(newPw, null, { algo: 'pbkdf2-sha256' });
      const passwordSaved = await updateRecord(state.users, user.id, {
        passwordHash: hashed.hash,
        salt: hashed.salt,
        passwordAlgo: hashed.algo,
        passwordIterations: hashed.iterations
      });
      if (!passwordSaved) return;
      addSecurityLog('password_changed', user.email || user.id);
      showNotification(isArCP ? 'نجاح' : 'Success', isArCP ? 'تم تغيير كلمة المرور بنجاح' : 'Password changed successfully', 'success');
      break;
    }
    case 'customer-merge': {
      const isArMerge = state.language === 'ar';
      if (!isCurrentUserAdmin()) {
        showNotification(isArMerge ? 'تم رفض الوصول' : 'Access Denied', isArMerge ? 'دمج العملاء متاح للمدير فقط.' : 'Only an administrator can merge customers.', 'error');
        return;
      }
      if (!isServerModeEnabled()) {
        showNotification(isArMerge ? 'يتطلب اتصال الخادم' : 'Server connection required', isArMerge ? 'أعد الاتصال بالخادم ثم حاول مرة أخرى.' : 'Reconnect to the server and try again.', 'warning');
        return;
      }
      if (!document.getElementById('customer-merge-confirm')?.checked) {
        showNotification(isArMerge ? 'التأكيد مطلوب' : 'Confirmation required', isArMerge ? 'أكد أولاً أن السجلين لنفس العميل.' : 'Confirm that both records belong to the same customer.', 'warning');
        return;
      }
      const keepCustomerId = String(state.modalData?.keepCustomerId || '');
      const duplicateCustomerId = String(state.modalData?.duplicateCustomerId || '');
      const keepCustomer = state.customers.find(customer => customer && !customer._deleted && String(customer.id) === keepCustomerId);
      const duplicateCustomer = state.customers.find(customer => customer && !customer._deleted && String(customer.id) === duplicateCustomerId);
      if (!keepCustomer || !duplicateCustomer || keepCustomerId === duplicateCustomerId) {
        showNotification(isArMerge ? 'اختيار غير صالح' : 'Invalid selection', isArMerge ? 'اختر سجلين مختلفين ثم حاول مرة أخرى.' : 'Choose two different active records and try again.', 'error');
        return;
      }
      const keepPhoneKeys = new Set(getCustomerPhoneEntries(keepCustomer).map(entry => entry.key));
      const sharesPhone = getCustomerPhoneEntries(duplicateCustomer).some(entry => keepPhoneKeys.has(entry.key));
      if (!sharesPhone) {
        showNotification(isArMerge ? 'تغيرت البيانات' : 'Data changed', isArMerge ? 'لم يعد السجلان يشتركان في رقم هاتف. حدّث الصفحة وحاول مرة أخرى.' : 'These records no longer share a phone number. Refresh and try again.', 'warning');
        return;
      }
      const expectedKeepLastModified = Number(keepCustomer._lastModified);
      const expectedDuplicateLastModified = Number(duplicateCustomer._lastModified);
      if (!Number.isSafeInteger(expectedKeepLastModified) || !Number.isSafeInteger(expectedDuplicateLastModified)) {
        showNotification(isArMerge ? 'يلزم التحديث' : 'Refresh required', isArMerge ? 'السجلان لا يحتويان على نسخة خادم صالحة. حدّث الصفحة ثم حاول.' : 'These records do not have a valid server version. Refresh and try again.', 'warning');
        return;
      }
      const response = await apiMergeCustomers({
        keepCustomerId,
        duplicateCustomerId,
        expectedKeepLastModified,
        expectedDuplicateLastModified,
        idempotencyKey: String(state.modalData?.idempotencyKey || '') || Security.generateSecureId('customer-merge')
      });
      if (!response.duplicate?.data?._deleted) throw new Error('The server did not archive the duplicate customer. Nothing was applied locally.');
      applyValidatedServerEntityBatch([
        { collection: 'customers', entity: response.customer },
        ...response.updatedPages.map(entity => ({ collection: 'pages', entity })),
        ...response.updatedReceipts.map(entity => ({ collection: 'receipts', entity })),
        ...response.updatedAds.map(entity => ({ collection: 'ads', entity })),
        { collection: 'customers', entity: response.duplicate }
      ], 'customerMerge');
      addAuditLog(
        'Merge',
        keepCustomerId,
        `Merged duplicate customer ${duplicateCustomerId} into ${keepCustomerId}`,
        { duplicateCustomerId, replayed: response.replayed === true }
      );
      showNotification(
        isArMerge ? 'تم الدمج بأمان' : 'Customers merged',
        isArMerge ? `تم نقل جميع الروابط إلى «${keepCustomer.name || ''}» وأرشفة السجل المكرر.` : `All links now belong to “${keepCustomer.name || 'the kept customer'}”; the duplicate was archived.`,
        'success'
      );
      break;
    }
    case 'customer': {
      const isAr = state.language === 'ar';
      // Whitespace-only input satisfies the HTML `required` attribute, so
      // trim + check here — otherwise a blank-named customer gets saved.
      const custName = document.getElementById('customer-name').value.trim();
      if (!custName) {
        showNotification(isAr ? 'خطأ في الإدخال' : 'Validation Error', isAr ? 'اسم العميل مطلوب' : 'Customer name is required', 'error');
        return;
      }

      // Collect all phone numbers
      const phoneInputs = document.querySelectorAll('.customer-phone');
      const phones = dedupeCustomerPhoneValues(Array.from(phoneInputs).map(input => input.value.trim()).filter(p => p));
      // A whitespace-only phone passes `required` but is filtered out above —
      // without this check the customer is saved with zero phone numbers.
      if (phones.length === 0) {
        showNotification(isAr ? 'خطأ في الإدخال' : 'Validation Error', isAr ? 'رقم هاتف واحد على الأقل مطلوب' : 'At least one phone number is required', 'error');
        return;
      }

      // Check for duplicate phone numbers with other customers
      const currentCustomerId = isEdit ? state.modalData.id : null;
      const duplicatePhone = checkDuplicatePhone(phones, currentCustomerId);
      if (duplicatePhone) {
        showNotification(
          isAr ? 'رقم هاتف مكرر' : 'Duplicate Phone Number',
          isAr
            ? `رقم الهاتف "${duplicatePhone.phone}" مسجّل بالفعل للعميل "${duplicatePhone.customerName}". الرجاء استخدام رقم آخر.`
            : `The phone number "${duplicatePhone.phone}" is already linked to customer "${duplicatePhone.customerName}". Use that existing customer instead of creating another.${isCurrentUserAdmin() ? ' To combine old duplicates, close this form and choose Find duplicates on the Customers page.' : ''}`,
          'error'
        );
        return; // Stop here, don't close modal
      }

      // Collect all profile links
      const linkInputs = document.querySelectorAll('.customer-link');
      const profileLinks = Array.from(linkInputs).map(input => input.value.trim()).filter(l => l);

      // Get join date
      const joinDateValue = document.getElementById('customer-joindate').value;
      const joinDate = joinDateValue ? new Date(joinDateValue).toISOString() : new Date().toISOString();

      if (isEdit) {
        const customerSaved = await updateRecord(state.customers, state.modalData.id, {
          name: custName,
          phones: phones,
          platform: document.getElementById('customer-platform').value,
          joinDate: joinDate,
          profileLinks: profileLinks
        });
        if (!customerSaved) return;
        showNotification(isAr ? 'تم التحديث' : 'Updated', isAr ? 'تم تحديث العميل بنجاح' : 'Customer updated successfully', 'success');
      } else {
        const customer = {
          id: generateId('cust'),
          name: custName,
          phones: phones,
          platform: document.getElementById('customer-platform').value,
          joinDate: joinDate,
          profileLinks: profileLinks
        };
        const customerSaved = await addRecord(state.customers, customer);
        if (!customerSaved) return;
        showNotification(isAr ? 'تمت الإضافة' : 'Success', isAr ? 'تمت إضافة العميل بنجاح' : 'Customer added successfully', 'success');
      }
      break;
    }
    case 'ad':
      try {
      const isArSubAd = state.language === 'ar';
      if (_adPhotoUploadsInFlight > 0) {
        showNotification(
          isArSubAd ? 'جاري تجهيز الصور' : 'Preparing photos',
          isArSubAd ? 'انتظر لحظة حتى ينتهي تجهيز الصور، ثم احفظ الإعلان.' : 'Please wait for the photos to finish preparing, then save the ad.',
          'info'
        );
        return;
      }
      if (state.tempAdPhotosDirty && !canModifyAdPhotosInCurrentModal()) {
        showNotification(
          isArSubAd ? 'تم رفض الوصول' : 'Access Denied',
          isArSubAd ? 'لا يمكن تغيير صور إعلان محفوظ دون صلاحية عرض الصور ورفعها.' : 'Saved ad photos cannot be changed without both View Photos and Upload Photos permissions.',
          'error'
        );
        return;
      }
      const paymentStatus = document.getElementById('ad-payment-status')?.value || 'paid';
      const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
      const isUnpaidDriver = paymentStatus === 'not_paid' && collectionMethod === 'driver';
      const isUnpaidShop = paymentStatus === 'not_paid' && collectionMethod === 'in_shop';
      const selectedUnpaidReceiptId = String(document.getElementById('ad-linked-receipt-id')?.value || '').trim();
      const adLinkInputs = Array.from(document.querySelectorAll('.ad-link-input')).map(i => (i.value || '').trim()).filter(Boolean);
      
      // Get amount based on payment status
      let amountUSD = 0;
      let collectionPayments = [];
      if (paymentStatus === 'paid') {
        // For paid ads, calculate amount from receipt allocations planned spend
        const allocations = (state.tempAdFunding?.allocations || []).filter(a => a.receiptId && parseFloat(a.amountUSD) > 0);
        amountUSD = allocations.reduce((sum, a) => sum + parseFloat(a.amountUSD), 0);
      } else if (isUnpaidDriver) {
        // A driver-collected ad can be pure debt before any receipt money is
        // available. Its budget is independent from optional receipt funding.
        amountUSD = normalizeAdDriverBudgetUSD(document.getElementById('ad-driver-budget-usd')?.value);
      } else if (isUnpaidShop && selectedUnpaidReceiptId) {
        // The linked unpaid receipt is the source of this ad's promised budget.
        // It is reserved below as due credit and counts as customer debt now.
        amountUSD = normalizeAdDriverBudgetUSD(document.getElementById('ad-due-amount-to-use')?.value);
      } else {
        // Use financial details (R2 totals) for Not Paid / Won't Pay
        collectionPayments = getReceiptPaymentData();
        const totals = getPaymentTotalsFromDom();
        amountUSD = totals.totalR2;
      }
      
      // #ad-rate does NOT exist in the ad modal template — reading it always
      // fell through to the CURRENT global default, so every save silently
      // rewrote a saved ad's exchangeRate (and any LYD figure derived from it)
      // with today's market rate instead of the rate the ad was created at.
      // Keep the ad's own stored rate on edit; use the default only for a new ad.
      let exchangeRate = parseFloat(
        (isEdit && Number.isFinite(Number(state.modalData?.exchangeRate)) && Number(state.modalData.exchangeRate) > 0)
          ? state.modalData.exchangeRate
          : state.defaultExchangeRate
      );
      const isPaid = paymentStatus === 'paid';
      // These three inputs do NOT exist in the ad modal template. Reading them
      // always yielded false/undefined, which on EDIT erased spentUSD /
      // extraTimeMinutes and reset the office-handover flag. Preserve the
      // existing record's values instead (create leaves modalData null, so a
      // new ad still gets the correct defaults).
      const isReceived = state.modalData?.isReceivedInOffice || false;
      const spentUSD = state.modalData?.spentUSD;
      const extraTime = state.modalData?.extraTimeMinutes;
      const startDate = document.getElementById('ad-start-date')?.value;
      const endDate = document.getElementById('ad-end-date')?.value;
      const days = parseInt(document.getElementById('ad-days')?.value) || undefined;
      
      // Get page ID
      const pageId = document.getElementById('ad-page')?.value || '';
      if (!pageId) {
        showNotification(isArSubAd ? 'خطأ' : 'Error', isArSubAd ? 'الرجاء اختيار صفحة' : 'Please select a page', 'error');
        return;
      }
      
      // Get customer ID from searchable dropdown hidden field
      const customerId = document.getElementById('ad-customer-id')?.value;
      if (!customerId) {
        showNotification(isArSubAd ? 'خطأ' : 'Error', isArSubAd ? 'الرجاء اختيار عميل' : 'Please select a customer', 'error');
        return;
      }

      // Normalize amount for unpaid flows; paid flows rely on receipt allocations
      if (paymentStatus !== 'paid' && !Number.isFinite(amountUSD)) {
        amountUSD = 0;
      }

      if (isUnpaidDriver && amountUSD <= 0) {
        showNotification(
          isArSubAd ? 'تنبيه' : 'Validation',
          isArSubAd ? 'أدخل ميزانية إعلان أكبر من صفر.' : 'Enter an ad budget greater than zero.',
          'error'
        );
        return;
      }
      if (isUnpaidShop && selectedUnpaidReceiptId && amountUSD <= 0) {
        showNotification(
          isArSubAd ? 'تنبيه' : 'Validation',
          isArSubAd ? 'أدخل ميزانية الإعلان من الوصل غير المدفوع.' : 'Enter the ad budget from the unpaid receipt.',
          'error'
        );
        return;
      }

      // Validate funding allocations (only required when paid)
      let allocations = (state.tempAdFunding?.allocations || []).filter(a => a.receiptId && parseFloat(a.amountUSD) > 0)
        .map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) }));

      if (isPaid && allocations.length === 0) {
        showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الرجاء ربط وصل واحد على الأقل لتمويل هذا الإعلان.' : 'Please link at least one receipt to fund this ad.', 'error');
        return;
      }

      // Planned spend vs receipt remaining check (only when paid)
      if (isPaid) {
        // Sum allocations per receipt (prevents over-allocation if the same receipt is selected twice).
        const totalsByReceipt = new Map();
        let totalAllocated = 0;
        for (const alloc of allocations) {
          const rid = String(alloc.receiptId || '');
          if (!rid) continue;
          const allocAmount = parseFloat(alloc.amountUSD) || 0;
          totalsByReceipt.set(rid, (totalsByReceipt.get(rid) || 0) + allocAmount);
          totalAllocated += allocAmount;
        }

        // Validate total allocations make sense (should be > 0)
        if (totalAllocated <= 0) {
          showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'إجمالي مبلغ التخصيص يجب أن يكون أكبر من صفر.' : 'Total allocation amount must be greater than zero.', 'error');
          return;
        }

        // Set amountUSD from allocations total for paid ads (ensures consistency)
        const settlingUnpaidDebt = isEdit
          && getAdPaymentState(state.modalData) === 'not_paid';
        const originalUnpaidBudget = normalizeAdDriverBudgetUSD(state.modalData?.amountUSD);
        if (settlingUnpaidDebt && originalUnpaidBudget > 0 && Math.abs(totalAllocated - originalUnpaidBudget) > 0.005) {
          showNotification(
            isArSubAd ? 'تنبيه' : 'Validation',
            isArSubAd
              ? `يجب أن يساوي مجموع تمويل الوصولات ($${totalAllocated.toFixed(2)}) مبلغ الإعلان غير المدفوع ($${originalUnpaidBudget.toFixed(2)}).`
              : `Receipt funding ($${totalAllocated.toFixed(2)}) must equal the unpaid ad amount ($${originalUnpaidBudget.toFixed(2)}).`,
            'error'
          );
          return;
        }
        amountUSD = totalAllocated;

        for (const [receiptId, plannedTotal] of totalsByReceipt.entries()) {
          const receipt = state.receipts.find(r => String(r.id) === String(receiptId));
          // Soft-deleted receipts stay in state.receipts with _deleted=true —
          // money can NOT be drawn from a deleted receipt (a stale open modal
          // could still reference one deleted meanwhile on another device).
          if (!receipt || receipt._deleted) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'أحد الوصولات المختارة مفقود أو تم حذفه.' : 'One of the selected receipts is missing or was deleted.', 'error');
            return;
          }
          if (String(receipt.customerId || '') !== String(customerId || '')) {
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              isArSubAd
                ? 'لا يمكن تمويل الإعلان من وصل يخص عميلاً آخر. اختر وصلاً مدفوعاً لهذا العميل.'
                : "An ad cannot be funded from another customer's receipt. Choose a Paid receipt for this customer.",
              'error'
            );
            return;
          }
          const receiptPaymentState = typeof getReceiptPaymentState === 'function'
            ? getReceiptPaymentState(receipt)
            : ((receipt.isPaid === true || String(receipt.status || '').trim().toLowerCase() === 'paid') ? 'paid' : 'not_paid');
          if (receiptPaymentState !== 'paid') {
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              isArSubAd
                ? 'الوصل الحالي لم يعد صالحاً للتمويل. اختر وصلاً مدفوعاً بديلاً.'
                : 'The current receipt is no longer eligible. Choose a Paid replacement receipt.',
              'error'
            );
            return;
          }
          // Calculate remaining balance (total - used - transferred)
          const usageStats = getReceiptUsageStats(receipt);
          let remaining = usageStats.remainingUSD || 0;

          // If editing, add back what this ad already allocated from this receipt
          if (isEdit && state.modalData?.id) {
            // This includes the ad's current due allocation when converting a
            // Driver debt to Paid. The server replaces those rows atomically,
            // so the current ad must not block its own settlement receipt.
            remaining += getEditingAdExistingAllocationUSD(receiptId);
          }

          if (plannedTotal > remaining + 0.0001) {
            const shortfall = Math.max(plannedTotal - remaining, 0);
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              isArSubAd
                ? `مبلغ الإعلان لم يتغير. ينقص الوصل ${receipt.serialNumber || receipt.id} مبلغ $${shortfall.toFixed(2)}. أضف وصلاً ثانياً أو اختر وصلاً برصيد كافٍ.`
                : `The ad amount was not changed. Receipt ${receipt.serialNumber || receipt.id} is short by $${shortfall.toFixed(2)}. Add a second receipt or choose one with enough balance.`,
              'error'
            );
            return;
          }
        }
      } else {
        // Not paid / won't pay → no allocations are applied
        allocations = [];
      }

      // Additional validation when not paid
      if (paymentStatus === 'not_paid') {
        if (!collectionMethod) {
          showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الرجاء اختيار طريقة تحصيل الدفع.' : 'Please choose how payment will be collected.', 'error');
          return;
        }
        if (collectionMethod === 'driver') {
          const linkedReceiptId = document.getElementById('ad-linked-receipt-id')?.value || '';
          if (!linkedReceiptId) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'اختر وصل توصيل مؤقت معلق (D#) أو أنشئ واحداً أولاً.' : 'Select a pending Temporary Delivery Receipt (D#) or create one first.', 'error');
            return;
          }
          const linkedReceipt = state.receipts.find(r => r && !r._deleted && String(r.id) === String(linkedReceiptId));
          if (!linkedReceipt || !isTempDeliveryReceiptNo(linkedReceipt.tempReceiptNo)) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الوصل المختار ليس وصل توصيل مؤقتاً معلقاً صالحاً.' : 'Selected receipt is not a valid pending Temporary Delivery Receipt.', 'error');
            return;
          }
          if (String(linkedReceipt.customerId || '') !== String(customerId || '')) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الوصل المختار يخص عميلاً آخر.' : 'Selected receipt belongs to a different customer.', 'error');
            return;
          }
          const ds = String(linkedReceipt.deliveryStatus || '');
          if (ds === 'Delivered' || ds === 'Office' || ds === 'Canceled') {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الوصل المختار لم يعد معلقاً للتوصيل. الرجاء اختيار وصل آخر.' : 'Selected receipt is not pending delivery anymore. Please choose another one.', 'error');
            return;
          }
          const assignedDriver = String(linkedReceipt.deliveryPersonId || '').trim();
          // Delivery assignment must come from the receipt (single source of truth).
          if (!assignedDriver) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'هذا الوصل بلا سائق معيّن. الرجاء تعيين سائق في الوصل أولاً.' : 'This receipt has no assigned driver. Please assign a driver in the Receipt first.', 'error');
            return;
          }

          // The receipt is the source of truth for driver assignment and rate.
          // The ad budget remains independent so an unfunded ad can be debt.
          const rRate = Number(linkedReceipt.exchangeRate || 0) || 0;
          if (rRate > 0) exchangeRate = rRate;
          collectionPayments = [];
        } else if (collectionMethod === 'in_shop' && selectedUnpaidReceiptId) {
          const linkedReceipt = state.receipts.find(r => r && !r._deleted && String(r.id) === selectedUnpaidReceiptId);
          if (!linkedReceipt) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الوصل غير المدفوع المحدد غير موجود.' : 'The selected unpaid receipt was not found.', 'error');
            return;
          }
          if (String(linkedReceipt.customerId || '') !== String(customerId || '')) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'الوصل المحدد يخص عميلاً آخر.' : 'Selected receipt belongs to a different customer.', 'error');
            return;
          }
          if (!isUnpaidShopReceipt(linkedReceipt, customerId)) {
            const becamePaid = linkedReceipt.isPaid === true || String(linkedReceipt.status || '') === 'Paid';
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              becamePaid
                ? (isArSubAd ? 'تم دفع هذا الوصل الآن. غيّر حالة الإعلان إلى «مدفوع» لإكمال التسوية.' : 'This receipt is now Paid. Change the ad to Paid to complete settlement.')
                : (isArSubAd ? 'الوصل المحدد ليس وصلاً صالحاً غير مدفوع في المحل.' : 'Selected receipt is not a valid unpaid In-Shop receipt.'),
              'error'
            );
            return;
          }
          const rRate = Number(linkedReceipt.exchangeRate || 0) || 0;
          if (rRate > 0) exchangeRate = rRate;
          collectionPayments = [];
        }
      }
      
      // Capture the promised amount from a linked unpaid receipt. Delivery uses
      // linkedDeliveryReceiptId; In Shop uses receiptId while sharing the same
      // due-allocation ledger so neither can spend receipt money twice.
      let dueAmountToUseUSD = 0;
      let linkedDeliveryReceiptId = '';
      let dueAllocations = [];
      if (paymentStatus === 'not_paid' && (collectionMethod === 'driver' || (collectionMethod === 'in_shop' && selectedUnpaidReceiptId))) {
        const linkedReceiptId = selectedUnpaidReceiptId;
        linkedDeliveryReceiptId = collectionMethod === 'driver' ? linkedReceiptId : '';
        const dueInput = document.getElementById('ad-due-amount-to-use');
        if (dueInput && linkedReceiptId) {
          dueAmountToUseUSD = parseFloat(dueInput.value) || 0;
          // The validation branches above intentionally keep their receipt
          // variables block-scoped. Resolve the selected receipt again here so
          // edit add-back never depends on an out-of-scope `linkedReceipt`.
          const selectedDueReceipt = state.receipts.find(
            receipt => receipt && !receipt._deleted && String(receipt.id || '') === String(linkedReceiptId)
          );
          
          // Validate: check if the amount exceeds available credit
          const dueUsage = getDeliveryReceiptDueUsage(linkedReceiptId);
          const availableUSD = dueUsage.remainingDueUSD;
          
          // If editing an existing ad, add back what this ad already used
          let currentAdUsage = 0;
          if (isEdit && state.modalData?.id) {
            const existingAd = state.ads.find(a => a.id === state.modalData.id);
            if (existingAd) {
              const explicitDueForReceipt = Array.isArray(existingAd.dueAllocations)
                ? existingAd.dueAllocations
                    .filter(a => String(a?.receiptId || '') === String(linkedReceiptId))
                    .reduce((sum, a) => sum + (parseFloat(a?.amountUSD) || 0), 0)
                : 0;
              currentAdUsage = explicitDueForReceipt > 0
                ? explicitDueForReceipt
                : getAdLegacyDueMirrorUSD(existingAd, linkedReceiptId, selectedDueReceipt?.exchangeRate);
            }
          }
          
          const effectiveAvailable = availableUSD + currentAdUsage;
          
          if (dueAmountToUseUSD > effectiveAvailable + 0.01) {
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              isArSubAd
                ? `صرف الرصيد المستحق ($${dueAmountToUseUSD.toFixed(2)}) يتجاوز المتاح ($${effectiveAvailable.toFixed(2)}).`
                : `Due credit spend ($${dueAmountToUseUSD.toFixed(2)}) exceeds available ($${effectiveAvailable.toFixed(2)}).`,
              'error'
            );
            return;
          }
          
          // Create due allocation
          if (dueAmountToUseUSD > 0) {
            dueAllocations.push({
              receiptId: linkedReceiptId,
              amountUSD: dueAmountToUseUSD
            });
          }
        }
      }
      
      // Capture real paid receipt allocations mixed into a Not Paid ad. Driver
      // and In Shop share the same safe UI working state; the server stores
      // In Shop rows canonically in receiptAllocations (without a legacy mirror).
      let mergedAllocations = [];
      if (paymentStatus === 'not_paid'
          && (collectionMethod === 'driver' || collectionMethod === 'in_shop')
          && state.tempMergeFunding?.enabled) {
        mergedAllocations = (state.tempMergeFunding.allocations || [])
          .filter(a => a.receiptId && parseFloat(a.amountUSD) > 0)
          .map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) }));
        
        // Validate merged allocations don't exceed receipt remaining.
        // MONEY-MATH: aggregate per receipt FIRST (mirrors the paid path above).
        // Checking row-by-row let two rows that pick the SAME receipt each pass
        // individually while their sum over-drew the receipt, and the edit
        // add-back was applied once per duplicate row, widening the gap.
        const mergedTotalsByReceipt = new Map();
        for (const alloc of mergedAllocations) {
          const rid = String(alloc.receiptId || '');
          if (!rid) continue;
          mergedTotalsByReceipt.set(rid, (mergedTotalsByReceipt.get(rid) || 0) + (parseFloat(alloc.amountUSD) || 0));
        }
        for (const [rid, plannedTotal] of mergedTotalsByReceipt.entries()) {
          const receipt = state.receipts.find(r => String(r.id) === rid);
          // Soft-deleted receipts stay in state.receipts with _deleted=true —
          // money can NOT be drawn from a deleted receipt.
          if (!receipt || receipt._deleted) {
            showNotification(isArSubAd ? 'تنبيه' : 'Validation', isArSubAd ? 'أحد الوصولات المدمجة مفقود أو تم حذفه.' : 'One of the merged receipts is missing or was deleted.', 'error');
            return;
          }
          // A receipt belongs to ONE customer — an ad may never be funded from
          // another customer's money (the merged rows survived a customer change).
          if (String(receipt.customerId || '') !== String(customerId || '')) {
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              isArSubAd
                ? 'لا يمكن تمويل الإعلان من وصل عميل آخر. أزل الوصولات المدمجة غير المطابقة.'
                : "An ad cannot be funded from another customer's receipt. Remove the mismatched merged receipts.",
              'error'
            );
            return;
          }
          const usageStats = getReceiptUsageStats(receipt);
          let remaining = usageStats.remainingUSD || 0;
          // If editing, add back what this ad already merged from this receipt
          // (mirrors the paid path) so re-saving the same amount is allowed —
          // applied ONCE per receipt, not once per duplicate row.
          if (isEdit && state.modalData?.id) {
            const existingAd = state.ads.find(a => a.id === state.modalData.id);
            const src = existingAd?.mergedPaidAllocations || existingAd?.receiptAllocations;
            if (Array.isArray(src)) {
              remaining += src
                .filter(a => String(a.receiptId) === rid)
                .reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
            }
          }
          if (plannedTotal > remaining + 0.0001) {
            showNotification(
              isArSubAd ? 'تنبيه' : 'Validation',
              isArSubAd
                ? `الصرف المدمج ($${plannedTotal.toFixed(2)}) يتجاوز الرصيد المتاح ($${remaining.toFixed(2)}) للوصل ${receipt.serialNumber || receipt.id}.`
                : `Merged spend ($${plannedTotal.toFixed(2)}) exceeds available balance ($${remaining.toFixed(2)}) for receipt ${receipt.serialNumber || receipt.id}.`,
              'error'
            );
            return;
          }
        }
      }
      
      // Combine allocations: merged paid receipts for Not Paid + Driver mode
      // For paid mode, use regular allocations
      const finalAllocations = isPaid ? allocations : mergedAllocations;
      const mergedTotal = mergedAllocations.reduce(
        (sum, a) => sum + (parseFloat(a.amountUSD) || 0),
        0
      );

      if (isUnpaidShop && selectedUnpaidReceiptId) {
        amountUSD = Math.round((dueAmountToUseUSD + mergedTotal) * 100) / 100;
        const intendedBudget = normalizeAdDriverBudgetUSD(state.tempMixedReceiptTargetUSD);
        if (intendedBudget > 0 && Math.abs(amountUSD - intendedBudget) > 0.005) {
          showNotification(
            isArSubAd ? 'تنبيه' : 'Validation',
            isArSubAd
              ? `الوصل غير المدفوع لا يغطي الفرق كاملاً. التمويل الحالي $${amountUSD.toFixed(2)} من الميزانية المطلوبة $${intendedBudget.toFixed(2)}. اختر وصلاً آخر أو أدخل ميزانية أصغر.`
              : `The unpaid receipt does not cover the full difference. Current funding is $${amountUSD.toFixed(2)} of the intended $${intendedBudget.toFixed(2)}. Choose another receipt or enter a smaller budget.`,
            'error'
          );
          return;
        }
      }
      
      // Receipt funding can cover some/all of the budget, but can never redefine
      // or exceed it. Any unfunded remainder is customer debt until payment.
      if (isUnpaidDriver) {
        const fundedTotal = dueAmountToUseUSD + mergedTotal;
        if (fundedTotal > amountUSD + 0.005) {
          showNotification(
            isArSubAd ? 'تنبيه' : 'Validation',
            isArSubAd
              ? `إجمالي التمويل ($${fundedTotal.toFixed(2)}) أكبر من ميزانية الإعلان ($${amountUSD.toFixed(2)}).`
              : `Receipt funding ($${fundedTotal.toFixed(2)}) exceeds the ad budget ($${amountUSD.toFixed(2)}).`,
            'error'
          );
          return;
        }
      }
      
      const adUpdates = {
        customerId: customerId,
        pageId: pageId,
        amountUSD,
        exchangeRate,
        amountLocal: amountUSD * exchangeRate,
        paymentMethod: (isPaid ? '' : (collectionPayments[0]?.method || '')) || '',
        status: state.modalData?.status || 'Active',
        // If Not Paid + Driver AND linked to a temp delivery receipt, the delivery is tracked on the receipt (not on the ad),
        // so we keep the ad out of the Delivery dashboard to avoid duplicates.
        deliveryStatus: (paymentStatus === 'not_paid' && collectionMethod === 'driver') ? 'Office' : (state.modalData?.deliveryStatus || 'Office'),
        deliveryPersonId: (paymentStatus === 'not_paid' && collectionMethod === 'driver') ? '' : (state.modalData?.deliveryPersonId || ''),
        receiptId: resolveAdPrimaryReceiptId({
          paymentStatus,
          collectionMethod,
          linkedDeliveryReceiptId,
          allocations: finalAllocations,
          dueAllocations
        }),
        paymentStatus,
        collectionMethod,
        adLinks: adLinkInputs,
        adLink: adLinkInputs[0] || '',
        adPhotos: state.tempAdPhotos || [],
        collectionPayments: (paymentStatus === 'paid') ? [] : collectionPayments,
        days,
        isPaid,
        isReceivedInOffice: isReceived,
        spentUSD,
        extraTimeMinutes: extraTime,
        startDate: startDate ? new Date(startDate).toISOString() : new Date().toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : new Date().toISOString(),
        receiptAllocations: finalAllocations,
        receiptIds: finalAllocations.map(a => a.receiptId),
        fundingReceiptId: finalAllocations[0]?.receiptId || '',
        // Due rows reserve promised money from either a delivery receipt or an
        // unpaid In Shop receipt without pretending it has already been paid.
        dueAmountToUseUSD: dueAmountToUseUSD,
        dueAllocations: dueAllocations,
        linkedDeliveryReceiptId: linkedDeliveryReceiptId,
        hasMergedPaidFunds: collectionMethod === 'driver' && mergedAllocations.length > 0,
        mergedPaidAllocations: collectionMethod === 'driver' ? mergedAllocations : []
      };

      // Ordinary edits do not need to re-upload unchanged base64 images. Both
      // the generic local update and the atomic server mutation merge omitted
      // fields over the stored record. Sending [] remains an intentional clear.
      if (isEdit && !state.tempAdPhotosDirty) {
        delete adUpdates.adPhotos;
      } else if (isEdit) {
        adUpdates.photos = []; // clear the legacy field after an intentional edit
      }

      // Re-baseline the top-up arithmetic. saveTopUps derives the ad's amount
      // and end date from initialAmountUSD/initialEndDate + the top-ups. Those
      // baselines are written ONLY by saveTopUps, so an amount/end-date edited
      // here was silently REVERTED by the next top-up save (and the funding
      // receipt re-charged). Rebase them off what we are saving now.
      if (isEdit && Array.isArray(state.modalData?.topUps) && state.modalData.topUps.length > 0) {
        const topUpUSD = state.modalData.topUps.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
        const topUpDays = state.modalData.topUps.reduce((s, t) => s + (parseInt(t.extendDays, 10) || 0), 0);
        adUpdates.initialAmountUSD = Math.max(0, Math.round((amountUSD - topUpUSD) * 100) / 100);
        const endMs = new Date(adUpdates.endDate).getTime();
        if (!Number.isNaN(endMs)) {
          adUpdates.initialEndDate = new Date(endMs - topUpDays * 86400000).toISOString();
        }
      }

      // Liquidity window integrity: growing an ad's budget in an ORDINARY
      // edit spends money exactly like a top-up but writes no dated row.
      // Record the growth in an append-only ledger so the liquidity window
      // can count in-window growth of pre-window ads (capped at real spend
      // when read; shrinking an ad is never recorded — money returning is
      // handled by refunds).
      if (isEdit) {
        const priorAmountUSD = parseFloat(state.modalData?.amountUSD) || 0;
        const growthUSD = Math.round((amountUSD - priorAmountUSD) * 100) / 100;
        if (growthUSD > 0.005) {
          const priorAdjustments = Array.isArray(state.modalData?.amountAdjustments)
            ? state.modalData.amountAdjustments
            : [];
          adUpdates.amountAdjustments = [
            ...priorAdjustments.map(row => ({ ...row })),
            { delta: growthUSD, date: new Date().toISOString() }
          ];
        }
      }

      if (isPaid && (!state.modalData || !state.modalData.collectionDate)) {
        adUpdates.collectionDate = new Date().toISOString();
      }
      
      if (isEdit) {
        // Track changes for edit history
        const oldAd = state.modalData;
        const changes = [];
        
        // Fields to track for changes
        const fieldsToTrack = [
          { key: 'customerId', label: 'Customer', format: (v) => state.customers.find(c => c.id === v)?.name || v },
          { key: 'pageId', label: 'Page', format: (v) => state.pages.find(p => p.id === v)?.name || v },
          { key: 'amountUSD', label: 'Amount (USD)', format: (v) => `$${parseFloat(v || 0).toFixed(2)}` },
          { key: 'amountLocal', label: 'Amount (LYD)', format: (v) => `${parseFloat(v || 0).toFixed(2)} LYD` },
          { key: 'exchangeRate', label: 'Exchange Rate', format: (v) => parseFloat(v || 0).toFixed(2) },
          { key: 'paymentStatus', label: 'Payment Status', format: (v) => v || 'paid' },
          { key: 'deliveryStatus', label: 'Delivery Status', format: (v) => v || 'Office' },
          { key: 'status', label: 'Ad Status', format: (v) => v || 'Active' },
          { key: 'startDate', label: 'Start Date', format: (v) => v ? new Date(v).toLocaleDateString(appDateLocale()) : 'N/A' },
          { key: 'endDate', label: 'End Date', format: (v) => v ? new Date(v).toLocaleDateString(appDateLocale()) : 'N/A' }
        ];
        
        fieldsToTrack.forEach(field => {
          const oldVal = oldAd[field.key];
          const newVal = adUpdates[field.key];
          if (String(oldVal || '') !== String(newVal || '')) {
            changes.push({
              field: field.label,
              from: field.format(oldVal),
              to: field.format(newVal)
            });
          }
        });
        
        // Track receipt allocations changes
        const oldAllocations = oldAd.receiptAllocations || [];
        const newAllocations = allocations || [];
        if (JSON.stringify(oldAllocations) !== JSON.stringify(newAllocations)) {
          changes.push({
            field: 'Receipt Funding',
            from: `${oldAllocations.length} allocation(s) • $${oldAllocations.reduce((s, a) => s + parseFloat(a.amountUSD || 0), 0).toFixed(2)}`,
            to: `${newAllocations.length} allocation(s) • $${newAllocations.reduce((s, a) => s + parseFloat(a.amountUSD || 0), 0).toFixed(2)}`
          });
        }
        
        // Track ad links changes
        const oldLinks = oldAd.adLinks || (oldAd.adLink ? [oldAd.adLink] : []);
        const newLinks = adLinkInputs || [];
        if (JSON.stringify(oldLinks) !== JSON.stringify(newLinks)) {
          changes.push({
            field: 'Ad Links',
            from: `${oldLinks.length} link(s)`,
            to: `${newLinks.length} link(s)`
          });
        }
        
        // Add to edit history if there are changes
        if (changes.length > 0) {
          const editHistory = oldAd.editHistory || [];
          editHistory.push({
            editedAt: new Date().toISOString(),
            editedBy: state.currentUser?.name || 'Unknown',
            changes: changes
          });
          adUpdates.editHistory = editHistory;
          adUpdates.editCount = editHistory.length;
          adUpdates.updatedAt = new Date().toISOString();
        } else {
          adUpdates.editHistory = oldAd.editHistory || [];
          adUpdates.editCount = oldAd.editCount || 0;
        }
        
        if (isServerModeEnabled()) {
          const expectedLastModified = Number(oldAd?._lastModified);
          await saveAdThroughAtomicServer(
            'update',
            oldAd.id,
            expectedLastModified,
            buildServerAdMutationData(adUpdates)
          );
        } else {
          const adSaved = await updateRecord(state.ads, state.modalData.id, adUpdates);
          if (!adSaved) return;
        }
        showNotification(state.language === 'ar' ? 'تم التحديث' : 'Updated', state.language === 'ar' ? 'تم تحديث الإعلان بنجاح' : 'Ad updated successfully', 'success');
        addLog('update', 'ad', state.modalData.id, `Updated ad with ${allocations.length} receipt link(s)`);
      } else {
        let savedAd;
        if (isServerModeEnabled()) {
          savedAd = await saveAdThroughAtomicServer(
            'create',
            '',
            null,
            buildServerAdMutationData(adUpdates, { create: true })
          );
        } else {
          const ad = {
            id: generateId('ad'),
            recordType: 'ad',
            creatorId: state.currentUser?.id || '',
            createdAt: new Date().toISOString(),
            topUps: [],
            ...adUpdates
          };
          const adSaved = await addRecord(state.ads, ad);
          if (!adSaved) return;
          savedAd = state.ads.find(row => row && String(row.id) === String(ad.id)) || ad;
        }
        showNotification(state.language === 'ar' ? 'تمت الإضافة' : 'Success', state.language === 'ar' ? 'تم إنشاء الإعلان بنجاح' : 'Ad created successfully', 'success');
        addLog('create', 'ad', savedAd.id, `Created ad with ${allocations.length} receipt link(s)`);
        
        // Log receipt usage for each allocation
        if (isPaid && allocations.length > 0) {
          for (const alloc of allocations) {
            addAuditLog('receipt', alloc.receiptId, 'usage', `Ad ${savedAd.id} allocated $${alloc.amountUSD.toFixed(2)}`, {
              adId: savedAd.id,
              amountUSD: alloc.amountUSD,
              receiptId: alloc.receiptId
            });
          }
        }
      }
      
      // Clear temp state
      state.tempAdFunding = { allocations: [] };
      state.tempAdPhotos = [];
      
      // Close modal
      closeModal();
      } catch (error) {
        console.error('Error saving ad:', error);
        const conflict = error?.status === 409;
        showNotification(
          conflict ? (state.language === 'ar' ? 'تعارض في التعديل' : 'Ad Changed') : (state.language === 'ar' ? 'خطأ' : 'Error'),
          conflict
            ? (state.language === 'ar' ? 'تم تغيير هذا الإعلان من مستخدم آخر. حدّث البيانات ثم أعد المحاولة.' : 'This ad changed on another device. Refresh the data, then try again.')
            : (state.language === 'ar' ? `فشل حفظ الإعلان: ${error.message}` : `Failed to save ad: ${error.message}`),
          conflict ? 'warning' : 'error'
        );
      }
      break;
    case 'user':
      const isArSubU = state.language === 'ar';
      const isAdminEditor = isCurrentUserAdmin();
      const editingId = state.modalData?.id;
      const isSelfEdit = !!(isEdit && editingId && String(state.currentUser?.id || '') === String(editingId));
      const canDoUserOp = isEdit ? (isSelfEdit || canManageUsersAction('edit')) : canManageUsersAction('add');
      if (!canDoUserOp) {
        showNotification(isArSubU ? 'تم رفض الوصول' : 'Access Denied', isArSubU ? 'لا تملك صلاحية إدارة المستخدمين' : 'You lack the required Users permission', 'error');
        return;
      }

      const roleEl = document.getElementById('user-role');
      let userRole = Security.sanitizeInput((roleEl ? roleEl.value : (state.modalData?.role || '')), { maxLength: 20 });
      // Only Admins / changeRole holders may alter roles; everyone else keeps the stored role.
      if (isEdit && !canManageUsersAction('changeRole')) userRole = state.modalData?.role || userRole;
      // Anti-escalation: only a real Admin can create or promote to Admin.
      if (!isAdminEditor && isAdminRole(userRole)) {
        showNotification(isArSubU ? 'تم رفض الوصول' : 'Access Denied', isArSubU ? 'فقط المدير يمكنه منح دور المدير' : 'Only an Admin can grant the Admin role', 'error');
        return;
      }
      // Non-admins can never edit an Admin account.
      if (isEdit && !isSelfEdit && !isAdminEditor && isAdminRole(state.modalData?.role)) {
        showNotification(isArSubU ? 'تم رفض الوصول' : 'Access Denied', isArSubU ? 'فقط المدير يمكنه تعديل حساب مدير' : 'Only an Admin can modify an Admin account', 'error');
        return;
      }
      const userName = Security.sanitizeInput(document.getElementById('user-name').value, { maxLength: 100 });
      const userEmail = Security.sanitizeInput(document.getElementById('user-email').value, { maxLength: 120 }).toLowerCase();

      // sanitizeInput trims, but a whitespace-only name still satisfies the
      // HTML `required` attribute — reject it or a blank user gets saved.
      if (!userName) {
        showNotification(
          state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation Error',
          state.language === 'ar' ? 'الاسم مطلوب' : 'Name is required',
          'error'
        );
        return;
      }

      if (!Security.isValidEmail(userEmail)) {
        showNotification(
          state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation Error',
          state.language === 'ar' ? 'الرجاء إدخال بريد إلكتروني صحيح' : 'Please enter a valid email address',
          'error'
        );
        return;
      }

      // Email must be unique. In server mode the DB enforces this (returns 409),
      // but in local mode nothing did — a duplicate email meant login always
      // resolved to the FIRST matching user, permanently locking the other user
      // out of their own account. Reject a duplicate against any other
      // non-deleted user (excluding the one being edited).
      {
        const _editingUserId = state.modalData?.id;
        const dup = (state.users || []).some(u =>
          u && !u._deleted &&
          String(u.id) !== String(_editingUserId || '') &&
          String(u.email || '').toLowerCase() === userEmail
        );
        if (dup) {
          showNotification(
            state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation Error',
            state.language === 'ar' ? 'هذا البريد الإلكتروني مستخدم بالفعل' : 'This email is already in use',
            'error'
          );
          return;
        }
      }

      // Get default permissions based on role
      const getDefaultPermissions = (role) => {
        switch (role) {
          case 'Admin':
            return {}; // Admins get all permissions automatically
          case 'Delivery':
            return PERMISSION_TEMPLATES.deliveryDriver.permissions;
          case 'Employee': {
            const presetKey = String(document.getElementById('user-access-preset')?.value || window._newUserAccessPreset || 'salesAgent');
            const preset = PERMISSION_TEMPLATES[presetKey] || PERMISSION_TEMPLATES.salesAgent;
            return preset.permissions;
          }
          default:
            return PERMISSION_TEMPLATES.viewer.permissions;
        }
      };
      
      // SERVER MODE: users are managed by backend (permission-gated there too)
      if (isServerModeEnabled()) {
      if (isEdit) {
          const payload = {
            name: userName,
            email: userEmail,
          role: userRole
        };
        const newPassword = document.getElementById('user-password').value;
          if (newPassword) {
            if (String(newPassword).length < 8) {
              showNotification(isArSubU ? 'خطأ في الإدخال' : 'Validation Error', isArSubU ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
              return;
            }
            if (isSelfEdit && !isAdminEditor) {
              // Server requires the current password for self-changes.
              showNotification(isArSubU ? 'غير مدعوم هنا' : 'Not Supported Here', isArSubU ? 'لتغيير كلمة مرورك استخدم الإعدادات ← تغيير كلمة المرور' : 'To change your own password use Settings → Change Password', 'info');
            } else {
              payload.password = newPassword;
            }
          }

          // Role-based permissions defaults
          const oldRole = state.modalData.role;
          if (oldRole !== userRole) {
            if (isAdminRole(userRole)) {
              payload.permissions = {};
            } else if (isAdminRole(oldRole)) {
              payload.permissions = getDefaultPermissions(userRole);
            }
          }

          const updated = await apiUpdateUser(state.modalData.id, payload);
          const idx = state.users.findIndex(u => u.id === state.modalData.id);
          if (idx !== -1 && updated) {
            state.users[idx] = { ...state.users[idx], ...updated, _lastModified: Date.now(), _deleted: false };
            markCollectionDirty('users');
          }
          saveState();
          showNotification(isArSubU ? 'تم التحديث' : 'Updated', isArSubU ? 'تم تحديث المستخدم بنجاح' : 'User updated successfully', 'success');
        } else {
          const rawPassword = document.getElementById('user-password').value;
          if (!rawPassword || String(rawPassword).length < 8) {
            showNotification(isArSubU ? 'خطأ في الإدخال' : 'Validation Error', isArSubU ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
            return;
          }

          const payload = {
            name: userName,
            email: userEmail,
            password: rawPassword,
            role: userRole,
            permissions: getDefaultPermissions(userRole)
          };

          const created = await apiCreateUser(payload);
          if (created?.id) {
            state.users.unshift({ ...created, _lastModified: Date.now(), _deleted: false });
            markCollectionDirty('users');
            saveState();
            showNotification(isArSubU ? 'نجاح' : 'Success', isArSubU ? 'تمت إضافة المستخدم بنجاح' : 'User added successfully', 'success');

            if (!isAdminRole(userRole)) {
              setTimeout(() => showPermissionsModal(created.id), 500);
            }
          } else {
            showNotification(isArSubU ? 'خطأ' : 'Error', isArSubU ? 'فشل إنشاء المستخدم' : 'Failed to create user', 'error');
          }
        }
        break;
      }
      
      if (isEdit) {
        const updates = {
          name: userName,
          email: userEmail
        };
        if (isAdminEditor) {
          updates.role = userRole;
        }
        const newPassword = document.getElementById('user-password').value;
        if (newPassword) {
          if (String(newPassword).length < 8) {
            showNotification(isArSubU ? 'خطأ في الإدخال' : 'Validation Error', isArSubU ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
            return;
          }
          const hashed = await Security.hashPassword(newPassword, null, { algo: 'pbkdf2-sha256' });
          updates.passwordHash = hashed.hash;
          updates.salt = hashed.salt;
          updates.passwordAlgo = hashed.algo;
          updates.passwordIterations = hashed.iterations;
          // Never store plaintext
          delete updates.password;
        }
        
        // If role changed to Admin, clear custom permissions (they get all by default)
        // If role changed from Admin, set default permissions
        if (isAdminEditor) {
        const oldRole = state.modalData.role;
        if (oldRole !== userRole) {
          if (isAdminRole(userRole)) {
            updates.permissions = {};
          } else if (isAdminRole(oldRole)) {
            updates.permissions = getDefaultPermissions(userRole);
            }
          }
        }
        
        const userSaved = await updateRecord(state.users, state.modalData.id, updates);
        if (!userSaved) return;
        showNotification(isArSubU ? 'تم التحديث' : 'Updated', isArSubU ? 'تم تحديث المستخدم بنجاح' : 'User updated successfully', 'success');
      } else {
        if (!isAdminEditor) {
          showNotification(isArSubU ? 'تم رفض الوصول' : 'Access Denied', isArSubU ? 'إنشاء المستخدمين للأدمن فقط' : 'Admin only', 'error');
          return;
        }
        const rawPassword = document.getElementById('user-password').value;
        if (!rawPassword || String(rawPassword).length < 8) {
          showNotification(isArSubU ? 'خطأ في الإدخال' : 'Validation Error', isArSubU ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
          return;
        }
        const hashed = await Security.hashPassword(rawPassword, null, { algo: 'pbkdf2-sha256' });
        const user = {
          id: generateId('user'),
          name: userName,
          email: userEmail,
          passwordHash: hashed.hash,
          salt: hashed.salt,
          passwordAlgo: hashed.algo,
          passwordIterations: hashed.iterations,
          role: userRole,
          permissions: getDefaultPermissions(userRole)
        };
        const userSaved = await addRecord(state.users, user);
        if (!userSaved) return;
        showNotification(isArSubU ? 'نجاح' : 'Success', isArSubU ? 'تمت إضافة المستخدم بنجاح' : 'User added successfully', 'success');
        
        // Show permission modal for non-admin users
        if (!isAdminRole(userRole)) {
          setTimeout(() => {
            showPermissionsModal(user.id);
          }, 500);
        }
      }
      break;
    case 'page': {
      const isArPage = state.language === 'ar';
      // Whitespace-only input satisfies `required` — trim + check both fields.
      const pageName = document.getElementById('page-name').value.trim();
      const pageCategory = document.getElementById('page-category').value.trim();
      if (!pageName || !pageCategory) {
        showNotification(
          isArPage ? 'خطأ في الإدخال' : 'Validation Error',
          isArPage ? 'اسم الصفحة والفئة مطلوبان' : 'Page name and category are required',
          'error'
        );
        return;
      }

      // Duplicate-name guard (user request): a page whose name matches an
      // existing page (case-insensitive, ignoring the page being edited) is
      // BLOCKED for non-admins; an Admin gets an explicit approve-anyway
      // confirmation. Prevents accidental duplicates like two "albayan" pages.
      const editingPageId = isEdit ? String(state.modalData?.id || '') : '';
      const duplicatePage = (state.pages || []).find(p =>
        p && !p._deleted &&
        String(p.id) !== editingPageId &&
        String(p.name || '').trim().toLowerCase() === pageName.toLowerCase()
      );
      if (duplicatePage) {
        if (isCurrentUserAdmin()) {
          const approveMsg = isArPage
            ? `توجد صفحة أخرى بنفس الاسم "${pageName}".\n\nهل توافق (كأدمن) على استخدام نفس الاسم لصفحة أخرى؟`
            : `Another page named "${pageName}" already exists.\n\nDo you (as Admin) approve using the same name for another page?`;
          if (!confirm(approveMsg)) return;
        } else {
          showNotification(
            isArPage ? 'اسم مكرر' : 'Duplicate Name',
            isArPage
              ? `توجد صفحة بنفس الاسم "${pageName}" بالفعل. استخدام نفس الاسم يتطلب موافقة الأدمن.`
              : `A page named "${pageName}" already exists. Using the same name requires Admin approval.`,
            'error'
          );
          return;
        }
      }

      // Get selected customer IDs
      const selectedCustomers = Array.from(document.querySelectorAll('.page-customer-item'))
        .map(item => item.getAttribute('data-customer-id'));

      // Validate at least one customer
      if (selectedCustomers.length === 0) {
        showNotification(
          isArPage ? 'خطأ في الإدخال' : 'Validation Error',
          isArPage ? 'الرجاء اختيار عميل واحد على الأقل لربط الصفحة' : 'Please select at least one customer to link this page',
          'error'
        );
        return;
      }

      if (isEdit) {
        const pageSaved = await updateRecord(state.pages, state.modalData.id, {
          name: pageName,
          category: pageCategory,
          customerIds: selectedCustomers
        });
        if (!pageSaved) return;
        showNotification(isArPage ? 'تم التحديث' : 'Updated', isArPage ? 'تم تحديث الصفحة بنجاح' : 'Page updated successfully', 'success');
        addLog('update', 'page', state.modalData.id, `Updated page: ${pageName}`);
      } else {
        const page = {
          id: generateId('page'),
          name: pageName,
          category: pageCategory,
          customerIds: selectedCustomers,
          createdAt: new Date().toISOString(),
          _lastModified: Date.now(),
          _deleted: false
        };
        const pageSaved = await addRecord(state.pages, page);
        if (!pageSaved) return;
        showNotification(isArPage ? 'تمت الإضافة' : 'Success', isArPage ? 'تمت إضافة الصفحة بنجاح' : 'Page added successfully', 'success');
        addLog('create', 'page', page.id, `Created page: ${page.name} linked to ${selectedCustomers.length} customer(s)`);
      }
      break;
    }
    case 'receipt':
      const isArSubR = state.language === 'ar';
      const receiptAmountEl = document.getElementById('receipt-amount');
      const receiptRateEl = document.getElementById('receipt-rate');
      const receiptFeeEl = document.getElementById('receipt-fee');
      const receiptDiscountEl = document.getElementById('receipt-discount');
      if (!receiptAmountEl || !receiptRateEl) {
        showNotification(isArSubR ? 'خطأ' : 'Error', isArSubR ? 'عناصر نموذج الوصل غير موجودة' : 'Receipt form elements not found', 'error');
        return;
      }
      const receiptAmountUSD = parseFloat(receiptAmountEl.value);
      const receiptRate = parseFloat(receiptRateEl.value);
      const officeFee = parseFloat(receiptFeeEl?.value || '0') || 0;
      const discount = parseFloat(receiptDiscountEl?.value || '0') || 0;
      const localAmount = (receiptAmountUSD * receiptRate) + officeFee - discount;
      const receiptPaid = document.getElementById('receipt-paid').checked;
      const receiptOffice = document.getElementById('receipt-office').checked;
      const receiptImageInput = document.getElementById('receipt-image');
      const receiptImage = receiptImageInput?.dataset.imageData || receiptData.receiptImage || '';
      const receiptStartDate = document.getElementById('receipt-start-date').value;
      const receiptEndDate = document.getElementById('receipt-end-date').value;
      
      // Get customer ID from searchable dropdown hidden field
      const receiptCustomerId = document.getElementById('receipt-customer-id').value;
      if (!receiptCustomerId) {
        showNotification(isArSubR ? 'خطأ' : 'Error', isArSubR ? 'الرجاء اختيار عميل' : 'Please select a customer', 'error');
        return;
      }
      
      // Validate serial number: if editing and old receipt had a serial, new serial cannot be empty
      const newSerialNumber = (document.getElementById('receipt-serial').value || '').trim();
      const oldSerialNumber = isEdit ? (state.modalData?.serialNumber || '').trim() : '';
      
      if (isEdit && oldSerialNumber && !newSerialNumber) {
        showNotification(isArSubR ? 'خطأ في الإدخال' : 'Validation Error', isArSubR ? 'لا يمكن حذف رقم الوصل الموجود' : 'Cannot remove existing receipt serial number. Please enter a serial number.', 'error');
        return;
      }
      
      const receiptUpdates = {
        customerId: receiptCustomerId,
        pageId: document.getElementById('receipt-page')?.value || '',
        amountUSD: receiptAmountUSD,
        exchangeRate: receiptRate,
        amountLocal: localAmount,
        paymentMethod: document.getElementById('receipt-payment').value,
        status: document.getElementById('receipt-status').value,
        isPaid: receiptPaid,
        isReceivedInOffice: receiptOffice,
        serialNumber: newSerialNumber,
        officeFee: officeFee,
        discount: discount,
        phoneNumber: document.getElementById('receipt-phone').value || '',
        adLink: document.getElementById('receipt-ad-link').value || '',
        receiptImage: receiptImage,
        startDate: receiptStartDate ? new Date(receiptStartDate).toISOString() : new Date().toISOString(),
        endDate: receiptEndDate ? new Date(receiptEndDate).toISOString() : new Date().toISOString()
      };
      
      if (receiptPaid && (!state.modalData || !state.modalData.collectionDate)) {
        receiptUpdates.collectionDate = new Date().toISOString();
      }
      
      if (isEdit) {
        const savedOk = await updateRecord(state.receipts, state.modalData.id, receiptUpdates);
        if (!savedOk) return;
        showNotification(state.language === 'ar' ? 'تم التحديث' : 'Updated', state.language === 'ar' ? 'تم تحديث الوصل بنجاح!' : 'Receipt updated successfully!', 'success');
      } else {
        const receipt = {
          id: generateId('receipt'),
          recordType: 'receipt',
          creatorId: state.currentUser?.id || '',
          deliveryStatus: 'Office',
          createdAt: new Date().toISOString(),
          payments: [],
          topUps: [],
          ...receiptUpdates
        };
        const savedOk = await addRecord(state.receipts, receipt);
        if (!savedOk) return;
        showNotification(state.language === 'ar' ? 'تمت الإضافة' : 'Success', state.language === 'ar' ? 'تم إنشاء الوصل بنجاح!' : 'Receipt created successfully!', 'success');
      }
      break;
  }
  closeModal();
  render();
}

function showWalletTopupModal(userId) {
  if (!isCurrentUserAdmin()) return;
  const target = state.users.find(u => u.id === userId && !u._deleted);
  if (!target) return;
  state.activeModal = 'wallet-topup';
  // Idempotency key fixed at open time: even a double submit of this same
  // form can only ever create ONE credit transaction.
  state.modalData = { userId: String(userId), idempotencyKey: Security.generateSecureId('topup') };
  updateUrlParams({ modal: 'wallet-topup', id: String(userId) }); // URL tracking
  renderModal();
}

function closeModal() {
  if (typeof resetReceiptCustomerRiskWarningState === 'function') {
    resetReceiptCustomerRiskWarningState();
  }
  const wasCustomerMerge = state.activeModal === 'customer-merge';
  const customerMergeReturnFocus = wasCustomerMerge ? _customerMergeReturnFocus : null;
  if (wasCustomerMerge) _customerMergeReturnFocus = null;
  // One-shot preset used by Ads Studio's "Customer login" shortcut. Never
  // let it silently affect a later user created from the normal Users screen.
  window._newUserAccessPreset = '';
  state.activeModal = null;
  state.modalData = null;
  // Existing-balance mode never leaks to the next receipt (showReceiptModal also
  // resets it on open, but clear it here too so a cancelled carried receipt is clean).
  _newReceiptCarried = false;

  // Clear temp funding states
  state.tempAdFunding = null;
  state.tempMergeFunding = null;
  state.tempMixedReceiptTargetUSD = null;
  // Discard any pending (unsaved) photos so a cancelled upload cannot leak
  // into the next ad/receipt created in this session.
  state.tempAdPhotos = [];
  state.tempReceiptPhotos = [];
  state.tempAdPhotosDirty = false;
  state.tempReceiptPhotosDirty = false;
  _adPhotoUploadGeneration++;
  _receiptPhotoUploadGeneration++;
  _adPhotoUploadsInFlight = 0;
  _receiptPhotoUploadsInFlight = 0;
  closeReceiptPhotoViewer();
  // Discard any pending (unsaved) top-up edits so they cannot leak into the
  // next ad's top-up session.
  tempTopUps = [];
  // Discard any pending (unsaved) clothes-product/shipment edits
  _clothesTempVariants = [];
  _clothesTempPhoto = null;
  if (typeof _clothesPhotoToken === 'number') _clothesPhotoToken++; // invalidate pending photo callback

  _clothesTempShipLines = [];
  _clothesTempOrderLines = [];
  
  // Clear URL params (modal, id). When this dialog's opener pushed a history
  // entry (albayanModal stamp — see updateUrlParams), consume that entry with
  // history.back() instead: replaceState alone rewrote the entry's URL but
  // left it stacked, so every open/close cycle cost one dead hardware-Back
  // press on phones. Skipped when Back itself already popped the entry
  // (_closingSurfaceFromPopstate, set by the popstate handler) — the new top
  // entry may be a previous ?modal entry that must survive for back/forward
  // restore. Openers that never pushed (boot deep-link error paths) fall
  // through to the old replaceState behaviour.
  let consumedModalHistoryEntry = false;
  if (typeof consumeOverlayHistoryEntry === 'function' && !_closingSurfaceFromPopstate) {
    const topHistoryEntry = window.history.state;
    if (topHistoryEntry && topHistoryEntry.albayanModal) {
      consumedModalHistoryEntry = consumeOverlayHistoryEntry();
    } else if (topHistoryEntry && topHistoryEntry.overlaySentinel && topHistoryEntry.underAlbayanModal) {
      // Phone browsers: an untracked overlay (duplicate-serial warning…)
      // opened late over this dialog, so its sentinel sits ON TOP of the
      // dialog's own ?modal entry — and closeModal is tearing both surfaces
      // down at once. Consume BOTH entries: rewriting only the sentinel
      // would leave the buried ?modal entry alive one level down, and a
      // later Back would resurrect the dismissed dialog. The popstate that
      // go(-2) fires is pure bookkeeping, so flag it for the router exactly
      // like consumeOverlayHistoryEntry does. Sentinels are never pushed on
      // desktop or in the packaged app, so this branch cannot run there.
      _suppressOverlayPopstateUntil = Date.now() + 800;
      try {
        window.history.go(-2);
        if (_overlaySentinelDepth > 0) _overlaySentinelDepth--;
        consumedModalHistoryEntry = true;
      } catch (_) {
        _suppressOverlayPopstateUntil = 0;
      }
    }
  }
  if (!consumedModalHistoryEntry) clearUrlParams(['modal', 'id']);
  
  // Force remove ALL modals - be very aggressive
  document.querySelectorAll('#app-modal').forEach(el => {
    el.style.display = 'none';
    el.remove();
  });
  
  // Also remove any lingering modals (duplicate warning, etc.)
  const duplicateWarning = document.getElementById('duplicate-receipt-warning');
  if (duplicateWarning) {
    duplicateWarning.remove();
  }
  
  // Remove any modal overlays that might be lingering
  document.querySelectorAll('.fixed.inset-0.bg-slate-900\\/60').forEach(el => el.remove());
  
  // Force re-render to ensure UI is updated
  setTimeout(() => {
    render();
    lucide.createIcons();
    if (wasCustomerMerge) {
      const fallbackTrigger = document.querySelector('button[aria-haspopup="dialog"][onclick="showCustomerDuplicateMerge()"]');
      const focusTarget = customerMergeReturnFocus?.isConnected ? customerMergeReturnFocus : fallbackTrigger;
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    }
  }, 50);
}

// ---- Delete-cascade helpers ----
// When a receipt disappears, every record that references it must be updated
// too, or money numbers go wrong (user report: deleting a transferred-in
// receipt left the source receipt still showing the money as gone). These are
// shared by deleteReceipt AND deleteCustomer so both paths clean up the same
// way.

// Remove every funding reference to `receiptId` from visible ads (allocation
// rows, merged mirror, direct id fields). Returns how many ads were touched.
async function cleanupAdFundingLinks(receiptId) {
  const linkedAds = state.ads.filter(a =>
    (a.receiptId === receiptId || a.linkedDeliveryReceiptId === receiptId || a.fundingReceiptId === receiptId ||
     (Array.isArray(a.receiptAllocations) && a.receiptAllocations.some(alloc => alloc.receiptId === receiptId)) ||
     (Array.isArray(a.dueAllocations) && a.dueAllocations.some(alloc => alloc.receiptId === receiptId)))
    && !a._deleted
  );
  let touched = 0;
  for (const ad of linkedAds) {
    const updates = {};
    if (Array.isArray(ad.receiptAllocations)) {
      const kept = ad.receiptAllocations.filter(alloc => alloc.receiptId !== receiptId);
      if (kept.length !== ad.receiptAllocations.length) updates.receiptAllocations = kept;
    }
    if (Array.isArray(ad.dueAllocations)) {
      const kept = ad.dueAllocations.filter(alloc => alloc.receiptId !== receiptId);
      if (kept.length !== ad.dueAllocations.length) updates.dueAllocations = kept;
    }
    // The merged-funding mirror too — leaving it stale would let the next ad
    // edit reseed the merge editor from it and re-write an allocation that
    // draws money from the deleted receipt.
    if (Array.isArray(ad.mergedPaidAllocations)) {
      const kept = ad.mergedPaidAllocations.filter(alloc => alloc.receiptId !== receiptId);
      if (kept.length !== ad.mergedPaidAllocations.length) {
        updates.mergedPaidAllocations = kept;
        updates.hasMergedPaidFunds = kept.length > 0;
      }
    }
    if (ad.receiptId === receiptId) updates.receiptId = '';
    if (ad.linkedDeliveryReceiptId === receiptId) updates.linkedDeliveryReceiptId = '';
    if (ad.fundingReceiptId === receiptId) updates.fundingReceiptId = '';
    if (Array.isArray(ad.receiptIds)) {
      const kept = ad.receiptIds.filter(rid => rid !== receiptId);
      if (kept.length !== ad.receiptIds.length) updates.receiptIds = kept;
    }
    // The stop-ad snapshot too: a later stop-amount edit recomputes the
    // surviving receipts' shares from this baseline, so a deleted receipt
    // left inside would dilute the pool and undercharge the survivors.
    if (ad.stopAllocationBaseline && typeof ad.stopAllocationBaseline === 'object') {
      const nextBaseline = { ...ad.stopAllocationBaseline };
      let baselineChanged = false;
      ['receipt', 'due', 'merged'].forEach(k => {
        const arr = ad.stopAllocationBaseline[k];
        if (Array.isArray(arr)) {
          const kept = arr.filter(a => String(a?.receiptId || '') !== String(receiptId));
          if (kept.length !== arr.length) {
            nextBaseline[k] = kept;
            baselineChanged = true;
          }
        }
      });
      if (baselineChanged) updates.stopAllocationBaseline = nextBaseline;
    }
    if (Object.keys(updates).length) {
      const saved = await updateRecord(state.ads, ad.id, updates);
      if (!saved) throw new Error('Failed to clean an ad funding link');
      touched += 1;
    }
  }
  return touched;
}

// When a delivery is CANCELED its debt will never be collected, so ads funded
// from that due credit must stop counting it — otherwise uncollectible money
// keeps backing ad budgets forever. The ads themselves stay (no feature
// removed); only their due-funding rows pointing at this receipt are
// released. Returns how many ads were touched.
async function releaseCanceledDeliveryDueFunding(receiptId) {
  const rid = String(receiptId || '');
  let touched = 0;
  const affectedAds = state.ads.filter(a => a && !a._deleted && a.recordType !== 'receipt' && (
    (Array.isArray(a.dueAllocations) && a.dueAllocations.some(al => String(al?.receiptId || '') === rid)) ||
    (isAdLegacyDueMirrorForReceipt(a, rid) && getAdLegacyDueMirrorUSD(a, rid) > 0)
  ));
  for (const ad of affectedAds) {
    const updates = {};
    if (Array.isArray(ad.dueAllocations)) {
      const kept = ad.dueAllocations.filter(al => String(al?.receiptId || '') !== rid);
      if (kept.length !== ad.dueAllocations.length) updates.dueAllocations = kept;
    }
    // Legacy single-field shape predating dueAllocations. The mirror identity
    // (linkedDeliveryReceiptId, or the older receiptId forms) comes from the
    // shared reader so this release clears exactly the money the balance
    // readers counted — both USD and LYD mirrors, like the server does.
    if (isAdLegacyDueMirrorForReceipt(ad, rid) && getAdLegacyDueMirrorUSD(ad, rid) > 0) {
      updates.dueAmountToUseUSD = 0;
      updates.dueAmountToUseLYD = 0;
    }
    if (Object.keys(updates).length) {
      const saved = await updateRecord(state.ads, ad.id, updates);
      if (!saved) throw new Error('Failed to release canceled-delivery funding');
      touched += 1;
    }
  }
  return touched;
}

// If `receipt` is a transferred-in receipt, give the money BACK to the source
// receipt by removing the paired transfers[] entry (the deduction). Without
// this, deleting a transferred-in receipt made the money vanish: the target
// lost it AND the source still showed it as transferred away.
// Money the target ALREADY SPENT on ads stays deducted at the source — only
// the unspent remainder returns (the entry shrinks instead of disappearing).
// IMPORTANT: callers must run this BEFORE cleanupAdFundingLinks, because the
// spent amount is read from the allocations that cleanup strips.
// Returns the source receipt when money was returned, else null.
async function undoTransferIntoReceipt(receipt) {
  if (!receipt || String(receipt.receiptType || '') !== 'TRANSFER_IN') return null;
  const source = state.receipts.find(r => r && !r._deleted && String(r.id) === String(receipt.transferFromReceiptId || ''));
  if (!source || !Array.isArray(source.transfers)) return null;
  const spentUSD = Math.max(getReceiptUsageStats(receipt).usedUSD || 0, 0);
  let changed = false;
  const kept = [];
  source.transfers.forEach(t => {
    if (String(t?.toReceiptId || '') !== String(receipt.id)) { kept.push(t); return; }
    changed = true;
    if (spentUSD > 0.009) {
      // Keep the deduction for the spent part only.
      const rate = (parseFloat(t?.amountUSD) || 0) > 0 && Number.isFinite(parseFloat(t?.amountLocal))
        ? (parseFloat(t.amountLocal) / parseFloat(t.amountUSD))
        : (receipt.exchangeRate || 0);
      kept.push({
        ...t,
        amountUSD: Math.round(spentUSD * 100) / 100,
        amountLocal: Math.round(spentUSD * rate * 100) / 100,
        note: `${t?.note || ''}${t?.note ? ' — ' : ''}shrunk to spent portion after transfer receipt was deleted`.trim()
      });
    }
  });
  if (!changed) return null;
  const saved = await updateRecord(state.receipts, source.id, { transfers: kept });
  if (!saved) throw new Error('Failed to restore the source receipt transfer');
  return source;
}

// If `receipt` was a transfer SOURCE, its outgoing transfers created paired
// TRANSFER_IN receipts for other customers. Deleting the source removes that
// money's origin, so the paired receipts must be deleted too — otherwise the
// other customers keep spendable money that no longer exists anywhere.
// Handles onward (chained) transfers; `seen` guards against cycles. Returns
// how many paired receipts were deleted.
async function cascadeDeleteOutgoingTransfers(receipt, seen, deleteOpts) {
  seen = seen || new Set();
  if (!receipt || seen.has(String(receipt.id))) return 0;
  seen.add(String(receipt.id));
  let count = 0;
  for (const t of (Array.isArray(receipt.transfers) ? receipt.transfers : [])) {
    const target = state.receipts.find(r => r && !r._deleted && String(r.id) === String(t?.toReceiptId || ''));
    if (!target) continue;
    count += await cascadeDeleteOutgoingTransfers(target, seen, deleteOpts);
    await cleanupAdFundingLinks(target.id);
    if (!await deleteRecord(state.receipts, target.id, deleteOpts)) {
      throw new Error('Failed to delete a linked transfer receipt');
    }
    count += 1;
  }
  return count;
}

async function deleteCustomer(id) {
  // Permission check
  if (!currentUserHasPermission('customers', 'delete')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف العملاء' : 'You do not have permission to delete customers', 'error');
    return;
  }
  const customer = state.customers.find(c => c.id === id);
  const customerName = customer?.name || 'Unknown';
  // Check for linked receipts/ads
  const linkedReceipts = state.receipts.filter(r => r.customerId === id && !r._deleted);
  const linkedAds = state.ads.filter(a => a.customerId === id && !a._deleted);
  // Server mode cannot safely unwind a customer's ads, receipts, transfers,
  // and funding links through separate generic requests. Refuse before any
  // mutation; a future dedicated cascade endpoint can make this atomic.
  if (isServerModeEnabled() && (linkedReceipts.length > 0 || linkedAds.length > 0)) {
    showNotification(
      state.language === 'ar' ? 'لا يمكن الحذف' : 'Cannot Delete Customer',
      state.language === 'ar'
        ? 'يحتوي هذا العميل على وصولات أو إعلانات مرتبطة. أزل السجلات المرتبطة بأمان أولاً.'
        : 'This customer has linked receipts or ads. Remove those records safely first; the server will not perform a partial financial cascade.',
      'warning'
    );
    return;
  }
  // Show the cascade-delete warning in the user's language. Previously it was
  // English-only, so an Arabic-only user could unknowingly delete every linked
  // receipt and ad.
  const isAr = state.language === 'ar';
  let warning = isAr
    ? `هل أنت متأكد من حذف العميل "${customerName}"؟`
    : `Are you sure you want to delete customer "${customerName}"?`;
  if (linkedReceipts.length > 0 || linkedAds.length > 0) {
    if (isAr) {
      warning += `\n\n⚠️ تحذير: لدى هذا العميل ${linkedReceipts.length} وصل و ${linkedAds.length} إعلان.`;
      warning += `\n\nاختر:`;
      warning += `\n• موافق = حذف العميل وجميع وصولاته وإعلاناته`;
      warning += `\n• إلغاء = الإبقاء على كل شيء`;
    } else {
      warning += `\n\n⚠️ WARNING: This customer has ${linkedReceipts.length} receipt(s) and ${linkedAds.length} ad(s).`;
      warning += `\n\nChoose an option:`;
      warning += `\n• OK = Delete customer AND all their receipts/ads`;
      warning += `\n• Cancel = Keep everything`;
    }
  }
  if (confirm(warning)) {
    // Cascade delete: the customer's ADS first, then their receipts. Deleting
    // the ads first releases the money they spent, so the transfer undo below
    // returns the full unspent amount to other customers' source receipts.
    // deleteRecord (instead of a bare _deleted flag with a fire-and-forget
    // server call) gives every cascaded record the standard server push with
    // rollback, error notification and audit log.
    // Every soft-delete of the cascade is collected and pushed to the server
    // as ONE all-or-nothing batch — a flaky connection can no longer leave
    // the customer half-deleted with some records resurrecting later.
    const batchDeleteOps = { collectServerOps: [] };
    for (const ad of linkedAds) {
      if (!await deleteRecord(state.ads, ad.id, batchDeleteOps)) return;
    }
    for (const receipt of linkedReceipts) {
      // Same link cleanup deleteReceipt does. Without it, ads of OTHER
      // customers funded by these receipts kept dead allocation rows, money
      // transferred IN from another customer stayed deducted at its source,
      // and money transferred OUT lived on as spendable phantom receipts.
      // Undo BEFORE cleanup: the undo reads spent amounts from allocations.
      await undoTransferIntoReceipt(receipt);
      await cleanupAdFundingLinks(receipt.id);
      await cascadeDeleteOutgoingTransfers(receipt, undefined, batchDeleteOps);
      if (!await deleteRecord(state.receipts, receipt.id, batchDeleteOps)) return;
    }
    // Unlink the customer from pages: page.customerIds kept the ghost id, so
    // the Pages view still showed the deleted customer as owner and every
    // page save re-persisted the dangling link.
    for (const page of getVisibleRecords(state.pages)) {
      if (Array.isArray(page.customerIds) && page.customerIds.includes(id)) {
        const pageSaved = await updateRecord(state.pages, page.id, { customerIds: page.customerIds.filter(cid => cid !== id) });
        if (!pageSaved) return;
      }
    }
    if (!await deleteRecord(state.customers, id, batchDeleteOps)) return;
    if (!await flushBatchDeletes(batchDeleteOps.collectServerOps)) return;
    const deletedCount = linkedReceipts.length + linkedAds.length;
    showNotification(
      isAr ? 'تم الحذف' : 'Deleted',
      isAr
        ? `تم حذف العميل${deletedCount > 0 ? ` مع ${deletedCount} سجل مرتبط` : ''}`
        : `Customer deleted${deletedCount > 0 ? ` along with ${deletedCount} linked record(s)` : ''}`,
      'success'
    );
    render();
  }
}

async function deletePage(id) {
  // Permission check
  if (!currentUserHasPermission('pages', 'delete')) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الصفحات' : 'You do not have permission to delete pages', 'error');
    return;
  }
  const isArPg = state.language === 'ar';
  let pageWarning = isArPg ? 'هل تريد حذف هذه الصفحة؟' : 'Delete this page?';
  // Ads keep pointing at the deleted page's id for history. Recreating a page
  // with the same name makes a NEW id, so those ads would not appear under it
  // — the user must know this before deleting.
  const pageAdsCount = state.ads.filter(a => a && !a._deleted && a.recordType !== 'receipt' && String(a.pageId || '') === String(id)).length;
  if (pageAdsCount > 0) {
    pageWarning += isArPg
      ? `\n\n⚠️ ${pageAdsCount} إعلان(ات) تابعة لهذه الصفحة. ستبقى الإعلانات وسجلها، لكن صفحة جديدة بنفس الاسم لن تشملها.`
      : `\n\n⚠️ ${pageAdsCount} ad(s) belong to this page. The ads and their history stay, but a NEW page with the same name will not include them.`;
  }
  if (confirm(pageWarning)) {
    if (!await deleteRecord(state.pages, id)) return;
    showNotification(state.language === 'ar' ? 'تم الحذف' : 'Deleted', state.language === 'ar' ? 'تم حذف الصفحة' : 'Page deleted', 'success');
    render();
  }
}

async function deleteReceipt(id) {
  // Permission check
  const receipt = state.receipts.find(r => r.id === id);
  if (!canActOnRecord('receipts', 'delete', receipt?.createdBy)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الوصولات' : 'You do not have permission to delete this receipt', 'error');
    return;
  }
  const serialNo = receipt?.serialNumber || receipt?.tempReceiptNo || receipt?.finalReceiptNo || id.slice(0, 8);
  const amountUSD = receipt?.amountUSD?.toFixed(2) || '0.00';
  // Check for linked ads
  const linkedAds = state.ads.filter(a =>
    (a.receiptId === id || a.linkedDeliveryReceiptId === id || a.fundingReceiptId === id ||
     (Array.isArray(a.receiptAllocations) && a.receiptAllocations.some(alloc => alloc.receiptId === id)) ||
     (Array.isArray(a.dueAllocations) && a.dueAllocations.some(alloc => alloc.receiptId === id)))
    && !a._deleted
  );
  const isArDel = state.language === 'ar';
  // Transfer links in BOTH directions (user report: deleting a transferred-in
  // receipt must give the money back to the source; deleting a source must
  // also remove the transferred-in receipts it created for other customers).
  const isTransferIn = String(receipt?.receiptType || '') === 'TRANSFER_IN';
  const transferSource = isTransferIn
    ? state.receipts.find(r => r && !r._deleted && String(r.id) === String(receipt.transferFromReceiptId || ''))
    : null;
  const outgoingTargets = (Array.isArray(receipt?.transfers) ? receipt.transfers : [])
    .map(t => state.receipts.find(r => r && !r._deleted && String(r.id) === String(t?.toReceiptId || '')))
    .filter(Boolean);
  // The local single-device cascade above cannot be reproduced safely as a
  // sequence of server requests. Block linked server deletions before the
  // source receipt or any ad allocation is changed.
  if (isServerModeEnabled() && (linkedAds.length > 0 || transferSource || outgoingTargets.length > 0)) {
    showNotification(
      state.language === 'ar' ? 'لا يمكن حذف الوصل' : 'Cannot Delete Receipt',
      state.language === 'ar'
        ? 'هذا الوصل مرتبط بتمويل أو تحويل. حرر هذه الارتباطات أولاً لحماية الرصيد.'
        : 'This receipt is linked to ad funding or a transfer. Release those links first; the server will not perform a partial money cleanup.',
      'warning'
    );
    return;
  }
  let warning = isArDel
    ? `هل أنت متأكد من حذف الوصل رقم ${serialNo} ($${amountUSD})؟`
    : `Are you sure you want to delete receipt #${serialNo} ($${amountUSD})?`;
  if (linkedAds.length > 0) {
    warning += isArDel
      ? `\n\n⚠️ تحذير: ${linkedAds.length} إعلان(ات) ممولة من هذا الوصل. سيتم تنظيف ارتباطات التمويل الخاصة بها.`
      : `\n\n⚠️ WARNING: ${linkedAds.length} ad(s) are funded by this receipt. Their allocation references will be cleaned up.`;
  }
  if (transferSource) {
    const srcLabel = transferSource.serialNumber || transferSource.id.slice(0, 8);
    warning += isArDel
      ? `\n\n↩️ هذا وصل محوَّل — سيعود مبلغه ($${amountUSD}) إلى الوصل الأصلي رقم ${srcLabel}.`
      : `\n\n↩️ This is a transferred-in receipt — its $${amountUSD} will return to source receipt #${srcLabel}.`;
  }
  if (outgoingTargets.length > 0) {
    warning += isArDel
      ? `\n\n⚠️ هذا الوصل حوَّل أموالاً إلى ${outgoingTargets.length} وصل(ات) لعملاء آخرين — سيتم حذفها أيضاً لأن مصدر أموالها سيختفي.`
      : `\n\n⚠️ This receipt transferred money to ${outgoingTargets.length} receipt(s) of other customers — those will be deleted too, because their money's source is being removed.`;
  }
  if (confirm(warning)) {
    // Clean up every record that references this receipt (shared helpers,
    // also used by deleteCustomer so both delete paths behave the same).
    // Order matters: the transfer undo reads how much of this receipt was
    // SPENT from its allocations, so it must run before cleanup strips them.
    // All soft-deletes are collected and pushed to the server as ONE
    // all-or-nothing batch (receipt + its chained transfer receipts).
    const batchDeleteOps = { collectServerOps: [] };
    const returnedTo = await undoTransferIntoReceipt(receipt);
    await cleanupAdFundingLinks(id);
    const cascadeCount = await cascadeDeleteOutgoingTransfers(receipt, undefined, batchDeleteOps);
    if (!await deleteRecord(state.receipts, id, batchDeleteOps)) return;
    if (!await flushBatchDeletes(batchDeleteOps.collectServerOps)) return;
    let detail = isArDel ? 'تم حذف الوصل' : 'Receipt deleted';
    if (linkedAds.length > 0) detail += isArDel ? ` (تم تنظيف ${linkedAds.length} ارتباط تمويل)` : ` (${linkedAds.length} ad allocation(s) cleaned up)`;
    if (returnedTo) detail += isArDel ? ` — عاد $${amountUSD} إلى الوصل رقم ${returnedTo.serialNumber || returnedTo.id.slice(0, 8)}` : ` — $${amountUSD} returned to receipt #${returnedTo.serialNumber || returnedTo.id.slice(0, 8)}`;
    if (cascadeCount > 0) detail += isArDel ? ` — تم حذف ${cascadeCount} وصل محوَّل مرتبط` : ` — ${cascadeCount} linked transferred-in receipt(s) deleted`;
    showNotification(isArDel ? 'تم الحذف' : 'Deleted', detail, 'success');
    render();
  }
}

async function deleteAd(id) {
  // Permission check
  const ad = state.ads.find(a => a.id === id);
  if (!canActOnRecord('ads', 'delete', ad?.creatorId)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الإعلانات' : 'You do not have permission to delete this ad', 'error');
    return;
  }
  const customer = state.customers.find(c => c.id === ad?.customerId);
  const customerName = customer?.name || 'Unknown';
  const amountUSD = ad?.amountUSD?.toFixed(2) || '0.00';
  // Reassure the user about where the money goes: allocations of a deleted ad
  // stop counting against the receipts, so the funded amount becomes available
  // again automatically.
  const fundedUSD = Array.isArray(ad?.receiptAllocations)
    ? Math.round(ad.receiptAllocations.reduce((s, a) => s + (parseFloat(a?.amountUSD) || 0), 0) * 100) / 100
    : 0;
  let warning = state.language === 'ar'
    ? `هل أنت متأكد من حذف هذا الإعلان؟\n\nالعميل: ${customerName}\nالمبلغ: $${amountUSD}`
    : `Are you sure you want to delete this ad?\n\nCustomer: ${customerName}\nAmount: $${amountUSD}`;
  if (fundedUSD > 0) {
    warning += state.language === 'ar'
      ? `\n\n↩️ سيعود $${fundedUSD.toFixed(2)} إلى رصيد وصل(وصولات) التمويل.`
      : `\n\n↩️ $${fundedUSD.toFixed(2)} will return to the funding receipt(s) balance.`;
  }
  warning += state.language === 'ar'
    ? `\n\n⚠️ لا يمكن التراجع عن هذا الإجراء!`
    : `\n\n⚠️ This action cannot be undone!`;
  if (confirm(warning)) {
    if (!await deleteRecord(state.ads, id)) return;
    showNotification(state.language === 'ar' ? 'تم الحذف' : 'Deleted', state.language === 'ar' ? 'تم حذف الإعلان' : 'Ad deleted', 'success');
    render();
  }
}

// Stop Ad - Enter spent amount and return remaining to receipts/customer
