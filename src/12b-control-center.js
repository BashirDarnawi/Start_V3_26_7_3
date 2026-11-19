// ==========================================
// OWNER DASHBOARD: THE DAILY CONTROL CENTER (ADMIN)
// ==========================================
// The Admin's first screen after sign-in. It does not change accounting automatically. The "Today"
// tab lists the work that is waiting across the whole business (office, deliveries, collections, the
// Ads Studio desk, the Clothes System): each line shows the same sum its own screen shows and has one
// button that opens the list behind the number. Month close sits beside it. The "System and plans"
// tab keeps server upkeep (encrypted backup, connections, setup tasks, plan prices) out of the way of
// daily work. Design and sources, line by line: docs/redesign/ADMIN_DASHBOARD.md.

let _controlCenter = {
  loading: false,
  loadedAt: 0,
  operations: null,
  meta: null,
  error: '',
  period: '',
  tab: 'today',         // 'today' | 'system'
  userId: '',           // whose server answers are held here (another sign-in starts clean)
  studio: null,         // the Studio desk's own counter: counts only, never a name or an amount
  studioFailed: false,
  clothesAsked: false,  // the Clothes bundle was asked for once, for its two numbers
  check: null,          // the last month check: { period, totals, blockers }
  checking: false,
  dialog: null          // the open confirmation: { kind: 'close' | 'unlock', period, blockers, busy }
};

// Platform-owner screen; still, Arabic admins deserve Arabic messages.
function ccText(en, ar) {
  return state.language === 'ar' ? ar : en;
}

// A server or network error as the admin reads it. English: the server's own sentence. Arabic: the
// shared translation of a known refusal, else the Arabic fallback (never a raw English sentence
// under an Arabic title); the server's words stay in the console for whoever supports the office.
function ccErrorText(error, fallbackEn, fallbackAr) {
  const detail = error && error.payload && error.payload.detail;
  const raw = String((typeof detail === 'string' && detail) || (detail && detail.message) || (error && error.message) || '').trim();
  if (state.language !== 'ar') return raw || fallbackEn;
  const known = raw && typeof _serverRefusalText === 'function' ? _serverRefusalText(raw) : raw;
  if (known && /[\u0600-\u06FF]/.test(known)) return known;
  if (raw) console.warn('[control-center]', raw);
  return fallbackAr;
}

function controlCenterPreviousMonth() {
  const now = new Date();
  const value = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function controlCenterMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

function controlCenterTimestamp(value) {
  const number = Number(value || 0);
  const never = ccText('Never', 'أبداً');
  if (!Number.isFinite(number) || number <= 0) return never;
  try { return new Date(number).toLocaleString(typeof appDateLocale === 'function' ? appDateLocale() : undefined); } catch (_) { return never; }
}

// One way of writing money on this screen: thousands separator, two decimals, the currency always shown.
function controlCenterLyd(value) {
  return `${controlCenterMoney(value)} ${ccText('LYD', 'د.ل')}`;
}

function controlCenterLocale() {
  return typeof appDateLocale === 'function' ? appDateLocale() : undefined;
}

// "2026-10" as a person says it: "October 2026".
function controlCenterMonthName(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!match) return String(period || '');
  try { return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(controlCenterLocale(), { month: 'long', year: 'numeric' }); } catch (_) { return match[0]; }
}

// "12:04", for "Server checks updated 12:04".
function controlCenterClock(value) {
  try { return new Date(Number(value) || Date.now()).toLocaleTimeString(controlCenterLocale(), { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}

// Server answers belong to the person who asked for them: another sign-in starts clean.
function controlCenterKeepSession() {
  const userId = String(state.currentUser?.id || '');
  if (_controlCenter.userId === userId) return;
  Object.assign(_controlCenter, { userId, loadedAt: 0, operations: null, meta: null, error: '', studio: null, studioFailed: false, check: null, checking: false, tab: 'today' });
  closeControlCenterDialog(true);
}

// Month-close blockers carry a stable code; the server's English message is
// only the fallback for a code this screen does not know yet.
const CONTROL_CENTER_BLOCKER_TEXT = {
  ads_need_setup: ['Ads still need customer, amount, or payment setup', 'إعلانات تحتاج استكمال العميل أو المبلغ أو الدفع'],
  unpaid_receipts: ['Receipts are still unpaid', 'وصولات لا تزال غير مدفوعة'],
  ads_still_running: ['Ads from this month are still running (not stopped or completed)', 'إعلانات من هذا الشهر لا تزال تعمل (لم تُوقف ولم تكتمل)'],
  deliveries_open: ['Delivery jobs from this month are still open', 'مهام توصيل من هذا الشهر لا تزال مفتوحة'],
  driver_cash_not_handed_over: ['Drivers still hold cash collected for this month\'s deliveries', 'نقود توصيلات هذا الشهر لم تُسلَّم للمكتب بعد']
};
function controlCenterBlockerLine(item) {
  const pair = CONTROL_CENTER_BLOCKER_TEXT[String(item?.code || '')];
  return `${Array.isArray(pair) ? ccText(pair[0], pair[1]) : String(item?.message || item?.code || '')} (${Number(item?.count) || 0})`;
}

// Server setup tasks arrive as English sentences; show the known ones in Arabic.
const CONTROL_CENTER_SETUP_TASK_AR = {
  'Last backup is overdue - check the backup worker and the log': 'آخر نسخة احتياطية متأخرة — راجع عامل النسخ الاحتياطي والسجل',
  'Enable encrypted daily backups': 'فعّل النسخ الاحتياطي اليومي المشفّر',
  'Add a permanent backup encryption key': 'أضف مفتاح تشفير دائماً للنسخ الاحتياطية',
  'Connect private S3-compatible off-site storage': 'اربط تخزيناً خارجياً خاصاً متوافقاً مع S3',
  'Off-site backup copy is failing - check the S3 bucket, keys and region': 'النسخة الخارجية تفشل — راجع حاوية S3 والمفاتيح والمنطقة',
  'Connect an operations alert webhook': 'اربط رابط تنبيهات التشغيل (Webhook)'
};

function getControlCenterFacts() {
  const ads = getVisibleRecords(state.ads || []);
  const receipts = getVisibleRecords(state.receipts || []);
  const setupAds = ads.filter(ad => {
    if (typeof isMetaAdSetupPending === 'function' && isMetaAdSetupPending(ad)) return true;
    return !String(ad.customerId || '').trim() || Number(ad.amountUSD || 0) <= 0 || !String(ad.paymentStatus || '').trim();
  });
  const unpaidReceipts = receipts.filter(receipt => {
    if (String(receipt.receiptType || '').toUpperCase() === 'TRANSFER_IN') return false;
    // Canceled/Lost/Destroyed receipts are settled history, not money the
    // owner still needs to chase — they must not inflate the attention count.
    if (getReceiptPaymentState(receipt) !== 'not_paid') return false;
    // Nor is a debt the company covered in full (it keeps Not Paid by design): the month
    // close (operations.py _customer_outstanding) and the dashboard use the same rule.
    // Without coverage fields the status alone decides, as on the server.
    if ((receipt.companyCoveredUSD != null || receipt.customerOutstandingUSD != null) && typeof _receiptCustomerOutstandingUSD === 'function' && _receiptCustomerOutstandingUSD(receipt) <= 0.005) return false;
    return true;
  });
  const metaFailures = ads.filter(ad => { const code = String(ad.metaSyncErrorCode || ad.metaLastErrorCode || '').trim(); return code && !['pending_enrichment', 'insights_unavailable', 'duplicate_link'].includes(code); });  // informational states are not failures
  const metaDuplicates = ads.filter(ad => String(ad.metaSyncErrorCode || '').trim() === 'duplicate_link');  // needs an unlink, not a retry
  let snapshot = null;
  try { snapshot = typeof getCurrentProfitabilitySnapshot === 'function' ? getCurrentProfitabilitySnapshot(ads) : null; } catch (_) {}
  return {
    ads,
    receipts,
    setupAds,
    unpaidReceipts,
    metaFailures,
    metaDuplicates,
    snapshot,
    attentionCount: setupAds.length + unpaidReceipts.length + metaFailures.length + metaDuplicates.length + ((snapshot?.unpricedSpendUSD || 0) > 0.005 ? 1 : 0)
  };
}

// Everything the "Today" tab shows that the browser already holds. Each figure comes from the function
// its own screen uses (named beside it), so the dashboard and that screen can never disagree.
function getControlCenterToday() {
  const facts = getControlCenterFacts();
  const debtors = shellDebtorRows();  // Collect a debt: its own list
  return {
    facts,
    reconciliation: facts.ads.filter(ad => isAdReadyForReconciliation(ad) && !isAdReconciliationDone(ad)).length,  // Reconciliation: "Ads ready for review"
    delivery: getDeliveryStats(getDeliveryRows()),  // Deliveries: its tiles and "Pending Assignment"
    overdue: debtors.filter(row => row.overdue).length,  // Collect a debt: the "Overdue" filter
    owedLyd: debtors.reduce((sum, row) => sum + row.dueLyd, 0),  // Collect a debt: its total (Home: "Owed")
    month: shellMonthCollected(facts.receipts),  // Home: "Collected this month"
    clothes: typeof clothesOwnerSummary === 'function' ? clothesOwnerSummary() : null  // the Clothes System's own door
  };
}

// The Studio desk's counter as the server hands it over (GET /api/studio/staff/pulse): whole numbers only.
function controlCenterStudioCounts(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const whole = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  const stopRequests = whole(raw.stopRequests);
  return {
    stopRequests,
    waitingReview: whole(raw.waitingReview),
    // A stop request opens a queue row and a ticket: it is counted once, on its own line.
    otherTickets: Math.max(0, whole(raw.openTickets) - whole(raw.stopTicketsOpen)),
    paymentsWaiting: whole(raw.paymentsWaiting),
    alerts: whole(raw.alerts)
  };
}

// "Needs you today": one line per kind of waiting work, grouped by area. A line exists only while its
// count is above zero. `count` is the length of the list its button opens (a money line counts as one).
function getControlCenterAttention(today, studio) {
  const { facts, delivery, clothes } = today;
  const one = (count, single, many) => (count === 1 ? single : many);
  const groups = [];
  const group = (id, title, lines) => { const shown = lines.filter(Boolean); if (shown.length) groups.push({ id, title, lines: shown }); };
  const line = (id, count, tone, title, detail, label, open, icon = '') => (count > 0 ? { id, count, tone, title, detail, label, open, icon } : null);
  const unpriced = Number(facts.snapshot?.unpricedSpendUSD) || 0;

  group('office', ccText('Office', 'المكتب'), [
    line('ads-setup', facts.setupAds.length, 'amber',
      ccText(one(facts.setupAds.length, 'ad needs setup', 'ads need setup'), one(facts.setupAds.length, 'إعلان يحتاج استكمال البيانات', 'إعلانات تحتاج استكمال البيانات')),
      ccText('Add the customer, selling amount, payment and receipt.', 'أضف العميل وسعر البيع وبيانات الدفع والوصل.'),
      ccText('Open ads', 'فتح الإعلانات'), "controlCenterOpenAds('setup')"),
    line('receipts-unpaid', facts.unpaidReceipts.length, 'rose',
      ccText(one(facts.unpaidReceipts.length, 'receipt is unpaid', 'receipts are unpaid'), one(facts.unpaidReceipts.length, 'وصل غير مدفوع', 'وصولات غير مدفوعة')),
      ccText('Money customers still owe.', 'مبالغ لا تزال مستحقة على العملاء.'),
      ccText('Open receipts', 'فتح الوصولات'), 'controlCenterOpenReceipts()'),
    line('unpriced-spend', unpriced > 0.005 ? 1 : 0, 'rose',
      ccText(`$${controlCenterMoney(unpriced)} of Meta spend has no purchase cost`, `إنفاق ميتا بقيمة ${controlCenterMoney(unpriced)} دولار دون تكلفة شراء مسجلة`),
      ccText('Record the real dollar purchase so profit is not guessed.', 'سجّل التكلفة الفعلية لشراء الدولار حتى لا يُحسب الربح بالتخمين.'),
      ccText('Fix profit data', 'استكمال بيانات الربح'), "navigateTo('analytics')", 'circle-dollar-sign'),
    line('meta-duplicates', facts.metaDuplicates.length, 'amber',
      ccText(one(facts.metaDuplicates.length, 'ad shares its Meta ad with another', 'ads share one Meta ad'), one(facts.metaDuplicates.length, 'إعلان مرتبط بإعلان ميتا مستخدم في إعلان آخر', 'إعلانات مرتبطة بنفس إعلان ميتا')),
      ccText('Unlink the duplicate so both can sync again.', 'افصل الإعلان المكرر ليعود التزامن للاثنين.'),
      ccText('Review', 'مراجعة'), "navigateTo('ads')"),
    line('meta-retry', facts.metaFailures.length, 'rose',
      ccText(one(facts.metaFailures.length, 'Meta sync item needs a retry', 'Meta sync items need a retry'), one(facts.metaFailures.length, 'عنصر مزامنة ميتا يحتاج إعادة المحاولة', 'عناصر مزامنة ميتا تحتاج إعادة المحاولة')),
      ccText('The server keeps retrying; open Ads to inspect the affected rows.', 'يواصل الخادم إعادة المحاولة؛ افتح الإعلانات لمراجعة العناصر المتأثرة.'),
      ccText('Review', 'مراجعة'), "navigateTo('ads')"),
    line('reconciliation', today.reconciliation, 'blue',
      ccText(one(today.reconciliation, 'finished ad is waiting for reconciliation', 'finished ads are waiting for reconciliation'), one(today.reconciliation, 'إعلان منتهٍ بانتظار التسوية', 'إعلانات منتهية بانتظار التسوية')),
      ccText('Enter the real spend and return the rest.', 'أدخل الإنفاق الفعلي وأعد الباقي.'),
      ccText('Open', 'فتح'), "navigateTo('reconciliation')")
  ]);

  group('deliveries', ccText('Deliveries', 'التوصيل'), [
    line('delivery-unassigned', delivery.pendingAssignment, 'amber',
      ccText(one(delivery.pendingAssignment, 'delivery is waiting for a driver', 'deliveries are waiting for a driver'), one(delivery.pendingAssignment, 'توصيلة بانتظار تعيين سائق', 'توصيلات بانتظار تعيين سائق')),
      '', ccText('Assign', 'تعيين'), 'controlCenterOpenDeliveries()'),
    line('driver-cash', delivery.heldByDrivers, 'amber',
      ccText(one(delivery.heldByDrivers, 'delivery has cash still with its driver', 'deliveries have cash still with drivers'), one(delivery.heldByDrivers, 'توصيلة نقدها لا يزال مع السائق', 'توصيلات نقدها لا يزال مع السائقين')),
      ccText(`${controlCenterLyd(delivery.driverCashLYD)} not yet handed to the office.`, `${controlCenterLyd(delivery.driverCashLYD)} لم تُسلَّم للمكتب بعد.`),
      ccText('Open deliveries', 'فتح التوصيل'), 'controlCenterOpenDeliveries()')
  ]);

  group('collections', ccText('Collections', 'التحصيل'), [
    line('overdue', today.overdue, 'rose',
      ccText(one(today.overdue, 'customer is overdue', 'customers are overdue'), one(today.overdue, 'عميل متأخر عن السداد', 'عملاء متأخرون عن السداد')),
      ccText(`Oldest unpaid receipt older than ${SHELL_OVERDUE_DAYS} days.`, `أقدم وصل غير مدفوع تجاوز ${SHELL_OVERDUE_DAYS} يوماً.`),
      ccText('Collect', 'تحصيل'), 'controlCenterOpenOverdue()')
  ]);

  if (studio) {
    group('studio', ccText('Ads Studio', 'استوديو الإعلانات'), [
      // First in its group: a customer is waiting for their money to stop being spent.
      line('studio-stop', studio.stopRequests, 'rose',
        ccText(one(studio.stopRequests, 'stop request', 'stop requests'), one(studio.stopRequests, 'طلب إيقاف', 'طلبات إيقاف')),
        ccText('A customer asked to stop a running ad.', 'عميل طلب إيقاف إعلان يعمل.'),
        ccText('Open', 'فتح'), "controlCenterOpenDesk('tickets')"),
      line('studio-review', studio.waitingReview, 'blue',
        ccText(one(studio.waitingReview, 'request is waiting for review', 'requests are waiting for review'), one(studio.waitingReview, 'طلب بانتظار المراجعة', 'طلبات بانتظار المراجعة')),
        '', ccText('Review', 'مراجعة'), "controlCenterOpenDesk('requests')"),
      line('studio-payments', studio.paymentsWaiting, 'amber',
        ccText(one(studio.paymentsWaiting, 'payment is waiting for your confirmation', 'payments are waiting for your confirmation'), one(studio.paymentsWaiting, 'دفعة بانتظار تأكيدك', 'دفعات بانتظار تأكيدك')),
        '', ccText('Confirm', 'تأكيد'), "controlCenterOpenDesk('more')"),
      line('studio-tickets', studio.otherTickets, 'blue',
        ccText(one(studio.otherTickets, 'ticket is waiting for the team', 'tickets are waiting for the team'), one(studio.otherTickets, 'تذكرة بانتظار الفريق', 'تذاكر بانتظار الفريق')),
        ccText('Not counting stop requests.', 'دون طلبات الإيقاف.'),
        ccText('Answer', 'الرد'), "controlCenterOpenDesk('tickets')"),
      line('studio-alerts', studio.alerts, 'amber',
        ccText(one(studio.alerts, 'Studio alert', 'Studio alerts'), one(studio.alerts, 'تنبيه في الاستوديو', 'تنبيهات في الاستوديو')),
        ccText('From the last 24 hours, not yet acknowledged.', 'من آخر 24 ساعة، لم يُطّلع عليها بعد.'),
        ccText('Open health', 'فتح الحالة'), "controlCenterOpenDesk('health')")
    ]);
  }

  if (clothes) {
    const owed = Number(clothes.owedLYD) || 0;
    const few = Number(clothes.lowStockAt) || 0;
    group('clothes', ccText('Clothes', 'الملابس'), [
      line('clothes-low', Number(clothes.lowStock) || 0, 'amber',
        ccText(one(clothes.lowStock, 'item is running low', 'items are running low'), one(clothes.lowStock, 'صنف يوشك على النفاد', 'أصناف توشك على النفاد')),
        ccText(`${few === 2 ? 'Two' : few} pieces or fewer.`, few === 2 ? 'قطعتان أو أقل.' : `${few} قطع أو أقل.`),
        ccText('Open products', 'فتح البضاعة'), "controlCenterOpenAddress('clothes-system', 'tab=products')"),
      line('clothes-owed', owed > 0.005 ? 1 : 0, 'rose',
        ccText(`Customers still owe ${controlCenterLyd(owed)} on Clothes orders`, `متبقٍ عند الزبائن ${controlCenterLyd(owed)} في طلبات الملابس`),
        '', ccText('Open orders', 'فتح الطلبات'), "controlCenterOpenAddress('clothes-system', 'tab=orders')", 'banknote')
    ]);
  }
  return groups;
}

async function loadControlCenterStatus(force = false) {
  if (_controlCenter.loading) return;
  if (!force && _controlCenter.loadedAt && Date.now() - _controlCenter.loadedAt < 60000) return;
  // Local mode has no server to ask: the lines the browser works out stay, the rest says so.
  if (!isServerModeEnabled()) { _controlCenter.loadedAt = Date.now(); return; }
  _controlCenter.loading = true;
  _controlCenter.error = '';
  if (state.currentView === 'control-center') RenderQueue.schedule('control-center-loading');
  try {
    // The Studio hands the dashboard its desk counter through its own server door (counts only).
    const [operations, meta, studio] = await Promise.allSettled([apiOperationsStatus(), apiMetaAdsStatus(), apiJson('/api/studio/staff/pulse', { method: 'GET' }, { timeoutMs: 15000 })]);
    const errors = [];
    if (operations.status === 'fulfilled') _controlCenter.operations = operations.value;
    else errors.push(`${ccText('Server checks', 'فحوصات الخادم')}: ${ccErrorText(operations.reason, 'unavailable', 'غير متاحة')}`);
    if (meta.status === 'fulfilled') _controlCenter.meta = meta.value;
    else errors.push(`${ccText('Meta', 'ميتا')}: ${ccErrorText(meta.reason, 'unavailable', 'غير متاحة')}`);
    _controlCenter.studio = studio.status === 'fulfilled' ? controlCenterStudioCounts(studio.value) : null;
    _controlCenter.studioFailed = !_controlCenter.studio;
    _controlCenter.error = errors.join(' | ');
    _controlCenter.loadedAt = Date.now();
  } catch (error) {
    _controlCenter.error = ccErrorText(error, 'Could not load the server checks', 'تعذّر تحميل فحوصات الخادم');
  } finally {
    _controlCenter.loading = false;
    if (state.currentView === 'control-center') RenderQueue.schedule('control-center-loaded');
  }
}

function refreshControlCenter() {
  _controlCenter.loadedAt = 0;
  loadControlCenterStatus(true);
}

function controlCenterOpenAds(mode) {
  state.adFilters = { status: 'all', payment: 'all', page: 'all' };
  if (mode === 'setup') state.adFilters.payment = 'pending_setup';
  if (mode === 'unpaid') state.adFilters.payment = 'not_paid';
  navigateTo('ads');
}

function controlCenterOpenReceipts() {
  state.receiptStatusFilter = 'unpaid';
  state.receiptPaymentFilter = 'all';
  navigateTo('receipts');
}

function controlCenterOpenDeliveries() {
  state.deliveryFilter = {};
  navigateTo('deliveries');
}

// Collect a debt, already on its own "Overdue" filter.
function controlCenterOpenOverdue() {
  navigateTo('collect');
  if (state.currentView === 'collect') collectSetFilter('overdue');
}

// Opens a screen at its own address, the way a bookmark would: the screen (or its system, once its
// bundle has loaded) reads its tab from the address. The dashboard never reaches into a system.
function controlCenterOpenAddress(view, query) {
  openAddress(view, query);
}

// The Ads Studio team desk, at one of its own sections (requests, tickets, health, more).
function controlCenterOpenDesk(section) {
  controlCenterOpenAddress('ads-studio', `tab=review&section=${encodeURIComponent(section)}`);
}

function controlCenterSetTab(tab) {
  _controlCenter.tab = tab === 'system' ? 'system' : 'today';
  render();
}

function controlCenterChosenPeriod() {
  return String(document.getElementById('control-center-period')?.value || _controlCenter.period || controlCenterPreviousMonth());
}

// Where each month-close check leads, so its line can open the list behind it.
const CONTROL_CENTER_BLOCKER_OPEN = {
  ads_need_setup: ["controlCenterOpenAds('setup')", 'Open ads', 'فتح الإعلانات'],
  unpaid_receipts: ['controlCenterOpenReceipts()', 'Open receipts', 'فتح الوصولات'],
  ads_still_running: ["navigateTo('ads')", 'Open ads', 'فتح الإعلانات'],
  deliveries_open: ['controlCenterOpenDeliveries()', 'Open deliveries', 'فتح التوصيل'],
  driver_cash_not_handed_over: ['controlCenterOpenDeliveries()', 'Open deliveries', 'فتح التوصيل']
};
// What a check reads when it found nothing.
const CONTROL_CENTER_BLOCKER_CLEAR = {
  ads_need_setup: ['No ads need setup', 'لا إعلانات تحتاج استكمال البيانات'],
  unpaid_receipts: ['No receipts are unpaid', 'لا وصولات غير مدفوعة'],
  ads_still_running: ['No ads from this month are still running', 'لا إعلانات من هذا الشهر ما زالت تعمل'],
  deliveries_open: ['No delivery jobs from this month are open', 'لا مهام توصيل مفتوحة من هذا الشهر'],
  driver_cash_not_handed_over: ['No driver holds cash from this month', 'لا نقود من هذا الشهر مع السائقين']
};

function controlCenterBlockerName(item) {
  const pair = CONTROL_CENTER_BLOCKER_TEXT[String(item?.code || '')];
  return Array.isArray(pair) ? ccText(pair[0], pair[1]) : String(item?.message || item?.code || '');
}

// "Check month": the server's read-only preview. Its totals and its five checks are shown on the
// screen as lines (they used to be text inside a browser alert box).
async function previewControlCenterMonth() {
  const period = controlCenterChosenPeriod();
  if (_controlCenter.checking) return;
  _controlCenter.checking = true;
  if (state.currentView === 'control-center') render();
  try {
    const preview = await apiPreviewFinancialPeriod(period);
    _controlCenter.check = { period, totals: preview?.totals || {}, blockers: Array.isArray(preview?.blockers) ? preview.blockers : [] };
  } catch (error) {
    showNotification(ccText('Month check failed', 'فشل فحص الشهر'), ccErrorText(error, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _controlCenter.checking = false;
    if (state.currentView === 'control-center') render();
  }
}

// "Close month": a fresh check first, then the app's own confirmation. With open checks the server
// requires a written reason (at least 10 characters); the dialog asks for it. No rule lives here.
async function closeControlCenterMonth() {
  const period = controlCenterChosenPeriod();
  try {
    const preview = await apiPreviewFinancialPeriod(period);
    const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
    _controlCenter.check = { period, totals: preview?.totals || {}, blockers };
    openControlCenterDialog({ kind: 'close', period, blockers });
  } catch (error) {
    showNotification(ccText('Could not close month', 'تعذر إقفال الشهر'), ccErrorText(error, 'Please try again.', 'لم يُقفل الشهر. راجع فحص الشهر ثم حاول مرة أخرى.'), 'error');
  }
}

// "Unlock": the server requires a written reason; the dialog asks for it.
function unlockControlCenterMonth(period) {
  openControlCenterDialog({ kind: 'unlock', period: String(period || ''), blockers: [] });
}

// ---- The dashboard's confirmation dialog (month close, month unlock) ----
// The app's own dialog instead of the browser's confirm and prompt boxes: it names the month, lists
// what is still open, and takes the written reason the server already requires.

function controlCenterDialogNeedsReason(dialog) {
  return dialog.kind === 'unlock' || dialog.blockers.length > 0;
}

function renderControlCenterDialog(dialog) {
  const month = Security.escapeHtml(controlCenterMonthName(dialog.period));
  const closing = dialog.kind === 'close';
  const needsReason = controlCenterDialogNeedsReason(dialog);
  const title = closing ? ccText(`Close ${month}?`, `إقفال ${month}؟`) : ccText(`Unlock ${month}?`, `فتح ${month}؟`);
  const lead = closing
    ? ccText('After closing, its receipts, ads and dollar purchases cannot be changed.', 'بعد الإقفال لا يمكن تعديل وصولاته وإعلاناته ومشتريات الدولار.')
    : ccText('Its receipts, ads and dollar purchases can be corrected again. Close it again when finished.', 'يمكن تصحيح وصولاته وإعلاناته ومشتريات الدولار من جديد. أقفله مجدداً عند الانتهاء.');
  const open = dialog.blockers.map(item => `<li><span>${Security.escapeHtml(controlCenterBlockerName(item))}</span><strong>${Number(item?.count) || 0}</strong></li>`).join('');
  const reasonLabel = closing ? ccText('Reason for closing with open items', 'سبب الإقفال مع وجود عناصر مفتوحة') : ccText('Reason for unlocking', 'سبب الفتح');
  const confirm = closing ? ccText(`Close ${month}`, `إقفال ${month}`) : ccText(`Unlock ${month}`, `فتح ${month}`);
  return `
    <div class="app-dialog-panel glass-panel w-full max-w-lg" dir="${state.language === 'ar' ? 'rtl' : 'ltr'}">
      <div class="app-dialog-titlebar">
        <h2 id="control-center-dialog-title" class="app-dialog-title">${title}</h2>
        <button type="button" onclick="closeControlCenterDialog()" class="app-dialog-close" aria-label="${ccText('Close', 'إغلاق')}"><i data-lucide="x" class="h-5 w-5"></i></button>
      </div>
      <p id="control-center-dialog-lead" class="management-dialog-lead">${lead}</p>
      ${open ? `<p class="management-dialog-note">${ccText('Still open in this month:', 'ما زال مفتوحاً في هذا الشهر:')}</p><ul class="management-dialog-list">${open}</ul>` : ''}
      ${needsReason ? `
        <label for="control-center-dialog-reason" class="management-field-label">${reasonLabel}</label>
        <textarea id="control-center-dialog-reason" rows="3" maxlength="500" dir="auto" class="glass-input w-full rounded-xl px-3 py-2" aria-describedby="control-center-dialog-hint" oninput="controlCenterDialogTyped()"></textarea>
        <p id="control-center-dialog-hint" class="management-dialog-note">${ccText('At least 10 characters. Recorded in the audit log.', '10 أحرف على الأقل. يُسجَّل في سجل التدقيق.')}</p>` : ''}
      <p id="control-center-dialog-error" class="management-dialog-error" role="alert" hidden></p>
      <div class="management-button-row">
        <button type="button" onclick="closeControlCenterDialog()" class="app-dialog-cancel management-button">${ccText('Cancel', 'إلغاء')}</button>
        <button type="button" id="control-center-dialog-confirm" onclick="confirmControlCenterDialog()" class="management-button is-primary" ${needsReason ? 'disabled' : ''}>${confirm}</button>
      </div>
    </div>`;
}

function openControlCenterDialog(dialog) {
  closeControlCenterDialog(true);
  let opener = null;
  try { opener = document.activeElement || null; } catch (_) {}
  _controlCenter.dialog = { ...dialog, busy: false, opener };
  const host = document.createElement('div');
  host.id = 'control-center-dialog';
  host.className = 'mobile-dialog-overlay app-dialog-overlay fixed inset-0 z-[80] flex items-center justify-center p-4';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'control-center-dialog-title');
  host.setAttribute('aria-describedby', 'control-center-dialog-lead');
  host.innerHTML = renderControlCenterDialog(_controlCenter.dialog);
  host.onclick = event => { if (event.target === host) closeControlCenterDialog(); };
  host.onkeydown = controlCenterDialogKeydown;
  document.body.appendChild(host);
  try { if (typeof IconQueue !== 'undefined') IconQueue.schedule(host); } catch (_) {}
  // The reason field first (there is something to type), else Cancel: never the confirming button.
  try { (host.querySelector('#control-center-dialog-reason') || host.querySelector('.app-dialog-cancel'))?.focus(); } catch (_) {}
}

function closeControlCenterDialog(force = false) {
  const dialog = _controlCenter.dialog;
  if (dialog?.busy && !force) return false;
  _controlCenter.dialog = null;
  try { document.getElementById('control-center-dialog')?.remove(); } catch (_) {}
  if (dialog && !force) { try { dialog.opener?.focus?.(); } catch (_) {} }
  return true;
}

// Escape closes; Tab stays inside the dialog.
function controlCenterDialogKeydown(event) {
  const host = document.getElementById('control-center-dialog');
  if (!host) return;
  if (event.key === 'Escape') { event.preventDefault(); closeControlCenterDialog(); return; }
  if (event.key !== 'Tab') return;
  const stops = Array.from(host.querySelectorAll('button:not([disabled]), textarea:not([disabled])'));
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// The confirming button wakes up once the reason is long enough (the server's own minimum).
function controlCenterDialogTyped() {
  const reason = String(document.getElementById('control-center-dialog-reason')?.value || '').trim();
  const confirm = document.getElementById('control-center-dialog-confirm');
  if (confirm) confirm.disabled = reason.length < 10 || !!_controlCenter.dialog?.busy;
}

async function confirmControlCenterDialog() {
  const dialog = _controlCenter.dialog;
  if (!dialog || dialog.busy) return;
  const reason = String(document.getElementById('control-center-dialog-reason')?.value || '').trim();
  const problem = document.getElementById('control-center-dialog-error');
  if (controlCenterDialogNeedsReason(dialog) && reason.length < 10) {
    if (problem) { problem.textContent = ccText('Please write at least 10 characters.', 'اكتب 10 أحرف على الأقل.'); problem.hidden = false; }
    return;
  }
  dialog.busy = true;
  const confirm = document.getElementById('control-center-dialog-confirm');
  if (confirm) confirm.disabled = true;
  const closing = dialog.kind === 'close';
  const period = dialog.period;
  try {
    if (closing) await apiCloseFinancialPeriod(period, reason);
    else await apiUnlockFinancialPeriod(period, reason);
    closeControlCenterDialog(true);
    _controlCenter.check = null;
    if (closing) showNotification(ccText('Month closed safely', 'تم إقفال الشهر بأمان'), ccText(`${period} is now protected from changes.`, `${period} أصبح محمياً من التعديل.`), 'success');
    else showNotification(ccText('Month unlocked', 'تم فتح الشهر'), ccText(`${period} can be corrected now. Close it again when finished.`, `يمكن تصحيح ${period} الآن. أقفله مجدداً عند الانتهاء.`), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    // The dialog stays open with what was typed; the server's refusal is shown in it.
    dialog.busy = false;
    if (confirm) confirm.disabled = false;
    const text = closing
      ? ccErrorText(error, 'The month was not closed. Please try again.', 'لم يُقفل الشهر. راجع فحص الشهر ثم حاول مرة أخرى.')
      : ccErrorText(error, 'The month was not unlocked. Please try again.', 'لم يُفتح الشهر. حاول مرة أخرى.');
    if (problem) { problem.textContent = text; problem.hidden = false; }
    else showNotification(closing ? ccText('Could not close month', 'تعذر إقفال الشهر') : ccText('Could not unlock month', 'تعذر فتح الشهر'), text, 'error');
  }
}

async function runControlCenterBackup() {
  try {
    showNotification(ccText('Backup started', 'بدأ النسخ الاحتياطي'), ccText('Please keep this page open while the server creates the encrypted copy.', 'أبقِ هذه الصفحة مفتوحة بينما ينشئ الخادم النسخة المشفرة.'), 'info');
    const response = await apiRunEncryptedBackup();
    // The server answers 200 when the local copy was saved but the off-site upload failed.
    if (response?.backup?.offsiteError) showNotification(ccText('Saved on this server only', 'حُفظت على هذا الخادم فقط'), `${ccText('The off-site copy failed:', 'فشلت النسخة الخارجية:')} ${String(response.backup.offsiteError)}`, 'warning');
    else showNotification(ccText('Backup complete', 'اكتمل النسخ الاحتياطي'), response?.backup?.offsite ? ccText('Encrypted backup saved locally and off-site.', 'حُفظت النسخة المشفرة محلياً وخارجياً.') : ccText('Encrypted backup saved.', 'حُفظت النسخة المشفرة.'), 'success');
    await loadControlCenterStatus(true);
  } catch (error) {
    // 409: a backup is already running (the daily one, or an earlier press) - busy, not failed.
    if (error?.status === 409) showNotification(ccText('Backup already running', 'النسخ الاحتياطي يعمل الآن'), ccText('It will appear under Last backup when it finishes.', 'ستظهر تحت «آخر نسخة» عند انتهائه.'), 'info');
    else showNotification(ccText('Backup failed', 'فشل النسخ الاحتياطي'), ccErrorText(error, 'Please try again.', 'لم تُنشأ النسخة. حاول مرة أخرى.'), 'error');
  }
}

// ---- Subscription plans manager (owner pricing without redeploys) ----
let _planManager = { loading: false, loadedAt: 0, failedAt: 0, version: 0, plans: [], error: '', dirty: false, saving: false, addOpen: false };
// Mirrors the server's KNOWN_SERVICE_IDS; the server re-validates anyway.
const PLAN_MANAGER_SERVICE_IDS = ['international_shipping', 'local_shipping', 'warehouse', 'smart_systems', 'clothes_system', 'ad_maker'];

// The service's own name in the screen language (the raw id, e.g. clothes_system, showed in Arabic too).
function planManagerServiceName(serviceId) {
  // A Smart System sold on its own (Clothes, Ads Studio) is named in its own list.
  const service = (typeof SERVICES === 'object' && SERVICES ? SERVICES[String(serviceId)] : null)
    || (typeof SMART_SYSTEMS_CHILDREN === 'object' && SMART_SYSTEMS_CHILDREN ? SMART_SYSTEMS_CHILDREN[String(serviceId)] : null);
  if (!service) return String(serviceId);
  return String((state.language === 'ar' ? service.nameAr : service.name) || serviceId);
}

async function loadPlanManager(force = false) {
  if (_planManager.loading || !isServerModeEnabled()) return;
  if (!force && _planManager.loadedAt && Date.now() - _planManager.loadedAt < 60000) return;
  if (!force && _planManager.dirty) return; // never clobber unsaved edits
  // After a failure only Reload asks at once: every render re-asked, looping while offline.
  if (!force && _planManager.failedAt && Date.now() - _planManager.failedAt < 30000) return;
  _planManager.loading = true;
  _planManager.error = '';
  try {
    const payload = await apiJson('/api/admin/subscription-plans', { method: 'GET' });
    _planManager.plans = Array.isArray(payload?.plans) ? payload.plans : [];
    _planManager.version = Number(payload?.version || 0);
    _planManager.loadedAt = Date.now();
    _planManager.failedAt = 0;
    _planManager.dirty = false;
  } catch (error) {
    _planManager.failedAt = Date.now();
    _planManager.error = ccErrorText(error, 'Could not load the plan catalog', 'تعذّر تحميل كتالوج الخطط');
  } finally {
    _planManager.loading = false;
    if (state.currentView === 'control-center') render();
  }
}

function planManagerSetField(index, field, value) {
  const plan = _planManager.plans[Number(index)];
  if (!plan) return;
  if (field === 'priceLYD') {
    // A half-typed or malformed price ("12.", "1,234.50", "") must never
    // silently become 0 and turn a paid plan into a free one; keep the
    // previous price until the input parses.
    const raw = String(value ?? '').trim().replace(',', '.');
    const parsed = Number(raw);
    plan._priceText = String(value ?? '').slice(0, 20);  // a redraw shows what was typed ("12."), not "12.00"
    if (raw === '' || !Number.isFinite(parsed)) return;
    plan.priceMinor = Math.max(0, Math.round(parsed * 100));
  }
  else if (field === 'durationDays') plan.durationDays = Math.max(1, Math.min(3660, Math.trunc(Number(value) || 30)));
  else if (field === 'sortOrder') plan.sortOrder = Math.trunc(Number(value) || 0);
  else if (field === 'active') plan.active = value === true;
  else if (field === 'name' || field === 'nameAr') plan[field] = String(value || '').slice(0, 80);
  _planManager.dirty = true;
  // Update in place: no render() while typing (a redraw from elsewhere keeps the focus through the inputs' ids).
  const save = document.getElementById('plan-manager-save');
  if (save) save.disabled = _planManager.saving;
  document.getElementById('plan-manager-dirty')?.classList.remove('hidden');
}

async function planManagerReload() {
  if (_planManager.dirty && !await appConfirm(ccText('Discard unsaved plan changes and reload from the server?', 'تجاهل تغييرات الخطط غير المحفوظة وإعادة التحميل من الخادم؟'))) return;
  return loadPlanManager(true);
}

async function planManagerAddBundle(sure) {
  const read = id => String(document.getElementById(id)?.value || '').trim();
  const rawId = read('plan-new-id').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  const name = read('plan-new-name').slice(0, 80);
  const nameAr = read('plan-new-name-ar').slice(0, 80);
  const services = PLAN_MANAGER_SERVICE_IDS.filter(sid => document.getElementById(`plan-new-svc-${sid}`)?.checked);
  if (rawId.length < 2 || !name || !nameAr || !services.length) {
    showNotification(ccText('Missing details', 'بيانات ناقصة'), ccText('A bundle needs an id, both names, and at least one service.', 'الباقة تحتاج إلى معرّف واسمين وخدمة واحدة على الأقل.'), 'warning');
    return;
  }
  if (_planManager.plans.some(p => String(p.id) === rawId)) {
    showNotification(ccText('Duplicate id', 'معرّف مكرر'), ccText('A plan with this id already exists.', 'توجد خطة بهذا المعرّف بالفعل.'), 'warning');
    return;
  }
  // An empty or unreadable price (a number box reports '' for "abc") must never silently
  // become a free bundle (as in planManagerSetField); a 0 LYD one is added only after a yes.
  const rawPrice = read('plan-new-price').replace(',', '.');
  const parsedPrice = Number(rawPrice);
  if (rawPrice === '' || !Number.isFinite(parsedPrice) || parsedPrice < 0 || parsedPrice > 1e10) {  // the server takes up to 1e12 minor
    showNotification(ccText('Enter the bundle price', 'أدخل سعر الباقة'), ccText('Type the price in LYD as a number, for example 150. Nothing was added.', 'اكتب السعر بالدينار كرقم، مثلاً 150. لم تتم إضافة الباقة.'), 'warning');
    return;
  }
  const priceMinor = Math.max(0, Math.round(parsedPrice * 100));
  // Asked once; after a yes the form is read and checked again.
  if (priceMinor === 0 && !sure) return await appConfirm(ccText('This bundle will be free for customers - add it anyway?', 'ستكون هذه الباقة مجانية للعملاء - هل تريد إضافتها على أي حال؟')) && planManagerAddBundle(1);
  _planManager.plans.push({
    id: rawId,
    serviceIds: services,
    name,
    nameAr,
    priceMinor,
    currency: 'LYD',
    durationDays: Math.max(1, Math.min(3660, Math.trunc(Number(read('plan-new-days')) || 30))),
    badge: services.length > 1 ? 'best_value' : null,
    savingsPct: null,
    active: true,
    sortOrder: 0
  });
  _planManager.dirty = true;
  render();
}

async function savePlanManager() {
  if (!_planManager.plans.length || _planManager.saving) return;
  _planManager.saving = true;
  const sentPlans = JSON.stringify(_planManager.plans);
  if (state.currentView === 'control-center') render();
  try {
    const payload = await apiAdminSaveSubscriptionPlans(_planManager.plans.map(p => ({
      id: String(p.id),
      serviceIds: Array.isArray(p.serviceIds) ? p.serviceIds : [],
      name: String(p.name || ''),
      nameAr: String(p.nameAr || ''),
      priceMinor: Math.max(0, Math.trunc(Number(p.priceMinor) || 0)),
      currency: 'LYD',
      durationDays: Math.max(1, Math.min(3660, Math.trunc(Number(p.durationDays) || 30))),
      badge: p.badge || null,
      savingsPct: Number.isFinite(Number(p.savingsPct)) && p.savingsPct !== null && p.savingsPct !== '' ? Math.trunc(Number(p.savingsPct)) : null,
      active: p.active !== false,
      sortOrder: Math.trunc(Number(p.sortOrder) || 0)
    })), _planManager.version);
    _planManager.version = Number(payload?.version || _planManager.version + 1);
    // Typed while this save was on its way: before, the reload below replaced it with the server's
    // copy and the "unsaved" hint went away without a word. It stays, marked unsaved, for the next save.
    const editedMeanwhile = JSON.stringify(_planManager.plans) !== sentPlans;
    _planManager.dirty = editedMeanwhile;
    _planManager.loadedAt = editedMeanwhile ? Date.now() : 0;
    showNotification(ccText('Plans saved', 'تم حفظ الخطط'), ccText(`Catalog version ${_planManager.version} is live — new purchases use it immediately.`, `الإصدار ${_planManager.version} من الكتالوج أصبح فعالاً — المشتريات الجديدة تستخدمه فوراً.`), 'success');
    if (typeof refreshSubscriptionPlans === 'function') refreshSubscriptionPlans(true).catch(() => {});
    if (!editedMeanwhile) loadPlanManager(true);
  } catch (error) {
    showNotification(ccText('Could not save plans', 'تعذر حفظ الخطط'), ccErrorText(error, 'Save failed', 'لم تُحفظ الخطط. أعد التحميل ثم حاول مرة أخرى.'), 'error');
  } finally {
    _planManager.saving = false;
    if (state.currentView === 'control-center') render();
  }
}

function renderPlanManagerSection() {
  if (!isServerModeEnabled()) return '';
  const rows = _planManager.plans.map((plan, index) => {
    const safeName = Security.escapeHtml(String(plan.name || plan.id));
    const services = (Array.isArray(plan.serviceIds) ? plan.serviceIds : []).map(planManagerServiceName).join(' + ');
    return `
      <div class="management-plan-row grid grid-cols-2 items-center gap-2 rounded-xl bg-slate-100 p-3 text-sm dark:bg-slate-800 sm:grid-cols-[1.2fr_1fr_90px_80px_70px_70px]">
        <div class="min-w-0">
          <input aria-label="${state.language === 'ar' ? 'اسم الخطة بالإنجليزية' : 'Plan name in English'}" id="plan-${index}-name" value="${safeName}" oninput="planManagerSetField(${index}, 'name', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 font-bold text-slate-800 focus:border-indigo-300 dark:text-white" />
          <input aria-label="${state.language === 'ar' ? 'اسم الخطة بالعربية' : 'Plan name in Arabic'}" value="${Security.escapeHtml(String(plan.nameAr || ''))}" id="plan-${index}-name-ar" dir="rtl" oninput="planManagerSetField(${index}, 'nameAr', this.value)" class="w-full rounded-lg border border-transparent bg-transparent px-1 text-xs text-slate-500 focus:border-indigo-300" />
        </div>
        <div class="truncate text-xs text-slate-500" title="${Security.escapeHtml(String(plan.id))}">${Security.escapeHtml(services)}</div>
        <label class="text-xs text-slate-500 sm:text-right">LYD<input id="plan-${index}-price" type="number" min="0" step="0.01" value="${Security.escapeHtml(String(plan._priceText ?? (Math.max(0, Number(plan.priceMinor) || 0) / 100).toFixed(2)))}" oninput="planManagerSetField(${index}, 'priceLYD', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono font-bold dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="text-xs text-slate-500 sm:text-right">${ccText('Days', 'الأيام')}<input id="plan-${index}-days" type="number" min="1" max="3660" value="${Math.max(1, Number(plan.durationDays) || 30)}" oninput="planManagerSetField(${index}, 'durationDays', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="text-xs text-slate-500 sm:text-right">${ccText('Order', 'الترتيب')}<input id="plan-${index}-order" type="number" value="${Math.trunc(Number(plan.sortOrder) || 0)}" oninput="planManagerSetField(${index}, 'sortOrder', this.value)" class="min-h-10 w-full rounded-lg border border-slate-300 px-2 font-mono dark:border-slate-700 dark:bg-slate-900" /></label>
        <label class="flex items-center justify-end gap-1 text-xs font-bold ${plan.active !== false ? 'text-emerald-600' : 'text-slate-400'}"><input type="checkbox" ${plan.active !== false ? 'checked' : ''} onchange="planManagerSetField(${index}, 'active', this.checked)" class="h-5 w-5 accent-emerald-600" />${ccText('On', 'مفعّلة')}</label>
      </div>`;
  }).join('');
  return `
      <section class="glass-panel rounded-3xl p-5 sm:p-6">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><div class="flex items-center gap-2"><i data-lucide="badge-dollar-sign" class="h-5 w-5 text-emerald-600"></i><h2 class="text-xl font-black text-slate-900 dark:text-white">${ccText('Subscription plans & prices', 'خطط الاشتراك والأسعار')}</h2></div>
          <p class="mt-1 text-sm text-slate-500">${ccText('Prices are LYD and live on the server — saving here changes what customers pay next, never what they already bought. Catalog version:', 'الأسعار بالدينار ومحفوظة على الخادم — الحفظ هنا يغيّر ما يدفعه العملاء لاحقاً، ولا يغيّر ما اشتروه سابقاً. إصدار الكتالوج:')} ${Number(_planManager.version) || 0}<span id="plan-manager-dirty"${_planManager.dirty ? '' : ' class="hidden"'}> · <span class="font-bold text-amber-600">${ccText('unsaved changes', 'تغييرات غير محفوظة')}</span></span></p></div>
          <div class="flex gap-2">
            <button type="button" onclick="planManagerReload()" class="min-h-11 rounded-xl border border-slate-300 px-4 font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">${ccText('Reload', 'إعادة التحميل')}</button>
            <button type="button" id="plan-manager-save" onclick="savePlanManager()" ${_planManager.dirty && !_planManager.saving ? '' : 'disabled'} class="min-h-11 rounded-xl bg-emerald-600 px-4 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">${ccText('Save all plans', 'حفظ كل الخطط')}</button>
          </div>
        </div>
        ${_planManager.error ? `<div class="mb-3 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">${Security.escapeHtml(_planManager.error)}</div>` : ''}
        <div class="space-y-2">${rows || `<div class="text-sm text-slate-500">${_planManager.loading ? ccText('Loading plans…', 'جارٍ تحميل الخطط…') : ccText('Press Reload to fetch the plan catalog.', 'اضغط «إعادة التحميل» لجلب كتالوج الخطط.')}</div>`}</div>
        <details ${_planManager.addOpen ? 'open' : ''} ontoggle="_planManager.addOpen = this.open" class="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <summary class="cursor-pointer select-none font-bold text-slate-700 dark:text-slate-200">${ccText('Add a bundle (one subscription, many systems)', 'إضافة باقة (اشتراك واحد لعدة أنظمة)')}</summary>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="text-xs font-bold text-slate-500">${ccText('Bundle id (letters/numbers/underscore)', 'معرّف الباقة (حروف إنجليزية/أرقام/شرطة سفلية)')}<input id="plan-new-id" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="pro_bundle" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Price (LYD)', 'السعر (د.ل)')}<input id="plan-new-price" type="number" min="0" step="0.01" required class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="150.00" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Name (English)', 'الاسم (بالإنجليزية)')}<input id="plan-new-name" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="Pro Bundle" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Name (Arabic)', 'الاسم (بالعربية)')}<input id="plan-new-name-ar" dir="rtl" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" placeholder="الباقة الاحترافية" /></label>
            <label class="text-xs font-bold text-slate-500">${ccText('Duration (days)', 'المدة (بالأيام)')}<input id="plan-new-days" type="number" min="1" max="3660" value="30" class="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 dark:border-slate-700 dark:bg-slate-900" /></label>
            <div class="text-xs font-bold text-slate-500">${ccText('Included systems', 'الأنظمة المشمولة')}<div class="mt-1 grid grid-cols-2 gap-1">${PLAN_MANAGER_SERVICE_IDS.map(sid => `<label class="flex items-center gap-2 rounded-lg bg-slate-100 px-2 py-1.5 dark:bg-slate-800"><input id="plan-new-svc-${sid}" type="checkbox" class="h-4 w-4 accent-indigo-600" /><span class="truncate">${Security.escapeHtml(planManagerServiceName(sid))}</span></label>`).join('')}</div></div>
          </div>
          <button type="button" onclick="planManagerAddBundle()" class="mt-3 min-h-11 rounded-xl bg-indigo-600 px-4 font-bold text-white">${ccText('Add to list (save to publish)', 'أضف إلى القائمة (احفظ للنشر)')}</button>
        </details>
      </section>`;
}

// ---- Drawing ----

function controlCenterSetPeriod(value) {
  _controlCenter.period = String(value || '');
  // A check belongs to the month it read: another month hides it.
  if (_controlCenter.check && _controlCenter.check.period !== _controlCenter.period) { _controlCenter.check = null; render(); }
}

const CONTROL_CENTER_TONES = { rose: 'is-danger', amber: 'is-warning', blue: 'is-info' };

// One line of "Needs you today": how many, why, and the one button that opens the list behind the number.
function renderControlCenterLine(line) {
  return `
    <li class="management-attention-row" data-attention="${line.id}">
      <span class="management-attention-count ${CONTROL_CENTER_TONES[line.tone] || 'is-info'}">${line.icon ? `<i data-lucide="${line.icon}" class="h-4 w-4" aria-hidden="true"></i>` : `<bdi>${line.count}</bdi>`}</span>
      <span class="management-attention-text"><strong>${Security.escapeHtml(line.title)}</strong>${line.detail ? `<span>${Security.escapeHtml(line.detail)}</span>` : ''}</span>
      <button type="button" onclick="${line.open}" class="management-button">${Security.escapeHtml(line.label)}</button>
    </li>`;
}

// A small coloured word: a dot and the state.
function controlCenterChip(text, tone = '') {
  return `<span class="management-chip ${tone}"><span aria-hidden="true"></span>${Security.escapeHtml(text)}</span>`;
}

function renderControlCenterNeedsServer() {
  return `<p class="management-note">${ccText('Needs the server connection.', 'يحتاج إلى اتصال الخادم.')}</p>`;
}

// The month check on the screen: the totals and the five checks, each a line with its own button.
function renderControlCenterCheck(check) {
  const found = new Map(check.blockers.map(item => [String(item?.code || ''), item]));
  const lines = Object.keys(CONTROL_CENTER_BLOCKER_TEXT).map(code => {
    const item = found.get(code);
    found.delete(code);
    const open = CONTROL_CENTER_BLOCKER_OPEN[code];
    const button = `<button type="button" onclick="${open[0]}" class="management-button">${ccText(open[1], open[2])}</button>`;
    if (!item) return `<li class="is-clear"><span class="management-attention-count is-ok"><i data-lucide="check" class="h-4 w-4" aria-hidden="true"></i></span><span class="management-attention-text"><strong>${ccText(...CONTROL_CENTER_BLOCKER_CLEAR[code])}</strong></span>${button}</li>`;
    return `<li><span class="management-attention-count is-warning"><bdi>${Number(item.count) || 0}</bdi></span><span class="management-attention-text"><strong>${Security.escapeHtml(controlCenterBlockerName(item))}</strong></span>${button}</li>`;
  });
  // A check this screen does not know yet: the server's own sentence, with its count.
  for (const item of found.values()) lines.push(`<li><span class="management-attention-count is-warning"><bdi>${Number(item?.count) || 0}</bdi></span><span class="management-attention-text"><strong>${Security.escapeHtml(controlCenterBlockerName(item))}</strong></span></li>`);
  const totals = check.totals || {};
  const total = (label, value) => `<div><dt>${label}</dt><dd><bdi>$${controlCenterMoney(value)}</bdi></dd></div>`;
  return `
    <div class="management-check" role="status" data-month-check="${Security.escapeHtml(check.period)}">
      <h3>${Security.escapeHtml(controlCenterMonthName(check.period))}: ${check.blockers.length ? ccText('items to review before closing', 'عناصر للمراجعة قبل الإقفال') : ccText('no closing problems found', 'لا توجد مشاكل تمنع الإقفال')}</h3>
      <dl class="management-check-totals">${total(ccText('Receipts', 'الوصولات'), totals.receiptVolumeUSD)}${total(ccText('Ad sales', 'مبيعات الإعلانات'), totals.adSalesUSD)}${total(ccText('Ad spend (actual)', 'الإنفاق الإعلاني الفعلي'), totals.adSpendUSD ?? totals.metaSpendUSD)}</dl>
      <ul class="management-attention-list">${lines.join('')}</ul>
    </div>`;
}

function renderControlCenterMonthCard(server, operations) {
  const periods = Array.isArray(operations.financialPeriods) ? operations.financialPeriods : [];
  const closed = periods.filter(row => String(row.status || '').toLowerCase() === 'closed');
  const last = controlCenterPreviousMonth();
  const lastClosed = closed.some(row => String(row.period || '') === last);
  const known = !!_controlCenter.operations;
  const lastName = Security.escapeHtml(controlCenterMonthName(last));
  const check = _controlCenter.check && _controlCenter.check.period === _controlCenter.period ? _controlCenter.check : null;
  return `
    <section class="management-card management-month${known && !lastClosed ? ' is-due' : ''}" aria-labelledby="control-center-month-title">
      <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="lock-keyhole" class="h-5 w-5"></i></span><div><h2 id="control-center-month-title">${ccText('Month close', 'إقفال الشهر')}</h2><p>${ccText('Review first, then protect the finished month from accidental edits.', 'راجع الشهر المنتهي ثم احمه من التعديلات غير المقصودة.')}</p></div></div>
      ${!server ? renderControlCenterNeedsServer() : `
      ${known ? (lastClosed ? controlCenterChip(ccText(`${lastName} is closed`, `${lastName} مُقفل`), 'is-ok') : controlCenterChip(ccText(`${lastName} is still open`, `${lastName} لم يُقفل بعد`), 'is-warning')) : ''}
      <label for="control-center-period" class="management-field-label">${ccText('Month', 'الشهر')}</label><input id="control-center-period" type="month" max="${last}" value="${Security.escapeHtml(_controlCenter.period)}" onchange="controlCenterSetPeriod(this.value)" class="management-input">
      <div class="management-button-row"><button type="button" onclick="previewControlCenterMonth()" class="management-button" ${_controlCenter.checking ? 'disabled' : ''}>${_controlCenter.checking ? ccText('Checking…', 'جارٍ الفحص…') : ccText('Check month', 'فحص الشهر')}</button><button type="button" onclick="closeControlCenterMonth()" class="management-button is-primary">${ccText('Close month', 'إقفال الشهر')}</button></div>
      ${check ? renderControlCenterCheck(check) : ''}
      <div class="management-closed-periods">${closed.map(row => `<div data-period="${Security.escapeHtml(String(row.period || ''))}"><span><strong>${Security.escapeHtml(controlCenterMonthName(row.period))}</strong> · ${ccText('Closed', 'مُقفل')}</span><button type="button" onclick="unlockControlCenterMonth('${Security.escapeHtml(String(row.period || ''))}')" class="management-button is-warning">${ccText('Unlock', 'إعادة الفتح')}</button></div>`).join('') || `<p>${ccText('No months have been closed yet.', 'لم يُقفل أي شهر بعد.')}</p>`}</div>`}
    </section>`;
}

// What the server's setup sentences mean in plain words. The sentence itself (in Arabic where known)
// stays behind "Show technical steps" for whoever maintains the server.
const CONTROL_CENTER_SETUP_TASK_PLAIN = {
  'Last backup is overdue - check the backup worker and the log': ['The last backup is overdue.', 'آخر نسخة احتياطية متأخرة.', 'No backup file was made for two backup periods.', 'لم يُنشأ ملف نسخة احتياطية منذ فترتين.'],
  'Enable encrypted daily backups': ['Automatic encrypted backups are off.', 'النسخ الاحتياطي المشفّر التلقائي متوقف.', 'The server is not making a regular backup yet.', 'الخادم لا يُنشئ نسخة احتياطية دورية بعد.'],
  'Add a permanent backup encryption key': ['The backup encryption key is not set.', 'مفتاح تشفير النسخ الاحتياطية غير مضبوط.', 'An encrypted backup cannot be made until it is.', 'لا يمكن إنشاء نسخة مشفّرة قبل ضبطه.'],
  'Connect private S3-compatible off-site storage': ['No copy is kept outside this server.', 'لا توجد نسخة محفوظة خارج هذا الخادم.', 'Backups stay on this server only.', 'تبقى النسخ الاحتياطية على هذا الخادم فقط.'],
  'Off-site backup copy is failing - check the S3 bucket, keys and region': ['The copy outside this server is failing.', 'النسخة خارج هذا الخادم تفشل.', 'Backups are saved on this server only until the upload works again.', 'تُحفظ النسخ على هذا الخادم فقط حتى يعود الرفع للعمل.'],
  'Connect an operations alert webhook': ['Operations alerts are not connected.', 'تنبيهات التشغيل غير موصولة.', 'The server cannot send an alert when a backup or the server has a problem.', 'لا يستطيع الخادم إرسال تنبيه عند مشكلة في النسخ الاحتياطي أو الخادم.']
};

// A setup task: plain words first, the technical detail folded.
function renderControlCenterSetupTask(title, detail, steps, urgent = false) {
  return `
    <li class="management-setup-task${urgent ? ' is-urgent' : ''}">
      <p><strong>${Security.escapeHtml(title)}</strong> ${Security.escapeHtml(detail)}</p>
      ${steps ? `<details><summary>${ccText('Show technical steps', 'عرض الخطوات التقنية')}</summary><p>${Security.escapeHtml(steps)}</p></details>` : ''}
    </li>`;
}

// What both tabs need to know about the server's upkeep, worked out once.
function getControlCenterSystem() {
  const operations = _controlCenter.operations || {};
  const backup = operations.backup || {};
  const monitoring = operations.monitoring || {};
  const meta = _controlCenter.meta || {};
  const isAr = state.language === 'ar';
  const recentRate = Number(monitoring.recent_error_rate ?? monitoring.error_rate ?? 0), recentSample = Number(monitoring.recent_sample_size ?? monitoring.total_requests ?? 0);  // rolling window, not since-boot
  const p95 = Math.round(Number(monitoring.response_ms_p95 || 0));
  // "Connected" only says the S3 settings exist; a failed last upload means no copy outside this server.
  const offsiteFailed = !!(backup.offsiteConfigured && backup.lastOffsiteError);
  const backupConfigured = !!(backup.enabled && backup.encryptionReady && backup.offsiteConfigured && !offsiteFailed);
  const serverErrors = recentRate >= 0.05 && recentSample >= 50;
  const tasks = [];
  if (!meta.webhookConfigured) tasks.push(renderControlCenterSetupTask(
    ccText('Instant Meta notifications are not set up yet.', 'إشعارات ميتا الفورية لم تُضبط بعد.'),
    ccText('The app still checks Meta every few minutes.', 'يواصل التطبيق فحص ميتا كل بضع دقائق.'),
    ccText('Add ALBAYAN_META_WEBHOOK_VERIFY_TOKEN in Jelastic, then subscribe Meta to /api/meta-ads/webhook. Polling remains active until then.', 'أضف ALBAYAN_META_WEBHOOK_VERIFY_TOKEN في Jelastic، ثم اشترك في ميتا على /api/meta-ads/webhook. يبقى الفحص الدوري يعمل حتى ذلك الحين.')));
  if (serverErrors) tasks.push(renderControlCenterSetupTask(
    ccText('The server is reporting errors.', 'الخادم يسجّل أخطاء.'),
    ccText(`${(recentRate * 100).toFixed(1)}% of recent requests failed.`, `فشلت ${(recentRate * 100).toFixed(1)}% من الطلبات الأخيرة.`),
    ccText('Check the Jelastic logs.', 'راجع سجلات Jelastic.'), true));
  if (p95 >= 3000 && Number(monitoring.total_requests || 0) >= 50) tasks.push(renderControlCenterSetupTask(
    ccText('The server is answering slowly.', 'الخادم يستجيب ببطء.'),
    ccText(`The slowest normal requests take about ${p95} ms.`, `أبطأ الطلبات العادية تستغرق نحو ${p95} ms.`),
    ccText('Check database and container resources.', 'راجع موارد قاعدة البيانات والحاوية.')));
  let backupTrouble = offsiteFailed || !!backup.lastBackupError;
  (operations.setupTasks || []).forEach(task => {
    const sentence = String(task);
    const overdue = /overdue/i.test(sentence), failing = /failing/i.test(sentence);
    if (overdue || failing) backupTrouble = true;
    const plain = CONTROL_CENTER_SETUP_TASK_PLAIN[sentence];
    const steps = `${(isAr && CONTROL_CENTER_SETUP_TASK_AR[sentence]) || sentence}. ${overdue
      ? ccText('The backup worker has not produced a file for two intervals. Check the operations log and the backup volume.', 'لم يُنتج عامل النسخ الاحتياطي ملفاً منذ فترتين. راجع سجل التشغيل ومساحة النسخ الاحتياطية.')
      : failing ? ccText('The error is shown under Encrypted backup.', 'الخطأ ظاهر تحت «نسخة احتياطية مشفرة».')
      : ccText('This protection needs one server setting in Jelastic. No secret is shown in Albayan.', 'هذه الحماية تحتاج إعداداً واحداً في الخادم عبر Jelastic. لا يُعرض أي سر داخل البيان.')}`;
    // A sentence this screen does not know yet is shown as the server wrote it.
    tasks.push(plain ? renderControlCenterSetupTask(ccText(plain[0], plain[1]), ccText(plain[2], plain[3]), steps, overdue || failing) : renderControlCenterSetupTask(sentence, '', '', overdue || failing));
  });
  const connections = [
    { name: ccText('Meta read connection', 'اتصال قراءة ميتا'), ok: !!meta.configured, word: meta.configured ? ccText('Ready', 'جاهز') : ccText('Needs setup', 'يحتاج إعداداً') },
    { name: ccText('Instant Meta notifications', 'إشعارات ميتا الفورية'), ok: !!meta.webhookConfigured, soft: true, word: meta.webhookConfigured ? ccText('Ready', 'جاهزة') : ccText('Checking every few minutes', 'فحص كل بضع دقائق') },
    { name: ccText('Backup worker', 'عامل النسخ الاحتياطي'), ok: !!backup.workerRunning, word: backup.workerRunning ? ccText('Running', 'يعمل') : ccText('Not running', 'لا يعمل') },
    { name: ccText('Server health', 'حالة الخادم'), ok: recentRate < 0.05, danger: recentRate >= 0.05, word: recentSample ? `${(recentRate * 100).toFixed(1)}% ${ccText('errors', 'أخطاء')}` : ccText('Collecting data', 'جارٍ جمع البيانات'), note: `P95 ${p95} ms` }
  ];
  return { backup, offsiteFailed, backupConfigured, tasks, connections, urgent: backupTrouble || serverErrors };
}

function renderControlCenterSystem(server) {
  if (!server) return `<section class="management-card"><div class="management-section-heading"><div><h2>${ccText('System and plans', 'النظام والباقات')}</h2></div></div>${renderControlCenterNeedsServer()}</section>`;
  const { backup, offsiteFailed, tasks, connections } = getControlCenterSystem();
  return `
      <div class="management-system-layout">
        <section class="management-card" aria-labelledby="control-center-backup-title">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="archive-restore" class="h-5 w-5"></i></span><div><h2 id="control-center-backup-title">${ccText('Encrypted backup', 'نسخة احتياطية مشفرة')}</h2><p>${ccText('Keep a recoverable copy of your work.', 'احتفظ بنسخة يمكن استعادة العمل منها.')}</p></div></div>
          <dl class="management-facts"><div><dt>${ccText('Last backup', 'آخر نسخة')}</dt><dd>${Security.escapeHtml(controlCenterTimestamp(backup.lastBackupAt))}</dd></div><div><dt>${ccText('Off-site copy', 'النسخة الخارجية')}</dt><dd${offsiteFailed ? ' class="text-rose-600"' : ''}>${offsiteFailed ? ccText('Failing', 'متعطلة') : backup.offsiteConfigured ? ccText('Connected', 'متصلة') : ccText('Not connected', 'غير متصلة')}</dd></div>${backup.offsiteConfigured ? `<div><dt>${ccText('Last off-site copy', 'آخر نسخة خارجية')}</dt><dd>${Security.escapeHtml(controlCenterTimestamp(backup.lastOffsiteAt))}</dd></div>` : ''}</dl>
          ${backup.lastBackupError ? `<div class="management-alert">${Security.escapeHtml(backup.lastBackupError)}</div>` : ''}
          ${offsiteFailed ? `<div class="management-alert">${ccText('Off-site upload failed:', 'فشل رفع النسخة الخارجية:')} ${Security.escapeHtml(backup.lastOffsiteError)}</div>` : ''}
          <button type="button" onclick="runControlCenterBackup()" ${backup.enabled && backup.encryptionReady ? '' : 'disabled'} class="management-button is-primary management-full-button">${ccText('Create encrypted backup now', 'إنشاء نسخة مشفرة الآن')}</button>
          ${backup.enabled && backup.encryptionReady ? '' : `<p class="management-note">${ccText('Backups are not set up yet: see the setup tasks.', 'النسخ الاحتياطي لم يُضبط بعد: راجع مهام الإعداد.')}</p>`}
        </section>

        <section class="management-card" aria-labelledby="control-center-connections-title">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="network" class="h-5 w-5"></i></span><div><h2 id="control-center-connections-title">${ccText('Live connections', 'الاتصالات المباشرة')}</h2><p>${ccText('Readiness of the services running behind your workspace.', 'جاهزية الخدمات التي تعمل خلف مساحة العمل.')}</p></div></div>
          <ul class="management-connection-list">${connections.map(item => `<li>${controlCenterChip(item.word, item.ok ? 'is-ok' : item.danger ? 'is-danger' : item.soft ? '' : 'is-warning')}<strong>${item.name}</strong>${item.note ? `<small>${item.note}</small>` : ''}</li>`).join('')}</ul>
        </section>

        <section class="management-card management-setup" aria-labelledby="control-center-setup-title">
          <div class="management-section-heading"><span class="management-section-icon"><i data-lucide="list-checks" class="h-5 w-5"></i></span><div><h2 id="control-center-setup-title">${ccText('Setup tasks', 'مهام الإعداد')}</h2><p>${ccText('Things the server still needs. The technical steps are for whoever maintains it.', 'أمور ما زال الخادم يحتاجها. الخطوات التقنية لمن يتولى صيانته.')}</p></div><span class="management-count">${tasks.length}</span></div>
          ${tasks.length ? `<ul class="management-setup-list">${tasks.join('')}</ul>` : `<p class="management-note">${ccText('Nothing is waiting for setup.', 'لا شيء بانتظار الإعداد.')}</p>`}
        </section>
      </div>

      <div class="management-plan-workspace">${renderPlanManagerSection()}</div>`;
}

function renderControlCenterToday(server) {
  const today = getControlCenterToday();
  const groups = getControlCenterAttention(today, server ? _controlCenter.studio : null);
  const kinds = groups.reduce((sum, group) => sum + group.lines.length, 0);
  const operations = _controlCenter.operations || {};
  // The Studio's lines come from the server: while it is being asked, or when it did not answer, say so
  // (never a zero that is not known).
  const studioNote = !server ? '' : (_controlCenter.studio ? '' : _controlCenter.studioFailed
    ? `<div class="management-attention-note"><span>${ccText('Could not read the Studio desk.', 'تعذّرت قراءة مكتب الاستوديو.')}</span><button type="button" onclick="navigateTo('ads-studio')" class="management-button">${ccText('Open the desk', 'فتح المكتب')}</button></div>`
    : `<div class="management-attention-note"><span>${ccText('Checking the Studio desk…', 'جارٍ فحص مكتب الاستوديو…')}</span></div>`);
  const checkedAt = controlCenterClock(_controlCenter.loadedAt);
  const list = kinds
    ? groups.map(group => `<h3 class="management-eyebrow" id="control-center-group-${group.id}">${Security.escapeHtml(group.title)}</h3><ul class="management-attention-list" aria-labelledby="control-center-group-${group.id}">${group.lines.map(renderControlCenterLine).join('')}</ul>`).join('')
    : `<div class="management-empty"><i data-lucide="circle-check" class="h-9 w-9"></i><h3>${ccText('Nothing needs you right now.', 'لا شيء يحتاجك الآن.')}</h3><p>${ccText(`Checked at ${checkedAt}`, `آخر فحص ${checkedAt}`)}</p></div>`;
  const month = today.month;
  const monthName = (() => { try { return month.now.toLocaleDateString(controlCenterLocale(), { month: 'long', year: 'numeric' }); } catch (_) { return ''; } })();
  const versus = month.pct === null ? ccText('first month on record', 'أول شهر مُسجَّل') : ccText(`${month.pct >= 0 ? '+' : ''}${month.pct}% vs last month`, `${month.pct >= 0 ? '+' : ''}${month.pct}% مقابل الشهر الماضي`);
  const figure = (label, value, note, open) => `<button type="button" onclick="${open}" class="management-figure"><span>${label}</span><strong><bdi>${Security.escapeHtml(value)}</bdi></strong><small>${Security.escapeHtml(note)}</small></button>`;
  const system = server ? getControlCenterSystem() : null;
  const ready = system ? system.connections.filter(item => item.ok).length : 0;
  const tiles = shellMoreTiles();
  const tileLine = id => { const tile = tiles.find(item => item.id === id); return tile ? `${tile.name} · ${tile.sub}` : ''; };
  const door = (view, icon, name, sub) => `<button type="button" onclick="navigateTo('${view}')" class="management-door"><i data-lucide="${icon}" class="h-5 w-5" aria-hidden="true"></i><span><strong>${name}</strong><small>${sub}</small></span><i data-lucide="chevron-right" class="h-4 w-4 management-direction-icon" aria-hidden="true"></i></button>`;
  return `
      <div class="management-control-layout">
        <section class="management-card management-priority-panel" aria-labelledby="control-center-needs-title">
          <div class="management-section-heading"><div><h2 id="control-center-needs-title">${ccText('Needs you today', 'يحتاجك اليوم')}</h2><p>${kinds ? ccText(`${kinds} ${kinds === 1 ? 'kind' : 'kinds'} of work ${kinds === 1 ? 'is' : 'are'} waiting`, kinds === 1 ? 'نوع واحد من العمل بالانتظار' : `${kinds} أنواع من العمل بالانتظار`) : ccText('Work across the whole business that is waiting for a decision.', 'أعمال من كل أقسام النشاط بانتظار قرار.')}</p></div><span class="management-count">${kinds}</span></div>
          ${list}
          ${studioNote}
        </section>

        <aside class="management-protection-stack" aria-label="${ccText('Money and month close', 'الأموال وإقفال الشهر')}">
          <section class="management-card" aria-labelledby="control-center-money-title">
            <div class="management-section-heading"><div><h2 id="control-center-money-title">${ccText('Money at a glance', 'الأموال في لمحة')}</h2></div></div>
            <div class="management-figures">
              ${figure(ccText('Collected this month', 'المُحصَّل هذا الشهر'), controlCenterLyd(month.collectedLyd), `${monthName} · ${versus}`, "navigateTo('analytics')")}
              ${figure(ccText('Owed by customers', 'مستحق على العملاء'), controlCenterLyd(today.owedLyd), ccText('Today', 'اليوم'), "navigateTo('collect')")}
              ${figure(ccText('Known gross profit', 'الربح الإجمالي المعروف'), controlCenterLyd(today.facts.snapshot?.knownGrossProfitLYD), ccText('Based on recorded purchase costs', 'بحسب تكاليف الشراء المسجلة'), "navigateTo('analytics')")}
              ${figure(ccText('To collect on deliveries', 'للتحصيل في التوصيل'), controlCenterLyd(today.delivery.uncollectedLYD), ccText('Today', 'اليوم'), 'controlCenterOpenDeliveries()')}
            </div>
          </section>

          ${renderControlCenterMonthCard(server, operations)}

          <section class="management-card" aria-labelledby="control-center-system-title">
            <div class="management-section-heading"><div><h2 id="control-center-system-title">${ccText('System and plans', 'النظام والباقات')}</h2></div><button type="button" onclick="controlCenterSetTab('system')" class="management-button">${ccText('Open', 'فتح')}</button></div>
            ${!server ? renderControlCenterNeedsServer() : !_controlCenter.operations ? `<p class="management-note">${_controlCenter.loading ? ccText('Checking the server…', 'جارٍ فحص الخادم…') : ccText('The server checks could not be read.', 'تعذّرت قراءة فحوصات الخادم.')}</p>` : `<p class="management-note${system.urgent ? ' is-urgent' : ''}" data-system-summary>${ccText(`Protection: ${system.backupConfigured ? 'set up' : 'setup needed'}`, `الحماية: ${system.backupConfigured ? 'مهيّأة' : 'تحتاج إعداداً'}`)} · ${ccText(`Connections: ${ready} of ${system.connections.length} ready`, `الاتصالات: ${ready} من ${system.connections.length} جاهزة`)} · ${ccText(`${system.tasks.length} setup ${system.tasks.length === 1 ? 'task' : 'tasks'}`, `مهام الإعداد: ${system.tasks.length}`)}</p>`}
          </section>
        </aside>
      </div>

      <nav class="management-doors" aria-label="${ccText('Areas', 'الأقسام')}">
        ${door('analytics', 'megaphone', ccText('Albayan Manager', 'مدير البيان'), tileLine('ads'))}
        ${door('deliveries', 'truck', ccText('Deliveries', 'التوصيل'), tiles.find(item => item.id === 'deliveries')?.sub || '')}
        ${door('ads-studio', 'rocket', ccText('Ads Studio', 'استوديو الإعلانات'), ccText('Team desk', 'مكتب الفريق'))}
        ${door('clothes-system', 'shirt', ccText('Clothes System', 'نظام الملابس'), ccText('Stock and orders', 'المخزون والطلبات'))}
        ${door('users', 'users', ccText('Team', 'الفريق'), tiles.find(item => item.id === 'users')?.sub || '')}
        ${door('services-hub', 'grid-3x3', ccText('Services', 'الخدمات'), ccText('All platform services', 'كل خدمات المنصة'))}
      </nav>`;
}

function renderControlCenterView() {
  if (!isAdminRole(state.currentUser?.role)) return renderNoAccessView();
  controlCenterKeepSession();
  const server = isServerModeEnabled();
  if (!_controlCenter.period) _controlCenter.period = controlCenterPreviousMonth();
  if (!_controlCenter.loading && (!_controlCenter.loadedAt || Date.now() - _controlCenter.loadedAt > 60000)) {
    setTimeout(() => loadControlCenterStatus(false), 0);
  }
  if (server && !_planManager.loading && !_planManager.loadedAt && (!_planManager.failedAt || Date.now() - _planManager.failedAt > 30000)) {
    setTimeout(() => loadPlanManager(false), 0);
  }
  // The Clothes System hands over its two numbers through its own bundle: asked for once, and only
  // when there are Clothes records to count.
  if (typeof clothesOwnerSummary !== 'function' && !_controlCenter.clothesAsked && ((state.clothesProducts || []).length || (state.clothesOrders || []).length)) {
    _controlCenter.clothesAsked = true;
    setTimeout(() => ensureClothesSystemLoaded().then(() => { if (state.currentView === 'control-center' && typeof clothesOwnerSummary === 'function') render(); }), 0);
  }
  const isAr = state.language === 'ar';
  const system = _controlCenter.tab === 'system';
  const today = (() => { try { return new Date().toLocaleDateString(controlCenterLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) { return ''; } })();
  const live = !server ? ccText('This device only (local mode)', 'هذا الجهاز فقط (الوضع المحلي)')
    : _serverLiveSync.startupLoadPending ? ccText('Loading your records…', 'جارٍ تحميل سجلاتك…')
    : _serverLiveSync.failStreak > 0 ? ccText('Connection lost: showing the last figures', 'انقطع الاتصال: تُعرض آخر الأرقام')
    : ccText('Figures are live', 'الأرقام مباشرة');
  const checks = !server ? '' : _controlCenter.loading ? ccText('Checking server…', 'جارٍ فحص الخادم…')
    : _controlCenter.error ? ccText('Some checks could not be read', 'تعذّرت قراءة بعض الفحوصات')
    : _controlCenter.loadedAt ? ccText(`Server checks updated ${controlCenterClock(_controlCenter.loadedAt)}`, `تحديث فحوصات الخادم ${controlCenterClock(_controlCenter.loadedAt)}`)
    : ccText('Waiting for checks', 'بانتظار الفحوصات');
  const tab = (id, label) => `<button type="button" onclick="controlCenterSetTab('${id}')" class="management-tab${_controlCenter.tab === id ? ' is-active' : ''}" aria-pressed="${_controlCenter.tab === id ? 'true' : 'false'}">${label}</button>`;
  return `
    <div class="management-workspace control-workspace" dir="${isAr ? 'rtl' : 'ltr'}" data-control-tab="${_controlCenter.tab}">
      <header class="management-hero">
        <div class="management-hero-copy"><h1>${ccText('Daily Control Center', 'مركز المتابعة اليومي')}</h1><p>${Security.escapeHtml(today)} · ${live}</p></div>
        <div class="management-hero-side">
          <div class="management-tabs" role="group" aria-label="${ccText('What to show', 'ما يُعرض')}">${tab('today', ccText('Today', 'اليوم'))}${tab('system', ccText('System and plans', 'النظام والباقات'))}</div>
          ${server ? `<span class="management-status ${_controlCenter.error ? 'is-warning' : ''}" role="status"><span aria-hidden="true"></span>${checks}</span>` : ''}
          <button type="button" onclick="refreshControlCenter()" class="management-button"><i data-lucide="refresh-cw" class="h-4 w-4 ${_controlCenter.loading ? 'animate-spin' : ''}"></i>${ccText('Refresh', 'تحديث')}</button>
        </div>
      </header>

      ${_controlCenter.error ? `<div class="management-alert" role="alert"><strong>${ccText('Server checks could not be read. Try again.', 'تعذّرت قراءة فحوصات الخادم. حاول مرة أخرى.')}</strong><details><summary>${ccText('Show technical steps', 'عرض الخطوات التقنية')}</summary><p>${Security.escapeHtml(_controlCenter.error)}</p></details></div>` : ''}

      ${system ? renderControlCenterSystem(server) : renderControlCenterToday(server)}
    </div>`;
}
