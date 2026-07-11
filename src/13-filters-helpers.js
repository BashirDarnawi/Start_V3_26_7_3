// ==========================================
// SEARCH & FILTER FUNCTIONS
// ==========================================

function getFilteredAds(customersById = null) {
  let filtered = getVisibleRecords(state.ads).filter(ad => ad.recordType !== 'receipt');

  // Dropdown filters (status / payment / page) — state.adFilters is kept in
  // sync by updateAdFilter(); 'all' or unset means no filtering.
  const f = state.adFilters || {};
  if (f.status && f.status !== 'all') {
    filtered = filtered.filter(ad => String(ad.status || '') === f.status);
  }
  if (f.payment && f.payment !== 'all') {
    filtered = filtered.filter(ad => {
      const ps = String(ad.paymentStatus || '').toLowerCase();
      const isPaid = ad.isPaid === true || ps === 'paid';
      if (f.payment === 'paid') return isPaid;
      if (f.payment === 'wont_pay') return ps === 'wont_pay';
      return !isPaid && ps !== 'wont_pay'; // not_paid
    });
  }
  if (f.page && f.page !== 'all') {
    filtered = filtered.filter(ad => String(ad.pageId || '') === String(f.page));
  }

  // Read the search term from state (kept in sync by the debounced input handler).
  // Fall back to the DOM only if state hasn't been set yet.
  const searchTerm = String(
    state.adSearch != null ? state.adSearch : (document.getElementById('ad-search')?.value || '')
  ).toLowerCase().trim();

  if (searchTerm) {
    // PERFORMANCE: one Map lookup per ad instead of scanning the whole customers
    // array for every ad on every keystroke.
    const custMap = customersById || new Map(state.customers.map(c => [c.id, c]));
    const pageMap = new Map((state.pages || []).map(p => [p.id, p]));
    filtered = filtered.filter(ad => {
      const customer = custMap.get(ad.customerId);
      const page = ad.pageId ? pageMap.get(ad.pageId) : null;
      return (
        customer?.name?.toLowerCase().includes(searchTerm) ||
        ad.id.toLowerCase().includes(searchTerm) ||
        ad.phoneNumber?.toLowerCase().includes(searchTerm) ||
        ad.serialNumber?.toLowerCase().includes(searchTerm) ||
        page?.name?.toLowerCase().includes(searchTerm)
      );
    });
  }

  return filtered;
}

// ==========================================
// CUSTOMER VALIDATION FUNCTIONS
// ==========================================

// Check if any phone number is already used by another customer
function checkDuplicatePhone(phones, excludeCustomerId = null) {
  const allCustomers = getVisibleRecords(state.customers);
  
  for (const phone of phones) {
    if (!phone) continue;
    
    // Normalize phone number (remove spaces, dashes, etc.)
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
    
    for (const customer of allCustomers) {
      // Skip the current customer being edited
      if (excludeCustomerId && customer.id === excludeCustomerId) continue;
      
      // Check if this customer has the phone number
      if (customer.phones && Array.isArray(customer.phones)) {
        const hasPhone = customer.phones.some(p => {
          const normalizedCustomerPhone = (p || '').replace(/[\s\-\(\)]/g, '');
          return normalizedCustomerPhone === normalizedPhone;
        });
        
        if (hasPhone) {
          return {
            phone: phone,
            customerId: customer.id,
            customerName: customer.name || 'Unknown'
          };
        }
      }
    }
  }
  
  return null; // No duplicate found
}

// ==========================================
// CUSTOMER STATS CALCULATION FUNCTIONS
// ==========================================

// PERFORMANCE: one-pass grouping of ads/receipts/pages by customer id.
// Build this ONCE before a loop over many customers and pass it to
// getCustomerStats — turns O(customers × records) view rendering into
// O(customers + records). Results are identical to the per-call filters.
function buildCustomerStatsIndex() {
  const adsByCustomer = new Map();
  for (const ad of getVisibleRecords(state.ads)) {
    if (ad.recordType !== 'ad') continue;
    const list = adsByCustomer.get(ad.customerId);
    if (list) list.push(ad); else adsByCustomer.set(ad.customerId, [ad]);
  }
  const receiptsByCustomer = new Map();
  for (const r of getVisibleRecords(state.receipts)) {
    const list = receiptsByCustomer.get(r.customerId);
    if (list) list.push(r); else receiptsByCustomer.set(r.customerId, [r]);
  }
  const pagesByCustomer = new Map();
  for (const p of getVisibleRecords(state.pages)) {
    if (!Array.isArray(p.customerIds)) continue;
    for (const cid of p.customerIds) {
      const list = pagesByCustomer.get(cid);
      if (list) list.push(p); else pagesByCustomer.set(cid, [p]);
    }
  }
  return { adsByCustomer, receiptsByCustomer, pagesByCustomer };
}

function getCustomerStats(customerId, statsIndex = null) {
  const customerAds = statsIndex
    ? (statsIndex.adsByCustomer.get(customerId) || [])
    : getVisibleRecords(state.ads).filter(ad => ad.customerId === customerId && ad.recordType === 'ad');
  const customerReceipts = statsIndex
    ? (statsIndex.receiptsByCustomer.get(customerId) || [])
    : getVisibleRecords(state.receipts).filter(r => r.customerId === customerId);
  const linkedPages = statsIndex
    ? (statsIndex.pagesByCustomer.get(customerId) || [])
    : getVisibleRecords(state.pages).filter(p => p.customerIds?.includes(customerId));
  
  // Calculate total paid from receipts (in LYD and USD)
  // IMPORTANT: Unpaid receipts (status "Not Paid") should NOT be counted as revenue.
  const paidReceipts = customerReceipts.filter(r => {
    const st = String(r.status || '');
    if (st === 'Canceled' || st === 'Lost') return false;
    return st === 'Paid' || r.isPaid === true;
  });
  const totalPaidLYD = paidReceipts.reduce((sum, receipt) => sum + (receipt.amountLocal || 0), 0);
  const totalPaidUSD = paidReceipts.reduce((sum, receipt) => sum + (receipt.amountUSD || 0), 0);
  
  // Calculate total spent USD from ads
  // For stopped ads, use spentUSD; for others, use amountUSD (the planned/active amount)
  const totalSpentUSD = customerAds.reduce((sum, ad) => {
    if (ad.status === 'Stopped' && ad.spentUSD !== undefined) {
      return sum + ad.spentUSD;
    }
    // For active/completed ads, count the full amount as spent
    if (['Completed', 'Canceled', 'Lost'].includes(ad.status)) {
      return sum + (ad.spentUSD !== undefined ? ad.spentUSD : (ad.amountUSD || 0));
    }
    // For pending/paused ads, don't count as spent yet
    if (['Pending', 'Paused'].includes(ad.status)) {
      return sum;
    }
    return sum + (ad.amountUSD || 0);
  }, 0);
  
  // Calculate spent LYD proportionally based on USD spent
  // This ensures spentLYD cannot exceed paidLYD
  let totalSpentLYD = 0;
  if (totalPaidUSD > 0) {
    // Proportional calculation: (spentUSD / paidUSD) * paidLYD
    totalSpentLYD = (totalSpentUSD / totalPaidUSD) * totalPaidLYD;
  }
  
  // Calculate balance (paid - spent)
  const balanceLYD = totalPaidLYD - totalSpentLYD;
  const balanceUSD = totalPaidUSD - totalSpentUSD;
  
  // Legacy balance (for backwards compatibility)
  const totalSpent = totalSpentLYD;
  const totalPaid = totalPaidLYD;
  const balance = balanceLYD;
  
  // Get last ad date
  const allCustomerAds = [...customerAds, ...customerReceipts];
  const lastAdDate = allCustomerAds.length > 0 
    ? Math.max(...allCustomerAds.map(ad => new Date(ad.date || ad.createdAt).getTime()))
    : null;
  
  return {
    totalSpent,
    totalPaid,
    balance,
    // LYD values (TOTAL PAID)
    totalSpentLYD,
    totalPaidLYD,
    balanceLYD,
    // USD values (TOTAL ADS CREDIT)
    totalSpentUSD,
    totalPaidUSD,
    balanceUSD,
    // Other stats
    lastAdDate,
    totalAds: customerAds.length,
    totalReceipts: customerReceipts.length,
    linkedPagesCount: linkedPages.length
  };
}

function getCustomerSortValue(customer, sortType, statsIndex = null) {
  // Date sorts never touch stats — skip the expensive computation entirely.
  if (sortType === 'newest') return new Date(customer.joinDate).getTime();
  if (sortType === 'oldest') return -new Date(customer.joinDate).getTime();

  const stats = getCustomerStats(customer.id, statsIndex);

  switch (sortType) {
    case 'newest':
      return new Date(customer.joinDate).getTime();
    case 'oldest':
      return -new Date(customer.joinDate).getTime();
    case 'lastActive':
      return stats.lastAdDate || 0;
    case 'highestPaid':
      return stats.totalPaid;
    case 'lowestPaid':
      return -stats.totalPaid;
    case 'mostSpend':
      return stats.totalSpent;
    case 'leastSpend':
      return -stats.totalSpent;
    // Non-qualifying customers sink to the bottom. Use a finite sentinel, not
    // -Infinity: two -Infinity values subtract to NaN in the comparator, which
    // makes the sort order undefined (and can throw in some engines).
    case 'biggestCredit':
      return stats.balance > 0 ? stats.balance : -Number.MAX_VALUE;
    case 'highestDebt':
      return stats.balance < 0 ? -stats.balance : -Number.MAX_VALUE;
    default:
      return 0;
  }
}

function getFilteredCustomers() {
  let filtered = getVisibleRecords(state.customers);
  const searchTerm = String(state.customerSearch || '').toLowerCase().trim();
  
  if (searchTerm) {
    filtered = filtered.filter(c => 
      String(c.name || '').toLowerCase().includes(searchTerm) ||
      (Array.isArray(c.phones) ? c.phones : []).some(p => String(p || '').includes(searchTerm)) ||
      String(c.platform || '').toLowerCase().includes(searchTerm)
    );
  }
  
  // PERFORMANCE: build the by-customer stats index ONCE and reuse it for both
  // the financial filter and the sort. Previously the sort comparator called
  // getCustomerStats(customer.id) with no index for BOTH operands of EVERY
  // comparison, and the no-index path rescans all ads+receipts+pages each time —
  // ~O(customers log customers × records), freezing the UI for seconds at a few
  // thousand records on every search keystroke / sort change / live-sync tick.
  const needsStats = (
    state.customerFinancialFilter === 'hasCredit' ||
    state.customerFinancialFilter === 'hasDebt' ||
    !(state.customerSort === 'newest' || state.customerSort === 'oldest')
  );
  const statsIndex = needsStats ? buildCustomerStatsIndex() : null;

  // Apply financial filter
  if (state.customerFinancialFilter === 'hasCredit') {
    filtered = filtered.filter(c => getCustomerStats(c.id, statsIndex).balance > 0);
  } else if (state.customerFinancialFilter === 'hasDebt') {
    filtered = filtered.filter(c => getCustomerStats(c.id, statsIndex).balance < 0);
  }

  // Apply sorting (decorate-sort-undecorate: compute each sort value once,
  // reusing the shared statsIndex, instead of recomputing inside the comparator).
  filtered = filtered
    .map(c => ({ c, v: getCustomerSortValue(c, state.customerSort, statsIndex) }))
    .sort((a, b) => b.v - a.v) // Descending order
    .map(x => x.c);

  return filtered;
}

// ==========================================
// HELPER FUNCTIONS FOR VIEWS
// ==========================================

function editAd(id) {
  // Permission check for editing ads
  const ad = state.ads.find(a => a.id === id);
  if (!canActOnRecord('ads', 'edit', ad?.creatorId)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الإعلانات' : 'You do not have permission to edit this ad', 'error');
    return;
  }
  state.activeModal = 'ad';
  state.modalData = ad;
  updateUrlParams({ modal: 'ad', id }); // URL tracking
  renderModal();
}

function editReceipt(id) {
  // Permission check for editing receipts
  const receipt = state.receipts.find(r => r.id === id);
  if (!canActOnRecord('receipts', 'edit', receipt?.createdBy)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الوصولات' : 'You do not have permission to edit this receipt', 'error');
    return;
  }
  state.activeModal = 'receipt';
  state.modalData = receipt;
  updateUrlParams({ modal: 'receipt', id }); // URL tracking
  renderModal();
}

function editCustomer(id) {
  // Permission check for editing customers
  const customer = state.customers.find(c => c.id === id);
  if (!canActOnRecord('customers', 'edit', customer?.createdBy)) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل العملاء' : 'You do not have permission to edit this customer', 'error');
    return;
  }
  state.activeModal = 'customer';
  state.modalData = customer;
  updateUrlParams({ modal: 'customer', id }); // URL tracking
  renderModal();
}

function editPage(id) {
  // Permission check for editing pages
  if (!currentUserHasPermission('pages', 'edit')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل الصفحات' : 'You do not have permission to edit pages', 'error');
    return;
  }
  state.activeModal = 'page';
  state.modalData = state.pages.find(p => p.id === id);
  updateUrlParams({ modal: 'page', id }); // URL tracking
  renderModal();
}

function editUser(id) {
  if (!isCurrentUserAdmin() && String(id) !== String(state.currentUser?.id || '')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يمكنك تعديل مستخدمين آخرين' : 'You cannot edit other users', 'error');
    return;
  }
  state.activeModal = 'user';
  state.modalData = state.users.find(u => u.id === id);
  updateUrlParams({ modal: 'user', id }); // URL tracking
  renderModal();
}

// ==========================================
// ADVANCED PERMISSIONS MANAGEMENT
// ==========================================

function showPermissionsModal(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Permissions Manager is Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) {
    showNotification('Error', 'User not found', 'error');
    return;
  }
  
  // Admins shouldn't have their permissions edited (they have all by default)
  if (isAdminRole(user.role)) {
    showNotification('Info', 'Administrators have full access by default', 'info');
    return;
  }
  
  const userPermissions = user.permissions || {};
  const permSummary = getPermissionSummary(userPermissions);
  
  // Preserve scroll position so toggling permissions doesn't jump to the top
  let prevScrollTop = 0;
  const existingModal = document.getElementById('app-modal');
  if (existingModal) {
    const scroller = existingModal.querySelector('#permissions-scroll');
    if (scroller) prevScrollTop = scroller.scrollTop || 0;
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.id = 'app-modal';
  modal.dataset.modalType = 'permissions';
  modal.dataset.userId = String(userId);
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden animate-slide-up" onclick="event.stopPropagation()">
      <!-- Header -->
      <div class="bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 p-6 text-white">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-4">
            <div class="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg">
              <span class="text-2xl font-bold">${user.name.charAt(0)}</span>
            </div>
            <div>
              <h2 class="text-2xl font-bold">Permissions Manager</h2>
              <div class="flex items-center space-x-2 mt-1">
                <span class="text-white/80">${Security.escapeHtml(user.name || '')}</span>
                <span class="px-2 py-0.5 rounded-full bg-white/20 text-xs font-medium">${Security.escapeHtml(user.role || '')}</span>
              </div>
            </div>
          </div>
          <button onclick="this.closest('#app-modal').remove()" class="w-10 h-10 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
        
        <!-- Permission Stats Bar -->
        <div class="mt-4 flex items-center space-x-4">
          <div class="flex-1 bg-white/20 rounded-full h-3 overflow-hidden">
            <div id="perm-summary-bar" class="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 rounded-full transition-all duration-300" style="width: ${permSummary.percentage}%"></div>
          </div>
          <span id="perm-summary-count" class="font-bold text-lg">${permSummary.granted}/${permSummary.total}</span>
        </div>
      </div>
      
      <div id="permissions-scroll" class="p-6 overflow-y-auto max-h-[calc(90vh-200px)] custom-scrollbar">
        <!-- Quick Templates -->
        <div class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-slate-700 dark:text-slate-300 uppercase flex items-center space-x-2">
              <i data-lucide="zap" class="w-4 h-4 text-amber-500"></i>
              <span>Quick Templates</span>
            </h3>
            <button onclick="clearAllPermissions('${userId}')" class="text-xs text-rose-600 hover:text-rose-700 font-medium flex items-center space-x-1">
              <i data-lucide="trash-2" class="w-3 h-3"></i>
              <span>Clear All</span>
            </button>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            ${Object.entries(PERMISSION_TEMPLATES).map(([key, template]) => `
              <button onclick="applyPermissionTemplate('${userId}', '${key}')" class="p-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 hover:border-${template.color}-500 hover:bg-${template.color}-50 dark:hover:bg-${template.color}-900/20 transition-all text-center group">
                <i data-lucide="${template.icon}" class="w-5 h-5 mx-auto mb-1 text-${template.color}-600 group-hover:scale-110 transition-transform"></i>
                <div class="text-xs font-bold text-slate-700 dark:text-slate-300">${template.name}</div>
                <div class="text-[10px] text-slate-500 line-clamp-1">${template.description}</div>
              </button>
            `).join('')}
          </div>
        </div>
        
        <!-- Granular Permissions -->
        <div class="space-y-4">
          ${Object.entries(PERMISSION_MODULES).map(([moduleKey, moduleConfig]) => {
            const modulePerms = userPermissions[moduleKey] || [];
            const modulePermCount = Object.keys(moduleConfig.permissions).length;
            const moduleGranted = modulePerms.length;
            const allSelected = moduleGranted === modulePermCount;
            
            return `
              <div class="border-2 border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden hover:border-${moduleConfig.color}-300 dark:hover:border-${moduleConfig.color}-700 transition-colors">
                <!-- Module Header -->
                <div class="p-4 bg-${moduleConfig.color}-50 dark:bg-${moduleConfig.color}-900/20 flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <div class="w-10 h-10 rounded-xl bg-${moduleConfig.color}-100 dark:bg-${moduleConfig.color}-800 flex items-center justify-center">
                      <i data-lucide="${moduleConfig.icon}" class="w-5 h-5 text-${moduleConfig.color}-600 dark:text-${moduleConfig.color}-400"></i>
                    </div>
                    <div>
                      <h4 class="font-bold text-slate-800 dark:text-white">${moduleConfig.name}</h4>
                      <p class="text-xs text-slate-500">${moduleConfig.description}</p>
                    </div>
                  </div>
                  <div class="flex items-center space-x-3">
                    <span id="perm-module-count-${moduleKey}" class="text-xs font-bold ${moduleGranted > 0 ? 'text-emerald-600' : 'text-slate-400'}">${moduleGranted}/${modulePermCount}</span>
                    <button id="perm-module-toggle-${moduleKey}" data-color="${moduleConfig.color}" onclick="toggleModulePermissions('${userId}', '${moduleKey}', ${!allSelected})" class="px-3 py-1.5 rounded-lg text-xs font-bold ${allSelected ? 'bg-slate-200 dark:bg-slate-700 text-slate-600' : 'bg-' + moduleConfig.color + '-600 text-white'} hover:opacity-80 transition-all">
                      ${allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                </div>
                
                <!-- Permissions Grid -->
                <div class="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  ${Object.entries(moduleConfig.permissions).map(([permKey, permConfig]) => {
                    const isEnabled = modulePerms.includes(permKey);
                    return `
                      <label class="flex items-start space-x-3 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group">
                        <input type="checkbox" 
                          ${isEnabled ? 'checked' : ''} 
                          onchange="togglePermission('${userId}', '${moduleKey}', '${permKey}', this.checked)"
                          data-module="${moduleKey}"
                          data-perm="${permKey}"
                          class="mt-0.5 w-4 h-4 rounded border-slate-300 text-${moduleConfig.color}-600 focus:ring-${moduleConfig.color}-500 cursor-pointer"
                        />
                        <div class="flex-1">
                          <div class="text-sm font-medium text-slate-700 dark:text-slate-300 group-hover:text-${moduleConfig.color}-600">${permConfig.label}</div>
                          <div class="text-[10px] text-slate-500">${permConfig.description}</div>
                        </div>
                      </label>
                    `;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      
      <!-- Footer -->
      <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between">
        <div class="text-xs text-slate-500">
          <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
          Changes are saved automatically
        </div>
        <div class="flex items-center space-x-3">
          <button onclick="exportUserPermissions('${userId}')" class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 flex items-center space-x-2 transition-colors">
            <i data-lucide="download" class="w-3 h-3"></i>
            <span>${state.language === 'ar' ? 'تصدير' : 'Export'}</span>
          </button>
          <button onclick="importUserPermissions('${userId}')" class="px-4 py-2 rounded-xl text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 flex items-center space-x-2 transition-colors">
            <i data-lucide="upload" class="w-3 h-3"></i>
            <span>${state.language === 'ar' ? 'استيراد' : 'Import'}</span>
          </button>
          <button onclick="this.closest('#app-modal').remove()" class="px-6 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:opacity-90 transition-all">
            ${state.language === 'ar' ? 'تم' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  const scroller = document.getElementById('permissions-scroll');
  if (scroller) scroller.scrollTop = prevScrollTop;
}

function refreshPermissionsModalUi(userId, moduleKey = null) {
  const modal = document.getElementById('app-modal');
  if (!modal || modal.dataset?.modalType !== 'permissions') return;
  if (String(modal.dataset.userId || '') !== String(userId || '')) return;

  const user = state.users.find(u => u && !u._deleted && u.id === userId);
  if (!user) return;

  const perms = user.permissions || {};
  const summary = getPermissionSummary(perms);
  const bar = modal.querySelector('#perm-summary-bar');
  const count = modal.querySelector('#perm-summary-count');
  if (bar) bar.style.width = `${summary.percentage}%`;
  if (count) count.textContent = `${summary.granted}/${summary.total}`;

  const updateModule = (mk) => {
    const cfg = PERMISSION_MODULES[mk];
    if (!cfg) return;
    const modulePerms = perms[mk] || [];
    const modulePermCount = Object.keys(cfg.permissions).length;
    const moduleGranted = modulePerms.length;
    const allSelected = moduleGranted === modulePermCount;

    const countEl = modal.querySelector(`#perm-module-count-${mk}`);
    if (countEl) countEl.textContent = `${moduleGranted}/${modulePermCount}`;

    const btn = modal.querySelector(`#perm-module-toggle-${mk}`);
    if (btn) {
      btn.setAttribute('onclick', `toggleModulePermissions('${String(userId)}', '${String(mk)}', ${!allSelected})`);
      btn.textContent = allSelected ? 'Deselect All' : 'Select All';
      const base = 'px-3 py-1.5 rounded-lg text-xs font-bold hover:opacity-80 transition-all';
      const color = String(btn.dataset.color || cfg.color || 'indigo');
      btn.className = `${base} ${allSelected ? 'bg-slate-200 dark:bg-slate-700 text-slate-600' : `bg-${color}-600 text-white`}`;
    }
  };

  if (moduleKey) {
    updateModule(moduleKey);
  } else {
    for (const mk of Object.keys(PERMISSION_MODULES)) updateModule(mk);
  }
}

function togglePermission(userId, moduleKey, permKey, enabled) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (!user.permissions) user.permissions = {};
  if (!user.permissions[moduleKey]) user.permissions[moduleKey] = [];
  
  if (enabled) {
    if (!user.permissions[moduleKey].includes(permKey)) {
      user.permissions[moduleKey].push(permKey);
    }
  } else {
    user.permissions[moduleKey] = user.permissions[moduleKey].filter(p => p !== permKey);
  }
  
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  // Add audit log
  addAuditLog('update', userId, `${enabled ? 'Granted' : 'Revoked'} permission: ${moduleKey}.${permKey} for ${user.name}`, {
    resourceType: 'user',
    permission: `${moduleKey}.${permKey}`,
    action: enabled ? 'grant' : 'revoke'
  });
  
  // Update UI in-place (no blinking)
  refreshPermissionsModalUi(userId, moduleKey);
}

function toggleModulePermissions(userId, moduleKey, enableAll) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const moduleConfig = PERMISSION_MODULES[moduleKey];
  if (!moduleConfig) return;
  
  if (!user.permissions) user.permissions = {};
  
  if (enableAll) {
    user.permissions[moduleKey] = Object.keys(moduleConfig.permissions);
  } else {
    user.permissions[moduleKey] = [];
  }
  
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `${enableAll ? 'Granted all' : 'Revoked all'} ${moduleKey} permissions for ${user.name}`, {
    resourceType: 'user',
    module: moduleKey,
    action: enableAll ? 'grant_all' : 'revoke_all'
  });
  
  // Update checkbox states in-place + refresh header counts
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll(`input[type="checkbox"][data-module="${moduleKey}"]`).forEach((el) => {
      el.checked = !!enableAll;
    });
  }
  refreshPermissionsModalUi(userId, moduleKey);
}

function applyPermissionTemplate(userId, templateKey) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const template = PERMISSION_TEMPLATES[templateKey];
  if (!template) return;
  
  user.permissions = JSON.parse(JSON.stringify(template.permissions));
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `Applied permission template "${template.name}" to ${user.name}`, {
    resourceType: 'user',
    template: templateKey
  });
  
  showNotification('Template Applied', `${template.name} permissions applied to ${user.name}`, 'success');
  // Update UI in-place (no blinking)
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => {
      const mk = el.getAttribute('data-module');
      const pk = el.getAttribute('data-perm');
      const allowed = Array.isArray(user.permissions?.[mk]) ? user.permissions[mk].includes(pk) : false;
      el.checked = allowed;
    });
  }
  refreshPermissionsModalUi(userId);
}

function clearAllPermissions(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (!confirm(`Clear all permissions for ${user.name}? They will lose access to most features.`)) return;
  
  user.permissions = {};
  user._lastModified = getMonotonicTime();
  markCollectionDirty('users');
  saveState();
  flushDirtyCollections().catch(() => {});
  scheduleServerUserUpdate(userId, { permissions: user.permissions });
  
  addAuditLog('update', userId, `Cleared all permissions for ${user.name}`, {
    resourceType: 'user',
    action: 'clear_all'
  });
  
  showNotification('Cleared', `All permissions cleared for ${user.name}`, 'success');
  const modal = document.getElementById('app-modal');
  if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
    modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => { el.checked = false; });
  }
  refreshPermissionsModalUi(userId);
}

function exportUserPermissions(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  const exportData = {
    userId: user.id,
    userName: user.name,
    userRole: user.role,
    exportDate: new Date().toISOString(),
    permissions: user.permissions || {}
  };
  
  const json = JSON.stringify(exportData, null, 2);
  downloadFile(json, `permissions-${user.name.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  
  showNotification('Exported', `Permissions exported for ${user.name}`, 'success');
}

function importUserPermissions(userId) {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'إدارة الصلاحيات للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        const user = state.users.find(u => u.id === userId);
        if (!user) return;
        
        if (data.permissions) {
          user.permissions = data.permissions;
          user._lastModified = getMonotonicTime();
          markCollectionDirty('users');
          saveState();
          flushDirtyCollections().catch(() => {});
          scheduleServerUserUpdate(userId, { permissions: user.permissions });
          
          addAuditLog('update', userId, `Imported permissions for ${user.name}`, {
            resourceType: 'user',
            action: 'import'
          });
          
          showNotification('Imported', `Permissions imported for ${user.name}`, 'success');
          const modal = document.getElementById('app-modal');
          if (modal?.dataset?.modalType === 'permissions' && String(modal.dataset.userId || '') === String(userId || '')) {
            modal.querySelectorAll('input[type="checkbox"][data-module][data-perm]').forEach((el) => {
              const mk = el.getAttribute('data-module');
              const pk = el.getAttribute('data-perm');
              const allowed = Array.isArray(user.permissions?.[mk]) ? user.permissions[mk].includes(pk) : false;
              el.checked = allowed;
            });
          }
          refreshPermissionsModalUi(userId);
        }
      } catch (error) {
        showNotification('Error', 'Invalid permissions file', 'error');
      }
    };
    reader.readAsText(file);
  };
  
  input.click();
}

function assignDelivery(itemId, userId) {
  if (!userId) return;
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    updateRecord(state.receipts, itemId, { deliveryPersonId: userId });
  } else {
    updateRecord(state.ads, itemId, { deliveryPersonId: userId });
  }
  showNotification('Assigned', 'Delivery person assigned', 'success');
  render();
}

function updateDeliveryStatus(itemId, status) {
  const s = String(status || '').trim();
  if (!s) return;
  if (s === 'Canceled') {
    // Require a reason (handled by modal)
    openDeliveryCancelModal(itemId);
    return;
  }
  if (s === 'Office') {
    // Treat as "delete mission" (remove from delivery tracking)
    removeDeliveryMission(itemId);
    return;
  }
  if (s === 'Delivered' && String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification('Not Allowed', 'Only the assigned delivery driver can mark a delivery as Delivered.', 'warning');
    return;
  }
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    updateRecord(state.receipts, itemId, { deliveryStatus: s });
  } else {
    updateRecord(state.ads, itemId, { deliveryStatus: s });
  }
  showNotification('Updated', `Status changed to ${s}`, 'success');
  render();
}

function markAsCollected(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    // Temp delivery receipts require strict completion (final receipt # + photo + amounts).
    if (isTempDeliveryReceiptNo(isReceipt.tempReceiptNo)) {
      showNotification('Not Allowed', 'Use "Mark Delivered" to complete this delivery with receipt photo + final number.', 'warning');
      openReceiptDeliveryCompletionModal(itemId);
      return;
    }
    updateRecord(state.receipts, itemId, { 
      isPaid: true, 
      collectionDate: new Date().toISOString(),
      status: 'Paid',
      deliveryStatus: 'Delivered'
    });
  } else {
    updateRecord(state.ads, itemId, { 
      isPaid: true, 
      collectionDate: new Date().toISOString(),
      status: 'Completed'
    });
  }
  // Update delivery stats if delivery user
  if (isDeliveryRole(state.currentUser?.role) && state.currentUser.stats) {
    state.currentUser.stats.collected = (state.currentUser.stats.collected || 0) + 1;
    updateRecord(state.users, state.currentUser.id, { stats: state.currentUser.stats });
  }
  showNotification('Collected', 'Payment marked as collected', 'success');
  render();
}

function acceptDelivery(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  const updateData = {
    deliveryStatus: 'In Progress',
    acceptedDate: new Date().toISOString()
  };
  
  if (isReceipt) {
    updateRecord(state.receipts, itemId, updateData);
  } else {
    updateRecord(state.ads, itemId, updateData);
  }
  // Update delivery stats
  if (isDeliveryRole(state.currentUser?.role) && state.currentUser.stats) {
    state.currentUser.stats.accepted = (state.currentUser.stats.accepted || 0) + 1;
    state.currentUser.stats.totalAds = (state.currentUser.stats.totalAds || 0) + 1;
    updateRecord(state.users, state.currentUser.id, { stats: state.currentUser.stats });
  }
  showNotification('Accepted', 'Delivery accepted', 'success');
  render();
}

// ==========================================
// TEMP DELIVERY RECEIPT: DRIVER CONFIRMATION FLOW
// ==========================================

function normalizePhoneToE164(phone) {
  let s = String(phone || '').trim();
  if (!s) return '';
  // Keep digits and leading +
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}

function buildWhatsAppLink(phone) {
  const e164 = normalizePhoneToE164(phone);
  const digits = String(e164 || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}`;
}

function compareFees(quoted, actual) {
  const q = Number(quoted) || 0;
  const a = Number(actual) || 0;
  const diff = a - q;
  if (Math.abs(diff) < 0.000001) return { feeDifferenceStatus: 'SAME', feeDiff: 0 };
  if (diff < 0) return { feeDifferenceStatus: 'LOWER', feeDiff: diff };
  return { feeDifferenceStatus: 'HIGHER', feeDiff: diff };
}

function compareDebt(debtAmount, collectedAmount) {
  const d = Number(debtAmount) || 0;
  const c = Number(collectedAmount) || 0;
  const difference = c - d;
  if (Math.abs(difference) < 0.000001) return { paymentResult: 'PAID_EXACT', difference: 0, overpaidAmount: 0, remainingDue: 0 };
  if (difference > 0) return { paymentResult: 'OVERPAID', difference, overpaidAmount: difference, remainingDue: 0 };
  return { paymentResult: 'UNDERPAID', difference, overpaidAmount: 0, remainingDue: Math.abs(difference) };
}

function _findReceiptForDeliveryModal(receiptId) {
  const rid = String(receiptId || '');
  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === rid);
  return receipt || null;
}

function _receiptFinalNoExists(serial, excludeId) {
  const s = String(serial || '').trim();
  if (!s) return false;
  return !!state.receipts.find(r =>
    r && !r._deleted &&
    String(r.id) !== String(excludeId || '') &&
    (String(r.serialNumber || '').trim() === s || String(r.finalReceiptNo || '').trim() === s)
  );
}

// ==========================================
// IMAGE COMPRESSION (shared by all photo uploads)
// ==========================================
// A phone camera photo is often 3-6MB; stored as a base64 data URL inside a
// record it inflates every save, sync payload and export by that amount.
// Downscaling to max 1280px JPEG (~80% quality) keeps receipts perfectly
// readable while shrinking payloads 10-20x. PNG stays PNG (transparency),
// and on ANY failure we fall back to the original uncompressed data URL so
// a photo is never lost.
const IMAGE_MAX_DIMENSION = 1280;
const IMAGE_JPEG_QUALITY = 0.8;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target?.result || ''));
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

async function compressImageToDataUrl(file) {
  const originalDataUrl = await readFileAsDataUrl(file);
  try {
    const type = String(file.type || '').toLowerCase();
    if (!/^image\//.test(type)) return originalDataUrl;
    // Animated GIFs cannot survive a canvas re-encode (only the first frame
    // would remain) — always keep them untouched.
    if (type === 'image/gif') return originalDataUrl;
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image decode failed'));
      image.src = originalDataUrl;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return originalDataUrl;
    const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(w, h));
    // PNG and WebP may carry transparency — re-encode as PNG to keep it.
    const keepAlpha = /image\/(png|webp)/.test(type);
    // Small already and not worth re-encoding? Keep the original.
    if (scale === 1 && originalDataUrl.length < 300 * 1024) return originalDataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return originalDataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = keepAlpha
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
    // Only use the compressed version if it is actually smaller.
    return (out && out.length < originalDataUrl.length) ? out : originalDataUrl;
  } catch (_) {
    return originalDataUrl;
  }
}

function handleDeliveryReceiptPhotoUpload(fileList) {
  const file = fileList && fileList.length ? fileList[0] : null;
  if (!file) return;
  compressImageToDataUrl(file).then((dataUrl) => {
    if (!dataUrl) return;
    const hidden = document.getElementById('delivery-receipt-image-data');
    if (hidden) hidden.dataset.imageData = dataUrl;
    const img = document.getElementById('delivery-receipt-image-preview');
    if (img) img.src = dataUrl;
    updateReceiptDeliveryCompletionComputed();
  }).catch(() => {});
}

function updateReceiptDeliveryCompletionComputed() {
  const modal = document.getElementById('delivery-complete-modal');
  if (!modal) return;
  const rid = modal.dataset.receiptId || '';
  const receipt = _findReceiptForDeliveryModal(rid);
  if (!receipt) return;

  const debt = Number(receipt.debtAmountLocal ?? receipt.amountLocal ?? 0) || 0;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;

  const finalNo = String(document.getElementById('delivery-final-receipt-no')?.value || '').trim();
  const collected = parseFloat(String(document.getElementById('delivery-collected-amount')?.value || '').trim()) || 0;
  const actualFee = parseFloat(String(document.getElementById('delivery-actual-fee')?.value || '').trim()) || 0;
  const notes = String(document.getElementById('delivery-driver-notes')?.value || '').trim();

  const imgData = String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').trim();

  // Compute comparisons
  const feeCmp = compareFees(quoted, actualFee);
  const debtCmp = compareDebt(debt, collected);

  const feeEl = document.getElementById('delivery-fee-compare');
  const debtEl = document.getElementById('delivery-debt-compare');
  if (feeEl) {
    const diff = feeCmp.feeDiff;
    feeEl.textContent = feeCmp.feeDifferenceStatus === 'SAME'
      ? 'Fee: SAME'
      : (feeCmp.feeDifferenceStatus === 'LOWER'
        ? `Fee: LOWER (${Math.abs(diff).toFixed(0)} LYD)`
        : `Fee: HIGHER (${diff.toFixed(0)} LYD)`);
  }
  if (debtEl) {
    if (debtCmp.paymentResult === 'PAID_EXACT') debtEl.textContent = 'Payment: PAID EXACT';
    if (debtCmp.paymentResult === 'OVERPAID') debtEl.textContent = `Payment: OVERPAID (+${debtCmp.overpaidAmount.toFixed(0)} LYD)`;
    if (debtCmp.paymentResult === 'UNDERPAID') debtEl.textContent = `Payment: UNDERPAID (${debtCmp.remainingDue.toFixed(0)} LYD remaining)`;
  }

  // Validate (allow S-prefixed auto-serials for LTT/Libyana/Madar)
  const errEl = document.getElementById('delivery-final-receipt-error');
  const isAutoSerialValidation = isAutoSerialNumber(finalNo);
  let ok = true;
  if (!finalNo) {
    ok = false;
    if (errEl) errEl.textContent = 'Final receipt number is required.';
  } else if (!isAutoSerialValidation && (!/^\d+$/.test(finalNo) || finalNo.startsWith('0'))) {
    ok = false;
    if (errEl) errEl.textContent = 'Final receipt number must be digits (no leading 0) or S-prefixed (S1, S2).';
  } else if (_receiptFinalNoExists(finalNo, receipt.id)) {
    ok = false;
    if (errEl) errEl.textContent = 'Final receipt number already exists.';
  } else {
    if (errEl) errEl.textContent = '';
  }

  if (!Number.isFinite(collected) || collected < 0) ok = false;
  if (!Number.isFinite(actualFee) || actualFee < 0) ok = false;
  if (!imgData) ok = false;

  const btn = document.getElementById('delivery-complete-submit');
  if (btn) btn.disabled = !ok;

  // Keep notes (no-op, but avoids unused var warnings in some linters)
  void notes;
}

function openReceiptDeliveryCompletionModal(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification('Error', 'Receipt not found', 'error');
    return;
  }
  if (String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification('Access Denied', 'Delivery users only', 'error');
    return;
  }
  if (String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
    showNotification('Access Denied', 'This receipt is not assigned to you', 'error');
    return;
  }

  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(receipt.customerId));
  const phone = String(receipt.phoneNumber || customer?.phones?.[0] || '').trim();
  const debt = Number(receipt.debtAmountLocal ?? receipt.amountLocal ?? 0) || 0;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;
  const tempNo = String(receipt.tempReceiptNo || '').trim();
  const finalNo = String(receipt.finalReceiptNo || receipt.serialNumber || '').trim();
  const place = String(receipt.deliveryPlaceName || '').trim();

  // Remove any existing modal
  document.getElementById('delivery-complete-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'delivery-complete-modal';
  modal.dataset.receiptId = String(receipt.id);
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <i data-lucide="check-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">Mark Delivered</div>
            <div class="text-xs text-slate-500">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
          </div>
        </div>
        <button onclick="this.closest('#delivery-complete-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-500 mb-1">Receipt</div>
          <div class="font-bold text-indigo-600">${Security.escapeHtml(tempNo || 'D?')}${finalNo ? ` → ${Security.escapeHtml(finalNo)}` : ''}</div>
          ${place ? `<div class="text-xs text-slate-600 dark:text-slate-300 mt-1"><span class="font-bold">📍</span> ${Security.escapeHtml(place)}</div>` : ''}
          <div class="text-xs text-slate-500 mt-1">Debt due: <span class="font-bold text-slate-800 dark:text-slate-200">${debt.toFixed(0)} LYD</span> • Quoted fee: <span class="font-bold text-emerald-600">${quoted.toFixed(0)} LYD</span></div>
          ${phone ? `<div class="text-xs text-slate-500 mt-1">Phone: <span class="font-bold text-slate-700 dark:text-slate-300">${Security.escapeHtml(phone)}</span></div>` : ''}
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Final receipt number *</label>
          <input id="delivery-final-receipt-no" type="text" inputmode="numeric" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="e.g., 45873" value="${Security.escapeHtml(finalNo)}" oninput="this.value=this.value.replace(/[^0-9]/g,''); updateReceiptDeliveryCompletionComputed()" />
          <div id="delivery-final-receipt-error" class="mt-1 text-[11px] text-rose-600"></div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Amount collected (LYD) *</label>
            <input id="delivery-collected-amount" type="text" inputmode="decimal" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${Security.escapeHtml(String(receipt.amountCollectedFromCustomer ?? ''))}" oninput="sanitizeMoneyInput(this); updateReceiptDeliveryCompletionComputed()" />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Actual delivery fee collected (LYD) *</label>
            <input id="delivery-actual-fee" type="text" inputmode="decimal" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" value="${Security.escapeHtml(String(receipt.actualDeliveryFeeCollected ?? receipt.deliveryFeeCollected ?? ''))}" oninput="sanitizeMoneyInput(this); updateReceiptDeliveryCompletionComputed()" />
          </div>
        </div>

        <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between mb-2">
            <div class="text-xs font-bold text-slate-600 dark:text-slate-400">Receipt photo *</div>
            <label class="text-xs font-bold text-indigo-600 hover:text-indigo-700 cursor-pointer">
              Upload
              <input type="file" accept="image/*" class="hidden" onchange="handleDeliveryReceiptPhotoUpload(this.files)" />
            </label>
          </div>
          <input type="hidden" id="delivery-receipt-image-data" data-image-data="${Security.escapeHtml(String(receipt.receiptImage || receipt.photos?.[0] || ''))}" />
          <img id="delivery-receipt-image-preview" src="${Security.escapeHtml(String(receipt.receiptImage || receipt.photos?.[0] || ''))}" class="${(receipt.receiptImage || receipt.photos?.[0]) ? '' : 'hidden'} w-full h-36 object-cover rounded-lg border border-slate-200 dark:border-slate-700" />
          ${(receipt.receiptImage || receipt.photos?.[0]) ? '' : '<div class="text-xs text-slate-400">No photo yet.</div>'}
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Driver notes (optional)</label>
          <textarea id="delivery-driver-notes" rows="2" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Notes..." oninput="updateReceiptDeliveryCompletionComputed()">${Security.escapeHtml(String(receipt.driverNotes || ''))}</textarea>
        </div>

        <div class="grid grid-cols-2 gap-3 text-xs">
          <div id="delivery-debt-compare" class="p-2 rounded-lg bg-white/60 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-200"></div>
          <div id="delivery-fee-compare" class="p-2 rounded-lg bg-white/60 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-200"></div>
        </div>

        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          <button type="button" onclick="openReceiptDeliveryCancelModal('${receipt.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            <i data-lucide="x-circle" class="w-4 h-4 inline mr-1"></i>Cancel Delivery
          </button>
          <button type="button" id="delivery-complete-submit" onclick="submitReceiptDeliveryCompletion('${receipt.id}')" class="flex-1 btn-shine bg-emerald-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed">
            <i data-lucide="check" class="w-4 h-4 inline mr-1"></i>Mark Delivered
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  IconQueue.schedule(modal);
  // If we have an existing image, show it
  const img = document.getElementById('delivery-receipt-image-preview');
  if (img && img.getAttribute('src')) img.classList.remove('hidden');
  updateReceiptDeliveryCompletionComputed();
}

async function submitReceiptDeliveryCompletion(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification('Error', 'Receipt not found', 'error');
    return;
  }

  const finalNo = String(document.getElementById('delivery-final-receipt-no')?.value || '').trim();
  const collected = parseFloat(String(document.getElementById('delivery-collected-amount')?.value || '').trim()) || 0;
  const actualFee = parseFloat(String(document.getElementById('delivery-actual-fee')?.value || '').trim()) || 0;
  const notes = String(document.getElementById('delivery-driver-notes')?.value || '').trim();
  const imgData = String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').trim();

  // Drivers are the most likely Arabic-only users — keep every message bilingual.
  const isArDrv = state.language === 'ar';
  const drvValidationTitle = isArDrv ? 'خطأ في الإدخال' : 'Validation';

  // Allow S-prefixed auto-serial numbers (S1, S2, etc.) for LTT/Libyana/Madar
  const isAutoSerialFinal = isAutoSerialNumber(finalNo);
  if (!finalNo || (!isAutoSerialFinal && (!/^\d+$/.test(finalNo) || finalNo.startsWith('0')))) {
    showNotification(drvValidationTitle, isArDrv
      ? 'رقم الوصل النهائي مطلوب (أرقام فقط، بدون صفر في البداية، أو بادئة S لـ LTT/ليبيانا/المدار).'
      : 'Final receipt number is required (digits only, no leading 0, or S-prefix for LTT/Libyana/Madar).', 'error');
    return;
  }
  if (_receiptFinalNoExists(finalNo, receipt.id)) {
    showNotification(drvValidationTitle, isArDrv ? 'رقم الوصل النهائي موجود بالفعل.' : 'Final receipt number already exists.', 'error');
    return;
  }
  if (!imgData) {
    showNotification(drvValidationTitle, isArDrv ? 'صورة الوصل مطلوبة.' : 'Receipt photo is required.', 'error');
    return;
  }
  if (!Number.isFinite(collected) || collected < 0) {
    showNotification(drvValidationTitle, isArDrv ? 'المبلغ المُحصَّل مطلوب.' : 'Amount collected is required.', 'error');
    return;
  }
  if (!Number.isFinite(actualFee) || actualFee < 0) {
    showNotification(drvValidationTitle, isArDrv ? 'قيمة التوصيل الفعلية مطلوبة.' : 'Actual delivery fee is required.', 'error');
    return;
  }

  const debtLocal = Number(receipt.debtAmountLocal ?? receipt.amountLocal ?? 0) || 0;
  const quoted = Number(receipt.quotedDeliveryFee ?? 0) || 0;
  const debtCmp = compareDebt(debtLocal, collected);
  const feeCmp = compareFees(quoted, actualFee);

  const rate = Number(receipt.exchangeRate || state.defaultExchangeRate || 1) || 1;
  const collectedUSD = rate > 0 ? (collected / rate) : 0;

  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({
    ts: new Date().toISOString(),
    userId: state.currentUser?.id || '',
    action: 'DELIVERED',
    tempReceiptNo: receipt.tempReceiptNo || '',
    finalReceiptNo: finalNo,
    amountCollectedFromCustomer: collected,
    actualDeliveryFeeCollected: actualFee
  });

  const newStatus = (debtCmp.paymentResult === 'UNDERPAID') ? 'Not Paid' : 'Paid';
  const newIsPaid = debtCmp.paymentResult !== 'UNDERPAID';

  const updates = {
    deliveryStatus: 'Delivered',
    deliveredAt: new Date().toISOString(),
    finalReceiptNo: finalNo,
    serialNumber: finalNo,
    receiptImage: imgData,
    photos: [imgData, ...(Array.isArray(receipt.photos) ? receipt.photos.filter(Boolean) : [])].slice(0, 6),
    amountCollectedFromCustomer: collected,
    actualDeliveryFeeCollected: actualFee,
    deliveryFeeCollected: actualFee,
    driverNotes: notes,
    debtAmountLocal: receipt.debtAmountLocal ?? debtLocal,
    debtAmountUSD: receipt.debtAmountUSD ?? (Number(receipt.amountUSD || 0) || 0),
    paymentResult: debtCmp.paymentResult,
    overpaidAmount: debtCmp.overpaidAmount,
    remainingDue: debtCmp.remainingDue,
    feeDifferenceStatus: feeCmp.feeDifferenceStatus,
    feeDiff: feeCmp.feeDiff,
    ownerCoveredExtraFee: receipt.ownerCoveredExtraFee ?? 0,
    status: newStatus,
    isPaid: newIsPaid,
    amountLocal: collected,
    amountUSD: collectedUSD,
    deliveryHistory: nextHistory
  };

  // Server-confirmed save for Delivery users: only show success when backend confirms.
  if (isServerModeEnabled()) {
    const btn = document.getElementById('delivery-complete-submit');
    if (btn) btn.disabled = true;
    try {
      const expected = receipt._lastModified || 0;
      const res = await apiPatchEntity('receipts', receipt.id, updates, expected);
      const saved = res?.data ? Security.sanitizeObject(res.data) : null;
      if (!saved || !saved.id) {
        showNotification(state.language === 'ar' ? 'خطأ في الخادم' : 'Server Error', state.language === 'ar' ? 'فشل حفظ التوصيل: استجابة غير صالحة من الخادم' : 'Failed to save delivery: invalid server response', 'error');
        if (btn) btn.disabled = false;
        return;
      }
      const idx = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
      if (idx !== -1) state.receipts[idx] = saved;
      markCollectionDirty('receipts');
      saveState();
      document.getElementById('delivery-complete-modal')?.remove();
      showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم إكمال التوصيل وحفظه' : 'Delivery completed and saved', 'success');
      render();
    } catch (e) {
      // Idempotency / retries: if we hit a conflict, load latest and succeed if already delivered.
      if (e?.status === 409) {
        try {
          const latest = await apiGetEntity('receipts', receipt.id);
          const latestData = latest?.data ? Security.sanitizeObject(latest.data) : null;
          if (latestData && String(latestData.deliveryStatus || '') === 'Delivered') {
            const idx = state.receipts.findIndex(r => r && !r._deleted && String(r.id) === String(receipt.id));
            if (idx !== -1) state.receipts[idx] = latestData;
            markCollectionDirty('receipts');
            saveState();
            document.getElementById('delivery-complete-modal')?.remove();
            showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم إكمال التوصيل وحفظه' : 'Delivery completed and saved', 'success');
            render();
            return;
          }
        } catch (retryErr) {
          // Fall through to error toast - retry also failed
          if (ALBAYAN_DEBUG_MODE) console.warn('[handleDeliveryComplete] Retry fetch failed:', retryErr?.message || retryErr);
        }
      }
      const status = e?.status ? `HTTP ${e.status}` : '';
      const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
      showNotification('Server Error', `Failed to save delivery: ${status ? status + ' - ' : ''}${detail}`, 'error');
      if (btn) btn.disabled = false;
      return;
    }
  } else {
    // Local mode: optimistic update
    updateRecord(state.receipts, receipt.id, updates);
    document.getElementById('delivery-complete-modal')?.remove();
    showNotification(state.language === 'ar' ? 'تم التوصيل' : 'Delivered', state.language === 'ar' ? 'تم إكمال التوصيل وحفظه' : 'Delivery completed and saved', 'success');
    render();
  }
}

function openReceiptDeliveryCancelModal(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) {
    showNotification('Error', 'Receipt not found', 'error');
    return;
  }
  if (String(state.currentUser?.role || '').toLowerCase() !== 'delivery') {
    showNotification('Access Denied', 'Delivery users only', 'error');
    return;
  }
  if (String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
    showNotification('Access Denied', 'This receipt is not assigned to you', 'error');
    return;
  }
  if (String(receipt.deliveryStatus || '') === 'Delivered') {
    showNotification('Not Allowed', 'Already delivered.', 'warning');
    return;
  }

  document.getElementById('delivery-cancel-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'delivery-cancel-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-md animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center space-x-3">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center">
            <i data-lucide="x-circle" class="w-5 h-5 text-white"></i>
          </span>
          <div>
            <div class="text-lg font-bold text-slate-800 dark:text-white">Cancel Delivery</div>
            <div class="text-xs text-slate-500">Receipt ${Security.escapeHtml(String(receipt.tempReceiptNo || receipt.serialNumber || receipt.id))}</div>
          </div>
        </div>
        <button onclick="this.closest('#delivery-cancel-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 mb-1">Reason *</label>
          <textarea id="delivery-cancel-reason" rows="3" class="w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="Why are you cancelling?"></textarea>
        </div>
        <div class="flex space-x-2 pt-2 border-t border-slate-200 dark:border-slate-700">
          <button type="button" onclick="this.closest('#delivery-cancel-modal').remove()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-300">Close</button>
          <button type="button" onclick="submitReceiptDeliveryCancel('${receipt.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            Confirm Cancel
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function submitReceiptDeliveryCancel(receiptId) {
  const receipt = _findReceiptForDeliveryModal(receiptId);
  if (!receipt) return;
  const reason = String(document.getElementById('delivery-cancel-reason')?.value || '').trim();
  if (!reason) {
    showNotification('Validation', 'Cancel reason is required.', 'error');
    return;
  }
  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({
    ts: new Date().toISOString(),
    userId: state.currentUser?.id || '',
    action: 'CANCELLED_BY_DRIVER',
    reason
  });
  updateRecord(state.receipts, receipt.id, {
    deliveryStatus: 'Canceled',
    deliveryCancelReason: reason,
    deliveryCancelledAt: new Date().toISOString(),
    deliveryCancelledBy: state.currentUser?.id || '',
    deliveryHistory: nextHistory
  });
  document.getElementById('delivery-cancel-modal')?.remove();
  document.getElementById('delivery-complete-modal')?.remove();
  showNotification('Canceled', 'Delivery canceled', 'success');
  render();
}

function markAsDelivered(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  if (isReceipt) {
    // Strict flow for temp delivery receipts: require final receipt # + photo + amounts
    if (isTempDeliveryReceiptNo(isReceipt.tempReceiptNo)) {
      openReceiptDeliveryCompletionModal(itemId);
      return;
    }
    // Delivered ≠ Office Handover. Office handover is a separate step (isReceivedInOffice).
    updateRecord(state.receipts, itemId, { deliveryStatus: 'Delivered' });
  } else {
    updateRecord(state.ads, itemId, {
      deliveryStatus: 'Delivered'
    });
  }
  showNotification('Delivered', 'Marked as delivered', 'success');
  render();
}

// ==========================================
// RECEIPT FILTER FUNCTIONS
// ==========================================

let _receiptSearchTimer = null;

function updateReceiptSearch(value) {
  const v = String(value || '');
  const clean = Security.sanitizeInput(v, { maxLength: 200 });
  state.receiptSearch = clean;
  if (_receiptSearchTimer) clearTimeout(_receiptSearchTimer);
  // Small debounce to keep typing smooth (same pattern as the customers view).
  // Only the results below the search box are re-rendered, so the input keeps
  // focus naturally — no full-page rebuild, no refocus hack.
  _receiptSearchTimer = setTimeout(() => {
    _receiptSearchTimer = null;
    updateReceiptsViewFiltered();
  }, 120);
}

function updateReceiptsViewFiltered() {
  if (state.currentView !== 'receipts') return;
  const grid = document.getElementById('receipts-grid');
  const countEl = document.getElementById('receipts-count');
  const chipsEl = document.getElementById('receipt-active-filters');
  const clearEl = document.getElementById('receipt-search-clear');
  const clearFiltersEl = document.getElementById('receipt-clear-filters');
  if (!grid || !countEl) {
    // View structure not on screen (e.g. mid-navigation): fall back to a full render.
    render();
    if (window.lucide) lucide.createIcons();
    return;
  }
  // Build the fresh view HTML off-screen, then swap in only the parts that
  // change while searching (results grid, count, filter chips, clear button).
  const tpl = document.createElement('template');
  tpl.innerHTML = renderReceiptsView();
  const src = tpl.content;
  const newGrid = src.querySelector('#receipts-grid');
  const newCount = src.querySelector('#receipts-count');
  const newChips = src.querySelector('#receipt-active-filters');
  const newClear = src.querySelector('#receipt-search-clear');
  const newClearFilters = src.querySelector('#receipt-clear-filters');
  if (newGrid) grid.innerHTML = newGrid.innerHTML;
  if (newCount) countEl.textContent = newCount.textContent;
  if (chipsEl && newChips) chipsEl.innerHTML = newChips.innerHTML;
  if (clearEl && newClear) clearEl.innerHTML = newClear.innerHTML;
  if (clearFiltersEl && newClearFilters) clearFiltersEl.innerHTML = newClearFilters.innerHTML;
  if (window.lucide) lucide.createIcons();
}

function clearReceiptSearch() {
  state.receiptSearch = '';
  render();
  lucide.createIcons();
}

function updateReceiptFilter(filterType, value) {
  switch (filterType) {
    case 'status':
      state.receiptStatusFilter = value;
      break;
    case 'payment':
      state.receiptPaymentFilter = value;
      break;
    case 'date':
      state.receiptDateFilter = value;
      break;
    case 'collected':
      state.receiptCollectedFilter = value;
      break;
    case 'sort':
      state.receiptSortBy = value;
      break;
  }
  render();
  lucide.createIcons();
}

function clearAllReceiptFilters() {
  state.receiptSearch = '';
  state.receiptStatusFilter = 'all';
  state.receiptPaymentFilter = 'all';
  state.receiptDateFilter = 'all';
  state.receiptCollectedFilter = 'all';
  state.receiptSortBy = 'newest';
  render();
  lucide.createIcons();
}

// Toggle receipt collected status
function _canMarkCollected() {
  if (!currentUserHasPermission('receipts', 'markCollected')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتعديل حالة التحصيل' : 'You do not have permission to mark receipts as collected', 'error');
    return false;
  }
  return true;
}

function _logReceiptCollection(receipt, action, collectedAmount) {
  state.logs.push({
    id: generateId(),
    type: 'receipt_collection',
    action,
    receiptId: receipt.id,
    userId: state.currentUser?.id,
    timestamp: new Date().toISOString(),
    details: { receiptSerial: receipt.serialNumber, amountUSD: receipt.amountUSD, amountLocal: receipt.amountLocal, collectedAmount }
  });
}

// Open a small modal to record HOW MUCH was collected for a receipt (user
// request). Supports partial collection; the card then shows collected + the
// amount still left to collect. Self-contained (stop-ad-modal style) so it
// doesn't touch renderModal/state.modalData.
// ---- Receipt collection (2-step): ask "same as receipt?" -> Yes records it
// as-is; No opens a payment-methods editor like the ad/receipt forms. ----
let _tempCollectPayments = [];   // [{ method, amount }] working list for the "No" editor
let _collectReceiptId = '';
let _collectTargetLYD = 0;

// The receipt's own payment breakdown in LYD (used for the "Yes = same" path
// and to seed the "No" editor). Each split's LYD value is amount × rate1.
function _receiptCollectionBreakdown(receipt) {
  const target = Number(receipt.amountLocal) || 0;
  if (Array.isArray(receipt.payments) && receipt.payments.length) {
    return receipt.payments
      .map(p => ({ method: p.method || 'Cash (LYD)', amount: Math.round((Number(p.amount) || 0) * (Number(p.rate) || 1) * 100) / 100 }))
      .filter(p => p.amount > 0);
  }
  return [{ method: receipt.paymentMethod || 'Cash (LYD)', amount: target }];
}

function openCollectReceiptModal(receiptId) {
  if (!_canMarkCollected()) return;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  const isAr = state.language === 'ar';
  const targetLYD = Number(receipt.amountLocal) || 0;
  const serialTxt = receipt.serialNumber || receipt.tempReceiptNo || receipt.finalReceiptNo || receiptId.slice(0, 8);
  _collectReceiptId = receiptId;
  _collectTargetLYD = targetLYD;
  _tempCollectPayments = [];

  document.getElementById('collect-receipt-modal')?.remove();
  const html = `
    <div id="collect-receipt-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onclick="if(event.target===this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
        <div class="p-5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-800 z-10">
          <h2 class="text-lg font-bold text-slate-800 dark:text-white flex items-center">
            <i data-lucide="hand-coins" class="w-5 h-5 mr-2 text-emerald-600"></i>
            ${isAr ? 'تسجيل التحصيل' : 'Record Collection'}
          </h2>
          <button onclick="document.getElementById('collect-receipt-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div id="collect-modal-body" class="p-5">
          ${_collectAskView(receiptId, receipt, isAr, targetLYD, serialTxt)}
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  if (window.lucide) lucide.createIcons();
}

// Step 1: ask whether the money came in exactly as the receipt states.
function _collectAskView(receiptId, receipt, isAr, targetLYD, serialTxt) {
  const breakdown = _receiptCollectionBreakdown(receipt);
  return `
    <div class="text-sm text-slate-600 dark:text-slate-400 mb-1">
      ${isAr ? 'الوصل' : 'Receipt'} #${Security.escapeHtml(String(serialTxt))} — ${isAr ? 'الإجمالي' : 'Total'}: <span class="font-bold text-slate-800 dark:text-white">${targetLYD.toFixed(2)} LYD</span>
    </div>
    <div class="text-xs text-slate-500 mb-4">
      ${isAr ? 'حسب الوصل' : 'As on the receipt'}: ${breakdown.map(p => `${Security.escapeHtml(p.method)} ${p.amount.toFixed(2)} LYD`).join(' • ')}
    </div>
    <p class="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
      ${isAr ? 'هل تم التحصيل بنفس بيانات الوصل الأصلية؟' : 'Did you collect exactly as shown on the receipt?'}
    </p>
    <div class="grid grid-cols-2 gap-3">
      <button onclick="collectReceiptSame('${receiptId}')" class="px-4 py-3 rounded-xl font-bold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-2">
        <i data-lucide="check" class="w-4 h-4"></i>${isAr ? 'نعم، كما الوصل' : 'Yes, same'}
      </button>
      <button onclick="collectReceiptCustom('${receiptId}')" class="px-4 py-3 rounded-xl font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 flex items-center justify-center gap-2">
        <i data-lucide="sliders-horizontal" class="w-4 h-4"></i>${isAr ? 'لا، طرق أخرى' : 'No, different'}
      </button>
    </div>`;
}

// "Yes" — record the collection using the receipt's own breakdown, full amount.
function collectReceiptSame(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  const breakdown = _receiptCollectionBreakdown(receipt);
  _saveReceiptCollection(receipt, breakdown, Number(receipt.amountLocal) || 0, true);
}

// "No" — switch the modal to the payment-methods editor (like the ad form).
function collectReceiptCustom(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  // Seed from the receipt's own breakdown so the user just edits amounts/methods.
  _tempCollectPayments = _receiptCollectionBreakdown(receipt).map(p => ({ method: p.method, amount: String(p.amount) }));
  if (_tempCollectPayments.length === 0) _tempCollectPayments = [{ method: PAYMENT_METHODS[0], amount: '' }];
  const body = document.getElementById('collect-modal-body');
  if (body) body.innerHTML = _collectEditorView(receiptId, receipt);
  if (window.lucide) lucide.createIcons();
}

function _collectEditorView(receiptId, receipt) {
  const isAr = state.language === 'ar';
  const target = _collectTargetLYD;
  const rows = _tempCollectPayments.map((p, idx) => `
    <div class="grid grid-cols-12 gap-2 items-end">
      <div class="col-span-7">
        ${idx === 0 ? `<label class="block text-[10px] text-slate-400 mb-1">${isAr ? 'الطريقة' : 'Method'}</label>` : ''}
        <select onchange="updateCollectPaymentRow(${idx}, 'method', this.value)" class="w-full glass-input px-2 py-1.5 rounded-lg text-sm">
          ${PAYMENT_METHODS.map(m => `<option value="${m}" ${p.method === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="col-span-4">
        ${idx === 0 ? `<label class="block text-[10px] text-slate-400 mb-1">${isAr ? 'المبلغ (LYD)' : 'Amount (LYD)'}</label>` : ''}
        <input type="text" inputmode="decimal" value="${Security.escapeHtml(String(p.amount || ''))}" oninput="sanitizeMoneyInput(this); updateCollectPaymentRow(${idx}, 'amount', this.value)" onfocus="this.select()" class="w-full glass-input px-2 py-1.5 rounded-lg text-sm" placeholder="0.00" />
      </div>
      <div class="col-span-1 flex justify-center pb-1">
        ${_tempCollectPayments.length > 1 ? `<button type="button" onclick="removeCollectPaymentRow(${idx})" class="text-rose-500 hover:text-rose-600"><i data-lucide="x" class="w-4 h-4"></i></button>` : ''}
      </div>
    </div>`).join('');
  const total = _tempCollectPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const left = Math.max(target - total, 0);
  return `
    <div class="text-sm text-slate-600 dark:text-slate-400 mb-3">
      ${isAr ? 'الإجمالي المطلوب' : 'Total due'}: <span class="font-bold text-slate-800 dark:text-white">${target.toFixed(2)} LYD</span>
    </div>
    <div class="space-y-2" id="collect-rows">${rows}</div>
    <button type="button" onclick="addCollectPaymentRow()" class="mt-2 text-xs font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1">
      <i data-lucide="plus-circle" class="w-4 h-4"></i>${isAr ? 'إضافة طريقة' : 'Add method'}
    </button>
    <div class="mt-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 space-y-1 text-sm">
      <div class="flex justify-between"><span class="text-slate-600 dark:text-slate-400">${isAr ? 'إجمالي المُحصَّل' : 'Total collected'}:</span><span class="font-bold text-emerald-600" id="collect-total">${total.toFixed(2)} LYD</span></div>
      <div class="flex justify-between"><span class="text-slate-600 dark:text-slate-400">${isAr ? 'المتبقي للتحصيل' : 'Left to collect'}:</span><span class="font-bold text-orange-600" id="collect-left">${left.toFixed(2)} LYD</span></div>
    </div>
    <div class="flex space-x-3 pt-4">
      <button onclick="collectReceiptCustomBack('${receiptId}')" class="flex-1 px-4 py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-bold">${isAr ? 'رجوع' : 'Back'}</button>
      <button onclick="confirmCollectReceipt('${receiptId}')" class="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700">${isAr ? 'حفظ' : 'Save'}</button>
    </div>`;
}

function _rerenderCollectEditor() {
  const receipt = state.receipts.find(r => r.id === _collectReceiptId);
  const body = document.getElementById('collect-modal-body');
  if (receipt && body) { body.innerHTML = _collectEditorView(_collectReceiptId, receipt); if (window.lucide) lucide.createIcons(); }
}

function _refreshCollectTotals() {
  const total = _tempCollectPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalEl = document.getElementById('collect-total');
  const leftEl = document.getElementById('collect-left');
  if (totalEl) totalEl.textContent = total.toFixed(2) + ' LYD';
  if (leftEl) leftEl.textContent = Math.max(_collectTargetLYD - total, 0).toFixed(2) + ' LYD';
}

// Row edits: amount just refreshes the totals (no re-render, keeps typing focus);
// method changes state silently; add/remove re-render the whole editor.
function updateCollectPaymentRow(idx, field, value) {
  if (!_tempCollectPayments[idx]) return;
  _tempCollectPayments[idx][field] = value;
  if (field === 'amount') _refreshCollectTotals();
}
function addCollectPaymentRow() { _tempCollectPayments.push({ method: PAYMENT_METHODS[0], amount: '' }); _rerenderCollectEditor(); }
function removeCollectPaymentRow(idx) { _tempCollectPayments.splice(idx, 1); _rerenderCollectEditor(); }
function collectReceiptCustomBack(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  const body = document.getElementById('collect-modal-body');
  if (receipt && body) {
    const serialTxt = receipt.serialNumber || receipt.tempReceiptNo || receipt.finalReceiptNo || receiptId.slice(0, 8);
    body.innerHTML = _collectAskView(receiptId, receipt, state.language === 'ar', Number(receipt.amountLocal) || 0, serialTxt);
    if (window.lucide) lucide.createIcons();
  }
}

// "No" path save: validate + persist the custom breakdown.
function confirmCollectReceipt(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  const payments = _tempCollectPayments
    .map(p => ({ method: p.method, amount: Math.round((parseFloat(p.amount) || 0) * 100) / 100 }))
    .filter(p => p.amount > 0);
  if (payments.length === 0) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'أدخل مبلغاً واحداً على الأقل' : 'Enter at least one amount', 'error');
    return;
  }
  const total = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  _saveReceiptCollection(receipt, payments, total, false);
}

// Shared save for both the "Yes" and "No" paths.
function _saveReceiptCollection(receipt, payments, totalLYD, matchesReceipt) {
  if (!_canMarkCollected()) return;
  const targetLYD = Number(receipt.amountLocal) || 0;
  updateRecord(state.receipts, receipt.id, {
    collected: true,
    collectedAmount: totalLYD,
    collectedPayments: payments,
    collectedMatchesReceipt: !!matchesReceipt,
    collectedAt: new Date().toISOString(),
    collectedBy: state.currentUser?.id || 'admin'
  });
  _logReceiptCollection(receipt, 'collected', totalLYD);
  saveState();
  document.getElementById('collect-receipt-modal')?.remove();
  const leftLYD = Math.max(targetLYD - totalLYD, 0);
  const isAr = state.language === 'ar';
  showNotification(
    isAr ? 'تم التحصيل' : 'Collected',
    (isAr ? `تم تسجيل ${totalLYD.toFixed(2)} LYD` : `Recorded ${totalLYD.toFixed(2)} LYD`) + (leftLYD > 0.01 ? (isAr ? ` — المتبقي ${leftLYD.toFixed(2)} LYD` : ` — ${leftLYD.toFixed(2)} LYD left`) : ''),
    'success'
  );
  render();
  if (window.lucide) lucide.createIcons();
}

function uncollectReceipt(receiptId) {
  if (!_canMarkCollected()) return;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  updateRecord(state.receipts, receiptId, { collected: false, collectedAmount: null, collectedAt: null, collectedBy: null });
  _logReceiptCollection(receipt, 'uncollected', 0);
  saveState();
  showNotification(state.language === 'ar' ? 'تم الإلغاء' : 'Collection Removed', state.language === 'ar' ? 'تم إلغاء التحصيل' : 'Receipt marked as not collected', 'info');
  render();
  if (window.lucide) lucide.createIcons();
}

// Back-compat shim: old callers of the boolean toggle now route to the new
// amount-based flow (open the modal to collect, or undo).
function toggleReceiptCollected(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  if (receipt.collected) uncollectReceipt(receiptId);
  else openCollectReceiptModal(receiptId);
}

function showReceiptModal() {
  // Permission check for creating receipts
  if (!currentUserHasPermission('receipts', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء وصولات' : 'You do not have permission to create receipts', 'error');
    return;
  }
  state.activeModal = 'receipt';
  state.modalData = null;
  updateUrlParams({ modal: 'receipt', id: 'new' }); // URL tracking for new receipt
  renderModal();
}

function manageSplitPayments(receiptId) {
  const receipt = state.receipts.find(a => a.id === receiptId);
  if (!receipt) return;
  
  state.activeModal = 'split-payments';
  state.modalData = receipt;
  updateUrlParams({ modal: 'split-payments', id: receiptId }); // URL tracking
  renderModal();
}

function manageTopUps(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;

  // Seed the working list with a COPY of the ad's existing top-ups, so the
  // modal shows them, the X button can delete them, and newly-added ones
  // appear immediately. Starting empty (the old behavior) meant existing
  // top-ups couldn't be removed and new ones were invisible until save.
  tempTopUps = (ad.topUps || []).map(t => ({ ...t }));

  state.activeModal = 'top-ups';
  state.modalData = ad;
  renderModal();
}

function manageRefund(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  
  state.activeModal = 'refund';
  state.modalData = ad;
  renderModal();
}

// Open transfer modal for a receipt
function showReceiptTransferModal(receiptId) {
  // Permission check
  if (!currentUserHasPermission('receipts', 'transfer')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتحويل الرصيد' : 'You do not have permission to transfer receipt balance', 'error');
    return;
  }
  state.activeModal = 'receipt-transfer';
  state.modalData = state.receipts.find(r => r.id === receiptId);
  renderModal();
}

// Quick inline history viewer for receipt transfers
function showReceiptTransferHistory(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  const transfers = receipt?.transfers || [];
  if (!receipt) return;
  if (transfers.length === 0) {
    showNotification('Transfers', 'No transfers recorded for this receipt.', 'info');
    return;
  }
  const lines = transfers.map(t => {
    const targetCustomer = state.customers.find(c => c.id === t.toCustomerId);
    const name = targetCustomer ? targetCustomer.name : 'Unknown';
    return `${new Date(t.date).toLocaleString()}: $${(t.amountUSD || 0).toFixed(2)} to ${name}`;
  }).join('\n');
  showNotification('Transfer history', lines, 'info');
}

// Show receipt edit history modal
function showReceiptEditHistory(receiptId) {
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;
  
  const editHistory = receipt.editHistory || [];
  if (editHistory.length === 0) {
    showNotification('Edit History', 'No edit history recorded for this receipt.', 'info');
    return;
  }
  
  const customer = state.customers.find(c => c.id === receipt.customerId);
  
  const modalHTML = `
    <div id="edit-history-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
                <i data-lucide="history" class="w-5 h-5 mr-2 text-amber-500"></i>
                Edit History
              </h2>
              <p class="text-sm text-slate-500 mt-1">
                Receipt ${receipt.serialNumber ? '#' + receipt.serialNumber : ''} for ${Security.escapeHtml(customer?.name || 'Unknown')}
              </p>
            </div>
            <button onclick="document.getElementById('edit-history-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          ${editHistory.slice().reverse().map((edit, idx) => `
            <div class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <span class="text-xs font-bold text-white bg-amber-500 px-2 py-1 rounded-full">Edit #${editHistory.length - idx}</span>
                  <span class="text-xs text-slate-500">${edit.editedBy || 'Unknown'}</span>
                </div>
                <span class="text-xs text-slate-400">${new Date(edit.editedAt).toLocaleString()}</span>
              </div>
              
              <div class="space-y-2">
                ${edit.changes.map(change => `
                  <div class="flex items-start text-sm bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                    <div class="flex-1">
                      <span class="font-medium text-slate-700 dark:text-slate-300">${change.field}</span>
                      <div class="flex items-center mt-1 space-x-2 text-xs">
                        <span class="px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 rounded line-through">${change.from}</span>
                        <i data-lucide="arrow-right" class="w-3 h-3 text-slate-400"></i>
                        <span class="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">${change.to}</span>
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p class="text-xs text-slate-500 text-center">
            Total: ${editHistory.length} edit${editHistory.length > 1 ? 's' : ''} • 
            Created: ${new Date(receipt.createdAt).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal first
  document.getElementById('edit-history-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons in the new modal
  lucide.createIcons();
}

// Show ad edit history modal
function showAdEditHistory(adId) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  
  const editHistory = ad.editHistory || [];
  if (editHistory.length === 0) {
    showNotification('Edit History', 'No edit history recorded for this ad.', 'info');
    return;
  }
  
  const customer = state.customers.find(c => c.id === ad.customerId);
  const page = state.pages.find(p => p.id === ad.pageId);
  
  const modalHTML = `
    <div id="edit-history-modal" class="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onclick="if(event.target === this) this.remove()">
      <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center">
                <i data-lucide="history" class="w-5 h-5 mr-2 text-purple-500"></i>
                Edit History
              </h2>
              <p class="text-sm text-slate-500 mt-1">
                Ad for ${Security.escapeHtml(customer?.name || 'Unknown')} • ${Security.escapeHtml(page?.name || 'Unknown Page')}
              </p>
            </div>
            <button onclick="document.getElementById('edit-history-modal').remove()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          ${editHistory.slice().reverse().map((edit, idx) => `
            <div class="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center space-x-2">
                  <span class="text-xs font-bold text-white bg-purple-500 px-2 py-1 rounded-full">Edit #${editHistory.length - idx}</span>
                  <span class="text-xs text-slate-500">${edit.editedBy || 'Unknown'}</span>
                </div>
                <span class="text-xs text-slate-400">${new Date(edit.editedAt).toLocaleString()}</span>
              </div>
              
              <div class="space-y-2">
                ${edit.changes.map(change => `
                  <div class="flex items-start text-sm bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-100 dark:border-slate-700">
                    <div class="flex-1">
                      <span class="font-medium text-slate-700 dark:text-slate-300">${change.field}</span>
                      <div class="flex items-center mt-1 space-x-2 text-xs">
                        <span class="px-2 py-1 bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 rounded line-through">${change.from}</span>
                        <i data-lucide="arrow-right" class="w-3 h-3 text-slate-400"></i>
                        <span class="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded">${change.to}</span>
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        
        <div class="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p class="text-xs text-slate-500 text-center">
            Total: ${editHistory.length} edit${editHistory.length > 1 ? 's' : ''} • 
            Created: ${new Date(ad.createdAt).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  `;
  
  // Remove any existing modal first
  document.getElementById('edit-history-modal')?.remove();
  
  // Add modal to DOM
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Initialize Lucide icons in the new modal
  lucide.createIcons();
}

// Persist a transfer from receipt to another customer
function saveReceiptTransfer() {
  const receiptId = state.modalData?.id;
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (!receipt) return;

  const targetCustomerEl = document.getElementById('transfer-target-customer');
  const amountUSDElement = document.getElementById('transfer-amount-usd');
  const noteElement = document.getElementById('transfer-note');
  if (!targetCustomerEl || !amountUSDElement) {
    showNotification('Error', 'Transfer form elements not found', 'error');
    return;
  }
  const targetCustomerId = targetCustomerEl.value;
  const amountUSD = parseFloat(amountUSDElement.value) || 0;
  const note = noteElement?.value || '';

  if (!targetCustomerId) {
    showNotification('Validation', 'Please choose a customer to transfer to.', 'error');
    return;
  }
  if (amountUSD <= 0) {
    showNotification('Validation', 'Transfer amount must be greater than zero.', 'error');
    return;
  }

  const usage = getReceiptUsageStats(receipt);
  if (amountUSD > usage.remainingUSD) {
    showNotification('Validation', 'Amount exceeds available balance.', 'error');
    return;
  }

  const transfer = {
    id: generateId('transfer'),
    toCustomerId: targetCustomerId,
    amountUSD,
    amountLocal: amountUSD * (receipt.exchangeRate || state.defaultExchangeRate || 1),
    date: new Date().toISOString(),
    note
  };

  const updatedTransfers = [...(receipt.transfers || []), transfer];
  updateRecord(state.receipts, receipt.id, { transfers: updatedTransfers });
  addLog('transfer', 'receipt', receipt.id, `Transferred $${amountUSD.toFixed(2)} to customer`, { toCustomerId: targetCustomerId });
  showNotification('Transferred', 'Receipt balance transferred successfully', 'success');
  closeModal();
  render();
}

function addSplitPayment() {
  const container = document.getElementById('split-payments-container');
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
  
  const div = document.createElement('div');
  div.className = 'split-payment-item p-4 rounded-lg';
  div.innerHTML = `
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="block text-xs font-medium mb-1">Payment Method</label>
        <select class="split-method w-full glass-input px-3 py-2 rounded-lg text-sm">
          ${PAYMENT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">Amount (LYD)</label>
        <input type="text" inputmode="decimal" class="split-amount w-full glass-input px-3 py-2 rounded-lg text-sm" placeholder="0.00" oninput="sanitizeMoneyInput(this)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">Exchange Rate</label>
        <input type="text" inputmode="decimal" class="split-rate w-full glass-input px-3 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">USD Rate (Rate 2)</label>
        <input type="text" inputmode="decimal" class="split-rate2 w-full glass-input px-3 py-2 rounded-lg text-sm" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" />
      </div>
      <div>
        <label class="block text-xs font-medium mb-1">Collection Type</label>
        <select class="split-collection w-full glass-input px-3 py-2 rounded-lg text-sm">
          <option value="office">Office</option>
          <option value="delivery">Delivery</option>
          <option value="bank">Bank</option>
        </select>
      </div>
      ${deliveryUsers.length > 0 ? `
        <div class="col-span-2">
          <label class="block text-xs font-medium mb-1">Delivery Person (if delivery)</label>
          <select class="split-delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm">
            <option value="">None</option>
            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
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
  `;
  container.appendChild(div);
  lucide.createIcons();
}

function saveSplitPayments() {
  // Read the target from the frozen hidden field, not the mutable global, so a
  // stray navigation can't redirect this save onto a different receipt.
  const receiptId = (document.getElementById('split-payments-receipt-id')?.value || '').trim() || state.modalData?.id;
  if (!receiptId || !state.receipts.some(r => r && !r._deleted && String(r.id) === String(receiptId))) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'تعذّر تحديد الوصل' : 'Could not identify the receipt', 'error');
    return;
  }
  const paymentItems = document.querySelectorAll('.split-payment-item');
  const payments = [];

  paymentItems.forEach(item => {
    const method = item.querySelector('.split-method').value;
    const amount = parseFloat(item.querySelector('.split-amount').value) || 0;
    const rate = parseFloat(item.querySelector('.split-rate').value) || state.defaultExchangeRate;
    // 0/blank Rate 2 means "no USD ads credit" (matches saveReceiptFromModal),
    // NOT "fall back to the LYD rate" — the old fallback fabricated ads credit
    // out of a zero-rate receipt on a no-op Save.
    const rate2 = parseFloat(item.querySelector('.split-rate2')?.value) || 0;
    const collectionType = item.querySelector('.split-collection').value;
    const deliveryPersonId = item.querySelector('.split-delivery-person')?.value || '';

    if (amount > 0) {
      payments.push({
        method,
        amount,
        rate,
        rate2,
        collectionType,
        deliveryPersonId
      });
    }
  });

  // Recompute the receipt totals from the edited payments using the SAME
  // logic as saveReceipt (src/14-forms.js). Previously this saved only the
  // payments array and left amountUSD/amountLocal/exchangeRate stale, so the
  // receipt's money totals no longer matched its own payment lines.
  const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  let totalR1 = 0; // Total PAID (LYD)
  let totalR2 = 0; // Total ADS CREDIT (USD)
  payments.forEach(p => {
    const r1 = p.amount * p.rate;
    let r2 = 0;
    if (p.rate2 > 0) {
      r2 = usdBasedMethods.includes(p.method) ? (r1 / p.rate2) : (p.amount / p.rate2);
      r2 = ceilingRound(r2);
    }
    totalR1 += r1;
    totalR2 += r2;
  });
  // Snap to 2 decimals first so binary float residue doesn't trip the rule.
  totalR2 = Math.round(totalR2 * 100) / 100;
  if (totalR2 % 1 !== 0) totalR2 = Math.round((totalR2 + 0.01) * 100) / 100;
  const avgRate = (totalR2 > 0 && totalR1 > 0) ? (totalR1 / totalR2) : state.defaultExchangeRate;

  updateRecord(state.receipts, receiptId, {
    payments,
    amountLocal: totalR1,
    amountUSD: totalR2,
    exchangeRate: avgRate
  });
  showNotification('Saved', 'Split payments saved successfully', 'success');
  closeModal();
  render();
}

// Top-ups management functions
let tempTopUps = [];

// Read whatever the user typed in the Add New Top-up form. Returns a top-up
// entry ({date, amount, extendDays, note}) or null when the form is empty.
// Shared by the "Add Top-up" button AND saveTopUps — previously an amount that
// was typed but not explicitly "Add"ed was SILENTLY DROPPED on Save, which
// made the whole feature look broken.
function _readTopUpForm() {
  const amountEl = document.getElementById('topup-amount');
  if (!amountEl) return null;
  const amount = parseFloat(amountEl.value) || 0;
  const extendDays = parseInt(document.getElementById('topup-extend-days')?.value, 10) || 0;
  if (amount <= 0 && extendDays <= 0) return null;
  const date = document.getElementById('topup-date')?.value;
  return {
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    amount: amount > 0 ? amount : 0,
    extendDays: extendDays > 0 ? extendDays : 0,
    note: document.getElementById('topup-note')?.value || 'Top-up'
  };
}

function addNewTopUp() {
  const entry = _readTopUpForm();
  if (entry === null && !document.getElementById('topup-amount')) {
    showNotification('Error', 'Top-up form elements not found', 'error');
    return;
  }
  if (!entry) {
    showNotification(
      state.language === 'ar' ? 'خطأ في الإدخال' : 'Validation',
      state.language === 'ar' ? 'أدخل مبلغاً أو عدد أيام تمديد' : 'Enter an amount or extension days',
      'error'
    );
    return;
  }
  tempTopUps.push(entry);
  // Re-render modal to show new top-up
  renderModal();
}

function removeTopUp(index) {
  tempTopUps.splice(index, 1);
  renderModal();
}

function saveTopUps() {
  const adId = state.modalData.id;
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;

  // Forgiving save: anything still typed in the form counts as a top-up too
  // (the user should not need to click "Add Top-up" before "Save Top-ups").
  const pending = _readTopUpForm();
  if (pending) tempTopUps.push(pending);

  // tempTopUps is the COMPLETE working list (seeded from ad.topUps on open,
  // plus/minus edits). initialAmountUSD / initialEndDate are the values BEFORE
  // any top-up, so the new totals are base + EVERY top-up — removing a top-up
  // later correctly shrinks both the amount and the end date again.
  const allTopUps = tempTopUps.map(t => ({ ...t }));
  const baseAmountUSD = ad.initialAmountUSD || ad.amountUSD;
  const totalTopUps = allTopUps.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  const newAmountUSD = Math.round((baseAmountUSD + totalTopUps) * 100) / 100;

  const updates = {
    topUps: allTopUps,
    initialAmountUSD: baseAmountUSD,
    amountUSD: newAmountUSD,
    amountLocal: Math.round(newAmountUSD * ad.exchangeRate * 100) / 100
  };

  // End-date extension (user request): top-ups can extend the ad's run.
  const baseEnd = ad.initialEndDate || ad.endDate || '';
  const totalExtendDays = allTopUps.reduce((sum, t) => sum + (parseInt(t.extendDays, 10) || 0), 0);
  let newEndDisplay = '';
  if (baseEnd && !isNaN(new Date(baseEnd).getTime())) {
    updates.initialEndDate = baseEnd;
    updates.endDate = new Date(new Date(baseEnd).getTime() + totalExtendDays * 86400000).toISOString();
    if (totalExtendDays > 0) newEndDisplay = new Date(updates.endDate).toLocaleDateString();
  }

  updateRecord(state.ads, adId, updates);

  tempTopUps = [];
  const isArTU = state.language === 'ar';
  showNotification(
    isArTU ? 'تم الحفظ' : 'Saved',
    (isArTU ? `تم حفظ التعبئة. المبلغ الجديد: $${newAmountUSD.toFixed(2)}` : `Top-ups saved. New amount: $${newAmountUSD.toFixed(2)}`)
      + (newEndDisplay ? (isArTU ? ` — ينتهي: ${newEndDisplay}` : ` — ends: ${newEndDisplay}`) : ''),
    'success'
  );
  closeModal();
  render();
}

// Refund management functions
function toggleRefundAmount(refundType) {
  const amountSection = document.getElementById('refund-amount-section');
  const statusSection = document.getElementById('refund-status-section');
  
  if (refundType === 'None') {
    amountSection.classList.add('hidden');
    statusSection.classList.add('hidden');
  } else {
    amountSection.classList.remove('hidden');
    statusSection.classList.remove('hidden');
    
    // Auto-fill amount for Full refund
    if (refundType === 'Full' && state.modalData) {
      document.getElementById('refund-amount').value = state.modalData.amountUSD;
    }
  }
}

function saveRefund() {
  const adId = state.modalData.id;
  const refundType = document.getElementById('refund-type').value;
  const refundAmount = parseFloat(document.getElementById('refund-amount').value) || 0;
  const refundStatus = document.getElementById('refund-status').value;
  
  const updates = {
    refundType,
    refundAmount: refundType !== 'None' ? refundAmount : 0,
    refundStatus: refundType !== 'None' ? refundStatus : undefined,
    status: refundType !== 'None' ? 'Canceled' : state.modalData.status,
    canceledBy: refundType !== 'None' ? state.currentUser?.id : state.modalData.canceledBy
  };
  
  updateRecord(state.ads, adId, updates);
  showNotification('Saved', `Refund ${refundType} applied`, refundType !== 'None' ? 'warning' : 'success');
  closeModal();
  render();
}

