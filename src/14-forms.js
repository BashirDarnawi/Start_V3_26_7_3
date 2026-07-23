// ==========================================
// CUSTOMER SEARCH / DROPDOWN UTILITIES
// ==========================================

// Click outside to close dropdown.
// CAPTURE phase (the `true`) is required: every suggestion dropdown lives
// inside a modal panel that carries onclick="event.stopPropagation()" (to keep
// inside-clicks from closing the modal), so a bubble-phase document listener
// never fires for taps inside the form — on phones (no Esc key, no hover) the
// open dropdown then covers the inputs below until the whole modal is lost.
// Capture fires on the way DOWN to the target, before that stopPropagation
// runs. Same fix as the delegated record-action listener further below.
// Selection still works: taps inside the dropdown are skipped by contains().
document.addEventListener('click', function(e) {
  const dropdowns = document.querySelectorAll('[id$="-dropdown"]');
  dropdowns.forEach(dropdown => {
    if (!dropdown.contains(e.target) && !e.target.id.includes('-search')) {
      dropdown.classList.add('hidden');
    }
  });
}, true);

// ==========================================
// RECEIPT MODAL HELPER FUNCTIONS
// ==========================================

function filterReceiptPhones() {
  const searchInput = document.getElementById('receipt-phone-search');
  const dropdown = document.getElementById('receipt-phone-dropdown');
  const searchTerm = searchInput.value.toLowerCase();
  
  const customers = getCustomersVisibleToCurrentUser();
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
  const isArF = state.language === 'ar';
  // BUG FIX: Check if array exists and has elements before accessing
  if (!Array.isArray(existingPayments) || existingPayments.length === 0) {
    return `<div class="text-xs text-slate-400 p-4">${isArF ? 'لا توجد دفعات معدة' : 'No payments configured'}</div>`;
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
            <span class="text-xs font-bold text-slate-500 uppercase">${isArF ? 'الدفعة رقم 1' : 'PAYMENT #1'}</span>
          </div>

          <div class="space-y-4">
            <!-- Payment Method & Amount Row -->
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">${isArF ? 'طريقة الدفع' : 'Payment Method'}</label>
                <select class="payment-method w-full glass-input px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-indigo-500/20" onchange="onPaymentMethodChange(this)">
                  ${paymentMethodOptions(payment.method).map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${trMethod(m)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">${isArF ? 'المبلغ' : 'Amount'}</label>
                <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-3 py-2 rounded-lg text-sm font-bold border border-slate-200 dark:border-slate-600 focus:ring-2 focus:ring-indigo-500/20" value="${payment.amount || 0}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptTotals()" />
              </div>
            </div>

            <!-- Rates Row -->
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <label class="text-[10px] font-bold text-slate-500 uppercase mb-1.5 block">${isArF ? 'السعر 1' : 'RATE 1'}</label>
                <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1.5 rounded text-xs font-medium text-center mb-2" value="${paymentRate1Value(payment)}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
                <div class="text-center pt-2 border-t border-slate-200 dark:border-slate-700">
                  <div class="text-[10px] font-bold text-slate-400 mb-0.5">R1:</div>
                  <span class="payment-r1-display text-sm font-bold text-indigo-600">0.00 LYD</span>
                </div>
              </div>
              <div class="bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                <label class="text-[10px] font-bold text-slate-500 uppercase mb-1.5 block">${isArF ? 'السعر 2' : 'RATE 2'}</label>
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
                <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">${isArF ? 'إجمالي المدفوع (LYD)' : 'TOTAL PAID (LYD)'}</div>
                <div class="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div id="receipt-total-lyd" class="text-xl font-bold text-slate-800 dark:text-white">0.00</div>
                  <div class="text-[10px] font-bold text-slate-400 mt-1">LYD</div>
                </div>
              </div>
              <div>
                <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">${isArF ? 'إجمالي رصيد الإعلانات (USD)' : 'TOTAL ADS CREDIT (USD)'}</div>
                <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                  <div id="receipt-total-usd" class="text-xl font-bold text-emerald-600">$0.00</div>
                  <div class="text-[10px] text-emerald-600/70 mt-1 leading-tight">${isArF ? 'مجموع كل الدفعات المحوّلة (باستثناء المبلغ 2)' : 'Sum of all converted payments (Excluding Amount 2)'}</div>
                </div>
              </div>
            </div>

            <!-- Footer Stats -->
            <div class="flex justify-between items-center pt-2 text-[10px] text-slate-400">
              <div>
                <div class="font-bold">${isArF ? 'صافي المدفوع (بعد الرسوم):' : 'Net Paid (After Fees):'}</div>
                <div id="receipt-net-paid" class="text-indigo-600 font-bold text-xs">0.00 LYD</div>
              </div>
              <div class="text-right">
                <div>${isArF ? 'سعر السوق' : 'Market Rate'}: <span id="receipt-market-rate" class="text-slate-600 dark:text-slate-300 font-bold">${state.defaultExchangeRate.toFixed(2)}</span></div>
                <div>${isArF ? 'متوسط السعر الفعلي' : 'Actual Avg Rate'}: <span id="receipt-avg-rate" class="text-emerald-600 font-bold">0.0000</span></div>
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
            <span class="text-xs font-bold text-slate-500 uppercase">${isArF ? `الدفعة رقم ${idx + 1}` : `PAYMENT #${idx + 1}`}</span>
          </div>
          <button type="button" onclick="removeReceiptPaymentSplit(this)" class="text-rose-500 hover:text-rose-700 transition-colors">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">${isArF ? 'طريقة الدفع' : 'Payment Method'}</label>
              <select class="payment-method w-full glass-input px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600" onchange="onPaymentMethodChange(this)">
                ${paymentMethodOptions(payment.method).map(m => `<option value="${m}" ${payment.method === m ? 'selected' : ''}>${trMethod(m)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">${isArF ? 'المبلغ' : 'Amount'}</label>
              <input type="text" inputmode="decimal" class="payment-amount w-full glass-input px-3 py-2 rounded-lg text-sm font-bold border border-slate-200 dark:border-slate-600" value="${payment.amount || 0}" placeholder="0" oninput="sanitizeMoneyInput(this); updateReceiptTotals()" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              <label class="text-[10px] font-bold text-slate-500 uppercase mb-1 block">${isArF ? 'السعر 1' : 'RATE 1'}</label>
              <input type="text" inputmode="decimal" class="payment-rate1 w-full glass-input px-2 py-1 rounded text-xs mb-1" value="${paymentRate1Value(payment)}" placeholder="1" oninput="sanitizeMoneyInput(this, 4); updateReceiptTotals()" />
              <div class="text-center pt-1 border-t border-slate-200 dark:border-slate-700">
                <span class="text-[9px] font-bold text-slate-400">R1: </span>
                <span class="payment-r1-display text-xs font-bold text-indigo-600">0.00 LYD</span>
              </div>
            </div>
            <div class="bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-200 dark:border-slate-700">
              <label class="text-[10px] font-bold text-slate-500 uppercase mb-1 block">${isArF ? 'السعر 2' : 'RATE 2'}</label>
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
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">${isArF ? 'إجمالي المدفوع (LYD)' : 'TOTAL PAID (LYD)'}</div>
            <div class="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
              <div id="receipt-total-lyd" class="text-xl font-bold text-slate-800 dark:text-white">0.00</div>
              <div class="text-[10px] font-bold text-slate-400 mt-1">LYD</div>
            </div>
          </div>
          <div>
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">${isArF ? 'إجمالي رصيد الإعلانات (USD)' : 'TOTAL ADS CREDIT (USD)'}</div>
            <div class="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
              <div id="receipt-total-usd" class="text-xl font-bold text-emerald-600">$0.00</div>
              <div class="text-[10px] text-emerald-600/70 mt-1">${isArF ? 'مجموع كل قيم R2' : 'Sum of all R2 values'}</div>
            </div>
          </div>
        </div>
        
        <div class="mt-3 px-4 py-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
          <div class="flex justify-between items-center text-xs">
            <div>
              <span class="text-slate-500 font-bold">${isArF ? 'صافي المدفوع:' : 'Net Paid:'}</span>
              <span id="receipt-net-paid" class="text-indigo-600 font-bold ml-1">0.00 LYD</span>
            </div>
            <div>
              <span class="text-slate-500 font-bold">${isArF ? 'سعر السوق:' : 'Market Rate:'}</span>
              <span id="receipt-market-rate" class="text-slate-600 font-bold ml-1">${state.defaultExchangeRate.toFixed(2)}</span>
            </div>
            <div>
              <span class="text-slate-500 font-bold">${isArF ? 'متوسط السعر:' : 'Avg Rate:'}</span>
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
      // Read Rate 1 as the preview does (`|| 0`) so a zero-rate method's
      // auto-filled 0.00 is honored instead of being replaced by the default
      // rate (which squared the stored exchange rate). See saveReceiptFromModal.
      rate: parseFloat(item.querySelector('.payment-rate1').value) || 0,
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
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'طرق الدفع غير معدة' : 'Payment methods not configured', 'error');
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
  const normalizedCustomerId = String(customerId || '').trim();
  const customer = getCustomersVisibleToCurrentUser()
    .find(c => String(c?.id || '') === normalizedCustomerId);
  if (!customer) return false;
  
  // Set customer ID
  document.getElementById('receipt-customer-id').value = normalizedCustomerId;
  
  // Update phone search
  document.getElementById('receipt-phone-search').value = phone;
  
  // Update customer name display
  document.getElementById('receipt-customer-name').value = customer.name;
  
  // Hide dropdown
  document.getElementById('receipt-phone-dropdown')?.classList.add('hidden');

  // Editing pre-populates this same picker. Only a genuinely NEW receipt
  // needs the duplicate-money warning; the frozen hidden editing id is the
  // reliable source of truth even if mutable modal state changes underneath.
  const editingId = String(document.getElementById('receipt-editing-id')?.value || '').trim();
  if (state.activeModal === 'receipt' && !editingId) {
    requireReceiptCustomerRiskAcknowledgement(normalizedCustomerId);
  }
  return true;
}

// ==========================================
// NEW RECEIPT: EXISTING DEBT / BALANCE WARNING
// ==========================================

let _receiptCustomerRiskAcknowledgedSignature = '';
let _receiptCustomerRiskAcknowledgedCustomerId = '';
let _receiptCustomerRiskCurrentSignature = '';
let _receiptCustomerRiskCurrentCustomerId = '';
let _receiptCustomerRiskFormModal = null;
let _receiptCustomerRiskReturnFocus = null;

function _receiptCustomerRiskMoneyCents(value) {
  const amount = Number(value) || 0;
  return Math.max(Math.round((amount + Number.EPSILON) * 100), 0);
}

function _receiptCustomerRiskDebtUSD(receipt) {
  // Mirror the server's single-source debt rule. Historical records can retain
  // several debt fields that disagree, so taking the largest value would
  // invent money and overstate the warning.
  if (getReceiptPaymentState(receipt) === 'paid') {
    return Math.max(Number(receipt?.amountUSD) || 0, 0);
  }

  const collection = String(receipt?.statusDetail?.notPaidCollection || '').trim().toLowerCase();
  if (['office', 'in_shop', 'shop'].includes(collection)) {
    return Math.max(Number(receipt?.amountUSD) || 0, 0);
  }

  const localValue = receipt?.debtAmountLocal ?? receipt?.amountLocal;
  const local = Number(localValue) || 0;
  const rate = Number(receipt?.exchangeRate) || 0;
  if (local > 0 && rate > 0) return Math.max(local / rate, 0);

  const usdValue = receipt?.debtAmountUSD ?? receipt?.amountUSD;
  return Math.max(Number(usdValue) || 0, 0);
}

// Pure, permission-scoped classifier used by both selection-time and save-time
// guards. It intentionally warns for a fully allocated unpaid receipt: using
// its promised credit does not mean the customer has paid the debt.
function getReceiptCustomerRiskNotices(customerId) {
  const cid = String(customerId || '').trim();
  if (!Security.isValidRecordId(cid)) return [];

  const notices = [];
  for (const receipt of getReceiptsVisibleToCurrentUser()) {
    if (getReceiptCustomerReferenceId(receipt) !== cid) continue;

    const debtType = getReceiptDebtType(receipt);
    if (debtType !== 'none') {
      const amountUSD = _receiptCustomerRiskDebtUSD(receipt);
      const cents = _receiptCustomerRiskMoneyCents(amountUSD);
      if (cents < 1) continue;
      notices.push({ receipt, kind: 'debt', debtType, amountUSD: cents / 100, cents });
      continue;
    }

    if (getReceiptPaymentState(receipt) !== 'paid') continue;
    const remainingUSD = Math.max(Number(getReceiptUsageStats(receipt)?.remainingUSD) || 0, 0);
    const cents = _receiptCustomerRiskMoneyCents(remainingUSD);
    if (cents < 1) continue;
    notices.push({ receipt, kind: 'balance', amountUSD: cents / 100, cents });
  }

  return notices.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'debt' ? -1 : 1;
    const leftDate = new Date(left.receipt?.createdAt || left.receipt?.startDate || 0).getTime() || 0;
    const rightDate = new Date(right.receipt?.createdAt || right.receipt?.startDate || 0).getTime() || 0;
    return rightDate - leftDate;
  });
}

function _getReceiptCustomerRiskSnapshot(customerId) {
  const cid = String(customerId || '').trim();
  const notices = getReceiptCustomerRiskNotices(cid);
  const parts = notices
    .map(notice => `${notice.kind}:${notice.kind === 'debt' ? notice.debtType : 'balance'}:${String(notice.receipt?.id || '')}:${notice.cents}`)
    .sort();
  return {
    customerId: cid,
    notices,
    signature: parts.length ? `${cid}|${parts.join('|')}` : ''
  };
}

function resetReceiptCustomerRiskWarningState() {
  closeReceiptCustomerRiskWarning(false);
  _receiptCustomerRiskAcknowledgedSignature = '';
  _receiptCustomerRiskAcknowledgedCustomerId = '';
  _receiptCustomerRiskCurrentSignature = '';
  _receiptCustomerRiskCurrentCustomerId = '';
  _receiptCustomerRiskFormModal = null;
}

function closeReceiptCustomerRiskWarning(restoreFocus = true) {
  const warning = document.getElementById('receipt-customer-risk-warning');
  if (warning) warning.remove();

  const appModal = document.getElementById('app-modal');
  if (appModal) {
    appModal.inert = false;
    if (typeof appModal.removeAttribute === 'function') appModal.removeAttribute('aria-hidden');
    else appModal.setAttribute('aria-hidden', 'false');
  }

  const focusTarget = _receiptCustomerRiskReturnFocus;
  _receiptCustomerRiskReturnFocus = null;
  if (restoreFocus && focusTarget?.isConnected && typeof focusTarget.focus === 'function') {
    try { focusTarget.focus({ preventScroll: true }); } catch (_) { focusTarget.focus(); }
  }
}

function acknowledgeReceiptCustomerRiskWarning() {
  _receiptCustomerRiskAcknowledgedSignature = _receiptCustomerRiskCurrentSignature;
  _receiptCustomerRiskAcknowledgedCustomerId = _receiptCustomerRiskCurrentCustomerId;
  closeReceiptCustomerRiskWarning(true);
}

// Escape, Android Back, and "Choose another" all take this safe path. They do
// not silently accept the warning while leaving a risky customer selected.
function cancelReceiptCustomerRiskWarning() {
  const selectedId = String(document.getElementById('receipt-customer-id')?.value || '').trim();
  const shouldClear = !selectedId || selectedId === _receiptCustomerRiskCurrentCustomerId;
  closeReceiptCustomerRiskWarning(false);
  if (shouldClear) {
    const customerIdInput = document.getElementById('receipt-customer-id');
    const customerNameInput = document.getElementById('receipt-customer-name');
    const phoneInput = document.getElementById('receipt-phone-search');
    if (customerIdInput) customerIdInput.value = '';
    if (customerNameInput) customerNameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (phoneInput && typeof phoneInput.focus === 'function') phoneInput.focus();
  }
  _receiptCustomerRiskAcknowledgedSignature = '';
  _receiptCustomerRiskAcknowledgedCustomerId = '';
  _receiptCustomerRiskCurrentSignature = '';
  _receiptCustomerRiskCurrentCustomerId = '';
}

function viewReceiptFromCustomerRiskWarning(receiptId) {
  const rid = String(receiptId || '').trim();
  const visibleReceipt = Security.isValidRecordId(rid)
    ? getReceiptsVisibleToCurrentUser().find(receipt => String(receipt?.id || '') === rid)
    : null;
  if (!visibleReceipt) {
    showNotification(
      state.language === 'ar' ? 'تعذر فتح الوصل' : 'Cannot Open Receipt',
      state.language === 'ar' ? 'هذا الوصل غير متاح لك.' : 'This receipt is not available to you.',
      'error'
    );
    return false;
  }

  closeReceiptCustomerRiskWarning(false);
  closeModal();
  return openReceiptRecord(rid);
}

function _receiptCustomerRiskSectionHtml(kind, notices, isAr) {
  if (!notices.length) return '';
  const isDebt = kind === 'debt';
  const heading = isDebt
    ? (isAr ? `وصولات دين غير مدفوعة (${notices.length})` : `Unpaid debt receipts (${notices.length})`)
    : (isAr ? `وصولات مدفوعة برصيد متبقٍ (${notices.length})` : `Paid receipts with balance (${notices.length})`);
  const sectionClasses = isDebt
    ? 'border-rose-200 bg-rose-50/80 dark:border-rose-800 dark:bg-rose-900/20'
    : 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-800 dark:bg-emerald-900/20';
  const headingClasses = isDebt
    ? 'text-rose-700 dark:text-rose-300'
    : 'text-emerald-700 dark:text-emerald-300';

  return `
    <section class="rounded-2xl border p-3 ${sectionClasses}">
      <h3 class="mb-2 flex items-center gap-2 text-sm font-extrabold ${headingClasses}">
        <i data-lucide="${isDebt ? 'circle-alert' : 'wallet-cards'}" class="h-4 w-4"></i>${heading}
      </h3>
      <div class="space-y-2">
        ${notices.map((notice, index) => {
          const receipt = notice.receipt || {};
          const number = String(receipt.finalReceiptNo || receipt.serialNumber || receipt.tempReceiptNo || '').trim();
          const numberLabel = number
            ? `#${Security.escapeHtml(number)}`
            : `${isAr ? 'وصل' : 'Receipt'} ${index + 1}`;
          const rate = Number(receipt.exchangeRate || state.defaultExchangeRate || 0) || 0;
          const amountUSD = notice.cents / 100;
          const amountLocal = amountUSD * rate;
          const detail = isDebt
            ? (isAr
              ? `${notice.debtType === 'delivery' ? 'دين توصيل' : 'دين داخل المحل'} • لم يُدفع بعد`
              : `${notice.debtType === 'delivery' ? 'Delivery debt' : 'In-shop debt'} • Still unpaid`)
            : (isAr ? 'رصيد متاح يمكن استخدامه' : 'Available balance can still be used');
          return `
            <div class="flex flex-col gap-2 rounded-xl border border-white/80 bg-white/90 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/70 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <div class="font-extrabold text-slate-800 dark:text-white">${numberLabel}</div>
                <div class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">${detail}</div>
                <div class="mt-1 text-sm font-bold ${headingClasses}">$${amountUSD.toFixed(2)}${rate > 0 ? ` • ${amountLocal.toFixed(2)} LYD` : ''}</div>
              </div>
              <button type="button" data-receipt-id="${Security.escapeHtml(String(receipt.id || ''))}" onclick="viewReceiptFromCustomerRiskWarning(this.dataset.receiptId)" class="min-h-11 shrink-0 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200" aria-label="${Security.escapeHtml(isAr ? `عرض الوصل ${number || index + 1}` : `View receipt ${number || index + 1}`)}">
                ${isAr ? 'عرض الوصل' : 'View receipt'}
              </button>
            </div>`;
        }).join('')}
      </div>
    </section>`;
}

function showReceiptCustomerRiskWarning(customerId, snapshot = null) {
  const currentSnapshot = snapshot || _getReceiptCustomerRiskSnapshot(customerId);
  if (!currentSnapshot.signature || !currentSnapshot.notices.length) return false;

  const customer = getCustomersVisibleToCurrentUser()
    .find(item => String(item?.id || '') === currentSnapshot.customerId);
  if (!customer) return false;

  closeReceiptCustomerRiskWarning(false);
  _receiptCustomerRiskCurrentSignature = currentSnapshot.signature;
  _receiptCustomerRiskCurrentCustomerId = currentSnapshot.customerId;
  _receiptCustomerRiskReturnFocus = document.getElementById('receipt-customer-name')
    || document.getElementById('receipt-phone-search')
    || document.activeElement;

  const isAr = state.language === 'ar';
  const debtNotices = currentSnapshot.notices.filter(notice => notice.kind === 'debt');
  const balanceNotices = currentSnapshot.notices.filter(notice => notice.kind === 'balance');
  const customerName = Security.escapeHtml(String(customer.name || (isAr ? 'العميل' : 'Customer')));
  const warning = document.createElement('div');
  warning.id = 'receipt-customer-risk-warning';
  warning.className = 'mobile-dialog-overlay fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm sm:p-4';
  warning.setAttribute('role', 'alertdialog');
  warning.setAttribute('aria-modal', 'true');
  warning.setAttribute('aria-labelledby', 'receipt-customer-risk-title');
  warning.setAttribute('aria-describedby', 'receipt-customer-risk-description');
  warning.setAttribute('dir', isAr ? 'rtl' : 'ltr');
  warning.innerHTML = `
    <div class="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-2xl dark:border-amber-800 dark:bg-slate-900" onclick="event.stopPropagation()">
      <div class="shrink-0 border-b border-amber-100 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-900/20 sm:p-5">
        <div class="flex items-start gap-3">
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"><i data-lucide="triangle-alert" class="h-6 w-6"></i></span>
          <div class="min-w-0">
            <h2 id="receipt-customer-risk-title" tabindex="-1" class="text-lg font-extrabold text-slate-900 outline-none dark:text-white">${isAr ? 'تنبيه: لدى العميل وصولات موجودة' : 'Warning: this customer has existing receipts'}</h2>
            <p id="receipt-customer-risk-description" class="mt-1 text-sm text-slate-600 dark:text-slate-300">${isAr ? `قبل إنشاء وصل جديد للعميل <strong>${customerName}</strong>، راجع المعلومات التالية.` : `Before creating another receipt for <strong>${customerName}</strong>, review the information below.`}</p>
          </div>
        </div>
        <p class="mt-3 rounded-xl bg-white/80 p-3 text-xs font-semibold text-amber-900 dark:bg-slate-900/60 dark:text-amber-200">${isAr ? 'أنشئ وصلاً جديداً فقط إذا كانت هذه دفعة جديدة فعلاً، حتى لا يُسجَّل المال مرتين.' : 'Create a new receipt only if this is genuinely new money, so the same money is not recorded twice.'}</p>
      </div>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 custom-scrollbar sm:p-5">
        ${_receiptCustomerRiskSectionHtml('debt', debtNotices, isAr)}
        ${_receiptCustomerRiskSectionHtml('balance', balanceNotices, isAr)}
      </div>
      <div class="grid shrink-0 grid-cols-1 gap-3 border-t border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/70 sm:grid-cols-2">
        <button type="button" onclick="cancelReceiptCustomerRiskWarning()" class="min-h-11 rounded-xl bg-slate-200 px-4 py-2.5 font-bold text-slate-700 hover:bg-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-500 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">${isAr ? 'اختيار عميل آخر' : 'Choose another customer'}</button>
        <button type="button" onclick="acknowledgeReceiptCustomerRiskWarning()" class="min-h-11 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5 font-extrabold text-white shadow-lg hover:from-amber-600 hover:to-orange-600 focus:outline-none focus:ring-2 focus:ring-amber-500">${isAr ? 'متابعة إنشاء الوصل' : 'Continue creating receipt'}</button>
      </div>
    </div>`;

  warning.addEventListener('keydown', event => {
    const isShortcut = (event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 'k';
    if (event.key === 'Escape' || isShortcut) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') cancelReceiptCustomerRiskWarning();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(warning.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
      event.preventDefault();
      warning.querySelector('#receipt-customer-risk-title')?.focus();
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
  }, true);

  const appModal = document.getElementById('app-modal');
  if (appModal) {
    _receiptCustomerRiskFormModal = appModal;
    appModal.inert = true;
    appModal.setAttribute('aria-hidden', 'true');
  }
  document.body.appendChild(warning);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => warning.querySelector('#receipt-customer-risk-title')?.focus(), 0);
  return true;
}

// Returns true when the caller must pause. A signature includes exact receipt
// ids, status type, and cents, so live-sync changes invalidate an old OK.
function requireReceiptCustomerRiskAcknowledgement(customerId) {
  const appModal = document.getElementById('app-modal');
  if (_receiptCustomerRiskFormModal !== appModal) {
    _receiptCustomerRiskAcknowledgedSignature = '';
    _receiptCustomerRiskAcknowledgedCustomerId = '';
    _receiptCustomerRiskFormModal = appModal;
  }
  const normalizedCustomerId = String(customerId || '').trim();
  if (_receiptCustomerRiskAcknowledgedCustomerId && _receiptCustomerRiskAcknowledgedCustomerId !== normalizedCustomerId) {
    _receiptCustomerRiskAcknowledgedSignature = '';
    _receiptCustomerRiskAcknowledgedCustomerId = '';
  }
  const snapshot = _getReceiptCustomerRiskSnapshot(normalizedCustomerId);
  if (!snapshot.signature) return false;
  if (snapshot.signature === _receiptCustomerRiskAcknowledgedSignature) return false;
  showReceiptCustomerRiskWarning(customerId, snapshot);
  return true;
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
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" data-record-action="select-page-customer" data-record-id="${Security.escapeHtml(String(c.id || ''))}" data-admin="${isAdminRole(state.currentUser?.role)}">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || (state.language === 'ar' ? 'لا يوجد هاتف' : 'No phone'))}</div>
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
      <div class="customer-option px-4 py-3 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800 last:border-0" data-record-action="select-page-customer" data-record-id="${Security.escapeHtml(String(c.id || ''))}" data-admin="${isAdminRole(state.currentUser?.role)}">
        <div class="font-medium text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</div>
        <div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(c.platform || '')} • ${Security.escapeHtml(c.phones?.[0] || (state.language === 'ar' ? 'لا يوجد هاتف' : 'No phone'))}</div>
      </div>
    `).join('');
    dropdown.classList.remove('hidden');
  }
}

function selectPageCustomer(customerId, isAdmin) {
  if (!Security.isValidRecordId(customerId)) return;
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;
  
  const container = document.getElementById('page-selected-customers');
  const noCustomersMsg = document.getElementById('page-no-customers');
  const dropdown = document.getElementById('page-customer-dropdown');
  const searchInput = document.getElementById('page-customer-search');
  
  // Check if already selected
  const existing = Array.from(container.querySelectorAll('[data-customer-id]'))
    .find(el => String(el.dataset.customerId || '') === String(customerId));
  if (existing) {
    showNotification(state.language === 'ar' ? 'محدد مسبقاً' : 'Already Selected', state.language === 'ar' ? 'هذا العميل مرتبط بهذه الصفحة بالفعل' : 'This customer is already linked to this page', 'info');
    dropdown.classList.add('hidden');
    return;
  }
  
  // Check if non-admin trying to add multiple
  const currentCount = container.querySelectorAll('.page-customer-item').length;
  if (isAdmin === 'false' && currentCount >= 1) {
    showNotification(state.language === 'ar' ? 'تم بلوغ الحد' : 'Limit Reached', state.language === 'ar' ? 'يمكنك ربط عميل واحد فقط. احذف العميل الحالي أولاً.' : 'You can only link one customer. Remove the existing customer first.', 'error');
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
    <button type="button" data-record-action="remove-page-customer" data-record-id="${Security.escapeHtml(String(customerId))}" class="text-rose-500 hover:text-rose-700">
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
  if (!Security.isValidRecordId(customerId)) return;
  const container = document.getElementById('page-selected-customers');
  const noCustomersMsg = document.getElementById('page-no-customers');
  const item = Array.from(container.querySelectorAll('[data-customer-id]'))
    .find(el => String(el.dataset.customerId || '') === String(customerId));
  
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

// Delegated record actions keep untrusted ids out of executable JavaScript.
// Dynamic dropdowns can be re-rendered freely without re-binding handlers.
// CAPTURE phase (the `true` below) is essential: modal panels carry
// onclick="event.stopPropagation()" to stop inside-clicks from closing the modal,
// which also stops the click ever bubbling to document. A capture-phase listener on
// document fires on the way DOWN to the target, before that bubble-phase
// stopPropagation runs — so page/customer dropdown selections work inside modals
// again. (Bubble phase silently broke every in-modal selection.)
if (!window.__albayanSafeRecordActionsBound) {
  window.__albayanSafeRecordActionsBound = true;
  document.addEventListener('click', (event) => {
    const actionEl = event.target?.closest?.('[data-record-action]');
    if (!actionEl) return;
    const recordId = String(actionEl.dataset.recordId || '');
    if (!Security.isValidRecordId(recordId)) {
      event.preventDefault();
      showNotification('Invalid Record', 'This record identifier is not allowed.', 'error');
      return;
    }
    switch (actionEl.dataset.recordAction) {
      case 'select-page-customer':
        selectPageCustomer(recordId, String(actionEl.dataset.admin || 'false'));
        break;
      case 'remove-page-customer':
        removePageCustomer(recordId);
        break;
      case 'select-ad-page':
        selectAdPage(recordId);
        break;
      case 'select-ad-customer':
        selectAdCustomer(recordId);
        break;
      default:
        return;
    }
    event.preventDefault();
  }, true);
}

// Close dropdowns when clicking outside. CAPTURE phase: the modal panel's
// onclick="event.stopPropagation()" swallows bubble-phase clicks, so without
// it this listener never fires for taps inside the form (see the comment on
// the capture-phase listener at the top of this file).
document.addEventListener('click', (e) => {
  const pageDropdown = document.getElementById('page-customer-dropdown');
  const pageSearch = document.getElementById('page-customer-search');

  if (pageDropdown && pageSearch &&
      !pageDropdown.contains(e.target) &&
      !pageSearch.contains(e.target)) {
    pageDropdown.classList.add('hidden');
  }
}, true);

// Rate 1 to SHOW for a stored payment row.
// MONEY-MATH: 0 is a REAL rate — the app itself fills Rate 1 with 0.00 for
// every zero-rate method (Bank Transfer LYD/USD, Sadad, USDT, LTT, Cash (USD)).
// The old `payment.rate || state.defaultExchangeRate` treated that 0 as
// "missing" and re-rendered the market rate, so simply reopening such a receipt
// (or adding/removing a split row) showed an inflated LYD total — and saving it
// again REWROTE amountLocal/exchangeRate with money the customer never paid.
// Only a genuinely absent rate falls back to the default.
function paymentRate1Value(payment) {
  const r = payment ? payment.rate : undefined;
  if (r === undefined || r === null || r === '') {
    return payment && payment.method !== undefined
      ? getDefaultRate1(payment.method)
      : state.defaultExchangeRate;
  }
  return r;
}

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

// AUTO-SERIAL GROUPS
// Some payment methods have no paper receipt from the provider, so the app
// issues its own sequential number. Each group owns an INDEPENDENT counter:
//   S — LTT / Libyana / Madar          (S1, S2, …)
//   B — Bank Transfer (LYD) / (USD)    (B1, B2, …)
//   O — Transfer Office                (O1, O2, …)
//   E — Sadad / USDT                   (E1, E2, …)
// The serial field is READ-ONLY for these methods (see updateSerialLockState).
const AUTO_SERIAL_GROUPS = {
  S: ['LTT', 'Libyana', 'Madar'],
  B: ['Bank Transfer (LYD)', 'Bank Transfer (USD)', 'Bank Transfer'],
  O: ['Transfer Office'],
  E: ['Sadad', 'USDT']
};
const AUTO_SERIAL_PREFIXES = Object.keys(AUTO_SERIAL_GROUPS);
const AUTO_SERIAL_PAYMENT_METHODS = Object.values(AUTO_SERIAL_GROUPS).flat();

// Which counter does this payment method draw from? null = manual serial.
function getAutoSerialPrefix(paymentMethod) {
  const m = String(paymentMethod || '').trim();
  for (const [prefix, methods] of Object.entries(AUTO_SERIAL_GROUPS)) {
    if (methods.includes(m)) return prefix;
  }
  return null;
}

// Next serial for the group a payment method belongs to (e.g. 'B3').
function getNextAutoSerialNumber(paymentMethod) {
  const prefix = getAutoSerialPrefix(paymentMethod);
  if (!prefix) return null;
  const groupMethods = AUTO_SERIAL_GROUPS[prefix];

  const receipts = getVisibleRecords(state.receipts);
  let maxSerialNumber = 0;

  receipts.forEach(receipt => {
    // A receipt belongs to the group if its method — or any of its split
    // payments — is in the group.
    const receiptPaymentMethod = receipt.paymentMethod || '';
    const payments = Array.isArray(receipt.payments) ? receipt.payments : [];
    const usesGroupMethod = groupMethods.includes(receiptPaymentMethod)
      || payments.some(p => groupMethods.includes(p && p.method));

    if (!usesGroupMethod || !receipt.serialNumber) return;
    const serial = String(receipt.serialNumber).trim().toUpperCase();

    // A receipt that has a MANUAL method (Cash) got a hand-typed PAPER receipt
    // number, so its bare digits are NOT a legacy S serial and must not advance
    // the S counter (a 5-digit paper number would otherwise hijack the whole
    // series). Only PURE auto-serial receipts count via the legacy branch.
    const methodsUsed = payments.length
      ? payments.map(p => p && p.method).filter(Boolean)
      : (receiptPaymentMethod && receiptPaymentMethod !== 'Split Payment' ? [receiptPaymentMethod] : []);
    const hasManualMethod = methodsUsed.some(m => !getAutoSerialPrefix(m));

    let serialNum = 0;
    if (serial.startsWith(prefix)) {
      serialNum = parseInt(serial.substring(prefix.length), 10);
    } else if (prefix === 'S' && /^\d+$/.test(serial) && !hasManualMethod) {
      // Legacy: the S group used bare numbers before the prefix existed.
      serialNum = parseInt(serial, 10);
    } else {
      return; // a serial from a different group never advances this counter
    }
    if (!isNaN(serialNum) && serialNum > maxSerialNumber) maxSerialNumber = serialNum;
  });

  return `${prefix}${maxSerialNumber + 1}`;
}

// Is this an app-generated serial (S1 / B2 / O3 / E4)?
function isAutoSerialNumber(serial) {
  if (!serial) return false;
  const s = String(serial).trim().toUpperCase();
  return new RegExp(`^[${AUTO_SERIAL_PREFIXES.join('')}]\\d+$`).test(s);
}

// The payment methods currently selected in the receipt form, in row order.
function getSelectedPaymentMethods() {
  return Array.from(document.querySelectorAll('.payment-split-item'))
    .map(item => item.querySelector('.payment-method'))
    .filter(Boolean)
    .map(sel => String(sel.value || '').trim())
    .filter(Boolean);
}

// The auto-serial method to number this receipt by — but ONLY when EVERY
// payment row is auto-numbered. If any row is a manual method (Cash), the
// customer got a real paper receipt, so its number must be typed by hand and
// the field stays editable. Returns null in that case (and when there are no
// payment rows at all).
function getSelectedAutoSerialMethod() {
  const paymentItems = document.querySelectorAll('.payment-split-item');
  let firstAuto = null;
  let rows = 0;
  for (const item of paymentItems) {
    const methodSelect = item.querySelector('.payment-method');
    if (!methodSelect) continue;
    rows++;
    const prefix = getAutoSerialPrefix(methodSelect.value);
    if (!prefix) return null; // a manual method is present -> manual number
    if (!firstAuto) firstAuto = methodSelect.value;
  }
  return rows > 0 ? firstAuto : null;
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
  
  // The payment method drives the receipt number — re-sync it.
  syncReceiptSerialWithPaymentMethods({ reissue: true });

  // Update totals
  updateReceiptTotals();
}

// Keep the Receipt Number field consistent with the selected payment methods.
//
// reissue=true  — the user just CHANGED the payment methods (picked another
//                 method, added/removed a split row). The number must follow
//                 the new methods, even on a saved receipt: switching a cash
//                 receipt (paper number 12851) to Bank Transfer means there is
//                 no paper receipt any more, so it takes a B number.
// reissue=false — the form merely opened; never renumber an existing receipt,
//                 only fill a blank field.
function syncReceiptSerialWithPaymentMethods({ reissue = false } = {}) {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return;

  const autoMethod = getSelectedAutoSerialMethod();
  const current = String(serialInput.value || '').trim();
  const currentUpper = current.toUpperCase();
  const isEditingSaved = !!state.modalData?.id;

  if (autoMethod) {
    const prefix = getAutoSerialPrefix(autoMethod);
    // The number already belongs to this method's counter — keep it.
    const inThisGroup = isAutoSerialNumber(currentUpper) && currentUpper.startsWith(prefix);
    // Legacy S receipts were numbered with bare digits before the prefix
    // existed; a saved one keeps its number rather than being renumbered. But
    // this exception must ONLY apply when the STORED receipt was already a pure
    // S-group receipt — a manual paper number (e.g. Cash #500) switched to LTT
    // must be REISSUED to an S-serial, not kept as "500".
    // The SAVED record is the source of truth here — state.modalData may only
    // carry the id, so read the stored methods off state.receipts by that id.
    const _storedId = state.modalData?.id;
    const _stored = (_storedId && Array.isArray(state.receipts)
      ? state.receipts.find(r => r && r.id === _storedId)
      : null) || state.modalData || {};
    const _storedMethods = Array.isArray(_stored.payments) && _stored.payments.length
      ? _stored.payments.map(p => p && p.method).filter(Boolean)
      : (_stored.paymentMethod && _stored.paymentMethod !== 'Split Payment' ? [_stored.paymentMethod] : []);
    const _storedWasPureSGroup = _storedMethods.length
      && _storedMethods.some(m => getAutoSerialPrefix(m) === 'S')
      && !_storedMethods.some(m => !getAutoSerialPrefix(m));
    const legacySInGroup = prefix === 'S' && isEditingSaved && /^\d+$/.test(current) && _storedWasPureSGroup;

    if (!current || (reissue && !inThisGroup && !legacySInGroup)) {
      const nextSerial = getNextAutoSerialNumber(autoMethod);
      if (nextSerial && nextSerial !== current) {
        serialInput.value = nextSerial;
        showNotification(
          state.language === 'ar' ? 'رقم تلقائي' : 'Auto Serial',
          state.language === 'ar'
            ? `تم تعيين رقم الوصل تلقائياً إلى ${nextSerial} لـ ${trMethod(autoMethod)}`
            : `Receipt number auto-set to ${nextSerial} for ${autoMethod}`,
          'info'
        );
      }
    }
  } else if (reissue && isAutoSerialNumber(currentUpper)) {
    // A manual (paper-receipt) method joined the split: drop the app-issued
    // number so the real receipt number is entered.
    serialInput.value = '';
    showNotification(
      state.language === 'ar' ? 'رقم الوصل مطلوب' : 'Receipt Number Required',
      state.language === 'ar'
        ? 'الدفع يشمل طريقة بإيصال ورقي — أدخل رقم الوصل يدوياً.'
        : 'This payment includes a method with a paper receipt — enter the receipt number manually.',
      'info'
    );
  }

  updateSerialLockState();
}

// Round UP to 2 decimal places (credit is granted in the customer's favour).
// Example: 90.100143062 -> 90.11.
//
// MONEY-MATH: it must NOT round up on binary floating-point residue. 291 / 9.7
// is 30.000000000000004 in JS, so the old Math.ceil(v * 100) turned an exact
// $30.00 into $30.01 — and the "+0.01 when it has decimals" rule below then
// made it $30.02, which in turn made the stored exchange rate 291/30.02 = 9.69
// instead of the 9.70 the user typed. Treat a value that is within a
// hair of a cent boundary as being ON it, then ceil.
const MONEY_EPSILON = 1e-6;

// The rate to STORE on a receipt.
// Single payment  -> exactly the rate the user typed (Rate 2).
// Split payments  -> the effective average (rows can carry different rates).
function receiptExchangeRate(payments, totalLYD, totalUSD) {
  const rows = Array.isArray(payments) ? payments : [];
  if (rows.length === 1) {
    const r = Number(rows[0]?.rate2);
    if (Number.isFinite(r) && r > 0) return r;
  }
  if (totalUSD > 0 && totalLYD > 0) return totalLYD / totalUSD;
  return state.defaultExchangeRate;
}

function ceilingRound(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return 0;
  const cents = v * 100;
  const nearest = Math.round(cents);
  if (Math.abs(cents - nearest) < MONEY_EPSILON) return nearest / 100;
  return Math.ceil(cents) / 100;
}

// Called when a payment row is ADDED or REMOVED — the set of methods changed,
// so the receipt number must follow it (reissue), same as a method change.
function updateAutoSerialForReceipt() {
  syncReceiptSerialWithPaymentMethods({ reissue: true });
}

// Called when the receipt form OPENS: fill a blank number, lock the field for
// auto-numbered methods, but never renumber an existing receipt.
function initReceiptSerialOnOpen() {
  syncReceiptSerialWithPaymentMethods({ reissue: false });
}

// The serial field is read-only whenever an auto-serial method is selected —
// these receipts are numbered by the app, never by hand.
function updateSerialLockState() {
  const serialInput = document.getElementById('receipt-serial');
  if (!serialInput) return;

  const autoSerialMethod = getSelectedAutoSerialMethod();

  if (autoSerialMethod) {
    serialInput.readOnly = true;
    serialInput.classList.add('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
    serialInput.title = state.language === 'ar'
      ? `مولّد تلقائياً لـ ${trMethod(autoSerialMethod)} (لا يمكن تعديله)`
      : `Auto-generated for ${autoSerialMethod} (not editable)`;
  } else {
    serialInput.readOnly = false;
    serialInput.classList.remove('bg-slate-100', 'dark:bg-slate-700', 'cursor-not-allowed');
    serialInput.title = '';
  }
}

function updateReceiptTotals() {
  const paymentItems = document.querySelectorAll('.payment-split-item');
  
  let totalR1 = 0; // Total PAID (LYD) - sum of all R1 values
  let totalR2 = 0; // Total ADS CREDIT (USD) - sum of all R2 values (rounded UP, = credit granted)
  // Un-rounded USD total. The credit granted (totalR2) is rounded UP in the
  // customer's favor, but comparing THAT against the market rate manufactures a
  // fake "saving" even when the customer paid exactly at market rate (and can
  // hide a real "paid extra"). The saved-vs-extra verdict and the effective
  // average rate must be judged from this un-rounded basis.
  let totalR2Raw = 0;

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
    
    let r2Raw = 0;
    if (rate2 > 0) {
      if (usdBasedMethods.includes(paymentMethod)) {
        // USD-based methods: R2 = R1 / Rate 2
        // BUG FIX: Prevent division by zero
        r2Raw = rate2 > 0 ? (r1 / rate2) : 0;
      } else {
        // Normal methods: R2 = Amount / Rate 2
        // BUG FIX: Prevent division by zero
        r2Raw = rate2 > 0 ? (amount / rate2) : 0;
      }
      // Apply ceiling rounding to individual R2 (always round up to 2 decimal places)
      r2 = ceilingRound(r2Raw);
    }

    // Update displays
    if (r1Display) r1Display.textContent = r1.toFixed(2) + ' LYD';
    if (r2Display) r2Display.textContent = r2.toFixed(2) + ' USD';

    // Add to totals
    totalR1 += r1;
    totalR2 += r2;
    totalR2Raw += r2Raw;
  });
  
  // Add 0.01 to TOTAL ADS CREDIT (USD) only if it has decimals
  // Snap to 2 decimals first so binary float residue (e.g. a sum landing on
  // 100.00000000000001) doesn't trip the "has decimals" rule on a whole total.
  totalR2 = Math.round(totalR2 * 100) / 100;
  if (totalR2 % 1 !== 0) {
    totalR2 = Math.round((totalR2 + 0.01) * 100) / 100;
  }
  
  // Update total displays
  const totalLydEl = document.getElementById('receipt-total-lyd');
  const totalUsdEl = document.getElementById('receipt-total-usd');
  const avgRateEl = document.getElementById('receipt-avg-rate');
  const netPaidEl = document.getElementById('receipt-net-paid');
  const savingsEl = document.getElementById('receipt-savings-display');
  
  if (totalLydEl) totalLydEl.textContent = totalR1.toFixed(2);
  if (totalUsdEl) totalUsdEl.textContent = '$' + totalR2.toFixed(2);
  
  // Calculate the effective average rate the customer transacted at. Use the
  // UN-rounded USD basis so a payment made exactly at the market rate shows an
  // avg rate equal to the market rate (the rounded credit would skew it).
  const avgRate = totalR2Raw > 0 ? (totalR1 / totalR2Raw) : 0;
  if (avgRateEl) avgRateEl.textContent = avgRate.toFixed(4);
  
  // Calculate net paid (total - processing fee if any)
  const processingFee = BUSINESS_CONFIG.RECEIPT_PROCESSING_FEE_LYD || 0;
  const netPaid = totalR1 - processingFee;
  if (netPaidEl) netPaidEl.textContent = netPaid.toFixed(2) + ' LYD';
  
  // Calculate savings or extra paid compared to market rate
  const marketRate = state.defaultExchangeRate;
  
  if (savingsEl && totalR2Raw > 0) {
    // What the customer would have paid at market rate for the SAME credit,
    // using the un-rounded USD so rounding can't fabricate a saving or mask an
    // overpayment. Positive = customer saved, negative = customer paid extra.
    const marketValue = totalR2Raw * marketRate;
    const difference = marketValue - totalR1;
    
    const isArSav = state.language === 'ar';
    if (Math.abs(difference) < 0.01) {
      // No significant difference
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400';
      savingsEl.innerHTML = `<i data-lucide="equal" class="w-4 h-4 inline mr-1"></i> ${isArSav ? 'دُفِع بسعر السوق' : 'Paid at market rate'}`;
      savingsEl.classList.remove('hidden');
    } else if (difference > 0) {
      // Customer saved money (paid less than market rate)
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
      savingsEl.innerHTML = `<i data-lucide="trending-down" class="w-4 h-4 inline mr-1"></i> ${isArSav ? 'وفّر العميل' : 'Customer Saved'}: <span class="text-emerald-600 font-bold">${Security.escapeHtml(difference.toFixed(2))} LYD</span>`;
      savingsEl.classList.remove('hidden');
    } else {
      // Customer paid extra (paid more than market rate)
      const extra = Math.abs(difference);
      savingsEl.className = 'mt-2 p-2 rounded-lg text-center text-sm font-bold bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400';
      savingsEl.innerHTML = `<i data-lucide="trending-up" class="w-4 h-4 inline mr-1"></i> ${isArSav ? 'دفع زيادة' : 'Paid Extra'}: <span class="text-rose-600 font-bold">${Security.escapeHtml(extra.toFixed(2))} LYD</span>`;
      savingsEl.classList.remove('hidden');
    }
    
    // Refresh icons
    if (window.lucide) lucide.createIcons();
  } else if (savingsEl) {
    savingsEl.classList.add('hidden');
  }
}

// Helper: compute totals from current payment rows (shared use)
// `root` scopes which .payment-split-item rows are summed. The receipt modal has one
// set (default = whole document); the delivery-completion form has TWO independent sets
// (collected amount + delivery fee), so it passes each container to get its own totals.
function getPaymentTotalsFromDom(root) {
  const paymentItems = (root || document).querySelectorAll('.payment-split-item');
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
  // Snap to 2 decimals first so binary float residue (e.g. a sum landing on
  // 100.00000000000001) doesn't trip the "has decimals" rule on a whole total.
  totalR2 = Math.round(totalR2 * 100) / 100;
  if (totalR2 % 1 !== 0) {
    totalR2 = Math.round((totalR2 + 0.01) * 100) / 100;
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
// Reentrancy guard: saving awaits a network call in server mode, and a second
// click while the first is in flight created a SECOND receipt (the duplicate-
// serial check passes for both because the first hasn't landed in state yet).
let _savingReceiptInFlight = false;

async function saveReceiptFromModal() {
  if (_savingReceiptInFlight) return;
  _savingReceiptInFlight = true;
  try {
    await _saveReceiptFromModalInner();
  } finally {
    _savingReceiptInFlight = false;
  }
}

async function _saveReceiptFromModalInner() {
  const isArV = state.language === 'ar';
  // Filled only after a NEW delivery receipt is confirmed saved. The share
  // prompt must use the server-returned row because the server may assign the
  // authoritative temporary D-number.
  let newlyCreatedDeliveryReceiptId = '';
  try {
  if (_receiptPhotoUploadsInFlight > 0) {
    showNotification(
      isArV ? 'جاري تجهيز الصور' : 'Preparing photos',
      isArV ? 'انتظر لحظة حتى ينتهي تجهيز الصور، ثم احفظ الوصل.' : 'Please wait for the photos to finish preparing, then save the receipt.',
      'info'
    );
    return;
  }
  // Resolve the edit target from the FROZEN hidden field written when this form
  // was rendered — NOT from the mutable global state.modalData, which a stray
  // browser-back / refresh / URL-restore can silently repoint at a different
  // receipt. Empty id, or an id no longer present, means "create new".
  // (Bug: a new receipt was overwriting an old one because state.modalData had
  // been repointed at the old receipt after the form opened.)
  const _editingId = (document.getElementById('receipt-editing-id')?.value || '').trim();
  const editTarget = _editingId
    ? (state.receipts.find(r => r && !r._deleted && String(r.id) === _editingId) || null)
    : null;

  const customerId = document.getElementById('receipt-customer-id').value;
  if (!customerId) {
    showNotification(isArV ? 'خطأ' : 'Error', isArV ? 'الرجاء اختيار عميل عن طريق رقم الهاتف' : 'Please select a customer by phone', 'error');
    return;
  }

  // Re-check immediately before a NEW receipt is saved. Live sync may have
  // added debt or changed a paid balance after the customer was first chosen;
  // an earlier acknowledgement is valid only while its exact signature stays
  // unchanged. Editing an existing receipt never enters this warning flow.
  if (!editTarget && requireReceiptCustomerRiskAcknowledgement(customerId)) {
    return;
  }
  
  // Collect all payment splits
  const paymentItems = document.querySelectorAll('.payment-split-item');
  const payments = [];
  
  paymentItems.forEach(item => {
    const method = item.querySelector('.payment-method').value;
    const amount = parseFloat(item.querySelector('.payment-amount').value) || 0;
    // Rate 1 MUST read identically to the live preview (updateReceiptTotals /
    // getPaymentTotalsFromDom both use `|| 0`). The old `|| defaultExchangeRate`
    // fallback fired on the legit 0.00 that zero-rate methods (Sadad, Bank
    // Transfer LYD, LTT…) auto-fill, so the saved receipt got amountLocal
    // multiplied by the default rate and a SQUARED exchangeRate — "what you
    // saw before saving" was not what got saved.
    const rate = parseFloat(item.querySelector('.payment-rate1').value) || 0;
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
  // Snap to 2 decimals first so binary float residue (e.g. a sum landing on
  // 100.00000000000001) doesn't trip the "has decimals" rule on a whole total.
  totalR2 = Math.round(totalR2 * 100) / 100;
  if (totalR2 % 1 !== 0) {
    totalR2 = Math.round((totalR2 + 0.01) * 100) / 100;
  }
  
  const totalLYD = totalR1;
  const totalUSD = totalR2;
  // BUG FIX: Prevent division by zero (defense in depth, already checked totalUSD > 0)
  // The receipt's exchange rate. With a SINGLE payment, store exactly the rate
  // the user typed — deriving it as LYD/USD made the card show 9.69 for a rate
  // of 9.70, because the credit total is rounded up in the customer's favour.
  // With a split (different rates per row) the effective average is the only
  // meaningful figure, so keep deriving it there.
  const avgRate = receiptExchangeRate(payments, totalLYD, totalUSD);
  const status = document.getElementById('receipt-status').value || 'Paid';
  const photos = state.tempReceiptPhotos || [];

  // A receipt records money that was RECEIVED. Rows with amount 0 are dropped
  // from payments[] above, so an all-zero form used to save a receipt with NO
  // payments at all — which then invented a payment method nobody picked. Only
  // a "Not Paid" receipt may legitimately carry no payment yet.
  if (payments.length === 0 && status !== 'Not Paid') {
    showNotification(
      isArV ? 'تحقق' : 'Validation',
      isArV ? 'أدخل مبلغ الدفع (لا يمكن حفظ وصل بدون مبلغ).' : 'Enter a payment amount (a receipt cannot be saved with no money).',
      'error'
    );
    return;
  }

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
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'اختر كيف سيدفع العميل (المحل أو التوصيل).' : 'Select how the customer will pay (shop or delivery).', 'error');
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
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'اختر نتيجة الإلغاء.' : 'Select a cancellation outcome.', 'error');
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
    showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'اختر نتيجة الفقدان (فارغ أو مدفوع).' : 'Select lost resolution (empty or paid).', 'error');
    return;
  }
  
  // Validate receipt number
  const serialInputEl = document.getElementById('receipt-serial');
  const serialErrEl = document.getElementById('receipt-serial-error');
  // Safety net: an auto-numbered payment method must never save without its
  // serial (e.g. the field was left empty because the method was pre-selected).
  // It must NOT fire for a temp-delivery receipt (those carry a D-number) nor
  // for a "Not Paid" receipt, whose number the form deliberately hides — issuing
  // one there would burn a number on a receipt that shows none.
  {
    const autoMethod = getSelectedAutoSerialMethod();
    const serialApplies = !isTempDelivery && status !== 'Not Paid';
    if (serialApplies && autoMethod && serialInputEl && !String(serialInputEl.value || '').trim()) {
      const next = getNextAutoSerialNumber(autoMethod);
      if (next) serialInputEl.value = next;
    }
  }
  const serialNumber = document.getElementById('receipt-serial').value.trim();

  // Temp delivery receipts must have a D{n} temporary number.
  if (isTempDelivery) {
    // In server mode, the backend generates tempReceiptNo safely, so it's OK to be empty before save.
    if (!serialNumber && !isServerModeEnabled()) {
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'رقم وصل التوصيل المؤقت مفقود. الرجاء إعادة اختيار التوصيل أو إعادة فتح نموذج الوصل.' : 'Temporary delivery receipt number is missing. Please re-select Delivery or reopen the receipt form.', 'error');
      return;
    }
    if (serialNumber && !isTempDeliveryReceiptNo(serialNumber)) {
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'رقم الوصل المؤقت يجب أن يكون بالشكل D12، D13، ...' : 'Temporary receipt number must look like D12, D13, ...', 'error');
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
    showNotification(isArV ? 'تحقق' : 'Validation', state.language === 'ar'
      ? 'لا يمكن حفظ الوصل بدون رقم عندما تكون الحالة (مدفوع/ملغي/ضائع).'
      : 'You cannot save without a receipt number when status is Paid/Canceled/Lost.', 'error');
    return;
  }
  
  if (serialNumber) {
    // Temp delivery receipt uniqueness + format
    if (isTempDelivery) {
      const existingTemp = state.receipts.find(r =>
        !r._deleted &&
        r.id !== (editTarget ? editTarget.id : null) &&
        (String(r.tempReceiptNo || '').trim() === serialNumber || String(r.serialNumber || '').trim() === serialNumber || String(r.finalReceiptNo || '').trim() === serialNumber)
      );
      if (existingTemp) {
        showNotification(isArV ? 'وصل مؤقت مكرر' : 'Duplicate Temp Receipt', isArV ? `رقم الوصل المؤقت "${serialNumber}" موجود بالفعل. الرجاء إعادة فتح نموذج الوصل لتوليد رقم جديد.` : `Temporary receipt number "${serialNumber}" already exists. Please reopen the receipt form to generate a new one.`, 'error');
        return;
      }
    }

    // Check if it's a valid receipt number:
    // - Regular receipts: digits only, no leading zeros (123, 456, etc.)
    // - Auto-serial receipts (LTT/Libyana/Madar): S-prefix + digits (S1, S2, S3, etc.)
    const isAutoSerial = isAutoSerialNumber(serialNumber);
    if (!isTempDelivery && !isAutoSerial && !/^\d+$/.test(serialNumber)) {
      showNotification(isArV ? 'رقم وصل غير صالح' : 'Invalid Receipt Number', isArV ? 'رقم الوصل يجب أن يحتوي على أرقام فقط (0-9) أو يبدأ بحرف S (مثل S1، S2) لطرق LTT/Libyana/Madar' : 'Receipt number must contain only digits (0-9) or be S-prefixed (S1, S2) for LTT/Libyana/Madar', 'error');
      return;
    }
    
    // Check if it starts with zero (only for non-auto-serial receipts)
    if (!isTempDelivery && !isAutoSerial && serialNumber.startsWith('0')) {
      showNotification(isArV ? 'رقم وصل غير صالح' : 'Invalid Receipt Number', isArV ? 'رقم الوصل لا يمكن أن يبدأ بصفر' : 'Receipt number cannot start with zero', 'error');
      return;
    }
    
    // Check for duplicates (excluding current record if editing)
    const existingReceipt = isTempDelivery ? null : state.receipts.find(receipt =>
      receipt.serialNumber === serialNumber &&
      receipt.id !== (editTarget ? editTarget.id : null) &&
      !receipt._deleted
    );
    
    if (existingReceipt) {
      const customer = state.customers.find(c => c.id === existingReceipt.customerId);
      const customerName = customer ? customer.name : (state.language === 'ar' ? 'غير معروف' : 'Unknown');
      
      // Show detailed duplicate warning
      showDuplicateReceiptWarning(serialNumber, customerName, existingReceipt.customerId);
      return;
    }
  }
  
  // Determine delivery status and delivery person based on status and collection method
  let receiptDeliveryStatus = 'Office';
  let receiptDeliveryPersonId = '';
  // MONEY-MATH: isPaid must be DERIVED from the status, not defaulted to true.
  // 'Canceled'/'Lost' used to inherit the true default, so switching a NEVER-PAID
  // receipt to Canceled/Lost flipped it to paid and minted spendable ad credit
  // from money the business never received. A canceled/lost receipt only counts
  // as paid if it really held money before (or a Lost one is resolved as paid).
  let receiptIsPaid = true;
  let receiptIsReceivedInOffice = true;

  if (status === 'Canceled' || status === 'Lost') {
    const heldMoneyBefore = !!(editTarget && (editTarget.isPaid === true || String(editTarget.status || '') === 'Paid'));
    const lostPaid = status === 'Lost' && String(statusDetail.lostResolution || '') === 'paid';
    receiptIsPaid = heldMoneyBefore || lostPaid;
    receiptIsReceivedInOffice = receiptIsPaid;
  }

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
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'الرجاء تعيين سائق توصيل.' : 'Please assign a delivery person.', 'error');
      return;
    }
    if (!deliveryPlaceName) {
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'اسم مكان التوصيل مطلوب.' : 'Delivery place name is required.', 'error');
      return;
    }
    if (!(quotedDeliveryFee >= 0) || !Number.isFinite(quotedDeliveryFee)) {
      showNotification(isArV ? 'تحقق' : 'Validation', isArV ? 'رسوم التوصيل المتفق عليها مطلوبة.' : 'Quoted delivery fee is required.', 'error');
      return;
    }
  }
  
  // Temp delivery receipts: send tempReceiptNo (D#) only; serialNumber stays empty until delivery completion.
  // Normal receipts: send serialNumber only.
  const tempReceiptNo = isTempDelivery ? serialNumber : (editTarget?.tempReceiptNo || '');
  const serialFinal = isTempDelivery ? (editTarget?.serialNumber || editTarget?.finalReceiptNo || '') : serialNumber;
  // finalReceiptNo must FOLLOW the number the user just entered. It used to
  // prefer the stored value, so editing a receipt's number changed only
  // serialNumber while the lists/cards (which show finalReceiptNo first) kept
  // displaying the OLD number — the edit looked like it never happened.
  const finalReceiptNo = isTempDelivery
    ? (editTarget?.finalReceiptNo || '')
    : (serialFinal || '');

  const receipt = {
    id: editTarget ? editTarget.id : generateId('receipt'),
    recordType: 'receipt',
    customerId: customerId,
    pageId: '',
    creatorId: state.currentUser?.id || '',
    amountUSD: totalUSD,
    exchangeRate: avgRate,
    amountLocal: totalLYD,
    // Derived from the rows the user actually chose. When every amount is 0 the
    // rows are dropped from payments[], and this used to invent 'Cash (USD)' —
    // a method nobody picked, contradicting the auto-serial that was issued for
    // the real method. Fall back to the SELECTED method instead.
    paymentMethod: (Array.isArray(payments) && payments.length > 1)
      ? 'Split Payment'
      : (Array.isArray(payments) && payments.length > 0
          ? payments[0]?.method
          : (getSelectedPaymentMethods()[0] || editTarget?.paymentMethod || '')),
    status,
    statusDetail,
    isPaid: receiptIsPaid,
    deliveryStatus: receiptDeliveryStatus,
    deliveryPersonId: receiptDeliveryPersonId,
    isReceivedInOffice: receiptIsReceivedInOffice,
    startDate: new Date().toISOString(),
    endDate: new Date().toISOString(),
    createdAt: editTarget ? editTarget.createdAt : new Date().toISOString(),
    // CRITICAL: temp delivery receipts must NOT send serialNumber=D# (server rejects non-digit serial).
    // Only send serialNumber for normal receipts; temp receipts use tempReceiptNo.
    serialNumber: isTempDelivery ? '' : serialFinal,
    finalReceiptNo: finalReceiptNo,
    tempReceiptNo: tempReceiptNo,
    // A carried "existing balance" receipt is an ordinary Paid receipt that is only
    // TAGGED so its card shows the existing-balance colour/badge; it counts as revenue
    // and funds ads exactly like any other receipt. The tag only applies to a NEW,
    // non-delivery receipt (an edit keeps whatever type it already had).
    receiptType: tempReceiptNo
      ? 'DELIVERY_TEMP'
      : (editTarget ? (editTarget.receiptType || '') : (_newReceiptCarried ? 'CARRIED_BALANCE' : '')),
    deliveryPlaceName: isTempDelivery ? deliveryPlaceName : (editTarget?.deliveryPlaceName || deliveryPlaceName || ''),
    deliveryInstructions: isTempDelivery ? deliveryInstructions : (editTarget?.deliveryInstructions || deliveryInstructions || ''),
    quotedDeliveryFee: isTempDelivery ? quotedDeliveryFee : (editTarget?.quotedDeliveryFee ?? quotedDeliveryFee),
    // Debt baseline (what the driver must collect on delivery). While the
    // receipt is still a pre-delivery temp receipt, keep this in sync with the
    // current totals so an admin's edit to the amount also corrects the amount
    // to be collected. Once delivered (no longer a temp receipt) the stored
    // baseline is preserved. Previously an edit updated amountLocal but left
    // this stale, corrupting the driver's cash reconciliation.
    debtAmountLocal: (isTempDelivery ? totalLYD : (editTarget?.debtAmountLocal ?? undefined)),
    debtAmountUSD: (isTempDelivery ? totalUSD : (editTarget?.debtAmountUSD ?? undefined)),
    officeFee: 0,
    discount: 0,
    phoneNumber: document.getElementById('receipt-phone-search').value || '',
    // When the money arrived. Stamped ONLY when the receipt is Paid: an EDIT
    // keeps the saved date (rewriting it made every edited old receipt look
    // newly collected, poisoning the liquidity window), an unpaid receipt
    // carries no arrival date at all, and the save that turns it Paid stamps
    // the true payment moment — matching the edit-modal rule in 15-modals.js.
    collectionDate: (editTarget ? editTarget.collectionDate : '') || (receiptIsPaid ? new Date().toISOString() : ''),
    payments: payments,
    photos
  };

  // PATCH has merge semantics, so unchanged photos can stay on the server
  // without being uploaded again. If the user intentionally removes the
  // legacy delivery proof from the photo list, clear that field explicitly.
  if (editTarget && !state.tempReceiptPhotosDirty) {
    delete receipt.photos;
  } else if (editTarget) {
    const legacyProof = String(editTarget.receiptImage || '').trim();
    if (legacyProof && !photos.includes(legacyProof)) receipt.receiptImage = '';
  }
  
  // Get customer name for logging
  const linkedCustomer = state.customers.find(c => c.id === customerId);
  const customerName = linkedCustomer ? linkedCustomer.name : 'customer';

  if (editTarget) {
    // Money already committed cannot be edited away: ads funded from this
    // receipt (including delivery-due funding) plus money transferred to
    // other customers set the floor for the new total. Below it, those
    // records would hold money the receipt no longer contains.
    const committedStats = getReceiptUsageStats(editTarget);
    const committedUSD = Math.round(((committedStats.usedUSD || 0) + (committedStats.transferredUSD || 0)) * 100) / 100;
    if (totalUSD < committedUSD - 0.01) {
      showNotification(
        state.language === 'ar' ? 'غير ممكن' : 'Not possible',
        state.language === 'ar'
          ? `$${committedUSD.toFixed(2)} من هذا الوصل مستخدمة بالفعل (إعلانات وتحويلات) — لا يمكن خفض الإجمالي إلى $${totalUSD.toFixed(2)}. حرِّر المبلغ أولاً (عدِّل/أوقف الإعلانات أو احذف التحويل).`
          : `$${committedUSD.toFixed(2)} of this receipt is already used (ads + transfers) — the total cannot go down to $${totalUSD.toFixed(2)}. Free the money first (edit/stop the ads or delete the transfer).`,
        'error'
      );
      return;
    }
    // Update existing - Track changes for edit history
    const oldReceipt = editTarget;
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
    // Pass the baseline the user actually edited (the MODAL-OPEN snapshot) so a
    // concurrent change (e.g. a driver completing the delivery) triggers a 409
    // conflict + reload instead of being silently overwritten. editTarget is
    // re-resolved fresh at save time, and live-sync REPLACES the array slot
    // (applyServerDelta arr[idx]=clean), so editTarget._lastModified is the
    // NEW value while state.modalData still holds the frozen open-time object.
    const _openLastMod = (state.modalData && String(state.modalData.id) === String(receipt.id))
      ? state.modalData._lastModified
      : oldReceipt?._lastModified;
    const savedOk = await updateRecord(state.receipts, receipt.id, receipt, _openLastMod);
    if (!savedOk) return; // keep the modal open; updateRecord already explained the failure
    showNotification(state.language === 'ar' ? 'تم التحديث' : 'Updated', state.language === 'ar' ? 'تم تحديث الوصل بنجاح!' : 'Receipt updated successfully!', 'success');
    addLog('update', 'receipt', receipt.id, `Updated receipt${serialNumber ? ' #' + serialNumber : ''}`);
  } else {
    // Create new
    if (isServerModeEnabled()) {
      // Server-confirmed create: do NOT show success until the server confirms.
      let saved = null;
      try {
        const created = await apiCreateEntity('receipts', receipt);
        saved = created?.data ? Security.sanitizeObject(created.data) : null;
      } catch (e) {
        // The first POST may have committed while its response was lost; its
        // retry then receives 409. Accept only a matching server row.
        if (e?.status === 409) {
          try {
            const existing = await apiGetEntity('receipts', receipt.id);
            if (existing?.data && serverRecordMatchesCreateRetry(existing.data, receipt)) {
              saved = Security.sanitizeObject(existing.data);
            }
          } catch (_) {}
        }
        if (saved) {
          // Continue below as a confirmed idempotent success.
        } else {
        const status = e?.status ? `HTTP ${e.status}` : '';
        const detail = (e?.payload && typeof e.payload === 'object' && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
        showNotification(isArV ? 'خطأ في الخادم' : 'Server Error', `${isArV ? 'فشل إنشاء الوصل' : 'Failed to create receipt'}: ${status ? status + ' - ' : ''}${detail}`, 'error');
        return; // keep modal open so user can retry
        }
      }
      if (!saved || !saved.id) {
        showNotification(isArV ? 'خطأ في الخادم' : 'Server Error', isArV ? 'فشل إنشاء الوصل: استجابة غير صالحة من الخادم' : 'Failed to create receipt: invalid server response', 'error');
        return;
      }
      // Insert into local state only after server confirmation.
      const savedIdx = state.receipts.findIndex(r => r && String(r.id) === String(saved.id));
      if (savedIdx === -1) state.receipts.unshift(saved);
      else state.receipts[savedIdx] = saved;
      markCollectionDirty('receipts');
      saveState();
      if (isTempDelivery && canShareDeliveryReceiptToWhatsApp(saved)) {
        newlyCreatedDeliveryReceiptId = String(saved.id || '');
      }
      showNotification(state.language === 'ar' ? 'تمت الإضافة' : 'Success', state.language === 'ar' ? 'تم إنشاء الوصل بنجاح!' : 'Receipt created successfully!', 'success');
      addLog('create', 'receipt', saved.id, `Created receipt${saved.tempReceiptNo ? ' #' + saved.tempReceiptNo : (serialNumber ? ' #' + serialNumber : '')} for ${customerName}`);
    } else {
      const savedOk = await addRecord(state.receipts, receipt);
      if (!savedOk) return;
      const savedLocalReceipt = state.receipts.find(item => item && !item._deleted && String(item.id) === String(receipt.id)) || receipt;
      if (isTempDelivery && canShareDeliveryReceiptToWhatsApp(savedLocalReceipt)) {
        newlyCreatedDeliveryReceiptId = String(savedLocalReceipt.id || '');
      }
      showNotification(state.language === 'ar' ? 'تمت الإضافة' : 'Success', state.language === 'ar' ? 'تم إنشاء الوصل بنجاح!' : 'Receipt created successfully!', 'success');
      addLog('create', 'receipt', receipt.id, `Created receipt${serialNumber ? ' #' + serialNumber : ''} for ${customerName}`);
    }
  }
  
  // Reset modal state FIRST
  state.activeModal = null;
  state.modalData = null;
  // Clear the modal/id URL params too. Leaving them meant the just-saved (or a
  // previously edited) receipt id lingered in the URL and could be restored
  // into state.modalData by a later back/refresh — the exact stale-target the
  // frozen editTarget id above defends the save against; clear it at the source.
  try { clearUrlParams(['modal', 'id']); } catch (_) {}

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
  if (newlyCreatedDeliveryReceiptId) {
    setTimeout(() => showDeliveryWhatsAppPrompt(newlyCreatedDeliveryReceiptId), 0);
  }
  
  } catch (error) {
    console.error('Error saving receipt:', error);
    showNotification(isArV ? 'خطأ' : 'Error', (isArV ? 'فشل حفظ الوصل: ' : 'Failed to save receipt: ') + error.message, 'error');
    
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

// ==========================================
// RECEIPT NUMBER VALIDATION
// ==========================================

// Real-time validation for receipt number input
function validateReceiptNumberInput(input) {
  const errorDiv = document.getElementById('receipt-serial-error');
  const originalValue = input.value;

  // App-generated serials (S1 / B2 / O3 / E4) are valid as-is — never strip
  // their prefix. The field is read-only for those methods anyway.
  if (isAutoSerialNumber(originalValue)) {
    if (errorDiv) errorDiv.classList.add('hidden');
    input.classList.remove('border-rose-500', 'focus:ring-rose-500/20');
    return;
  }

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
      errorDiv.innerHTML = '<i data-lucide="alert-circle" class="w-3 h-3 inline mr-1"></i>' + (state.language === 'ar' ? 'رقم الوصل لا يمكن أن يبدأ بصفر' : 'Receipt number cannot start with zero');
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
  
  // Check for duplicates (excluding current record if editing).
  // Search state.receipts — receipts were migrated OUT of state.ads long ago
  // (normalizeReceiptsFromAds strips recordType==='receipt' from ads on every
  // load), so the old state.ads lookup never found anything and this live
  // warning was a silent no-op. Mirrors the save-time check in saveReceipt.
  const existingReceipt = state.receipts.find(receipt =>
    receipt.serialNumber === serialNumber &&
    receipt.id !== (state.modalData ? state.modalData.id : null) &&
    !receipt._deleted
  );

  if (existingReceipt) {
    const customer = state.customers.find(c => c.id === existingReceipt.customerId);
    const customerName = customer ? customer.name : 'Unknown';
    
    // Show error message with link to customer
    if (errorDiv) {
      errorDiv.innerHTML = `
        <div class="flex items-center space-x-2">
          <i data-lucide="alert-circle" class="w-3 h-3"></i>
          <span>${state.language === 'ar' ? 'موجود بالفعل! مرتبط بـ:' : 'Already exists! Linked to:'} <strong>${Security.escapeHtml(customerName)}</strong></span>
          <button type="button" onclick="goToCustomerFromWarning('${existingReceipt.customerId}')"
            class="ml-1 text-indigo-600 hover:text-indigo-700 underline font-bold">
            ${state.language === 'ar' ? 'عرض العميل ←' : 'View Customer →'}
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
  const isArDup = state.language === 'ar';
  const warningModal = document.createElement('div');
  warningModal.className = 'mobile-dialog-overlay fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm';
  warningModal.id = 'duplicate-receipt-warning';
  
  warningModal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 max-w-md w-full animate-fade-in-up shadow-2xl">
      <div class="flex items-start space-x-4 mb-4">
        <div class="w-12 h-12 bg-rose-100 dark:bg-rose-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
          <i data-lucide="alert-triangle" class="w-6 h-6 text-rose-600"></i>
        </div>
        <div>
          <h3 class="text-xl font-bold text-slate-800 dark:text-white mb-2">${isArDup ? 'رقم الوصل موجود بالفعل' : 'Receipt Number Already Exists'}</h3>
          <p class="text-sm text-slate-600 dark:text-slate-400">
            ${isArDup ? 'رقم الوصل' : 'Receipt number'} <span class="font-mono font-bold text-rose-600">#${receiptNumber}</span> ${isArDup ? 'محفوظ بالفعل.' : 'is already saved.'}
          </p>
        </div>
      </div>
      
      <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl mb-4">
        <div class="flex items-center space-x-2 mb-2">
          <i data-lucide="user" class="w-4 h-4 text-slate-500"></i>
          <span class="text-xs font-medium text-slate-500 uppercase">${isArDup ? 'مرتبط بالعميل' : 'Linked to Customer'}</span>
        </div>
        <p class="text-lg font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customerName)}</p>
      </div>
      
      <div class="flex space-x-3">
        <button onclick="closeDuplicateWarning()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-4 py-2 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors">
          ${isArDup ? 'إغلاق' : 'Close'}
        </button>
        <button onclick="goToCustomerFromWarning('${customerId}')" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center space-x-2">
          <i data-lucide="arrow-right" class="w-4 h-4"></i>
          <span>${isArDup ? 'عرض العميل' : 'View Customer'}</span>
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
  const isArS = state.language === 'ar';
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
        serialInput.placeholder = isArS ? 'رقم مؤقت (يولّده الخادم)' : 'Temporary number (server-generated)';
        if (tempHint) {
          tempHint.classList.remove('hidden');
          tempHint.textContent = isTempDeliveryReceiptNo(existing)
            ? (isArS ? `الرقم المؤقت: ${existing} (بانتظار التوصيل)` : `Temporary number: ${existing} (Pending Delivery)`)
            : (isArS ? 'سيتم تعيين الرقم المؤقت عند الحفظ (بانتظار التوصيل)' : 'Temporary number will be assigned when saved (Pending Delivery)');
        }
      } else {
        // Local mode fallback: generate a best-effort D{n}.
        serialInput.placeholder = isArS ? 'رقم مؤقت (تلقائي)' : 'Temporary number (auto)';
        const tempNo = ensureTempDeliveryReceiptNoInReceiptForm();
        if (tempHint) {
          tempHint.classList.remove('hidden');
          tempHint.textContent = isArS ? `الرقم المؤقت: ${tempNo} (بانتظار التوصيل)` : `Temporary number: ${tempNo} (Pending Delivery)`;
        }
      }
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.add('hidden');
      show(deliveryInfo, true);
    } else if (currentStatus === 'Not Paid') {
      const allow = isAdmin && adminOverride?.checked;
      serialInput.disabled = !allow;
      serialInput.readOnly = false;
      serialInput.placeholder = allow
        ? (isArS ? 'الأدمن يدخل رقم الوصل' : 'Admin entering receipt number')
        : (isArS ? 'مقفل حتى الدفع' : 'Locked until paid');
      // Stash the number instead of destroying it: the user may be only
      // glancing at "Not Paid" and switch back — the receipt's real number
      // used to be wiped from the form and then saved as empty.
      if (!allow) {
        if (String(serialInput.value || '').trim()) {
          serialInput.dataset.stashedSerial = serialInput.value;
        }
        serialInput.value = '';
      }
      if (tempHint) tempHint.classList.add('hidden');
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.toggle('hidden', !isAdmin);
      show(deliveryInfo, false);
    } else {
      serialInput.disabled = false;
      serialInput.readOnly = false;
      serialInput.placeholder = isArS ? 'مثال: 12345' : 'e.g., 12345';
      // Switching back out of "Not Paid": restore the number we stashed above.
      if (!String(serialInput.value || '').trim() && serialInput.dataset.stashedSerial) {
        serialInput.value = serialInput.dataset.stashedSerial;
        delete serialInput.dataset.stashedSerial;
      }
      if (tempHint) tempHint.classList.add('hidden');
      const overrideLabel = adminOverride?.closest('label');
      if (overrideLabel) overrideLabel.classList.toggle('hidden', !isAdmin);
      show(deliveryInfo, false);
      // This branch just cleared readOnly — re-apply the auto-serial rules so a
      // Paid receipt on an auto-numbered method keeps its number and its lock.
      syncReceiptSerialWithPaymentMethods({ reissue: false });
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
  return getLinkedPagesForCustomer(customerId);
}

function getReceiptsForAd(customerId, pageId) {
  if (!customerId) return [];
  return getVisibleRecords(state.receipts || []).filter(r => {
    if (!r || r._deleted) return false;
    if (r.customerId !== customerId) return false;
    // Receipt credit belongs to the customer, not to one Facebook page. Older
    // receipts can still carry a legacy pageId, so filtering on it hid valid
    // replacement funds when an ad was moved to (or created for) another page.
    // The server uses the same customer-level ownership rule.
    const statusLower = String(r.status || '').toLowerCase();
    const isPaid = (r.isPaid === true) || statusLower === 'paid';
    if (!isPaid) return false;

    // Funding receipts must be real paid receipts.
    // Temp delivery receipts (D#) are allowed ONLY after they are finalized:
    // - a final receipt number exists (digits or S-prefixed)
    // A receipt may be collected/marked Paid from the Receipts screen after its
    // delivery workflow. Its old deliveryStatus can remain Office, but Paid plus
    // a final number is authoritative and is also what the server accepts.
    const looksTemp = (String(r.receiptType || '').toUpperCase() === 'DELIVERY_TEMP') || isTempDeliveryReceiptNo(r.tempReceiptNo);
    if (looksTemp) {
      const finalNo = String(r.finalReceiptNo || r.serialNumber || '').trim();
      // Accept either digits (123) or S-prefixed (S1, S2) for LTT/Libyana/Madar
      const hasFinalNo = (/^\d+$/.test(finalNo) && !finalNo.startsWith('0')) || isAutoSerialNumber(finalNo);
      if (!hasFinalNo) return false;
    }

    return true;
  });
}

function getReceiptRemainingUSD(receipt) {
  const usage = getReceiptUsageStats(receipt);
  return usage.remainingUSD || 0;
}

function initAdFunding(adData = {}) {
  // COPY each allocation (not alias — editing the form must not mutate the
  // saved ad until Save) and snap the amount to 2 decimals for display:
  // stored values can carry float residue from proportional stop-ad math
  // (e.g. 50.000000000000001), which otherwise shows raw in the input.
  const isUnpaidShopDebt = getAdPaymentState(adData) === 'not_paid'
    && String(adData.collectionMethod || '').toLowerCase() === 'in_shop';
  const sourceAllocations = isUnpaidShopDebt && Array.isArray(adData.dueAllocations)
    ? adData.dueAllocations
    : adData.receiptAllocations;
  const allocations = Array.isArray(sourceAllocations)
      ? sourceAllocations.map(a => ({
          ...a,
          amountUSD: (a && a.amountUSD !== '' && a.amountUSD !== null && isFinite(parseFloat(a.amountUSD)))
            ? Math.round(parseFloat(a.amountUSD) * 100) / 100
            : (a ? a.amountUSD : '')
        }))
      : [];
  state.tempAdFunding = {
    allocations,
    // Frozen only for clear edit feedback. The authoritative comparison at
    // save time remains state.modalData/server optimistic locking.
    originalAllocations: allocations.map(row => ({ ...row }))
  };
}

// When EDITING an ad, getReceiptUsageStats counts the ad's own saved
// allocation as "used" on its receipts. Every edit-form display must add that
// share back, otherwise the form double-counts the ad against itself — e.g. a
// $50 ad on a $200 receipt showed Balance $100 instead of $150, as if a brand
// new ad were being created next to the old one. (The save-time validation
// already does this add-back; this is the display-side counterpart.)
// kind: 'receipt' (paid funding rows) | 'merged' (merged paid-funds rows).
function getEditingAdExistingAllocationUSD(receiptId, kind = 'receipt') {
  if (!state.modalData?.id) return 0;
  const existingAd = state.ads.find(a => a.id === state.modalData.id) || state.modalData;
  if (!existingAd) return 0;
  const rid = String(receiptId || '');
  const savedMerged = Array.isArray(existingAd.mergedPaidAllocations)
    && existingAd.mergedPaidAllocations.length
    ? existingAd.mergedPaidAllocations
    : existingAd.receiptAllocations;
  const sources = kind === 'merged'
    ? [savedMerged]
    : [existingAd.receiptAllocations];
  const collectionMethod = String(existingAd.collectionMethod || '').toLowerCase();
  const isUnpaidReceiptDebt = getAdPaymentState(existingAd) === 'not_paid'
    && (collectionMethod === 'driver' || collectionMethod === 'in_shop');
  if (kind === 'receipt' && isUnpaidReceiptDebt) sources.push(existingAd.dueAllocations);

  let total = sources.reduce((sum, src) => {
    if (!Array.isArray(src)) return sum;
    return sum + src.filter(a => a && String(a.receiptId) === rid)
      .reduce((rowSum, a) => rowSum + (parseFloat(a.amountUSD) || 0), 0);
  }, 0);
  const explicitDueForReceipt = Array.isArray(existingAd.dueAllocations)
    ? existingAd.dueAllocations
        .filter(row => row && String(row.receiptId || '') === rid)
        .reduce((sum, row) => sum + (parseFloat(row.amountUSD) || 0), 0)
    : 0;
  if (kind === 'receipt' && isUnpaidReceiptDebt && explicitDueForReceipt <= 0) {
    total += getAdLegacyDueMirrorUSD(existingAd, rid);
  }
  return Math.round(total * 100) / 100;
}

function handleAdCustomerChange(customerId, preserveFunding = false) {
  // Reset page and funding when customer changes
  const pageSelect = document.getElementById('ad-page');
  if (pageSelect) {
    const pages = getPagesForCustomer(customerId);
    pageSelect.innerHTML = `<option value="">${state.language === 'ar' ? 'اختر صفحة' : 'Select page'}</option>${pages.map(p => `<option value="${Security.escapeHtml(p.id)}">${Security.escapeHtml(p.name)}</option>`).join('')}`;
    if (preserveFunding && state.modalData?.pageId && pages.some(p => p.id === state.modalData.pageId)) {
      pageSelect.value = state.modalData.pageId;
    } else {
      pageSelect.value = '';
    }
  }

  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  if (!preserveFunding) {
    state.tempAdFunding.allocations = [];
    // MERGED funding is customer-scoped too. It used to survive a customer
    // change, so an ad could be funded from ANOTHER customer's receipt.
    clearAdMergeFunding();
  }

  renderAdFundingList();
}

// Receipts belong to a customer: whenever the ad's customer/page changes, the
// merged-funds allocations from the previous customer must go with it.
function clearAdMergeFunding() {
  state.tempMergeFunding = { allocations: [], enabled: false };
  state.tempMixedReceiptTargetUSD = null;
  try { if (typeof renderAdMergedFundingList === 'function') renderAdMergedFundingList(); } catch (_) {}
  try { if (typeof reflectMergeFundingUI === 'function') reflectMergeFundingUI(); } catch (_) {}
}

function getTempMergeFundingTotalUSD() {
  const total = (state.tempMergeFunding?.allocations || []).reduce(
    (sum, row) => sum + (parseFloat(row?.amountUSD) || 0),
    0
  );
  return Math.round(total * 100) / 100;
}

// Beginner-friendly bridge from the Paid form to the canonical mixed-debt
// flow. Example: the user entered $5 on a paid receipt with only $4.63 left.
// Keep $4.63 as real paid funding, then visibly switch to Not Paid + In Shop
// so the user can choose an unpaid receipt for the exact $0.37 difference.
function startAdMixedReceiptFunding() {
  const isAr = state.language === 'ar';
  const customerId = String(document.getElementById('ad-customer-id')?.value || '').trim();
  if (!customerId) {
    showNotification(
      isAr ? 'تنبيه' : 'Validation',
      isAr ? 'اختر الصفحة والعميل أولاً.' : 'Select the page and customer first.',
      'error'
    );
    return;
  }

  const requestedRows = (state.tempAdFunding?.allocations || [])
    .filter(row => row?.receiptId && (parseFloat(row.amountUSD) || 0) > 0);
  if (!requestedRows.length) {
    showNotification(
      isAr ? 'تنبيه' : 'Validation',
      isAr ? 'اختر وصلاً مدفوعاً وأدخل ميزانية الإعلان أولاً.' : 'Choose a paid receipt and enter the ad budget first.',
      'error'
    );
    return;
  }

  let targetTotal = 0;
  const paidRows = [];
  for (const requested of requestedRows) {
    const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === String(requested.receiptId));
    const requestedAmount = Math.round((parseFloat(requested.amountUSD) || 0) * 100) / 100;
    targetTotal += requestedAmount;
    const receiptStatus = String(receipt?.status || '').toLowerCase();
    const receiptIsPaid = !!receipt && (receipt.isPaid === true || receiptStatus === 'paid');
    if (!receiptIsPaid || String(receipt.customerId || '') !== customerId) {
      showNotification(
        isAr ? 'تنبيه' : 'Validation',
        isAr ? 'الوصل المدفوع غير صالح أو يخص عميلاً آخر.' : 'The paid receipt is invalid or belongs to another customer.',
        'error'
      );
      return;
    }
    const usage = getReceiptUsageStats(receipt);
    const available = Math.max(
      Math.round(((usage.remainingUSD || 0) + getEditingAdExistingAllocationUSD(receipt.id)) * 100) / 100,
      0
    );
    const paidAmount = Math.min(requestedAmount, available);
    if (paidAmount > 0.009) {
      paidRows.push({ receiptId: receipt.id, amountUSD: paidAmount.toFixed(2) });
    }
  }

  targetTotal = Math.round(targetTotal * 100) / 100;
  const paidTotal = Math.round(paidRows.reduce((sum, row) => sum + Number(row.amountUSD), 0) * 100) / 100;
  const shortfall = Math.round(Math.max(targetTotal - paidTotal, 0) * 100) / 100;
  if (targetTotal <= 0 || shortfall <= 0.009) {
    showNotification(
      isAr ? 'الرصيد كافٍ' : 'Paid Balance Is Enough',
      isAr ? 'الوصولات المدفوعة المختارة تغطي ميزانية الإعلان بالكامل، لذلك لا يوجد فرق غير مدفوع.' : 'The selected paid receipts already cover the full ad budget, so there is no unpaid difference.',
      'info'
    );
    return;
  }

  if (!getUnpaidShopReceiptsForCustomer(customerId).length) {
    showNotification(
      isAr ? 'لا يوجد وصل غير مدفوع' : 'No Unpaid Receipt',
      isAr ? `أنشئ وصلاً «غير مدفوع - في المحل» لهذا العميل لتغطية الفرق $${shortfall.toFixed(2)}.` : `Create a “Not Paid - In Shop” receipt for this customer to cover the $${shortfall.toFixed(2)} difference.`,
      'error'
    );
    return;
  }

  state.tempMixedReceiptTargetUSD = targetTotal;
  state.tempMergeFunding = { allocations: paidRows, enabled: true };
  state.tempAdFunding = { allocations: [] };
  setAdPaymentStatus('not_paid');
  setAdCollectionMethod('in_shop');
  reflectMergeFundingUI();
  showNotification(
    isAr ? 'اختر الوصل غير المدفوع' : 'Select the Unpaid Receipt',
    isAr
      ? `سيُستخدم $${paidTotal.toFixed(2)} من المدفوع. اختر الآن وصلاً غير مدفوع للفرق $${shortfall.toFixed(2)}.`
      : `$${paidTotal.toFixed(2)} will come from paid credit. Now select an unpaid receipt for the $${shortfall.toFixed(2)} difference.`,
    'info'
  );
  setTimeout(() => {
    document.getElementById('ad-temp-receipt-link')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, 0);
}

function handleAdPageChange(preserveFunding = false) {
  // Clear funding when page changes (unless we're initializing an edit modal and want to keep existing allocations)
  state.tempAdFunding = state.tempAdFunding || { allocations: [] };
  if (!preserveFunding) {
  state.tempAdFunding.allocations = [];
  clearAdMergeFunding();
  }
  renderAdFundingList();
}

// Select a page in the Add Ad modal (Page-first workflow)
function selectAdPage(pageId, preserveFunding = false) {
  if (!Security.isValidRecordId(pageId)) return;
  const isArP = state.language === 'ar';
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
  // Deleted customers must never be offered (or auto-selected) as the ad's
  // customer — page.customerIds can still hold ids of customers deleted later.
  const linkedCustomers = state.customers.filter(c => c && !c._deleted && linkedCustomerIds.includes(c.id));
  
  // Show customer section
  if (customerSection) customerSection.classList.remove('hidden');
  
  if (linkedCustomers.length === 0) {
    // No customers linked to this page
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-center">
          <i data-lucide="alert-triangle" class="w-5 h-5 mx-auto mb-1 text-amber-500"></i>
          <p class="text-xs text-amber-700 dark:text-amber-300">${isArP ? 'لا يوجد عملاء مرتبطون.' : 'No customers linked.'}</p>
          <button type="button" onclick="closeModal(); navigateTo('pages')" class="mt-1 text-xs text-amber-600 hover:text-amber-700 font-medium">${isArP ? 'ربط ←' : 'Link →'}</button>
        </div>
      `;
    }
    if (customerIdInput) customerIdInput.value = '';
    if (customerHint) customerHint.textContent = isArP ? '(لا يوجد عملاء)' : '(no customers)';
  } else if (linkedCustomers.length === 1) {
    // Single customer - auto-select
    const customer = linkedCustomers[0];
    if (customerIdInput) customerIdInput.value = customer.id;
    if (customerHint) customerHint.textContent = isArP ? '(محدد تلقائياً)' : '(auto-selected)';
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="flex items-center space-x-3 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-medium text-sm">
            ${customer.name?.charAt(0) || 'C'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-slate-700 dark:text-slate-200 truncate">${Security.escapeHtml(customer.name || '')}</div>
            <div class="text-[10px] text-slate-400">${Security.escapeHtml(customer.platform || '')} • ${Security.escapeHtml(customer.phones?.[0] || (state.language === 'ar' ? 'لا يوجد هاتف' : 'No phone'))}</div>
          </div>
          <span class="text-[10px] text-indigo-600 dark:text-indigo-400">✓</span>
        </div>
      `;
    }
  } else {
    // Multiple customers - show selection cards
    if (customerHint) customerHint.textContent = isArP ? '(اختر واحداً)' : '(select one)';
    const currentCustomerId = customerIdInput?.value || '';
    if (customerDisplay) {
      customerDisplay.innerHTML = `
        <div class="relative mb-2">
          <i data-lucide="search" class="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
          <input type="text" placeholder="${isArP ? 'بحث...' : 'Search...'}" class="w-full glass-input pl-8 pr-3 py-1.5 rounded-lg text-xs" oninput="filterAdCustomers(this.value)" />
        </div>
        <div id="ad-customer-cards" class="grid grid-cols-2 gap-2 max-h-28 overflow-y-auto">
          ${linkedCustomers.map(c => {
            const isSelected = c.id === currentCustomerId;
            return `
              <button type="button" data-record-action="select-ad-customer" data-record-id="${Security.escapeHtml(String(c.id || ''))}" class="ad-customer-btn group p-2 rounded-lg text-left transition-all ${isSelected ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-400'}" data-customer-id="${Security.escapeHtml(String(c.id || ''))}" data-customer-name="${Security.escapeHtml((c.name || '').toLowerCase())}">
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
  if (!Security.isValidRecordId(customerId)) return;
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
    clearAdMergeFunding();
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

function isUnpaidShopReceipt(receipt, customerId = '') {
  if (!receipt || receipt._deleted) return false;
  if (customerId && String(receipt.customerId || '') !== String(customerId)) return false;
  const status = String(receipt.status || '');
  if (status !== 'Not Paid' || receipt.isPaid === true) return false;
  const detail = receipt.statusDetail && typeof receipt.statusDetail === 'object'
    ? receipt.statusDetail
    : {};
  const collection = String(detail.notPaidCollection || '').trim().toLowerCase();
  const tempNo = String(receipt.tempReceiptNo || '').trim();
  const receiptType = String(receipt.receiptType || '').trim().toUpperCase();
  const deliveryStatus = String(receipt.deliveryStatus || '').trim();
  if (collection && !['office', 'in_shop', 'shop'].includes(collection)) return false;
  if ((tempNo.startsWith('D') && /^D\d+$/.test(tempNo)) || receiptType === 'DELIVERY_TEMP') return false;
  if (deliveryStatus && deliveryStatus !== 'Office') return false;
  return status !== 'Canceled' && status !== 'Lost';
}

function getUnpaidShopReceiptsForCustomer(customerId) {
  const cid = String(customerId || '');
  if (!cid) return [];
  return getVisibleRecords(state.receipts)
    .filter(receipt => isUnpaidShopReceipt(receipt, cid))
    .filter(receipt => getDeliveryReceiptDueUsage(receipt).remainingDueUSD > 0.009)
    .sort((a, b) => new Date(b.createdAt || b.startDate || 0) - new Date(a.createdAt || a.startDate || 0));
}

function refreshAdTempReceiptOptions() {
  const isArT = state.language === 'ar';
  const paymentStatus = document.getElementById('ad-payment-status')?.value || '';
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  const section = document.getElementById('ad-temp-receipt-link');
  const select = document.getElementById('ad-temp-receipt-id');
  const hidden = document.getElementById('ad-linked-receipt-id');
  const hint = document.getElementById('ad-temp-receipt-hint');
  const label = document.getElementById('ad-linked-receipt-label');
  const help = document.getElementById('ad-linked-receipt-help');
  const dueTitle = document.getElementById('ad-due-title');
  const dueAmountLabel = document.getElementById('ad-due-amount-label');
  if (!section || !select || !hidden) return;

  const isShop = collectionMethod === 'in_shop';
  const isDriver = collectionMethod === 'driver';
  const isEditingSavedAd = !!state.modalData?.id;
  const shouldShow = paymentStatus === 'not_paid' && (isDriver || isShop) && !!customerId;
  section.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    hidden.value = '';
    if (hint) hint.textContent = '';
    select.innerHTML = `<option value="">${isArT ? 'اختر وصلاً معلقاً...' : 'Select pending receipt...'}</option>`;
    return;
  }

  if (label) label.textContent = isShop
    ? (isArT ? 'ربط وصل غير مدفوع في المحل' : 'Link Unpaid In-Shop Receipt')
    : (isArT ? 'ربط وصل توصيل (D#)' : 'Link Delivery Receipt (D#)');
  if (help) {
    const editHelp = isEditingSavedAd
      ? (isArT
          ? 'يمكنك استبدال الوصل المرتبط. عند الحفظ سيعيد النظام الرصيد المحجوز إلى الوصل القديم ويستخدم الوصل الجديد معاً في عملية واحدة.'
          : 'You can replace the linked receipt. On Save, reserved credit returns to the old receipt and the new receipt is used together in one transaction.')
      : '';
    const debtHelp = isShop
      ? (isArT
          ? 'سيظهر مبلغ الإعلان كدين (ناقص) حتى تسجيل الدفع.'
          : 'The ad amount remains customer debt (minus) until payment is recorded.')
      : '';
    help.classList.toggle('hidden', !(editHelp || debtHelp));
    help.textContent = [editHelp, debtHelp].filter(Boolean).join(' ');
  }
  if (dueTitle) dueTitle.textContent = isShop
    ? (isArT ? 'ميزانية الإعلان من الوصل غير المدفوع' : 'Ad Budget from Unpaid Receipt')
    : (isArT ? 'استخدام رصيد من الوصل المستحق' : 'Use Credit from Due Receipt');
  if (dueAmountLabel) dueAmountLabel.textContent = isShop
    ? (isArT ? 'ميزانية الإعلان (USD)' : 'Ad Budget (USD)')
    : (isArT ? 'الصرف المخطط (USD)' : 'Planned Spend (USD)');

  const receipts = isShop
    ? getUnpaidShopReceiptsForCustomer(customerId)
    : getPendingTempDeliveryReceiptsForCustomer(customerId);
  let current = String(hidden.value || '').trim()
    || String(state.modalData?.linkedDeliveryReceiptId || state.modalData?.receiptId || '').trim();
  const editingSameMode = isEditingSavedAd
    && String(state.modalData?.collectionMethod || '') === collectionMethod;
  if (!receipts.some(r => String(r.id) === current) && !editingSameMode) current = '';

  // The list only holds PENDING delivery receipts. A saved ad whose receipt has
  // since been delivered would therefore find its own link missing from the
  // options — and the auto-suggest below would silently RE-LINK the ad to a
  // different receipt (spending another receipt's money). Keep the ad's own
  // receipt in the list, marked as no longer pending.
  const linkedReceipt = current && editingSameMode
    ? getVisibleRecords(state.receipts).find(r => String(r.id) === current)
    : null;
  const linkedIsListed = !!linkedReceipt && receipts.some(r => String(r.id) === current);
  const extraOption = (linkedReceipt && !linkedIsListed)
    ? (() => {
        const place = String(linkedReceipt.deliveryPlaceName || '').trim();
        const note = isShop
          ? (isArT ? 'لم يعد غير مدفوع' : 'no longer unpaid')
          : (isArT ? 'غير معلق' : 'no longer pending');
        const optionLabel = `${linkedReceipt.tempReceiptNo || linkedReceipt.serialNumber || linkedReceipt.id.slice(0, 8)}${place ? ' • ' + place : ''} • (${note})`;
        return `<option value="${linkedReceipt.id}" selected>${Security.escapeHtml(optionLabel)}</option>`;
      })()
    : '';

  select.innerHTML = [
    `<option value="">${isShop ? (isArT ? 'اختر وصلاً غير مدفوع...' : 'Select an unpaid receipt...') : (isArT ? 'اختر وصلاً معلقاً...' : 'Select pending receipt...')}</option>`,
    extraOption,
    ...receipts.map(r => {
      // Calculate available credit in USD
      const dueUsage = getDeliveryReceiptDueUsage(r);
      const availableUSD = dueUsage.remainingDueUSD;
      const place = String(r.deliveryPlaceName || '').trim();
      const receiptNumber = r.tempReceiptNo || r.serialNumber || r.finalReceiptNo || (isArT ? 'وصل بدون رقم' : 'Unnumbered receipt');
      const optionLabel = `${receiptNumber}${place ? ' • ' + place : ''} • $${availableUSD.toFixed(2)} ${isArT ? 'متاح' : 'available'}`;
      const selected = String(r.id) === current ? 'selected' : '';
      return `<option value="${r.id}" ${selected}>${Security.escapeHtml(optionLabel)}</option>`;
    })
  ].join('');

  // Auto-suggest the newest pending receipt — but ONLY for a NEW ad. Never
  // pick a receipt on the user's behalf for an ad that is already saved.
  let selectedId = String(select.value || '').trim();
  if (!selectedId && !isEditingSavedAd && isDriver && receipts.length > 0) {
    selectedId = String(receipts[0].id);
    select.value = selectedId;
  }
  onAdTempReceiptChange(selectedId);
}

function onAdTempReceiptChange(receiptId) {
  const isArC = state.language === 'ar';
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  const isShop = collectionMethod === 'in_shop';
  const hidden = document.getElementById('ad-linked-receipt-id');
  const hint = document.getElementById('ad-temp-receipt-hint');
  const driverSelect = document.getElementById('ad-delivery-person');
  const dueSection = document.getElementById('ad-due-amount-section');
  const mergeToggle = document.getElementById('ad-merge-funds-toggle');
  const dueAvailable = document.getElementById('ad-due-available');
  const dueInput = document.getElementById('ad-due-amount-to-use');
  const unpaidFinancial = document.getElementById('ad-unpaid-financial');
  
  if (!hidden) return;
  hidden.value = String(receiptId || '');

  const rid = String(receiptId || '').trim();
  if (!rid) {
    if (hint) hint.textContent = '';
    if (driverSelect) driverSelect.disabled = false;
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    if (dueInput) {
      dueInput.value = '';
      dueInput.dataset.maxDue = '0';
      dueInput.dataset.receiptId = '';
    }
    if (isShop && unpaidFinancial) unpaidFinancial.classList.remove('hidden');
    if (isShop) state.tempAdFunding = { allocations: [] };
    renderAdDueReceiptReplacementNotice();
    return;
  }

  const r = state.receipts.find(x => x && !x._deleted && String(x.id) === rid);
  if (!r) {
    if (hint) hint.textContent = isArC ? 'الوصل المحدد غير موجود. جرّب التحديث.' : 'Selected receipt not found. Try Refresh.';
    if (driverSelect) driverSelect.disabled = false;
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    if (dueInput) {
      dueInput.value = '';
      dueInput.dataset.maxDue = '0';
      dueInput.dataset.receiptId = '';
    }
    renderAdDueReceiptReplacementNotice();
    return;
  }

  const customerId = document.getElementById('ad-customer-id')?.value || '';
  if (customerId && String(r.customerId || '') !== String(customerId)) {
    if (hint) hint.textContent = isArC ? 'عميل الوصل غير مطابق. الرجاء اختيار العميل الصحيح.' : 'Receipt customer mismatch. Please select the correct customer.';
    if (dueSection) dueSection.classList.add('hidden');
    if (mergeToggle) mergeToggle.classList.add('hidden');
    if (dueInput) {
      dueInput.value = '';
      dueInput.dataset.maxDue = '0';
      dueInput.dataset.receiptId = '';
    }
  } else {
    const place = String(r.deliveryPlaceName || '').trim();
    const fee = Number(r.quotedDeliveryFee ?? 0) || 0;
    const dueLYD = Number(r.debtAmountLocal ?? r.amountLocal ?? 0) || 0;
    
    // Calculate available credit in USD using the new tracking function
    const dueUsage = getDeliveryReceiptDueUsage(r);
    let availableUSD = dueUsage.remainingDueUSD;
    // When EDITING an ad, add back this ad's own due usage so its existing
    // allocation can be shown and preserved. Without this, editing an ad that
    // used the receipt's full due credit computed available=$0, skipped the
    // prefill, and on save wiped the allocation — silently resurrecting the
    // spent credit and zeroing the ad's budget.
    if (state.modalData?.id) {
      const existingAd = state.ads.find(a => a.id === state.modalData.id);
      if (existingAd) {
        const explicitDueForReceipt = Array.isArray(existingAd.dueAllocations)
          ? existingAd.dueAllocations
              .filter(a => String(a?.receiptId || '') === rid)
              .reduce((sum, a) => sum + (parseFloat(a?.amountUSD) || 0), 0)
          : 0;
        availableUSD += explicitDueForReceipt > 0
          ? explicitDueForReceipt
          : getAdLegacyDueMirrorUSD(existingAd, rid, r.exchangeRate);
      }
    }
    const exchangeRate = dueUsage.exchangeRate || state.defaultExchangeRate || 1;
    const budgetRate = document.getElementById('ad-driver-budget-rate');
    if (budgetRate) budgetRate.value = String(exchangeRate);
    updateAdDriverBudgetSummary();
    
    const receiptNumber = r.tempReceiptNo || r.serialNumber || r.finalReceiptNo || (isArC ? 'وصل بدون رقم' : 'Unnumbered receipt');
    const txt = isShop
      ? `${receiptNumber} • ${isArC ? 'وصل غير مدفوع في المحل' : 'Unpaid In-Shop receipt'} • $${availableUSD.toFixed(2)}`
      : `${receiptNumber}${r.finalReceiptNo || r.serialNumber ? ` → ${r.finalReceiptNo || r.serialNumber}` : ''}${place ? ` • ${place}` : ''} • ${isArC ? 'الرسوم المتفق عليها' : 'Quoted fee'} ${fee.toFixed(0)} LYD`;
    if (hint) hint.textContent = txt;
    
    // Show due amount section if there's available credit
    if (availableUSD > 0.01) {
      if (dueSection) dueSection.classList.remove('hidden');
      if (dueAvailable) dueAvailable.textContent = `${isArC ? 'المتاح' : 'Available'}: $${availableUSD.toFixed(2)} (${(availableUSD * exchangeRate).toFixed(0)} LYD)`;
      if (dueInput) {
        // Store the max due amount in USD for validation
        dueInput.dataset.maxDue = availableUSD.toString();
        dueInput.dataset.exchangeRate = exchangeRate.toString();
        
        // Check if editing - load existing dueAmountToUseUSD from modalData
        let prefillValue = null;
        if (String(state.modalData?.linkedDeliveryReceiptId || state.modalData?.receiptId || '') === rid) {
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
        
        // Preserve an existing saved value, but never spend delivery receipt
        // credit just because the receipt was selected. The user can explicitly
        // enter an amount or press "Use Full Credit" when that is intended.
        // The field is stamped with the receipt it belongs to: switching the
        // linked receipt used to KEEP the previous receipt's amount (the
        // "Available" label updated, the amount did not), so the ad could be
        // saved spending more than the new receipt actually holds.
        const belongsToThisReceipt = dueInput.dataset.receiptId === rid;
        const originalReceiptId = String(state.modalData?.linkedDeliveryReceiptId || state.modalData?.receiptId || '');
        const replacingSavedReceipt = !!state.modalData?.id && !!originalReceiptId && originalReceiptId !== rid;
        const originalDueAmount = replacingSavedReceipt ? getOriginalAdDueAllocationUSD() : 0;
        if (prefillValue !== null) {
          const parsedPrefill = Number(prefillValue);
          dueInput.value = Number.isFinite(parsedPrefill) && parsedPrefill > 0
            ? parsedPrefill.toFixed(2)
            : '';
        } else if (replacingSavedReceipt && originalDueAmount > 0) {
          // Relinking changes the SOURCE, never the ad budget/allocation. Keep
          // the old due share exactly even if the new receipt is larger. If it
          // is smaller, save-time capacity validation blocks and asks the user
          // to choose/add funding instead of silently shrinking the ad.
          dueInput.value = originalDueAmount.toFixed(2);
          if (isShop) {
            state.tempMixedReceiptTargetUSD = normalizeAdDriverBudgetUSD(state.modalData?.amountUSD);
          }
        } else if (!belongsToThisReceipt) {
          // Selecting an office receipt is an explicit choice to use it, so
          // start with its full remaining amount. When the user arrived from
          // the Paid form's "use an unpaid receipt for the difference" action,
          // prefill only the exact shortfall instead. Delivery receipts keep
          // the safer blank default.
          const target = normalizeAdDriverBudgetUSD(state.tempMixedReceiptTargetUSD);
          const paidPart = getTempMergeFundingTotalUSD();
          const shortfall = target > 0 ? Math.max(target - paidPart, 0) : availableUSD;
          dueInput.value = isShop ? Math.min(availableUSD, shortfall).toFixed(2) : '';
        }
        dueInput.dataset.receiptId = rid;
      }
      // Both Driver and In Shop debt may combine due credit with real paid
      // receipt funds. The saved record remains Not Paid while any due part
      // exists, so the customer sees only the difference as debt.
      if (mergeToggle) mergeToggle.classList.remove('hidden');
      initMergeFunding();
      reflectMergeFundingUI();
    } else {
      // No credit available - all used up
      if (dueSection) dueSection.classList.add('hidden');
      if (dueInput) {
        dueInput.value = '';
        dueInput.dataset.maxDue = '0';
        dueInput.dataset.exchangeRate = exchangeRate.toString();
        dueInput.dataset.receiptId = rid;
      }
      if (mergeToggle) mergeToggle.classList.toggle('hidden', isShop);
      if (!isShop) {
        initMergeFunding();
        reflectMergeFundingUI();
      }
      // Update hint to show that credit is fully used
      if (hint) hint.textContent += isArC ? ' • ⚠️ الرصيد مستخدم بالكامل' : ' • ⚠️ Credit fully used';
    }

    updateAdDueSummary();
    if (isShop) {
      if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
      syncShopDueAllocationToFunding();
    }
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
  renderAdDueReceiptReplacementNotice();
}

function getAdReceiptDisplayLabel(receiptId) {
  const rid = String(receiptId || '');
  const receipt = (state.receipts || []).find(row => row && String(row.id) === rid);
  if (!receipt) return rid ? `#${rid.slice(0, 8)}` : '';
  const serial = receipt.finalReceiptNo || receipt.serialNumber || receipt.tempReceiptNo || rid.slice(0, 8);
  return `#${serial}`;
}

function getOriginalAdDueAllocationUSD() {
  const ad = state.modalData;
  if (!ad?.id) return 0;
  const originalReceiptId = String(ad.linkedDeliveryReceiptId || ad.receiptId || '');
  const explicitDueForReceipt = Array.isArray(ad.dueAllocations)
    ? ad.dueAllocations
      .filter(row => String(row?.receiptId || '') === originalReceiptId)
      .reduce((sum, row) => sum + (parseFloat(row?.amountUSD) || 0), 0)
    : 0;
  if (explicitDueForReceipt > 0) return Math.round(explicitDueForReceipt * 100) / 100;
  return getAdLegacyDueMirrorUSD(ad, originalReceiptId);
}

// Explain a due/debt receipt replacement before it is committed. This is
// especially important on phones where the old option may scroll out of view.
function renderAdDueReceiptReplacementNotice() {
  const notice = document.getElementById('ad-linked-receipt-change');
  if (!notice) return;
  const ad = state.modalData;
  const paymentStatus = document.getElementById('ad-payment-status')?.value || '';
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  const oldCollection = String(ad?.collectionMethod || '');
  const oldReceiptId = String(ad?.linkedDeliveryReceiptId || ad?.receiptId || '');
  const newReceiptId = String(document.getElementById('ad-linked-receipt-id')?.value || '');
  const changed = !!ad?.id
    && paymentStatus === 'not_paid'
    && oldCollection === collectionMethod
    && oldReceiptId
    && newReceiptId
    && oldReceiptId !== newReceiptId;
  if (!changed) {
    notice.classList.add('hidden');
    notice.textContent = '';
    return;
  }
  const oldAmount = getOriginalAdDueAllocationUSD();
  const newAmount = parseFloat(document.getElementById('ad-due-amount-to-use')?.value) || 0;
  const oldLabel = getAdReceiptDisplayLabel(oldReceiptId);
  const newLabel = getAdReceiptDisplayLabel(newReceiptId);
  const isAr = state.language === 'ar';
  notice.classList.remove('hidden');
  notice.textContent = isAr
    ? `عند الحفظ: سيعود $${oldAmount.toFixed(2)} إلى ${oldLabel} وسيُحجز $${newAmount.toFixed(2)} من ${newLabel}. يتم التغيير معاً دون خصم مزدوج.`
    : `On Save: $${oldAmount.toFixed(2)} returns to ${oldLabel}, and $${newAmount.toFixed(2)} is reserved from ${newLabel}. Both changes happen together with no double charge.`;
}

function syncShopDueAllocationToFunding() {
  const paymentStatus = document.getElementById('ad-payment-status')?.value || '';
  const collectionMethod = document.getElementById('ad-collection-method')?.value || '';
  if (paymentStatus !== 'not_paid' || collectionMethod !== 'in_shop') return;
  const receiptId = String(document.getElementById('ad-linked-receipt-id')?.value || '').trim();
  const amountUSD = parseFloat(document.getElementById('ad-due-amount-to-use')?.value) || 0;
  state.tempAdFunding = {
    allocations: receiptId && amountUSD > 0 ? [{ receiptId, amountUSD }] : []
  };
}

// Initialize merge funding state.
// When EDITING an ad that already has merged paid funds, seed the working set
// from the saved allocations so a plain edit preserves them. Without this,
// tempMergeFunding started empty/disabled and saving wiped the merged funds
// (shrinking the ad's amountUSD and resurrecting the paid receipt's balance).
function initMergeFunding() {
  if (!state.tempMergeFunding) {
    const md = state.modalData;
    const isMixedShopDebt = getAdPaymentState(md || {}) === 'not_paid'
      && String(md?.collectionMethod || '').toLowerCase() === 'in_shop';
    const savedPaidRows = isMixedShopDebt
      ? md?.receiptAllocations
      : (md?.mergedPaidAllocations || md?.receiptAllocations);
    if (Array.isArray(savedPaidRows) && savedPaidRows.length) {
      state.tempMergeFunding = {
        enabled: true,
        // Snap to 2 decimals for display — stored values can carry float
        // residue from proportional stop-ad math (same as initAdFunding).
        allocations: savedPaidRows.map(a => ({
          receiptId: a.receiptId,
          amountUSD: isFinite(parseFloat(a.amountUSD)) ? String(Math.round(parseFloat(a.amountUSD) * 100) / 100) : String(a.amountUSD)
        }))
      };
    } else {
      state.tempMergeFunding = { allocations: [], enabled: false };
    }
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

  // Once the user edits the suggested difference, treat the visible paid +
  // unpaid total as the new intended budget. Future paid-row edits can then
  // keep the due portion synchronized without restoring an old amount.
  if (document.getElementById('ad-collection-method')?.value === 'in_shop'
      && normalizeAdDriverBudgetUSD(state.tempMixedReceiptTargetUSD) > 0) {
    state.tempMixedReceiptTargetUSD = Math.round(
      (getTempMergeFundingTotalUSD() + value) * 100
    ) / 100;
  }
  
  updateAdDueSummary();
  syncShopDueAllocationToFunding();
  renderAdDueReceiptReplacementNotice();
}

// Use all available due amount (USD)
function useAllDueAmount() {
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!dueInput) return;
  
  const maxDue = parseFloat(dueInput.dataset.maxDue) || 0;
  const budget = normalizeAdDriverBudgetUSD(document.getElementById('ad-driver-budget-usd')?.value);
  const mergedTotal = state.tempMergeFunding?.enabled
    ? (state.tempMergeFunding.allocations || []).reduce((sum, row) => sum + (parseFloat(row?.amountUSD) || 0), 0)
    : 0;
  const budgetRemaining = budget > 0 ? Math.max(budget - mergedTotal, 0) : maxDue;
  dueInput.value = Math.min(maxDue, budgetRemaining).toFixed(2);
  if (document.getElementById('ad-collection-method')?.value === 'in_shop'
      && normalizeAdDriverBudgetUSD(state.tempMixedReceiptTargetUSD) > 0) {
    state.tempMixedReceiptTargetUSD = Math.round(
      (getTempMergeFundingTotalUSD() + (parseFloat(dueInput.value) || 0)) * 100
    ) / 100;
  }
  updateAdDueSummary();
  syncShopDueAllocationToFunding();
  renderAdDueReceiptReplacementNotice();
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
  
  const isArD = state.language === 'ar';
  const isShopDebt = document.getElementById('ad-collection-method')?.value === 'in_shop';
  if (usingUSD > 0) {
    if (isShopDebt) {
      const paidPart = getTempMergeFundingTotalUSD();
      const combined = Math.round((paidPart + usingUSD) * 100) / 100;
      summary.innerHTML = isArD
        ? `المدفوع: <span class="font-medium text-blue-700">$${paidPart.toFixed(2)}</span> + الدين: <span class="font-medium text-violet-700">$${usingUSD.toFixed(2)}</span> = الميزانية: <strong>$${combined.toFixed(2)}</strong>. <span class="text-amber-700">الفرق فقط يبقى بالسالب حتى يدفع العميل.</span>`
        : `Paid: <span class="font-medium text-blue-700">$${paidPart.toFixed(2)}</span> + debt: <span class="font-medium text-violet-700">$${usingUSD.toFixed(2)}</span> = budget: <strong>$${combined.toFixed(2)}</strong>. <span class="text-amber-700">Only the difference stays minus until the customer pays.</span>`;
    } else {
      summary.innerHTML = isArD
      ? `سيتم استخدام <span class="font-medium text-violet-700">$${usingUSD.toFixed(2)}</span> (${usingLYD.toFixed(0)} LYD) من المستحق. ${remainingUSD > 0 ? `<span class="text-slate-400">سيتبقى $${remainingUSD.toFixed(2)} (${remainingLYD.toFixed(0)} LYD).</span>` : '<span class="text-emerald-600">سيتم استخدام الرصيد بالكامل.</span>'}`
      : `Using <span class="font-medium text-violet-700">$${usingUSD.toFixed(2)}</span> (${usingLYD.toFixed(0)} LYD) from due. ${remainingUSD > 0 ? `<span class="text-slate-400">$${remainingUSD.toFixed(2)} (${remainingLYD.toFixed(0)} LYD) will remain.</span>` : '<span class="text-emerald-600">Full credit will be used.</span>'}`;
    }
  } else {
    summary.innerHTML = `<span class="text-amber-600">${isArD ? 'أدخل المبلغ المراد استخدامه من الوصل المستحق.' : 'Enter amount to use from due receipt.'}</span>`;
  }
}

// When merge funding is already enabled (e.g. seeded from an ad being edited),
// make the UI match: reveal the section, set the toggle label, and render the
// saved allocations so they can be seen and kept.
function reflectMergeFundingUI() {
  if (!state.tempMergeFunding?.enabled) return;
  const mergedSection = document.getElementById('ad-merged-paid-funds');
  const mergeIcon = document.getElementById('ad-merge-icon');
  const mergeText = document.getElementById('ad-merge-text');
  if (mergedSection) mergedSection.classList.remove('hidden');
  if (mergeIcon) mergeIcon.setAttribute('data-lucide', 'minus-circle');
  if (mergeText) mergeText.textContent = state.language === 'ar' ? 'إزالة أموال الوصولات المدفوعة' : 'Remove Paid Receipt Funds';
  renderAdMergedFundingList();
  if (window.lucide) lucide.createIcons();
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
    if (mergeText) mergeText.textContent = state.language === 'ar' ? 'إزالة أموال الوصولات المدفوعة' : 'Remove Paid Receipt Funds';
    renderAdMergedFundingList();
  } else {
    if (mergedSection) mergedSection.classList.add('hidden');
    if (mergeIcon) mergeIcon.setAttribute('data-lucide', 'plus-circle');
    if (mergeText) mergeText.textContent = state.language === 'ar' ? 'إضافة أموال وصولات مدفوعة' : 'Add Paid Receipt Funds';
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
  syncMixedShopReceiptDifference();
}

// Update funding receipt in merge mode
function updateAdMergeFundingReceipt(idx, receiptId) {
  if (!state.tempMergeFunding?.allocations) return;
  const allocation = state.tempMergeFunding.allocations[idx];
  if (!allocation) return;
  allocation.receiptId = receiptId;
  renderAdMergedFundingList();
  syncMixedShopReceiptDifference();
}

// Update funding amount in merge mode
function updateAdMergeFundingAmount(idx, value) {
  if (!state.tempMergeFunding?.allocations) return;
  const allocation = state.tempMergeFunding.allocations[idx];
  if (!allocation) return;
  allocation.amountUSD = value;
  refreshAdMergedFundingSummary();
  syncMixedShopReceiptDifference();
}

function syncMixedShopReceiptDifference() {
  if (document.getElementById('ad-collection-method')?.value !== 'in_shop') return;
  const target = normalizeAdDriverBudgetUSD(state.tempMixedReceiptTargetUSD);
  const dueInput = document.getElementById('ad-due-amount-to-use');
  if (!dueInput || target <= 0 || !String(dueInput.dataset.receiptId || '').trim()) return;
  const maxDue = Math.max(parseFloat(dueInput.dataset.maxDue) || 0, 0);
  const shortfall = Math.max(target - getTempMergeFundingTotalUSD(), 0);
  dueInput.value = Math.min(shortfall, maxDue).toFixed(2);
  updateAdDueSummary();
  syncShopDueAllocationToFunding();
}

// Get paid receipts available for the current customer (for merge mode)
function getPaidReceiptsForMerge(customerId) {
  if (!customerId) return [];
  return getVisibleRecords(state.receipts).filter(r => {
    if (String(r.customerId || '') !== String(customerId)) return false;
    const statusLower = String(r.status || '').trim().toLowerCase();
    if (!(r.isPaid === true || statusLower === 'paid')) return false;
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
  const isArM = state.language === 'ar';
  const list = document.getElementById('ad-merged-funding-list');
  if (!list) return;

  initMergeFunding();
  const allocations = state.tempMergeFunding.allocations || [];
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  const receipts = getPaidReceiptsForMerge(customerId);
  
  if (allocations.length === 0) {
    list.innerHTML = `<div class="py-2 text-center text-xs text-slate-400">${isArM ? 'اضغط "+ إضافة وصل" لاستخدام الأموال المدفوعة' : 'Click "+ Add Receipt" to use paid funds'}</div>`;
    refreshAdMergedFundingSummary();
    return;
  }
  
  list.innerHTML = allocations.map((alloc, idx) => {
    const receipt = receipts.find(r => r.id === alloc.receiptId);
    // Same rule as the paid funding rows: a receipt already chosen in ANOTHER
    // row is not offered again (each receipt can be merged only once).
    const usedElsewhere = new Set(
      allocations.filter((a, i) => i !== idx && a && a.receiptId).map(a => a.receiptId)
    );
    const optionsHtml = receipts.filter(r => !usedElsewhere.has(r.id)).map(r => {
      const usage = getReceiptUsageStats(r);
      const avail = Math.round(((usage.remainingUSD || 0) + getEditingAdExistingAllocationUSD(r.id, 'merged')) * 100) / 100;
      const serial = r.serialNumber || r.finalReceiptNo || (r.receiptType === 'TRANSFER_IN' ? (state.language === 'ar' ? 'تحويل' : 'TRF') : (r.id ? String(r.id).slice(0,6) : '???'));
      const label = `#${serial} • $${avail.toFixed(2)} ${isArM ? 'متاح' : 'avail'}`;
      return `<option value="${r.id || ''}" ${alloc.receiptId === r.id ? 'selected' : ''}>${Security.escapeHtml(label)}</option>`;
    }).join('');

    let receiptRemaining = 0;
    if (receipt) {
      const usage = getReceiptUsageStats(receipt);
      receiptRemaining = Number(usage?.remainingUSD) || 0;
      receiptRemaining = Math.round((receiptRemaining + getEditingAdExistingAllocationUSD(receipt.id, 'merged')) * 100) / 100;
    }

    const plannedSpend = parseFloat(alloc.amountUSD) || 0;

    return `
      <div class="p-2 bg-slate-50 rounded-lg space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500">${isArM ? `وصل مدفوع رقم ${idx + 1}` : `Paid Receipt #${idx + 1}`}</span>
          <button type="button" onclick="removeAdMergeFundingAllocation(${idx})" class="text-xs text-rose-500 hover:text-rose-600">${isArM ? 'إزالة' : 'Remove'}</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">${isArM ? 'الوصل' : 'Receipt'}</label>
            <select class="w-full border border-slate-200 px-2 py-1.5 rounded-lg text-sm" onchange="updateAdMergeFundingReceipt(${idx}, this.value)">
              <option value="">${isArM ? 'اختر...' : 'Select...'}</option>
              ${optionsHtml}
            </select>
          </div>
          <div>
            <label class="block text-[10px] text-slate-400 mb-1">${isArM ? 'المبلغ المستخدم (USD)' : 'Use Amount (USD)'}</label>
            <input type="text" inputmode="decimal" class="w-full border border-slate-200 px-2 py-1.5 rounded-lg text-sm" value="${alloc.amountUSD || ''}" oninput="sanitizeMoneyInput(this); updateAdMergeFundingAmount(${idx}, this.value)" onfocus="this.select()" />
          </div>
        </div>
        ${receipt ? `
          <div class="text-[10px] text-slate-400">
            ${isArM ? 'المتاح' : 'Available'}: <span class="text-emerald-600 font-medium">$${receiptRemaining.toFixed(2)}</span>
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
    <span class="text-xs text-blue-600">${state.language === 'ar' ? 'الإجمالي من الوصولات المدفوعة' : 'Total from Paid Receipts'}</span>
    <span class="text-sm font-semibold text-blue-700">$${totalUSD.toFixed(2)}</span>
  </div>`;
}

function openTempDeliveryReceiptFromAd() {
  const customerId = document.getElementById('ad-customer-id')?.value || '';
  if (!customerId) {
    showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'اختر عميلاً أولاً.' : 'Select a customer first.', 'error');
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

// Hide dropdown when clicking outside. CAPTURE phase: the modal panel's
// onclick="event.stopPropagation()" swallows bubble-phase clicks, so without
// it this listener never fires for taps inside the form (see the comment on
// the capture-phase listener at the top of this file).
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('ad-page-dropdown');
  const search = document.getElementById('ad-page-search');
  if (dropdown && search && !dropdown.contains(e.target) && e.target !== search) {
    dropdown.classList.add('hidden');
  }
}, true);

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

function normalizeAdDriverBudgetUSD(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100) / 100;
}

function getOriginalUnpaidDriverBudgetUSD() {
  const ad = state.modalData;
  if (!ad) return 0;
  const isDriverDebt = getAdPaymentState(ad) === 'not_paid'
    && String(ad.collectionMethod || '').toLowerCase() === 'driver';
  return isDriverDebt ? normalizeAdDriverBudgetUSD(ad.amountUSD) : 0;
}

function getOriginalUnpaidAdBudgetUSD() {
  const ad = state.modalData;
  if (!ad || getAdPaymentState(ad) !== 'not_paid') return 0;
  return normalizeAdDriverBudgetUSD(ad.amountUSD);
}

function updateAdDriverBudgetSummary() {
  const input = document.getElementById('ad-driver-budget-usd');
  const summary = document.getElementById('ad-driver-budget-summary');
  if (!input || !summary) return;

  const budget = normalizeAdDriverBudgetUSD(input.value);
  const rate = Number(document.getElementById('ad-driver-budget-rate')?.value)
    || Number(state.defaultExchangeRate)
    || 1;
  const isAr = state.language === 'ar';
  if (budget <= 0) {
    summary.textContent = isAr ? 'أدخل ميزانية الإعلان الموجبة.' : 'Enter the positive ad budget.';
    return;
  }
  summary.textContent = isAr
    ? `الميزانية: $${budget.toFixed(2)} ≈ ${(budget * rate).toFixed(2)} LYD`
    : `Budget: $${budget.toFixed(2)} ≈ ${(budget * rate).toFixed(2)} LYD`;
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
  const driverBudgetSection = document.getElementById('ad-driver-budget-section');
  const driverSettlementHint = document.getElementById('ad-driver-settlement-hint');
  
  if (!paidBtn || !notPaidBtn || !wontPayBtn || !hiddenInput) {
    // Expected while the New Ad wizard hasn't rendered the payment section yet
    // (it appears only after a customer is selected) — not an error.
    return;
  }

  const previousStatus = hiddenInput.value;
  const previousCollectionMethod = document.getElementById('ad-collection-method')?.value || '';
  if (status === 'paid' && previousStatus === 'not_paid' && previousCollectionMethod === 'in_shop') {
    // When the unpaid receipt is later collected, the user settles the whole
    // mixed ad by switching to Paid. Bring BOTH the original paid portion and
    // the former due portion into the normal paid funding list so the exact
    // original total is visible and can be validated by the server.
    initMergeFunding();
    const totals = new Map();
    for (const row of [
      ...(state.tempMergeFunding?.allocations || []),
      ...(state.tempAdFunding?.allocations || [])
    ]) {
      const receiptId = String(row?.receiptId || '').trim();
      const amountUSD = parseFloat(row?.amountUSD) || 0;
      if (!receiptId || amountUSD <= 0) continue;
      totals.set(receiptId, (totals.get(receiptId) || 0) + amountUSD);
    }
    state.tempAdFunding = {
      allocations: Array.from(totals, ([receiptId, amountUSD]) => ({
        receiptId,
        amountUSD: (Math.round(amountUSD * 100) / 100).toFixed(2)
      }))
    };
    state.tempMergeFunding = { allocations: [], enabled: false };
    state.tempMixedReceiptTargetUSD = null;
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
    if (driverBudgetSection) driverBudgetSection.classList.add('hidden');
    if (driverSettlementHint) {
      driverSettlementHint.classList.toggle('hidden', getOriginalUnpaidAdBudgetUSD() <= 0);
    }
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
    if (driverSettlementHint) driverSettlementHint.classList.add('hidden');
    // Hide financial details if driver (receipt already has them)
    if (collectionMethod === 'driver') {
      if (unpaidFinancial) unpaidFinancial.classList.add('hidden');
      if (driverBudgetSection) driverBudgetSection.classList.remove('hidden');
    } else {
      if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
      if (driverBudgetSection) driverBudgetSection.classList.add('hidden');
    }
    if (wontPaySection) wontPaySection.classList.add('hidden');
  } else {
    // wont_pay
    if (notPaidOptions) notPaidOptions.classList.add('hidden');
    if (receiptFunding) receiptFunding.classList.add('hidden');
    if (unpaidFinancial) unpaidFinancial.classList.remove('hidden');
    if (driverBudgetSection) driverBudgetSection.classList.add('hidden');
    if (driverSettlementHint) driverSettlementHint.classList.add('hidden');
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
  const driverBudgetSection = document.getElementById('ad-driver-budget-section');
  
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
    if (driverBudgetSection) driverBudgetSection.classList.add('hidden');
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
    if (driverBudgetSection) driverBudgetSection.classList.add('hidden');
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
    if (driverBudgetSection) driverBudgetSection.classList.remove('hidden');
    updateAdDriverBudgetSummary();
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

// Keep each record below the server's 10 MB request limit after JSON overhead.
// Data-URL character length closely approximates the JSON request byte size.
const MAX_ENTITY_PHOTO_PAYLOAD_CHARS = 7 * 1024 * 1024;

function _preparedPhotoFits(existing, source) {
  const used = (Array.isArray(existing) ? existing : [])
    .reduce((sum, value) => sum + String(value || '').length, 0);
  return used + String(source || '').length <= MAX_ENTITY_PHOTO_PAYLOAD_CHARS;
}

function _showPhotoPayloadLimit() {
  showNotification(
    state.language === 'ar' ? 'حجم الصور كبير' : 'Photos are too large',
    state.language === 'ar' ? 'وصلت الصور إلى حد الرفع الآمن. احذف صورة أو استخدم صوراً أصغر.' : 'The safe upload limit was reached. Remove a photo or use smaller images.',
    'warning'
  );
}

// HEIC/HEIF (the iPhone camera default) cannot be decoded by Chrome on
// Android: compressImageToDataUrl falls back to the raw data URL and
// isSafeReceiptPhotoSource rejects it. Without this notice the photo just
// silently never appears in the preview grid.
function _showUnsupportedPhotoFormat() {
  showNotification(
    state.language === 'ar' ? 'صيغة صورة غير مدعومة' : 'Unsupported photo',
    state.language === 'ar'
      ? 'استخدم صورة PNG أو JPG أو WEBP أو GIF — صور HEIC غير مدعومة (غيّر إعداد كاميرا الآيفون إلى "الأكثر توافقاً" أو أرسلها بصيغة JPG).'
      : 'Use a PNG, JPG, WEBP, or GIF image — HEIC photos are not supported (set the iPhone camera to "Most Compatible" or share as JPG).',
    'error'
  );
}

async function _compressPhotosForUpload(files, concurrency = 2) {
  const input = Array.isArray(files) ? files : [];
  const results = new Array(input.length).fill('');
  let next = 0;
  const worker = async () => {
    while (next < input.length) {
      const index = next++;
      try { results[index] = await compressImageToDataUrl(input[index]); } catch (_) {}
    }
  };
  const workers = Math.min(Math.max(Number(concurrency) || 1, 1), input.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function canModifyAdPhotosInCurrentModal() {
  if (!can('ads', 'uploadPhotos')) return false;
  const editingSavedAd = state.activeModal === 'ad' && Boolean(state.modalData?.id);
  // A partial photo array must never replace saved photos the user cannot see.
  // A new ad is safe because there are no older photos to erase.
  return !editingSavedAd || can('ads', 'viewPhotos');
}

// Upload and preview ad photos
function uploadAdPhotos(fileList) {
  if (!fileList || !fileList.length) return;
  if (!canModifyAdPhotosInCurrentModal()) {
    showNotification(
      state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied',
      state.language === 'ar'
        ? 'تحتاج صلاحية عرض ورفع الصور لتغيير صور إعلان محفوظ.'
        : 'Viewing and Upload Photos permissions are required to change a saved ad\'s photos.',
      'error'
    );
    return;
  }
  state.tempAdPhotos = state.tempAdPhotos || [];
  const uploadGeneration = _adPhotoUploadGeneration;
  const room = Math.max(6 - state.tempAdPhotos.length, 0);
  const files = Array.from(fileList).slice(0, room);
  if (!files.length) {
    showNotification(
      state.language === 'ar' ? 'الحد الأقصى للصور' : 'Photo limit reached',
      state.language === 'ar' ? 'يمكن إرفاق 6 صور كحد أقصى لكل إعلان.' : 'You can attach up to 6 photos to each ad.',
      'warning'
    );
    return;
  }
  _adPhotoUploadsInFlight += files.length;
  _compressPhotosForUpload(files).then(results => {
    if (uploadGeneration !== _adPhotoUploadGeneration || state.activeModal !== 'ad') return;
    state.tempAdPhotos = state.tempAdPhotos || [];
    let changed = false;
    let tooLarge = false;
    let unsupported = false;
    results.forEach(dataUrl => {
      // Keep the photo-cap check first so a full grid doesn't show a
      // misleading "unsupported" message.
      if (!dataUrl || state.tempAdPhotos.length >= 6) return;
      if (!isSafeReceiptPhotoSource(dataUrl)) {
        unsupported = true;
        return;
      }
      if (!_preparedPhotoFits(state.tempAdPhotos, dataUrl)) {
        tooLarge = true;
        return;
      }
      state.tempAdPhotos.push(dataUrl);
      changed = true;
    });
    if (changed) {
      state.tempAdPhotosDirty = true;
      renderAdPhotoPreviews();
    }
    if (tooLarge) _showPhotoPayloadLimit();
    if (unsupported) _showUnsupportedPhotoFormat();
  }).finally(() => {
    if (uploadGeneration === _adPhotoUploadGeneration) {
      _adPhotoUploadsInFlight = Math.max(0, _adPhotoUploadsInFlight - files.length);
    }
  });
}

function renderAdPhotoPreviews() {
  const container = document.getElementById('ad-photo-previews');
  if (!container) return;
  const photos = state.tempAdPhotos || [];
  if (!photos.length) {
    const hiddenCount = getAdPhotoCount(state.modalData);
    const hiddenSavedPhotos = Boolean(state.modalData?.id) && hiddenCount > 0 && !can('ads', 'viewPhotos');
    container.innerHTML = hiddenSavedPhotos
      ? `<div class="text-xs text-amber-600 dark:text-amber-400 col-span-4 text-center py-2">${state.language === 'ar' ? `تم حفظ ${hiddenCount} صورة. تحتاج صلاحية عرض الصور لرؤيتها أو تغييرها.` : `${hiddenCount} saved photo${hiddenCount === 1 ? '' : 's'}. View Photos permission is required to see or change them.`}</div>`
      : `<div class="text-xs text-slate-400 col-span-4">${state.language === 'ar' ? 'لا توجد صور بعد. اضغط "إضافة صورة" للرفع.' : 'No photos yet. Click "Add Photo" to upload.'}</div>`;
    return;
  }
  container.innerHTML = photos.map((src, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <button type="button" onclick="openPendingAdPhotoViewer(${idx})" class="group/photo block w-full relative focus:outline-none focus:ring-2 focus:ring-indigo-500" title="${state.language === 'ar' ? 'اضغط لعرض الصورة بالحجم الكامل' : 'Click to view full size'}" aria-label="${state.language === 'ar' ? `عرض صورة الإعلان ${idx + 1}` : `View ad photo ${idx + 1}`}">
        <img src="${Security.escapeHtml(src)}" alt="${state.language === 'ar' ? `صورة الإعلان ${idx + 1}` : `Ad photo ${idx + 1}`}" class="w-full h-20 object-cover" />
        <span class="absolute inset-0 bg-black/0 group-hover/photo:bg-black/25 group-focus/photo:bg-black/25 transition-colors flex items-center justify-center"><i data-lucide="maximize-2" class="w-5 h-5 text-white opacity-0 group-hover/photo:opacity-100 group-focus/photo:opacity-100 drop-shadow"></i></span>
      </button>
      ${canModifyAdPhotosInCurrentModal() ? `<button type="button" onclick="removeAdPhoto(${idx})" class="absolute top-1 right-1 bg-white/90 dark:bg-slate-900/90 rounded-full p-1 shadow hover:bg-rose-100 z-10" aria-label="${state.language === 'ar' ? `حذف صورة الإعلان ${idx + 1}` : `Remove ad photo ${idx + 1}`}">
        <i data-lucide="x" class="w-3 h-3 text-rose-600"></i>
      </button>` : ''}
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function removeAdPhoto(idx) {
  if (!canModifyAdPhotosInCurrentModal() || !state.tempAdPhotos) return;
  state.tempAdPhotos.splice(idx, 1);
  state.tempAdPhotosDirty = true;
  renderAdPhotoPreviews();
}

// Update totals for ad unpaid financial details (reuses receipt totals calculation)
function updateAdUnpaidTotals() {
  updateReceiptTotals();
}

// Update ad status directly from list view
// NOTE: updateAdStatusFromList was removed (user request): the ads-table
// status dropdown is now a read-only badge. It also let "Stopped" be set
// directly, bypassing confirmStopAd's money flow (unspent funds were never
// returned to the funding receipts) — status changes go through the Actions
// buttons, which run the correct flows.

// NOTE: updateAdDeliveryStatus was removed (user request, same as the status
// dropdown): the ads-table Delivery column is now a read-only badge. Like the
// status dropdown, it wrote deliveryStatus directly with no transition
// validation (e.g. could jump straight to Delivered, or reopen a terminal
// state). Delivery changes go through the Deliveries page / delivery
// dashboard flows, which run the proper checks.

// Receipt photos helpers
function uploadReceiptPhotos(fileList) {
  if (!fileList || !fileList.length) return;
  state.tempReceiptPhotos = state.tempReceiptPhotos || [];
  const uploadGeneration = _receiptPhotoUploadGeneration;
  const room = Math.max(6 - state.tempReceiptPhotos.length, 0);
  const files = Array.from(fileList).slice(0, room);
  if (!files.length) {
    showNotification(
      state.language === 'ar' ? 'الحد الأقصى للصور' : 'Photo limit reached',
      state.language === 'ar' ? 'يمكن إرفاق 6 صور كحد أقصى لكل وصل.' : 'You can attach up to 6 photos to each receipt.',
      'warning'
    );
    return;
  }
  _receiptPhotoUploadsInFlight += files.length;
  _compressPhotosForUpload(files).then(results => {
    // Ignore results from a cancelled/reopened form, preserve selection order,
    // and recheck both limits after asynchronous compression.
    if (uploadGeneration !== _receiptPhotoUploadGeneration || state.activeModal !== 'receipt') return;
    state.tempReceiptPhotos = state.tempReceiptPhotos || [];
    let changed = false;
    let tooLarge = false;
    let unsupported = false;
    results.forEach(dataUrl => {
      // Keep the photo-cap check first so a full grid doesn't show a
      // misleading "unsupported" message.
      if (!dataUrl || state.tempReceiptPhotos.length >= 6) return;
      if (!isSafeReceiptPhotoSource(dataUrl)) {
        unsupported = true;
        return;
      }
      if (!_preparedPhotoFits(state.tempReceiptPhotos, dataUrl)) {
        tooLarge = true;
        return;
      }
      state.tempReceiptPhotos.push(dataUrl);
      changed = true;
    });
    if (changed) {
      state.tempReceiptPhotosDirty = true;
      renderReceiptPhotoPreviews();
    }
    if (tooLarge) _showPhotoPayloadLimit();
    if (unsupported) _showUnsupportedPhotoFormat();
  }).finally(() => {
    if (uploadGeneration === _receiptPhotoUploadGeneration) {
      _receiptPhotoUploadsInFlight = Math.max(0, _receiptPhotoUploadsInFlight - files.length);
    }
  });
}

function renderReceiptPhotoPreviews() {
  const container = document.getElementById('receipt-photo-previews');
  if (!container) return;
  const photos = state.tempReceiptPhotos || [];
  if (!photos.length) {
    container.innerHTML = `<div class="text-xs text-slate-400 col-span-4">${state.language === 'ar' ? 'لا توجد صور بعد. اضغط "إضافة صورة" للرفع.' : 'No photos yet. Click "Add Photo" to upload.'}</div>`;
    return;
  }
  container.innerHTML = photos.map((src, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <button type="button" onclick="openPendingReceiptPhotoViewer(${idx})" class="group/photo block w-full relative focus:outline-none focus:ring-2 focus:ring-indigo-500" title="${state.language === 'ar' ? 'اضغط لعرض الصورة بالحجم الكامل' : 'Click to view full size'}" aria-label="${state.language === 'ar' ? `عرض صورة الوصل ${idx + 1}` : `View receipt photo ${idx + 1}`}">
        <img src="${Security.escapeHtml(src)}" alt="${state.language === 'ar' ? `صورة الوصل ${idx + 1}` : `Receipt photo ${idx + 1}`}" class="w-full h-20 object-cover" />
        <span class="absolute inset-0 bg-black/0 group-hover/photo:bg-black/25 group-focus/photo:bg-black/25 transition-colors flex items-center justify-center">
          <i data-lucide="maximize-2" class="w-5 h-5 text-white opacity-0 group-hover/photo:opacity-100 group-focus/photo:opacity-100 drop-shadow"></i>
        </span>
      </button>
      <button type="button" onclick="removeReceiptPhoto(${idx})" class="absolute top-1 right-1 bg-white/90 dark:bg-slate-900/90 rounded-full p-1 shadow hover:bg-rose-100 z-10" aria-label="${state.language === 'ar' ? `حذف صورة الوصل ${idx + 1}` : `Remove receipt photo ${idx + 1}`}">
        <i data-lucide="x" class="w-3 h-3 text-rose-600"></i>
      </button>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

function removeReceiptPhoto(idx) {
  if (!state.tempReceiptPhotos) return;
  state.tempReceiptPhotos.splice(idx, 1);
  state.tempReceiptPhotosDirty = true;
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
  
  displayEl.innerHTML = `${state.language === 'ar' ? 'بالعملة المحلية' : 'Local'}: <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(localAmount.toLocaleString('en-US'))} LYD</span>`;
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
  const selectedReceipt = state.receipts.find(r => r && !r._deleted && String(r.id) === String(receiptId || ''));
  const customerId = String(document.getElementById('ad-customer-id')?.value || '');
  if (selectedReceipt && customerId && String(selectedReceipt.customerId || '') !== customerId) {
    showNotification(
      state.language === 'ar' ? 'وصل غير صالح' : 'Invalid receipt',
      state.language === 'ar' ? 'هذا الوصل يخص عميلاً آخر.' : 'This receipt belongs to another customer.',
      'error'
    );
    allocation.receiptId = '';
    allocation.amountUSD = 0;
    renderAdFundingList();
    return;
  }
  allocation.receiptId = receiptId;
  
  // Default to 0, but cap existing values at remaining if receipt is selected
  const receipt = state.receipts.find(r => r.id === receiptId);
  if (receipt) {
    const originalUnpaidBudget = getOriginalUnpaidAdBudgetUSD();
    const isSettlingUnpaidAd = originalUnpaidBudget > 0
      && String(document.getElementById('ad-payment-status')?.value || '').toLowerCase() === 'paid';
    if (isSettlingUnpaidAd) {
      // A stored Not Paid ad can contain only a partial due allocation. When the
      // user changes its source while settling it, that old partial amount must
      // not become the new Paid total (for example $1.24 of a $9.00 ad). Fill
      // this row with the exact remaining settlement amount after all OTHER
      // rows. Capacity validation still shows a shortage and lets the user split
      // the total across receipts; it never shrinks or erases customer debt.
      const otherAllocated = state.tempAdFunding.allocations.reduce((sum, row, rowIndex) => {
        if (rowIndex === idx) return sum;
        return sum + (parseFloat(row?.amountUSD) || 0);
      }, 0);
      allocation.amountUSD = Math.max(
        Math.round((originalUnpaidBudget - otherAllocated) * 100) / 100,
        0
      );
    } else {
      // Relinking changes only the source receipt. Never clamp a saved $30
      // allocation down to a new $20 balance (silently shrinking the ad), nor
      // grow it to a larger receipt. Save-time capacity validation will block an
      // insufficient replacement and the user can add a second receipt.
      if (allocation.amountUSD && parseFloat(allocation.amountUSD) > 0) {
        allocation.amountUSD = Math.round((parseFloat(allocation.amountUSD) || 0) * 100) / 100;
      } else {
        allocation.amountUSD = 0;
      }
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

  // Normalize non-ASCII numerals/separators BEFORE filtering, so an Arabic
  // keyboard entry is not corrupted: previously "12,5" (comma decimal) became
  // "125" (a 10x error) and Arabic-Indic digits were deleted entirely.
  val = val
    .replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48)) // Arabic-Indic
    .replace(/[۰-۹]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 48)) // Extended (Persian)
    .replace(/[,٫]/g, '.'); // comma / Arabic decimal separator -> dot

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
  renderAdPaidReceiptReplacementNotice();
}

function getAdAllocationMap(rows) {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const receiptId = String(row?.receiptId || '');
    const amount = parseFloat(row?.amountUSD) || 0;
    if (!receiptId || amount <= 0) continue;
    result.set(receiptId, Math.round(((result.get(receiptId) || 0) + amount) * 100) / 100);
  }
  return result;
}

// Give the user an exact preview of what a paid-receipt replacement means.
// The actual return/use operation remains authoritative in /api/ads/mutate.
function renderAdPaidReceiptReplacementNotice() {
  const notice = document.getElementById('ad-funding-change-notice');
  if (!notice) return;
  const ad = state.modalData;
  const paymentStatus = document.getElementById('ad-payment-status')?.value || '';
  if (!ad?.id || getAdPaymentState(ad) !== 'paid' || paymentStatus !== 'paid') {
    notice.classList.add('hidden');
    notice.textContent = '';
    return;
  }
  const before = getAdAllocationMap(ad.receiptAllocations);
  const after = getAdAllocationMap(state.tempAdFunding?.allocations);
  const allIds = new Set([...before.keys(), ...after.keys()]);
  let returned = 0;
  let used = 0;
  const releasedLabels = [];
  const addedLabels = [];
  for (const receiptId of allIds) {
    const oldAmount = before.get(receiptId) || 0;
    const newAmount = after.get(receiptId) || 0;
    if (oldAmount > newAmount + 0.005) {
      returned += oldAmount - newAmount;
      releasedLabels.push(getAdReceiptDisplayLabel(receiptId));
    }
    if (newAmount > oldAmount + 0.005) {
      used += newAmount - oldAmount;
      addedLabels.push(getAdReceiptDisplayLabel(receiptId));
    }
  }
  if (returned <= 0.005 && used <= 0.005) {
    notice.classList.add('hidden');
    notice.textContent = '';
    return;
  }
  const isAr = state.language === 'ar';
  const from = releasedLabels.join(', ') || (isAr ? 'الوصل الحالي' : 'the current receipt');
  const to = addedLabels.join(', ') || (isAr ? 'الوصل المحدد' : 'the selected receipt');
  notice.classList.remove('hidden');
  notice.textContent = isAr
    ? `عند الحفظ: سيعود $${returned.toFixed(2)} إلى ${from} وسيُستخدم $${used.toFixed(2)} من ${to}. الإعلان وأرصدة الوصولات تتحدث معاً دون خصم مزدوج.`
    : `On Save: $${returned.toFixed(2)} returns to ${from}, and $${used.toFixed(2)} is used from ${to}. The ad and both receipt balances update together with no double charge.`;
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
  const receiptRemaining = Math.round(((usage?.remainingUSD ?? 0) + getEditingAdExistingAllocationUSD(receipt.id)) * 100) / 100;
  const plannedSpend = parseFloat(allocation.amountUSD) || 0;
  const balance = Math.round((receiptRemaining - plannedSpend) * 100) / 100;
  const receiptRate = receipt?.exchangeRate || state.defaultExchangeRate || '-';

  if (remainingEl) remainingEl.textContent = `$${Number(receiptRemaining || 0).toFixed(2)}`;
  if (balanceEl) {
    balanceEl.textContent = balance < -0.005
      ? `${state.language === 'ar' ? 'عجز' : 'Short'} $${Math.abs(balance).toFixed(2)}`
      : `$${Number(balance || 0).toFixed(2)}`;
    balanceEl.className = balance < -0.005
      ? 'text-rose-600 dark:text-rose-400 font-bold'
      : 'text-blue-600 dark:text-blue-400 font-medium';
  }
  if (rateEl) rateEl.textContent = String(receiptRate);
}

function renderAdFundingList() {
  const isArL = state.language === 'ar';
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
    let eligibleReceiptIds = new Set();
    try {
      const eligibleReceipts = getReceiptsForAd(customerId, pageId);
      eligibleReceiptIds = new Set(eligibleReceipts.map(receipt => String(receipt.id)));
      receipts = eligibleReceipts.filter(r => {
        if (!r) return false;
        if (selectedReceiptIds.has(String(r.id))) return true;
        const usage = getReceiptUsageStats(r);
        const remaining = (usage?.remainingUSD ?? 0) + getEditingAdExistingAllocationUSD(r.id);
        return remaining > 0.0001;
      });
      // Keep a saved current link visible even if the receipt later became
      // unavailable. It is clearly labelled and alternatives remain listed,
      // so editing never silently swaps or hides the old source.
      for (const receiptId of selectedReceiptIds) {
        if (receipts.some(receipt => String(receipt.id) === receiptId)) continue;
        const current = (state.receipts || []).find(receipt =>
          receipt && String(receipt.id) === receiptId && String(receipt.customerId || '') === String(customerId || '')
        );
        if (current) receipts.unshift(current);
      }
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
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">${isArL ? 'اختر صفحة وعميلاً أولاً' : 'Select a page & customer first'}</div>`;
    refreshAdFundingSummary();
    renderAdPaidReceiptReplacementNotice();
    return;
  }
  
  if (receipts.length === 0) {
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">${isArL ? 'لا توجد وصولات برصيد متبقٍ' : 'No receipts with remaining balance'}</div>`;
    refreshAdFundingSummary();
    renderAdPaidReceiptReplacementNotice();
    return;
  }
  
  if (allocations.length === 0) {
    // In Paid mode, show the first allocation row automatically (old behavior),
    // so the user can immediately choose a receipt and amount without extra clicks.
    if (String(paymentStatus || '').toLowerCase() === 'paid') {
      state.tempAdFunding = state.tempAdFunding || { allocations: [] };
      const originalDriverBudget = getOriginalUnpaidAdBudgetUSD();
      state.tempAdFunding.allocations = [{
        receiptId: '',
        amountUSD: originalDriverBudget > 0 ? originalDriverBudget.toFixed(2) : ''
      }];
      renderAdFundingList();
      return;
    }
    list.innerHTML = `<div class="py-3 text-center text-xs text-slate-400">${isArL ? 'اضغط "+ إضافة" لربط وصل' : 'Click "+ Add" to link a receipt'}</div>`;
    refreshAdFundingSummary();
    return;
  }
  
  list.innerHTML = allocations.map((alloc, idx) => {
    const receipt = receipts.find(r => r.id === alloc.receiptId);
    // A receipt already chosen in ANOTHER allocation row must not be offered
    // again here (user request) — each receipt can fund the ad only once.
    // The row's OWN current selection stays listed so it renders as selected.
    const usedElsewhere = new Set(
      allocations.filter((a, i) => i !== idx && a && a.receiptId).map(a => a.receiptId)
    );
    const optionsHtml = receipts.filter(r => !usedElsewhere.has(r.id)).map(r => {
      const serial = r.serialNumber || r.finalReceiptNo || (r.receiptType === 'TRANSFER_IN' ? (state.language === 'ar' ? 'تحويل' : 'TRF') : (r.id ? String(r.id).slice(0,6) : '???'));
      const unavailable = !eligibleReceiptIds.has(String(r.id));
      const staleLabel = unavailable
        ? (isArL ? ' • الرابط الحالي غير متاح — اختر بديلاً' : ' • current link unavailable — choose a replacement')
        : '';
      const label = `#${serial} • $${(r.amountUSD || 0).toFixed(2)}${staleLabel}`;
      return `<option value="${r.id || ''}" ${alloc.receiptId === r.id ? 'selected' : ''}>${Security.escapeHtml(label)}</option>`;
    }).join('');
    
    const receiptRate = receipt?.exchangeRate || state.defaultExchangeRate || '-';

    // Calculate remaining balance BEFORE any planned spend (full receipt
    // remaining + this ad's own saved share when editing).
    let receiptRemaining = 0;
    if (receipt) {
      const usage = getReceiptUsageStats(receipt);
      receiptRemaining = Number(usage?.remainingUSD) || 0;
      receiptRemaining = Math.round((receiptRemaining + getEditingAdExistingAllocationUSD(receipt.id)) * 100) / 100;
    }

    // Calculate balance = Remaining - Planned Spend
    const plannedSpend = parseFloat(alloc.amountUSD) || 0;
    const balance = Math.round((receiptRemaining - plannedSpend) * 100) / 100;
    const balanceText = balance < -0.005
      ? `${isArL ? 'عجز' : 'Short'} $${Math.abs(balance).toFixed(2)}`
      : `$${balance.toFixed(2)}`;
    
    return `
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-500 flex items-center gap-1"><i data-lucide="receipt" class="w-3 h-3"></i>${isArL ? `تخصيص الوصل رقم ${idx + 1}` : `Receipt Allocation #${idx + 1}`}</span>
          <button type="button" onclick="removeAdFundingAllocation(${idx})" aria-label="${isArL ? `إزالة تخصيص الوصل رقم ${idx + 1}` : `Remove receipt allocation ${idx + 1}`}" class="min-h-11 px-2 text-xs text-rose-500 hover:text-rose-600">${isArL ? 'إزالة' : 'Remove'}</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label for="ad-funding-receipt-${idx}" class="block text-[10px] text-slate-400 mb-1">${isArL ? 'الوصل' : 'Receipt'}</label>
            <select id="ad-funding-receipt-${idx}" class="w-full min-h-11 glass-input px-3 py-2 rounded-lg text-sm" onchange="updateAdFundingReceipt(${idx}, this.value)">
              <option value="">${isArL ? 'اختر...' : 'Select...'}</option>
              ${optionsHtml}
            </select>
          </div>
          <div>
            <label for="ad-funding-amount-${idx}" class="block text-[10px] text-slate-400 mb-1">${isArL ? 'الإنفاق المخطط (USD)' : 'Planned Spend (USD)'}</label>
            <input id="ad-funding-amount-${idx}" type="text" inputmode="decimal" class="w-full min-h-11 glass-input px-3 py-2 rounded-lg text-sm" value="${alloc.amountUSD || ''}" oninput="sanitizeMoneyInput(this); updateAdFundingAmount(${idx}, this.value)" onfocus="this.select()" />
          </div>
        </div>
        ${receipt ? `
          <div class="text-[10px] text-slate-400 space-y-0.5">
            <div>${isArL ? 'المتبقي' : 'Remaining'}: <span id="ad-funding-remaining-${idx}" class="text-emerald-600 dark:text-emerald-400 font-medium">$${receiptRemaining.toFixed(2)}</span></div>
            <div>${isArL ? 'الرصيد' : 'Balance'}: <span id="ad-funding-balance-${idx}" class="${balance < -0.005 ? 'text-rose-600 dark:text-rose-400 font-bold' : 'text-blue-600 dark:text-blue-400 font-medium'}">${balanceText}</span></div>
            <div>${isArL ? 'السعر' : 'Rate'}: <span id="ad-funding-rate-${idx}" class="text-slate-600 dark:text-slate-300">${receiptRate}</span></div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  refreshAdFundingSummary();
  renderAdPaidReceiptReplacementNotice();
  if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error rendering ad funding list:', err);
    list.innerHTML = `<div class="py-3 text-center text-xs text-rose-500">${isArL ? 'خطأ في تحميل الوصولات. الرجاء التحديث.' : 'Error loading receipts. Please refresh.'}</div>`;
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
  
  // Calculate total balance (sum of all balances: Remaining - Planned Spend
  // per allocation, with this ad's own saved share added back when editing)
  let totalBalance = 0;
  allocations.forEach(a => {
    if (a.receiptId) {
      const receipt = state.receipts.find(r => r.id === a.receiptId);
      if (receipt) {
        const usage = getReceiptUsageStats(receipt);
        const receiptRemaining = (usage.remainingUSD || 0) + getEditingAdExistingAllocationUSD(receipt.id);
        const plannedSpend = parseFloat(a.amountUSD) || 0;
        const balance = Math.max(receiptRemaining - plannedSpend, 0);
        totalBalance += balance;
      }
    }
  });
  totalBalance = Math.round(totalBalance * 100) / 100;
  
  summary.innerHTML = `
    <div class="flex items-center justify-between py-1.5">
      <span class="text-xs text-slate-500">${state.language === 'ar' ? 'إجمالي الرصيد' : 'Total Balance'}</span>
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
    <input type="tel" class="customer-phone flex-1 glass-input px-4 py-2 rounded-xl" placeholder="${state.language === 'ar' ? 'رقم الهاتف' : 'Phone number'}" />
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
    showNotification(state.language === 'ar' ? 'رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإضافة عملاء' : 'You do not have permission to add customers', 'error');
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
    showNotification(state.language === 'ar' ? 'رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإضافة صفحات' : 'You do not have permission to add pages', 'error');
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
    showNotification(state.language === 'ar' ? 'رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'لا يوجد صلاحية لإنشاء إعلانات' : 'You do not have permission to create ads', 'error');
    return;
  }
  if (getVisibleRecords(state.customers).length === 0) {
    showNotification(state.language === 'ar' ? 'لا يوجد عملاء' : 'No Customers', state.language === 'ar' ? 'الرجاء إضافة عميل أولاً' : 'Please add a customer first', 'warning');
    return;
  }
  state.activeModal = 'ad';
  state.modalData = null;
  updateUrlParams({ modal: 'ad', id: 'new' }); // URL tracking for new ad
  renderModal();
}

function showUserModal() {
  if (!isCurrentUserAdmin()) {
    showNotification(state.language === 'ar' ? 'رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'هذه الميزة للأدمن فقط' : 'Admin only', 'error');
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
  
  const isArR = state.language === 'ar';
  const roleConfig = {
    'Admin': {
      icon: 'crown',
      title: isArR ? 'مدير كامل الصلاحيات' : 'Full Administrator',
      desc: isArR ? 'وصول كامل لجميع الميزات. بدون قيود.' : 'Complete access to all features. No restrictions.',
      bgColor: 'bg-amber-100 dark:bg-amber-900/30',
      iconColor: 'text-amber-600',
      badge: `<span class="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold">${isArR ? 'وصول كامل' : 'ALL ACCESS'}</span>`
    },
    'Delivery': {
      icon: 'truck',
      title: isArR ? 'سائق توصيل' : 'Delivery Driver',
      desc: isArR ? 'وصول لعمليات التوصيل فقط.' : 'Access to delivery operations only.',
      bgColor: 'bg-cyan-100 dark:bg-cyan-900/30',
      iconColor: 'text-cyan-600',
      badge: ''
    },
    'Employee': {
      icon: 'user-check',
      title: isArR ? 'موظف' : 'Employee',
      desc: isArR ? 'وصول موظف قياسي. يمكن تخصيص الصلاحيات بعد الإنشاء.' : 'Standard employee access. Customize permissions after creation.',
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
