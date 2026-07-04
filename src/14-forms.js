// ==========================================
// CUSTOMER SEARCH COMPONENT
// ==========================================

let selectedCustomerId = null;
let selectedCustomerByPhone = null;

function renderCustomerSearchDropdown(fieldId, selectedId = null) {
  const customers = getVisibleRecords(state.customers);
  selectedCustomerId = selectedId;
  
  // Get selected customer data if editing
  const selectedCustomer = selectedId ? customers.find(c => c.id === selectedId) : null;
  const searchValue = selectedCustomer ? selectedCustomer.name : '';
  const showConfirmation = selectedCustomer !== null;
  
  return `
    <div class="relative">
      <div class="flex items-start space-x-3">
        <div class="flex-1 relative">
          <div class="relative">
            <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input 
              type="text" 
              id="${fieldId}-search" 
              value="${Security.escapeHtml(searchValue)}"
              placeholder="Search by name or phone..." 
              class="w-full glass-input px-4 py-2 pl-10 rounded-xl"
              autocomplete="off"
              oninput="filterCustomerDropdown('${fieldId}')"
              onfocus="showCustomerDropdown('${fieldId}')"
            />
          </div>
          <input type="hidden" id="${fieldId}-id" value="${selectedId || ''}" required />
          
          <!-- Dropdown Results -->
          <div id="${fieldId}-dropdown" class="absolute z-10 w-full mt-2 glass-panel rounded-xl shadow-xl max-h-60 overflow-y-auto hidden">
            <div id="${fieldId}-results" class="p-2">
              ${customers.map(c => `
                <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectCustomer('${fieldId}', '${c.id}')">
                  <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
                  <div class="text-sm text-slate-500 mt-1 flex items-center">
                    <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
                    ${Security.escapeHtml((c.phones || []).join(', '))}
                  </div>
                  <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">
                    <i data-lucide="${c.platform === 'Facebook' ? 'facebook' : c.platform === 'WhatsApp' ? 'message-circle' : c.platform === 'Instagram' ? 'instagram' : 'phone'}" class="w-3 h-3 inline mr-1"></i>
                    ${Security.escapeHtml(c.platform || '')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        
        <!-- Selected Customer Confirmation (Right Side) -->
        <div id="${fieldId}-confirmation" class="w-72 p-4 glass-panel rounded-xl border-2 border-emerald-500 ${showConfirmation ? '' : 'hidden'}">
          <div class="flex items-start justify-between mb-2">
            <div class="flex items-center space-x-2">
              <i data-lucide="check-circle" class="w-5 h-5 text-emerald-600"></i>
              <span class="font-bold text-sm text-emerald-700 dark:text-emerald-400">Selected</span>
            </div>
            <button type="button" onclick="clearCustomerSelection('${fieldId}')" class="text-slate-400 hover:text-rose-600 transition-colors" title="Clear selection">
              <i data-lucide="x-circle" class="w-4 h-4"></i>
            </button>
          </div>
          <div class="flex items-start space-x-3">
            <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
              ${selectedCustomer ? selectedCustomer.name.charAt(0).toUpperCase() : 'C'}
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-bold text-slate-800 dark:text-white truncate" id="${fieldId}-selected-name">
                ${selectedCustomer ? Security.escapeHtml(selectedCustomer.name || '') : ''}
              </div>
              <div class="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center" id="${fieldId}-selected-phone">
                ${selectedCustomer ? `<i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>${Security.escapeHtml(selectedCustomer.phones?.[0] || 'No phone')}` : ''}
              </div>
              ${selectedCustomer && selectedCustomer.platform ? `
                <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">
                  ${Security.escapeHtml(selectedCustomer.platform)}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function filterCustomerDropdown(fieldId) {
  const searchInput = document.getElementById(`${fieldId}-search`);
  const searchTerm = searchInput.value.toLowerCase();
  const dropdown = document.getElementById(`${fieldId}-dropdown`);
  const results = document.getElementById(`${fieldId}-results`);
  
  const customers = getVisibleRecords(state.customers);
  const filtered = customers.filter(c => 
    c.name.toLowerCase().includes(searchTerm) ||
    c.phones.some(p => p.includes(searchTerm)) ||
    c.platform.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length > 0 && searchTerm) {
    results.innerHTML = filtered.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors" onclick="selectCustomer('${fieldId}', '${c.id}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-sm text-slate-500 mt-1">
          <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
          ${Security.escapeHtml((c.phones || []).join(', '))}
        </div>
        <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">${Security.escapeHtml(c.platform || '')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
    lucide.createIcons();
  } else if (!searchTerm) {
    results.innerHTML = customers.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors" onclick="selectCustomer('${fieldId}', '${c.id}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-sm text-slate-500 mt-1">
          <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
          ${Security.escapeHtml((c.phones || []).join(', '))}
        </div>
        <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">${Security.escapeHtml(c.platform || '')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
    lucide.createIcons();
  } else {
    dropdown.classList.add('hidden');
  }
}

function showCustomerDropdown(fieldId) {
  const dropdown = document.getElementById(`${fieldId}-dropdown`);
  dropdown.classList.remove('hidden');
  filterCustomerDropdown(fieldId);
}

function selectCustomer(fieldId, customerId) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  selectedCustomerId = customerId;
  
  // Update hidden field
  const idField = document.getElementById(`${fieldId}-id`);
  idField.value = customerId;
  
  // Update search input
  const searchInput = document.getElementById(`${fieldId}-search`);
  searchInput.value = customer.name;
  
  // Hide dropdown
  const dropdown = document.getElementById(`${fieldId}-dropdown`);
  dropdown.classList.add('hidden');
  
  // Show and update confirmation panel
  const confirmation = document.getElementById(`${fieldId}-confirmation`);
  confirmation.classList.remove('hidden');
  
  // Update confirmation content with full customer details
  const confirmationInner = confirmation.querySelector('div.flex.items-start.space-x-3') || confirmation;
  confirmationInner.innerHTML = `
    <div class="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
      ${customer.name.charAt(0).toUpperCase()}
    </div>
    <div class="flex-1 min-w-0">
      <div class="font-bold text-slate-800 dark:text-white truncate">${Security.escapeHtml(customer.name || '')}</div>
      <div class="text-xs text-slate-600 dark:text-slate-400 mt-1 flex items-center">
        <i data-lucide="phone" class="w-3 h-3 inline mr-1"></i>
        ${Security.escapeHtml((Array.isArray(customer.phones) && customer.phones.length > 0) ? customer.phones[0] : 'No phone')}
      </div>
      ${customer.platform ? `
        <div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1">
          ${Security.escapeHtml(customer.platform)}
        </div>
      ` : ''}
    </div>
  `;
  
  // Re-add close button
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'text-slate-400 hover:text-rose-600 transition-colors';
  closeBtn.setAttribute('onclick', `clearCustomerSelection('${fieldId}')`);
  closeBtn.title = 'Clear selection';
  closeBtn.innerHTML = '<i data-lucide="x-circle" class="w-4 h-4"></i>';
  
  const wrapper = confirmation.querySelector('div.flex.items-start.justify-between');
  if (wrapper) {
    wrapper.appendChild(closeBtn);
  }
  
  if (fieldId === 'ad-customer') {
    handleAdCustomerChange(customerId);
  }
  
  lucide.createIcons();
}

function clearCustomerSelection(fieldId) {
  selectedCustomerId = null;
  
  // Clear fields
  document.getElementById(`${fieldId}-search`).value = '';
  document.getElementById(`${fieldId}-id`).value = '';
  
  // Hide confirmation
  const confirmation = document.getElementById(`${fieldId}-confirmation`);
  confirmation.classList.add('hidden');
  
  // Show dropdown
  filterCustomerDropdown(fieldId);
}

// Click outside to close dropdown
document.addEventListener('click', function(e) {
  const dropdowns = document.querySelectorAll('[id$="-dropdown"]');
  dropdowns.forEach(dropdown => {
    if (!dropdown.contains(e.target) && !e.target.id.includes('-search')) {
      dropdown.classList.add('hidden');
    }
  });
});

// ==========================================
// RECEIPT MODAL HELPER FUNCTIONS
// ==========================================

function filterReceiptPhones() {
  const searchInput = document.getElementById('receipt-phone-search');
  const dropdown = document.getElementById('receipt-phone-dropdown');
  const searchTerm = searchInput.value.toLowerCase();
  
  const customers = getVisibleRecords(state.customers);
  const phoneCustomerMap = [];
  customers.forEach(c => {
    c.phones.forEach(phone => {
      phoneCustomerMap.push({ phone, customer: c });
    });
  });
  
  const filtered = phoneCustomerMap.filter(item => 
    item.phone.includes(searchTerm) ||
    item.customer.name.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length > 0 && searchTerm) {
    dropdown.innerHTML = filtered.map(item => `
      <div class="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer phone-option rounded transition-colors" data-phone="${Security.escapeHtml(item.phone)}" data-customer-id="${Security.escapeHtml(item.customer.id)}" onclick="selectReceiptPhone(this.dataset.phone, this.dataset.customerId)">
        <div class="text-sm font-medium">${Security.escapeHtml(item.phone)}</div>
        <div class="text-xs text-slate-500">${Security.escapeHtml(item.customer.name)} - ${Security.escapeHtml(item.customer.platform)}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  } else {
    dropdown.classList.add('hidden');
  }
}

function showReceiptPhoneDropdown() {
  filterReceiptPhones();
}

// ==========================================
// RECEIPT RENDER HELPERS
// ==========================================

function renderReceiptFinancials(payments, existingPayments, receiptDeliveryUsers) {
  // BUG FIX: Check if array exists and has elements before accessing
  if (!Array.isArray(existingPayments) || existingPayments.length === 0) {
    return '<div class="text-xs text-slate-400 p-4">No payments configured</div>';
  }
  
  const isSplit = existingPayments.length > 1;
  
  if (!isSplit) {
    const payment = existingPayments[0];
    // Single Payment Mode - Compact & Integrated
    return `
      <div id="receipt-payments-container" class="space-y-3">
        <div class="p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm payment-split-item">
          <!-- Header -->
          <div class="flex items-center space-x-2 mb-4 pb-3 border-b border-slate-100 dark:border-slate-700">
            <i data-lucide="credit-card" class="w-4 h-4 text-slate-500"></i>
            <span class="text-xs font-bold text-slate-500 uppercase">PAYMENT #1</span>
          </div>

          <div class="space-y-4">
            <!-- Payment Method & Amount Row -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Payment Method</label>
                <select class="payment-method w-full glass-input px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-indigo-500/20" onchange="onPaymentMethodChange(this)">
                  ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">Amount</label>
                <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-3 py-2 rounded-lg text-sm font-bold border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-indigo-500/20" value="${payment.amount || 0}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptTotals()" />
              </div>
            </div>

            <!-- Rates Row -->
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <label class="text-[10px] font-bold text-slate-500 uppercase mb-1.5 block">RATE 1</label>
                <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1.5 rounded text-xs font-medium text-center mb-2" value="${payment.rate || state.defaultExchangeRate}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
                <div class="text-center pt-2 border-t border-slate-200 dark:border-slate-700">
                  <div class="text-[10px] font-bold text-slate-400 mb-0.5">R1:</div>
                  <span class="payment-r1-display text-sm font-bold text-indigo-600">0.00 LYD</span>
                </div>
              </div>
              <div class="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <label class="text-[10px] font-bold text-slate-500 uppercase mb-1.5 block">RATE 2</label>
                <input type="text" inputmode="decimal" class="payment-rate2 w-full glass-input px-2 py-1.5 rounded text-xs font-medium text-center mb-2" value="${payment.rate2 !== undefined ? payment.rate2 : state.defaultExchangeRate}" placeholder="0" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
                <div class="text-center pt-2 border-t border-slate-200 dark:border-slate-700">
                  <div class="text-[10px] font-bold text-slate-400 mb-0.5">R2:</div>
                  <span class="payment-r2-display text-sm font-bold text-emerald-600">0.00 USD</span>
                </div>
              </div>
            </div>

            <!-- Hidden collection type for data consistency -->
            <input type="hidden" class="collection-type" value="${payment.collectionType || 'office'}" />

            <!-- Integrated Totals -->
            <div class="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 grid grid-cols-2 gap-4">
              <div>
                <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL PAID (LYD)</div>
                <div class="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div id="receipt-total-lyd" class="text-xl font-bold text-slate-800 dark:text-white">0.00</div>
                  <div class="text-[10px] font-bold text-slate-400 mt-1">LYD</div>
                </div>
              </div>
              <div>
                <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL ADS CREDIT (USD)</div>
                <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                  <div id="receipt-total-usd" class="text-xl font-bold text-emerald-600">$0.00</div>
                  <div class="text-[10px] text-emerald-600/70 mt-1 leading-tight">Sum of all converted payments (Excluding Amount 2)</div>
                </div>
              </div>
            </div>

            <!-- Footer Stats -->
            <div class="flex justify-between items-center pt-2 text-[10px] text-slate-400">
              <div>
                <div class="font-bold">Net Paid (After Fees):</div>
                <div id="receipt-net-paid" class="text-indigo-600 font-bold text-xs">0.00 LYD</div>
              </div>
              <div class="text-right">
                <div>Market Rate: <span id="receipt-market-rate" class="text-slate-600 dark:text-slate-300 font-bold">${state.defaultExchangeRate.toFixed(2)}</span></div>
                <div>Actual Avg Rate: <span id="receipt-avg-rate" class="text-emerald-600 font-bold">0.0000</span></div>
              </div>
            </div>
            
            <!-- Savings/Extra Display -->
            <div id="receipt-savings-display" class="mt-3 p-2 rounded-lg text-center text-sm font-bold hidden">
              <!-- Will be populated dynamically -->
            </div>

          </div>
        </div>
      </div>
    `;
  } else {
    // Split Payment Mode - All Payments First, Then Totals at Bottom
    const paymentCardsHTML = existingPayments.map((payment, idx) => `
      <div class="p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm payment-split-item">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center space-x-2">
            <i data-lucide="credit-card" class="w-4 h-4 text-slate-400"></i>
            <span class="text-xs font-bold text-slate-500 uppercase">PAYMENT #${idx + 1}</span>
          </div>
          <button type="button" onclick="removeReceiptPaymentSplit(this)" class="text-rose-500 hover:text-rose-700 transition-colors">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Payment Method</label>
              <select class="payment-method w-full glass-input px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600" onchange="onPaymentMethodChange(this)">
                ${PAYMENT_METHODS.map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${m}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Amount</label>
              <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-3 py-2 rounded-lg text-sm font-bold border border-slate-200 dark:border-slate-600" value="${payment.amount || 0}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptTotals()" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              <label class="text-[10px] font-bold text-slate-500 uppercase mb-1 block">RATE 1</label>
              <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1 rounded text-xs mb-1" value="${payment.rate || state.defaultExchangeRate}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
              <div class="text-center pt-1 border-t border-slate-200 dark:border-slate-700">
                <span class="text-[9px] font-bold text-slate-400">R1: </span>
                <span class="payment-r1-display text-xs font-bold text-indigo-600">0.00 LYD</span>
              </div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              <label class="text-[10px] font-bold text-slate-500 uppercase mb-1 block">RATE 2</label>
              <input type="text" inputmode="decimal" class="payment-rate2 w-full glass-input px-2 py-1 rounded text-xs mb-1" value="${payment.rate2 !== undefined ? payment.rate2 : state.defaultExchangeRate}" placeholder="0" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
              <div class="text-center pt-1 border-t border-slate-200 dark:border-slate-700">
                <span class="text-[9px] font-bold text-slate-400">R2: </span>
                <span class="payment-r2-display text-xs font-bold text-emerald-600">0.00 USD</span>
              </div>
            </div>
          </div>

          <!-- Hidden collection type for data consistency -->
          <input type="hidden" class="collection-type" value="${payment.collectionType || 'office'}" />
        </div>
      </div>
    `).join('');

    return `
      <!-- All Payment Cards First -->
      <div id="receipt-payments-container" class="space-y-3">
        ${paymentCardsHTML}
      </div>

      <!-- Totals Section at Bottom (After All Payments) -->
      <div id="receipt-totals-section" class="mt-4 pt-4 border-t-2 border-slate-200 dark:border-slate-700">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL PAID (LYD)</div>
            <div class="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <div id="receipt-total-lyd" class="text-xl font-bold text-slate-800 dark:text-white">0.00</div>
              <div class="text-[10px] font-bold text-slate-400 mt-1">LYD</div>
            </div>
          </div>
          <div>
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">TOTAL ADS CREDIT (USD)</div>
            <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
              <div id="receipt-total-usd" class="text-xl font-bold text-emerald-600">$0.00</div>
              <div class="text-[10px] text-emerald-600/70 mt-1">Sum of all R2 values</div>
            </div>
          </div>
        </div>
        
        <div class="mt-3 px-4 py-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
          <div class="flex justify-between items-center text-xs">
            <div>
              <span class="text-slate-500 font-bold">Net Paid:</span> 
              <span id="receipt-net-paid" class="text-indigo-600 font-bold ml-1">0.00 LYD</span>
            </div>
            <div>
              <span class="text-slate-500 font-bold">Market Rate:</span> 
              <span id="receipt-market-rate" class="text-slate-600 font-bold ml-1">${state.defaultExchangeRate.toFixed(2)}</span>
            </div>
            <div>
              <span class="text-slate-500 font-bold">Avg Rate:</span> 
              <span id="receipt-avg-rate" class="text-emerald-600 font-bold ml-1">0.0000</span>
            </div>
          </div>
          
          <!-- Savings/Extra Display -->
          <div id="receipt-savings-display" class="mt-2 p-2 rounded-lg text-center text-sm font-bold hidden">
            <!-- Will be populated dynamically -->
          </div>
        </div>
      </div>
    `;
  }
}

// Function to collect current payment data from DOM
function getReceiptPaymentData() {
  const container = document.getElementById('receipt-payments-container');
  if (!container) return [];
  
  const items = container.querySelectorAll('.payment-split-item');
  const payments = [];
  
  items.forEach(item => {
    const rate2Value = item.querySelector('.payment-rate2').value;
    payments.push({
      method: item.querySelector('.payment-method').value,
      amount: parseFloat(item.querySelector('.payment-amount').value) || 0,
      rate: parseFloat(item.querySelector('.payment-rate1').value) || state.defaultExchangeRate,
      rate2: rate2Value !== '' && rate2Value !== null ? parseFloat(rate2Value) : state.defaultExchangeRate,
      collectionType: item.querySelector('.collection-type').value,
      deliveryPersonId: item.querySelector('.delivery-person')?.value || ''
    });
  });
  
  return payments;
}

// Add new payment split
function addReceiptPaymentSplit() {
  const currentPayments = getReceiptPaymentData();
  // BUG FIX: Check if PAYMENT_METHODS array exists and has elements
  if (!Array.isArray(PAYMENT_METHODS) || PAYMENT_METHODS.length === 0) {
    showNotification('Error', 'Payment methods not configured', 'error');
    return;
  }
  const defaultRate1 = getDefaultRate1(PAYMENT_METHODS[0]);
  currentPayments.push({ 
    method: PAYMENT_METHODS[0], 
    amount: 0, 
    rate: defaultRate1, 
    rate2: state.defaultExchangeRate, 
    collectionType: 'office', 
    deliveryPersonId: '' 
  });
  
  // Re-render the financial section
  const financialSection = document.getElementById('receipt-financial-section');
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
  
  if (financialSection) {
    financialSection.innerHTML = renderReceiptFinancials(currentPayments, currentPayments, deliveryUsers);
    
    // Refresh icons and update totals
    if (window.lucide) lucide.createIcons();
    updateReceiptTotals();
    updateAutoSerialForReceipt();
  }
}

// Remove payment split
function removeReceiptPaymentSplit(btn) {
  const item = btn.closest('.payment-split-item');
  if (item) {
    // If it's the last one in a list of > 1, we need to re-render to switch back to compact mode
    const container = document.getElementById('receipt-payments-container');
    const count = container.querySelectorAll('.payment-split-item').length;
    
    if (count <= 2) { // Removing one will leave 1 => switch to compact
      item.remove();
      const currentPayments = getReceiptPaymentData(); // Get remaining data
      
      const financialSection = document.getElementById('receipt-financial-section');
      const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      
      if (financialSection) {
        financialSection.innerHTML = renderReceiptFinancials(currentPayments, currentPayments, deliveryUsers);
        if (window.lucide) lucide.createIcons();
        updateReceiptTotals();
        updateAutoSerialForReceipt();
      }
    } else {
      // Just remove it normally
      item.remove();
      updateReceiptTotals();
      updateAutoSerialForReceipt();
    }
  }
}

function selectReceiptPhone(phone, customerId) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  // Set customer ID
  document.getElementById('receipt-customer-id').value = customerId;
  
  // Update phone search
  document.getElementById('receipt-phone-search').value = phone;
  
  // Update customer name display
  document.getElementById('receipt-customer-name').value = customer.name;
  
  // Hide dropdown
  document.getElementById('receipt-phone-dropdown').classList.add('hidden');
}

// ==========================================
// PAGE CUSTOMER SELECTION HELPERS
// ==========================================

function filterPageCustomers() {
  const searchInput = document.getElementById('page-customer-search');
  const dropdown = document.getElementById('page-customer-dropdown');
  const searchTerm = searchInput?.value.toLowerCase() || '';
  
  const customers = getVisibleRecords(state.customers);
  
  const filtered = customers.filter(c => 
    c.name.toLowerCase().includes(searchTerm) ||
    c.phones.some(p => p.includes(searchTerm)) ||
    c.platform.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length > 0 && searchTerm) {
    dropdown.innerHTML = filtered.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectPageCustomer('${c.id}', '${isAdminRole(state.currentUser?.role)}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || 'No phone')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  } else {
    dropdown.classList.add('hidden');
  }
}

function showPageCustomerDropdown() {
  const dropdown = document.getElementById('page-customer-dropdown');
  const customers = getVisibleRecords(state.customers);
  
  if (customers.length > 0) {
    dropdown.innerHTML = customers.map(c => `
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" onclick="selectPageCustomer('${c.id}', '${isAdminRole(state.currentUser?.role)}')">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || 'No phone')}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  }
}

function selectPageCustomer(customerId, isAdmin) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  const container = document.getElementById('page-selected-customers');
  const noCustomersMsg = document.getElementById('page-no-customers');
  const dropdown = document.getElementById('page-customer-dropdown');
  const searchInput = document.getElementById('page-customer-search');
  
  // Check if already selected
  const existing = container.querySelector(`[data-customer-id="${customerId}"]`);
  if (existing) {
    showNotification('Already Selected', 'This customer is already linked to this page', 'info');
    dropdown.classList.add('hidden');
    return;
  }
  
  // Check if non-admin trying to add multiple
  const currentCount = container.querySelectorAll('.page-customer-item').length;
  if (isAdmin === 'false' && currentCount >= 1) {
    showNotification('Limit Reached', 'You can only link one customer. Remove the existing customer first.', 'error');
    dropdown.classList.add('hidden');
    return;
  }
  
  // Add customer item
  const customerItem = document.createElement('div');
  customerItem.className = 'flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded-lg border border-indigo-200 dark:border-indigo-800 page-customer-item';
  customerItem.setAttribute('data-customer-id', customerId);
  customerItem.innerHTML = `
    <div>
      <div class="font-medium text-sm text-slate-800 dark:text-white">${Security.escapeHtml(customer.name || '')}</div>
      <div class="text-xs text-slate-500">${Security.escapeHtml(customer.platform || '')}</div>
    </div>
    <button type="button" onclick="removePageCustomer('${customerId}')" class="text-rose-500 hover:text-rose-700">
      <i data-lucide="x-circle" class="w-4 h-4"></i>
    </button>
  `;
  
  container.insertBefore(customerItem, noCustomersMsg);
  
  // Refresh icons
  if (window.lucide) {
    lucide.createIcons();
  }
  
  // Hide no customers message
  noCustomersMsg.classList.add('hidden');
  
  // Clear search
  searchInput.value = '';
  dropdown.classList.add('hidden');
  
  // Show multi-customer warning for admin
  const newCount = container.querySelectorAll('.page-customer-item').length;
  if (isAdmin === 'true' && newCount > 1) {
    const warning = document.getElementById('page-multi-customer-warning');
    if (warning) {
      warning.classList.remove('hidden');
    }
  }
}

function removePageCustomer(customerId) {
  const container = document.getElementById('page-selected-customers');
  const noCustomersMsg = document.getElementById('page-no-customers');
  const item = container.querySelector(`[data-customer-id="${customerId}"]`);
  
  if (item) {
    item.remove();
  }
  
  // Check if no customers left
  const remaining = container.querySelectorAll('.page-customer-item').length;
  if (remaining === 0) {
    noCustomersMsg.classList.remove('hidden');
  }
  
  // Hide multi-customer warning if down to 1 or less
  if (remaining <= 1) {
    const warning = document.getElementById('page-multi-customer-warning');
    if (warning) {
      warning.classList.add('hidden');
    }
  }
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  const pageDropdown = document.getElementById('page-customer-dropdown');
  const pageSearch = document.getElementById('page-customer-search');
  
  if (pageDropdown && pageSearch && 
      !pageDropdown.contains(e.target) && 
      !pageSearch.contains(e.target)) {
    pageDropdown.classList.add('hidden');
  }
});

function setPaymentCollection(button, type) {
  const paymentItem = button.closest('.payment-split-item');
  const collectionInput = paymentItem.querySelector('.collection-type');
  collectionInput.value = type;
  
  // Update button styles
  const buttons = paymentItem.querySelectorAll('.collection-btn');
  buttons.forEach(btn => {
    const btnType = btn.getAttribute('onclick').match(/'(\w+)'/)[1];
    if (btnType === type) {
      btn.className = 'collection-btn px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wide transition-all bg-white border-2 border-indigo-600 text-indigo-700 shadow-sm';
    } else {
      btn.className = 'collection-btn px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wide transition-all bg-slate-100 dark:bg-slate-700 text-slate-500 border-2 border-transparent';
    }
  });
  
  // Show/hide delivery person selector
  let deliverySelect = paymentItem.querySelector('.delivery-person');
  
  if (type === 'delivery') {
    // If delivery selected and no dropdown exists, create it
    if (!deliverySelect) {
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
      if (deliveryUsers.length > 0) {
        const selectHtml = `
          <select class="delivery-person w-full glass-input px-3 py-2 rounded-lg text-sm mt-2 border border-slate-200 dark:border-slate-700">
            <option value="">Select delivery person...</option>
            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
          </select>
        `;
        const collectionDiv = paymentItem.querySelector('.collection-type').closest('div');
        collectionDiv.insertAdjacentHTML('beforeend', selectHtml);
      }
    } else {
      deliverySelect.style.display = 'block';
    }
  } else {
    // Hide delivery person selector if not delivery
    if (deliverySelect) {
      deliverySelect.style.display = 'none';
    }
  }
}

// REMOVED DUPLICATE addReceiptPaymentSplit - correct version is defined earlier at line ~2738
// This duplicate was causing layout issues by not restructuring the totals section

// Get default Rate 1 based on payment method
function getDefaultRate1(paymentMethod) {
  const zeroRateMethods = ['Bank Transfer', 'Bank Transfer (LYD)', 'Bank Transfer (USD)', 'Sadad', 'USDT', 'Cash (USD)', 'LTT'];
  const oneRateMethods = ['Cash (LYD)', 'Transfer Office'];
  
  if (zeroRateMethods.includes(paymentMethod)) return 0;
  if (oneRateMethods.includes(paymentMethod)) return 1;
  if (paymentMethod === 'Libyana') return 0.70;
  if (paymentMethod === 'Madar') return 0.75;
  
  return state.defaultExchangeRate; // Default for others
}

// Check if Rate 2 should be zero for this payment method
function shouldRate2BeZero(paymentMethod) {
  const zeroRate2Methods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  return zeroRate2Methods.includes(paymentMethod);
}

// Payment methods that get auto-serial numbers (S-prefix: S1, S2, S3...)
const AUTO_SERIAL_PAYMENT_METHODS = ['LTT', 'Libyana', 'Madar'];
const AUTO_SERIAL_PREFIX = 'S'; // Prefix for auto-generated serial numbers

// Get the next serial number for auto-serial payment methods (returns S1, S2, S3...)
function getNextAutoSerialNumber(paymentMethod) {
  if (!AUTO_SERIAL_PAYMENT_METHODS.includes(paymentMethod)) return null;
  
  // Find all receipts that use ANY of the auto-serial payment methods (LTT, Libyana, Madar share the same sequence)
  const receipts = getVisibleRecords(state.receipts);
  let maxSerialNumber = 0;
  
  receipts.forEach(receipt => {
    // Check if this receipt uses ANY of the auto-serial payment methods
    const receiptPaymentMethod = receipt.paymentMethod || '';
    const payments = receipt.payments || [];
    const usesAutoSerialMethod = AUTO_SERIAL_PAYMENT_METHODS.includes(receiptPaymentMethod) || 
                                  payments.some(p => AUTO_SERIAL_PAYMENT_METHODS.includes(p.method));
    
    if (usesAutoSerialMethod && receipt.serialNumber) {
      const serial = String(receipt.serialNumber).trim();
      // Extract number from S-prefixed serial (S1, S2, etc.) or plain number (legacy: 1, 2, etc.)
      let serialNum = 0;
      if (serial.toUpperCase().startsWith(AUTO_SERIAL_PREFIX)) {
        // New format: S1, S2, S3...
        serialNum = parseInt(serial.substring(AUTO_SERIAL_PREFIX.length), 10);
      } else {
        // Legacy format: plain number (1, 2, 3...)
        serialNum = parseInt(serial, 10);
      }
      if (!isNaN(serialNum) && serialNum > maxSerialNumber) {
        maxSerialNumber = serialNum;
      }
    }
  });
  
  // Return with S prefix: S1, S2, S3...
  return `${AUTO_SERIAL_PREFIX}${maxSerialNumber + 1}`;
}

// Check if a serial number is an auto-generated S-serial (S1, S2, etc.)
function isAutoSerialNumber(serial) {
  if (!serial) return false;
  const s = String(serial).trim().toUpperCase();
  return s.startsWith(AUTO_SERIAL_PREFIX) && /^S\d+$/.test(s);
}

// Handle payment method change
function onPaymentMethodChange(selectElement) {
  const paymentItem = selectElement.closest('.payment-split-item');
  const paymentMethod = selectElement.value;
  
  // Auto-set Rate 1 based on payment method
  const rate1Input = paymentItem.querySelector('.payment-rate1');
  const defaultRate1 = getDefaultRate1(paymentMethod);
  rate1Input.value = defaultRate1.toFixed(2);
  
  // Handle Rate 2
  const rate2Input = paymentItem.querySelector('.payment-rate2');
  const zeroR2Methods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  
  if (zeroR2Methods.includes(paymentMethod)) {
    // For USDT, Bank Transfer (USD), Cash (USD): R2 calculation is disabled
    // But we still allow the user to enter a rate (it just won't be used in R2 calculation)
    // Set to 0 to indicate no R2 will be calculated
    rate2Input.value = '0';
  } else if (parseFloat(rate2Input.value) === 0 || !rate2Input.value) {
    // If it was zero and now it's a normal method, set to default exchange rate
    rate2Input.value = state.defaultExchangeRate.toFixed(2);
  }
  
  // Auto-set serial number for LTT, Libyana, Madar payment methods
  const serialInput = document.getElementById('receipt-serial');
  if (AUTO_SERIAL_PAYMENT_METHODS.includes(paymentMethod)) {
    if (serialInput && !serialInput.value) {
      const nextSerial = getNextAutoSerialNumber(paymentMethod);
      if (nextSerial) {
        serialInput.value = nextSerial;
        // Make field read-only and style it
        serialInput.readOnly = true;
        serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
        serialInput.title = `Auto-generated for ${paymentMethod}`;
        // Show notification about auto-generated serial
        showNotification('Auto Serial', `Receipt number auto-set to ${nextSerial} for ${paymentMethod}`, 'info');
      }
    } else if (serialInput) {
      // If already has value and is auto-serial method, keep it locked
      serialInput.readOnly = true;
      serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
      serialInput.title = `Auto-generated for ${paymentMethod}`;
    }
  }
  
  // Check if we need to update the serial lock state based on all payment methods
  updateSerialLockState();
  
  // Update totals
  updateReceiptTotals();
}

// Helper function to always round UP to 2 decimal places
// This ensures any value with decimals beyond 2 places rounds up
// Example: 90.100143062 becomes 90.11, not 90.10
function ceilingRound(value) {
  if (value === 0 || !value || isNaN(value)) return 0;
  // Always round up: multiply by 100, use Math.ceil, then divide by 100
  // This ensures 90.10000001 becomes 90.11
  const result = Math.ceil(value * 100) / 100;
  return result;
}

// Auto-update serial number for receipts with LTT, Libyana, or Madar payment methods
function updateAutoSerialForReceipt() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return;
  
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let autoSerialMethod = null;
  
  // Check if any payment method requires auto-serial
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    if (methodSelect && AUTO_SERIAL_PAYMENT_METHODS.includes(methodSelect.value)) {
      autoSerialMethod = methodSelect.value;
    }
  });
  
  if (autoSerialMethod && !serialInput.value) {
    const nextSerial = getNextAutoSerialNumber(autoSerialMethod);
    if (nextSerial) {
      serialInput.value = nextSerial;
      // Make field read-only
      serialInput.readOnly = true;
      serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
      serialInput.title = `Auto-generated for ${autoSerialMethod}`;
    }
  }
  
  // Update lock state
  updateSerialLockState();
}

// Update serial field lock state based on payment methods
function updateSerialLockState() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return;
  
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let hasAutoSerialMethod = false;
  let autoSerialMethod = null;
  
  // Check if any payment method requires auto-serial
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    if (methodSelect && AUTO_SERIAL_PAYMENT_METHODS.includes(methodSelect.value)) {
      hasAutoSerialMethod = true;
      autoSerialMethod = methodSelect.value;
    }
  });
  
  if (hasAutoSerialMethod) {
    // Lock the serial field
    serialInput.readOnly = true;
    serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
    serialInput.title = `Auto-generated for ${autoSerialMethod}`;
  } else {
    // Unlock the serial field if no auto-serial methods are present
    serialInput.readOnly = false;
    serialInput.classList.remove('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
    serialInput.title = '';
  }
}

function updateReceiptTotals() {
  const paymentItems = document.querySelectorAll('.payment-split-item');
  
  let totalR1 = 0; // Total PAID (LYD) - sum of all R1 values
  let totalR2 = 0; // Total ADS CREDIT (USD) - sum of all R2 values
  
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    const amountInput = item.querySelector('.payment-amount');
    const rate1Input = item.querySelector('.payment-rate1');
    const rate2Input = item.querySelector('.payment-rate2');
    const r1Display = item.querySelector('.payment-r1-display');
    const r2Display = item.querySelector('.payment-r2-display');
    
    if (!methodSelect || !amountInput || !rate1Input || !rate2Input) return;
    
    const paymentMethod = methodSelect.value;
    const amount = parseFloat(amountInput.value) || 0;
    const rate1 = parseFloat(rate1Input.value) || 0;
    const rate2 = parseFloat(rate2Input.value) || 0;
    
    // Calculate R1 = Amount × Rate 1
    const r1 = amount * rate1;
    
    // Calculate R2 based on payment method:
    // - For USDT, Bank Transfer (USD), Cash (USD): R2 = R1 ÷ Rate 2
    // - For all other methods: R2 = Amount ÷ Rate 2
    let r2 = 0;
    const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
    
    if (rate2 > 0) {
      if (usdBasedMethods.includes(paymentMethod)) {
        // USD-based methods: R2 = R1 / Rate 2
        // BUG FIX: Prevent division by zero
        r2 = rate2 > 0 ? (r1 / rate2) : 0;
      } else {
        // Normal methods: R2 = Amount / Rate 2
        // BUG FIX: Prevent division by zero
        r2 = rate2 > 0 ? (amount / rate2) : 0;
      }
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2);
    }
    
    // Update displays
    if (r1Display) r1Display.textContent = r1.toFixed(2) + ' LYD';
    if (r2Display) r2Display.textContent = r2.toFixed(2) + ' USD';
    
    // Add to totals
    totalR1 += r1;
    totalR2 += r2;
  });
  
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  if (totalR2 % 1 !== 0) {
    totalR2 = totalR2 + 0.01;
  }
  
  // Update total displays
  const totalLydEl = document.getElementById('receipt-total-lyd');
  const totalUsdEl = document.getElementById('receipt-total-usd');
  const avgRateEl = document.getElementById('receipt-avg-rate');
  const netPaidEl = document.getElementById('receipt-net-paid');
  const savingsEl = document.getElementById('receipt-savings-display');
  
  if (totalLydEl) totalLydEl.textContent = totalR1.toFixed(2);
  if (totalUsdEl) totalUsdEl.textContent = '$' + totalR2.toFixed(2);
  
  // Calculate average rate (Total LYD / Total USD)
  const avgRate = totalR2 > 0 ? (totalR1 / totalR2) : 0;
  if (avgRateEl) avgRateEl.textContent = avgRate.toFixed(4);
  
  // Calculate net paid (total - processing fee if any)
  const processingFee = BUSINESS_CONFIG.RECEIPT_PROCESSING_FEE_LYD || 0;
  const netPaid = totalR1 - processingFee;
  if (netPaidEl) netPaidEl.textContent = netPaid.toFixed(2) + ' LYD';
  
  // Calculate savings or extra paid compared to market rate
  const marketRate = state.defaultExchangeRate;
  
  if (savingsEl && totalR2 > 0) {
    // What customer would have paid at market rate
    const marketValue = totalR2 * marketRate;
    // Difference: positive = customer saved, negative = customer paid extra
    const difference = marketValue - totalR1;
    
    if (Math.abs(difference) < 0.01) {
      // No significant difference
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
      savingsEl.innerHTML = `<i data-lucide="equal" class="w-4 h-4 inline mr-1"></i> Paid at market rate`;
      savingsEl.classList.remove('hidden');
    } else if (difference > 0) {
      // Customer saved money (paid less than market rate)
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
      savingsEl.innerHTML = `<i data-lucide="trending-down" class="w-4 h-4 inline mr-1"></i> Customer Saved: <span class="text-emerald-600 font-bold">${Security.escapeHtml(difference.toFixed(2))} LYD</span>`;
      savingsEl.classList.remove('hidden');
    } else {
      // Customer paid extra (paid more than market rate)
      const extra = Math.abs(difference);
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400';
      savingsEl.innerHTML = `<i data-lucide="trending-up" class="w-4 h-4 inline mr-1"></i> Paid Extra: <span class="text-rose-600 font-bold">${Security.escapeHtml(extra.toFixed(2))} LYD</span>`;
      savingsEl.classList.remove('hidden');
    }
    
    // Refresh icons
    if (window.lucide) lucide.createIcons();
  } else if (savingsEl) {
    savingsEl.classList.add('hidden');
  }
}

// Helper: compute totals from current payment rows (shared use)
function getPaymentTotalsFromDom() {
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let totalR1 = 0;
  let totalR2 = 0;
  paymentItems.forEach((item) => {
    const methodSelect = item.querySelector('.payment-method');
    const amountInput = item.querySelector('.payment-amount');
    const rate1Input = item.querySelector('.payment-rate1');
    const rate2Input = item.querySelector('.payment-rate2');
    if (!methodSelect || !amountInput || !rate1Input || !rate2Input) return;
    const paymentMethod = methodSelect.value;
    const amount = parseFloat(amountInput.value) || 0;
    const rate1 = parseFloat(rate1Input.value) || 0;
    const rate2 = parseFloat(rate2Input.value) || 0;
    const r1 = amount * rate1;
    const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
    let r2 = 0;
    if (rate2 > 0) {
      r2 = usdBasedMethods.includes(paymentMethod) ? (r1 / rate2) : (amount / rate2);
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2);
    }
    totalR1 += r1;
    totalR2 += r2;
  });
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  if (totalR2 % 1 !== 0) {
    totalR2 = totalR2 + 0.01;
  }
  return { totalR1, totalR2 };
}

/**
 * Save a receipt from the modal form (create new or update existing).
 * 
 * This is the MAIN RECEIPT SAVE LOGIC - handles all receipt types:
 *   - Regular receipts (Paid, Not Paid - Office collection)
 *   - Delivery receipts (Not Paid - Delivery collection)
 *   - Temp delivery receipts (D1, D2, etc. assigned to drivers)
 *   - Refund receipts
 *   - Lost/Canceled receipts
 * 
 * Critical Validations:
 *   1. Customer must be selected
 *   2. Receipt number required (except for Not Paid status)
 *   3. Receipt number must be unique and valid (digits only, no leading zeros)
 *   4. Temp delivery receipts (D#) must have a driver assigned
 *   5. Delivery fee required for delivery receipts
 *   6. Amounts must be positive numbers
 * 
 * Special Flows:
 *   - Not Paid + Delivery: Creates temp receipt (D#) assigned to driver
 *   - Server generates D# if not provided (multi-user safe)
 *   - Paid + Delivery: Normal receipt with driver info (already collected)
 * 
 * Server Sync:
 *   - Uses apiCreateEntity() for new receipts
 *   - Server returns authoritative data (including generated D# numbers)
 *   - Frontend shows success only after server confirmation
 * 
 * Error Handling:
 *   - Validation errors: Show toast + highlight field
 *   - Server errors: Show detailed message from server
 *   - Rollback not needed (optimistic update only after server confirms)
 */
async function saveReceiptFromModal() {
  try {
  const customerId = document.getElementById('receipt-customer-id').value;
  if (!customerId) {
    showNotification('Error', 'Please select a customer by phone', 'error');
    return;
  }
  
  // Collect all payment splits
  const paymentItems = document.querySelectorAll('.payment-split-item');
  const payments = [];
  
  paymentItems.forEach(item => {
    const method = item.querySelector('.payment-method').value;
    const amount = parseFloat(item.querySelector('.payment-amount').value) || 0;
    const rate = parseFloat(item.querySelector('.payment-rate1').value) || state.defaultExchangeRate;
    const rate2 = parseFloat(item.querySelector('.payment-rate2').value) || 0;
    const collectionType = item.querySelector('.collection-type').value;
    const deliveryPersonSelect = item.querySelector('.delivery-person');
    const deliveryPersonId = deliveryPersonSelect ? deliveryPersonSelect.value : '';
    
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
  
  // Calculate totals using the same logic as updateReceiptTotals
  // R1 = amount * rate1, R2 depends on payment method
  const usdBasedMethods = ['USDT', 'Bank Transfer (USD)', 'Cash (USD)'];
  
  let totalR1 = 0; // Total PAID (LYD)
  let totalR2 = 0; // Total ADS CREDIT (USD)
  
  payments.forEach(p => {
    const r1 = p.amount * p.rate;
    let r2 = 0;
    
    if (p.rate2 > 0) {
      if (usdBasedMethods.includes(p.method)) {
        // USD-based methods: R2 = R1 / Rate 2
        r2 = r1 / p.rate2;
      } else {
        // Normal methods: R2 = Amount / Rate 2
        r2 = p.amount / p.rate2;
      }
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2);
    }
    
    totalR1 += r1;
    totalR2 += r2;
  });
  
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  if (totalR2 % 1 !== 0) {
    totalR2 = totalR2 + 0.01;
  }
  
  const totalLYD = totalR1;
  const totalUSD = totalR2;
  // BUG FIX: Prevent division by zero (defense in depth, already checked totalUSD > 0)
  const avgRate = (totalUSD > 0 && totalLYD > 0) ? (totalLYD / totalUSD) : state.defaultExchangeRate;
  const status = document.getElementById('receipt-status').value || 'Paid';
  const photos = state.tempReceiptPhotos || [];
  
  // Collect status detail fields
  const statusDetail = {
    paidCollection: document.getElementById('paid-collection-value')?.value || 'office',
    paidDeliveryPersonId: document.getElementById('paid-delivery-person')?.value || '',
    notPaidCollection: document.getElementById('notpaid-collection-value')?.value || 'office',
    allowSerialOverride: document.getElementById('status-not-paid-admin-override')?.checked || false,
    refundAction: document.getElementById('status-cancel-refund-action')?.value || '',
    refundStatus: document.getElementById('status-cancel-refund-status')?.value || '',
    lostResolution: document.getElementById('status-lost-resolution')?.value || ''
  };

  const notPaidCollection = String(statusDetail.notPaidCollection || '');
  const isTempDelivery = status === 'Not Paid' && notPaidCollection === 'delivery';
  
  // Enforce Not Paid rules
  if (status === 'Not Paid') {
    if (!statusDetail.notPaidCollection) {
      showNotification('Validation', 'Select how the customer will pay (shop or delivery).', 'error');
      return;
    }
    if (!isCurrentUserAdmin()) {
      statusDetail.allowSerialOverride = false;
      const serialInput = document.getElementById('receipt-serial');
      if (serialInput && !isTempDelivery) serialInput.value = '';
    }
  }
  
  // Enforce Cancel rules
  if (status === 'Canceled') {
    if (!statusDetail.refundAction) {
      showNotification('Validation', 'Select a cancellation outcome.', 'error');
      return;
    }
    if (statusDetail.refundAction === 'full' || statusDetail.refundAction === 'partial') {
      if (!statusDetail.refundStatus) {
        statusDetail.refundStatus = 'pending';
      }
    } else {
      statusDetail.refundStatus = '';
    }
  }
  
  // Lost rules
  if (status === 'Lost' && !statusDetail.lostResolution) {
    showNotification('Validation', 'Select lost resolution (empty or paid).', 'error');
    return;
  }
  
  // Validate receipt number
  const serialNumber = document.getElementById('receipt-serial').value.trim();
  const serialInputEl = document.getElementById('receipt-serial');
  const serialErrEl = document.getElementById('receipt-serial-error');

  // Temp delivery receipts must have a D{n} temporary number.
  if (isTempDelivery) {
    // In server mode, the backend generates tempReceiptNo safely, so it's OK to be empty before save.
    if (!serialNumber && !isServerModeEnabled()) {
      showNotification('Validation', 'Temporary delivery receipt number is missing. Please re-select Delivery or reopen the receipt form.', 'error');
      return;
    }
    if (serialNumber && !isTempDeliveryReceiptNo(serialNumber)) {
      showNotification('Validation', 'Temporary receipt number must look like D12, D13, ...', 'error');
      return;
    }
  }

  // Require receipt number for any status except "Not Paid"
  if (status !== 'Not Paid' && !serialNumber) {
    if (serialErrEl) {
      serialErrEl.innerHTML = '<i data-lucide="alert-circle" class="w-3 h-3 inline mr-1"></i>' +
        (state.language === 'ar' ? 'رقم الوصل مطلوب (إلا إذا كانت الحالة: غير مدفوع)' : 'Receipt number is required (unless status is Not Paid)');
      serialErrEl.classList.remove('hidden');
    }
    if (serialInputEl) {
      serialInputEl.classList.add('border-rose-500', 'focus:ring-rose-500/20', 'animate-shake');
      setTimeout(() => serialInputEl.classList.remove('animate-shake'), 300);
      serialInputEl.focus();
    }
    if (window.lucide) lucide.createIcons();
    showNotification('Validation', state.language === 'ar'
      ? 'لا يمكن حفظ الوصل بدون رقم عندما تكون الحالة (مدفوع/ملغي/ضائع).'
      : 'You cannot save without a receipt number when status is Paid/Canceled/Lost.', 'error');
    return;
  }
  
  if (serialNumber) {
    // Temp delivery receipt uniqueness + format
    if (isTempDelivery) {
      const existingTemp = state.receipts.find(r =>
        !r._deleted &&
        r.id !== (state.modalData ? state.modalData.id : null) &&
        (String(r.tempReceiptNo || '').trim() === serialNumber || String(r.serialNumber || '').trim() === serialNumber || String(r.finalReceiptNo || '').trim() === serialNumber)
      );
      if (existingTemp) {
        showNotification('Duplicate Temp Receipt', `Temporary receipt number "${serialNumber}" already exists. Please reopen the receipt form to generate a new one.`, 'error');
        return;
      }
    }

    // Check if it's a valid receipt number:
    // - Regular receipts: digits only, no leading zeros (123, 456, etc.)
    // - Auto-serial receipts (LTT/Libyana/Madar): S-prefix + digits (S1, S2, S3, etc.)
    const isAutoSerial = isAutoSerialNumber(serialNumber);
    if (!isTempDelivery && !isAutoSerial && !/^\d+$/.test(serialNumber)) {
      showNotification('Invalid Receipt Number', 'Receipt number must contain only digits (0-9) or be S-prefixed (S1, S2) for LTT/Libyana/Madar', 'error');
      return;
    }
    
    // Check if it starts with zero (only for non-auto-serial receipts)
    if (!isTempDelivery && !isAutoSerial && serialNumber.startsWith('0')) {
      showNotification('Invalid Receipt Number', 'Receipt number cannot start with zero', 'error');
      return;
    }
    
    // Check for duplicates (excluding current record if editing)
    const existingReceipt = isTempDelivery ? null : state.receipts.find(receipt => 
      receipt.serialNumber === serialNumber && 
      receipt.id !== (state.modalData ? state.modalData.id : null) &&
      !receipt._deleted
    );
    
    if (existingReceipt) {
      const customer = state.customers.find(c => c.id === existingReceipt.customerId);
      const customerName = customer ? customer.name : 'Unknown';
      
      // Show detailed duplicate warning
      showDuplicateReceiptWarning(serialNumber, customerName, existingReceipt.customerId);
      return;
    }
  }
  
  // Determine delivery status and delivery person based on status and collection method
  let receiptDeliveryStatus = 'Office';
  let receiptDeliveryPersonId = '';
  let receiptIsPaid = true;
  let receiptIsReceivedInOffice = true;
  
  if (status === 'Not Paid') {
    receiptIsPaid = false;
    receiptIsReceivedInOffice = false;
    
    if (statusDetail.notPaidCollection === 'delivery') {
      receiptDeliveryStatus = 'Needs Delivery';
      // Get delivery person from the first payment with a delivery person, or from a dedicated field
      const deliveryPayment = payments.find(p => p.deliveryPersonId);
      receiptDeliveryPersonId = deliveryPayment?.deliveryPersonId || 
                                document.getElementById('notpaid-delivery-person')?.value || '';
    } else {
      receiptDeliveryStatus = 'Office'; // Customer will come to shop
    }
  }

  // Paid rules: collected in office vs by delivery
  if (status === 'Paid') {
    const paidCollection = statusDetail.paidCollection || 'office';
    if (paidCollection === 'delivery') {
      // Payment already collected by driver; mark as delivered but not necessarily handed to office yet.
      receiptDeliveryStatus = 'Delivered';
      receiptIsReceivedInOffice = false;
      const deliveryPayment = payments.find(p => p.deliveryPersonId);
      receiptDeliveryPersonId = statusDetail.paidDeliveryPersonId || deliveryPayment?.deliveryPersonId || '';
    } else {
      receiptDeliveryStatus = 'Office';
      receiptDeliveryPersonId = '';
      receiptIsReceivedInOffice = true;
      statusDetail.paidDeliveryPersonId = '';
    }
  }

  // Temp delivery receipt: require assignment-time delivery info
  const deliveryPlaceName = String(document.getElementById('receipt-delivery-place')?.value || '').trim();
  const quotedDeliveryFee = parseFloat(String(document.getElementById('receipt-quoted-delivery-fee')?.value || '').trim()) || 0;
  const deliveryInstructions = String(document.getElementById('receipt-delivery-instructions')?.value || '').trim();
  if (isTempDelivery) {
    if (!receiptDeliveryPersonId) {
      showNotification('Validation', 'Please assign a delivery person.', 'error');
      return;
    }
    if (!deliveryPlaceName) {
      showNotification('Validation', 'Delivery place name is required.', 'error');
      return;
    }
    if (!(quotedDeliveryFee >= 0) || !Number.isFinite(quotedDeliveryFee)) {
      showNotification('Validation', 'Quoted delivery fee is required.', 'error');
      return;
    }
  }
  
  // Temp delivery receipts: send tempReceiptNo (D#) only; serialNumber stays empty until delivery completion.
  // Normal receipts: send serialNumber only.
  const tempReceiptNo = isTempDelivery ? serialNumber : (state.modalData?.tempReceiptNo || '');
  const serialFinal = isTempDelivery ? (state.modalData?.serialNumber || state.modalData?.finalReceiptNo || '') : serialNumber;
  const finalReceiptNo = (state.modalData?.finalReceiptNo || '') || (serialFinal || '');
  
  const receipt = {
    id: state.modalData ? state.modalData.id : generateId('receipt'),
    recordType: 'receipt',
    customerId: customerId,
    pageId: '',
    creatorId: state.currentUser?.id || '',
    amountUSD: totalUSD,
    exchangeRate: avgRate,
    amountLocal: totalLYD,
    paymentMethod: (Array.isArray(payments) && payments.length > 1) ? 'Split Payment' : (Array.isArray(payments) && payments.length > 0 ? payments[0]?.method : 'Cash (USD)'),
    status,
    statusDetail,
    isPaid: receiptIsPaid,
    deliveryStatus: receiptDeliveryStatus,
    deliveryPersonId: receiptDeliveryPersonId,
    isReceivedInOffice: receiptIsReceivedInOffice,
    startDate: new Date().toISOString(),
    endDate: new Date().toISOString(),
    createdAt: state.modalData ? state.modalData.createdAt : new Date().toISOString(),
    // CRITICAL: temp delivery receipts must NOT send serialNumber=D# (server rejects non-digit serial).
    // Only send serialNumber for normal receipts; temp receipts use tempReceiptNo.
    serialNumber: isTempDelivery ? '' : serialFinal,
    finalReceiptNo: finalReceiptNo,
    tempReceiptNo: tempReceiptNo,
    receiptType: tempReceiptNo ? 'DELIVERY_TEMP' : (state.modalData?.receiptType || ''),
    deliveryPlaceName: isTempDelivery ? deliveryPlaceName : (state.modalData?.deliveryPlaceName || deliveryPlaceName || ''),
    deliveryInstructions: isTempDelivery ? deliveryInstructions : (state.modalData?.deliveryInstructions || deliveryInstructions || ''),
    quotedDeliveryFee: isTempDelivery ? quotedDeliveryFee : (state.modalData?.quotedDeliveryFee ?? quotedDeliveryFee),
    // Debt baseline (what the driver must collect on delivery). While the
    // receipt is still a pre-delivery temp receipt, keep this in sync with the
    // current totals so an admin's edit to the amount also corrects the amount
    // to be collected. Once delivered (no longer a temp receipt) the stored
    // baseline is preserved. Previously an edit updated amountLocal but left
    // this stale, corrupting the driver's cash reconciliation.
    debtAmountLocal: (isTempDelivery ? totalLYD : (state.modalData?.debtAmountLocal ?? undefined)),
    debtAmountUSD: (isTempDelivery ? totalUSD : (state.modalData?.debtAmountUSD ?? undefined)),
    officeFee: 0,
    discount: 0,
    phoneNumber: document.getElementById('receipt-phone-search').value || '',
    collectionDate: new Date().toISOString(),
    payments: payments,
    photos
  };
  
  // Get customer name for logging
  const linkedCustomer = state.customers.find(c => c.id === customerId);
  const customerName = linkedCustomer ? linkedCustomer.name : 'customer';
  
  if (state.modalData) {
    // Update existing - Track changes for edit history
    const oldReceipt = state.modalData;
    const changes = [];
    
    // Fields to track for changes
    const fieldsToTrack = [
      { key: 'customerId', label: 'Customer', format: (v) => state.customers.find(c => c.id === v)?.name || v },
      { key: 'amountUSD', label: 'Amount (USD)', format: (v) => `$${parseFloat(v || 0).toFixed(2)}` },
      { key: 'amountLocal', label: 'Amount (LYD)', format: (v) => `${parseFloat(v || 0).toFixed(2)} LYD` },
      { key: 'exchangeRate', label: 'Exchange Rate', format: (v) => parseFloat(v || 0).toFixed(2) },
      { key: 'paymentMethod', label: 'Payment Method', format: (v) => v },
      { key: 'status', label: 'Status', format: (v) => v },
      { key: 'serialNumber', label: 'Serial Number', format: (v) => v || 'None' },
      { key: 'phoneNumber', label: 'Phone Number', format: (v) => v || 'None' },
    ];
    
    fieldsToTrack.forEach(field => {
      const oldVal = oldReceipt[field.key];
      const newVal = receipt[field.key];
      if (String(oldVal || '') !== String(newVal || '')) {
        changes.push({
          field: field.label,
          from: field.format(oldVal),
          to: field.format(newVal)
        });
      }
    });
    
    // Track payment changes
    const oldPayments = oldReceipt.payments || [];
    const newPayments = receipt.payments || [];
    if (JSON.stringify(oldPayments) !== JSON.stringify(newPayments)) {
      changes.push({
        field: 'Payments',
        from: `${oldPayments.length} payment(s)`,
        to: `${newPayments.length} payment(s)`
      });
    }
    
    // Add to edit history if there are changes
    if (changes.length > 0) {
      const editHistory = oldReceipt.editHistory || [];
      editHistory.push({
        editedAt: new Date().toISOString(),
        editedBy: state.currentUser?.name || 'Unknown',
        changes: changes
      });
      receipt.editHistory = editHistory;
      receipt.editCount = editHistory.length;
    } else {
      receipt.editHistory = oldReceipt.editHistory || [];
      receipt.editCount = oldReceipt.editCount || 0;
    }
    
    receipt.updatedAt = new Date().toISOString();
    // Pass the baseline the user actually edited (the modal snapshot) so a
    // concurrent change (e.g. a driver completing the delivery) triggers a
    // 409 conflict + reload instead of being silently overwritten.
    updateRecord(state.receipts, receipt.id, receipt, oldReceipt?._lastModified);
    showNotification('Updated', 'Receipt updated successfully!', 'success');
    addLog('update', 'receipt', receipt.id, `Updated receipt${serialNumber ? ' #' + serialNumber : ''}`);
  } else {
    // Create new
    if (isServerModeEnabled()) {
      // Server-confirmed create: do NOT show success until the server confirms.
      try {
        const created = await apiCreateEntity('receipts', receipt);
        const saved = created?.data ? Security.sanitizeObject(created.data) : null;
        if (!saved || !saved.id) {
          showNotification('Server Error', 'Failed to create receipt: invalid server response', 'error');
          return;
        }
        // Insert into local state
        state.receipts.unshift(saved);
        markCollectionDirty('receipts');
        saveState();
        showNotification('Success', 'Receipt created successfully!', 'success');
        addLog('create', 'receipt', saved.id, `Created receipt${saved.tempReceiptNo ? ' #' + saved.tempReceiptNo : (serialNumber ? ' #' + serialNumber : '')} for ${customerName}`);
      } catch (e) {
        const status = e?.status ? `HTTP ${e.status}` : '';
        const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
        showNotification('Server Error', `Failed to create receipt: ${status ? status + ' - ' : ''}${detail}`, 'error');
        return; // keep modal open so user can retry
      }
    } else {
    addRecord(state.receipts, receipt);
    showNotification('Success', 'Receipt created successfully!', 'success');
    addLog('create', 'receipt', receipt.id, `Created receipt${serialNumber ? ' #' + serialNumber : ''} for ${customerName}`);
    }
  }
  
  // Reset modal state FIRST
  state.activeModal = null;
  state.modalData = null;
  
  // Force remove ALL modal elements directly
  document.querySelectorAll('#app-modal').forEach(el => el.remove());
  document.querySelectorAll('[class*="fixed inset-0"]').forEach(el => {
    if (el.id === 'app-modal' || el.querySelector('#app-modal')) {
      el.remove();
    }
  });
  
  // Also try the closeModal function
  const modalEl = document.getElementById('app-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.remove();
  }
  
  // Force full re-render to ensure data consistency
  // Reset partial render cache to force full DOM update
  _lastRenderedView = null;
  _lastRenderedUserId = null;
  
  // Render immediately (don't wait)
  render();
    lucide.createIcons();
  
  } catch (error) {
    console.error('Error saving receipt:', error);
    showNotification('Error', 'Failed to save receipt: ' + error.message, 'error');
    
    // Still try to close the modal even if there was an error
    state.activeModal = null;
    state.modalData = null;
    document.querySelectorAll('#app-modal').forEach(el => el.remove());
    setTimeout(() => {
      render();
      lucide.createIcons();
    }, 50);
  }
}

// Image upload handler
function handleReceiptImageUpload(input) {
  if (input.files && input.files[0]) {
    compressImageToDataUrl(input.files[0]).then((dataUrl) => {
      // Store base64 image temporarily (compressed)
      if (dataUrl) input.dataset.imageData = dataUrl;
    }).catch(() => {});
  }
}

// ==========================================
// RECEIPT NUMBER VALIDATION
// ==========================================

// Real-time validation for receipt number input
function validateReceiptNumberInput(input) {
  const errorDiv = document.getElementById('receipt-serial-error');
  const originalValue = input.value;
  
  // Remove any non-digit characters
  let value = input.value.replace(/[^0-9]/g, '');
  
  // Check if user tried to enter non-digit characters
  if (originalValue !== value && originalValue.length > 0) {
    input.classList.add('animate-shake');
    setTimeout(() => input.classList.remove('animate-shake'), 300);
  }
  
  // If the value starts with 0, remove it and show error
  if (value.length > 0 && value.startsWith('0')) {
    value = value.substring(1);
    input.classList.add('animate-shake');
    setTimeout(() => input.classList.remove('animate-shake'), 300);
    
    if (errorDiv) {
      errorDiv.innerHTML = '<i data-lucide="alert-circle" class="w-3 h-3 inline mr-1"></i>Receipt number cannot start with zero';
      errorDiv.classList.remove('hidden');
      input.classList.add('border-rose-500', 'focus:ring-rose-500/20');
      if (window.lucide) lucide.createIcons();
      setTimeout(() => {
        errorDiv.classList.add('hidden');
        input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
      }, 3000);
    }
  }
  
  // Update the input value
  input.value = value;
  
  // Clear error if valid
  if (value.length > 0 && !value.startsWith('0')) {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
  }
}

// Check for duplicate receipt number on blur
function checkReceiptNumberDuplicate(input) {
  const serialNumber = input.value.trim();
  const errorDiv = document.getElementById('receipt-serial-error');
  
  if (!serialNumber) {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
    return;
  }
  
  // Check for duplicates (excluding current record if editing)
  const existingReceipt = state.ads.find(ad => 
    ad.recordType === 'receipt' && 
    ad.serialNumber === serialNumber && 
    ad.id !== (state.modalData ? state.modalData.id : null) &&
    !ad._deleted
  );
  
  if (existingReceipt) {
    const customer = state.customers.find(c => c.id === existingReceipt.customerId);
    const customerName = customer ? customer.name : 'Unknown';
    
    // Show error message with link to customer
    if (errorDiv) {
      errorDiv.innerHTML = `
        <div class="flex items-center space-x-2">
          <i data-lucide="alert-circle" class="w-3 h-3"></i>
          <span>Already exists! Linked to: <strong>${customerName}</strong></span>
          <button type="button" onclick="goToCustomerFromWarning('${existingReceipt.customerId}')" 
            class="ml-1 text-indigo-600 hover:text-indigo-700 underline font-bold">
            View Customer →
          </button>
        </div>
      `;
      errorDiv.classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }
    input.classList.add('border-rose-500', 'focus:ring-rose-500/20');
  } else {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
  }
}

// Duplicate receipt warning
function showDuplicateReceiptWarning(receiptNumber, customerName, customerId) {
  const warningModal = document.createElement('div');
  warningModal.className = 'fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm';
  warningModal.id = 'duplicate-receipt-warning';
  
  warningModal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 max-w-md w-full animate-fade-in-up shadow-2xl">
      <div class="flex items-start space-x-4 mb-4">
        <div class="w-12 h-12 bg-rose-100 dark:bg-rose-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
          <i data-lucide="alert-triangle" class="w-6 h-6 text-rose-600"></i>
        </div>
        <div>
          <h3 class="text-xl font-bold text-slate-800 dark:text-white mb-2">Receipt Number Already Exists</h3>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            Receipt number <span class="font-mono font-bold text-rose-600">#${receiptNumber}</span> is already saved.
          </p>
        </div>
      </div>
      
      <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl mb-4">
        <div class="flex items-center space-x-2 mb-2">
          <i data-lucide="user" class="w-4 h-4 text-slate-500"></i>
          <span class="text-xs font-medium text-slate-500 uppercase">Linked to Customer</span>
        </div>
        <p class="text-lg font-bold text-slate-800 dark:text-white">${customerName}</p>
      </div>
      
      <div class="flex space-x-3">
        <button onclick="closeDuplicateWarning()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">
          Close
        </button>
        <button onclick="goToCustomerFromWarning('${customerId}')" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center space-x-2">
          <i data-lucide="arrow-right" class="w-4 h-4"></i>
          <span>View Customer</span>
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(warningModal);
  
  // Refresh icons
  if (window.lucide) {
    lucide.createIcons();
  }
}

function closeDuplicateWarning() {
  const warning = document.getElementById('duplicate-receipt-warning');
  if (warning) {
    warning.remove();
  }
}

function goToCustomerFromWarning(customerId) {
  closeDuplicateWarning();
  closeModal();
  navigateTo('customers');
  
  // Scroll to customer after a short delay
  setTimeout(() => {
    const customerCard = document.querySelector(`[data-customer-id="${customerId}"]`);
    if (customerCard) {
      customerCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      customerCard.classList.add('animate-shake');
      setTimeout(() => customerCard.classList.remove('animate-shake'), 500);
    }
  }, 300);
}

// ==========================================
// RECEIPT MODAL HELPERS
// ==========================================

function isTempDeliveryReceiptNo(value) {
  const s = String(value || '').trim();
  return /^D\d+$/.test(s);
}

function getNextTempDeliveryReceiptNo() {
  const receipts = getVisibleRecords(state.receipts);
  let maxN = 0;
  const used = new Set();
  for (const r of receipts) {
    const t = String(r?.tempReceiptNo || '').trim();
    const f = String(r?.finalReceiptNo || r?.serialNumber || '').trim();
    if (t) used.add(t);
    if (f) used.add(f);
    const m = /^D(\d+)$/.exec(t);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  let next = maxN + 1;
  // Safety: if somehow a number is missing, still ensure uniqueness.
  while (used.has(`D${next}`)) next += 1;
  return `D${next}`;
}

function ensureTempDeliveryReceiptNoInReceiptForm() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return '';
  const existing = String(serialInput.value || '').trim();
  if (isTempDeliveryReceiptNo(existing)) return existing;
  const v = getNextTempDeliveryReceiptNo();
  serialInput.value = v;
  return v;
}

function setReceiptStatus(btn, status) {
  // Update hidden input
  document.getElementById('receipt-status').value = status;
  
  // Update visual state
  const container = btn.parentElement;
  const buttons = container.querySelectorAll('button');
  buttons.forEach(b => {
    b.className = 'flex-1 py-1.5 text-sm font-medium rounded-lg transition-all text-slate-500 hover:text-slate-700';
  });
  
  btn.className = 'flex-1 py-1.5 text-sm font-medium rounded-lg transition-all bg-white shadow-sm text-indigo-600 font-bold';
  
  updateReceiptStatusUI(status);
}

function updateReceiptStatusUI(status) {
  const serialInput = document.getElementById('receipt-serial');
  const paidBlock = document.getElementById('status-paid');
  const notPaidBlock = document.getElementById('status-not-paid');
  const cancelBlock = document.getElementById('status-canceled');
  const lostBlock = document.getElementById('status-lost');
  const refundActionSelect = document.getElementById('status-cancel-refund-action');
  const refundStatusSelect = document.getElementById('status-cancel-refund-status');
  const adminOverride = document.getElementById('status-not-paid-admin-override');
  const notPaidCollection = document.getElementById('notpaid-collection-value')?.value || '';
  const tempHint = document.getElementById('receipt-temp-hint');
  const deliveryInfo = document.getElementById('receipt-delivery-info');

  const currentStatus = status || document.getElementById('receipt-status')?.value || 'Paid';
  const isAdmin = isCurrentUserAdmin();
  const isTempDelivery = currentStatus === 'Not Paid' && notPaidCollection === 'delivery';

  const show = (el, shouldShow) => {
    if (!el) return;
    el.classList.toggle('hidden', !shouldShow);
  };

  // Default visibility
  show(paidBlock, currentStatus === 'Paid');
  show(notPaidBlock, currentStatus === 'Not Paid');
  show(cancelBlock, currentStatus === 'Canceled');
  show(lostBlock, currentStatus === 'Lost');

  // Serial rules
  if (serialInput) {
    // Temp delivery receipt: auto-generate D{n} and lock editing.
    if (isTempDelivery) {
      serialInput.disabled = true;
      serialInput.readOnly = true;
      const existing = String(serialInput.value || '').trim();
      if (isServerModeEnabled()) {
        // In server mode, the backend generates a unique D{n} safely (no collisions across users/devices).
        // Keep existing value when editing; otherwise let server fill it on save.
        if (!isTempDeliveryReceiptNo(existing)) {
          serialInput.value = '';
        }
        serialInput.placeholder = 'Temporary number (server-generated)';
        if (tempHint) {
          tempHint.classList.remove('hidden');
          tempHint.textContent = isTempDeliveryReceiptNo(existing)
            ? `Temporary number: ${existing} (Pending Delivery)`
            : 'Temporary number will be assigned when saved (Pending Delivery)';
        }
      } else {
        // Local mode fallback: generate a best-effort D{n}.
        serialInput.placeholder = 'Temporary number (auto)';
        const tempNo = ensureTempDeliveryReceiptNoInReceiptForm();
        if (tempHint) {
          tempHint.classList.remove('hidden');
          tempHint.textContent = `Temporary number: ${tempNo} (Pending Delivery)`;
        }
      }
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.add('hidden');
      show(deliveryInfo, true);
    } else if (currentStatus === 'Not Paid') {
      const allow = isAdmin && adminOverride?.checked;
      serialInput.disabled = !allow;
      serialInput.readOnly = false;
      serialInput.placeholder = allow ? 'Admin entering receipt number' : 'Locked until paid';
      if (!allow) serialInput.value = '';
      if (tempHint) tempHint.classList.add('hidden');
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.toggle('hidden', !isAdmin);
      show(deliveryInfo, false);
    } else {
      serialInput.disabled = false;
      serialInput.readOnly = false;
      serialInput.placeholder = 'e.g., 12345';
      if (tempHint) tempHint.classList.add('hidden');
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.toggle('hidden', !isAdmin);
      show(deliveryInfo, false);
    }
  }

  // Refund sub-status
  if (refundActionSelect) {
    const action = refundActionSelect.value;
    const needsRefundStatus = currentStatus === 'Canceled' && (action === 'full' || action === 'partial');
    const refundStatusSection = document.getElementById('cancel-refund-status-section');
    show(refundStatusSection, needsRefundStatus);
  }
}

// Beautiful button selection for Cancel options
function selectCancelOption(value) {
  // Update hidden input
  const input = document.getElementById('status-cancel-refund-action');
  if (input) input.value = value;
  
  // Update button styles
  document.querySelectorAll('.cancel-option-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    // Reset all buttons first
    btn.className = 'cancel-option-btn group relative overflow-hidden px-4 py-3 rounded-xl text-left transition-all duration-300';
    
    if (isSelected) {
      // Apply selected gradient based on option
      const gradients = {
        'full': 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/30 scale-[1.02]',
        'partial': 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 scale-[1.02]',
        'forgiven': 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-lg shadow-violet-500/30 scale-[1.02]',
        'undecided': 'bg-gradient-to-r from-slate-500 to-slate-600 text-white shadow-lg shadow-slate-500/30 scale-[1.02]'
      };
      btn.className += ' ' + (gradients[btnValue] || gradients['undecided']);
      
      // Update icon and text colors
      const iconBg = btn.querySelector('span.flex-shrink-0');
      if (iconBg) iconBg.className = 'flex-shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center';
      btn.querySelectorAll('i').forEach(i => i.className = i.className.replace(/text-\w+-\d+/g, '') + ' text-white');
      btn.querySelectorAll('.font-bold').forEach(el => el.className = el.className.replace(/text-slate-\d+/g, '') + ' text-white');
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => el.className = el.className.replace(/text-slate-\d+/g, '') + ' text-white/80');
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:shadow-md';
    }
  });
  
  // Show/hide refund status section
  const needsRefundStatus = value === 'full' || value === 'partial';
  const refundStatusSection = document.getElementById('cancel-refund-status-section');
  if (refundStatusSection) {
    refundStatusSection.classList.toggle('hidden', !needsRefundStatus);
  }
  
  // Set default refund status if needed
  if (needsRefundStatus) {
    const refundStatusInput = document.getElementById('status-cancel-refund-status');
    if (refundStatusInput && !refundStatusInput.value) {
      refundStatusInput.value = 'pending';
      selectRefundStatus('pending');
    }
  }
  
  if (window.lucide) lucide.createIcons();
}

// ================================
// AD FUNDING & LINKING HELPERS
// ================================

function getPagesForCustomer(customerId) {
  if (!customerId) return [];
  return getVisibleRecords(state.pages).filter(p => Array.isArray(p.customerIds) && p.customerIds.includes(customerId));
}

function getReceiptsForAd(customerId, pageId) {
  if (!customerId) return [];
  return getVisibleRecords(state.receipts || []).filter(r => {
    if (!r || r._deleted) return false;
    if (r.customerId !== customerId) return false;
    if (pageId && r.pageId && r.pageId !== pageId) return false;
    const statusLower = String(r.status || '').toLowerCase();
    const isPaid = (r.isPaid === true) || statusLower === 'paid';
    if (!isPaid) return false;

    // Funding receipts must be real paid receipts.
    // Temp delivery receipts (D#) are allowed ONLY after they are finalized:
    // - deliveryStatus === Delivered
    // - final receipt number exists (digits or S-prefixed) (finalReceiptNo/serialNumber)
    const looksTemp = (String(r.receiptType || '').toUpperCase() === 'DELIVERY_TEMP') || isTempDeliveryReceiptNo(r.tempReceiptNo);
    if (looksTemp) {
      const dsLower = String(r.deliveryStatus || '').toLowerCase();
      const finalNo = String(r.finalReceiptNo || r.serialNumber || '').trim();
      // Accept either digits (123) or S-prefixed (S1, S2) for LTT/Libyana/Madar
      const hasFinalNo = (/^\d+$/.test(finalNo) && !finalNo.startsWith('0')) || isAutoSerialNumber(finalNo);
      if (!(dsLower === 'delivered' && hasFinalNo)) return false;
    }

    return true;
  });
}

function getReceiptRemainingUSD(receipt) {
  const usage = getReceiptUsageStats(receipt);
  return usage.remainingUSD || 0;
}

function initAdFunding(adData = {}) {
  state.tempAdFunding = {
    allocations: Array.isArray(adData.receiptAllocations) ? [...adData.receiptAllocations] : []
  };
}

function handleAdCustomerChange(customerId, preserveFunding = false) {
  // Reset page and funding when customer changes
  const pageSelect = document.getElementById('ad-page');
  if (pageSelect) {
    const pages = getPagesForCustomer(customerId);
    pageSelect.innerHTML = `<option value="">Select page</option>${pages.map(p => `<option value="${Security.escapeHtml(p.id)}">${Security.escapeHtml(p.name)}</option>`).join('')}`;
    if (preserveFunding && state.modalData?.pageId && pages.some(p => p.id === state.modalData.pageId)) {
      pageSelect.value = state.modalData.pageId;
    } else {
      pageSelect.value = '';
    }
  }
  
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  if (!preserveFunding) {
    state.tempAdFunding.allocations = [];
  }
  
  renderAdFundingList();
}

function handleAdPageChange(preserveFunding = false) {
  // Clear funding when page changes (unless we're initializing an edit modal and want to keep existing allocations)
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  if (!preserveFunding) {
  state.tempAdFunding.allocations = [];
  }
  renderAdFundingList();
}

// Select a page in the Add Ad modal (Page-first workflow)
function selectAdPage(pageId, preserveFunding = false) {
  const pageInput = document.getElementById('ad-page');
  const pageSearch = document.getElementById('ad-page-search');
  const customerSection = document.getElementById('ad-customer-section');
  const customerDisplay = document.getElementById('ad-customer-display');
  const customerIdInput = document.getElementById('ad-customer-id');
  const customerHint = document.getElementById('ad-customer-hint');
  
  // Hide dropdown after selection
  hideAdPageDropdown();
  
  if (!pageId) {
    if (customerSection) customerSection.classList.add('hidden');
    if (customerIdInput) customerIdInput.value = '';
    return;
  }
  
  // Update page input
  if (pageInput) pageInput.value = pageId;
  const page = state.pages.find(p => p.id === pageId);
  if (pageSearch && page) pageSearch.value = page.name;
  
  // Update page button visuals
  document.querySelectorAll('.ad-page-btn').forEach(btn => {
    const btnPageId = btn.dataset.pageId;
    const isSelected = btnPageId === pageId;
    
    btn.className = `ad-page-btn group p-2.5 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white shadow-md' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-500'}`;
    
    const icon = btn.querySelector('i[data-lucide="facebook"]');
    const iconContainer = btn.querySelector('span:first-child');
    const title = btn.querySelector('.font-medium');
    const subtitle = btn.querySelector('.text-\\[10px\\]');
    
    if (iconContainer) {
      iconContainer.className = `w-7 h-7 rounded-lg ${isSelected ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center`;
    }
    if (icon) {
      icon.className = `w-3.5 h-3.5 ${isSelected ? 'text-white' : 'text-slate-500 dark:text-slate-400'}`;
    }
    if (title) {
      title.className = `font-medium text-xs truncate ${isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-200'}`;
    }
    if (subtitle) {
      subtitle.className = `text-[10px] ${isSelected ? 'text-indigo-200' : 'text-slate-400'}`;
    }
  });
  
  // Get page and find linked customers
  if (!page) return;
  
  const linkedCustomerIds = page.customerIds || [];
  const linkedCustomers = state.customers.filter(c => linkedCustomerIds.includes(c.id));
  
  // Show customer section
  if (customerSection) customerSection.classList.remove('hidden');
  
  if (linkedCustomers.length === 0) {
    // No customers linked to this page
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-center">
          <i data-lucide="alert-triangle" class="w-5 h-5 mx-auto mb-1 text-amber-500"></i>
          <p class="text-xs text-amber-700 dark:text-amber-300">No customers linked.</p>
          <button type="button" onclick="closeModal(); navigateTo('pages')" class="mt-1 text-xs text-amber-600 hover:text-amber-700 font-medium">Link →</button>
        </div>
      `;
    }
    if (customerIdInput) customerIdInput.value = '';
    if (customerHint) customerHint.textContent = '(no customers)';
  } else if (linkedCustomers.length === 1) {
    // Single customer - auto-select
    const customer = linkedCustomers[0];
    if (customerIdInput) customerIdInput.value = customer.id;
    if (customerHint) customerHint.textContent = '(auto-selected)';
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="flex items-center space-x-3 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-medium text-sm">
            ${customer.name?.charAt(0) || 'C'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-slate-700 dark:text-slate-200 truncate">${Security.escapeHtml(customer.name || '')}</div>
            <div class="text-[10px] text-slate-400">${Security.escapeHtml(customer.platform || '')} • ${Security.escapeHtml(customer.phones?.[0] || 'No phone')}</div>
          </div>
          <span class="text-[10px] text-indigo-600 dark:text-indigo-400">✓</span>
        </div>
      `;
    }
  } else {
    // Multiple customers - show selection cards
    if (customerHint) customerHint.textContent = '(select one)';
    const currentCustomerId = customerIdInput?.value || '';
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="relative mb-2">
          <i data-lucide="search" class="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
          <input type="text" placeholder="Search..." class="w-full glass-input pl-8 pr-3 py-1.5 rounded-lg text-xs" oninput="filterAdCustomers(this.value)" />
        </div>
        <div id="ad-customer-cards" class="grid grid-cols-2 gap-2 max-h-28 overflow-y-auto">
          ${linkedCustomers.map(c => {
            const isSelected = c.id === currentCustomerId;
            return `
              <button type="button" onclick="selectAdCustomer('${c.id}')" class="ad-customer-btn group p-2 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400'}" data-customer-id="${c.id}" data-customer-name="${Security.escapeHtml((c.name || '').toLowerCase())}">
                <div class="flex items-center space-x-2">
                  <div class="w-6 h-6 rounded-full ${isSelected ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center text-[10px] font-medium ${isSelected ? 'text-white' : 'text-slate-500'}">
                    ${c.name?.charAt(0) || 'C'}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-xs truncate ${isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-200'}">${Security.escapeHtml(c.name || '')}</div>
                  </div>
                </div>
              </button>
            `;
          }).join('')}
        </div>
      `;
    }
  }
  
  // Refresh icons and funding
  lucide.createIcons();
  handleAdPageChange(!!preserveFunding);
}

// Select customer in multi-customer scenario
function selectAdCustomer(customerId, preserveFunding = false) {
  const customerIdInput = document.getElementById('ad-customer-id');
  const prevCustomerId = customerIdInput?.value || '';
  if (customerIdInput) customerIdInput.value = customerId;
  
  // Update button visuals
  document.querySelectorAll('.ad-customer-btn').forEach(btn => {
    const btnCustomerId = btn.dataset.customerId;
    const isSelected = btnCustomerId === customerId;
    
    btn.className = `ad-customer-btn group p-2 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400'}`;
    
    const avatar = btn.querySelector('.rounded-full');
    const title = btn.querySelector('.font-medium');
    
    if (avatar) {
      avatar.className = `w-6 h-6 rounded-full ${isSelected ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-700'} flex items-center justify-center text-[10px] font-medium ${isSelected ? 'text-white' : 'text-slate-500'}`;
    }
    if (title) {
      title.className = `font-medium text-xs truncate ${isSelected ? 'text-white' : 'text-slate-700 dark:text-slate-200'}`;
    }
  });
  
  lucide.createIcons();
  // If the user changes customer while creating a new ad, clear funding allocations
  // (receipts are customer-scoped). Preserve allocations only when initializing an edit modal.
  const changedCustomer = prevCustomerId && String(prevCustomerId) !== String(customerId || '');
  if (!preserveFunding && changedCustomer) {
    state.tempAdFunding = state.tempAdFunding || { allocations: [] };
    state.tempAdFunding.allocations = [];
  }
  // Refresh Receipt Funding UI after choosing customer (critical for multi-customer pages)
  renderAdFundingList();
  refreshAdTempReceiptOptions();
}

function getPendingTempDeliveryReceiptsForCustomer(customerId) {
  const cid = String(customerId || '');
  if (!cid) return [];
  return getVisibleRecords(state.receipts)
    .filter(r => {
      if (!r || r._deleted) return false;
      if (String(r.customerId || '') !== cid) return false;
      if (!isTempDeliveryReceiptNo(r.tempReceiptNo)) return false;
      const ds = String(r.deliveryStatus || '');
      if (!ds) return false;
      // Pending delivery receipts only
      if (ds === 'Delivered' || ds === 'Office' || ds === 'Canceled') return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt || b.startDate || 0) - new Date(a.createdAt || a.startDate || 0));
}

function refreshAdTempReceiptOptions() {
  const paymentStatus = document.getElementById('ad-payment-status')?.value || '';
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  const section = document.getElementById('ad-temp-receipt-link');
  const select = document.getElementById('ad-temp-receipt-id');
  const hidden = document.getElementById('ad-linked-receipt-id');
  const hint = document.getElementById('ad-temp-receipt-hint');
  if (!section || !select || !hidden) return;

  const shouldShow = paymentStatus === 'not_paid' && collectionMethod === 'driver' && !!customerId;
  section.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    hidden.value = '';
    if (hint) hint.textContent = '';
    select.innerHTML = '<option value="">Select pending receipt...</option>';
    return;
  }

  const receipts = getPendingTempDeliveryReceiptsForCustomer(customerId);
  const current = String(hidden.value || '').trim() || String(state.modalData?.receiptId || '').trim();

  select.innerHTML = [
    '<option value="">Select pending receipt...</option>',
    ...receipts.map(r => {
      // Calculate available credit in USD
      const dueUsage = getDeliveryReceiptDueUsage(r);
      const availableUSD = dueUsage.remainingDueUSD;
      const place = String(r.deliveryPlaceName || '').trim();
      const label = `${r.tempReceiptNo}${place ? ' • ' + place : ''} • $${availableUSD.toFixed(2)} available`;
      const selected = String(r.id) === current ? 'selected' : '';
      return `<option value="${r.id}" ${selected}>${Security.escapeHtml(label)}</option>`;
    })
  ].join('');

  // Auto-suggest: if nothing selected yet and there is a pending receipt, pick the newest.
  let selectedId = String(select.value || '').trim();
  if (!selectedId && receipts.length > 0) {
    selectedId = String(receipts[0].id);
    select.value = selectedId;
  }
  onAdTempReceiptChange(selectedId);
}

function onAdTempReceiptChange(receiptId) {
  const hidden = document.getElementById('ad-linked-receipt-id');
  const hint = document.getElementById('ad-temp-receipt-hint');
  const driverSelect = document.getElementById('ad-delivery-person');
  const dueSection = document.getElementById('ad-due-amount-section');
  const mergeToggle = document.getElementById('ad-merge-funds-toggle');
  const dueAvailable = document.getElementById('ad-due-available');
  const dueInput = document.getElementById('ad-due-amount-to-use');
  
  if (!hidden) return;
  hidden.value = String(receiptId || '');

  const rid = String(receiptId || '').trim();
  if (!rid) {
    if (hint) hint.textContent = '';
    if (driverSelect) driverSelect.disabled = false;
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    return;
  }

  const r = state.receipts.find(x => x && !x._deleted && String(x.id) === rid);
  if (!r) {
    if (hint) hint.textContent = 'Selected receipt not found. Try Refresh.';
    if (driverSelect) driverSelect.disabled = false;
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    return;
  }

  const customerId = document.getElementById('ad-customer-id')?.value || '';
  if (customerId && String(r.customerId || '') !== String(customerId)) {
    if (hint) hint.textContent = 'Receipt customer mismatch. Please select the correct customer.';
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
  } else {
    const place = String(r.deliveryPlaceName || '').trim();
    const fee = Number(r.quotedDeliveryFee ?? 0) || 0;
    const dueLYD = Number(r.debtAmountLocal ?? r.amountLocal ?? 0) || 0;
    
    // Calculate available credit in USD using the new tracking function
    const dueUsage = getDeliveryReceiptDueUsage(r);
    const availableUSD = dueUsage.remainingDueUSD;
    const exchangeRate = dueUsage.exchangeRate || state.defaultExchangeRate || 1;
    
    const txt = `${r.tempReceiptNo}${r.finalReceiptNo || r.serialNumber ? ` → ${r.finalReceiptNo || r.serialNumber}` : ''}${place ? ` • ${place}` : ''} • Quoted fee ${fee.toFixed(0)} LYD`;
    if (hint) hint.textContent = txt;
    
    // Show due amount section if there's available credit
    if (availableUSD > 0.01) {
      if (dueSection) dueSection.classList.remove('hidden');
      if (dueAvailable) dueAvailable.textContent = `Available: $${availableUSD.toFixed(2)} (${(availableUSD * exchangeRate).toFixed(0)} LYD)`;
      if (dueInput) {
        // Store the max due amount in USD for validation
        dueInput.dataset.maxDue = availableUSD.toString();
        dueInput.dataset.exchangeRate = exchangeRate.toString();
        
        // Check if editing - load existing dueAmountToUseUSD from modalData
        let prefillValue = null;
        if (state.modalData?.linkedDeliveryReceiptId === rid) {
          // Check dueAllocations first (new format)
          if (Array.isArray(state.modalData.dueAllocations)) {
            const existingAlloc = state.modalData.dueAllocations.find(a => String(a.receiptId) === rid);
            if (existingAlloc) prefillValue = existingAlloc.amountUSD;
          }
          // Fallback to dueAmountToUseUSD
          if (prefillValue === null && state.modalData.dueAmountToUseUSD > 0) {
            prefillValue = state.modalData.dueAmountToUseUSD;
          }
        }
        
        // Default to existing value, or full available amount for new ads
        if (prefillValue !== null) {
          dueInput.value = prefillValue.toFixed(2);
        } else if (!dueInput.value) {
          dueInput.value = availableUSD.toFixed(2);
        }
      }
      // Show merge toggle to allow combining with paid receipts
      if (mergeToggle) mergeToggle.classList.remove('hidden');
      // Initialize merge funding state
      initMergeFunding();
    } else {
      // No credit available - all used up
      if (dueSection) dueSection.classList.add('hidden');
      if (mergeToggle) mergeToggle.classList.remove('hidden'); // Still allow merging paid receipts
      initMergeFunding();
      // Update hint to show that credit is fully used
      if (hint) hint.textContent += ' • ⚠️ Credit fully used';
    }
    
    updateAdDueSummary();
  }

  // Keep driver selection consistent with the receipt assignment.
  if (driverSelect) {
    const assigned = String(r.deliveryPersonId || '').trim();
    if (assigned) {
      driverSelect.value = assigned;
      driverSelect.disabled = true;
    } else {
      driverSelect.disabled = false;
    }
  }
}

// Initialize merge funding state
function initMergeFunding() {
  if (!state.tempMergeFunding) {
    state.tempMergeFunding = { allocations: [], enabled: false };
  }
}

// Handle due amount input change (USD)
function onAdDueAmountChange() {
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  let value = parseFloat(dueInput.value) || 0;
  
  // Cap at max available
  if (value > maxDue) {
    value = maxDue;
    dueInput.value = value.toFixed(2);
  }
  
  updateAdDueSummary();
}

// Use all available due amount (USD)
function useAllDueAmount() {
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  dueInput.value = maxDue.toFixed(2);
  updateAdDueSummary();
}

// Update the due amount summary (USD)
function updateAdDueSummary() {
  const summary = document.getElementById('ad-due-summary');
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!summary || !dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  const exchangeRate = parseFloat(dueInput.dataset.exchangeRate) || state.defaultExchangeRate || 1;
  const usingUSD = parseFloat(dueInput.value) || 0;
  const remainingUSD = maxDue - usingUSD;
  const usingLYD = usingUSD * exchangeRate;
  const remainingLYD = remainingUSD * exchangeRate;
  
  if (usingUSD > 0) {
    summary.innerHTML = `Using <span class="font-medium text-violet-700">$${usingUSD.toFixed(2)}</span> (${usingLYD.toFixed(0)} LYD) from due. ${remainingUSD > 0 ? `<span class="text-slate-400">$${remainingUSD.toFixed(2)} (${remainingLYD.toFixed(0)} LYD) will remain.</span>` : '<span class="text-emerald-600">Full credit will be used.</span>'}`;
  } else {
    summary.innerHTML = '<span class="text-amber-600">Enter amount to use from due receipt.</span>';
  }
}

// Toggle merge with paid funds
function toggleMergePaidFunds() {
  initMergeFunding();
  state.tempMergeFunding.enabled = !state.tempMergeFunding.enabled;
  
  const mergedSection = document.getElementById('ad-merged-paid-funds');
  const mergeIcon = document.getElementById('ad-merge-icon');
  const mergeText = document.getElementById('ad-merge-text');
  
  if (state.tempMergeFunding.enabled) {
    if (mergedSection) mergedSection.classList.remove('hidden');
    if (mergeIcon) mergeIcon.setAttribute('data-lucide', 'minus-circle');
    if (mergeText) mergeText.textContent = 'Remove Paid Receipt Funds';
    renderAdMergedFundingList();
  } else {
    if (mergedSection) mergedSection.classList.add('hidden');
    if (mergeIcon) mergeIcon.setAttribute('data-lucide', 'plus-circle');
    if (mergeText) mergeText.textContent = 'Add Paid Receipt Funds';
    // Clear allocations when disabled
    state.tempMergeFunding.allocations = [];
  }
  
  if (window.lucide) lucide.createIcons();
}

// Add funding allocation for merge mode
function addAdFundingAllocationForMerge() {
  initMergeFunding();
  state.tempMergeFunding.allocations.push({ receiptId: '', amountUSD: '' });
  renderAdMergedFundingList();
}

// Remove funding allocation from merge mode
function removeAdMergeFundingAllocation(idx) {
  if (!state.tempMergeFunding?.allocations) return;
  state.tempMergeFunding.allocations.splice(idx, 1);
  renderAdMergedFundingList();
}

// Update funding receipt in merge mode
function updateAdMergeFundingReceipt(idx, receiptId) {
  if (!state.tempMergeFunding?.allocations) return;
  const allocation = state.tempMergeFunding.allocations[idx];
  if (!allocation) return;
  allocation.receiptId = receiptId;
  renderAdMergedFundingList();
}

// Update funding amount in merge mode
function updateAdMergeFundingAmount(idx, value) {
  if (!state.tempMergeFunding?.allocations) return;
  const allocation = state.tempMergeFunding.allocations[idx];
  if (!allocation) return;
  allocation.amountUSD = value;
  refreshAdMergedFundingSummary();
}

// Get paid receipts available for the current customer (for merge mode)
function getPaidReceiptsForMerge(customerId) {
  if (!customerId) return [];
  return getVisibleRecords(state.receipts).filter(r => {
    if (String(r.customerId || '') !== String(customerId)) return false;
    if (r.isPaid === false) return false;
    // Exclude temp delivery receipts that aren't finalized
    const looksTemp = (String(r.receiptType || '').toUpperCase() === 'DELIVERY_TEMP') || isTempDeliveryReceiptNo(r.tempReceiptNo);
    if (looksTemp) {
      const dsLower = String(r.deliveryStatus || '').toLowerCase();
      const finalNo = String(r.finalReceiptNo || r.serialNumber || '').trim();
      const hasFinalNo = (/^\d+$/.test(finalNo) && !finalNo.startsWith('0')) || isAutoSerialNumber(finalNo);
      if (!(dsLower === 'delivered' && hasFinalNo)) return false;
    }
    return true;
  });
}

// Render the merged funding list (for Not Paid + Driver + Merge)
function renderAdMergedFundingList() {
  const list = document.getElementById('ad-merged-funding-list');
  if (!list) return;
  
  initMergeFunding();
  const allocations = state.tempMergeFunding.allocations || [];
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  const receipts = getPaidReceiptsForMerge(customerId);
  
  if (allocations.length === 0) {
    list.innerHTML = `<div class="py-2 text-center text-xs text-slate-400">Click "+ Add Receipt" to use paid funds</div>`;
    refreshAdMergedFundingSummary();
    return;
  }
  
  list.innerHTML = allocations.map((alloc, idx) => {
    const receipt = receipts.find(r => r.id === alloc.receiptId);
    const optionsHtml = receipts.map(r => {
      const usage = getReceiptUsageStats(r);
      const serial = r.serialNumber || r.finalReceiptNo || (r.id ? String(r.id).slice(0,6) : '???');
      const label = `#${serial} • $${(usage.remainingUSD || 0).toFixed(2)} avail`;
      return `<option value="${r.id || ''}" ${alloc.receiptId === r.id ? 'selected' : ''}>${Security.escapeHtml(label)}</option>`;
    }).join('');
    
    let receiptRemaining = 0;
    if (receipt) {
      const usage = getReceiptUsageStats(receipt);
      receiptRemaining = Number(usage?.remainingUSD) || 0;
    }

    const plannedSpend = parseFloat(alloc.amountUSD) || 0;

    return `
      <div class="p-2 bg-slate-50 rounded-lg space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500">Paid Receipt #${idx + 1}</span>
          <button type="button" onclick="removeAdMergeFundingAllocation(${idx})" class="text-xs text-rose-500 hover:text-rose-600">Remove</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Receipt</label>
            <select class="w-full border border-slate-200 px-2 py-1.5 rounded-lg text-sm" onchange="updateAdMergeFundingReceipt(${idx}, this.value)">
              <option value="">Select...</option>
              ${optionsHtml}
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Use Amount (USD)</label>
            <input type="text" inputmode="decimal" class="w-full border border-slate-200 px-2 py-1.5 rounded-lg text-sm" value="${alloc.amountUSD || ''}" oninput="sanitizeMoneyInput(this); updateAdMergeFundingAmount(${idx}, this.value)" onfocus="this.select()" />
          </div>
        </div>
        ${receipt ? `
          <div class="text-[10px] text-slate-400">
            Available: <span class="text-emerald-600 font-medium">$${receiptRemaining.toFixed(2)}</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  refreshAdMergedFundingSummary();
  if (window.lucide) lucide.createIcons();
}

// Refresh the merged funding summary
function refreshAdMergedFundingSummary() {
  const summary = document.getElementById('ad-merged-funding-summary');
  if (!summary) return;
  
  initMergeFunding();
  const allocations = state.tempMergeFunding.allocations || [];
  
  if (allocations.length === 0) {
    summary.innerHTML = '';
    return;
  }
  
  const totalUSD = allocations.reduce((sum, a) => sum + (parseFloat(a.amountUSD) || 0), 0);
  summary.innerHTML = `<div class="flex items-center justify-between py-1">
    <span class="text-xs text-blue-600">Total from Paid Receipts</span>
    <span class="text-sm font-semibold text-blue-700">$${totalUSD.toFixed(2)}</span>
  </div>`;
}

function openTempDeliveryReceiptFromAd() {
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  if (!customerId) {
    showNotification('Validation', 'Select a customer first.', 'error');
    return;
  }
  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(customerId));
  const phone = customer?.phones?.[0] || '';
  const driverId = document.getElementById('ad-delivery-person')?.value || '';

  closeModal();
  state.activeModal = 'receipt';
  state.modalData = null;
  renderModal();

  setTimeout(() => {
    try {
      if (phone) selectReceiptPhone(phone, customerId);
      const btn = document.querySelector('#receipt-status-tabs button[data-status="Not Paid"]');
      if (btn) setReceiptStatus(btn, 'Not Paid');
      selectNotPaidCollection('delivery');
      const dp = document.getElementById('notpaid-delivery-person');
      if (dp && driverId) dp.value = driverId;
      updateReceiptStatusUI('Not Paid');
    } catch (e) {
      console.warn('openTempDeliveryReceiptFromAd failed:', e);
    }
  }, 160);
}

// Filter customers in multi-customer selection
function filterAdCustomers(searchTerm) {
  const term = searchTerm.toLowerCase();
  document.querySelectorAll('.ad-customer-btn').forEach(btn => {
    const customerName = btn.dataset.customerName || '';
    btn.style.display = customerName.includes(term) ? '' : 'none';
  });
}

// Filter pages dropdown
function filterAdPages() {
  const input = document.getElementById('ad-page-search');
  const term = (input?.value || '').toLowerCase();
  document.querySelectorAll('#ad-page-dropdown .page-option').forEach(opt => {
    const name = opt.dataset.name || '';
    opt.style.display = name.includes(term) ? '' : 'none';
  });
  showAdPageDropdown();
}

function showAdPageDropdown() {
  const dropdown = document.getElementById('ad-page-dropdown');
  if (dropdown) dropdown.classList.remove('hidden');
}

function hideAdPageDropdown() {
  const dropdown = document.getElementById('ad-page-dropdown');
  if (dropdown) dropdown.classList.add('hidden');
}

// Hide dropdown when clicking outside
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('ad-page-dropdown');
  const search = document.getElementById('ad-page-search');
  if (dropdown && search && !dropdown.contains(e.target) && e.target !== search) {
    dropdown.classList.add('hidden');
  }
});

function toggleAdDriver() {
  const deliverySelect = document.getElementById('ad-delivery');
  const driverContainer = document.getElementById('ad-driver-container');
  if (!deliverySelect || !driverContainer) return;
  driverContainer.classList.toggle('hidden', !deliverySelect.value);
}

// Add ad link input dynamically
function addAdLinkInput(value = '') {
  const list = document.getElementById('ad-links-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'ad-link-row flex space-x-2 items-center';
  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://...';
  input.className = 'ad-link-input flex-1 glass-input px-3 py-2 rounded-lg text-sm';
  input.value = value || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-xs text-rose-600 hover:text-rose-700 px-2 py-1';
  btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>';
  btn.onclick = () => { row.remove(); lucide.createIcons(); };
  row.appendChild(input);
  row.appendChild(btn);
  list.appendChild(row);
  lucide.createIcons();
}

// Set Ad Payment Status (Paid / Not Paid)
function setAdPaymentStatus(status) {
  const paidBtn = document.getElementById('ad-pay-status-paid');
  const notPaidBtn = document.getElementById('ad-pay-status-not-paid');
  const wontPayBtn = document.getElementById('ad-pay-status-wont');
  const hiddenInput = document.getElementById('ad-payment-status');
  const notPaidOptions = document.getElementById('ad-not-paid-options');
  const receiptFunding = document.getElementById('ad-receipt-funding-section');
  const unpaidFinancial = document.getElementById('ad-unpaid-financial');
  
  if (!paidBtn || !notPaidBtn || !wontPayBtn || !hiddenInput) {
    console.error('Payment status buttons not found');
    return;
  }
  
  // Update hidden input
  hiddenInput.value = status;
  
  // Paid button
  if (status === 'paid') {
    paidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30';
    const paidIcon = paidBtn.querySelector('i');
    const paidSpan = paidBtn.querySelector('span');
    if (paidIcon) paidIcon.className = 'w-4 h-4 text-emerald-600';
    if (paidSpan) paidSpan.className = 'font-semibold text-sm text-emerald-700 dark:text-emerald-400';
  } else {
    paidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-slate-200 dark:border-slate-700 hover:border-emerald-300';
    const paidIcon = paidBtn.querySelector('i');
    const paidSpan = paidBtn.querySelector('span');
    if (paidIcon) paidIcon.className = 'w-4 h-4 text-slate-400';
    if (paidSpan) paidSpan.className = 'font-semibold text-sm text-slate-500';
  }

  // Not Paid button
  if (status === 'not_paid') {
    notPaidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-amber-500 bg-amber-50 dark:bg-amber-900/30';
    const notPaidIcon = notPaidBtn.querySelector('i');
    const notPaidSpan = notPaidBtn.querySelector('span');
    if (notPaidIcon) notPaidIcon.className = 'w-4 h-4 text-amber-600';
    if (notPaidSpan) notPaidSpan.className = 'font-semibold text-sm text-amber-700 dark:text-amber-400';
  } else {
    notPaidBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-slate-200 dark:border-slate-700 hover:border-amber-300';
    const notPaidIcon = notPaidBtn.querySelector('i');
    const notPaidSpan = notPaidBtn.querySelector('span');
    if (notPaidIcon) notPaidIcon.className = 'w-4 h-4 text-slate-400';
    if (notPaidSpan) notPaidSpan.className = 'font-semibold text-sm text-slate-500';
  }

  // Won't Pay button
  if (status === 'wont_pay') {
    wontPayBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-rose-500 bg-rose-50 dark:bg-rose-900/30';
    const wontIcon = wontPayBtn.querySelector('i');
    const wontSpan = wontPayBtn.querySelector('span');
    if (wontIcon) wontIcon.className = 'w-4 h-4 text-rose-600';
    if (wontSpan) wontSpan.className = 'font-semibold text-sm text-rose-700 dark:text-rose-400';
  } else {
    wontPayBtn.className = 'p-3 rounded-xl border-2 transition-all duration-200 flex items-center justify-center space-x-2 border-slate-200 dark:border-slate-700 hover:border-rose-300';
    const wontIcon = wontPayBtn.querySelector('i');
    const wontSpan = wontPayBtn.querySelector('span');
    if (wontIcon) wontIcon.className = 'w-4 h-4 text-slate-400';
    if (wontSpan) wontSpan.className = 'font-semibold text-sm text-slate-500';
  }

  // Toggle sections
  const wontPaySection = document.getElementById('ad-wont-pay-section');
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  
  if (status === 'paid') {
    if (notPaidOptions) notPaidOptions.classList.add('hidden');
    if (receiptFunding) receiptFunding.classList.remove('hidden');
    if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
    if (wontPaySection) wontPaySection.classList.add('hidden');
    setAdCollectionMethod('');
    // Ensure Receipt Funding list renders immediately (prevents "blank" feeling)
    renderAdFundingList();
    // UX: when creating a new Ad, jump straight to Receipt Funding so users don't think it's missing.
    if (!state.modalData) {
      setTimeout(() => {
        try {
          // Scroll the whole modal panel (header + form) to avoid confusion about where to scroll.
          const scroller = document.getElementById('app-modal')?.firstElementChild || document.getElementById('modal-form');
          const target = document.getElementById('ad-receipt-funding-section');
          if (!scroller || !target) return;
          const scrollerRect = scroller.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const delta = targetRect.top - scrollerRect.top;
          scroller.scrollBy({ top: Math.max(delta - 8, 0), behavior: 'smooth' });
        } catch (e) {
          // no-op
        }
      }, 0);
    }
  } else if (status === 'not_paid') {
    if (notPaidOptions) notPaidOptions.classList.remove('hidden');
    if (receiptFunding) receiptFunding.classList.add('hidden');
    // Hide financial details if driver (receipt already has them)
    if (collectionMethod === 'driver') {
      if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
    } else {
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
    }
    if (wontPaySection) wontPaySection.classList.add('hidden');
  } else {
    // wont_pay
    if (notPaidOptions) notPaidOptions.classList.add('hidden');
    if (receiptFunding) receiptFunding.classList.add('hidden');
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
    if (wontPaySection) wontPaySection.classList.remove('hidden');
    setAdCollectionMethod('');
  }
  
  lucide.createIcons();
  refreshAdTempReceiptOptions();
}

// Set Ad Collection Method (In Shop / Driver)
function setAdCollectionMethod(method) {
  const shopBtn = document.getElementById('ad-collect-shop');
  const driverBtn = document.getElementById('ad-collect-driver');
  const hiddenInput = document.getElementById('ad-collection-method');
  const collectionDetails = document.getElementById('ad-collection-details');
  const driverSelect = document.getElementById('ad-driver-select');
  
  if (!shopBtn || !driverBtn || !hiddenInput) return;
  
  // Update hidden input
  hiddenInput.value = method;
  
  // Reset all buttons
  const resetBtn = (btn, hoverBorder) => {
    if (!btn) return;
    btn.className = `p-2.5 rounded-lg border-2 transition-all duration-200 flex flex-col items-center space-y-1 border-slate-200 dark:border-slate-600 hover:${hoverBorder} bg-white dark:bg-slate-800`;
    const icon = btn.querySelector('i');
    const span = btn.querySelector('span');
    if (icon) icon.className = 'w-4 h-4 text-slate-400';
    if (span) span.className = 'text-[10px] font-medium text-slate-500';
  };
  
  resetBtn(shopBtn, 'border-blue-300');
  resetBtn(driverBtn, 'border-violet-300');
  
  // If cleared, hide collection details and stop
  if (!method) {
    if (collectionDetails) collectionDetails.classList.add('hidden');
    if (driverSelect) driverSelect.classList.add('hidden');
    lucide.createIcons();
    refreshAdTempReceiptOptions();
    return;
  }
  
  // Show collection details section
  if (collectionDetails) collectionDetails.classList.remove('hidden');
  
  // Activate selected button
  const unpaidFinancial = document.getElementById('ad-unpaid-financial');
  if (method === 'in_shop') {
    shopBtn.className = 'p-2.5 rounded-lg border-2 transition-all duration-200 flex flex-col items-center space-y-1 border-blue-500 bg-blue-50 dark:bg-blue-900/30';
    const shopIcon = shopBtn.querySelector('i');
    const shopSpan = shopBtn.querySelector('span');
    if (shopIcon) shopIcon.className = 'w-4 h-4 text-blue-600';
    if (shopSpan) shopSpan.className = 'text-[10px] font-medium text-blue-700 dark:text-blue-400';
    // Hide driver select for in shop
    if (driverSelect) driverSelect.classList.add('hidden');
    // Show financial details for in shop
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
  } else if (method === 'driver') {
    driverBtn.className = 'p-2.5 rounded-lg border-2 transition-all duration-200 flex flex-col items-center space-y-1 border-violet-500 bg-violet-50 dark:bg-violet-900/30';
    const driverIcon = driverBtn.querySelector('i');
    const driverSpan = driverBtn.querySelector('span');
    if (driverIcon) driverIcon.className = 'w-4 h-4 text-violet-600';
    if (driverSpan) driverSpan.className = 'text-[10px] font-medium text-violet-700 dark:text-violet-400';
    // Driver select is HIDDEN (driver is assigned in the receipt)
    if (driverSelect) driverSelect.classList.add('hidden');
    // Hide financial details for driver (receipt already has them)
    if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
  }
  
  lucide.createIcons();
  refreshAdTempReceiptOptions();
}

// Update number of days based on start/end dates
function parseDateInputAsUTC(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split('-').map(n => parseInt(n, 10));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUTCDateForInput(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function updateAdDays() {
  const startInput = document.getElementById('ad-start-date');
  const endInput = document.getElementById('ad-end-date');
  const daysInput = document.getElementById('ad-days');
  if (!startInput || !endInput || !daysInput) return;
  const start = parseDateInputAsUTC(startInput.value);
  const end = parseDateInputAsUTC(endInput.value);
  if (!start || !end) {
    daysInput.value = '';
    return;
  }
  const diffMs = end.getTime() - start.getTime();
  const diffDays = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  daysInput.value = diffDays;

  // Refresh photo previews if present (helps after re-render)
  renderReceiptPhotoPreviews();
}

// Update end date based on start date + days (editable Days field)
function updateAdEndDateFromDays() {
  const startInput = document.getElementById('ad-start-date');
  const endInput = document.getElementById('ad-end-date');
  const daysInput = document.getElementById('ad-days');
  if (!startInput || !endInput || !daysInput) return;

  // Ensure start date exists
  if (!startInput.value) startInput.value = getTodayDateString();

  const start = parseDateInputAsUTC(startInput.value);
  if (!start) return;

  const raw = String(daysInput.value ?? '').trim();
  if (!raw) return;

  let days = parseInt(raw, 10);
  if (!Number.isFinite(days)) return;
  if (days < 0) days = 0;

  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  endInput.value = formatUTCDateForInput(end);
}

// Upload and preview ad photos
function uploadAdPhotos(fileList) {
  if (!fileList || !fileList.length) return;
  state.tempAdPhotos = state.tempAdPhotos || [];
  Array.from(fileList).forEach(file => {
    compressImageToDataUrl(file).then((dataUrl) => {
      if (!dataUrl) return;
      state.tempAdPhotos.push(dataUrl);
      renderAdPhotoPreviews();
    }).catch(() => {});
  });
}

function renderAdPhotoPreviews() {
  const container = document.getElementById('ad-photo-previews');
  if (!container) return;
  const photos = state.tempAdPhotos || [];
  if (!photos.length) {
    container.innerHTML = `<div class="text-xs text-slate-400 col-span-4">No photos yet. Click "Add Photo" to upload.</div>`;
    return;
  }
  container.innerHTML = photos.map((src, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <img src="${Security.escapeHtml(src)}" class="w-full h-20 object-cover" />
      <button type="button" onclick="removeAdPhoto(${idx})" class="absolute top-1 right-1 bg-white/80 dark:bg-slate-900/80 rounded-full p-1 shadow hover:bg-rose-100">
        <i data-lucide="x" class="w-3 h-3 text-rose-600"></i>
      </button>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function removeAdPhoto(idx) {
  if (!state.tempAdPhotos) return;
  state.tempAdPhotos.splice(idx, 1);
  renderAdPhotoPreviews();
}

// Update totals for ad unpaid financial details (reuses receipt totals calculation)
function updateAdUnpaidTotals() {
  updateReceiptTotals();
}

// Update ad status directly from list view
function updateAdStatusFromList(adId, status) {
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  updateRecord(state.ads, adId, { status: status });
  addLog('status_change', 'ad', adId, `Changed status to: ${status}`);
  render();
}

function updateAdDeliveryStatus(adId, deliveryStatus) {
  // Permission check
  if (!currentUserHasPermission('deliveries', 'assign') && !currentUserHasPermission('ads', 'edit')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لتغيير حالة التوصيل' : 'You do not have permission to change delivery status', 'error');
    return;
  }
  const ad = state.ads.find(a => a.id === adId);
  if (!ad) return;
  updateRecord(state.ads, adId, { deliveryStatus: deliveryStatus });
  addLog('delivery_status_change', 'ad', adId, `Changed delivery status to: ${deliveryStatus}`);
  showNotification('Updated', `Delivery status changed to ${deliveryStatus}`, 'success');
  render();
}

// Receipt photos helpers
function uploadReceiptPhotos(fileList) {
  if (!fileList || !fileList.length) return;
  state.tempReceiptPhotos = state.tempReceiptPhotos || [];
  Array.from(fileList).forEach(file => {
    compressImageToDataUrl(file).then((dataUrl) => {
      if (!dataUrl) return;
      state.tempReceiptPhotos.push(dataUrl);
      renderReceiptPhotoPreviews();
    }).catch(() => {});
  });
}

function renderReceiptPhotoPreviews() {
  const container = document.getElementById('receipt-photo-previews');
  if (!container) return;
  const photos = state.tempReceiptPhotos || [];
  if (!photos.length) {
    container.innerHTML = `<div class="text-xs text-slate-400 col-span-4">No photos yet. Click "Add Photo" to upload.</div>`;
    return;
  }
  container.innerHTML = photos.map((src, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <img src="${Security.escapeHtml(src)}" class="w-full h-20 object-cover" />
      <button type="button" onclick="removeReceiptPhoto(${idx})" class="absolute top-1 right-1 bg-white/80 dark:bg-slate-900/80 rounded-full p-1 shadow hover:bg-rose-100">
        <i data-lucide="x" class="w-3 h-3 text-rose-600"></i>
      </button>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function removeReceiptPhoto(idx) {
  if (!state.tempReceiptPhotos) return;
  state.tempReceiptPhotos.splice(idx, 1);
  renderReceiptPhotoPreviews();
}

// Update local amount display
function updateAdLocalAmount() {
  const amountInput = document.getElementById('ad-amount');
  const rateInput = document.getElementById('ad-rate');
  const displayEl = document.getElementById('ad-local-amount');
  
  if (!amountInput || !rateInput || !displayEl) return;
  
  const amount = parseFloat(amountInput.value) || 0;
  const rate = parseFloat(rateInput.value) || 1;
  const localAmount = amount * rate;
  
  displayEl.innerHTML = `Local: <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(localAmount.toLocaleString())} LYD</span>`;
}

function addAdFundingAllocation() {
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  state.tempAdFunding.allocations.push({ receiptId: '', amountUSD: 0 });
  renderAdFundingList();
}

function removeAdFundingAllocation(idx) {
  if (!state.tempAdFunding?.allocations) return;
  state.tempAdFunding.allocations.splice(idx, 1);
  renderAdFundingList();
}

function updateAdFundingReceipt(idx, receiptId) {
  if (!state.tempAdFunding?.allocations) return;
  const allocation = state.tempAdFunding.allocations[idx];
  if (!allocation) return;
  allocation.receiptId = receiptId;
  
  // Default to 0, but cap existing values at remaining if receipt is selected
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (receipt) {
    const remaining = getReceiptRemainingUSD(receipt);
    // If user already entered a value, cap it at remaining; otherwise default to 0
    if (allocation.amountUSD && parseFloat(allocation.amountUSD) > 0) {
      allocation.amountUSD = Math.min(remaining, parseFloat(allocation.amountUSD) || 0);
    } else {
      allocation.amountUSD = 0;
    }
  } else {
    allocation.amountUSD = 0;
  }
  renderAdFundingList();
  refreshAdFundingSummary();
}

// Money input validator (prevents multiple decimals, limits to 2 decimal places)
function sanitizeMoneyInput(input, maxDecimals = 2) {
  if (!input) return;
  let val = String(input.value || '');
  
  // Preserve cursor position
  const cursorPos = input.selectionStart || 0;
  
  // Remove everything except digits and first decimal point
  let clean = '';
  let hasDecimal = false;
  for (let i = 0; i < val.length; i++) {
    const c = val[i];
    if (c >= '0' && c <= '9') {
      clean += c;
    } else if (c === '.' && !hasDecimal) {
      clean += c;
      hasDecimal = true;
    }
  }
  
  // Limit decimal places
  if (hasDecimal && maxDecimals >= 0) {
    const parts = clean.split('.');
    if (parts[1] && parts[1].length > maxDecimals) {
      parts[1] = parts[1].substring(0, maxDecimals);
    }
    clean = parts.join('.');
  }
  
  // Only update if value changed
  if (input.value !== clean) {
    input.value = clean;
    // Restore cursor position (adjust for removed characters)
    const newCursorPos = Math.min(cursorPos, clean.length);
    input.setSelectionRange(newCursorPos, newCursorPos);
  }
}

function updateAdFundingAmount(idx, value) {
  if (!state.tempAdFunding?.allocations) return;
  const allocation = state.tempAdFunding.allocations[idx];
  if (!allocation) return;
  // Preserve raw string value to allow typing decimals (e.g., "4." -> "4.1")
  // Only store empty string if truly empty, otherwise keep the raw input
  const trimmed = String(value || '').trim();
  if (trimmed === '' || trimmed === '.') {
    allocation.amountUSD = '';
  } else {
    // Store as string to preserve decimal point during typing
    allocation.amountUSD = trimmed;
  }
  // Do NOT re-render the list here; it would replace the input element and break typing focus/caret.
  refreshAdFundingRow(idx);
  refreshAdFundingSummary();
}

function refreshAdFundingRow(idx) {
  const allocation = state.tempAdFunding?.allocations?.[idx];
  if (!allocation) return;

  const receiptId = allocation.receiptId;
  if (!receiptId) return;

  const receipt = state.receipts?.find(r => r.id === receiptId);
  if (!receipt) return;

  const remainingEl = document.getElementById(`ad-funding-remaining-${idx}`);
  const balanceEl = document.getElementById(`ad-funding-balance-${idx}`);
  const rateEl = document.getElementById(`ad-funding-rate-${idx}`);

  // If the details block isn't rendered yet (no receipt selected when list was rendered), skip.
  if (!remainingEl && !balanceEl && !rateEl) return;

  const usage = getReceiptUsageStats(receipt);
  const receiptRemaining = usage?.remainingUSD ?? 0;
  const plannedSpend = parseFloat(allocation.amountUSD) || 0;
  const balance = Math.max(receiptRemaining - plannedSpend, 0);
  const receiptRate = receipt?.exchangeRate || state.defaultExchangeRate || '-';

  if (remainingEl) remainingEl.textContent = `$${Number(receiptRemaining || 0).toFixed(2)}`;
  if (balanceEl) balanceEl.textContent = `$${Number(balance || 0).toFixed(2)}`;
  if (rateEl) rateEl.textContent = String(receiptRate);
}

function renderAdFundingList() {
  const list = document.getElementById('ad-funding-list');
  if (!list) return;

  try {
    const customerId = document.getElementById('ad-customer-id')?.value || '';
    const pageId = document.getElementById('ad-page')?.value || '';
    const paymentStatus = document.getElementById('ad-payment-status')?.value || 'paid';
    const allocations = state.tempAdFunding?.allocations || [];
    const selectedReceiptIds = new Set(allocations.map(a => String(a.receiptId || '')).filter(Boolean));

    // Only show receipts for this customer that still have remaining balance.
    // When editing an existing ad, keep currently-selected receipts visible even if their remaining is now 0.
    let receipts = [];
    try {
      receipts = getReceiptsForAd(customerId, pageId).filter(r => {
        if (!r) return false;
        if (selectedReceiptIds.has(String(r.id))) return true;
        const usage = getReceiptUsageStats(r);
        const remaining = usage?.remainingUSD ?? 0;
        return remaining > 0.0001;
      });
    } catch (filterErr) {
      console.error('Error filtering receipts for ad:', filterErr);
      receipts = [];
    }

  // Prefer latest receipts first (serialNumber desc if numeric, otherwise createdAt desc)
  receipts.sort((a, b) => {
    const aSerial = parseInt(String(a.serialNumber || ''), 10);
    const bSerial = parseInt(String(b.serialNumber || ''), 10);
    if (Number.isFinite(aSerial) && Number.isFinite(bSerial)) return bSerial - aSerial;
    const aTime = new Date(a.createdAt || a.startDate || 0).getTime();
    const bTime = new Date(b.createdAt || b.startDate || 0).getTime();
    return bTime - aTime;
  });
  
  if (!customerId) {
    // In the Ad modal, customer selection depends on picking a Page first.
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">Select a page & customer first</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  if (receipts.length === 0) {
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">No receipts with remaining balance</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  if (allocations.length === 0) {
    // In Paid mode, show the first allocation row automatically (old behavior),
    // so the user can immediately choose a receipt and amount without extra clicks.
    if (String(paymentStatus || '').toLowerCase() === 'paid') {
      state.tempAdFunding = state.tempAdFunding || { allocations: [] };
      state.tempAdFunding.allocations = [{ receiptId: '', amountUSD: '' }];
      renderAdFundingList();
      return;
    }
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">Click "+ Add" to link a receipt</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  list.innerHTML = allocations.map((alloc, idx) => {
    const receipt = receipts.find(r => r.id === alloc.receiptId);
    const optionsHtml = receipts.map(r => {
      const serial = r.serialNumber || r.finalReceiptNo || (r.id ? String(r.id).slice(0,6) : '???');
      const label = `#${serial} • $${(r.amountUSD || 0).toFixed(2)}`;
      return `<option value="${r.id || ''}" ${alloc.receiptId === r.id ? 'selected' : ''}>${Security.escapeHtml(label)}</option>`;
    }).join('');
    
    const receiptRate = receipt?.exchangeRate || state.defaultExchangeRate || '-';
    
    // Calculate remaining balance BEFORE any planned spend (full receipt remaining)
    let receiptRemaining = 0;
    if (receipt) {
      const usage = getReceiptUsageStats(receipt);
      receiptRemaining = Number(usage?.remainingUSD) || 0;
    }

    // Calculate balance = Remaining - Planned Spend
    const plannedSpend = parseFloat(alloc.amountUSD) || 0;
    const balance = Math.max(receiptRemaining - plannedSpend, 0);
    
    return `
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500 flex items-center gap-1"><i data-lucide="receipt" class="w-3 h-3"></i>Receipt Allocation #${idx + 1}</span>
          <button type="button" onclick="removeAdFundingAllocation(${idx})" class="text-xs text-rose-500 hover:text-rose-600">Remove</button>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Receipt</label>
            <select class="w-full glass-input px-2 py-1.5 rounded-lg text-sm" onchange="updateAdFundingReceipt(${idx}, this.value)">
              <option value="">Select...</option>
              ${optionsHtml}
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">Planned Spend (USD)</label>
            <input type="text" inputmode="decimal" class="w-full glass-input px-2 py-1.5 rounded-lg text-sm" value="${alloc.amountUSD || ''}" oninput="sanitizeMoneyInput(this); updateAdFundingAmount(${idx}, this.value)" onfocus="this.select()" />
          </div>
        </div>
        ${receipt ? `
          <div class="text-[10px] text-slate-400 space-y-0.5">
            <div>Remaining: <span id="ad-funding-remaining-${idx}" class="text-emerald-600 dark:text-emerald-400 font-medium">$${receiptRemaining.toFixed(2)}</span></div>
            <div>Balance: <span id="ad-funding-balance-${idx}" class="text-blue-600 dark:text-blue-400 font-medium">$${balance.toFixed(2)}</span></div>
            <div>Rate: <span id="ad-funding-rate-${idx}" class="text-slate-600 dark:text-slate-300">${receiptRate}</span></div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  refreshAdFundingSummary();
  if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error rendering ad funding list:', err);
    list.innerHTML = `<div class="py-3 text-center text-xs text-rose-500">Error loading receipts. Please refresh.</div>`;
  }
}

function refreshAdFundingSummary() {
  const summary = document.getElementById('ad-funding-summary');
  if (!summary) return;
  
  const allocations = state.tempAdFunding?.allocations || [];
  
  if (allocations.length === 0) {
    summary.innerHTML = '';
    return;
  }
  
  // Calculate total balance (sum of all balances: Remaining - Planned Spend per allocation)
  let totalBalance = 0;
  allocations.forEach(a => {
    if (a.receiptId) {
      const receipt = state.receipts.find(r => r.id === a.receiptId);
      if (receipt) {
        const usage = getReceiptUsageStats(receipt);
        const receiptRemaining = usage.remainingUSD;
        const plannedSpend = parseFloat(a.amountUSD) || 0;
        const balance = Math.max(receiptRemaining - plannedSpend, 0);
        totalBalance += balance;
      }
    }
  });
  
  summary.innerHTML = `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-xs text-slate-500">Total Balance</span>
      <span class="text-sm font-semibold ${totalBalance > 0 ? 'text-emerald-600' : 'text-slate-500'}">$${totalBalance.toFixed(2)}</span>
    </div>
  `;
}

// Beautiful button selection for Refund Status
function selectRefundStatus(value) {
  const input = document.getElementById('status-cancel-refund-status');
  if (input) input.value = value;
  
  document.querySelectorAll('.refund-status-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    btn.className = 'refund-status-btn flex-1 py-2.5 px-4 rounded-xl text-sm font-bold transition-all duration-300';
    
    if (isSelected) {
      if (btnValue === 'pending') {
        btn.className += ' bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30';
      } else {
        btn.className += ' bg-gradient-to-r from-emerald-400 to-green-500 text-white shadow-lg shadow-emerald-500/30';
      }
    } else {
      btn.className += ' bg-white/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-amber-300';
    }
  });
  
  if (window.lucide) lucide.createIcons();
}

// Beautiful button selection for Not Paid collection method
function selectNotPaidCollection(value) {
  const input = document.getElementById('notpaid-collection-value');
  if (input) input.value = value;
  
  document.querySelectorAll('.notpaid-collection-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    btn.className = 'notpaid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300';
    
    if (isSelected) {
      if (btnValue === 'office') {
        btn.className += ' bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]';
      } else {
        btn.className += ' bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]';
      }
      
      // Update inner elements
      const iconBg = btn.querySelector('span.w-12');
      if (iconBg) iconBg.className = 'w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center shadow-inner';
      btn.querySelectorAll('i').forEach(i => {
        i.className = i.className.replace(/text-\w+-\d+/g, '').replace('dark:text-blue-400', '').replace('dark:text-emerald-400', '') + ' text-white';
      });
      btn.querySelectorAll('.font-bold').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-200', '') + ' text-white';
      });
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-400', '') + ' text-white/70';
      });
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:shadow-lg';
    }
  });
  
  // Show/hide delivery person selector based on selection
  const deliveryPersonSection = document.getElementById('notpaid-delivery-person-section');
  if (deliveryPersonSection) {
    if (value === 'delivery') {
      deliveryPersonSection.classList.remove('hidden');
    } else {
      deliveryPersonSection.classList.add('hidden');
    }
  }

  // Temp delivery receipt UX: show required delivery info + auto temp number.
  const status = document.getElementById('receipt-status')?.value || 'Paid';
  if (status === 'Not Paid') {
    updateReceiptStatusUI(status);
  }
  
  if (window.lucide) lucide.createIcons();
}

// Beautiful button selection for Paid collection method
function selectPaidCollection(value) {
  const input = document.getElementById('paid-collection-value');
  if (input) input.value = value;

  document.querySelectorAll('.paid-collection-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;

    btn.className = 'paid-collection-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300';

    if (isSelected) {
      if (btnValue === 'office') {
        btn.className += ' bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-xl shadow-blue-500/30 scale-[1.02]';
      } else {
        btn.className += ' bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]';
      }

      const iconBg = btn.querySelector('span.w-12');
      if (iconBg) iconBg.className = 'w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center shadow-inner';
      btn.querySelectorAll('i').forEach(i => {
        i.className = i.className.replace(/text-\w+-\d+/g, '').replace('dark:text-blue-400', '').replace('dark:text-emerald-400', '') + ' text-white';
      });
      btn.querySelectorAll('.font-bold').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-200', '') + ' text-white';
      });
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-400', '') + ' text-white/70';
      });
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:shadow-lg';
    }
  });

  // Show/hide delivery person selector based on selection
  const deliveryPersonSection = document.getElementById('paid-delivery-person-section');
  if (deliveryPersonSection) {
    if (value === 'delivery') {
      deliveryPersonSection.classList.remove('hidden');
    } else {
      deliveryPersonSection.classList.add('hidden');
      const sel = document.getElementById('paid-delivery-person');
      if (sel) sel.value = '';
    }
  }
  
  if (window.lucide) lucide.createIcons();
}

// Beautiful button selection for Lost options
function selectLostOption(value) {
  const input = document.getElementById('status-lost-resolution');
  if (input) input.value = value;
  
  document.querySelectorAll('.lost-option-btn').forEach(btn => {
    const btnValue = btn.dataset.value;
    const isSelected = btnValue === value;
    
    btn.className = 'lost-option-btn group relative overflow-hidden p-4 rounded-xl text-center transition-all duration-300';
    
    if (isSelected) {
      if (btnValue === 'empty') {
        btn.className += ' bg-gradient-to-br from-slate-600 to-slate-700 text-white shadow-xl shadow-slate-500/30 scale-[1.02]';
      } else {
        btn.className += ' bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-xl shadow-emerald-500/30 scale-[1.02]';
      }
      
      // Update inner elements
      const iconBg = btn.querySelector('span.w-12');
      if (iconBg) iconBg.className = 'w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center shadow-inner';
      btn.querySelectorAll('i').forEach(i => {
        i.className = i.className.replace(/text-\w+-\d+/g, '').replace('dark:text-slate-400', '').replace('dark:text-emerald-400', '') + ' text-white';
      });
      btn.querySelectorAll('.font-bold').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-200', '') + ' text-white';
      });
      btn.querySelectorAll('.text-\\[10px\\]').forEach(el => {
        el.className = el.className.replace(/text-slate-\d+/g, '').replace('dark:text-slate-400', '') + ' text-white/70';
      });
    } else {
      btn.className += ' bg-white/80 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 hover:shadow-lg';
    }
  });
  
  if (window.lucide) lucide.createIcons();
}

function addInlineSplit(data = null) {
  const container = document.getElementById('inline-splits-container');
  const index = container.children.length;
  
  const div = document.createElement('div');
  div.className = 'split-card bg-white border border-slate-200 rounded-xl p-4 relative shadow-sm transition-all hover:shadow-md';
  
  const method = data?.method || 'Cash (LYD)';
  const amount = data?.amount || '';
  const rate1 = data?.rate || 1;
  const rate2 = data?.rate2 !== undefined ? data.rate2 : state.defaultExchangeRate;
  const collection = data?.collectionType || 'office';
  
  div.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <div class="flex items-center space-x-2">
        <i data-lucide="credit-card" class="w-4 h-4 text-slate-400"></i>
        <span class="text-xs font-bold text-slate-500 uppercase tracking-wider">PAYMENT #${index + 1}</span>
      </div>
      <button type="button" onclick="this.closest('.split-card').remove(); updateReceiptTotals();" class="text-slate-300 hover:text-rose-500 transition-colors">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>

    <div class="grid grid-cols-12 gap-4 mb-4">
      <div class="col-span-5">
        <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Payment Method</label>
        <select class="split-method w-full bg-slate-50 border-none text-sm font-medium rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500/20" onchange="updateReceiptTotals()">
          ${PAYMENT_METHODS.map(m => `<option value="${m}" ${method === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="col-span-4">
        <label class="block text-[10px] font-bold text-slate-400 uppercase mb-1">Amount</label>
        <input type="text" inputmode="decimal" class="split-amount w-full bg-slate-50 border-none text-lg font-bold text-slate-800 rounded-lg px-3 py-1 focus:ring-2 focus:ring-indigo-500/20" oninput="sanitizeMoneyInput(this)" 
          value="${amount}" placeholder="0" oninput="updateReceiptTotals()" />
      </div>
      <div class="col-span-3 space-y-2">
        <div class="flex items-center">
          <label class="text-[10px] font-bold text-slate-400 w-12">RATE 1:</label>
          <input type="text" inputmode="decimal" class="split-rate1 w-full bg-slate-50 border-none text-xs font-mono rounded px-2 py-1 text-right" oninput="sanitizeMoneyInput(this, 4)" 
            value="${rate1}" oninput="updateReceiptTotals()" />
        </div>
        <div class="flex items-center">
          <label class="text-[10px] font-bold text-slate-400 w-12">RATE 2:</label>
          <input type="text" inputmode="decimal" class="split-rate2 w-full bg-slate-50 border-none text-xs font-mono rounded px-2 py-1 text-right" oninput="sanitizeMoneyInput(this, 4)" 
            value="${rate2}" oninput="updateReceiptTotals()" />
        </div>
      </div>
    </div>

    <div class="flex justify-between items-end border-t border-slate-100 pt-3">
      <div class="space-y-1">
        <div class="text-[10px] text-slate-400 font-mono">R1: <span class="split-r1-display font-bold text-slate-600">0.00 LYD</span></div>
        <div class="text-[10px] text-slate-400 font-mono">R2: <span class="split-r2-display font-bold text-slate-600">0.00 USD</span></div>
      </div>
      
      <div>
        <div class="flex bg-slate-100 p-0.5 rounded-lg">
          <button type="button" onclick="toggleCollection(this, 'office')" 
            class="px-3 py-1 text-[10px] font-bold rounded-md transition-all ${collection === 'office' ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}">
            In Shop
          </button>
          <button type="button" onclick="toggleCollection(this, 'delivery')" 
            class="px-3 py-1 text-[10px] font-bold rounded-md transition-all ${collection === 'delivery' ? 'bg-white shadow text-indigo-600' : 'text-slate-400 hover:text-slate-600'}">
            Delivery
          </button>
          <input type="hidden" class="split-collection" value="${collection}">
        </div>
      </div>
    </div>
  `;
  
  container.appendChild(div);
  lucide.createIcons();
  updateReceiptTotals();
}

function toggleCollection(btn, type) {
  const wrapper = btn.parentElement;
  const input = wrapper.querySelector('input');
  input.value = type;
  
  const buttons = wrapper.querySelectorAll('button');
  buttons.forEach(b => {
    b.className = 'px-3 py-1 text-[10px] font-bold rounded-md transition-all text-slate-400 hover:text-slate-600';
  });
  
  btn.className = 'px-3 py-1 text-[10px] font-bold rounded-md transition-all bg-white shadow text-indigo-600';
}

// REMOVED DUPLICATE updateReceiptTotals() - the correct version is defined earlier in the file

// Dynamic field management for modals
function addPhoneField() {
  const container = document.getElementById('phone-fields-container');
  const div = document.createElement('div');
  div.className = 'flex items-center space-x-2 phone-field-group';
  div.innerHTML = `
    <input type="tel" class="customer-phone flex-1 glass-input px-4 py-2 rounded-xl" placeholder="Phone number" />
    <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
      <i data-lucide="trash-2" class="w-4 h-4"></i>
    </button>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

function addProfileLinkField() {
  const container = document.getElementById('profile-links-container');
  // Remove "no links" message if it exists
  const emptyMsg = container.querySelector('div.text-center');
  if (emptyMsg) emptyMsg.remove();
  
  const div = document.createElement('div');
  div.className = 'flex items-center space-x-2 link-field-group';
  div.innerHTML = `
    <input type="url" class="customer-link flex-1 glass-input px-4 py-2 rounded-xl" placeholder="https://facebook.com/..." />
    <button type="button" onclick="this.parentElement.remove(); lucide.createIcons()" class="text-rose-600 hover:text-rose-700">
      <i data-lucide="trash-2" class="w-4 h-4"></i>
    </button>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

// CRUD Operations
function showCustomerModal() {
  // Permission check for creating customers
  if (!currentUserHasPermission('customers', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإضافة عملاء' : 'You do not have permission to add customers', 'error');
    return;
  }
  state.activeModal = 'customer';
  state.modalData = null;
  updateUrlParams({ modal: 'customer', id: 'new' }); // URL tracking
  renderModal();
}

function showPageModal() {
  // Permission check for creating pages
  if (!currentUserHasPermission('pages', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإضافة صفحات' : 'You do not have permission to add pages', 'error');
    return;
  }
  state.activeModal = 'page';
  state.modalData = null;
  updateUrlParams({ modal: 'page', id: 'new' }); // URL tracking
  renderModal();
}

function showAdModal() {
  // Permission check for creating ads
  if (!currentUserHasPermission('ads', 'add')) {
    showNotification('Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء إعلانات' : 'You do not have permission to create ads', 'error');
    return;
  }
  if (getVisibleRecords(state.customers).length === 0) {
    showNotification('No Customers', 'Please add a customer first', 'warning');
    return;
  }
  state.activeModal = 'ad';
  state.modalData = null;
  updateUrlParams({ modal: 'ad', id: 'new' }); // URL tracking for new ad
  renderModal();
}

function showUserModal() {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', state.language === 'ar' ? 'هذه الميزة للأدمن فقط' : 'Admin only', 'error');
    return;
  }
  state.activeModal = 'user';
  state.modalData = null;
  updateUrlParams({ modal: 'user', id: 'new' }); // URL tracking
  renderModal();
}

// Update role info display in user modal
function updateUserRoleInfo(role) {
  const roleIcon = document.getElementById('role-icon');
  const roleTitle = document.getElementById('role-title');
  const roleDesc = document.getElementById('role-desc');
  const roleInfo = document.getElementById('role-info');
  
  if (!roleIcon || !roleTitle || !roleDesc) return;
  
  const roleConfig = {
    'Admin': {
      icon: 'crown',
      title: 'Full Administrator',
      desc: 'Complete access to all features. No restrictions.',
      bgColor: 'bg-amber-100 dark:bg-amber-900/30',
      iconColor: 'text-amber-600',
      badge: '<span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">ALL ACCESS</span>'
    },
    'Delivery': {
      icon: 'truck',
      title: 'Delivery Driver',
      desc: 'Access to delivery operations only.',
      bgColor: 'bg-cyan-100 dark:bg-cyan-900/30',
      iconColor: 'text-cyan-600',
      badge: ''
    },
    'Employee': {
      icon: 'user-check',
      title: 'Employee',
      desc: 'Standard employee access. Customize permissions after creation.',
      bgColor: 'bg-emerald-100 dark:bg-emerald-900/30',
      iconColor: 'text-emerald-600',
      badge: ''
    }
  };
  
  const config = roleConfig[role] || roleConfig['Employee'];
  
  roleIcon.className = `w-10 h-10 rounded-xl flex items-center justify-center ${config.bgColor}`;
  roleIcon.innerHTML = `<i data-lucide="${config.icon}" class="w-5 h-5 ${config.iconColor}"></i>`;
  roleTitle.textContent = config.title;
  roleDesc.textContent = config.desc;
  
  // Update badge if exists
  const existingBadge = roleInfo.querySelector('span.rounded-lg');
  if (existingBadge) existingBadge.remove();
  
  if (config.badge) {
    const badgeDiv = document.createElement('div');
    badgeDiv.innerHTML = config.badge;
    roleInfo.querySelector('.flex').appendChild(badgeDiv.firstChild);
  }
  
  if (window.lucide) lucide.createIcons();
}

