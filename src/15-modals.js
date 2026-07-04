function renderModal() {
  const existingModal = document.getElementById('app-modal');
  if (existingModal) existingModal.remove();
  
  if (!state.activeModal) return;
  
  const isEdit = state.modalData !== null;
  let modalContent = '';
  switch (state.activeModal) {
    case 'customer':
      const custData = state.modalData || {};
      const phones = custData.phones || [''];
      const profileLinks = custData.profileLinks || [];
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="user" class="w-6 h-6 mr-2 text-indigo-600"></i>
          ${isEdit ? 'Edit' : 'Add'} Customer
        </h2>
        <form id="modal-form" class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar pr-2">
          <!-- Name -->
          <div>
            <label class="block text-sm font-medium mb-2">Name *</label>
            <input type="text" id="customer-name" value="${Security.escapeHtml(custData.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" placeholder="Customer name" />
          </div>

          <!-- Platform -->
          <div>
            <label class="block text-sm font-medium mb-2">Platform *</label>
            <select id="customer-platform" class="w-full glass-input px-4 py-2 rounded-xl">
              ${PLATFORMS.map(p => `<option value="${p}" ${custData.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>

          <!-- Join Date -->
          <div>
            <label class="block text-sm font-medium mb-2">Join Date</label>
            <input type="date" id="customer-joindate" value="${Security.escapeHtml(custData.joinDate ? custData.joinDate.split('T')[0] : getTodayDateString())}" class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>

          <!-- Phone Numbers -->
          <div>
            <div class="flex justify-between items-center mb-2">
              <label class="block text-sm font-medium">Phone Numbers *</label>
              <button type="button" onclick="addPhoneField()" class="text-indigo-600 hover:text-indigo-700 text-sm font-medium flex items-center space-x-1">
                <i data-lucide="plus-circle" class="w-4 h-4"></i>
                <span>Add Phone</span>
              </button>
            </div>
            <div id="phone-fields-container" class="space-y-2">
              ${phones.map((phone, index) => `
                <div class="flex items-center space-x-2 phone-field-group">
                  <input type="tel" class="customer-phone flex-1 glass-input px-4 py-2 rounded-xl" value="${Security.escapeHtml(phone || '')}" placeholder="Phone number" ${index === 0 ? 'required' : ''} />
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
              <label class="block text-sm font-medium">Profile Links</label>
              <button type="button" onclick="addProfileLinkField()" class="text-indigo-600 hover:text-indigo-700 text-sm font-medium flex items-center space-x-1">
                <i data-lucide="plus-circle" class="w-4 h-4"></i>
                <span>Add Link</span>
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
                  <p>No profile links yet. Click "Add Link" to add one.</p>
                </div>
              `}
            </div>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button type="submit" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isEdit ? 'Save Changes' : 'Create Customer'}
            </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold hover:bg-slate-300">Cancel</button>
          </div>
        </form>
      `;
      break;
    case 'ad':
      const visibleCustomers = getVisibleRecords(state.customers);
      const visiblePages = getVisibleRecords(state.pages);
      const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      const adData = state.modalData || {};
      state.tempAdPhotos = adData.adPhotos || adData.photos || state.tempAdPhotos || [];
      const durationDaysDefault = (adData.days !== undefined ? adData.days : (adData.startDate && adData.endDate ? Math.max(0, Math.round((new Date(adData.endDate) - new Date(adData.startDate)) / (1000 * 60 * 60 * 24))) : ''));
      const isAdminUser = isCurrentUserAdmin();
      const adCreator = isEdit && adData.creatorId ? state.users.find(u => u.id === adData.creatorId) : state.currentUser;
      
      if (visiblePages.length === 0) {
        modalContent = `
          <div class="text-center py-8">
            <div class="w-20 h-20 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-xl">
              <i data-lucide="file-text" class="w-10 h-10 text-white"></i>
            </div>
            <h2 class="text-xl font-bold text-slate-800 dark:text-white mb-2">No Pages Found</h2>
            <p class="text-slate-500 mb-4">Please add a Facebook Page first before creating an ad.</p>
            <button onclick="closeModal(); navigateTo('pages')" class="btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-3 rounded-xl font-bold">
              <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>Add Page
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
                <h2 class="text-lg font-bold text-slate-800 dark:text-white">${isEdit ? 'Edit' : 'New'} Ad</h2>
                <p class="text-slate-400 text-xs">Fill all sections below</p>
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
                Basic Info
              </div>
              
              <!-- Creator -->
              <div class="flex items-center justify-between p-2 bg-white dark:bg-slate-900 rounded-lg">
                <div class="flex items-center space-x-2">
                  <div class="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 font-bold text-xs">
                    ${adCreator?.name?.charAt(0) || 'U'}
                  </div>
                  <span class="text-sm text-slate-600 dark:text-slate-300">${Security.escapeHtml(adCreator?.name || 'Unknown')}</span>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[9px] font-bold ${isAdminUser ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'}">
                  ${isAdminUser ? 'ADMIN' : 'USER'}
                </span>
              </div>
              <input type="hidden" id="ad-creator-id" value="${adCreator?.id || state.currentUser?.id || ''}" />
              
              <!-- Page Selection -->
              <div>
                <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Page *</label>
                <div class="relative">
                  <input type="text" id="ad-page-search" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-3 py-2 rounded-lg text-sm" placeholder="Search pages..." oninput="filterAdPages()" onfocus="showAdPageDropdown()" value="${Security.escapeHtml((state.pages.find(p => p.id === adData.pageId)?.name) || '')}" autocomplete="off" />
                  <div id="ad-page-dropdown" class="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 rounded-lg shadow-xl max-h-48 overflow-y-auto hidden border border-slate-200 dark:border-slate-600">
                    ${visiblePages.map(p => `
                      <div class="page-option px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer text-sm" data-name="${Security.escapeHtml((p.name || '').toLowerCase())}" onclick="selectAdPage('${p.id}')">
                        ${Security.escapeHtml(p.name || '')}
                      </div>
                    `).join('')}
                  </div>
                  <input type="hidden" id="ad-page" value="${adData.pageId || ''}" required />
                </div>
              </div>
              
              <!-- Customer -->
              <div id="ad-customer-section" class="${adData.pageId ? '' : 'hidden'}">
                <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Customer <span class="text-slate-400" id="ad-customer-hint">(auto-selected)</span></label>
                <div id="ad-customer-display" class="bg-white dark:bg-slate-900 rounded-lg p-2"></div>
                <input type="hidden" id="ad-customer-id" value="${adData.customerId || ''}" required />
              </div>
            </div>

            <!-- SECTION 2: Payment Status -->
            <div class="bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 space-y-3 border border-emerald-200 dark:border-emerald-800">
              <div class="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[10px]">2</span>
                Payment Status
              </div>
              <div class="grid grid-cols-3 gap-2">
                <button type="button" onclick="setAdPaymentStatus('paid')" id="ad-pay-status-paid"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'border-emerald-500 bg-emerald-100 dark:bg-emerald-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="check-circle" class="w-5 h-5 ${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'text-emerald-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'text-emerald-700' : 'text-slate-500'}">Paid</span>
                </button>
                <button type="button" onclick="setAdPaymentStatus('not_paid')" id="ad-pay-status-not-paid"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adData.paymentStatus === 'not_paid' ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="clock" class="w-5 h-5 ${adData.paymentStatus === 'not_paid' ? 'text-amber-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adData.paymentStatus === 'not_paid' ? 'text-amber-700' : 'text-slate-500'}">Not Paid</span>
                </button>
                <button type="button" onclick="setAdPaymentStatus('wont_pay')" id="ad-pay-status-wont"
                  class="p-2 rounded-lg border-2 transition-all flex flex-col items-center ${adData.paymentStatus === 'wont_pay' ? 'border-rose-500 bg-rose-100 dark:bg-rose-900/40' : 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800'}">
                  <i data-lucide="x-octagon" class="w-5 h-5 ${adData.paymentStatus === 'wont_pay' ? 'text-rose-600' : 'text-slate-400'}"></i>
                  <span class="text-xs font-semibold mt-1 ${adData.paymentStatus === 'wont_pay' ? 'text-rose-700' : 'text-slate-500'}">Won't Pay</span>
                </button>
              </div>
              <input type="hidden" id="ad-payment-status" value="${adData.paymentStatus || 'paid'}" />
            </div>

            <!-- NOT PAID OPTIONS -->
            <div id="ad-not-paid-options" class="${adData.paymentStatus === 'not_paid' ? '' : 'hidden'}">
              <div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-3">
                <label class="block text-xs font-bold text-amber-700">How will payment be collected?</label>
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" onclick="setAdCollectionMethod('in_shop')" id="ad-collect-shop"
                    class="p-3 rounded-lg border-2 flex flex-col items-center ${adData.collectionMethod === 'in_shop' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'}">
                    <i data-lucide="store" class="w-5 h-5 ${adData.collectionMethod === 'in_shop' ? 'text-blue-600' : 'text-slate-400'}"></i>
                    <span class="text-xs font-medium mt-1">In Shop</span>
                  </button>
                  <button type="button" onclick="setAdCollectionMethod('driver')" id="ad-collect-driver"
                    class="p-3 rounded-lg border-2 flex flex-col items-center ${adData.collectionMethod === 'driver' ? 'border-violet-500 bg-violet-50' : 'border-slate-200 bg-white'}">
                    <i data-lucide="truck" class="w-5 h-5 ${adData.collectionMethod === 'driver' ? 'text-violet-600' : 'text-slate-400'}"></i>
                    <span class="text-xs font-medium mt-1">Driver</span>
                  </button>
                </div>
                <input type="hidden" id="ad-collection-method" value="${adData.collectionMethod || ''}" />
                <div id="ad-collection-details" class="${adData.collectionMethod ? '' : 'hidden'} pt-2 border-t border-amber-200">
                  <div id="ad-driver-select" class="hidden"></div>
                  <div id="ad-temp-receipt-link" class="hidden mt-2 p-3 bg-white rounded-lg border border-violet-200 space-y-3">
                    <label class="block text-xs font-bold text-violet-700">Link Delivery Receipt (D#)</label>
                    <select id="ad-temp-receipt-id" class="w-full border border-slate-200 px-3 py-2 rounded-lg text-sm" onchange="onAdTempReceiptChange(this.value)">
                      <option value="">Select pending receipt...</option>
                    </select>
                    <div id="ad-temp-receipt-hint" class="text-xs text-slate-500"></div>
                    <input type="hidden" id="ad-linked-receipt-id" value="${adData.receiptId || ''}" />
                    
                    <!-- Due Amount Usage Section -->
                    <div id="ad-due-amount-section" class="hidden p-3 bg-violet-50 rounded-lg border border-violet-200 space-y-2">
                      <div class="flex items-center justify-between">
                        <span class="text-xs font-semibold text-violet-700">Use Credit from Due Receipt</span>
                        <span id="ad-due-available" class="text-xs text-violet-600 font-medium">Available: $0.00</span>
                  </div>
                      <div class="grid grid-cols-2 gap-2">
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-1">Planned Spend (USD)</label>
                          <input type="text" id="ad-due-amount-to-use" inputmode="decimal" class="w-full border border-violet-300 px-3 py-2 rounded-lg text-sm bg-white" placeholder="0.00" oninput="sanitizeMoneyInput(this); onAdDueAmountChange()" onfocus="this.select()" />
                </div>
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-1">Use All</label>
                          <button type="button" onclick="useAllDueAmount()" class="w-full bg-violet-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-violet-700">
                            Use Full Credit
                          </button>
                        </div>
                      </div>
                      <div id="ad-due-summary" class="text-[10px] text-slate-500"></div>
                    </div>
                    
                    <!-- Merge with Paid Funds Toggle -->
                    <div id="ad-merge-funds-toggle" class="hidden">
                      <button type="button" onclick="toggleMergePaidFunds()" class="flex items-center gap-2 text-xs text-blue-600 hover:text-blue-700 font-medium">
                        <i data-lucide="plus-circle" class="w-4 h-4" id="ad-merge-icon"></i>
                        <span id="ad-merge-text">Add Paid Receipt Funds</span>
                      </button>
                    </div>
                    
                    <!-- Merged Paid Funds Section (hidden by default) -->
                    <div id="ad-merged-paid-funds" class="hidden mt-2 p-3 bg-blue-50 rounded-lg border border-blue-200 space-y-2">
                      <div class="flex items-center justify-between">
                        <span class="text-xs font-bold text-blue-700">Also Use Paid Receipt Funds</span>
                        <button type="button" onclick="addAdFundingAllocationForMerge()" class="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-blue-700">
                          + Add Receipt
                        </button>
                      </div>
                      <div id="ad-merged-funding-list" class="space-y-2 bg-white rounded-lg p-2 min-h-[40px]">
                        <div class="text-xs text-slate-400 text-center py-1">Click "+ Add Receipt" to use paid funds</div>
                      </div>
                      <div id="ad-merged-funding-summary" class="text-xs text-blue-600 font-medium"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- UNPAID FINANCIAL -->
            <div id="ad-unpaid-financial" class="${adData.paymentStatus === 'paid' || !adData.paymentStatus ? 'hidden' : (adData.paymentStatus === 'not_paid' && adData.collectionMethod === 'driver' ? 'hidden' : '')}">
              <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-2">
                <div class="flex justify-between items-center">
                  <span class="text-xs font-bold text-slate-600">Financial Details</span>
                  <button type="button" onclick="addReceiptPaymentSplit()" class="text-xs text-emerald-600 font-medium">+ Add Split</button>
                </div>
                <div id="receipt-financial-section">
                  ${renderReceiptFinancials(
                    adData.collectionPayments && adData.collectionPayments.length ? adData.collectionPayments : [{
                      method: adData.paymentMethod || PAYMENT_METHODS[0],
                      amount: adData.amountUSD || 0,
                      rate: adData.exchangeRate || getDefaultRate1(adData.paymentMethod || PAYMENT_METHODS[0]),
                      rate2: state.defaultExchangeRate,
                      collectionType: 'office',
                      deliveryPersonId: adData.deliveryPersonId || ''
                    }],
                    adData.collectionPayments && adData.collectionPayments.length ? adData.collectionPayments : [{
                      method: adData.paymentMethod || PAYMENT_METHODS[0],
                      amount: adData.amountUSD || 0,
                      rate: adData.exchangeRate || getDefaultRate1(adData.paymentMethod || PAYMENT_METHODS[0]),
                      rate2: state.defaultExchangeRate,
                      collectionType: 'office',
                      deliveryPersonId: adData.deliveryPersonId || ''
                    }],
                    deliveryUsers
                  )}
                </div>
              </div>
            </div>

            <!-- SECTION 3: Receipt Funding (PAID ONLY) -->
            <div id="ad-receipt-funding-section" class="${adData.paymentStatus === 'paid' || !adData.paymentStatus ? '' : 'hidden'} bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl p-4 space-y-3 border border-blue-200 dark:border-blue-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px]">3</span>
                  Receipt Funding
                </div>
                <button type="button" onclick="addAdFundingAllocation()" class="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-blue-700">
                  + Add Receipt
                </button>
              </div>
              <div id="ad-funding-list" class="space-y-2 bg-white dark:bg-slate-900 rounded-lg p-2 min-h-[60px]">
                <div class="text-xs text-slate-400 text-center py-2">Select a page & customer first</div>
              </div>
              <div id="ad-funding-summary" class="text-xs text-blue-600 font-medium"></div>
            </div>

            <!-- SECTION 4: Dates -->
            <div class="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-xl p-4 space-y-3 border border-purple-200 dark:border-purple-800">
              <div class="text-xs font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center text-[10px]">4</span>
                Ad Duration
              </div>
              <div class="grid grid-cols-3 gap-2">
                <div>
                  <label class="block text-xs text-slate-500 mb-1">Start</label>
                  <input type="date" id="ad-start-date" value="${Security.escapeHtml(adData.startDate ? adData.startDate.split('T')[0] : getTodayDateString())}" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" onchange="updateAdDays()" />
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1">End</label>
                  <input type="date" id="ad-end-date" value="${Security.escapeHtml(adData.endDate ? adData.endDate.split('T')[0] : getTodayDateString())}" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" onchange="updateAdDays()" />
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1">Days</label>
                  <input type="number" id="ad-days" min="0" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-2 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(durationDaysDefault || ''))}" oninput="updateAdEndDateFromDays()" />
                </div>
              </div>
            </div>

            <!-- SECTION 5: Photos -->
            <div class="bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-900/20 dark:to-amber-900/20 rounded-xl p-4 space-y-3 border border-orange-200 dark:border-orange-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-orange-600 text-white flex items-center justify-center text-[10px]">5</span>
                  Photos
                </div>
                <label class="text-xs bg-orange-600 text-white px-2 py-1 rounded-lg font-medium cursor-pointer hover:bg-orange-700">
                  + Upload
                  <input type="file" accept="image/*" multiple class="hidden" onchange="uploadAdPhotos(this.files)" />
                </label>
              </div>
              <div id="ad-photo-previews" class="grid grid-cols-4 gap-2 min-h-[40px] bg-white dark:bg-slate-900 rounded-lg p-2">
                <div class="text-xs text-slate-400 col-span-4 text-center py-2">No photos yet</div>
              </div>
            </div>

            <!-- SECTION 6: Links -->
            <div class="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-cyan-900/20 dark:to-teal-900/20 rounded-xl p-4 space-y-3 border border-cyan-200 dark:border-cyan-800">
              <div class="flex items-center justify-between">
                <div class="text-xs font-bold text-cyan-700 dark:text-cyan-400 uppercase tracking-wider flex items-center gap-2">
                  <span class="w-5 h-5 rounded-full bg-cyan-600 text-white flex items-center justify-center text-[10px]">6</span>
                  Ad Links
                </div>
                <button type="button" onclick="addAdLinkInput('')" class="text-xs bg-cyan-600 text-white px-2 py-1 rounded-lg font-medium hover:bg-cyan-700">
                  + Add Link
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
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>${isEdit ? 'Save Changes' : 'Create Ad'}
            </button>
            <button type="button" onclick="closeModal()" class="px-6 py-3 rounded-xl font-medium text-sm bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200">
              Cancel
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
      modalContent = `
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shadow-lg">
              ${userData.name ? userData.name.charAt(0) : '<i data-lucide="user-plus" class="w-6 h-6"></i>'}
            </div>
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white">${isEdit ? (isSelfEdit ? 'Edit Profile' : 'Edit User') : 'Add New User'}</h2>
              <p class="text-xs text-slate-500">${isEdit ? (isSelfEdit ? 'Update your profile details' : 'Update user details and access') : 'Create account with permissions'}</p>
            </div>
          </div>
          <button type="button" onclick="closeModal()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            <i data-lucide="x" class="w-4 h-4 text-slate-500"></i>
          </button>
        </div>
        
        <form id="modal-form" class="space-y-5">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Full Name *</label>
              <input type="text" id="user-name" value="${Security.escapeHtml(userData.name || '')}" required class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="John Doe" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Email Address *</label>
              <input type="email" id="user-email" value="${Security.escapeHtml(userData.email || '')}" required class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="john@company.com" />
            </div>
          </div>
          
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Password ${isEdit ? '(leave blank to keep)' : '*'}</label>
              <input type="password" id="user-password" ${!isEdit ? 'required' : ''} class="w-full glass-input px-4 py-2.5 rounded-xl" placeholder="${isEdit ? '••••••••' : 'Min. 8 characters'}" />
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">Role *</label>
              <select id="user-role" onchange="updateUserRoleInfo(this.value)" class="w-full glass-input px-4 py-2.5 rounded-xl" ${isAdminEditor ? '' : 'disabled'}>
                ${USER_ROLES.map(r => `<option value="${r}" ${userData.role === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
              ${!isAdminEditor ? `
                <div class="mt-1 text-[11px] text-slate-400">
                  ${state.language === 'ar' ? 'تغيير الدور والصلاحيات للأدمن فقط' : 'Role & permissions can be changed by Admin only'}
                </div>
              ` : ''}
            </div>
          </div>
          
          <!-- Role Info -->
          <div id="role-info" class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="flex items-center space-x-3">
              <div id="role-icon" class="w-10 h-10 rounded-xl flex items-center justify-center ${isAdminRole(userData.role) ? 'bg-amber-100 dark:bg-amber-900/30' : isDeliveryRole(userData.role) ? 'bg-cyan-100 dark:bg-cyan-900/30' : 'bg-emerald-100 dark:bg-emerald-900/30'}">
                <i data-lucide="${isAdminRole(userData.role) ? 'crown' : isDeliveryRole(userData.role) ? 'truck' : 'user-check'}" class="w-5 h-5 ${isAdminRole(userData.role) ? 'text-amber-600' : isDeliveryRole(userData.role) ? 'text-cyan-600' : 'text-emerald-600'}"></i>
              </div>
              <div class="flex-1">
                <div id="role-title" class="font-bold text-sm text-slate-700 dark:text-slate-300">
                  ${isAdminRole(userData.role) ? 'Full Administrator' : isDeliveryRole(userData.role) ? 'Delivery Driver' : 'Employee'}
                </div>
                <div id="role-desc" class="text-xs text-slate-500">
                  ${isAdminRole(userData.role) ? 'Complete access to all features. No restrictions.' : isDeliveryRole(userData.role) ? 'Access to delivery operations only.' : 'Standard employee access. Customize permissions after creation.'}
                </div>
              </div>
              ${isAdminRole(userData.role) ? `
                <span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">ALL ACCESS</span>
              ` : ''}
            </div>
          </div>
          
          ${isEdit && !isAdminRole(userData.role) && userPermSummary ? `
            <!-- Current Permissions Summary -->
            <div class="p-4 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <i data-lucide="shield" class="w-4 h-4 text-purple-600"></i>
                  <span class="text-sm font-bold text-purple-700 dark:text-purple-300">Current Permissions</span>
                </div>
                <span class="text-xs font-bold text-purple-600">${userPermSummary.granted}/${userPermSummary.total} granted</span>
              </div>
              <div class="w-full h-2 bg-purple-200 dark:bg-purple-800 rounded-full overflow-hidden mb-3">
                <div class="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full" style="width: ${userPermSummary.percentage}%"></div>
              </div>
              ${isAdminEditor ? `
              <button type="button" onclick="closeModal(); setTimeout(() => showPermissionsModal('${userData.id}'), 200)" class="w-full py-2 rounded-lg text-xs font-bold text-purple-600 hover:bg-purple-100 dark:hover:bg-purple-800/30 transition-colors flex items-center justify-center space-x-2">
                <i data-lucide="settings" class="w-3 h-3"></i>
                <span>Manage Detailed Permissions</span>
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
                  <div class="text-sm font-bold text-blue-700 dark:text-blue-300">Permissions Setup</div>
                  <p class="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    After creating this user, you'll be able to configure their detailed permissions. 
                    Default permissions will be assigned based on their role.
                  </p>
                </div>
              </div>
            </div>
          ` : ''}
          
          <div class="flex space-x-3 pt-2">
            <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="${isEdit ? 'save' : 'user-plus'}" class="w-4 h-4"></i>
              <span>${isEdit ? 'Save Changes' : 'Create User'}</span>
            </button>
            <button type="button" onclick="closeModal()" class="px-6 py-3 bg-slate-200 dark:bg-slate-700 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">Cancel</button>
          </div>
        </form>
      `;
      break;
    case 'page':
      const pageData = state.modalData || {};
      const pageCustomers = getVisibleRecords(state.customers);
      const existingCustomerIds = pageData.customerIds || [];
      const isAdminPage = isAdminRole(state.currentUser?.role);
      
      if (pageCustomers.length === 0) {
        modalContent = `
          <h2 class="text-2xl font-bold mb-4">Add Page</h2>
          <div class="text-center py-8">
            <i data-lucide="alert-circle" class="w-12 h-12 mx-auto text-amber-500 mb-4"></i>
            <p class="text-slate-600 dark:text-slate-400 mb-4">No customers found. Please add a customer first.</p>
            <button onclick="closeModal(); navigateTo('customers')" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">Go to Customers</button>
          </div>
        `;
      } else {
      modalContent = `
        <h2 class="text-2xl font-bold mb-4">${isEdit ? 'Edit' : 'Add'} Page</h2>
        <form id="modal-form" class="space-y-4">
          <div>
              <label class="block text-sm font-medium mb-2">Page Name *</label>
            <input type="text" id="page-name" value="${Security.escapeHtml(pageData.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>
          <div>
              <label class="block text-sm font-medium mb-2">Category *</label>
            <input type="text" id="page-category" value="${Security.escapeHtml(pageData.category || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" />
          </div>
            
            <!-- Customer Linking Section -->
            <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
              <div class="flex items-center space-x-2 mb-3">
                <i data-lucide="users" class="w-4 h-4 text-blue-600"></i>
                <label class="text-sm font-bold text-blue-900 dark:text-blue-100">Link to Customer(s) *</label>
              </div>
              
              ${!isAdminPage ? `
                <div class="mb-3 p-2 bg-amber-100 dark:bg-amber-900/20 rounded-lg">
                  <p class="text-xs text-amber-800 dark:text-amber-200">
                    <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
                    You can only link a page to one customer
                  </p>
                </div>
              ` : ''}
              
              <div class="relative mb-3">
                <input 
                  type="text" 
                  id="page-customer-search" 
                  placeholder="Search for customer..."
                  class="w-full glass-input px-4 py-2 rounded-xl"
                  oninput="filterPageCustomers()"
                  onfocus="showPageCustomerDropdown()"
                />
                <div id="page-customer-dropdown" class="absolute z-20 mt-1 w-full glass-panel rounded-lg shadow-xl max-h-60 overflow-y-auto hidden">
                  ${pageCustomers.map(c => `
                    <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectPageCustomer('${c.id}', '${isAdminPage}')">
                      <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
                      <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || 'No phone')}</div>
                    </div>
                  `).join('')}
                </div>
              </div>
              
              <div id="page-selected-customers" class="space-y-2">
                ${existingCustomerIds.map(cid => {
                  const customer = state.customers.find(c => c.id === cid);
                  return customer ? `
                    <div class="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-lg border border-indigo-200 dark:border-indigo-800 page-customer-item" data-customer-id="${cid}">
                      <div>
                        <div class="font-medium text-sm text-slate-800 dark:text-white">${Security.escapeHtml(customer.name || '')}</div>
                        <div class="text-xs text-slate-500">${Security.escapeHtml(customer.platform || '')}</div>
                      </div>
                      <button type="button" onclick="removePageCustomer('${cid}')" class="text-rose-500 hover:text-rose-700">
                        <i data-lucide="x-circle" class="w-4 h-4"></i>
                      </button>
                    </div>
                  ` : '';
                }).join('')}
                <div id="page-no-customers" class="${existingCustomerIds.length > 0 ? 'hidden' : ''} text-sm text-slate-400 text-center py-4 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                  No customers selected yet. Please search and select at least one customer above.
                </div>
              </div>
              
                ${isAdminPage ? `
                <div id="page-multi-customer-warning" class="hidden mt-3 p-3 bg-rose-50 dark:bg-rose-900/20 rounded-lg border border-rose-200 dark:border-rose-800">
                  <div class="flex items-start space-x-2">
                    <i data-lucide="alert-triangle" class="w-4 h-4 text-rose-600 mt-0.5"></i>
                    <div>
                      <p class="text-xs font-bold text-rose-900 dark:text-rose-100">Warning: Multiple Customers</p>
                      <p class="text-xs text-rose-700 dark:text-rose-300 mt-1">This page is linked to multiple customers. This is uncommon and may cause confusion. Are you sure this is what you want?</p>
                    </div>
                  </div>
                </div>
              ` : ''}
            </div>
            
          <div class="flex space-x-3">
            <button type="submit" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">${isEdit ? 'Save Changes' : 'Create Page'}</button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold">Cancel</button>
          </div>
        </form>
      `;
      }
      break;
    case 'receipt':
      const receiptCustomers = getVisibleRecords(state.customers);
      const receiptData = state.modalData || {};
      const isAdminReceipt = isCurrentUserAdmin();
      const defaultRate1 = getDefaultRate1(PAYMENT_METHODS[0]);
      const existingPayments = receiptData.payments || [{ method: PAYMENT_METHODS[0], amount: 0, rate: defaultRate1, rate2: state.defaultExchangeRate, collectionType: 'office', deliveryPersonId: '' }];
      const receiptDeliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      // Copy (not alias) the live record's photos so add/remove in the modal
      // does not mutate the saved receipt when the user cancels.
      state.tempReceiptPhotos = (receiptData.photos || []).slice();
      
      if (receiptCustomers.length === 0) {
        modalContent = `
          <h2 class="text-2xl font-bold mb-4">Add Receipt</h2>
          <div class="text-center py-8">
            <i data-lucide="alert-circle" class="w-12 h-12 mx-auto text-amber-500 mb-4"></i>
            <p class="text-slate-600 dark:text-slate-400 mb-4">No customers found. Please add a customer first.</p>
            <button onclick="closeModal(); navigateTo('customers')" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">Go to Customers</button>
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
            <!-- Phone Search Section -->
            <div class="grid grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2 flex items-center">
                  <i data-lucide="phone" class="w-3 h-3 mr-1"></i>
                  Search phone...
                </label>
                <input 
                  type="text" 
                  id="receipt-phone-search" 
                  placeholder="Type phone number..."
                  class="w-full glass-input px-3 py-2 rounded-lg text-sm"
                  oninput="filterReceiptPhones()"
                  onfocus="showReceiptPhoneDropdown()"
                />
                <div id="receipt-phone-dropdown" class="absolute z-20 mt-1 w-80 glass-panel rounded-lg shadow-xl max-h-40 overflow-y-auto hidden">
                  ${phoneCustomerMap.map(item => `
                    <div class="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer phone-option" data-phone="${Security.escapeHtml(item.phone)}" data-customer-id="${Security.escapeHtml(item.customer.id)}" onclick="selectReceiptPhone(this.dataset.phone, this.dataset.customerId)">
                      <div class="text-sm font-medium">${Security.escapeHtml(item.phone)}</div>
                      <div class="text-xs text-slate-500">${Security.escapeHtml(item.customer.name)} - ${Security.escapeHtml(item.customer.platform)}</div>
                    </div>
                  `).join('')}
                </div>
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-500 mb-2">Select phone first...</label>
                <input type="text" id="receipt-customer-name" readonly class="w-full glass-input px-3 py-2 rounded-lg text-sm bg-slate-100 dark:bg-slate-800" placeholder="Customer will appear here" />
                <input type="hidden" id="receipt-customer-id" value="${receiptData.customerId || ''}" />
              </div>
            </div>

            <!-- Receipt Number -->
            <div class="px-1">
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5">Receipt Number</label>
              <input type="text" id="receipt-serial" value="${receiptData.serialNumber || receiptData.finalReceiptNo || receiptData.tempReceiptNo || ''}" 
                class="w-full glass-input px-3 py-2 rounded-lg text-sm" 
                placeholder="e.g., 12345" 
                oninput="validateReceiptNumberInput(this)"
                onblur="checkReceiptNumberDuplicate(this)" />
              <div id="receipt-serial-error" class="hidden mt-1 text-xs text-rose-500 font-medium"></div>
              <div id="receipt-temp-hint" class="hidden mt-1 text-xs text-indigo-600 font-medium"></div>
            </div>

            <!-- Status Tabs -->
            <div class="px-1">
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1.5">Status</label>
              <div class="grid grid-cols-4 gap-1.5" id="receipt-status-tabs">
                <button type="button" onclick="setReceiptStatus(this, 'Paid')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${!receiptData.status || receiptData.status === 'Paid' ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Paid">Paid</button>
                <button type="button" onclick="setReceiptStatus(this, 'Not Paid')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Not Paid' ? 'bg-blue-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Not Paid">Not Paid</button>
                <button type="button" onclick="setReceiptStatus(this, 'Canceled')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Canceled' ? 'bg-rose-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Canceled">Canceled</button>
                <button type="button" onclick="setReceiptStatus(this, 'Lost')" class="receipt-status-btn px-4 py-2 rounded-lg text-sm font-medium transition-all ${receiptData.status === 'Lost' ? 'bg-slate-500 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}" data-status="Lost">Lost</button>
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
                      <div class="text-sm font-bold text-blue-900 dark:text-blue-100">Payment Collected</div>
                      <div class="text-xs text-blue-600/80 dark:text-blue-300/80">Choose how the payment was collected</div>
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
                        <div class="font-bold text-sm ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">In Office</div>
                        <div class="text-[10px] ${(!receiptData.statusDetail?.paidCollection || receiptData.statusDetail?.paidCollection === 'office') ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Paid in shop/office</div>
                      </div>
                    </div>
                  </button>

                  <button type="button" onclick="selectPaidCollection('delivery')" class="paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="delivery">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="truck" class="w-6 h-6 ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">By Delivery</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.paidCollection === 'delivery' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Driver collected payment</div>
                      </div>
                    </div>
                  </button>
                </div>

                <div id="paid-delivery-person-section" class="${receiptData.statusDetail?.paidCollection === 'delivery' ? '' : 'hidden'} mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                  <label class="block text-xs font-bold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center space-x-2">
                    <i data-lucide="user-check" class="w-4 h-4"></i>
                    <span>Delivery Person (optional)</span>
                  </label>
                  <select id="paid-delivery-person" class="w-full glass-input px-3 py-2 rounded-lg text-sm border border-emerald-200 dark:border-emerald-700 focus:ring-2 focus:ring-emerald-500/20">
                    <option value="">Select delivery person...</option>
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
                      <div class="text-sm font-bold text-amber-900 dark:text-amber-100">Payment Pending</div>
                      <div class="text-xs text-amber-600/80 dark:text-amber-300/80 flex items-center space-x-1">
                        <i data-lucide="lock" class="w-3 h-3"></i>
                        <span>Receipt # locked until paid</span>
              </div>
                </div>
                  </div>
                  ${isAdminReceipt ? `
                    <label class="flex items-center space-x-2 px-3 py-2 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-amber-200 dark:border-amber-700 cursor-pointer hover:bg-white dark:hover:bg-slate-800 transition-all">
                      <input type="checkbox" id="status-not-paid-admin-override" class="w-4 h-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500" onchange="updateReceiptStatusUI('Not Paid')" ${receiptData.statusDetail?.allowSerialOverride ? 'checked' : ''}/>
                      <span class="text-xs font-bold text-amber-800 dark:text-amber-200">Admin Override</span>
                    </label>
                  ` : ''}
                      </div>

                <div class="pt-3 border-t border-amber-200/60 dark:border-amber-700/40">
                  <div class="text-xs font-bold text-amber-800 dark:text-amber-200 mb-3 flex items-center space-x-2">
                    <i data-lucide="map-pin" class="w-3 h-3"></i>
                    <span>How will customer pay?</span>
                  </div>
                  <input type="hidden" id="notpaid-collection-value" value="${receiptData.statusDetail?.notPaidCollection || 'office'}" />
                        <div class="grid grid-cols-2 gap-3">
                    <button type="button" onclick="selectNotPaidCollection('office')" class="notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-600 hover:shadow-lg'}" data-value="office">
                      <div class="flex flex-col items-center space-y-2">
                        <span class="w-12 h-12 rounded-2xl ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'bg-white/20' : 'bg-gradient-to-br from-blue-100 to-indigo-200 dark:from-blue-900/50 dark:to-indigo-900/50'} flex items-center justify-center shadow-inner">
                          <i data-lucide="store" class="w-6 h-6 ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white' : 'text-blue-600 dark:text-blue-400'}"></i>
                        </span>
                          <div>
                          <div class="font-bold text-sm ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">In Shop</div>
                          <div class="text-[10px] ${!receiptData.statusDetail?.notPaidCollection || receiptData.statusDetail?.notPaidCollection === 'office' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Customer visits office</div>
                          </div>
                      </div>
                    </button>
                    <button type="button" onclick="selectNotPaidCollection('delivery')" class="notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="delivery">
                      <div class="flex flex-col items-center space-y-2">
                        <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                          <i data-lucide="truck" class="w-6 h-6 ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                        </span>
                          <div>
                          <div class="font-bold text-sm ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Delivery</div>
                          <div class="text-[10px] ${receiptData.statusDetail?.notPaidCollection === 'delivery' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Driver collects payment</div>
                        </div>
                      </div>
                    </button>
                  </div>
                  
                  <!-- Delivery Person Selection (shown when Delivery is selected) -->
                  <div id="notpaid-delivery-person-section" class="${receiptData.statusDetail?.notPaidCollection === 'delivery' ? '' : 'hidden'} mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700">
                    <label class="block text-xs font-bold text-emerald-700 dark:text-emerald-300 mb-2 flex items-center space-x-2">
                      <i data-lucide="user-check" class="w-4 h-4"></i>
                      <span>Assign Delivery Person</span>
                    </label>
                    <select id="notpaid-delivery-person" class="w-full glass-input px-3 py-2 rounded-lg text-sm border border-emerald-200 dark:border-emerald-700 focus:ring-2 focus:ring-emerald-500/20">
                      <option value="">Select delivery person...</option>
                      ${getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role)).map(u => 
                        `<option value="${u.id}" ${receiptData.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`
                      ).join('')}
                    </select>
                  </div>

                  <!-- Delivery Info (Required for Temp Delivery Receipts) -->
                  <div id="receipt-delivery-info" class="hidden mt-3 p-3 rounded-xl bg-white/70 dark:bg-slate-800/60 border border-emerald-200 dark:border-emerald-800 space-y-3">
                    <div class="text-xs font-bold text-emerald-700 dark:text-emerald-300 flex items-center space-x-2">
                      <i data-lucide="map-pin" class="w-4 h-4"></i>
                      <span>Delivery Info (Required)</span>
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">Place name *</label>
                      <input type="text" id="receipt-delivery-place" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Neighborhood / address / destination" value="${Security.escapeHtml(receiptData.deliveryPlaceName || '')}" maxlength="200" />
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">Quoted delivery fee (LYD) *</label>
                      <input type="text" inputmode="decimal" id="receipt-quoted-delivery-fee" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${(receiptData.quotedDeliveryFee ?? '')}" oninput="sanitizeMoneyInput(this)" />
                    </div>
                    <div>
                      <label class="block text-[10px] font-bold text-slate-600 dark:text-slate-400 mb-1">Instructions (optional)</label>
                      <textarea id="receipt-delivery-instructions" rows="2" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Landmarks, notes...">${Security.escapeHtml(receiptData.deliveryInstructions || '')}</textarea>
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
                    <div class="text-sm font-bold text-rose-900 dark:text-rose-100">What happened?</div>
                    <div class="text-xs text-rose-600/80 dark:text-rose-300/80">Choose the cancellation outcome</div>
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
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Full Refund</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'full' ? 'text-white/80' : 'text-slate-500'}">Return all money</div>
                          </div>
                          </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('partial')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'partial' ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-amber-300 dark:hover:border-amber-700 hover:shadow-md'}" data-value="partial">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'partial' ? 'bg-white/20' : 'bg-amber-100 dark:bg-amber-900/40'} flex items-center justify-center">
                        <i data-lucide="pie-chart" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white' : 'text-amber-600 dark:text-amber-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Partial Refund</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'partial' ? 'text-white/80' : 'text-slate-500'}">Return some money</div>
                        </div>
                    </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('forgiven')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-violet-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md'}" data-value="forgiven">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'bg-white/20' : 'bg-violet-100 dark:bg-violet-900/40'} flex items-center justify-center">
                        <i data-lucide="heart-handshake" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white' : 'text-violet-600 dark:text-violet-400'}"></i>
                      </span>
                        <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Forgiven</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'forgiven' ? 'text-white/80' : 'text-slate-500'}">No refund needed</div>
                          </div>
                        </div>
                  </button>
                  <button type="button" onclick="selectCancelOption('undecided')" class="cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300 ${receiptData.statusDetail?.refundAction === 'undecided' ? 'bg-gradient-to-r from-slate-500 to-slate-600 text-white shadow-lg shadow-slate-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600 hover:shadow-md'}" data-value="undecided">
                    <div class="flex items-center space-x-3">
                      <span class="flex-shrink-0 w-8 h-8 rounded-lg ${receiptData.statusDetail?.refundAction === 'undecided' ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center">
                        <i data-lucide="clock" class="w-4 h-4 ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white' : 'text-slate-600 dark:text-slate-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Undecided</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.refundAction === 'undecided' ? 'text-white/80' : 'text-slate-500'}">Decide later</div>
                      </div>
                    </div>
                  </button>
                </div>
                <div id="cancel-refund-status-section" class="${(receiptData.status === 'Canceled' && (receiptData.statusDetail?.refundAction === 'full' || receiptData.statusDetail?.refundAction === 'partial')) ? '' : 'hidden'} pt-3 border-t border-rose-200 dark:border-rose-800/50 space-y-2">
                  <div class="text-xs font-bold text-rose-800 dark:text-rose-200 flex items-center space-x-2">
                    <i data-lucide="loader" class="w-3 h-3"></i>
                    <span>Refund Progress</span>
              </div>
                  <input type="hidden" id="status-cancel-refund-status" value="${receiptData.statusDetail?.refundStatus || 'pending'}" />
                  <div class="flex space-x-2">
                    <button type="button" onclick="selectRefundStatus('pending')" class="refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300 ${receiptData.statusDetail?.refundStatus !== 'refunded' ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30' : 'bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-amber-300'}" data-value="pending">
                      <i data-lucide="hourglass" class="w-4 h-4 inline mr-1.5"></i>Pending
                    </button>
                    <button type="button" onclick="selectRefundStatus('refunded')" class="refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300 ${receiptData.statusDetail?.refundStatus === 'refunded' ? 'bg-gradient-to-r from-emerald-400 to-green-500 text-white shadow-lg shadow-emerald-500/30' : 'bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-emerald-300'}" data-value="refunded">
                      <i data-lucide="check-circle" class="w-4 h-4 inline mr-1.5"></i>Refunded
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
                    <div class="text-sm font-bold text-indigo-900 dark:text-indigo-100">What's the situation?</div>
                    <div class="text-xs text-indigo-600/80 dark:text-indigo-300/80">Was this receipt paid or empty?</div>
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
                        <div class="font-bold text-sm ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Empty</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.lostResolution === 'empty' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">No payment received</div>
                      </div>
                    </div>
                  </button>
                  <button type="button" onclick="selectLostOption('paid')" class="lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300 ${receiptData.statusDetail?.lostResolution === 'paid' ? 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]' : 'bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:shadow-lg'}" data-value="paid">
                    <div class="flex flex-col items-center space-y-2">
                      <span class="w-12 h-12 rounded-2xl ${receiptData.statusDetail?.lostResolution === 'paid' ? 'bg-white/20' : 'bg-gradient-to-br from-emerald-100 to-teal-200 dark:from-emerald-900/50 dark:to-teal-900/50'} flex items-center justify-center shadow-inner">
                        <i data-lucide="wallet" class="w-6 h-6 ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white' : 'text-emerald-600 dark:text-emerald-400'}"></i>
                      </span>
                      <div>
                        <div class="font-bold text-sm ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white' : 'text-slate-800 dark:text-slate-200'}">Paid</div>
                        <div class="text-[10px] ${receiptData.statusDetail?.lostResolution === 'paid' ? 'text-white/70' : 'text-slate-500 dark:text-slate-400'}">Receipt was lost</div>
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
                  <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300">Financial Details</h3>
                </div>
                <button type="button" onclick="addReceiptPaymentSplit()" class="text-emerald-600 hover:text-emerald-700 text-xs font-bold flex items-center space-x-1">
                  <i data-lucide="plus-circle" class="w-3 h-3"></i>
                  <span>Add Split</span>
                </button>
              </div>

              <!-- Payment Methods Label -->
              <div class="mb-2">
                <label class="text-[10px] font-bold text-slate-500 uppercase">Payment Methods</label>
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
                    <span>Photos</span>
                  </label>
                  <label class="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center space-x-1 cursor-pointer">
                    <i data-lucide="upload" class="w-3 h-3"></i><span>Add Photo</span>
                    <input type="file" accept="image/*" multiple class="hidden" onchange="uploadReceiptPhotos(this.files)" />
                  </label>
                </div>
                <div id="receipt-photo-previews" class="grid grid-cols-4 gap-2"></div>
              </div>
            </div>

            <!-- Action Buttons -->
            <div class="flex space-x-2 px-1 pt-3 border-t border-slate-200 dark:border-slate-700">
              <button type="button" onclick="saveReceiptFromModal()" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-purple-700">
                <i data-lucide="check" class="w-4 h-4 inline mr-1.5"></i>${isEdit ? 'Save' : 'Create'}
              </button>
              <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">Cancel</button>
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
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="swap" class="w-6 h-6 mr-2 text-blue-600"></i>
          Transfer Receipt Balance
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
            <div class="text-xs text-slate-500 mb-1">Available Balance</div>
            <div class="text-lg font-bold text-blue-700 dark:text-blue-200">$${availableUSD.toFixed(2)} USD</div>
            <div class="text-xs text-slate-500">~ ${(availableUSD * (transferReceipt.exchangeRate || state.defaultExchangeRate || 1)).toFixed(2)} LYD</div>
          </div>

          ${transferCustomers.length === 0 ? `
            <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-200 text-sm">
              No other customers available to transfer to. Please add another customer first.
                </div>
          ` : `
            <div>
              <label class="block text-sm font-medium mb-2">Transfer to Customer *</label>
              <select id="transfer-target-customer" class="w-full glass-input px-4 py-2 rounded-xl">
                <option value="">Select customer</option>
                ${transferCustomers.map(c => `<option value="${c.id}">${Security.escapeHtml(c.name || '')}</option>`).join('')}
              </select>
                </div>
            <div>
              <label class="block text-sm font-medium mb-2">Amount (USD) *</label>
              <input type="text" inputmode="decimal" id="transfer-amount-usd" value="${availableUSD.toFixed(2)}" class="w-full glass-input px-4 py-2 rounded-xl" min="0" max="${availableUSD.toFixed(2)}" oninput="sanitizeMoneyInput(this)" />
              <p class="text-xs text-slate-500 mt-1">Available: $${availableUSD.toFixed(2)}</p>
              </div>
            <div>
              <label class="block text-sm font-medium mb-2">Note (optional)</label>
              <textarea id="transfer-note" class="w-full glass-input px-4 py-2 rounded-xl" rows="3" placeholder="Why are you transferring?"></textarea>
            </div>
          `}

          ${transferReceipt.transfers && transferReceipt.transfers.length > 0 ? `
            <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
              <div class="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2 flex items-center space-x-1">
                <i data-lucide="history" class="w-3 h-3"></i><span>Transfer History</span>
              </div>
              <div class="space-y-1 text-xs text-slate-600 dark:text-slate-300 max-h-24 overflow-y-auto custom-scrollbar pr-1">
                ${transferReceipt.transfers.map(t => {
                  const targetCustomer = state.customers.find(c => c.id === t.toCustomerId);
                  const name = targetCustomer ? targetCustomer.name : 'Unknown';
                  return `<div class="flex justify-between">
                    <span>${new Date(t.date).toLocaleString()}</span>
                    <span class="font-medium">$${(t.amountUSD || 0).toFixed(2)} → ${name}</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
          ` : ''}

          <div class="flex space-x-3 pt-2 border-t border-slate-200 dark:border-slate-700 mt-2">
            <button type="button" onclick="saveReceiptTransfer()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold" ${transferCustomers.length === 0 ? 'disabled' : ''}>
              <i data-lucide="check" class="w-4 h-4 inline mr-1.5"></i>Transfer
              </button>
            <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold">Cancel</button>
            </div>
          </div>
        `;
      break;
    case 'split-payments':
      const splitReceipt = state.modalData;
      const splitExistingPayments = splitReceipt.payments || [];
      const splitDeliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="credit-card" class="w-6 h-6 mr-2 text-purple-600"></i>
          Manage Split Payments
        </h2>
        <div class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar pr-2">
          <div class="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl">
            <div class="text-sm font-medium text-indigo-700 dark:text-indigo-300 mb-2">Receipt Total</div>
            <div class="text-2xl font-bold text-indigo-600">$${splitReceipt.amountUSD?.toFixed(2)} = ${splitReceipt.amountLocal?.toFixed(2)} LYD</div>
            <div class="text-xs text-slate-500 mt-1">Exchange Rate: ${splitReceipt.exchangeRate}</div>
          </div>

          <div id="split-payments-container" class="space-y-3">
            ${splitExistingPayments.map((payment, idx) => `
              <div class="split-payment-item p-4 rounded-lg">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs font-medium mb-1">Payment Method</label>
                    <select class="split-method w-full glass-input px-3 py-2 rounded-lg text-sm">
                      ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${m}</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">Amount (LYD)</label>
                    <input type="text" inputmode="decimal" class="split-amount w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.amount}" oninput="sanitizeMoneyInput(this)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">Exchange Rate</label>
                    <input type="text" inputmode="decimal" class="split-rate w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.rate || state.defaultExchangeRate}" oninput="sanitizeMoneyInput(this, 4)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">USD Rate (Rate 2)</label>
                    <input type="text" inputmode="decimal" class="split-rate2 w-full glass-input px-3 py-2 rounded-lg text-sm" value="${payment.rate2 !== undefined ? payment.rate2 : (payment.rate || state.defaultExchangeRate)}" oninput="sanitizeMoneyInput(this, 4)" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium mb-1">Collection Type</label>
                    <select class="split-collection w-full glass-input px-3 py-2 rounded-lg text-sm">
                      <option value="office" ${payment.collectionType === 'office' ? 'selected' : ''}>Office</option>
                      <option value="delivery" ${payment.collectionType === 'delivery' ? 'selected' : ''}>Delivery</option>
                      <option value="bank" ${payment.collectionType === 'bank' ? 'selected' : ''}>Bank</option>
                    </select>
                  </div>
                  ${splitDeliveryUsers.length > 0 ? `
                    <div class="col-span-2">
                      <label class="block text-xs font-medium mb-1">Delivery Person</label>
                      <select class="split-delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm">
                        <option value="">None</option>
                        ${splitDeliveryUsers.map(u => `<option value="${u.id}" ${payment.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
                      </select>
                    </div>
                  ` : ''}
                  <div class="col-span-2 flex justify-end">
                    <button type="button" onclick="this.closest('.split-payment-item').remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700 text-sm font-medium flex items-center space-x-1">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                      <span>Remove</span>
                    </button>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>

          <button type="button" onclick="addSplitPayment()" class="w-full btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center space-x-2">
            <i data-lucide="plus-circle" class="w-4 h-4"></i>
            <span>Add Payment Split</span>
          </button>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveSplitPayments()" class="flex-1 btn-shine bg-purple-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>Save Split Payments
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">Cancel</button>
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

      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="trending-up" class="w-6 h-6 mr-2 text-blue-600"></i>
          Manage Top-ups
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
            <div class="text-sm font-medium text-blue-700 dark:text-blue-300">Ad Details</div>
            <div class="text-lg font-bold text-blue-600 mt-1">Original: $${topUpBase} → New: $${(topUpBase + topUpWorkingTotal).toFixed(2)}</div>
            ${existingTopUps.length > 0 ? `<div class="text-xs text-slate-500 mt-1">Total top-ups: $${topUpWorkingTotal.toFixed(2)}</div>` : ''}
          </div>

          <div id="topups-container" class="space-y-2">
            ${existingTopUps.map((topup, idx) => `
              <div class="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <div class="font-medium">$${topup.amount}</div>
                  <div class="text-xs text-slate-500">${new Date(topup.date).toLocaleDateString()} - ${Security.escapeHtml(topup.note || '')}</div>
                </div>
                <button type="button" onclick="removeTopUp(${idx})" class="text-rose-500 hover:text-rose-700">
                  <i data-lucide="x-circle" class="w-4 h-4"></i>
                </button>
              </div>
            `).join('')}
          </div>

          <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl space-y-3">
            <h4 class="text-sm font-medium">Add New Top-up</h4>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs mb-1">Amount (USD)</label>
                <input type="text" inputmode="decimal" id="topup-amount" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="0.00" oninput="sanitizeMoneyInput(this)" />
              </div>
              <div>
                <label class="block text-xs mb-1">Date</label>
                <input type="date" id="topup-date" value="${getTodayDateString()}" class="w-full glass-input px-3 py-2 rounded-lg" />
              </div>
            </div>
            <div>
              <label class="block text-xs mb-1">Note</label>
              <input type="text" id="topup-note" class="w-full glass-input px-3 py-2 rounded-lg" placeholder="Reason for top-up..." />
            </div>
            <button type="button" onclick="addNewTopUp()" class="w-full btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold">
              <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>Add Top-up
            </button>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveTopUps()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>Save Top-ups
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">Cancel</button>
          </div>
        </div>
      `;
      break;
    case 'refund':
      const refundAd = state.modalData;
      
      modalContent = `
        <h2 class="text-2xl font-bold mb-4 flex items-center">
          <i data-lucide="arrow-left-circle" class="w-6 h-6 mr-2 text-rose-600"></i>
          Manage Refund
        </h2>
        <div class="space-y-4">
          <div class="p-4 bg-rose-50 dark:bg-rose-900/20 rounded-xl">
            <div class="text-sm font-medium text-rose-700 dark:text-rose-300">Ad Amount</div>
            <div class="text-2xl font-bold text-rose-600">$${refundAd.amountUSD} (${refundAd.amountLocal} LYD)</div>
            ${refundAd.refundType && refundAd.refundType !== 'None' ? `
              <div class="text-xs text-slate-500 mt-2">Current Refund: ${refundAd.refundType} - $${refundAd.refundAmount || 0} (${refundAd.refundStatus || 'Pending'})</div>
            ` : ''}
          </div>

          <div>
            <label class="block text-sm font-medium mb-2">Refund Type</label>
            <select id="refund-type" class="w-full glass-input px-4 py-2 rounded-xl" onchange="toggleRefundAmount(this.value)">
              ${REFUND_TYPES.map(t => `<option value="${t}" ${refundAd.refundType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>

          <div id="refund-amount-section" class="${!refundAd.refundType || refundAd.refundType === 'None' ? 'hidden' : ''}">
            <label class="block text-sm font-medium mb-2">Refund Amount (USD)</label>
            <input type="text" inputmode="decimal" id="refund-amount" value="${refundAd.refundAmount || (refundAd.refundType === 'Full' ? refundAd.amountUSD : 0)}" class="w-full glass-input px-4 py-2 rounded-xl" oninput="sanitizeMoneyInput(this)" />
          </div>

          <div id="refund-status-section" class="${!refundAd.refundType || refundAd.refundType === 'None' ? 'hidden' : ''}">
            <label class="block text-sm font-medium mb-2">Refund Status</label>
            <select id="refund-status" class="w-full glass-input px-4 py-2 rounded-xl">
              <option value="Pending" ${refundAd.refundStatus === 'Pending' ? 'selected' : ''}>Pending</option>
              <option value="Refunded" ${refundAd.refundStatus === 'Refunded' ? 'selected' : ''}>Refunded</option>
            </select>
          </div>

          <div class="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl flex items-start space-x-2">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-600 mt-0.5"></i>
            <p class="text-xs text-amber-700 dark:text-amber-300">Refunds will mark the ad status as Canceled and track the refund amount.</p>
          </div>

          <div class="flex space-x-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button onclick="saveRefund()" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-3 rounded-xl font-bold">
              <i data-lucide="check" class="w-4 h-4 inline mr-2"></i>Save Refund
            </button>
            <button onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-3 rounded-xl font-bold">Cancel</button>
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
            <button type="button" onclick="copyTextToClipboard('${key}').then(ok => showNotification(ok ? 'Copied' : 'Copy Failed', ok ? 'Recovery key copied' : 'Please copy manually', ok ? 'success' : 'error'))" class="flex-1 btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
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
                <input type="password" id="pwreset-new" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" minlength="8" />
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
              <input type="password" id="pwreset-new" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" minlength="8" ${hasRecovery ? '' : 'disabled'} />
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
            <input type="password" id="cp-new" required minlength="8" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" />
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
  }
  
  const modal = document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  // Smaller, more compact modal sizes
  let modalSize = 'max-w-md';
  if (state.activeModal === 'split-payments' || state.activeModal === 'top-ups' || state.activeModal === 'refund') {
    modalSize = 'max-w-4xl';
  } else if (state.activeModal === 'ad') {
    modalSize = 'max-w-xl'; // Wider modal for new Ad design with sections
  } else if (state.activeModal === 'receipt') {
    modalSize = 'max-w-lg'; // Compact size for receipts
  }
  // Make Ad/Receipt modals scroll on the whole panel (header + content) to avoid "nothing shows" confusion.
  const modalScrollable = (state.activeModal === 'receipt' || state.activeModal === 'ad')
    ? ' max-h-[90vh] overflow-y-auto custom-scrollbar'
    : '';
  modal.innerHTML = `<div class="glass-panel rounded-2xl p-6 w-full ${modalSize}${modalScrollable}" onclick="event.stopPropagation()">${modalContent}</div>`;
  modal.onclick = closeModal;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  
  // Initialize receipt totals if it's a receipt modal
  if (state.activeModal === 'receipt') {
    setTimeout(() => {
      updateReceiptTotals();
      updateReceiptStatusUI(document.getElementById('receipt-status')?.value || 'Paid');
      // Pre-populate customer if editing
      if (state.modalData && state.modalData.customerId) {
        const customer = state.customers.find(c => c.id === state.modalData.customerId);
        if (customer && Array.isArray(customer.phones) && customer.phones.length > 0) {
          selectReceiptPhone(customer.phones[0], customer.id);
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
      const initialPaymentStatus = adData.paymentStatus || 'paid';
      setAdPaymentStatus(initialPaymentStatus);
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
  }
  
  const form = document.getElementById('modal-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await handleModalSubmit();
      } catch (err) {
        console.error('Modal submit error:', err);
        showNotification('Error', 'Failed to save changes', 'error');
      }
    });
  }
}

async function handleModalSubmit() {
  const isEdit = state.modalData !== null;
  
  switch (state.activeModal) {
    case 'change-password': {
      if (!state.currentUser?.id) {
        showNotification('Error', 'Not logged in', 'error');
        return;
      }

      const currentPw = String(document.getElementById('cp-current')?.value || '');
      const newPw = String(document.getElementById('cp-new')?.value || '');
      const confirmPw = String(document.getElementById('cp-confirm')?.value || '');

      if (!currentPw) {
        showNotification('Validation', 'Current password is required', 'error');
        return;
      }
      if (!newPw || newPw.length < 8) {
        showNotification('Validation', 'Password must be at least 8 characters', 'error');
        return;
      }
      if (newPw !== confirmPw) {
        showNotification('Validation', 'Passwords do not match', 'error');
        return;
      }

      if (isServerModeEnabled()) {
        try {
          await apiChangePassword(currentPw, newPw);
          showNotification('Success', 'Password changed successfully', 'success');
        } catch (e) {
          showNotification('Error', e.message || 'Failed to change password', 'error');
          return;
        }
        break;
      }

      // Local mode
      const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id) || state.currentUser;
      if (!user) {
        showNotification('Error', 'User not found', 'error');
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
        showNotification('Error', 'Current password is incorrect', 'error');
        addSecurityLog('password_change_bad_current', user.email || user.id);
        return;
      }

      const hashed = await Security.hashPassword(newPw, null, { algo: 'pbkdf2-sha256' });
      updateRecord(state.users, user.id, {
        passwordHash: hashed.hash,
        salt: hashed.salt,
        passwordAlgo: hashed.algo,
        passwordIterations: hashed.iterations
      });
      addSecurityLog('password_changed', user.email || user.id);
      showNotification('Success', 'Password changed successfully', 'success');
      break;
    }
    case 'customer':
      // Collect all phone numbers
      const phoneInputs = document.querySelectorAll('.customer-phone');
      const phones = Array.from(phoneInputs).map(input => input.value.trim()).filter(p => p);
      
      // Check for duplicate phone numbers with other customers
      const currentCustomerId = isEdit ? state.modalData.id : null;
      const duplicatePhone = checkDuplicatePhone(phones, currentCustomerId);
      if (duplicatePhone) {
        showNotification('Duplicate Phone Number', `The phone number "${duplicatePhone.phone}" is already linked to customer "${duplicatePhone.customerName}". Please use a different phone number.`, 'error');
        return; // Stop here, don't close modal
      }
      
      // Collect all profile links
      const linkInputs = document.querySelectorAll('.customer-link');
      const profileLinks = Array.from(linkInputs).map(input => input.value.trim()).filter(l => l);
      
      // Get join date
      const joinDateValue = document.getElementById('customer-joindate').value;
      const joinDate = joinDateValue ? new Date(joinDateValue).toISOString() : new Date().toISOString();
      
      if (isEdit) {
        updateRecord(state.customers, state.modalData.id, {
          name: document.getElementById('customer-name').value,
          phones: phones,
          platform: document.getElementById('customer-platform').value,
          joinDate: joinDate,
          profileLinks: profileLinks
        });
        showNotification('Updated', 'Customer updated successfully', 'success');
      } else {
        const customer = {
          id: generateId('cust'),
          name: document.getElementById('customer-name').value,
          phones: phones,
          platform: document.getElementById('customer-platform').value,
          joinDate: joinDate,
          profileLinks: profileLinks
        };
        addRecord(state.customers, customer);
        showNotification('Success', 'Customer added successfully', 'success');
      }
      break;
    case 'ad':
      try {
      const paymentStatus = document.getElementById('ad-payment-status')?.value || 'paid';
      const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
      const adLinkInputs = Array.from(document.querySelectorAll('.ad-link-input')).map(i => (i.value || '').trim()).filter(Boolean);
      
      // Get amount based on payment status
      let amountUSD = 0;
      let collectionPayments = [];
      if (paymentStatus === 'paid') {
        // For paid ads, calculate amount from receipt allocations planned spend
        const allocations = (state.tempAdFunding?.allocations || []).filter(a => a.receiptId && parseFloat(a.amountUSD) > 0);
        amountUSD = allocations.reduce((sum, a) => sum + parseFloat(a.amountUSD), 0);
      } else {
        // Use financial details (R2 totals) for Not Paid / Won't Pay
        collectionPayments = getReceiptPaymentData();
        const totals = getPaymentTotalsFromDom();
        amountUSD = totals.totalR2;
      }
      
      let exchangeRate = parseFloat(document.getElementById('ad-rate')?.value || state.defaultExchangeRate);
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
        showNotification('Error', 'Please select a page', 'error');
        return;
      }
      
      // Get customer ID from searchable dropdown hidden field
      const customerId = document.getElementById('ad-customer-id')?.value;
      if (!customerId) {
        showNotification('Error', 'Please select a customer', 'error');
        return;
      }

      // Normalize amount for unpaid flows; paid flows rely on receipt allocations
      if (paymentStatus !== 'paid' && !Number.isFinite(amountUSD)) {
        amountUSD = 0;
      }

      // Validate funding allocations (only required when paid)
      let allocations = (state.tempAdFunding?.allocations || []).filter(a => a.receiptId && parseFloat(a.amountUSD) > 0)
        .map(a => ({ receiptId: a.receiptId, amountUSD: parseFloat(a.amountUSD) }));

      if (isPaid && allocations.length === 0) {
        showNotification('Validation', 'Please link at least one receipt to fund this ad.', 'error');
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
          showNotification('Validation', 'Total allocation amount must be greater than zero.', 'error');
          return;
        }

        // Set amountUSD from allocations total for paid ads (ensures consistency)
        amountUSD = totalAllocated;

        for (const [receiptId, plannedTotal] of totalsByReceipt.entries()) {
          const receipt = state.receipts.find(r => String(r.id) === String(receiptId));
          if (!receipt) {
            showNotification('Validation', 'One of the selected receipts is missing.', 'error');
            return;
          }
          // Calculate remaining balance (total - used - transferred)
          const usageStats = getReceiptUsageStats(receipt);
          let remaining = usageStats.remainingUSD || 0;

          // If editing, add back what this ad already allocated from this receipt
          if (isEdit && state.modalData?.id) {
            const existingAd = state.ads.find(a => a.id === state.modalData.id);
            if (existingAd?.receiptAllocations) {
              const existingAlloc = existingAd.receiptAllocations
                .filter(a => String(a.receiptId) === String(receiptId))
                .reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
              remaining += existingAlloc;
            }
          }

          if (plannedTotal > remaining + 0.0001) {
            showNotification(
              'Validation',
              `Planned spend ($${plannedTotal.toFixed(2)}) exceeds available balance ($${remaining.toFixed(2)}) for receipt ${receipt.serialNumber || receipt.id}.`,
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
          showNotification('Validation', 'Please choose how payment will be collected.', 'error');
          return;
        }
        if (collectionMethod === 'driver') {
          const linkedReceiptId = document.getElementById('ad-linked-receipt-id')?.value || '';
          if (!linkedReceiptId) {
            showNotification('Validation', 'Select a pending Temporary Delivery Receipt (D#) or create one first.', 'error');
            return;
          }
          const linkedReceipt = state.receipts.find(r => r && !r._deleted && String(r.id) === String(linkedReceiptId));
          if (!linkedReceipt || !isTempDeliveryReceiptNo(linkedReceipt.tempReceiptNo)) {
            showNotification('Validation', 'Selected receipt is not a valid pending Temporary Delivery Receipt.', 'error');
            return;
          }
          if (String(linkedReceipt.customerId || '') !== String(customerId || '')) {
            showNotification('Validation', 'Selected receipt belongs to a different customer.', 'error');
            return;
          }
          const ds = String(linkedReceipt.deliveryStatus || '');
          if (ds === 'Delivered' || ds === 'Office' || ds === 'Canceled') {
            showNotification('Validation', 'Selected receipt is not pending delivery anymore. Please choose another one.', 'error');
            return;
          }
          const assignedDriver = String(linkedReceipt.deliveryPersonId || '').trim();
          // Delivery assignment must come from the receipt (single source of truth).
          if (!assignedDriver) {
            showNotification('Validation', 'This receipt has no assigned driver. Please assign a driver in the Receipt first.', 'error');
            return;
          }

          // Receipt is the source of truth for money details in this flow.
          // Do NOT use Ad financial splits; derive totals from the linked receipt.
          const debtUsd = Number(linkedReceipt.debtAmountUSD ?? linkedReceipt.amountUSD ?? 0) || 0;
          amountUSD = Number.isFinite(debtUsd) ? debtUsd : 0;
          const rRate = Number(linkedReceipt.exchangeRate || 0) || 0;
          if (rRate > 0) exchangeRate = rRate;
          collectionPayments = [];
        }
      }
      
      // Capture due amount to use from delivery receipt (Not Paid + Driver mode)
      let dueAmountToUseUSD = 0;
      let linkedDeliveryReceiptId = '';
      let dueAllocations = [];
      if (paymentStatus === 'not_paid' && collectionMethod === 'driver') {
        linkedDeliveryReceiptId = document.getElementById('ad-linked-receipt-id')?.value || '';
        const dueInput = document.getElementById('ad-due-amount-to-use');
        if (dueInput && linkedDeliveryReceiptId) {
          dueAmountToUseUSD = parseFloat(dueInput.value) || 0;
          
          // Validate: check if the amount exceeds available credit
          const dueUsage = getDeliveryReceiptDueUsage(linkedDeliveryReceiptId);
          const availableUSD = dueUsage.remainingDueUSD;
          
          // If editing an existing ad, add back what this ad already used
          let currentAdUsage = 0;
          if (isEdit && state.modalData?.id) {
            const existingAd = state.ads.find(a => a.id === state.modalData.id);
            if (existingAd) {
              if (Array.isArray(existingAd.dueAllocations)) {
                currentAdUsage = existingAd.dueAllocations
                  .filter(a => String(a.receiptId) === String(linkedDeliveryReceiptId))
                  .reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
              } else if (existingAd.dueAmountToUseUSD > 0 && String(existingAd.linkedDeliveryReceiptId) === String(linkedDeliveryReceiptId)) {
                currentAdUsage = existingAd.dueAmountToUseUSD;
              }
            }
          }
          
          const effectiveAvailable = availableUSD + currentAdUsage;
          
          if (dueAmountToUseUSD > effectiveAvailable + 0.01) {
            showNotification(
              'Validation',
              `Due credit spend ($${dueAmountToUseUSD.toFixed(2)}) exceeds available ($${effectiveAvailable.toFixed(2)}).`,
              'error'
            );
            return;
          }
          
          // Create due allocation
          if (dueAmountToUseUSD > 0) {
            dueAllocations.push({
              receiptId: linkedDeliveryReceiptId,
              amountUSD: dueAmountToUseUSD
            });
          }
        }
      }
      
      // Capture merged paid receipt allocations (if enabled in Not Paid + Driver mode)
      let mergedAllocations = [];
      if (paymentStatus === 'not_paid' && collectionMethod === 'driver' && state.tempMergeFunding?.enabled) {
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
            showNotification('Validation', 'One of the merged receipts is missing or was deleted.', 'error');
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
              'Validation',
              `Merged spend ($${plannedTotal.toFixed(2)}) exceeds available balance ($${remaining.toFixed(2)}) for receipt ${receipt.serialNumber || receipt.id}.`,
              'error'
            );
            return;
          }
        }
      }
      
      // Combine allocations: merged paid receipts for Not Paid + Driver mode
      // For paid mode, use regular allocations
      const finalAllocations = isPaid ? allocations : mergedAllocations;
      
      // For Not Paid + Driver mode, update amountUSD to reflect total from due + merged allocations
      // This ensures the ad credit shows the correct amount, not the full receipt amount
      if (paymentStatus === 'not_paid' && collectionMethod === 'driver') {
        const mergedTotal = mergedAllocations.reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
        amountUSD = dueAmountToUseUSD + mergedTotal;
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
        receiptId: (paymentStatus === 'not_paid' && collectionMethod === 'driver') ? linkedDeliveryReceiptId : (state.modalData?.receiptId || ''),
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
        // Due amount fields for Not Paid + Driver mode (stored in USD like paid allocations)
        dueAmountToUseUSD: dueAmountToUseUSD,
        dueAllocations: dueAllocations,
        linkedDeliveryReceiptId: linkedDeliveryReceiptId,
        hasMergedPaidFunds: mergedAllocations.length > 0,
        mergedPaidAllocations: mergedAllocations
      };
      
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
          { key: 'startDate', label: 'Start Date', format: (v) => v ? new Date(v).toLocaleDateString() : 'N/A' },
          { key: 'endDate', label: 'End Date', format: (v) => v ? new Date(v).toLocaleDateString() : 'N/A' }
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
        
        updateRecord(state.ads, state.modalData.id, adUpdates);
        showNotification('Updated', 'Ad updated successfully', 'success');
        addLog('update', 'ad', state.modalData.id, `Updated ad with ${allocations.length} receipt link(s)`);
      } else {
        const ad = {
          id: generateId('ad'),
          recordType: 'ad',
          creatorId: state.currentUser?.id || '',
          createdAt: new Date().toISOString(),
          topUps: [],
          ...adUpdates
        };
        addRecord(state.ads, ad);
        showNotification('Success', 'Ad created successfully', 'success');
        addLog('create', 'ad', ad.id, `Created ad with ${allocations.length} receipt link(s)`);
        
        // Log receipt usage for each allocation
        if (isPaid && allocations.length > 0) {
          for (const alloc of allocations) {
            addAuditLog('receipt', alloc.receiptId, 'usage', `Ad ${ad.id} allocated $${alloc.amountUSD.toFixed(2)}`, {
              adId: ad.id,
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
        showNotification('Error', `Failed to save ad: ${error.message}`, 'error');
      }
      break;
    case 'user':
      const isAdminEditor = isCurrentUserAdmin();
      const editingId = state.modalData?.id;
      const isSelfEdit = !!(isEdit && editingId && String(state.currentUser?.id || '') === String(editingId));
      if (!isAdminEditor && !isSelfEdit) {
        showNotification('Access Denied', state.language === 'ar' ? 'إدارة المستخدمين للأدمن فقط' : 'Admin only', 'error');
        return;
      }

      const roleEl = document.getElementById('user-role');
      let userRole = Security.sanitizeInput((roleEl ? roleEl.value : (state.modalData?.role || '')), { maxLength: 20 });
      if (!isAdminEditor && isEdit) userRole = state.modalData?.role || userRole;
      const userName = Security.sanitizeInput(document.getElementById('user-name').value, { maxLength: 100 });
      const userEmail = Security.sanitizeInput(document.getElementById('user-email').value, { maxLength: 120 }).toLowerCase();

      if (!Security.isValidEmail(userEmail)) {
        showNotification('Validation Error', 'Please enter a valid email address', 'error');
        return;
      }
      
      // Get default permissions based on role
      const getDefaultPermissions = (role) => {
        switch (role) {
          case 'Admin':
            return {}; // Admins get all permissions automatically
          case 'Delivery':
            return PERMISSION_TEMPLATES.deliveryDriver.permissions;
          case 'Employee':
            return PERMISSION_TEMPLATES.salesAgent.permissions;
          default:
            return PERMISSION_TEMPLATES.viewer.permissions;
        }
      };
      
      // SERVER MODE: users are managed by backend (Admin only)
      if (isServerModeEnabled()) {
        if (!isAdminEditor) {
          showNotification('Access Denied', state.language === 'ar' ? 'هذه العملية للأدمن فقط' : 'Admin only', 'error');
          return;
        }
      if (isEdit) {
          const payload = {
            name: userName,
            email: userEmail,
          role: userRole
        };
        const newPassword = document.getElementById('user-password').value;
          if (newPassword) {
            if (String(newPassword).length < 8) {
              showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
              return;
            }
            payload.password = newPassword;
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
          showNotification('Updated', 'User updated successfully', 'success');
        } else {
          const rawPassword = document.getElementById('user-password').value;
          if (!rawPassword || String(rawPassword).length < 8) {
            showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
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
            showNotification('Success', 'User added successfully', 'success');

            if (!isAdminRole(userRole)) {
              setTimeout(() => showPermissionsModal(created.id), 500);
            }
          } else {
            showNotification('Error', 'Failed to create user', 'error');
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
            showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
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
        
        updateRecord(state.users, state.modalData.id, updates);
        showNotification('Updated', 'User updated successfully', 'success');
      } else {
        if (!isAdminEditor) {
          showNotification('Access Denied', state.language === 'ar' ? 'إنشاء المستخدمين للأدمن فقط' : 'Admin only', 'error');
          return;
        }
        const rawPassword = document.getElementById('user-password').value;
        if (!rawPassword || String(rawPassword).length < 8) {
          showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
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
        addRecord(state.users, user);
        showNotification('Success', 'User added successfully', 'success');
        
        // Show permission modal for non-admin users
        if (!isAdminRole(userRole)) {
          setTimeout(() => {
            showPermissionsModal(user.id);
          }, 500);
        }
      }
      break;
    case 'page':
      // Get selected customer IDs
      const selectedCustomers = Array.from(document.querySelectorAll('.page-customer-item'))
        .map(item => item.getAttribute('data-customer-id'));
      
      // Validate at least one customer
      if (selectedCustomers.length === 0) {
        showNotification('Validation Error', 'Please select at least one customer to link this page', 'error');
        return;
      }
      
      if (isEdit) {
        updateRecord(state.pages, state.modalData.id, {
          name: document.getElementById('page-name').value,
          category: document.getElementById('page-category').value,
          customerIds: selectedCustomers
        });
        showNotification('Updated', 'Page updated successfully', 'success');
        addLog('update', 'page', state.modalData.id, `Updated page: ${document.getElementById('page-name').value}`);
      } else {
        const page = {
          id: generateId('page'),
          name: document.getElementById('page-name').value,
          category: document.getElementById('page-category').value,
          customerIds: selectedCustomers,
          createdAt: new Date().toISOString(),
          _lastModified: Date.now(),
          _deleted: false
        };
        addRecord(state.pages, page);
        showNotification('Success', 'Page added successfully', 'success');
        addLog('create', 'page', page.id, `Created page: ${page.name} linked to ${selectedCustomers.length} customer(s)`);
      }
      break;
    case 'receipt':
      const receiptAmountEl = document.getElementById('receipt-amount');
      const receiptRateEl = document.getElementById('receipt-rate');
      const receiptFeeEl = document.getElementById('receipt-fee');
      const receiptDiscountEl = document.getElementById('receipt-discount');
      if (!receiptAmountEl || !receiptRateEl) {
        showNotification('Error', 'Receipt form elements not found', 'error');
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
        showNotification('Error', 'Please select a customer', 'error');
        return;
      }
      
      // Validate serial number: if editing and old receipt had a serial, new serial cannot be empty
      const newSerialNumber = (document.getElementById('receipt-serial').value || '').trim();
      const oldSerialNumber = isEdit ? (state.modalData?.serialNumber || '').trim() : '';
      
      if (isEdit && oldSerialNumber && !newSerialNumber) {
        showNotification('Validation Error', state.language === 'ar' ? 'لا يمكن حذف رقم الوصل الموجود' : 'Cannot remove existing receipt serial number. Please enter a serial number.', 'error');
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
        updateRecord(state.receipts, state.modalData.id, receiptUpdates);
        showNotification('Updated', 'Receipt updated successfully!', 'success');
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
        addRecord(state.receipts, receipt);
        showNotification('Success', 'Receipt created successfully!', 'success');
      }
      break;
  }
  closeModal();
  render();
}

function closeModal() {
  state.activeModal = null;
  state.modalData = null;

  // Clear temp funding states
  state.tempAdFunding = null;
  state.tempMergeFunding = null;
  // Discard any pending (unsaved) photos so a cancelled upload cannot leak
  // into the next ad/receipt created in this session.
  state.tempAdPhotos = [];
  // Discard any pending (unsaved) top-up edits so they cannot leak into the
  // next ad's top-up session.
  tempTopUps = [];
  
  // Clear URL params (modal, id)
  clearUrlParams(['modal', 'id']);
  
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
  }, 50);
}

function deleteCustomer(id) {
  // Permission check
  if (!currentUserHasPermission('customers', 'delete')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف العملاء' : 'You do not have permission to delete customers', 'error');
    return;
  }
  const customer = state.customers.find(c => c.id === id);
  const customerName = customer?.name || 'Unknown';
  // Check for linked receipts/ads
  const linkedReceipts = state.receipts.filter(r => r.customerId === id && !r._deleted);
  const linkedAds = state.ads.filter(a => a.customerId === id && !a._deleted);
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
    // Cascade delete: also delete linked receipts and ads
    linkedReceipts.forEach(receipt => {
      receipt._deleted = true;
      receipt._lastModified = getMonotonicTime();
      markCollectionDirty('receipts');
      if (isServerModeEnabled()) {
        apiDeleteEntity('receipts', receipt.id).catch(() => {});
      }
    });
    linkedAds.forEach(ad => {
      ad._deleted = true;
      ad._lastModified = getMonotonicTime();
      markCollectionDirty('ads');
      if (isServerModeEnabled()) {
        apiDeleteEntity('ads', ad.id).catch(() => {});
      }
    });
    deleteRecord(state.customers, id);
    const deletedCount = linkedReceipts.length + linkedAds.length;
    showNotification('Deleted', `Customer deleted${deletedCount > 0 ? ` along with ${deletedCount} linked record(s)` : ''}`, 'success');
    render();
  }
}

function deletePage(id) {
  // Permission check
  if (!currentUserHasPermission('pages', 'delete')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الصفحات' : 'You do not have permission to delete pages', 'error');
    return;
  }
  if (confirm('Delete this page?')) {
    deleteRecord(state.pages, id);
    showNotification('Deleted', 'Page deleted', 'success');
    render();
  }
}

function deleteReceipt(id) {
  // Permission check
  const receipt = state.receipts.find(r => r.id === id);
  if (!canActOnRecord('receipts', 'delete', receipt?.createdBy)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الوصولات' : 'You do not have permission to delete this receipt', 'error');
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
  let warning = `Are you sure you want to delete receipt #${serialNo} ($${amountUSD})?`;
  if (linkedAds.length > 0) {
    warning += `\n\n⚠️ WARNING: ${linkedAds.length} ad(s) are funded by this receipt. Their allocation references will be cleaned up.`;
  }
  if (confirm(warning)) {
    // Clean up allocation references in linked ads
    linkedAds.forEach(ad => {
      let changed = false;
      // Remove from receiptAllocations
      if (Array.isArray(ad.receiptAllocations)) {
        const before = ad.receiptAllocations.length;
        ad.receiptAllocations = ad.receiptAllocations.filter(alloc => alloc.receiptId !== id);
        if (ad.receiptAllocations.length !== before) changed = true;
      }
      // Remove from dueAllocations
      if (Array.isArray(ad.dueAllocations)) {
        const before = ad.dueAllocations.length;
        ad.dueAllocations = ad.dueAllocations.filter(alloc => alloc.receiptId !== id);
        if (ad.dueAllocations.length !== before) changed = true;
      }
      // Remove from mergedPaidAllocations (the merged-funding mirror). Leaving
      // it stale would let the next ad edit reseed the merge editor from it and
      // re-write an allocation that draws money from the deleted receipt.
      if (Array.isArray(ad.mergedPaidAllocations)) {
        const before = ad.mergedPaidAllocations.length;
        ad.mergedPaidAllocations = ad.mergedPaidAllocations.filter(alloc => alloc.receiptId !== id);
        if (ad.mergedPaidAllocations.length !== before) {
          changed = true;
          ad.hasMergedPaidFunds = ad.mergedPaidAllocations.length > 0;
        }
      }
      // Clear linked receipt references
      if (ad.receiptId === id) { ad.receiptId = ''; changed = true; }
      if (ad.linkedDeliveryReceiptId === id) { ad.linkedDeliveryReceiptId = ''; changed = true; }
      if (ad.fundingReceiptId === id) { ad.fundingReceiptId = ''; changed = true; }
      // Remove from receiptIds array
      if (Array.isArray(ad.receiptIds)) {
        const before = ad.receiptIds.length;
        ad.receiptIds = ad.receiptIds.filter(rid => rid !== id);
        if (ad.receiptIds.length !== before) changed = true;
      }
      if (changed) {
        ad._lastModified = getMonotonicTime();
        markCollectionDirty('ads');
        if (isServerModeEnabled()) {
          apiUpdateEntity('ads', ad.id, ad).catch(() => {});
        }
      }
    });
    deleteRecord(state.receipts, id);
    showNotification('Deleted', `Receipt deleted${linkedAds.length > 0 ? ` (${linkedAds.length} ad allocation(s) cleaned up)` : ''}`, 'success');
    render();
  }
}

function deleteAd(id) {
  // Permission check
  const ad = state.ads.find(a => a.id === id);
  if (!canActOnRecord('ads', 'delete', ad?.creatorId)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لحذف الإعلانات' : 'You do not have permission to delete this ad', 'error');
    return;
  }
  const customer = state.customers.find(c => c.id === ad?.customerId);
  const customerName = customer?.name || 'Unknown';
  const amountUSD = ad?.amountUSD?.toFixed(2) || '0.00';
  const warning = `Are you sure you want to delete this ad?\n\nCustomer: ${customerName}\nAmount: $${amountUSD}\n\n⚠️ This action cannot be undone!`;
  if (confirm(warning)) {
    deleteRecord(state.ads, id);
    showNotification('Deleted', 'Ad deleted', 'success');
    render();
  }
}

// Stop Ad - Enter spent amount and return remaining to receipts/customer
