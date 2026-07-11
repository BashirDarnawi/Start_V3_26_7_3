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
  render();
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

function getVisibleClothesProducts() {
  return getVisibleRecords(state.clothesProducts);
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
  return renderClothesComingSoonPanel(
    'layout-dashboard',
    'Dashboard', 'نظرة عامة',
    'One screen with the full picture: value of stock in the warehouse, goods still on the way, orders out for delivery, money collected and money customers still owe.',
    'شاشة واحدة بالصورة الكاملة: قيمة البضاعة في المستودع، البضاعة التي في الطريق، الطلبات الخارجة للتوصيل، المال المحصَّل والمال المتبقي عند الزبائن.'
  );
}

// (Shipments tab implemented in the SHIPMENTS section below)

// (Orders tab implemented in the ORDERS section below)

function renderClothesSystemView() {
  const isAr = clothesIsAr();

  let tabContent;
  switch (_clothesActiveTab) {
    case 'products': tabContent = renderClothesProductsTab(); break;
    case 'shipments': tabContent = renderClothesShipmentsTab(); break;
    case 'orders': tabContent = renderClothesOrdersTab(); break;
    default: tabContent = renderClothesDashboardTab();
  }

  return `
    <div class="max-w-6xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('smart-systems')" class="mb-6 flex items-center gap-2 text-rose-600 hover:text-rose-700 font-medium">
        <i data-lucide="${isAr ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isAr ? 'العودة للأنظمة الذكية' : 'Back to Smart Systems'}</span>
      </button>

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
  if (!isCurrentUserAdmin()) return;
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
  if (!isCurrentUserAdmin()) return;
  const isAr = clothesIsAr();
  const product = getVisibleClothesProducts().find(p => p.id === id);
  if (!product) return;
  const name = product.name || (isAr ? 'منتج' : 'product');
  const ok = confirm(isAr
    ? `هل تريد حذف المنتج "${name}"؟\nسيبقى في الشحنات والطلبات القديمة كسجل فقط.`
    : `Delete product "${name}"?\nOld shipments and orders will keep it for history only.`);
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

function showClothesProductModal() {
  if (!isCurrentUserAdmin()) return;
  state.activeModal = 'clothes-product';
  state.modalData = null;
  _clothesTempVariants = [{ color: '', size: '', qty: 0 }];
  _clothesTempPhoto = null;
  renderModal();
}

function editClothesProduct(id) {
  if (!isCurrentUserAdmin()) return;
  const product = getVisibleClothesProducts().find(p => p.id === id);
  if (!product) return;
  state.activeModal = 'clothes-product';
  state.modalData = product;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  _clothesTempVariants = variants.length
    ? variants.map(v => ({ color: String(v?.color || ''), size: String(v?.size || ''), qty: Math.max(0, Math.floor(Number(v?.qty) || 0)) }))
    : [{ color: '', size: '', qty: 0 }];
  _clothesTempPhoto = product.photo || null;
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
  wrap.innerHTML = _clothesTempVariants.map((v, idx) => `
    <div class="flex items-center gap-2">
      <input type="text" value="${Security.escapeHtml(String(v.color || ''))}" oninput="onClothesVariantField(${idx}, 'color', this.value)" placeholder="${isAr ? 'اللون' : 'Color'}" class="flex-1 min-w-0 glass-input px-3 py-2 rounded-xl text-sm" />
      <input type="text" value="${Security.escapeHtml(String(v.size || ''))}" oninput="onClothesVariantField(${idx}, 'size', this.value)" placeholder="${isAr ? 'المقاس' : 'Size'}" class="w-20 glass-input px-3 py-2 rounded-xl text-sm" />
      <input type="number" min="0" step="1" value="${Math.max(0, Math.floor(Number(v.qty) || 0))}" oninput="onClothesVariantField(${idx}, 'qty', this.value)" placeholder="0" class="w-20 glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'الكمية' : 'Quantity'}" />
      <button type="button" onclick="removeClothesVariantRow(${idx})" class="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0" title="${isAr ? 'إزالة' : 'Remove'}">
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
  compressImageToDataUrl(file).then((dataUrl) => {
    _clothesTempPhoto = dataUrl;
    refreshClothesPhotoPreview();
  }).catch(() => {
    showNotification('Error', clothesIsAr() ? 'تعذر قراءة الصورة' : 'Could not read the image', 'error');
  });
  // Allow re-selecting the same file later
  input.value = '';
}

function removeClothesProductPhoto() {
  _clothesTempPhoto = null;
  refreshClothesPhotoPreview();
}

// Called by handleModalSubmit for state.activeModal === 'clothes-product'.
// Returns true when saved (modal may close), false to keep the modal open.
async function saveClothesProductFromModal() {
  if (!isCurrentUserAdmin()) return false;
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
  return getVisibleRecords(state.clothesShipments);
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

function setClothesShipmentStatus(shipmentId, newStatus) {
  if (!isCurrentUserAdmin()) return;
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
  if (!isCurrentUserAdmin()) return;
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

let _clothesTempShipLines = [];

function showClothesShipmentModal() {
  if (!isCurrentUserAdmin()) return;
  state.activeModal = 'clothes-shipment';
  state.modalData = null;
  _clothesTempShipLines = [{ productId: '', color: '', size: '', qty: 0, unitCostUSD: '' }];
  renderModal();
}

function editClothesShipment(id) {
  if (!isCurrentUserAdmin()) return;
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
  wrap.innerHTML = _clothesTempShipLines.map((line, idx) => `
    <div class="flex flex-wrap items-center gap-2">
      <select oninput="onClothesShipLineField(${idx}, 'productId', this.value)" class="flex-1 min-w-[140px] glass-input px-3 py-2 rounded-xl text-sm">
        <option value="">${isAr ? '— اختر المنتج —' : '— choose product —'}</option>
        ${products.map(p => `<option value="${p.id}" ${line.productId === p.id ? 'selected' : ''}>${Security.escapeHtml(p.name || '')}</option>`).join('')}
      </select>
      <input type="text" value="${Security.escapeHtml(String(line.color || ''))}" oninput="onClothesShipLineField(${idx}, 'color', this.value)" placeholder="${isAr ? 'اللون' : 'Color'}" class="w-24 glass-input px-3 py-2 rounded-xl text-sm" />
      <input type="text" value="${Security.escapeHtml(String(line.size || ''))}" oninput="onClothesShipLineField(${idx}, 'size', this.value)" placeholder="${isAr ? 'المقاس' : 'Size'}" class="w-20 glass-input px-3 py-2 rounded-xl text-sm" />
      <input type="number" min="0" step="1" value="${Math.max(0, Math.floor(Number(line.qty) || 0))}" oninput="onClothesShipLineField(${idx}, 'qty', this.value)" placeholder="${isAr ? 'كمية' : 'Qty'}" class="w-20 glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'الكمية' : 'Quantity'}" />
      <input type="text" inputmode="decimal" value="${Security.escapeHtml(String(line.unitCostUSD ?? ''))}" oninput="sanitizeMoneyInput(this); onClothesShipLineField(${idx}, 'unitCostUSD', this.value)" placeholder="$/1" class="w-20 glass-input px-3 py-2 rounded-xl text-sm" title="${isAr ? 'تكلفة القطعة بالدولار' : 'Unit cost USD'}" />
      <button type="button" onclick="removeClothesShipLine(${idx})" class="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0" title="${isAr ? 'إزالة' : 'Remove'}">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>
  `).join('');
  if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap);
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
    // Convenience: prefill unit cost from the product's cost price when empty
    if (!String(line.unitCostUSD || '').trim()) {
      const p = getVisibleClothesProducts().find(x => x.id === line.productId);
      if (p && Number(p.costUSD) > 0) {
        line.unitCostUSD = String(p.costUSD);
        refreshClothesShipLines();
      }
    }
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
  if (!isCurrentUserAdmin()) return false;
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
