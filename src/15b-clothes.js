// ==========================================
// CLOTHES SYSTEM (نظام الملابس)
// Smart Systems child #4 — warehouse stock, incoming shipments
// from abroad, and customer orders (buy in USD, sell in LYD).
// Admin-only for now (registered in PLATFORM_ADMIN_ONLY_VIEWS).
// Collections: state.clothesProducts / clothesShipments / clothesOrders.
// ==========================================

// Active tab: 'dashboard' | 'products' | 'shipments' | 'orders'
let _clothesActiveTab = 'dashboard';

const CLOTHES_TABS = [
  { id: 'dashboard', icon: 'layout-dashboard', label: 'Dashboard', labelAr: 'نظرة عامة' },
  { id: 'products', icon: 'shirt', label: 'Products', labelAr: 'البضاعة' },
  { id: 'shipments', icon: 'plane', label: 'Shipments', labelAr: 'الشحنات القادمة' },
  { id: 'orders', icon: 'shopping-bag', label: 'Orders', labelAr: 'طلبات الزبائن' }
];

// A variant's stock is "low" at or below this count (and "out" at 0)
const CLOTHES_LOW_STOCK_THRESHOLD = 2;
const CLOTHES_PRODUCTS_PAGE_SIZE = 30;

function setClothesTab(tabId) {
  if (!CLOTHES_TABS.some(tab => tab.id === tabId)) return;
  _clothesActiveTab = tabId;
  // Each tab is its own address: /clothes-system?tab=orders
  try { updateUrlParams({ tab: tabId }, true); } catch (_) {}
  render();
}

// Restore the active tab from ?tab= when the Clothes System is opened by URL.
function restoreClothesTabFromUrl() {
  try {
    const tab = getUrlParams().tab;
    if (tab && CLOTHES_TABS.some(t => t.id === tab)) _clothesActiveTab = tab;
  } catch (_) {}
}

// ------------------------------------------
// Shared helpers
// ------------------------------------------

function clothesIsAr() {
  return state.language === 'ar';
}

function clothesFmtUSD(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `$${v.toFixed(2)}`;
}

function clothesFmtLYD(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${v.toFixed(2)} LYD`;
}

function clothesParseMoney(raw) {
  // Inputs already run through sanitizeMoneyInput (ASCII digits, one dot),
  // this is the final defensive parse at save time.
  const v = parseFloat(String(raw == null ? '' : raw).trim());
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.round(v * 100) / 100;
}

function getClothesProductTotalQty(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  return variants.reduce((sum, v) => sum + (Math.max(0, Math.floor(Number(v?.qty) || 0))), 0);
}

// Who may use the Clothes System: admins always; anyone else needs an active
// clothes_system subscription (the server additionally enforces per-record
// ownership through viewOwn/editOwn/deleteOwn permissions).
function clothesCanUse() {
  if (isCurrentUserAdmin()) return true;
  return hasSubscription('clothes_system');
}

// Multi-tenant isolation: subscribers see ONLY their own records.
// Admin (platform owner) sees everything.
function _clothesScopeToOwner(records) {
  const visible = getVisibleRecords(records);
  if (isCurrentUserAdmin()) return visible;
  const uid = state.currentUser?.id;
  return visible.filter(r => r && r.createdBy === uid);
}

function getVisibleClothesProducts() {
  return _clothesScopeToOwner(state.clothesProducts);
}

// Personal settings: ONE record per user, strictly own for everyone
// (including admin — the platform owner's rate must not pick up a client's).
function getClothesSettingsRecord() {
  const uid = state.currentUser?.id;
  if (!uid) return null;
  return getVisibleRecords(state.clothesSettings).find(r => r && r.createdBy === uid) || null;
}

// The USD→LYD rate used for THIS user's profit math. Falls back to the app's
// global rate for admins; subscribers must set their own (0 = unset → the UI
// hides profit instead of showing wrong numbers).
function getClothesExchangeRate() {
  const own = Number(getClothesSettingsRecord()?.rateLYDperUSD) || 0;
  if (own > 0) return own;
  return isCurrentUserAdmin() ? (Number(state.defaultExchangeRate) || 0) : 0;
}

function saveClothesExchangeRate() {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  const value = clothesParseMoney(document.getElementById('clothes-rate-input')?.value);
  if (!(value > 0)) {
    showNotification(isAr ? 'تنبيه' : 'Validation', isAr ? 'أدخل سعر صرف أكبر من صفر (كم دينار يساوي الدولار).' : 'Enter a rate greater than zero (how many LYD one USD is worth).', 'error');
    return;
  }
  const existing = getClothesSettingsRecord();
  if (existing) {
    updateRecord(state.clothesSettings, existing.id, { rateLYDperUSD: value });
  } else {
    addRecord(state.clothesSettings, { rateLYDperUSD: value, createdAt: new Date().toISOString() });
  }
  showNotification(isAr ? 'تم الحفظ' : 'Saved', isAr ? `سعر الصرف الآن: ${value}` : `Exchange rate is now: ${value}`, 'success');
  render();
}

// ------------------------------------------
// Tab bar + view shell
// ------------------------------------------

function renderClothesTabBar() {
  const isAr = clothesIsAr();
  return `
    <div class="flex flex-wrap gap-2 mb-8">
      ${CLOTHES_TABS.map(tab => {
        const active = _clothesActiveTab === tab.id;
        return `
          <button
            type="button"
            onclick="setClothesTab('${tab.id}')"
            class="flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-all ${active
              ? 'bg-gradient-to-r from-rose-500 to-pink-500 text-white shadow-lg'
              : 'glass-panel text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400'}"
          >
            <i data-lucide="${tab.icon}" class="w-4 h-4"></i>
            <span>${isAr ? tab.labelAr : tab.label}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

// Shared placeholder for tabs not built yet (removed stage by stage)
function renderClothesComingSoonPanel(icon, title, titleAr, desc, descAr) {
  const isAr = clothesIsAr();
  return `
    <div class="glass-panel rounded-2xl p-12 text-center">
      <div class="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center mb-6 shadow-2xl">
        <i data-lucide="${icon}" class="w-10 h-10 text-white"></i>
      </div>
      <h3 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${isAr ? titleAr : title}</h3>
      <p class="text-slate-500 dark:text-slate-400 max-w-xl mx-auto mb-6">${isAr ? descAr : desc}</p>
      <span class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
        <i data-lucide="hammer" class="w-3.5 h-3.5"></i>
        ${isAr ? 'يتم البناء الآن — المرحلة القادمة' : 'Under construction — next stage'}
      </span>
    </div>
  `;
}

function renderClothesDashboardTab() {
  const isAr = clothesIsAr();
  const products = getVisibleClothesProducts();
  const shipments = getVisibleClothesShipments();
  const orders = getVisibleClothesOrders();

  // Warehouse: pieces + cost value + low-stock list
  let totalPieces = 0;
  let stockValueUSD = 0;
  const lowStock = [];
  for (const p of products) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants) {
      const qty = Math.max(0, Math.floor(Number(v?.qty) || 0));
      totalPieces += qty;
      stockValueUSD += qty * (Number(p.costUSD) || 0);
      if (qty <= CLOTHES_LOW_STOCK_THRESHOLD) {
        lowStock.push({ name: p.name, color: v?.color, size: v?.size, qty });
      }
    }
  }
  stockValueUSD = Math.round(stockValueUSD * 100) / 100;

  // Shipments: money still on the way vs already brought in
  let inTransitUSD = 0, receivedUSD = 0;
  for (const s of shipments) {
    const t = getClothesShipmentTotals(s);
    if (s.status === 'Received') receivedUSD += t.totalUSD;
    else inTransitUSD += t.totalUSD;
  }
  inTransitUSD = Math.round(inTransitUSD * 100) / 100;
  receivedUSD = Math.round(receivedUSD * 100) / 100;

  // Orders: deliveries in motion + the money picture
  let outCount = 0, outValueLYD = 0, collectedLYD = 0, owedLYD = 0;
  for (const o of orders) {
    const t = getClothesOrderTotals(o);
    if (o.status === 'On the way') { outCount++; outValueLYD += t.totalLYD; }
    if (o.status !== 'Canceled' && o.status !== 'Returned') {
      collectedLYD += t.paidLYD;
      owedLYD += t.remainingLYD;
    }
  }
  outValueLYD = Math.round(outValueLYD * 100) / 100;
  collectedLYD = Math.round(collectedLYD * 100) / 100;
  owedLYD = Math.round(owedLYD * 100) / 100;

  // Profit (needs the exchange rate; hidden gracefully when unset)
  const rate = getClothesExchangeRate();
  let profitAllLYD = 0, profitMonthLYD = 0, deliveredThisMonth = 0;
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
  if (rate > 0) {
    for (const o of orders) {
      if (o.status !== 'Delivered') continue;
      const p = getClothesOrderProfitLYD(o);
      if (p === null) continue;
      profitAllLYD += p;
      const d = o.deliveredAt ? new Date(o.deliveredAt) : null;
      if (d && `${d.getFullYear()}-${d.getMonth()}` === monthKey) {
        profitMonthLYD += p;
        deliveredThisMonth++;
      }
    }
    profitAllLYD = Math.round(profitAllLYD * 100) / 100;
    profitMonthLYD = Math.round(profitMonthLYD * 100) / 100;
  }

  const bigCard = (icon, label, value, sub, gradient) => `
    <div class="glass-panel rounded-2xl p-5">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shadow-lg shrink-0">
          <i data-lucide="${icon}" class="w-6 h-6 text-white"></i>
        </div>
        <div class="min-w-0">
          <div class="text-xs text-slate-500 dark:text-slate-400">${label}</div>
          <div class="text-xl font-bold text-slate-800 dark:text-white truncate">${value}</div>
          ${sub ? `<div class="text-xs text-slate-400 dark:text-slate-500 truncate">${sub}</div>` : ''}
        </div>
      </div>
    </div>
  `;

  const lowStockList = lowStock.slice(0, 10).map(item => {
    const variant = [item.color, item.size].map(x => String(x || '').trim()).filter(Boolean).join(' · ');
    const chip = item.qty === 0
      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    return `
      <div class="flex items-center justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
        <div class="min-w-0">
          <span class="font-medium text-slate-700 dark:text-slate-200">${Security.escapeHtml(String(item.name || ''))}</span>
          ${variant ? `<span class="text-slate-400 dark:text-slate-500 text-sm"> — ${Security.escapeHtml(variant)}</span>` : ''}
        </div>
        <span class="px-2.5 py-0.5 rounded-full text-xs font-bold whitespace-nowrap ${chip}">
          ${item.qty === 0 ? (isAr ? 'نفد' : 'Out') : item.qty}
        </span>
      </div>
    `;
  }).join('');

  // First-time guide: shown until the system has any real data
  const isEmpty = products.length === 0 && shipments.length === 0 && orders.length === 0;
  const guideStep = (n, icon, title, desc, onclick, btnLabel) => `
    <div class="flex-1 glass-panel rounded-2xl p-5 text-center">
      <div class="w-10 h-10 mx-auto rounded-full bg-gradient-to-br from-rose-500 to-pink-500 text-white font-bold flex items-center justify-center mb-3 shadow-lg">${n}</div>
      <i data-lucide="${icon}" class="w-6 h-6 mx-auto text-rose-400 mb-2"></i>
      <h4 class="font-bold text-slate-800 dark:text-white mb-1">${title}</h4>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">${desc}</p>
      <button onclick="${onclick}" class="text-sm font-bold text-rose-600 hover:text-rose-700">${btnLabel} ←</button>
    </div>
  `;
  const firstRunGuide = !isEmpty ? '' : `
    <div class="glass-panel rounded-2xl p-6 mb-6">
      <h3 class="text-xl font-bold text-slate-800 dark:text-white mb-1 text-center">${isAr ? '👋 أهلاً بك! ثلاث خطوات وتبدأ' : '👋 Welcome! Three steps to get going'}</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-5 text-center">${isAr ? 'هكذا يعمل النظام — من الشراء إلى البيع' : 'This is how the system works — from buying to selling'}</p>
      <div class="flex flex-col md:flex-row gap-4" dir="${isAr ? 'rtl' : 'ltr'}">
        ${guideStep(1, 'shirt', isAr ? 'أضف بضاعتك' : 'Add your products', isAr ? 'كل قطعة: الصورة والسعر والألوان والمقاسات.' : 'Each item: photo, prices, colors and sizes.', "setClothesTab('products'); showClothesProductModal();", isAr ? 'أضف منتجاً' : 'Add a product')}
        ${guideStep(2, 'plane', isAr ? 'سجّل شحناتك' : 'Record your shipments', isAr ? 'عند الاستلام تُضاف الكميات للمخزون تلقائياً.' : 'Receiving adds the quantities to stock automatically.', "setClothesTab('shipments'); showClothesShipmentModal();", isAr ? 'أضف شحنة' : 'Add a shipment')}
        ${guideStep(3, 'shopping-bag', isAr ? 'بِع لزبائنك' : 'Sell to your customers', isAr ? 'الطلب يخصم من المخزون ويتابع التوصيل والدفع.' : 'An order deducts stock and tracks delivery and payment.', "setClothesTab('orders'); showClothesOrderModal();", isAr ? 'أنشئ طلباً' : 'Create an order')}
      </div>
    </div>
  `;

  return `
    <div>
      ${firstRunGuide}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        ${bigCard('warehouse', isAr ? 'قيمة المخزون (تكلفة)' : 'Stock value (cost)', clothesFmtUSD(stockValueUSD), isAr ? `${totalPieces} قطعة في المستودع` : `${totalPieces} pieces in the warehouse`, 'from-rose-500 to-pink-500')}
        ${bigCard('plane', isAr ? 'بضاعة في الطريق' : 'Goods on the way', clothesFmtUSD(inTransitUSD), isAr ? 'شحنات لم تُستلم بعد' : 'Shipments not yet received', 'from-blue-500 to-cyan-500')}
        ${bigCard('banknote', isAr ? 'إجمالي ما استوردته' : 'Total imported', clothesFmtUSD(receivedUSD), isAr ? 'الشحنات المستلمة (بضاعة + شحن)' : 'Received shipments (goods + shipping)', 'from-violet-500 to-fuchsia-500')}
        ${bigCard('truck', isAr ? 'طلبات في الطريق للزبائن' : 'Orders out for delivery', String(outCount), clothesFmtLYD(outValueLYD), 'from-amber-400 to-orange-500')}
        ${bigCard('circle-check', isAr ? 'المال المحصَّل' : 'Money collected', clothesFmtLYD(collectedLYD), isAr ? 'من الطلبات الفعّالة' : 'From active orders', 'from-emerald-500 to-green-500')}
        ${bigCard('alert-triangle', isAr ? 'متبقٍ عند الزبائن' : 'Still owed by customers', clothesFmtLYD(owedLYD), isAr ? 'مبالغ غير محصّلة' : 'Uncollected amounts', 'from-red-500 to-rose-500')}
        ${rate > 0
          ? bigCard('trending-up', isAr ? 'الربح التقديري (المُسلّم)' : 'Est. profit (delivered)', clothesFmtLYD(profitAllLYD), isAr ? `سعر الصرف: ${rate}` : `Exchange rate: ${rate}`, 'from-emerald-600 to-teal-500')
          : bigCard('trending-up', isAr ? 'الربح التقديري' : 'Est. profit', '—', isAr ? 'حدّد سعر صرفك في الأسفل أولاً' : 'Set your exchange rate below first', 'from-slate-400 to-slate-500')}
        ${rate > 0
          ? bigCard('calendar', isAr ? 'هذا الشهر' : 'This month', clothesFmtLYD(profitMonthLYD), isAr ? `${deliveredThisMonth} طلب مُسلّم` : `${deliveredThisMonth} delivered orders`, 'from-indigo-500 to-purple-500')
          : ''}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="glass-panel rounded-2xl p-5">
          <h3 class="font-bold text-slate-800 dark:text-white mb-3 flex items-center gap-2">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-500"></i>
            ${isAr ? 'مقاسات شارفت على النفاد' : 'Running low'}
          </h3>
          ${lowStock.length
            ? lowStockList + (lowStock.length > 10 ? `<p class="mt-2 text-xs text-slate-400">${isAr ? `+${lowStock.length - 10} أخرى` : `+${lowStock.length - 10} more`}</p>` : '')
            : `<p class="text-sm text-slate-400 dark:text-slate-500">${isAr ? 'كل المقاسات متوفرة بكمية كافية 🎉' : 'Everything is well stocked 🎉'}</p>`}
        </div>

        <div class="glass-panel rounded-2xl p-5">
          <h3 class="font-bold text-slate-800 dark:text-white mb-3 flex items-center gap-2">
            <i data-lucide="zap" class="w-4 h-4 text-rose-500"></i>
            ${isAr ? 'إجراءات سريعة' : 'Quick actions'}
          </h3>
          <div class="space-y-2">
            <button onclick="setClothesTab('products'); showClothesProductModal();" class="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl glass-input hover:border-rose-400 font-medium text-slate-700 dark:text-slate-200">
              <i data-lucide="shirt" class="w-4 h-4 text-rose-500"></i>${isAr ? 'إضافة منتج' : 'Add a product'}
            </button>
            <button onclick="setClothesTab('shipments'); showClothesShipmentModal();" class="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl glass-input hover:border-rose-400 font-medium text-slate-700 dark:text-slate-200">
              <i data-lucide="plane" class="w-4 h-4 text-blue-500"></i>${isAr ? 'إضافة شحنة' : 'Add a shipment'}
            </button>
            <button onclick="setClothesTab('orders'); showClothesOrderModal();" class="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl glass-input hover:border-rose-400 font-medium text-slate-700 dark:text-slate-200">
              <i data-lucide="shopping-bag" class="w-4 h-4 text-emerald-500"></i>${isAr ? 'طلب جديد لزبون' : 'New customer order'}
            </button>
          </div>

          <h3 class="font-bold text-slate-800 dark:text-white mt-5 mb-2 flex items-center gap-2">
            <i data-lucide="banknote" class="w-4 h-4 text-emerald-500"></i>
            ${isAr ? 'سعر الصرف الخاص بك' : 'Your exchange rate'}
          </h3>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-2">
            ${isAr ? 'كم ديناراً يساوي الدولار الواحد — يُستخدم لحساب أرباحك أنت فقط.' : 'How many LYD one USD is worth — used only for YOUR profit numbers.'}
          </p>
          <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0.5rem;align-items:center;">
            <input type="text" inputmode="decimal" id="clothes-rate-input" value="${rate > 0 ? rate : ''}" oninput="sanitizeMoneyInput(this)" placeholder="${isAr ? 'مثال: 5.2' : 'e.g. 5.2'}" style="width:100%;min-width:0;" class="glass-input px-3 py-2 rounded-xl text-sm" />
            <button onclick="saveClothesExchangeRate()" class="btn-shine bg-gradient-to-r from-emerald-500 to-teal-500 text-white px-4 py-2 rounded-xl text-sm font-bold shadow">
              ${isAr ? 'حفظ' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ------------------------------------------
// CSV EXPORTS (Excel-friendly: UTF-8 BOM + en-CA dates, like exportAuditLogs)
// ------------------------------------------

function _clothesCsvCell(v) {
  // Delegate to the shared escaper so clothes exports also get the
  // formula-injection guard (a product name / customer note starting with
  // = + - @ used to execute as a spreadsheet formula on open).
  return csvCell(v);
}

function _clothesDownloadCsv(rows, filenameBase) {
  const csv = rows.map(r => r.map(_clothesCsvCell).join(',')).join('\n');
  downloadFile('﻿' + csv, `${filenameBase}-${getTodayDateString()}.csv`, 'text/csv;charset=utf-8');
  showNotification(clothesIsAr() ? 'تم التصدير' : 'Exported', clothesIsAr() ? 'تم تنزيل ملف CSV.' : 'CSV file downloaded.', 'success');
}

function exportClothesProductsCSV() {
  const isAr = clothesIsAr();
  const rows = [[
    isAr ? 'المنتج' : 'Product', isAr ? 'الفئة' : 'Category', isAr ? 'اللون' : 'Color', isAr ? 'المقاس' : 'Size',
    isAr ? 'الكمية' : 'Qty', isAr ? 'التكلفة $' : 'Cost USD', isAr ? 'سعر البيع د.ل' : 'Price LYD'
  ]];
  for (const p of getFilteredClothesProducts()) {
    const variants = Array.isArray(p.variants) && p.variants.length ? p.variants : [{ color: '', size: '', qty: 0 }];
    for (const v of variants) {
      rows.push([p.name || '', p.category || '', v.color || '', v.size || '', Math.max(0, Math.floor(Number(v.qty) || 0)), Number(p.costUSD) || 0, Number(p.priceLYD) || 0]);
    }
  }
  _clothesDownloadCsv(rows, 'clothes-products');
}

function exportClothesShipmentsCSV() {
  const isAr = clothesIsAr();
  const rows = [[
    isAr ? 'المرجع' : 'Reference', isAr ? 'المورد' : 'Supplier', isAr ? 'الحالة' : 'Status',
    isAr ? 'تاريخ الطلب' : 'Ordered', isAr ? 'تاريخ الاستلام' : 'Received',
    isAr ? 'القطع' : 'Pieces', isAr ? 'البضاعة $' : 'Goods USD', isAr ? 'الشحن $' : 'Shipping USD', isAr ? 'الإجمالي $' : 'Total USD',
    isAr ? 'ملاحظة' : 'Note'
  ]];
  for (const s of getFilteredClothesShipments()) {
    const t = getClothesShipmentTotals(s);
    const meta = clothesShipmentStatusMeta(s.status);
    rows.push([
      s.ref || '', s.supplier || '', isAr ? meta.labelAr : meta.label,
      s.orderedAt || '', s.receivedAt ? String(s.receivedAt).split('T')[0] : '',
      t.pieces, t.goodsUSD, t.shippingUSD, t.totalUSD, s.note || ''
    ]);
  }
  _clothesDownloadCsv(rows, 'clothes-shipments');
}

function exportClothesOrdersCSV() {
  const isAr = clothesIsAr();
  const rows = [[
    isAr ? 'الزبون' : 'Customer', isAr ? 'الهاتف' : 'Phone', isAr ? 'الحالة' : 'Status', isAr ? 'الدفع' : 'Payment',
    isAr ? 'القطع' : 'Pieces', isAr ? 'البضاعة د.ل' : 'Goods LYD', isAr ? 'التوصيل د.ل' : 'Delivery LYD',
    isAr ? 'الإجمالي د.ل' : 'Total LYD', isAr ? 'المدفوع د.ل' : 'Paid LYD', isAr ? 'المتبقي د.ل' : 'Remaining LYD',
    isAr ? 'طريقة الدفع' : 'Method', isAr ? 'تاريخ الإنشاء' : 'Created', isAr ? 'تاريخ التسليم' : 'Delivered',
    isAr ? 'ملاحظة' : 'Note'
  ]];
  for (const o of getFilteredClothesOrders()) {
    const t = getClothesOrderTotals(o);
    const meta = clothesOrderStatusMeta(o.status);
    const payMeta = clothesPaymentStatusMeta(o.paymentStatus);
    rows.push([
      o.customerName || '', o.customerPhone || '', isAr ? meta.labelAr : meta.label, isAr ? payMeta.labelAr : payMeta.label,
      t.pieces, t.goodsLYD, t.feeLYD, t.totalLYD, t.paidLYD, t.remainingLYD,
      o.paymentMethod || '', o.createdAt ? String(o.createdAt).split('T')[0] : '', o.deliveredAt ? String(o.deliveredAt).split('T')[0] : '',
      o.note || ''
    ]);
  }
  _clothesDownloadCsv(rows, 'clothes-orders');
}

// (Shipments tab implemented in the SHIPMENTS section below)

// (Orders tab implemented in the ORDERS section below)

function renderClothesSystemView() {
  const isAr = clothesIsAr();
  const isAdmin = isCurrentUserAdmin();

  // Subscription gate for non-admins (view access alone is not enough)
  if (!isAdmin && !hasSubscription('clothes_system')) {
    return `
      <div class="max-w-2xl mx-auto">
        <div class="glass-panel rounded-2xl p-12 text-center">
          <div class="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mb-6 shadow-2xl">
            <i data-lucide="lock" class="w-10 h-10 text-white"></i>
          </div>
          <h3 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${isAr ? 'الاشتراك مطلوب' : 'Subscription required'}</h3>
          <p class="text-slate-500 dark:text-slate-400 mb-6">${isAr ? 'نظام الملابس خدمة باشتراك. اشترك لتبدأ إدارة مخزونك وطلباتك.' : 'The Clothes System is a subscription service. Subscribe to start managing your stock and orders.'}</p>
          <button onclick="showSubscriptionModal('clothes_system', 'clothes_system')" class="btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-8 py-3 rounded-xl font-bold shadow-lg">
            ${isAr ? 'اشترك الآن' : 'Subscribe now'}
          </button>
        </div>
      </div>
    `;
  }

  let tabContent;
  switch (_clothesActiveTab) {
    case 'products': tabContent = renderClothesProductsTab(); break;
    case 'shipments': tabContent = renderClothesShipmentsTab(); break;
    case 'orders': tabContent = renderClothesOrdersTab(); break;
    default: tabContent = renderClothesDashboardTab();
  }

  // Back target: admins return to the Smart Systems hub; employees with other
  // permissions return to their first allowed manager page; pure subscribers
  // (this is their whole world) get no back button.
  const backView = isAdmin ? 'smart-systems' : getAlbayanManagerLandingViewForUser(state.currentUser);
  const showBack = isAdmin || (backView && backView !== 'clothes-system' && backView !== 'no-access');
  const backLabel = isAdmin ? (isAr ? 'العودة للأنظمة الذكية' : 'Back to Smart Systems') : (isAr ? 'العودة' : 'Back');

  return `
    <div class="max-w-6xl mx-auto">
      ${showBack ? `
      <!-- Back Button -->
      <button onclick="navigateTo('${backView}')" class="mb-6 flex items-center gap-2 text-rose-600 hover:text-rose-700 font-medium">
        <i data-lucide="${isAr ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${backLabel}</span>
      </button>` : ''}

      <!-- Header -->
      <div class="mb-8">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center shadow-2xl">
            <i data-lucide="shirt" class="w-8 h-8 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">
              ${isAr ? 'نظام الملابس' : 'Clothes System'}
            </h1>
            <p class="text-slate-500 dark:text-slate-400">
              ${isAr ? 'المستودع والشحنات وطلبات الزبائن' : 'Warehouse, shipments & customer orders'}
            </p>
          </div>
        </div>
      </div>

      ${renderClothesTabBar()}

      ${tabContent}
    </div>
  `;
}

// ------------------------------------------
// PRODUCTS TAB — list, search, stock adjust
// ------------------------------------------

let _clothesProductSearch = '';
let _clothesProductsShowLimit = CLOTHES_PRODUCTS_PAGE_SIZE;
let _clothesProductsFilterFingerprint = '';

function loadMoreClothesProducts() {
  _clothesProductsShowLimit += CLOTHES_PRODUCTS_PAGE_SIZE;
  updateClothesProductsFiltered();
}

function onClothesProductSearchInput(el) {
  const value = Security.sanitizeInput(String(el?.value || ''), { maxLength: 200 });
  _clothesProductSearch = value;
  if (window._clothesProductSearchTimer) clearTimeout(window._clothesProductSearchTimer);
  window._clothesProductSearchTimer = setTimeout(() => updateClothesProductsFiltered(), 80);
}

function getFilteredClothesProducts() {
  const q = _clothesProductSearch.trim().toLowerCase();
  let items = getVisibleClothesProducts();
  if (q) {
    items = items.filter(p => {
      const name = String(p.name || '').toLowerCase();
      const category = String(p.category || '').toLowerCase();
      if (name.includes(q) || category.includes(q)) return true;
      const variants = Array.isArray(p.variants) ? p.variants : [];
      return variants.some(v =>
        String(v?.color || '').toLowerCase().includes(q) ||
        String(v?.size || '').toLowerCase().includes(q)
      );
    });
  }
  return items;
}

// Targeted swap (caret-preserving): re-renders only the stats + grid regions,
// same pattern as updateCustomersViewFiltered.
function updateClothesProductsFiltered() {
  const container = document.querySelector('main');
  if (!container || state.currentView !== 'clothes-system' || _clothesActiveTab !== 'products') {
    render();
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = renderClothesProductsTab();
  const newStats = template.content.querySelector('#clothes-products-stats');
  const newGrid = template.content.querySelector('#clothes-products-grid');
  const curStats = document.getElementById('clothes-products-stats');
  const curGrid = document.getElementById('clothes-products-grid');
  if (newStats && curStats) curStats.innerHTML = newStats.innerHTML;
  if (newGrid && curGrid) curGrid.innerHTML = newGrid.innerHTML;
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(container);
  else lucide.createIcons();
}

function renderClothesProductsTab() {
  const isAr = clothesIsAr();
  const all = getVisibleClothesProducts();
  const filtered = getFilteredClothesProducts();

  // Reset pagination when the filter changes
  const fingerprint = JSON.stringify([_clothesProductSearch]);
  if (fingerprint !== _clothesProductsFilterFingerprint) {
    _clothesProductsFilterFingerprint = fingerprint;
    _clothesProductsShowLimit = CLOTHES_PRODUCTS_PAGE_SIZE;
  }
  const shown = filtered.slice(0, _clothesProductsShowLimit);
  const remaining = Math.max(0, filtered.length - shown.length);

  // Stats
  let totalPieces = 0;
  let stockValueUSD = 0;
  let lowVariants = 0;
  for (const p of all) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants) {
      const qty = Math.max(0, Math.floor(Number(v?.qty) || 0));
      totalPieces += qty;
      stockValueUSD += qty * (Number(p.costUSD) || 0);
      if (qty <= CLOTHES_LOW_STOCK_THRESHOLD) lowVariants++;
    }
  }
  stockValueUSD = Math.round(stockValueUSD * 100) / 100;

  const statCard = (icon, label, value, gradient) => `
    <div class="glass-panel rounded-2xl p-4 flex items-center gap-3">
      <div class="w-11 h-11 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shadow-lg shrink-0">
        <i data-lucide="${icon}" class="w-5 h-5 text-white"></i>
      </div>
      <div class="min-w-0">
        <div class="text-xs text-slate-500 dark:text-slate-400">${label}</div>
        <div class="text-lg font-bold text-slate-800 dark:text-white truncate">${value}</div>
      </div>
    </div>
  `;

  return `
    <div>
      <div id="clothes-products-stats" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${statCard('shirt', isAr ? 'المنتجات' : 'Products', String(all.length), 'from-rose-500 to-pink-500')}
        ${statCard('boxes', isAr ? 'القطع في المخزون' : 'Pieces in stock', String(totalPieces), 'from-blue-500 to-cyan-500')}
        ${statCard('banknote', isAr ? 'قيمة المخزون (تكلفة)' : 'Stock value (cost)', clothesFmtUSD(stockValueUSD), 'from-emerald-500 to-green-500')}
        ${statCard('alert-triangle', isAr ? 'مقاسات شارفت على النفاد' : 'Low-stock variants', String(lowVariants), 'from-amber-400 to-orange-500')}
      </div>

      <div class="flex flex-col sm:flex-row gap-3 mb-6">
        <div class="relative flex-1">
          <i data-lucide="search" class="w-4 h-4 absolute top-1/2 -translate-y-1/2 ${isAr ? 'right-4' : 'left-4'} text-slate-400"></i>
          <input
            type="text"
            id="clothes-product-search"
            value="${Security.escapeHtml(_clothesProductSearch)}"
            oninput="onClothesProductSearchInput(this)"
            placeholder="${isAr ? 'ابحث بالاسم أو الفئة أو اللون أو المقاس...' : 'Search by name, category, color or size...'}"
            class="w-full glass-input ${isAr ? 'pr-11 pl-4' : 'pl-11 pr-4'} py-2.5 rounded-xl"
          />
        </div>
        <button onclick="exportClothesProductsCSV()" class="glass-panel px-3 py-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:text-rose-600 flex items-center justify-center" title="${isAr ? 'تصدير CSV (إكسل)' : 'Export CSV (Excel)'}">
          <i data-lucide="download" class="w-4 h-4"></i>
        </button>
        <button onclick="showClothesProductModal()" class="btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-5 py-2.5 rounded-xl font-bold shadow-lg hover:shadow-xl flex items-center justify-center gap-2">
          <i data-lucide="plus" class="w-4 h-4"></i>
          ${isAr ? 'إضافة منتج' : 'Add Product'}
        </button>
      </div>

      <div id="clothes-products-grid">
        ${shown.length === 0 ? `
          <div class="glass-panel rounded-2xl p-12 text-center">
            <div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center mb-4 shadow-xl opacity-80">
              <i data-lucide="shirt" class="w-8 h-8 text-white"></i>
            </div>
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-1">
              ${all.length === 0
                ? (isAr ? 'لا توجد منتجات بعد' : 'No products yet')
                : (isAr ? 'لا توجد نتائج للبحث' : 'No results for this search')}
            </h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${all.length === 0
                ? (isAr ? 'أضف أول منتج لبدء تتبع المخزون.' : 'Add your first product to start tracking stock.')
                : (isAr ? 'جرّب كلمة بحث أخرى.' : 'Try a different search term.')}
            </p>
          </div>
        ` : `
          <div class="text-sm text-slate-500 dark:text-slate-400 mb-3" id="clothes-products-count">
            ${isAr ? `عرض ${shown.length} من ${filtered.length} منتج` : `Showing ${shown.length} of ${filtered.length} products`}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${shown.map(p => renderClothesProductCard(p)).join('')}
          </div>
          ${remaining > 0 ? `
            <div class="text-center mt-6">
              <button onclick="loadMoreClothesProducts()" class="glass-panel px-6 py-2.5 rounded-xl font-medium text-slate-600 dark:text-slate-300 hover:text-rose-600">
                ${isAr ? `عرض المزيد (${remaining} متبقي)` : `Load more (${remaining} remaining)`}
              </button>
            </div>
          ` : ''}
        `}
      </div>
    </div>
  `;
}

function renderClothesProductCard(p) {
  const isAr = clothesIsAr();
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const totalQty = getClothesProductTotalQty(p);

  const qtyBadgeClass = totalQty === 0
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : (variants.some(v => (Math.floor(Number(v?.qty) || 0)) <= CLOTHES_LOW_STOCK_THRESHOLD)
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300');

  const variantChips = variants.map((v, idx) => {
    const qty = Math.max(0, Math.floor(Number(v?.qty) || 0));
    const label = [v?.color, v?.size].map(s => String(s || '').trim()).filter(Boolean).join(' · ') || (isAr ? 'بدون تحديد' : 'unspecified');
    const chipClass = qty === 0
      ? 'border-red-300 dark:border-red-700 text-red-600 dark:text-red-400'
      : (qty <= CLOTHES_LOW_STOCK_THRESHOLD
        ? 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400'
        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300');
    return `
      <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium border ${chipClass}">
        <span>${Security.escapeHtml(label)}</span>
        <button type="button" onclick="adjustClothesVariantQty('${p.id}', ${idx}, -1)" class="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-rose-200 dark:hover:bg-rose-800 flex items-center justify-center leading-none" title="-1">−</button>
        <span class="font-bold">${qty}</span>
        <button type="button" onclick="adjustClothesVariantQty('${p.id}', ${idx}, 1)" class="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-emerald-200 dark:hover:bg-emerald-800 flex items-center justify-center leading-none" title="+1">+</button>
      </span>
    `;
  }).join('');

  return `
    <div class="glass-panel rounded-2xl p-5">
      <div class="flex items-start gap-4">
        <div class="w-16 h-16 rounded-xl overflow-hidden bg-gradient-to-br from-rose-100 to-pink-100 dark:from-rose-900/30 dark:to-pink-900/30 flex items-center justify-center shrink-0">
          ${p.photo
            ? `<img src="${Security.escapeHtml(p.photo)}" alt="" class="w-full h-full object-cover" />`
            : `<i data-lucide="shirt" class="w-7 h-7 text-rose-400"></i>`}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h4 class="font-bold text-slate-800 dark:text-white truncate">${Security.escapeHtml(p.name || '')}</h4>
              ${p.category ? `<span class="inline-block mt-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">${Security.escapeHtml(p.category)}</span>` : ''}
            </div>
            <span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${qtyBadgeClass}">
              ${totalQty} ${isAr ? 'قطعة' : 'pcs'}
            </span>
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm">
            <span class="text-slate-500 dark:text-slate-400">${isAr ? 'التكلفة:' : 'Cost:'} <span class="font-bold text-slate-700 dark:text-slate-200">${clothesFmtUSD(p.costUSD)}</span></span>
            <span class="text-slate-500 dark:text-slate-400">${isAr ? 'البيع:' : 'Sell:'} <span class="font-bold text-emerald-600 dark:text-emerald-400">${clothesFmtLYD(p.priceLYD)}</span></span>
          </div>
        </div>
      </div>

      ${variants.length ? `<div class="flex flex-wrap gap-1.5 mt-4">${variantChips}</div>` : `
        <div class="mt-4 text-xs text-slate-400 dark:text-slate-500">${isAr ? 'لا توجد ألوان/مقاسات بعد — عدّل المنتج لإضافتها.' : 'No colors/sizes yet — edit the product to add them.'}</div>
      `}

      ${p.note ? `<p class="mt-3 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">${Security.escapeHtml(p.note)}</p>` : ''}

      <div class="flex gap-2 mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
        <button onclick="editClothesProduct('${p.id}')" class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i>${isAr ? 'تعديل' : 'Edit'}
        </button>
        <button onclick="deleteClothesProduct('${p.id}')" class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>${isAr ? 'حذف' : 'Delete'}
        </button>
      </div>
    </div>
  `;
}

function adjustClothesVariantQty(productId, variantIndex, delta) {
  if (!clothesCanUse()) return;
  const product = getVisibleClothesProducts().find(p => p.id === productId);
  if (!product) return;
  const variants = (Array.isArray(product.variants) ? product.variants : []).map(v => ({ ...v }));
  const v = variants[variantIndex];
  if (!v) return;
  v.qty = Math.max(0, Math.floor(Number(v.qty) || 0) + (Number(delta) || 0));
  updateRecord(state.clothesProducts, productId, { variants });
  updateClothesProductsFiltered();
}

function deleteClothesProduct(id) {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  const product = getVisibleClothesProducts().find(p => p.id === id);
  if (!product) return;
  const name = product.name || (isAr ? 'منتج' : 'product');
  // Live records that still plan to MOVE this product's stock: a shipment on
  // the way whose pieces would arrive, and active orders whose pieces would
  // return to stock on cancel. After deletion those movements are silently
  // skipped — the user must know before confirming.
  const pendingShipments = (state.clothesShipments || []).filter(s => s && !s._deleted
    && String(s.status || '') !== 'Received'
    && Array.isArray(s.lines) && s.lines.some(l => String(l?.productId || '') === String(id))).length;
  const activeOrders = (state.clothesOrders || []).filter(o => o && !o._deleted
    && clothesOrderIsActiveStatus(o.status)
    && Array.isArray(o.lines) && o.lines.some(l => String(l?.productId || '') === String(id))).length;
  let msg = isAr
    ? `هل تريد حذف المنتج "${name}"؟\nسيبقى في الشحنات والطلبات القديمة كسجل فقط.`
    : `Delete product "${name}"?\nOld shipments and orders will keep it for history only.`;
  if (pendingShipments > 0) {
    msg += isAr
      ? `\n\n⚠️ ${pendingShipments} شحنة لم تصل بعد تحتوي هذا المنتج — قطعها لن تُضاف إلى المخزون عند الاستلام.`
      : `\n\n⚠️ ${pendingShipments} shipment(s) still on the way contain this product — their pieces will NOT be added to stock on arrival.`;
  }
  if (activeOrders > 0) {
    msg += isAr
      ? `\n\n⚠️ ${activeOrders} طلب نشط يحتوي هذا المنتج — إلغاؤه أو إرجاعه لن يعيد القطع إلى المخزون.`
      : `\n\n⚠️ ${activeOrders} active order(s) contain this product — canceling or returning them will NOT put the pieces back in stock.`;
  }
  const ok = confirm(msg);
  if (!ok) return;
  deleteRecord(state.clothesProducts, id);
  showNotification(
    isAr ? 'تم الحذف' : 'Deleted',
    isAr ? 'تم حذف المنتج.' : 'Product deleted.',
    'success'
  );
  updateClothesProductsFiltered();
}

// ------------------------------------------
// PRODUCT MODAL (add / edit)
// ------------------------------------------

// Temp modal state (seeded on open, cleared in closeModal)
let _clothesTempVariants = [];
let _clothesTempPhoto = null;
// Generation token for async photo compression — bumped on every product modal
// open/close so a callback that resolves after the modal changed is discarded.
let _clothesPhotoToken = 0;

function showClothesProductModal() {
  if (!clothesCanUse()) return;
  state.activeModal = 'clothes-product';
  state.modalData = null;
  _clothesTempVariants = [{ color: '', size: '', qty: 0 }];
  _clothesTempPhoto = null;
  _clothesPhotoToken++; // invalidate any pending photo-compression callback
  updateUrlParams({ modal: 'clothes-product', id: 'new' }); // URL tracking
  renderModal();
}

function editClothesProduct(id) {
  if (!clothesCanUse()) return;
  const product = getVisibleClothesProducts().find(p => p.id === id);
  if (!product) return;
  state.activeModal = 'clothes-product';
  state.modalData = product;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  _clothesTempVariants = variants.length
    ? variants.map(v => ({ color: String(v?.color || ''), size: String(v?.size || ''), qty: Math.max(0, Math.floor(Number(v?.qty) || 0)) }))
    : [{ color: '', size: '', qty: 0 }];
  _clothesTempPhoto = product.photo || null;
  _clothesPhotoToken++; // invalidate any pending photo callback from a prior modal
  updateUrlParams({ modal: 'clothes-product', id }); // URL tracking
  renderModal();
}

function renderClothesProductModal() {
  const isAr = clothesIsAr();
  const data = state.modalData || {};
  const isEdit = state.modalData !== null;
  const categories = [...new Set(getVisibleClothesProducts().map(p => String(p.category || '').trim()).filter(Boolean))];

  return `
    <h2 class="text-2xl font-bold mb-4 flex items-center gap-2">
      <i data-lucide="shirt" class="w-6 h-6 text-rose-500"></i>
      ${isEdit ? (isAr ? 'تعديل منتج' : 'Edit Product') : (isAr ? 'إضافة منتج' : 'Add Product')}
    </h2>
    <form id="modal-form" class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar ${isAr ? 'pl-2' : 'pr-2'}">
      <!-- Frozen edit target: never trust state.modalData at save time (it can be
           repointed by URL restore) — same defense as #receipt-editing-id. -->
      <input type="hidden" id="clothes-product-editing-id" value="${Security.escapeHtml(String(isEdit ? (data.id || '') : ''))}" />

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'اسم المنتج *' : 'Product name *'}</label>
        <input type="text" id="clothes-product-name" value="${Security.escapeHtml(data.name || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'مثال: قميص قطن رجالي' : 'e.g. Men cotton shirt'}" />
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'الفئة' : 'Category'}</label>
        <input type="text" id="clothes-product-category" list="clothes-categories-list" value="${Security.escapeHtml(data.category || '')}" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'مثال: قمصان، بناطيل، فساتين...' : 'e.g. Shirts, Pants, Dresses...'}" />
        <datalist id="clothes-categories-list">
          ${categories.map(c => `<option value="${Security.escapeHtml(c)}"></option>`).join('')}
        </datalist>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'سعر التكلفة (دولار) *' : 'Cost price (USD) *'}</label>
          <input type="text" inputmode="decimal" id="clothes-product-cost" value="${Security.escapeHtml(String(data.costUSD ?? ''))}" oninput="sanitizeMoneyInput(this)" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="0.00" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'سعر البيع (دينار) *' : 'Selling price (LYD) *'}</label>
          <input type="text" inputmode="decimal" id="clothes-product-price" value="${Security.escapeHtml(String(data.priceLYD ?? ''))}" oninput="sanitizeMoneyInput(this)" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="0.00" />
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'الألوان والمقاسات والكمية' : 'Colors, sizes & quantity'}</label>
        <div id="clothes-variant-rows" class="space-y-2"></div>
        <button type="button" onclick="addClothesVariantRow()" class="mt-2 flex items-center gap-1.5 text-sm font-medium text-rose-600 hover:text-rose-700">
          <i data-lucide="plus" class="w-4 h-4"></i>${isAr ? 'إضافة لون/مقاس' : 'Add color/size'}
        </button>
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'صورة (اختياري)' : 'Photo (optional)'}</label>
        <div id="clothes-photo-preview-wrap"></div>
        <input type="file" id="clothes-product-photo-input" accept="image/*" class="hidden" onchange="onClothesProductPhotoSelected(this)" />
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'ملاحظة' : 'Note'}</label>
        <textarea id="clothes-product-note" rows="2" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'اختياري' : 'Optional'}">${Security.escapeHtml(data.note || '')}</textarea>
      </div>

      <div class="flex gap-3 pt-2">
        <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg">
          ${isEdit ? (isAr ? 'حفظ التعديلات' : 'Save Changes') : (isAr ? 'إضافة المنتج' : 'Add Product')}
        </button>
        <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600">
          ${isAr ? 'إلغاء' : 'Cancel'}
        </button>
      </div>
    </form>
  `;
}

// Variant rows: inputs write straight into _clothesTempVariants (no re-render
// while typing, so the caret is preserved); add/remove re-render the rows only.
function refreshClothesVariantRows() {
  const isAr = clothesIsAr();
  const wrap = document.getElementById('clothes-variant-rows');
  if (!wrap) return;
  // Inline grid template: width utility classes proved unreliable inside the
  // modal in narrow webviews, so the column sizes are pinned inline.
  const rowStyle = 'display:grid;grid-template-columns:minmax(0,1fr) 5.5rem 4.5rem 2rem;gap:0.5rem;align-items:center;';
  const cellStyle = 'width:100%;min-width:0;';
  wrap.innerHTML = _clothesTempVariants.map((v, idx) => `
    <div style="${rowStyle}">
      <input type="text" value="${Security.escapeHtml(String(v.color || ''))}" oninput="onClothesVariantField(${idx}, 'color', this.value)" placeholder="${isAr ? 'اللون' : 'Color'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" />
      <input type="text" value="${Security.escapeHtml(String(v.size || ''))}" oninput="onClothesVariantField(${idx}, 'size', this.value)" placeholder="${isAr ? 'المقاس' : 'Size'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" />
      <input type="number" min="0" step="1" value="${Math.max(0, Math.floor(Number(v.qty) || 0))}" oninput="onClothesVariantField(${idx}, 'qty', this.value)" placeholder="0" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'الكمية' : 'Quantity'}" />
      <button type="button" onclick="removeClothesVariantRow(${idx})" class="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="${isAr ? 'إزالة' : 'Remove'}">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>
  `).join('');
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap);
}

function onClothesVariantField(idx, field, value) {
  const v = _clothesTempVariants[idx];
  if (!v) return;
  if (field === 'qty') {
    v.qty = Math.max(0, Math.floor(Number(value) || 0));
  } else if (field === 'color' || field === 'size') {
    v[field] = Security.sanitizeInput(String(value || ''), { maxLength: 60 });
  }
}

function addClothesVariantRow() {
  _clothesTempVariants.push({ color: '', size: '', qty: 0 });
  refreshClothesVariantRows();
}

function removeClothesVariantRow(idx) {
  _clothesTempVariants.splice(idx, 1);
  if (_clothesTempVariants.length === 0) _clothesTempVariants.push({ color: '', size: '', qty: 0 });
  refreshClothesVariantRows();
}

function refreshClothesPhotoPreview() {
  const isAr = clothesIsAr();
  const wrap = document.getElementById('clothes-photo-preview-wrap');
  if (!wrap) return;
  if (_clothesTempPhoto) {
    wrap.innerHTML = `
      <div class="flex items-center gap-3">
        <img src="${Security.escapeHtml(_clothesTempPhoto)}" alt="" class="w-16 h-16 rounded-xl object-cover border border-slate-200 dark:border-slate-700" />
        <button type="button" onclick="removeClothesProductPhoto()" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>${isAr ? 'إزالة الصورة' : 'Remove photo'}
        </button>
      </div>
    `;
  } else {
    wrap.innerHTML = `
      <button type="button" onclick="document.getElementById('clothes-product-photo-input').click()" class="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-500 dark:text-slate-400 hover:border-rose-400 hover:text-rose-500">
        <i data-lucide="image-plus" class="w-4 h-4"></i>${isAr ? 'اختر صورة' : 'Choose photo'}
      </button>
    `;
  }
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap);
}

function onClothesProductPhotoSelected(input) {
  const file = input?.files && input.files[0];
  if (!file) return;
  const myToken = ++_clothesPhotoToken;
  compressImageToDataUrl(file).then((dataUrl) => {
    if (myToken !== _clothesPhotoToken || state.activeModal !== 'clothes-product') return; // modal changed — discard
    _clothesTempPhoto = dataUrl;
    refreshClothesPhotoPreview();
  }).catch(() => {
    if (myToken !== _clothesPhotoToken) return;
    showNotification('Error', clothesIsAr() ? 'تعذر قراءة الصورة' : 'Could not read the image', 'error');
  });
  // Allow re-selecting the same file later
  input.value = '';
}

function removeClothesProductPhoto() {
  _clothesTempPhoto = null;
  _clothesPhotoToken++; // a pending compression must not undo the removal
  refreshClothesPhotoPreview();
}

// Called by handleModalSubmit for state.activeModal === 'clothes-product'.
// Returns true when saved (modal may close), false to keep the modal open.
async function saveClothesProductFromModal() {
  if (!clothesCanUse()) return false;
  const isAr = clothesIsAr();

  const name = Security.sanitizeInput(String(document.getElementById('clothes-product-name')?.value || ''), { maxLength: 120 }).trim();
  if (!name) {
    showNotification(isAr ? 'تنبيه' : 'Validation', isAr ? 'اسم المنتج مطلوب' : 'Product name is required', 'error');
    return false;
  }
  const category = Security.sanitizeInput(String(document.getElementById('clothes-product-category')?.value || ''), { maxLength: 60 }).trim();
  const note = Security.sanitizeInput(String(document.getElementById('clothes-product-note')?.value || ''), { maxLength: 500 }).trim();
  const costUSD = clothesParseMoney(document.getElementById('clothes-product-cost')?.value);
  const priceLYD = clothesParseMoney(document.getElementById('clothes-product-price')?.value);

  // Normalize variants: trim, drop fully-empty rows, merge duplicate color+size
  const merged = new Map();
  for (const v of _clothesTempVariants) {
    const color = String(v?.color || '').trim();
    const size = String(v?.size || '').trim();
    const qty = Math.max(0, Math.floor(Number(v?.qty) || 0));
    if (!color && !size && qty === 0) continue;
    const key = `${color.toLowerCase()}|${size.toLowerCase()}`;
    if (merged.has(key)) {
      merged.get(key).qty += qty;
    } else {
      merged.set(key, { color, size, qty });
    }
  }
  const variants = Array.from(merged.values());

  const editingId = String(document.getElementById('clothes-product-editing-id')?.value || '').trim();
  const editTarget = editingId ? getVisibleClothesProducts().find(p => p.id === editingId) : null;
  // Editing a record that vanished (deleted on another device mid-edit) must
  // NOT silently create a duplicate — abort and tell the user to reopen.
  if (editingId && !editTarget) {
    showNotification(isAr ? 'تعذّر الحفظ' : 'Cannot save', isAr ? 'تم حذف هذا المنتج. أعد فتح القائمة.' : 'This product was deleted. Please reopen the list.', 'error');
    return false;
  }

  const payload = { name, category, note, photo: _clothesTempPhoto, costUSD, priceLYD, variants };

  if (editTarget) {
    updateRecord(state.clothesProducts, editTarget.id, payload);
    showNotification(isAr ? 'تم الحفظ' : 'Saved', isAr ? 'تم تحديث المنتج بنجاح.' : 'Product updated successfully.', 'success');
  } else {
    addRecord(state.clothesProducts, { ...payload, createdAt: new Date().toISOString() });
    showNotification(isAr ? 'تمت الإضافة' : 'Added', isAr ? 'تمت إضافة المنتج بنجاح.' : 'Product added successfully.', 'success');
  }
  return true;
}

// ------------------------------------------
// SHIPMENTS TAB — incoming goods from abroad
// ------------------------------------------
// Rules that keep stock honest:
// - Stock is added ONLY when a shipment's status becomes 'Received'
//   (stockApplied flag makes this happen exactly once).
// - Moving a Received shipment back to an earlier status removes the same
//   quantities again (mistake correction, fully reversible).
// - A Received shipment cannot be edited or deleted — move its status back
//   first. This prevents silent stock drift.

const CLOTHES_SHIPMENT_STATUSES = [
  { id: 'Ordered', label: 'Ordered', labelAr: 'مطلوبة', badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  { id: 'Shipped', label: 'Shipped', labelAr: 'مشحونة', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  { id: 'Arrived', label: 'Arrived', labelAr: 'وصلت', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { id: 'Received', label: 'Received', labelAr: 'استُلمت', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' }
];
const CLOTHES_SHIPMENTS_PAGE_SIZE = 30;

let _clothesShipmentSearch = '';
let _clothesShipmentStatusFilter = 'all';
let _clothesShipmentsShowLimit = CLOTHES_SHIPMENTS_PAGE_SIZE;
let _clothesShipmentsFilterFingerprint = '';

function getVisibleClothesShipments() {
  return _clothesScopeToOwner(state.clothesShipments);
}

function clothesShipmentStatusMeta(statusId) {
  return CLOTHES_SHIPMENT_STATUSES.find(s => s.id === statusId) || CLOTHES_SHIPMENT_STATUSES[0];
}

// Product name lookup that still works for deleted products (history display)
function clothesProductNameById(productId) {
  const p = (state.clothesProducts || []).find(x => x.id === productId);
  return p ? String(p.name || '') : (clothesIsAr() ? '(منتج محذوف)' : '(deleted product)');
}

function getClothesShipmentTotals(s) {
  const lines = Array.isArray(s?.lines) ? s.lines : [];
  let pieces = 0;
  let goodsUSD = 0;
  for (const line of lines) {
    const qty = Math.max(0, Math.floor(Number(line?.qty) || 0));
    pieces += qty;
    goodsUSD += qty * (Number(line?.unitCostUSD) || 0);
  }
  goodsUSD = Math.round(goodsUSD * 100) / 100;
  const shippingUSD = Math.round((Number(s?.shippingCostUSD) || 0) * 100) / 100;
  const totalUSD = Math.round((goodsUSD + shippingUSD) * 100) / 100;
  return { pieces, goodsUSD, shippingUSD, totalUSD };
}

// Add (sign=+1) or remove (sign=-1) a shipment's quantities in product stock.
// One updateRecord per product so every change syncs like any other edit.
function applyClothesShipmentStockDelta(shipment, sign) {
  const lines = Array.isArray(shipment?.lines) ? shipment.lines : [];
  const byProduct = new Map();
  for (const line of lines) {
    const pid = String(line?.productId || '');
    if (!pid) continue;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(line);
  }
  for (const [pid, productLines] of byProduct) {
    const product = getVisibleClothesProducts().find(p => p.id === pid);
    if (!product) continue; // product deleted — nothing to update
    const variants = (Array.isArray(product.variants) ? product.variants : []).map(v => ({ ...v }));
    for (const line of productLines) {
      const qty = Math.max(0, Math.floor(Number(line?.qty) || 0));
      if (qty === 0) continue;
      const color = String(line?.color || '').trim();
      const size = String(line?.size || '').trim();
      const match = variants.find(v =>
        String(v?.color || '').trim().toLowerCase() === color.toLowerCase() &&
        String(v?.size || '').trim().toLowerCase() === size.toLowerCase()
      );
      if (match) {
        match.qty = Math.max(0, Math.floor(Number(match.qty) || 0) + sign * qty);
      } else if (sign > 0) {
        variants.push({ color, size, qty });
      }
    }
    updateRecord(state.clothesProducts, pid, { variants });
  }
}

// Which of a shipment's lines can NOT be fully removed from stock because the
// pieces were already sold (current variant stock < the shipment's quantity).
// Aggregates per product+variant so multiple lines don't mis-report.
function _clothesShipmentUnreceiveShortfall(shipment) {
  const need = new Map(); // pid||color||size -> {productId, color, size, qty}
  (Array.isArray(shipment?.lines) ? shipment.lines : []).forEach(line => {
    const color = String(line?.color || '').trim();
    const size = String(line?.size || '').trim();
    const key = `${line?.productId || ''}||${color.toLowerCase()}||${size.toLowerCase()}`;
    const prev = need.get(key) || { productId: line?.productId || '', color, size, qty: 0 };
    prev.qty += Math.max(0, Math.floor(Number(line?.qty) || 0));
    need.set(key, prev);
  });
  const out = [];
  for (const { productId, color, size, qty } of need.values()) {
    if (qty === 0) continue;
    const product = (state.clothesProducts || []).find(p => p && p.id === productId);
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const match = variants.find(v =>
      String(v?.color || '').trim().toLowerCase() === color.toLowerCase() &&
      String(v?.size || '').trim().toLowerCase() === size.toLowerCase()
    );
    const available = match ? Math.max(0, Math.floor(Number(match.qty) || 0)) : 0;
    if (available < qty) {
      const variant = [color, size].filter(Boolean).join('/');
      const name = product ? String(product.name || '') : clothesProductNameById(productId);
      out.push(`${name}${variant ? ' ' + variant : ''}: ${clothesIsAr() ? 'المتوفر' : 'in stock'} ${available}, ${clothesIsAr() ? 'يلزم إرجاع' : 'need to remove'} ${qty}`);
    }
  }
  return out;
}

function setClothesShipmentStatus(shipmentId, newStatus) {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  if (!CLOTHES_SHIPMENT_STATUSES.some(s => s.id === newStatus)) return;
  const shipment = getVisibleClothesShipments().find(s => s.id === shipmentId);
  if (!shipment || shipment.status === newStatus) return;

  const updates = { status: newStatus };
  if (newStatus === 'Received' && !shipment.stockApplied) {
    const ok = confirm(isAr
      ? 'تأكيد استلام الشحنة؟ سيتم إضافة الكميات إلى المخزون.'
      : 'Confirm receiving this shipment? Quantities will be ADDED to stock.');
    if (!ok) { updateClothesShipmentsFiltered(); return; }
    applyClothesShipmentStockDelta(shipment, 1);
    updates.stockApplied = true;
    updates.receivedAt = new Date().toISOString();
  } else if (shipment.status === 'Received' && newStatus !== 'Received' && shipment.stockApplied) {
    // Un-receiving removes this shipment's pieces from stock. If some of those
    // pieces were already SOLD, the removal would floor at zero and silently
    // under-remove — and a later order cancel would then restore full
    // quantities, inventing phantom stock. Block it: the sale must be reversed
    // first so the pieces are physically back before the shipment is undone.
    const short = _clothesShipmentUnreceiveShortfall(shipment);
    if (short.length) {
      showNotification(
        isAr ? 'غير ممكن' : 'Not allowed',
        (isAr
          ? 'لا يمكن إرجاع هذه الشحنة لأن بعض قطعها بيعت بالفعل. ألغِ/أرجِع الطلبات التي باعتها أولاً:\n\n'
          : 'Cannot un-receive: some of its pieces are already sold. Cancel/return the orders that sold them first:\n\n') + short.join('\n'),
        'error'
      );
      updateClothesShipmentsFiltered();
      return;
    }
    const ok = confirm(isAr
      ? 'إرجاع الشحنة إلى حالة سابقة؟ سيتم خصم كمياتها من المخزون مرة أخرى.'
      : 'Move this shipment back? Its quantities will be REMOVED from stock again.');
    if (!ok) { updateClothesShipmentsFiltered(); return; }
    applyClothesShipmentStockDelta(shipment, -1);
    updates.stockApplied = false;
    updates.receivedAt = null;
  }

  updateRecord(state.clothesShipments, shipmentId, updates);
  const meta = clothesShipmentStatusMeta(newStatus);
  showNotification(
    isAr ? 'تم التحديث' : 'Updated',
    isAr ? `حالة الشحنة الآن: ${meta.labelAr}` : `Shipment status is now: ${meta.label}`,
    'success'
  );
  updateClothesShipmentsFiltered();
}

function deleteClothesShipment(id) {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  const shipment = getVisibleClothesShipments().find(s => s.id === id);
  if (!shipment) return;
  if (shipment.status === 'Received') {
    showNotification(
      isAr ? 'غير ممكن' : 'Not allowed',
      isAr ? 'لا يمكن حذف شحنة مستلمة — أرجع حالتها أولاً حتى يُخصم مخزونها.' : 'Cannot delete a Received shipment — move its status back first so its stock is removed.',
      'error'
    );
    return;
  }
  const ok = confirm(isAr ? 'هل تريد حذف هذه الشحنة؟' : 'Delete this shipment?');
  if (!ok) return;
  deleteRecord(state.clothesShipments, id);
  showNotification(isAr ? 'تم الحذف' : 'Deleted', isAr ? 'تم حذف الشحنة.' : 'Shipment deleted.', 'success');
  updateClothesShipmentsFiltered();
}

function loadMoreClothesShipments() {
  _clothesShipmentsShowLimit += CLOTHES_SHIPMENTS_PAGE_SIZE;
  updateClothesShipmentsFiltered();
}

function onClothesShipmentSearchInput(el) {
  _clothesShipmentSearch = Security.sanitizeInput(String(el?.value || ''), { maxLength: 200 });
  if (window._clothesShipmentSearchTimer) clearTimeout(window._clothesShipmentSearchTimer);
  window._clothesShipmentSearchTimer = setTimeout(() => updateClothesShipmentsFiltered(), 80);
}

function setClothesShipmentStatusFilter(value) {
  _clothesShipmentStatusFilter = String(value || 'all');
  updateClothesShipmentsFiltered();
}

function getFilteredClothesShipments() {
  const q = _clothesShipmentSearch.trim().toLowerCase();
  let items = getVisibleClothesShipments();
  if (_clothesShipmentStatusFilter !== 'all') {
    items = items.filter(s => s.status === _clothesShipmentStatusFilter);
  }
  if (q) {
    items = items.filter(s => {
      if (String(s.ref || '').toLowerCase().includes(q)) return true;
      if (String(s.supplier || '').toLowerCase().includes(q)) return true;
      const lines = Array.isArray(s.lines) ? s.lines : [];
      return lines.some(line => clothesProductNameById(line.productId).toLowerCase().includes(q));
    });
  }
  return items;
}

function updateClothesShipmentsFiltered() {
  const container = document.querySelector('main');
  if (!container || state.currentView !== 'clothes-system' || _clothesActiveTab !== 'shipments') {
    render();
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = renderClothesShipmentsTab();
  const newStats = template.content.querySelector('#clothes-shipments-stats');
  const newGrid = template.content.querySelector('#clothes-shipments-grid');
  const curStats = document.getElementById('clothes-shipments-stats');
  const curGrid = document.getElementById('clothes-shipments-grid');
  if (newStats && curStats) curStats.innerHTML = newStats.innerHTML;
  if (newGrid && curGrid) curGrid.innerHTML = newGrid.innerHTML;
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(container);
  else lucide.createIcons();
}

function renderClothesShipmentsTab() {
  const isAr = clothesIsAr();
  const all = getVisibleClothesShipments();
  const filtered = getFilteredClothesShipments();

  const fingerprint = JSON.stringify([_clothesShipmentSearch, _clothesShipmentStatusFilter]);
  if (fingerprint !== _clothesShipmentsFilterFingerprint) {
    _clothesShipmentsFilterFingerprint = fingerprint;
    _clothesShipmentsShowLimit = CLOTHES_SHIPMENTS_PAGE_SIZE;
  }
  const shown = filtered.slice(0, _clothesShipmentsShowLimit);
  const remaining = Math.max(0, filtered.length - shown.length);

  // Stats: money still on the way vs already received
  let inTransitCount = 0, inTransitUSD = 0, receivedCount = 0, receivedUSD = 0;
  for (const s of all) {
    const t = getClothesShipmentTotals(s);
    if (s.status === 'Received') { receivedCount++; receivedUSD += t.totalUSD; }
    else { inTransitCount++; inTransitUSD += t.totalUSD; }
  }
  inTransitUSD = Math.round(inTransitUSD * 100) / 100;
  receivedUSD = Math.round(receivedUSD * 100) / 100;

  const statCard = (icon, label, value, gradient) => `
    <div class="glass-panel rounded-2xl p-4 flex items-center gap-3">
      <div class="w-11 h-11 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shadow-lg shrink-0">
        <i data-lucide="${icon}" class="w-5 h-5 text-white"></i>
      </div>
      <div class="min-w-0">
        <div class="text-xs text-slate-500 dark:text-slate-400">${label}</div>
        <div class="text-lg font-bold text-slate-800 dark:text-white truncate">${value}</div>
      </div>
    </div>
  `;

  return `
    <div>
      <div id="clothes-shipments-stats" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${statCard('plane', isAr ? 'في الطريق' : 'On the way', String(inTransitCount), 'from-blue-500 to-cyan-500')}
        ${statCard('banknote', isAr ? 'قيمة ما في الطريق' : 'Value on the way', clothesFmtUSD(inTransitUSD), 'from-amber-400 to-orange-500')}
        ${statCard('package-check', isAr ? 'شحنات مستلمة' : 'Received shipments', String(receivedCount), 'from-emerald-500 to-green-500')}
        ${statCard('boxes', isAr ? 'قيمة المستلم' : 'Received value', clothesFmtUSD(receivedUSD), 'from-rose-500 to-pink-500')}
      </div>

      <div class="flex flex-col sm:flex-row gap-3 mb-6">
        <div class="relative flex-1">
          <i data-lucide="search" class="w-4 h-4 absolute top-1/2 -translate-y-1/2 ${isAr ? 'right-4' : 'left-4'} text-slate-400"></i>
          <input
            type="text"
            id="clothes-shipment-search"
            value="${Security.escapeHtml(_clothesShipmentSearch)}"
            oninput="onClothesShipmentSearchInput(this)"
            placeholder="${isAr ? 'ابحث بالمرجع أو المورد أو المنتج...' : 'Search by reference, supplier or product...'}"
            class="w-full glass-input ${isAr ? 'pr-11 pl-4' : 'pl-11 pr-4'} py-2.5 rounded-xl"
          />
        </div>
        <select onchange="setClothesShipmentStatusFilter(this.value)" class="glass-input px-4 py-2.5 rounded-xl">
          <option value="all" ${_clothesShipmentStatusFilter === 'all' ? 'selected' : ''}>${isAr ? 'كل الحالات' : 'All statuses'}</option>
          ${CLOTHES_SHIPMENT_STATUSES.map(s => `<option value="${s.id}" ${_clothesShipmentStatusFilter === s.id ? 'selected' : ''}>${isAr ? s.labelAr : s.label}</option>`).join('')}
        </select>
        <button onclick="exportClothesShipmentsCSV()" class="glass-panel px-3 py-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:text-rose-600 flex items-center justify-center" title="${isAr ? 'تصدير CSV (إكسل)' : 'Export CSV (Excel)'}">
          <i data-lucide="download" class="w-4 h-4"></i>
        </button>
        <button onclick="showClothesShipmentModal()" class="btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-5 py-2.5 rounded-xl font-bold shadow-lg hover:shadow-xl flex items-center justify-center gap-2">
          <i data-lucide="plus" class="w-4 h-4"></i>
          ${isAr ? 'إضافة شحنة' : 'Add Shipment'}
        </button>
      </div>

      <div id="clothes-shipments-grid">
        ${shown.length === 0 ? `
          <div class="glass-panel rounded-2xl p-12 text-center">
            <div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center mb-4 shadow-xl opacity-80">
              <i data-lucide="plane" class="w-8 h-8 text-white"></i>
            </div>
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-1">
              ${all.length === 0 ? (isAr ? 'لا توجد شحنات بعد' : 'No shipments yet') : (isAr ? 'لا توجد نتائج' : 'No results')}
            </h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${all.length === 0
                ? (isAr ? 'أضف شحنة عندما تشتري بضاعة من الخارج.' : 'Add a shipment when you buy goods from abroad.')
                : (isAr ? 'جرّب بحثاً أو فلتراً آخر.' : 'Try a different search or filter.')}
            </p>
          </div>
        ` : `
          <div class="text-sm text-slate-500 dark:text-slate-400 mb-3">
            ${isAr ? `عرض ${shown.length} من ${filtered.length} شحنة` : `Showing ${shown.length} of ${filtered.length} shipments`}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${shown.map(s => renderClothesShipmentCard(s)).join('')}
          </div>
          ${remaining > 0 ? `
            <div class="text-center mt-6">
              <button onclick="loadMoreClothesShipments()" class="glass-panel px-6 py-2.5 rounded-xl font-medium text-slate-600 dark:text-slate-300 hover:text-rose-600">
                ${isAr ? `عرض المزيد (${remaining} متبقي)` : `Load more (${remaining} remaining)`}
              </button>
            </div>
          ` : ''}
        `}
      </div>
    </div>
  `;
}

function renderClothesShipmentCard(s) {
  const isAr = clothesIsAr();
  const meta = clothesShipmentStatusMeta(s.status);
  const totals = getClothesShipmentTotals(s);
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const isReceived = s.status === 'Received';

  const lineSummary = lines.slice(0, 3).map(line => {
    const bits = [clothesProductNameById(line.productId)];
    const variant = [line.color, line.size].map(x => String(x || '').trim()).filter(Boolean).join('/');
    if (variant) bits.push(variant);
    return `${Security.escapeHtml(bits.join(' '))} ×${Math.max(0, Math.floor(Number(line.qty) || 0))}`;
  }).join(isAr ? '، ' : ', ') + (lines.length > 3 ? (isAr ? ` +${lines.length - 3} أخرى` : ` +${lines.length - 3} more`) : '');

  return `
    <div class="glass-panel rounded-2xl p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h4 class="font-bold text-slate-800 dark:text-white truncate">
            ${Security.escapeHtml(s.ref || (isAr ? 'شحنة' : 'Shipment'))}
          </h4>
          ${s.supplier ? `<p class="text-sm text-slate-500 dark:text-slate-400 truncate">${Security.escapeHtml(s.supplier)}</p>` : ''}
        </div>
        <span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${meta.badge}">
          ${isAr ? meta.labelAr : meta.label}
        </span>
      </div>

      <div class="mt-3 space-y-1.5 text-sm">
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'تاريخ الطلب' : 'Ordered'}</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">${Security.escapeHtml(s.orderedAt || '—')}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'القطع' : 'Pieces'}</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">${totals.pieces}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'البضاعة + الشحن' : 'Goods + shipping'}</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">${clothesFmtUSD(totals.goodsUSD)} + ${clothesFmtUSD(totals.shippingUSD)}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'الإجمالي' : 'Total'}</span>
          <span class="font-bold text-rose-600 dark:text-rose-400">${clothesFmtUSD(totals.totalUSD)}</span>
        </div>
        ${s.receivedAt ? `
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'تاريخ الاستلام' : 'Received at'}</span>
          <span class="font-medium text-emerald-600 dark:text-emerald-400">${Security.escapeHtml(String(s.receivedAt).split('T')[0])}</span>
        </div>` : ''}
      </div>

      ${lines.length ? `<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">${lineSummary}</p>` : ''}
      ${s.note ? `<p class="mt-2 text-xs text-slate-400 dark:text-slate-500 line-clamp-2">${Security.escapeHtml(s.note)}</p>` : ''}

      <div class="flex items-center gap-2 mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
        <select onchange="setClothesShipmentStatus('${s.id}', this.value)" class="glass-input px-2 py-1.5 rounded-lg text-sm flex-1" title="${isAr ? 'تغيير الحالة' : 'Change status'}">
          ${CLOTHES_SHIPMENT_STATUSES.map(st => `<option value="${st.id}" ${s.status === st.id ? 'selected' : ''}>${isAr ? st.labelAr : st.label}</option>`).join('')}
        </select>
        ${isReceived ? `
          <span class="text-xs text-slate-400 dark:text-slate-500 px-2" title="${isAr ? 'أرجع الحالة أولاً للتعديل أو الحذف' : 'Move status back to edit or delete'}">
            <i data-lucide="lock" class="w-4 h-4"></i>
          </span>
        ` : `
          <button onclick="editClothesShipment('${s.id}')" class="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" title="${isAr ? 'تعديل' : 'Edit'}">
            <i data-lucide="pencil" class="w-4 h-4"></i>
          </button>
          <button onclick="deleteClothesShipment('${s.id}')" class="p-2 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" title="${isAr ? 'حذف' : 'Delete'}">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        `}
      </div>
    </div>
  `;
}

// ------------------------------------------
// SHIPMENT MODAL (add / edit)
// ------------------------------------------

// Variant helpers shared by shipment + order line editors.
// "Pick, don't type": color/size come from a dropdown fed by the chosen
// product, so a typo can never send stock to the wrong place.
function clothesVariantOptionLabel(v, withStock) {
  const isAr = clothesIsAr();
  const label = [v?.color, v?.size].map(x => String(x || '').trim()).filter(Boolean).join(' · ') || (isAr ? 'بدون تحديد' : 'unspecified');
  if (!withStock) return label;
  const qty = Math.max(0, Math.floor(Number(v?.qty) || 0));
  return `${label} (${qty} ${isAr ? 'متبقي' : 'left'})`;
}

function findClothesVariantIndex(product, color, size) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const c = String(color || '').trim().toLowerCase();
  const s = String(size || '').trim().toLowerCase();
  return variants.findIndex(v =>
    String(v?.color || '').trim().toLowerCase() === c &&
    String(v?.size || '').trim().toLowerCase() === s
  );
}

let _clothesTempShipLines = [];

function showClothesShipmentModal() {
  if (!clothesCanUse()) return;
  state.activeModal = 'clothes-shipment';
  state.modalData = null;
  _clothesTempShipLines = [{ productId: '', color: '', size: '', qty: 0, unitCostUSD: '' }];
  updateUrlParams({ modal: 'clothes-shipment', id: 'new' }); // URL tracking
  renderModal();
}

function editClothesShipment(id) {
  if (!clothesCanUse()) return;
  const shipment = getVisibleClothesShipments().find(s => s.id === id);
  if (!shipment) return;
  if (shipment.status === 'Received') {
    showNotification(
      clothesIsAr() ? 'غير ممكن' : 'Not allowed',
      clothesIsAr() ? 'لا يمكن تعديل شحنة مستلمة — أرجع حالتها أولاً.' : 'Cannot edit a Received shipment — move its status back first.',
      'error'
    );
    return;
  }
  state.activeModal = 'clothes-shipment';
  state.modalData = shipment;
  updateUrlParams({ modal: 'clothes-shipment', id }); // URL tracking
  const lines = Array.isArray(shipment.lines) ? shipment.lines : [];
  _clothesTempShipLines = lines.length
    ? lines.map(l => ({
        productId: String(l?.productId || ''),
        color: String(l?.color || ''),
        size: String(l?.size || ''),
        qty: Math.max(0, Math.floor(Number(l?.qty) || 0)),
        unitCostUSD: String(l?.unitCostUSD ?? '')
      }))
    : [{ productId: '', color: '', size: '', qty: 0, unitCostUSD: '' }];
  renderModal();
}

function renderClothesShipmentModal() {
  const isAr = clothesIsAr();
  const data = state.modalData || {};
  const isEdit = state.modalData !== null;

  return `
    <h2 class="text-2xl font-bold mb-4 flex items-center gap-2">
      <i data-lucide="plane" class="w-6 h-6 text-rose-500"></i>
      ${isEdit ? (isAr ? 'تعديل شحنة' : 'Edit Shipment') : (isAr ? 'إضافة شحنة' : 'Add Shipment')}
    </h2>
    <form id="modal-form" class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar ${isAr ? 'pl-2' : 'pr-2'}">
      <input type="hidden" id="clothes-shipment-editing-id" value="${Security.escapeHtml(String(isEdit ? (data.id || '') : ''))}" />

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'مرجع الشحنة' : 'Reference'}</label>
          <input type="text" id="clothes-shipment-ref" value="${Security.escapeHtml(data.ref || '')}" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'مثال: شحنة تركيا يوليو' : 'e.g. Turkey July batch'}" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'المورد / البلد' : 'Supplier / country'}</label>
          <input type="text" id="clothes-shipment-supplier" value="${Security.escapeHtml(data.supplier || '')}" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'مثال: مورد إسطنبول' : 'e.g. Istanbul supplier'}" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'تاريخ الطلب' : 'Order date'}</label>
          <input type="date" id="clothes-shipment-date" value="${Security.escapeHtml(data.orderedAt || getTodayDateString())}" class="w-full glass-input px-4 py-2 rounded-xl" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'تكلفة الشحن (دولار)' : 'Shipping cost (USD)'}</label>
          <input type="text" inputmode="decimal" id="clothes-shipment-shipping" value="${Security.escapeHtml(String(data.shippingCostUSD ?? ''))}" oninput="sanitizeMoneyInput(this)" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="0.00" />
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'محتويات الشحنة *' : 'Shipment contents *'}</label>
        <div id="clothes-ship-lines" class="space-y-2"></div>
        <button type="button" onclick="addClothesShipLine()" class="mt-2 flex items-center gap-1.5 text-sm font-medium text-rose-600 hover:text-rose-700">
          <i data-lucide="plus" class="w-4 h-4"></i>${isAr ? 'إضافة صنف' : 'Add item'}
        </button>
        <p class="mt-1 text-xs text-slate-400 dark:text-slate-500">
          ${isAr ? 'أضف المنتج أولاً في تبويب البضاعة إن لم يكن موجوداً.' : 'If a product is missing, add it first in the Products tab.'}
        </p>
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'ملاحظة' : 'Note'}</label>
        <textarea id="clothes-shipment-note" rows="2" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'اختياري' : 'Optional'}">${Security.escapeHtml(data.note || '')}</textarea>
      </div>

      <div class="flex gap-3 pt-2">
        <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg">
          ${isEdit ? (isAr ? 'حفظ التعديلات' : 'Save Changes') : (isAr ? 'إضافة الشحنة' : 'Add Shipment')}
        </button>
        <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600">
          ${isAr ? 'إلغاء' : 'Cancel'}
        </button>
      </div>
    </form>
  `;
}

function refreshClothesShipLines() {
  const isAr = clothesIsAr();
  const wrap = document.getElementById('clothes-ship-lines');
  if (!wrap) return;
  const products = getVisibleClothesProducts();
  // Inline grid template: width utility classes proved unreliable inside the
  // modal in narrow webviews (see refreshClothesVariantRows), so the column
  // sizes are pinned inline. Two rows per line so it stays usable on phones:
  // row 1 = product + remove, row 2 = variant picker / qty / unit cost
  // (+ a color/size text row only when "new color/size" is chosen).
  const rowStyle = 'display:grid;grid-template-columns:minmax(0,1fr) 2rem;gap:0.5rem;align-items:center;';
  const subStyle = 'grid-column:1 / -1;display:grid;grid-template-columns:minmax(0,1fr) 4rem 5rem;gap:0.5rem;align-items:center;';
  const newStyle = 'grid-column:1 / -1;display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;align-items:center;';
  const cellStyle = 'width:100%;min-width:0;';
  wrap.innerHTML = _clothesTempShipLines.map((line, idx) => {
    const product = products.find(p => p.id === line.productId);
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const matchIdx = product ? findClothesVariantIndex(product, line.color, line.size) : -1;
    // "new" mode stays sticky while the user is typing a brand-new color/size
    const isNew = line._newVariant === true || (matchIdx === -1 && !!(String(line.color || '').trim() || String(line.size || '').trim()));
    const selectVal = (matchIdx >= 0 && !line._newVariant) ? `v:${matchIdx}` : (isNew ? 'new' : '');
    return `
    <div style="${rowStyle}" class="pb-2 border-b border-slate-100 dark:border-slate-800">
      <select oninput="onClothesShipLineField(${idx}, 'productId', this.value)" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm">
        <option value="">${isAr ? '— اختر المنتج —' : '— choose product —'}</option>
        ${products.map(p => `<option value="${p.id}" ${line.productId === p.id ? 'selected' : ''}>${Security.escapeHtml(p.name || '')}</option>`).join('')}
      </select>
      <button type="button" onclick="removeClothesShipLine(${idx})" class="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="${isAr ? 'إزالة' : 'Remove'}">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
      <div style="${subStyle}">
        <select oninput="onClothesShipLineVariantPick(${idx}, this.value)" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" ${product ? '' : 'disabled'} title="${isAr ? 'اللون والمقاس' : 'Color & size'}">
          <option value="" ${selectVal === '' ? 'selected' : ''}>${product ? (isAr ? '— اللون والمقاس —' : '— color & size —') : (isAr ? 'اختر المنتج أولاً' : 'choose product first')}</option>
          ${variants.map((v, vi) => `<option value="v:${vi}" ${selectVal === `v:${vi}` ? 'selected' : ''}>${Security.escapeHtml(clothesVariantOptionLabel(v, false))}</option>`).join('')}
          ${product ? `<option value="new" ${selectVal === 'new' ? 'selected' : ''}>${isAr ? '+ لون/مقاس جديد' : '+ new color/size'}</option>` : ''}
        </select>
        <input type="number" min="0" step="1" value="${Math.max(0, Math.floor(Number(line.qty) || 0))}" oninput="onClothesShipLineField(${idx}, 'qty', this.value)" placeholder="${isAr ? 'كمية' : 'Qty'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'الكمية' : 'Quantity'}" />
        <input type="text" inputmode="decimal" value="${Security.escapeHtml(String(line.unitCostUSD ?? ''))}" oninput="sanitizeMoneyInput(this); onClothesShipLineField(${idx}, 'unitCostUSD', this.value)" placeholder="$/1" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'تكلفة القطعة بالدولار' : 'Unit cost USD'}" />
      </div>
      ${isNew ? `
      <div style="${newStyle}">
        <input type="text" value="${Security.escapeHtml(String(line.color || ''))}" oninput="onClothesShipLineField(${idx}, 'color', this.value)" placeholder="${isAr ? 'اللون الجديد' : 'New color'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" />
        <input type="text" value="${Security.escapeHtml(String(line.size || ''))}" oninput="onClothesShipLineField(${idx}, 'size', this.value)" placeholder="${isAr ? 'المقاس الجديد' : 'New size'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" />
      </div>` : ''}
    </div>
  `;
  }).join('');
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap);
}

function onClothesShipLineVariantPick(idx, value) {
  const line = _clothesTempShipLines[idx];
  if (!line) return;
  const product = getVisibleClothesProducts().find(p => p.id === line.productId);
  if (String(value).startsWith('v:')) {
    const v = (product?.variants || [])[Number(String(value).slice(2))];
    if (v) {
      line.color = String(v.color || '');
      line.size = String(v.size || '');
      line._newVariant = false;
    }
  } else if (value === 'new') {
    line.color = '';
    line.size = '';
    line._newVariant = true;
  } else {
    line.color = '';
    line.size = '';
    line._newVariant = false;
  }
  refreshClothesShipLines();
}

function onClothesShipLineField(idx, field, value) {
  const line = _clothesTempShipLines[idx];
  if (!line) return;
  if (field === 'qty') {
    line.qty = Math.max(0, Math.floor(Number(value) || 0));
  } else if (field === 'unitCostUSD') {
    line.unitCostUSD = String(value || '');
  } else if (field === 'productId') {
    line.productId = String(value || '');
    // New product = new variant list: reset the picked color/size
    line.color = '';
    line.size = '';
    line._newVariant = false;
    // Convenience: prefill unit cost from the product's cost price when empty
    if (!String(line.unitCostUSD || '').trim()) {
      const p = getVisibleClothesProducts().find(x => x.id === line.productId);
      if (p && Number(p.costUSD) > 0) line.unitCostUSD = String(p.costUSD);
    }
    refreshClothesShipLines();
  } else if (field === 'color' || field === 'size') {
    line[field] = Security.sanitizeInput(String(value || ''), { maxLength: 60 });
  }
}

function addClothesShipLine() {
  _clothesTempShipLines.push({ productId: '', color: '', size: '', qty: 0, unitCostUSD: '' });
  refreshClothesShipLines();
}

function removeClothesShipLine(idx) {
  _clothesTempShipLines.splice(idx, 1);
  if (_clothesTempShipLines.length === 0) _clothesTempShipLines.push({ productId: '', color: '', size: '', qty: 0, unitCostUSD: '' });
  refreshClothesShipLines();
}

// Called by handleModalSubmit for state.activeModal === 'clothes-shipment'.
async function saveClothesShipmentFromModal() {
  if (!clothesCanUse()) return false;
  const isAr = clothesIsAr();

  const ref = Security.sanitizeInput(String(document.getElementById('clothes-shipment-ref')?.value || ''), { maxLength: 120 }).trim();
  const supplier = Security.sanitizeInput(String(document.getElementById('clothes-shipment-supplier')?.value || ''), { maxLength: 120 }).trim();
  const orderedAt = String(document.getElementById('clothes-shipment-date')?.value || '').trim();
  const shippingCostUSD = clothesParseMoney(document.getElementById('clothes-shipment-shipping')?.value);
  const note = Security.sanitizeInput(String(document.getElementById('clothes-shipment-note')?.value || ''), { maxLength: 500 }).trim();

  // Valid lines: a chosen product and a positive quantity
  const lines = [];
  for (const l of _clothesTempShipLines) {
    const productId = String(l?.productId || '').trim();
    const qty = Math.max(0, Math.floor(Number(l?.qty) || 0));
    if (!productId || qty === 0) continue;
    lines.push({
      productId,
      color: String(l?.color || '').trim(),
      size: String(l?.size || '').trim(),
      qty,
      unitCostUSD: clothesParseMoney(l?.unitCostUSD)
    });
  }
  if (lines.length === 0) {
    showNotification(
      isAr ? 'تنبيه' : 'Validation',
      isAr ? 'أضف صنفاً واحداً على الأقل (منتج + كمية).' : 'Add at least one item (product + quantity).',
      'error'
    );
    return false;
  }

  const editingId = String(document.getElementById('clothes-shipment-editing-id')?.value || '').trim();
  const editTarget = editingId ? getVisibleClothesShipments().find(s => s.id === editingId) : null;
  if (editingId && !editTarget) {
    showNotification(isAr ? 'تعذّر الحفظ' : 'Cannot save', isAr ? 'تم حذف هذه الشحنة. أعد فتح القائمة.' : 'This shipment was deleted. Please reopen the list.', 'error');
    return false;
  }
  if (editTarget && editTarget.status === 'Received') {
    showNotification(isAr ? 'غير ممكن' : 'Not allowed', isAr ? 'لا يمكن تعديل شحنة مستلمة.' : 'Cannot edit a Received shipment.', 'error');
    return false;
  }

  const payload = { ref, supplier, orderedAt, shippingCostUSD, note, lines };

  if (editTarget) {
    updateRecord(state.clothesShipments, editTarget.id, payload);
    showNotification(isAr ? 'تم الحفظ' : 'Saved', isAr ? 'تم تحديث الشحنة.' : 'Shipment updated.', 'success');
  } else {
    addRecord(state.clothesShipments, {
      ...payload,
      status: 'Ordered',
      stockApplied: false,
      receivedAt: null,
      createdAt: new Date().toISOString()
    });
    showNotification(isAr ? 'تمت الإضافة' : 'Added', isAr ? 'تمت إضافة الشحنة.' : 'Shipment added.', 'success');
  }
  return true;
}

// ------------------------------------------
// ORDERS TAB — outgoing customer orders
// ------------------------------------------
// Rules that keep stock honest (mirror of shipments, in reverse):
// - Creating an order takes its pieces OUT of stock immediately
//   (stockDeducted flag makes this happen exactly once).
// - 'Returned' / 'Canceled' puts the pieces BACK; moving the order back to an
//   active status takes them out again (fully reversible).
// - Editing an order's lines restores the old pieces first, then deducts the
//   new ones — stock never drifts.
// - Returned/Canceled orders cannot be edited (re-activate first).

const CLOTHES_ORDER_STATUSES = [
  { id: 'New', label: 'New', labelAr: 'جديد', active: true, badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  { id: 'On the way', label: 'On the way', labelAr: 'في الطريق', active: true, badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  { id: 'Delivered', label: 'Delivered', labelAr: 'تم التسليم', active: true, badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  { id: 'Returned', label: 'Returned', labelAr: 'مرتجع', active: false, badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { id: 'Canceled', label: 'Canceled', labelAr: 'ملغى', active: false, badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' }
];

const CLOTHES_PAYMENT_STATUSES = [
  { id: 'Not Paid', label: 'Not Paid', labelAr: 'غير مدفوع', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  { id: 'Partially Paid', label: 'Partially Paid', labelAr: 'مدفوع جزئياً', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { id: 'Paid', label: 'Paid', labelAr: 'مدفوع', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' }
];

const CLOTHES_ORDERS_PAGE_SIZE = 30;

let _clothesOrderSearch = '';
let _clothesOrderStatusFilter = 'all';
let _clothesOrderPaymentFilter = 'all';
let _clothesOrdersShowLimit = CLOTHES_ORDERS_PAGE_SIZE;
let _clothesOrdersFilterFingerprint = '';

function getVisibleClothesOrders() {
  return _clothesScopeToOwner(state.clothesOrders);
}

function clothesOrderStatusMeta(statusId) {
  return CLOTHES_ORDER_STATUSES.find(s => s.id === statusId) || CLOTHES_ORDER_STATUSES[0];
}

function clothesPaymentStatusMeta(statusId) {
  return CLOTHES_PAYMENT_STATUSES.find(s => s.id === statusId) || CLOTHES_PAYMENT_STATUSES[0];
}

function clothesOrderIsActiveStatus(statusId) {
  return clothesOrderStatusMeta(statusId).active === true;
}

function getClothesOrderTotals(o) {
  const lines = Array.isArray(o?.lines) ? o.lines : [];
  let pieces = 0;
  let goodsLYD = 0;
  for (const line of lines) {
    const qty = Math.max(0, Math.floor(Number(line?.qty) || 0));
    pieces += qty;
    goodsLYD += qty * (Number(line?.priceLYD) || 0);
  }
  goodsLYD = Math.round(goodsLYD * 100) / 100;
  const feeLYD = Math.round((Number(o?.deliveryFeeLYD) || 0) * 100) / 100;
  const totalLYD = Math.round((goodsLYD + feeLYD) * 100) / 100;
  const paidLYD = Math.round((Number(o?.amountPaidLYD) || 0) * 100) / 100;
  const remainingLYD = Math.max(0, Math.round((totalLYD - paidLYD) * 100) / 100);
  return { pieces, goodsLYD, feeLYD, totalLYD, paidLYD, remainingLYD };
}

// Estimated profit of an order in LYD: goods revenue minus goods cost
// (cost is the USD snapshot taken at sale time, converted with the app's
// exchange rate). Delivery fee excluded — it usually covers the courier.
// Returns null when no exchange rate is set (never show wrong numbers).
function getClothesOrderProfitLYD(order) {
  const rate = getClothesExchangeRate();
  if (rate <= 0) return null;
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  let profit = 0;
  for (const line of lines) {
    const qty = Math.max(0, Math.floor(Number(line?.qty) || 0));
    const price = Number(line?.priceLYD) || 0;
    const costUSD = Number(line?.costUSDAtSale) || 0;
    profit += qty * (price - costUSD * rate);
  }
  return Math.round(profit * 100) / 100;
}

// Add (sign=+1, restore) or remove (sign=-1, sell) an order's pieces in stock.
function applyClothesOrderStockDelta(order, sign) {
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const byProduct = new Map();
  for (const line of lines) {
    const pid = String(line?.productId || '');
    if (!pid) continue;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(line);
  }
  for (const [pid, productLines] of byProduct) {
    const product = getVisibleClothesProducts().find(p => p.id === pid);
    if (!product) continue; // product deleted — nothing to update
    const variants = (Array.isArray(product.variants) ? product.variants : []).map(v => ({ ...v }));
    for (const line of productLines) {
      const qty = Math.max(0, Math.floor(Number(line?.qty) || 0));
      if (qty === 0) continue;
      const color = String(line?.color || '').trim();
      const size = String(line?.size || '').trim();
      const match = variants.find(v =>
        String(v?.color || '').trim().toLowerCase() === color.toLowerCase() &&
        String(v?.size || '').trim().toLowerCase() === size.toLowerCase()
      );
      if (sign < 0) {
        // Selling: the warehouse can only give what it actually has, so
        // remember the amount REALLY removed. Restoring later puts back only
        // that amount — an oversold order (stock floored at zero) can no
        // longer invent phantom pieces when it is canceled or deleted.
        const available = match ? Math.max(0, Math.floor(Number(match.qty) || 0)) : 0;
        const taken = Math.min(qty, available);
        if (match) match.qty = available - taken;
        line.deductedQty = taken;
      } else {
        // Restoring: put back what was really removed. Orders saved before
        // deductedQty existed restore the full quantity (old behavior).
        const back = Number.isFinite(Number(line?.deductedQty))
          ? Math.max(0, Math.floor(Number(line.deductedQty)))
          : qty;
        if (back === 0) continue;
        if (match) {
          match.qty = Math.max(0, Math.floor(Number(match.qty) || 0) + back);
        }
        // else: the variant was renamed/removed from the product AFTER this
        // sale. Do NOT recreate it — pushing it back resurrected the deleted
        // variant as phantom stock in the products grid. The merchant changed
        // the variant set on purpose, so the restored pieces are dropped.
      }
    }
    updateRecord(state.clothesProducts, pid, { variants });
  }
  // Persist the per-line deducted amounts when the order already lives in
  // state (new orders save their lines right after this call anyway).
  if (order && order.id && (state.clothesOrders || []).some(o => o && o.id === order.id)) {
    updateRecord(state.clothesOrders, order.id, { lines });
  }
}

function setClothesOrderStatus(orderId, newStatus) {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  if (!CLOTHES_ORDER_STATUSES.some(s => s.id === newStatus)) return;
  const order = getVisibleClothesOrders().find(o => o.id === orderId);
  if (!order || order.status === newStatus) return;

  const wasActive = clothesOrderIsActiveStatus(order.status);
  const willBeActive = clothesOrderIsActiveStatus(newStatus);
  const updates = { status: newStatus };

  if (wasActive && !willBeActive && order.stockDeducted) {
    const ok = confirm(isAr
      ? 'سيتم إرجاع قطع هذا الطلب إلى المخزون. متابعة؟'
      : 'This order\'s pieces will be RETURNED to stock. Continue?');
    if (!ok) { updateClothesOrdersFiltered(); return; }
    applyClothesOrderStockDelta(order, 1);
    updates.stockDeducted = false;
  } else if (!wasActive && willBeActive && !order.stockDeducted) {
    const ok = confirm(isAr
      ? 'سيتم خصم قطع هذا الطلب من المخزون مرة أخرى. متابعة؟'
      : 'This order\'s pieces will be TAKEN from stock again. Continue?');
    if (!ok) { updateClothesOrdersFiltered(); return; }
    applyClothesOrderStockDelta(order, -1);
    updates.stockDeducted = true;
  }

  if (newStatus === 'Delivered' && !order.deliveredAt) {
    updates.deliveredAt = new Date().toISOString();
  }

  updateRecord(state.clothesOrders, orderId, updates);
  const meta = clothesOrderStatusMeta(newStatus);
  showNotification(
    isAr ? 'تم التحديث' : 'Updated',
    isAr ? `حالة الطلب الآن: ${meta.labelAr}` : `Order status is now: ${meta.label}`,
    'success'
  );
  updateClothesOrdersFiltered();
}

function setClothesOrderPayment(orderId, newPaymentStatus) {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  if (!CLOTHES_PAYMENT_STATUSES.some(s => s.id === newPaymentStatus)) return;
  const order = getVisibleClothesOrders().find(o => o.id === orderId);
  if (!order || order.paymentStatus === newPaymentStatus) return;

  const totals = getClothesOrderTotals(order);
  const updates = { paymentStatus: newPaymentStatus };
  if (newPaymentStatus === 'Paid') {
    updates.amountPaidLYD = totals.totalLYD; // fully paid
    updates.paidAt = order.paidAt || new Date().toISOString();
  } else if (newPaymentStatus === 'Not Paid') {
    updates.amountPaidLYD = 0;
  }
  // 'Partially Paid' keeps the recorded amount — edit it in the order form.

  updateRecord(state.clothesOrders, orderId, updates);
  const meta = clothesPaymentStatusMeta(newPaymentStatus);
  showNotification(
    isAr ? 'تم التحديث' : 'Updated',
    isAr ? `حالة الدفع الآن: ${meta.labelAr}` : `Payment status is now: ${meta.label}`,
    'success'
  );
  updateClothesOrdersFiltered();
}

function deleteClothesOrder(id) {
  if (!clothesCanUse()) return;
  const isAr = clothesIsAr();
  const order = getVisibleClothesOrders().find(o => o.id === id);
  if (!order) return;
  const willRestore = order.stockDeducted === true;
  const ok = confirm(isAr
    ? (willRestore ? 'هل تريد حذف هذا الطلب؟ ستعود قطعه إلى المخزون.' : 'هل تريد حذف هذا الطلب؟')
    : (willRestore ? 'Delete this order? Its pieces will return to stock.' : 'Delete this order?'));
  if (!ok) return;
  if (willRestore) {
    applyClothesOrderStockDelta(order, 1);
    updateRecord(state.clothesOrders, id, { stockDeducted: false });
  }
  deleteRecord(state.clothesOrders, id);
  showNotification(isAr ? 'تم الحذف' : 'Deleted', isAr ? 'تم حذف الطلب.' : 'Order deleted.', 'success');
  updateClothesOrdersFiltered();
}

function loadMoreClothesOrders() {
  _clothesOrdersShowLimit += CLOTHES_ORDERS_PAGE_SIZE;
  updateClothesOrdersFiltered();
}

function onClothesOrderSearchInput(el) {
  _clothesOrderSearch = Security.sanitizeInput(String(el?.value || ''), { maxLength: 200 });
  if (window._clothesOrderSearchTimer) clearTimeout(window._clothesOrderSearchTimer);
  window._clothesOrderSearchTimer = setTimeout(() => updateClothesOrdersFiltered(), 80);
}

function setClothesOrderStatusFilter(value) {
  _clothesOrderStatusFilter = String(value || 'all');
  updateClothesOrdersFiltered();
}

function setClothesOrderPaymentFilter(value) {
  _clothesOrderPaymentFilter = String(value || 'all');
  updateClothesOrdersFiltered();
}

function getFilteredClothesOrders() {
  const q = _clothesOrderSearch.trim().toLowerCase();
  let items = getVisibleClothesOrders();
  if (_clothesOrderStatusFilter !== 'all') {
    items = items.filter(o => o.status === _clothesOrderStatusFilter);
  }
  if (_clothesOrderPaymentFilter !== 'all') {
    items = items.filter(o => o.paymentStatus === _clothesOrderPaymentFilter);
  }
  if (q) {
    items = items.filter(o => {
      if (String(o.customerName || '').toLowerCase().includes(q)) return true;
      if (String(o.customerPhone || '').toLowerCase().includes(q)) return true;
      const lines = Array.isArray(o.lines) ? o.lines : [];
      return lines.some(line => clothesProductNameById(line.productId).toLowerCase().includes(q));
    });
  }
  return items;
}

function updateClothesOrdersFiltered() {
  const container = document.querySelector('main');
  if (!container || state.currentView !== 'clothes-system' || _clothesActiveTab !== 'orders') {
    render();
    return;
  }
  const template = document.createElement('template');
  template.innerHTML = renderClothesOrdersTab();
  const newStats = template.content.querySelector('#clothes-orders-stats');
  const newGrid = template.content.querySelector('#clothes-orders-grid');
  const curStats = document.getElementById('clothes-orders-stats');
  const curGrid = document.getElementById('clothes-orders-grid');
  if (newStats && curStats) curStats.innerHTML = newStats.innerHTML;
  if (newGrid && curGrid) curGrid.innerHTML = newGrid.innerHTML;
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(container);
  else lucide.createIcons();
}

function renderClothesOrdersTab() {
  const isAr = clothesIsAr();
  const all = getVisibleClothesOrders();
  const filtered = getFilteredClothesOrders();

  const fingerprint = JSON.stringify([_clothesOrderSearch, _clothesOrderStatusFilter, _clothesOrderPaymentFilter]);
  if (fingerprint !== _clothesOrdersFilterFingerprint) {
    _clothesOrdersFilterFingerprint = fingerprint;
    _clothesOrdersShowLimit = CLOTHES_ORDERS_PAGE_SIZE;
  }
  const shown = filtered.slice(0, _clothesOrdersShowLimit);
  const remaining = Math.max(0, filtered.length - shown.length);

  // Stats: where the orders and the money stand
  let onTheWay = 0, deliveredCount = 0, collectedLYD = 0, owedLYD = 0;
  for (const o of all) {
    const t = getClothesOrderTotals(o);
    if (o.status === 'On the way') onTheWay++;
    if (o.status === 'Delivered') deliveredCount++;
    if (o.status !== 'Canceled' && o.status !== 'Returned') {
      collectedLYD += t.paidLYD;
      owedLYD += t.remainingLYD;
    }
  }
  collectedLYD = Math.round(collectedLYD * 100) / 100;
  owedLYD = Math.round(owedLYD * 100) / 100;

  const statCard = (icon, label, value, gradient) => `
    <div class="glass-panel rounded-2xl p-4 flex items-center gap-3">
      <div class="w-11 h-11 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center shadow-lg shrink-0">
        <i data-lucide="${icon}" class="w-5 h-5 text-white"></i>
      </div>
      <div class="min-w-0">
        <div class="text-xs text-slate-500 dark:text-slate-400">${label}</div>
        <div class="text-lg font-bold text-slate-800 dark:text-white truncate">${value}</div>
      </div>
    </div>
  `;

  return `
    <div>
      <div id="clothes-orders-stats" class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${statCard('truck', isAr ? 'في الطريق للزبون' : 'On the way', String(onTheWay), 'from-blue-500 to-cyan-500')}
        ${statCard('package-check', isAr ? 'طلبات مُسلّمة' : 'Delivered', String(deliveredCount), 'from-emerald-500 to-green-500')}
        ${statCard('banknote', isAr ? 'المال المحصَّل' : 'Money collected', clothesFmtLYD(collectedLYD), 'from-rose-500 to-pink-500')}
        ${statCard('alert-triangle', isAr ? 'متبقٍ عند الزبائن' : 'Still owed', clothesFmtLYD(owedLYD), 'from-amber-400 to-orange-500')}
      </div>

      <div class="flex flex-col sm:flex-row gap-3 mb-6">
        <div class="relative flex-1">
          <i data-lucide="search" class="w-4 h-4 absolute top-1/2 -translate-y-1/2 ${isAr ? 'right-4' : 'left-4'} text-slate-400"></i>
          <input
            type="text"
            id="clothes-order-search"
            value="${Security.escapeHtml(_clothesOrderSearch)}"
            oninput="onClothesOrderSearchInput(this)"
            placeholder="${isAr ? 'ابحث باسم الزبون أو الهاتف أو المنتج...' : 'Search by customer, phone or product...'}"
            class="w-full glass-input ${isAr ? 'pr-11 pl-4' : 'pl-11 pr-4'} py-2.5 rounded-xl"
          />
        </div>
        <select onchange="setClothesOrderStatusFilter(this.value)" class="glass-input px-4 py-2.5 rounded-xl">
          <option value="all" ${_clothesOrderStatusFilter === 'all' ? 'selected' : ''}>${isAr ? 'كل الحالات' : 'All statuses'}</option>
          ${CLOTHES_ORDER_STATUSES.map(s => `<option value="${s.id}" ${_clothesOrderStatusFilter === s.id ? 'selected' : ''}>${isAr ? s.labelAr : s.label}</option>`).join('')}
        </select>
        <select onchange="setClothesOrderPaymentFilter(this.value)" class="glass-input px-4 py-2.5 rounded-xl">
          <option value="all" ${_clothesOrderPaymentFilter === 'all' ? 'selected' : ''}>${isAr ? 'كل حالات الدفع' : 'All payments'}</option>
          ${CLOTHES_PAYMENT_STATUSES.map(s => `<option value="${s.id}" ${_clothesOrderPaymentFilter === s.id ? 'selected' : ''}>${isAr ? s.labelAr : s.label}</option>`).join('')}
        </select>
        <button onclick="exportClothesOrdersCSV()" class="glass-panel px-3 py-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:text-rose-600 flex items-center justify-center" title="${isAr ? 'تصدير CSV (إكسل)' : 'Export CSV (Excel)'}">
          <i data-lucide="download" class="w-4 h-4"></i>
        </button>
        <button onclick="showClothesOrderModal()" class="btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-5 py-2.5 rounded-xl font-bold shadow-lg hover:shadow-xl flex items-center justify-center gap-2">
          <i data-lucide="plus" class="w-4 h-4"></i>
          ${isAr ? 'طلب جديد' : 'New Order'}
        </button>
      </div>

      <div id="clothes-orders-grid">
        ${shown.length === 0 ? `
          <div class="glass-panel rounded-2xl p-12 text-center">
            <div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center mb-4 shadow-xl opacity-80">
              <i data-lucide="shopping-bag" class="w-8 h-8 text-white"></i>
            </div>
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-1">
              ${all.length === 0 ? (isAr ? 'لا توجد طلبات بعد' : 'No orders yet') : (isAr ? 'لا توجد نتائج' : 'No results')}
            </h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${all.length === 0
                ? (isAr ? 'أنشئ طلباً عندما يشتري منك زبون.' : 'Create an order when a customer buys from you.')
                : (isAr ? 'جرّب بحثاً أو فلتراً آخر.' : 'Try a different search or filter.')}
            </p>
          </div>
        ` : `
          <div class="text-sm text-slate-500 dark:text-slate-400 mb-3">
            ${isAr ? `عرض ${shown.length} من ${filtered.length} طلب` : `Showing ${shown.length} of ${filtered.length} orders`}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${shown.map(o => renderClothesOrderCard(o)).join('')}
          </div>
          ${remaining > 0 ? `
            <div class="text-center mt-6">
              <button onclick="loadMoreClothesOrders()" class="glass-panel px-6 py-2.5 rounded-xl font-medium text-slate-600 dark:text-slate-300 hover:text-rose-600">
                ${isAr ? `عرض المزيد (${remaining} متبقي)` : `Load more (${remaining} remaining)`}
              </button>
            </div>
          ` : ''}
        `}
      </div>
    </div>
  `;
}

function renderClothesOrderCard(o) {
  const isAr = clothesIsAr();
  const meta = clothesOrderStatusMeta(o.status);
  const payMeta = clothesPaymentStatusMeta(o.paymentStatus);
  const totals = getClothesOrderTotals(o);
  const lines = Array.isArray(o.lines) ? o.lines : [];
  const editable = clothesOrderIsActiveStatus(o.status);

  const lineSummary = lines.slice(0, 3).map(line => {
    const bits = [clothesProductNameById(line.productId)];
    const variant = [line.color, line.size].map(x => String(x || '').trim()).filter(Boolean).join('/');
    if (variant) bits.push(variant);
    return `${Security.escapeHtml(bits.join(' '))} ×${Math.max(0, Math.floor(Number(line.qty) || 0))}`;
  }).join(isAr ? '، ' : ', ') + (lines.length > 3 ? (isAr ? ` +${lines.length - 3} أخرى` : ` +${lines.length - 3} more`) : '');

  return `
    <div class="glass-panel rounded-2xl p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h4 class="font-bold text-slate-800 dark:text-white truncate">
            ${o.orderNo ? `<span class="text-rose-500">#${String(Math.floor(Number(o.orderNo))).padStart(4, '0')}</span> ` : ''}${Security.escapeHtml(o.customerName || '')}
          </h4>
          ${o.customerPhone ? `<p class="text-sm text-slate-500 dark:text-slate-400 truncate" dir="ltr">${Security.escapeHtml(o.customerPhone)}</p>` : ''}
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${meta.badge}">${isAr ? meta.labelAr : meta.label}</span>
          <span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${payMeta.badge}">${isAr ? payMeta.labelAr : payMeta.label}</span>
        </div>
      </div>

      <div class="mt-3 space-y-1.5 text-sm">
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'القطع' : 'Pieces'}</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">${totals.pieces}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'البضاعة + التوصيل' : 'Goods + delivery'}</span>
          <span class="font-medium text-slate-700 dark:text-slate-200">${clothesFmtLYD(totals.goodsLYD)} + ${clothesFmtLYD(totals.feeLYD)}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'الإجمالي' : 'Total'}</span>
          <span class="font-bold text-rose-600 dark:text-rose-400">${clothesFmtLYD(totals.totalLYD)}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'المدفوع / المتبقي' : 'Paid / remaining'}</span>
          <span class="font-medium">
            <span class="text-emerald-600 dark:text-emerald-400">${clothesFmtLYD(totals.paidLYD)}</span>
            <span class="text-slate-400"> / </span>
            <span class="${totals.remainingLYD > 0 ? 'text-red-600 dark:text-red-400 font-bold' : 'text-slate-500'}">${clothesFmtLYD(totals.remainingLYD)}</span>
          </span>
        </div>
        ${(() => {
          const profit = getClothesOrderProfitLYD(o);
          if (profit === null) return '';
          return `
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'الربح التقديري' : 'Est. profit'}</span>
          <span class="font-bold ${profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}">${clothesFmtLYD(profit)}</span>
        </div>`;
        })()}
        ${o.deliveredAt ? `
        <div class="flex justify-between gap-2">
          <span class="text-slate-500 dark:text-slate-400">${isAr ? 'تاريخ التسليم' : 'Delivered at'}</span>
          <span class="font-medium text-emerald-600 dark:text-emerald-400">${Security.escapeHtml(String(o.deliveredAt).split('T')[0])}</span>
        </div>` : ''}
      </div>

      ${lines.length ? `<p class="mt-3 text-xs text-slate-500 dark:text-slate-400">${lineSummary}</p>` : ''}
      ${o.note ? `<p class="mt-2 text-xs text-slate-400 dark:text-slate-500 line-clamp-2">${Security.escapeHtml(o.note)}</p>` : ''}

      <div class="flex items-center gap-2 mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
        <select onchange="setClothesOrderStatus('${o.id}', this.value)" class="glass-input px-2 py-1.5 rounded-lg text-sm flex-1" title="${isAr ? 'حالة التوصيل' : 'Delivery status'}">
          ${CLOTHES_ORDER_STATUSES.map(st => `<option value="${st.id}" ${o.status === st.id ? 'selected' : ''}>${isAr ? st.labelAr : st.label}</option>`).join('')}
        </select>
        <select onchange="setClothesOrderPayment('${o.id}', this.value)" class="glass-input px-2 py-1.5 rounded-lg text-sm flex-1" title="${isAr ? 'حالة الدفع' : 'Payment status'}">
          ${CLOTHES_PAYMENT_STATUSES.map(st => `<option value="${st.id}" ${o.paymentStatus === st.id ? 'selected' : ''}>${isAr ? st.labelAr : st.label}</option>`).join('')}
        </select>
        <button onclick="printClothesOrderSlip('${o.id}')" class="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" title="${isAr ? 'طباعة إيصال' : 'Print slip'}">
          <i data-lucide="printer" class="w-4 h-4"></i>
        </button>
        ${editable ? `
          <button onclick="editClothesOrder('${o.id}')" class="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" title="${isAr ? 'تعديل' : 'Edit'}">
            <i data-lucide="pencil" class="w-4 h-4"></i>
          </button>
        ` : ''}
        <button onclick="deleteClothesOrder('${o.id}')" class="p-2 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" title="${isAr ? 'حذف' : 'Delete'}">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
  `;
}

// ------------------------------------------
// ORDER MODAL (add / edit)
// ------------------------------------------

let _clothesTempOrderLines = [];

function showClothesOrderModal() {
  if (!clothesCanUse()) return;
  state.activeModal = 'clothes-order';
  state.modalData = null;
  _clothesTempOrderLines = [{ productId: '', color: '', size: '', qty: 1, priceLYD: '' }];
  updateUrlParams({ modal: 'clothes-order', id: 'new' }); // URL tracking
  renderModal();
}

function editClothesOrder(id) {
  if (!clothesCanUse()) return;
  const order = getVisibleClothesOrders().find(o => o.id === id);
  if (!order) return;
  if (!clothesOrderIsActiveStatus(order.status)) {
    showNotification(
      clothesIsAr() ? 'غير ممكن' : 'Not allowed',
      clothesIsAr() ? 'لا يمكن تعديل طلب مرتجع أو ملغى — أعد تفعيله أولاً.' : 'Cannot edit a Returned/Canceled order — re-activate it first.',
      'error'
    );
    return;
  }
  state.activeModal = 'clothes-order';
  state.modalData = order;
  updateUrlParams({ modal: 'clothes-order', id }); // URL tracking
  const lines = Array.isArray(order.lines) ? order.lines : [];
  _clothesTempOrderLines = lines.length
    ? lines.map(l => ({
        productId: String(l?.productId || ''),
        color: String(l?.color || ''),
        size: String(l?.size || ''),
        qty: Math.max(0, Math.floor(Number(l?.qty) || 0)),
        priceLYD: String(l?.priceLYD ?? ''),
        // Carry the historical cost snapshot: if this line's product was
        // deleted meanwhile, saving the edit must NOT wipe the cost to 0
        // (which would inflate the order's profit numbers).
        costUSDAtSale: Number(l?.costUSDAtSale) || 0
      }))
    : [{ productId: '', color: '', size: '', qty: 1, priceLYD: '' }];
  renderModal();
}

function renderClothesOrderModal() {
  const isAr = clothesIsAr();
  const data = state.modalData || {};
  const isEdit = state.modalData !== null;
  const payStatus = data.paymentStatus || 'Not Paid';

  return `
    <h2 class="text-2xl font-bold mb-4 flex items-center gap-2">
      <i data-lucide="shopping-bag" class="w-6 h-6 text-rose-500"></i>
      ${isEdit ? (isAr ? 'تعديل طلب' : 'Edit Order') : (isAr ? 'طلب جديد' : 'New Order')}
    </h2>
    <form id="modal-form" class="space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar ${isAr ? 'pl-2' : 'pr-2'}">
      <input type="hidden" id="clothes-order-editing-id" value="${Security.escapeHtml(String(isEdit ? (data.id || '') : ''))}" />

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'اسم الزبون *' : 'Customer name *'}</label>
          <input type="text" id="clothes-order-customer" value="${Security.escapeHtml(data.customerName || '')}" required class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'الاسم' : 'Name'}" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'الهاتف' : 'Phone'}</label>
          <input type="text" id="clothes-order-phone" value="${Security.escapeHtml(data.customerPhone || '')}" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="09..." dir="ltr" />
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium mb-2">${isAr ? 'القطع المطلوبة *' : 'Order items *'}</label>
        <div id="clothes-order-lines" class="space-y-2"></div>
        <button type="button" onclick="addClothesOrderLine()" class="mt-2 flex items-center gap-1.5 text-sm font-medium text-rose-600 hover:text-rose-700">
          <i data-lucide="plus" class="w-4 h-4"></i>${isAr ? 'إضافة قطعة' : 'Add item'}
        </button>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'رسوم التوصيل (دينار)' : 'Delivery fee (LYD)'}</label>
          <input type="text" inputmode="decimal" id="clothes-order-fee" value="${Security.escapeHtml(String(data.deliveryFeeLYD ?? ''))}" oninput="sanitizeMoneyInput(this); updateClothesOrderModalTotal()" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="0.00" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'الإجمالي' : 'Total'}</label>
          <div id="clothes-order-modal-total" class="w-full px-4 py-2 rounded-xl bg-rose-50 dark:bg-rose-900/20 font-bold text-rose-600 dark:text-rose-400">0.00 LYD</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'حالة الدفع' : 'Payment status'}</label>
          <select id="clothes-order-paystatus" class="w-full glass-input px-4 py-2 rounded-xl">
            ${CLOTHES_PAYMENT_STATUSES.map(s => `<option value="${s.id}" ${payStatus === s.id ? 'selected' : ''}>${isAr ? s.labelAr : s.label}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'المبلغ المدفوع (دينار)' : 'Amount paid (LYD)'}</label>
          <input type="text" inputmode="decimal" id="clothes-order-paid" value="${Security.escapeHtml(String(data.amountPaidLYD ?? ''))}" oninput="sanitizeMoneyInput(this)" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="0.00" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'طريقة الدفع' : 'Payment method'}</label>
          <input type="text" id="clothes-order-method" list="clothes-pay-methods" value="${Security.escapeHtml(data.paymentMethod || '')}" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'نقداً، تحويل...' : 'Cash, transfer...'}" />
          <datalist id="clothes-pay-methods">
            <option value="${isAr ? 'نقداً' : 'Cash'}"></option>
            <option value="${isAr ? 'تحويل بنكي' : 'Bank transfer'}"></option>
            <option value="${isAr ? 'بطاقة' : 'Card'}"></option>
          </datalist>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">${isAr ? 'ملاحظة' : 'Note'}</label>
          <input type="text" id="clothes-order-note" value="${Security.escapeHtml(data.note || '')}" class="w-full glass-input px-4 py-2 rounded-xl" placeholder="${isAr ? 'اختياري' : 'Optional'}" />
        </div>
      </div>

      <div class="flex gap-3 pt-2">
        <button type="submit" class="flex-1 btn-shine bg-gradient-to-r from-rose-500 to-pink-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg">
          ${isEdit ? (isAr ? 'حفظ التعديلات' : 'Save Changes') : (isAr ? 'إنشاء الطلب' : 'Create Order')}
        </button>
        <button type="button" onclick="closeModal()" class="flex-1 bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600">
          ${isAr ? 'إلغاء' : 'Cancel'}
        </button>
      </div>
    </form>
  `;
}

function refreshClothesOrderLines() {
  const isAr = clothesIsAr();
  const wrap = document.getElementById('clothes-order-lines');
  if (!wrap) return;
  const products = getVisibleClothesProducts();
  // Same inline-grid pattern as the shipment modal (width utility classes are
  // unreliable inside modals in narrow webviews).
  const rowStyle = 'display:grid;grid-template-columns:minmax(0,1fr) 2rem;gap:0.5rem;align-items:center;';
  const subStyle = 'grid-column:1 / -1;display:grid;grid-template-columns:minmax(0,1fr) 4rem 4rem 5rem;gap:0.5rem;align-items:center;';
  const cellStyle = 'width:100%;min-width:0;';
  wrap.innerHTML = _clothesTempOrderLines.map((line, idx) => {
    const product = products.find(p => p.id === line.productId);
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const matchIdx = product ? findClothesVariantIndex(product, line.color, line.size) : -1;
    return `
    <div style="${rowStyle}" class="pb-2 border-b border-slate-100 dark:border-slate-800">
      <select oninput="onClothesOrderLineField(${idx}, 'productId', this.value)" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm">
        <option value="">${isAr ? '— اختر المنتج —' : '— choose product —'}</option>
        ${products.map(p => `<option value="${p.id}" ${line.productId === p.id ? 'selected' : ''}>${Security.escapeHtml(p.name || '')}</option>`).join('')}
      </select>
      <button type="button" onclick="removeClothesOrderLine(${idx})" class="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="${isAr ? 'إزالة' : 'Remove'}">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
      <div style="${subStyle}">
        <select oninput="onClothesOrderLineVariantPick(${idx}, this.value)" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" ${product && variants.length ? '' : 'disabled'} title="${isAr ? 'اللون والمقاس' : 'Color & size'}">
          <option value="" ${matchIdx < 0 ? 'selected' : ''}>${!product
            ? (isAr ? 'اختر المنتج أولاً' : 'choose product first')
            : (variants.length ? (isAr ? '— اللون والمقاس —' : '— color & size —') : (isAr ? 'لا مخزون لهذا المنتج' : 'no stock for this product'))}</option>
          ${variants.map((v, vi) => `<option value="v:${vi}" ${matchIdx === vi ? 'selected' : ''}>${Security.escapeHtml(clothesVariantOptionLabel(v, true))}</option>`).join('')}
        </select>
        <input type="number" min="0" step="1" value="${Math.max(0, Math.floor(Number(line.qty) || 0))}" oninput="onClothesOrderLineField(${idx}, 'qty', this.value)" placeholder="${isAr ? 'كمية' : 'Qty'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'الكمية' : 'Quantity'}" />
        <input type="text" inputmode="decimal" value="${Security.escapeHtml(String(line.priceLYD ?? ''))}" oninput="sanitizeMoneyInput(this); onClothesOrderLineField(${idx}, 'priceLYD', this.value)" placeholder="${isAr ? 'سعر/1' : 'LYD/1'}" style="${cellStyle}" class="glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'سعر القطعة بالدينار' : 'Unit price LYD'}" />
      </div>
    </div>
  `;
  }).join('');
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap);
  updateClothesOrderModalTotal();
}

function onClothesOrderLineVariantPick(idx, value) {
  const line = _clothesTempOrderLines[idx];
  if (!line) return;
  const product = getVisibleClothesProducts().find(p => p.id === line.productId);
  if (String(value).startsWith('v:')) {
    const v = (product?.variants || [])[Number(String(value).slice(2))];
    if (v) {
      line.color = String(v.color || '');
      line.size = String(v.size || '');
    }
  } else {
    line.color = '';
    line.size = '';
  }
  refreshClothesOrderLines();
}

function onClothesOrderLineField(idx, field, value) {
  const line = _clothesTempOrderLines[idx];
  if (!line) return;
  if (field === 'qty') {
    line.qty = Math.max(0, Math.floor(Number(value) || 0));
  } else if (field === 'priceLYD') {
    line.priceLYD = String(value || '');
  } else if (field === 'productId') {
    line.productId = String(value || '');
    // New product = new variant list: reset the picked color/size
    line.color = '';
    line.size = '';
    // A different product has a different cost — drop the frozen cost snapshot
    // so saveClothesOrderFromModal re-snapshots from the NEW product's cost.
    // Without this, swapping a line's product on an existing order kept the old
    // product's cost and reported wrong (even sign-flipped) profit.
    delete line.costUSDAtSale;
    // Convenience: prefill unit price from the product's selling price when empty
    if (!String(line.priceLYD || '').trim()) {
      const p = getVisibleClothesProducts().find(x => x.id === line.productId);
      if (p && Number(p.priceLYD) > 0) line.priceLYD = String(p.priceLYD);
    }
    refreshClothesOrderLines();
    return;
  }
  updateClothesOrderModalTotal();
}

function addClothesOrderLine() {
  _clothesTempOrderLines.push({ productId: '', color: '', size: '', qty: 1, priceLYD: '' });
  refreshClothesOrderLines();
}

function removeClothesOrderLine(idx) {
  _clothesTempOrderLines.splice(idx, 1);
  if (_clothesTempOrderLines.length === 0) _clothesTempOrderLines.push({ productId: '', color: '', size: '', qty: 1, priceLYD: '' });
  refreshClothesOrderLines();
}

function updateClothesOrderModalTotal() {
  const el = document.getElementById('clothes-order-modal-total');
  if (!el) return;
  let goods = 0;
  for (const line of _clothesTempOrderLines) {
    goods += Math.max(0, Math.floor(Number(line.qty) || 0)) * (clothesParseMoney(line.priceLYD) || 0);
  }
  const fee = clothesParseMoney(document.getElementById('clothes-order-fee')?.value);
  el.textContent = clothesFmtLYD(Math.round((goods + fee) * 100) / 100);
}

// Printable bilingual order slip (uses the app's print-single/.print-target
// mechanism — see printReceiptCard for the original pattern).
function printClothesOrderSlip(orderId) {
  const order = getVisibleClothesOrders().find(o => o.id === orderId);
  if (!order) return;
  const isAr = clothesIsAr();
  const totals = getClothesOrderTotals(order);
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const payMeta = clothesPaymentStatusMeta(order.paymentStatus);
  const orderNoLabel = order.orderNo ? `#${String(Math.floor(Number(order.orderNo))).padStart(4, '0')}` : '';
  const dateLabel = String(order.createdAt || '').split('T')[0] || '';

  const rowsHtml = lines.map((line, i) => {
    const variant = [line.color, line.size].map(x => String(x || '').trim()).filter(Boolean).join(' · ');
    const qty = Math.max(0, Math.floor(Number(line.qty) || 0));
    const price = Number(line.priceLYD) || 0;
    return `
      <tr>
        <td style="border:1px solid #cbd5e1;padding:6px 8px;text-align:center;">${i + 1}</td>
        <td style="border:1px solid #cbd5e1;padding:6px 8px;">${Security.escapeHtml(clothesProductNameById(line.productId))}${variant ? ` — ${Security.escapeHtml(variant)}` : ''}</td>
        <td style="border:1px solid #cbd5e1;padding:6px 8px;text-align:center;">${qty}</td>
        <td style="border:1px solid #cbd5e1;padding:6px 8px;text-align:center;">${price.toFixed(2)}</td>
        <td style="border:1px solid #cbd5e1;padding:6px 8px;text-align:center;">${(qty * price).toFixed(2)}</td>
      </tr>`;
  }).join('');

  const moneyRow = (label, value, bold) => `
    <div style="display:flex;justify-content:space-between;padding:3px 0;${bold ? 'font-weight:bold;font-size:15px;border-top:1px solid #cbd5e1;margin-top:4px;padding-top:6px;' : ''}">
      <span>${label}</span><span>${value}</span>
    </div>`;

  document.querySelectorAll('.clothes-print-slip').forEach(el => el.remove());
  const slip = document.createElement('div');
  slip.className = 'clothes-print-slip print-target';
  slip.dir = isAr ? 'rtl' : 'ltr';
  slip.innerHTML = `
    <div style="padding:18px;font-family:inherit;font-size:13px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #0f172a;padding-bottom:8px;margin-bottom:10px;">
        <div style="font-size:20px;font-weight:bold;">${isAr ? 'إيصال طلب' : 'Order Slip'} ${orderNoLabel}</div>
        <div>${Security.escapeHtml(dateLabel)}</div>
      </div>
      <div style="margin-bottom:10px;">
        <div><strong>${isAr ? 'الزبون:' : 'Customer:'}</strong> ${Security.escapeHtml(order.customerName || '')}</div>
        ${order.customerPhone ? `<div><strong>${isAr ? 'الهاتف:' : 'Phone:'}</strong> <span dir="ltr">${Security.escapeHtml(order.customerPhone)}</span></div>` : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="border:1px solid #cbd5e1;padding:6px 8px;">#</th>
            <th style="border:1px solid #cbd5e1;padding:6px 8px;text-align:${isAr ? 'right' : 'left'};">${isAr ? 'الصنف' : 'Item'}</th>
            <th style="border:1px solid #cbd5e1;padding:6px 8px;">${isAr ? 'الكمية' : 'Qty'}</th>
            <th style="border:1px solid #cbd5e1;padding:6px 8px;">${isAr ? 'السعر' : 'Price'}</th>
            <th style="border:1px solid #cbd5e1;padding:6px 8px;">${isAr ? 'المجموع' : 'Total'}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div style="max-width:280px;margin-${isAr ? 'right' : 'left'}:auto;">
        ${moneyRow(isAr ? 'البضاعة' : 'Goods', clothesFmtLYD(totals.goodsLYD), false)}
        ${moneyRow(isAr ? 'التوصيل' : 'Delivery', clothesFmtLYD(totals.feeLYD), false)}
        ${moneyRow(isAr ? 'الإجمالي' : 'TOTAL', clothesFmtLYD(totals.totalLYD), true)}
        ${moneyRow(isAr ? 'المدفوع' : 'Paid', clothesFmtLYD(totals.paidLYD), false)}
        ${moneyRow(isAr ? 'المتبقي' : 'Remaining', clothesFmtLYD(totals.remainingLYD), false)}
        ${moneyRow(isAr ? 'حالة الدفع' : 'Payment', `${isAr ? payMeta.labelAr : payMeta.label}${order.paymentMethod ? ` (${Security.escapeHtml(order.paymentMethod)})` : ''}`, false)}
      </div>
      <div style="text-align:center;margin-top:16px;color:#64748b;">${isAr ? 'شكراً لتسوقكم معنا' : 'Thank you for your business'}</div>
    </div>
  `;
  document.body.appendChild(slip);
  document.body.classList.add('print-single');
  const cleanup = () => {
    document.body.classList.remove('print-single');
    slip.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Safety net for webviews that never fire afterprint (printReceiptCard pattern)
  setTimeout(cleanup, 3000);
  window.print();
}

// Checks stock for the requested lines; returns a human list of shortages.
function getClothesOrderStockShortages(lines) {
  // Aggregate requested quantity per product+variant BEFORE comparing to
  // stock. Two lines for the same Red/M each ≤ stock individually still
  // oversell when their sum exceeds stock — the deduction is cumulative, so
  // the check must be too.
  const requestedByKey = new Map();
  for (const line of lines) {
    const key = `${line.productId}||${String(line.color || '').trim().toLowerCase()}||${String(line.size || '').trim().toLowerCase()}`;
    const prev = requestedByKey.get(key) || { line, qty: 0 };
    prev.qty += Math.max(0, Math.floor(Number(line.qty) || 0));
    requestedByKey.set(key, prev);
  }
  const shortages = [];
  for (const { line, qty } of requestedByKey.values()) {
    const product = getVisibleClothesProducts().find(p => p.id === line.productId);
    if (!product) continue;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const match = variants.find(v =>
      String(v?.color || '').trim().toLowerCase() === String(line.color || '').trim().toLowerCase() &&
      String(v?.size || '').trim().toLowerCase() === String(line.size || '').trim().toLowerCase()
    );
    const available = match ? Math.max(0, Math.floor(Number(match.qty) || 0)) : 0;
    if (qty > available) {
      const variant = [line.color, line.size].filter(Boolean).join('/');
      shortages.push(`${product.name}${variant ? ' ' + variant : ''}: ${available} ${clothesIsAr() ? 'متوفر' : 'available'}, ${qty} ${clothesIsAr() ? 'مطلوب' : 'requested'}`);
    }
  }
  return shortages;
}

// Called by handleModalSubmit for state.activeModal === 'clothes-order'.
async function saveClothesOrderFromModal() {
  if (!clothesCanUse()) return false;
  const isAr = clothesIsAr();

  const customerName = Security.sanitizeInput(String(document.getElementById('clothes-order-customer')?.value || ''), { maxLength: 120 }).trim();
  if (!customerName) {
    showNotification(isAr ? 'تنبيه' : 'Validation', isAr ? 'اسم الزبون مطلوب' : 'Customer name is required', 'error');
    return false;
  }
  const customerPhone = Security.sanitizeInput(String(document.getElementById('clothes-order-phone')?.value || ''), { maxLength: 40 }).trim();
  const deliveryFeeLYD = clothesParseMoney(document.getElementById('clothes-order-fee')?.value);
  const paymentStatus = String(document.getElementById('clothes-order-paystatus')?.value || 'Not Paid');
  let amountPaidLYD = clothesParseMoney(document.getElementById('clothes-order-paid')?.value);
  const paymentMethod = Security.sanitizeInput(String(document.getElementById('clothes-order-method')?.value || ''), { maxLength: 60 }).trim();
  const note = Security.sanitizeInput(String(document.getElementById('clothes-order-note')?.value || ''), { maxLength: 500 }).trim();

  const lines = [];
  for (const l of _clothesTempOrderLines) {
    const productId = String(l?.productId || '').trim();
    const qty = Math.max(0, Math.floor(Number(l?.qty) || 0));
    if (!productId || qty === 0) continue;
    const product = getVisibleClothesProducts().find(p => p.id === productId)
      // Deleted products keep their historical cost for the snapshot.
      || (state.clothesProducts || []).find(p => p && p.id === productId);
    // Cost snapshot: FROZEN at sale time so profit stays correct even if the
    // product's cost price changes later. An existing line already carries its
    // snapshot — keep it, so editing an order for an unrelated reason (e.g.
    // fixing a phone number) never silently rewrites historical profit. Only a
    // newly-added line takes the current product cost. (A line whose product
    // was deleted also keeps its snapshot via the same branch.)
    const prevSnap = Number(l?.costUSDAtSale);
    const hasPrevSnap = Number.isFinite(prevSnap);
    lines.push({
      productId,
      color: String(l?.color || '').trim(),
      size: String(l?.size || '').trim(),
      qty,
      priceLYD: clothesParseMoney(l?.priceLYD),
      costUSDAtSale: hasPrevSnap
        ? Math.round(prevSnap * 100) / 100
        : (product ? Math.round(((Number(product.costUSD) || 0)) * 100) / 100 : 0)
    });
  }
  if (lines.length === 0) {
    showNotification(isAr ? 'تنبيه' : 'Validation', isAr ? 'أضف قطعة واحدة على الأقل (منتج + كمية).' : 'Add at least one item (product + quantity).', 'error');
    return false;
  }

  // A product that has colors/sizes must have one picked (dropdown), so the
  // deduction can never land on a variant that does not exist.
  for (const line of lines) {
    const product = getVisibleClothesProducts().find(p => p.id === line.productId);
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    if (variants.length && findClothesVariantIndex(product, line.color, line.size) === -1) {
      showNotification(
        isAr ? 'تنبيه' : 'Validation',
        isAr ? `اختر اللون والمقاس للمنتج "${product.name}".` : `Choose a color & size for "${product.name}".`,
        'error'
      );
      return false;
    }
  }

  const editingId = String(document.getElementById('clothes-order-editing-id')?.value || '').trim();
  const editTarget = editingId ? getVisibleClothesOrders().find(o => o.id === editingId) : null;
  if (editingId && !editTarget) {
    showNotification(isAr ? 'تعذّر الحفظ' : 'Cannot save', isAr ? 'تم حذف هذا الطلب. أعد فتح القائمة.' : 'This order was deleted. Please reopen the list.', 'error');
    return false;
  }
  if (editTarget && !clothesOrderIsActiveStatus(editTarget.status)) {
    showNotification(isAr ? 'غير ممكن' : 'Not allowed', isAr ? 'لا يمكن تعديل طلب مرتجع أو ملغى.' : 'Cannot edit a Returned/Canceled order.', 'error');
    return false;
  }

  // For stock checking on edit: the old pieces come back first, so check
  // against stock as it would be AFTER restoring them.
  if (editTarget && editTarget.stockDeducted) {
    applyClothesOrderStockDelta(editTarget, 1); // restore old pieces
  }
  const shortages = getClothesOrderStockShortages(lines);
  if (shortages.length) {
    const ok = confirm((isAr
      ? 'تنبيه: المخزون غير كافٍ للقطع التالية:\n\n'
      : 'Warning: not enough stock for these items:\n\n') + shortages.join('\n') + (isAr
      ? '\n\nهل تريد المتابعة رغم ذلك؟ (سيصبح المخزون صفراً)'
      : '\n\nContinue anyway? (stock will floor at zero)'));
    if (!ok) {
      // Put the old pieces back the way they were and abort
      if (editTarget && editTarget.stockDeducted) applyClothesOrderStockDelta(editTarget, -1);
      return false;
    }
  }

  const totalsProbe = { lines, deliveryFeeLYD };
  const total = getClothesOrderTotals(totalsProbe).totalLYD;
  if (paymentStatus === 'Paid') amountPaidLYD = total;
  if (paymentStatus === 'Not Paid') amountPaidLYD = 0;

  const payload = { customerName, customerPhone, note, lines, deliveryFeeLYD, paymentStatus, amountPaidLYD, paymentMethod };

  if (editTarget) {
    applyClothesOrderStockDelta({ lines }, -1); // deduct the new pieces
    updateRecord(state.clothesOrders, editTarget.id, { ...payload, stockDeducted: true });
    showNotification(isAr ? 'تم الحفظ' : 'Saved', isAr ? 'تم تحديث الطلب.' : 'Order updated.', 'success');
  } else {
    applyClothesOrderStockDelta({ lines }, -1); // pieces leave the warehouse
    // Sequential order number; max over ALL records (deleted included) so a
    // number is never reused after a delete.
    const nextNo = 1 + (state.clothesOrders || []).reduce((m, x) => Math.max(m, Math.floor(Number(x?.orderNo) || 0)), 0);
    addRecord(state.clothesOrders, {
      ...payload,
      orderNo: nextNo,
      status: 'New',
      stockDeducted: true,
      deliveredAt: null,
      paidAt: paymentStatus === 'Paid' ? new Date().toISOString() : null,
      createdAt: new Date().toISOString()
    });
    showNotification(isAr ? 'تم الإنشاء' : 'Created', isAr ? 'تم إنشاء الطلب وخصم القطع من المخزون.' : 'Order created and pieces taken from stock.', 'success');
  }
  return true;
}
