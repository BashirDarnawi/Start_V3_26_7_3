// ==========================================
// APPLICATION STATE
// ==========================================

// ==========================================
// SERVICES CONFIGURATION (Multi-Service Hub)
// ==========================================

const SERVICES = {
  international_shipping: {
    id: 'international_shipping',
    order: 1,
    name: 'International Shipping',
    nameAr: 'الشحن الدولي',
    icon: 'plane',
    color: 'from-blue-500 to-cyan-500',
    description: 'Ship worldwide',
    descriptionAr: 'شحن عالمي',
    comingSoon: false,
    requiresSubscription: true,
    // Pricing offer (local demo). In server mode, pricing should come from the backend.
    subscription: { price: 0, durationDays: 30 }
  },
  local_shipping: {
    id: 'local_shipping',
    order: 2,
    name: 'Local Shipping',
    nameAr: 'الشحن المحلي',
    icon: 'truck',
    color: 'from-emerald-500 to-green-500',
    description: 'Local delivery',
    descriptionAr: 'توصيل محلي',
    comingSoon: false,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  warehouse: {
    id: 'warehouse',
    order: 3,
    name: 'Warehouse',
    nameAr: 'المستودع',
    icon: 'warehouse',
    color: 'from-orange-500 to-red-500',
    description: 'Storage solutions',
    descriptionAr: 'حلول التخزين',
    comingSoon: false,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  smart_systems: {
    id: 'smart_systems',
    order: 4, // Service #4 (Business Tools / Smart Systems)
    name: 'Smart Systems',
    nameAr: 'الأنظمة الذكية',
    icon: 'cpu',
    color: 'from-violet-500 to-fuchsia-500',
    description: 'Business tools & portals',
    descriptionAr: 'أدوات الأعمال والبوابات',
    comingSoon: false,
    requiresSubscription: true, // treat as a paid service (children inherit by default)
    subscription: { price: 0, durationDays: 30 },
    openView: 'smart-systems',
    hasChildren: true,
    children: ['albayan_manager', 'crm', 'store_system', 'clothes_system', 'ad_maker']
  },
  albayan_cards: {
    id: 'albayan_cards',
    order: 5,
    name: 'Albayan Cards',
    nameAr: 'بطاقات البيان',
    icon: 'credit-card',
    color: 'from-purple-500 to-pink-500',
    description: 'Payment cards',
    descriptionAr: 'بطاقات الدفع',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  ship_through_us: {
    id: 'ship_through_us',
    order: 7,
    name: 'Ship Through Us',
    nameAr: 'اشحن معنا',
    icon: 'package',
    color: 'from-sky-500 to-blue-500',
    description: 'Full service shipping',
    descriptionAr: 'شحن كامل الخدمة',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  managed_social_ads: {
    id: 'managed_social_ads',
    order: 8,
    name: 'Managed Social Ads',
    nameAr: 'إعلانات مُدارة',
    icon: 'zap',
    color: 'from-amber-500 to-yellow-500',
    description: 'We run your ads',
    descriptionAr: 'ندير إعلاناتك',
    comingSoon: true,
    requiresSubscription: true,
    subscription: { price: 0, durationDays: 30 }
  },
  placeholder_coming_soon: {
    id: 'placeholder_coming_soon',
    order: 9,
    name: 'Coming Soon',
    nameAr: 'قريباً',
    icon: 'rocket',
    color: 'from-slate-400 to-slate-500',
    description: 'More services soon',
    descriptionAr: 'المزيد قريباً',
    comingSoon: true,
    requiresSubscription: false
  }
};

// Child systems under Smart Systems
const SMART_SYSTEMS_CHILDREN = {
  albayan_manager: {
    id: 'albayan_manager',
    order: 1,
    name: 'Albayan Manager',
    nameAr: 'مدير البيان',
    icon: 'megaphone',
    color: 'from-indigo-600 to-purple-600',
    description: 'Ads Manager Portal',
    descriptionAr: 'بوابة إدارة الإعلانات',
    comingSoon: false,
    requiresSubscription: true,
    // Access via Smart Systems subscription (recommended default)
    requiredSubscriptions: ['smart_systems'],
    openView: 'analytics'
  },
  crm: {
    id: 'crm',
    order: 2,
    name: 'CRM',
    nameAr: 'إدارة العملاء',
    icon: 'users',
    color: 'from-blue-500 to-cyan-500',
    description: 'Customer management',
    descriptionAr: 'إدارة العملاء',
    comingSoon: true,
    requiresSubscription: true,
    requiredSubscriptions: ['smart_systems']
  },
  store_system: {
    id: 'store_system',
    order: 3,
    name: 'Store System',
    nameAr: 'نظام المتجر',
    icon: 'shopping-cart',
    color: 'from-green-500 to-emerald-500',
    description: 'E-commerce platform',
    descriptionAr: 'منصة التجارة الإلكترونية',
    comingSoon: true,
    requiresSubscription: true,
    requiredSubscriptions: ['smart_systems']
  },
  clothes_system: {
    id: 'clothes_system',
    order: 4,
    name: 'Clothes System',
    nameAr: 'نظام الملابس',
    icon: 'shirt',
    color: 'from-rose-500 to-pink-500',
    description: 'Warehouse, shipments & orders',
    descriptionAr: 'المستودع والشحنات والطلبات',
    comingSoon: false,
    requiresSubscription: true,
    // Sold as its OWN subscription product (not bundled with smart_systems)
    requiredSubscriptions: ['clothes_system'],
    subscription: { price: 0, durationDays: 30 },
    openView: 'clothes-system'
  },
  ad_maker: {
    id: 'ad_maker',
    order: 5,
    name: 'Albayan Ads Studio',
    nameAr: 'استوديو إعلانات البيان',
    icon: 'rocket',
    color: 'from-blue-600 to-cyan-500',
    description: 'Customer self-service campaigns',
    descriptionAr: 'حملات إعلانية ذاتية للعملاء',
    comingSoon: false,
    requiresSubscription: true,
    requiredSubscriptions: ['ad_maker'],
    subscription: { price: 0, durationDays: 30 },
    openView: 'ads-studio'
  }
};

// ==========================================
// PLATFORM FOUNDATION (Wallet + Subscriptions)
// ==========================================

// Money must be handled using **minor units integers** (no floats).
// NOTE: This is still local/demo friendly, but real money must be enforced in server mode.
const WALLET_SUPPORTED_CURRENCIES = ['LYD', 'USD', 'EUR'];
const WALLET_CURRENCY_META = {
  LYD: { decimals: 2, label: 'LYD' },
  USD: { decimals: 2, label: 'USD' },
  EUR: { decimals: 2, label: 'EUR' }
};

// UI safety guard to prevent accidental double-submits (double charging) in local demo mode.
// Server mode must still enforce idempotency authoritatively.
const WalletUiGuard = {
  windowMs: 1800,
  _last: new Map(),
  hit: (fingerprint) => {
    const key = String(fingerprint || '').trim();
    if (!key) return false;
    const now = Date.now();
    const last = Number(WalletUiGuard._last.get(key) || 0);
    if (now - last < WalletUiGuard.windowMs) return true;
    WalletUiGuard._last.set(key, now);
    return false;
  }
};

function walletNormalizeCurrency(input) {
  const c = String(input || '').trim().toUpperCase();
  if (WALLET_SUPPORTED_CURRENCIES.includes(c)) return c;
  return 'LYD';
}

function walletDecimals(currency) {
  const c = walletNormalizeCurrency(currency);
  return Number(WALLET_CURRENCY_META[c]?.decimals ?? 2);
}

function walletToMinor(amountMajor, currency) {
  const d = walletDecimals(currency);
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) return NaN;
  const factor = 10 ** d;
  // Round to minor units (safe enough for UI input; server must validate precisely)
  return Math.round(n * factor);
}

function walletFromMinor(amountMinor, currency) {
  const d = walletDecimals(currency);
  const factor = 10 ** d;
  const n = Number(amountMinor);
  if (!Number.isFinite(n)) return NaN;
  return n / factor;
}

function walletTxCurrency(tx) {
  const c = tx && typeof tx === 'object' ? tx.currency : null;
  return walletNormalizeCurrency(c || WALLET.currency);
}

function walletTxAmountMinor(tx) {
  if (!tx || typeof tx !== 'object') return 0;
  const c = walletTxCurrency(tx);
  const minor = Number(tx.amountMinor);
  if (Number.isFinite(minor)) return Math.trunc(minor);
  const major = Number(tx.amount);
  if (Number.isFinite(major)) {
    const m = walletToMinor(major, c);
    return Number.isFinite(m) ? Math.trunc(m) : 0;
  }
  return 0;
}

function walletFormatMinor(amountMinor, currency) {
  const c = walletNormalizeCurrency(currency);
  const d = walletDecimals(c);
  const major = walletFromMinor(amountMinor, c);
  if (!Number.isFinite(major)) return `0 ${c}`;
  return `${major.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })} ${c}`;
}

function walletFindByIdempotency(idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return null;
  const txs = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  return txs.find(t => t && !t._deleted && String(t.idempotencyKey || '') === key) || null;
}

function upsertServerBackedRecord(collectionName, entityResponse) {
  const saved = entityResponse?.data ? Security.sanitizeObject(entityResponse.data) : null;
  if (!saved?.id || !Security.isValidRecordId(saved.id)) throw new Error('Invalid server response');
  if (!Array.isArray(state[collectionName])) state[collectionName] = [];
  const arr = state[collectionName];
  const idx = arr.findIndex(row => row && String(row.id) === String(saved.id));
  if (idx === -1) arr.unshift(saved);
  else arr[idx] = saved;
  markCollectionDirty(collectionName);
  saveState();
  return saved;
}

function ensureOperationIdempotencyKey(value, prefix) {
  const supplied = Security.sanitizeInput(String(value || '').trim(), { maxLength: 120 });
  if (supplied.length >= 8) return supplied;
  return `${String(prefix || 'op')}:${Security.generateSecureId('idem')}`.slice(0, 120);
}

const WALLET = {
  currency: 'LYD',
  // Compute balance from immutable ledger
  getBalanceMinor: (userId, currency = WALLET.currency) => {
    const uid = String(userId || '');
    if (!uid) return 0;
    const txs = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
    const c = walletNormalizeCurrency(currency || WALLET.currency);
    let balMinor = 0;
    for (const tx of txs) {
      if (!tx || tx._deleted) continue;
      if (walletTxCurrency(tx) !== c) continue;
      const amtMinor = walletTxAmountMinor(tx);
      if (tx.toUserId === uid) balMinor += amtMinor;
      if (tx.fromUserId === uid) balMinor -= amtMinor;
    }
    return balMinor;
  },
  getBalance: (userId, currency = WALLET.currency) => {
    const c = walletNormalizeCurrency(currency || WALLET.currency);
    const minor = WALLET.getBalanceMinor(userId, c);
    const major = walletFromMinor(minor, c);
    const d = walletDecimals(c);
    return Number.isFinite(major) ? Number(major.toFixed(d)) : 0;
  },
  getBalances: (userId) => {
    const uid = String(userId || '');
    const out = {};
    if (!uid) return out;
    for (const c of WALLET_SUPPORTED_CURRENCIES) {
      const major = WALLET.getBalance(uid, c);
      if (major !== 0) out[c] = major;
    }
    // Always include default currency for predictable UI
    if (out[WALLET.currency] === undefined) out[WALLET.currency] = WALLET.getBalance(uid, WALLET.currency);
    return out;
  },
  // Add credit (admin/top-up)
  credit: async (toUserId, amount, meta = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    // Manual credit = the platform owner records money received OUTSIDE the
    // app (cash / bank transfer from a client). Admin-only on the client, and
    // the server additionally rejects walletTransactions writes from anyone
    // who is not Admin (no role template grants that module). If a real
    // payment processor is ever added, its settlements must come from the
    // backend, not this function.
    if (!isAdminRole(state.currentUser.role)) throw new Error('Only Admin can top-up wallets');
    const currency = walletNormalizeCurrency(meta.currency || WALLET.currency);
    const amountMinor = Number.isFinite(Number(meta.amountMinor)) ? Math.trunc(Number(meta.amountMinor)) : walletToMinor(amount, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const idem = ensureOperationIdempotencyKey(meta.idempotencyKey, 'topup');
    const existing = walletFindByIdempotency(idem);
    if (existing) return existing;
    const tx = {
      id: generateId('wtx'),
      type: 'credit',
      schemaVersion: 2,
      amountMinor,
      currency,
      // Keep a major value for convenience/debugging (NOT source of truth)
      amount: walletFromMinor(amountMinor, currency),
      fromUserId: null,
      toUserId: String(toUserId || ''),
      memo: Security.sanitizeInput(meta.memo || 'Top-up', { maxLength: 180 }),
      idempotencyKey: idem || undefined,
      status: 'posted',
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.id || 'system',
      _lastModified: getMonotonicTime(),
      _deleted: false
    };
    if (!tx.toUserId) throw new Error('Missing recipient');
    if (tx.toUserId === 'system') throw new Error('Invalid recipient');
    const exists = Array.isArray(state.users) && state.users.some(u => u && !u._deleted && String(u.id) === tx.toUserId);
    if (!exists) throw new Error('Recipient not found');
    if (isServerModeEnabled()) {
      const response = await apiWalletTopUp({
        userId: tx.toUserId,
        amountMinor,
        currency,
        idempotencyKey: idem,
        memo: tx.memo
      });
      return upsertServerBackedRecord('walletTransactions', response);
    }
    const savedOk = await addRecord(state.walletTransactions, tx);
    if (!savedOk) throw new Error('Failed to save wallet top-up');
    addAuditLog('wallet', tx.id, `Wallet credit ${walletFormatMinor(amountMinor, currency)}`, { resourceType: 'walletTransactions', toUserId: tx.toUserId });
    return tx;
  },
  // Transfer between users
  transfer: async (fromUserId, toUserId, amount, meta = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    const currency = walletNormalizeCurrency(meta.currency || WALLET.currency);
    const amountMinor = Number.isFinite(Number(meta.amountMinor)) ? Math.trunc(Number(meta.amountMinor)) : walletToMinor(amount, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const fromId = String(fromUserId || '');
    const toId = String(toUserId || '');
    if (!fromId || !toId) throw new Error('Missing users');
    if (fromId === toId) throw new Error('Cannot transfer to self');
    const isAdmin = isAdminRole(state.currentUser.role);
    if (!isAdmin && String(state.currentUser.id) !== fromId) throw new Error('Forbidden');
    if (!isAdmin && fromId === 'system') throw new Error('Forbidden');
    if (toId !== 'system') {
      const toExists = Array.isArray(state.users) && state.users.some(u => u && !u._deleted && String(u.id) === toId);
      if (!toExists) throw new Error('Recipient not found');
    }

    const idem = ensureOperationIdempotencyKey(meta.idempotencyKey, 'transfer');
    const existing = walletFindByIdempotency(idem);
    if (existing) return existing;

    // Local mode owns its ledger and must validate here. In server mode the
    // cache may be a few seconds stale, so only the locked DB transaction may
    // decide whether the authoritative balance is sufficient.
    if (!isServerModeEnabled()) {
      const balMinor = WALLET.getBalanceMinor(fromId, currency);
      if (balMinor < amountMinor) throw new Error('Insufficient balance');
    }

    const tx = {
      id: generateId('wtx'),
      type: String(meta.type || 'transfer'),
      schemaVersion: 2,
      amountMinor,
      currency,
      amount: walletFromMinor(amountMinor, currency),
      fromUserId: fromId,
      toUserId: toId,
      memo: Security.sanitizeInput(meta.memo || 'Transfer', { maxLength: 180 }),
      idempotencyKey: idem || undefined,
      status: 'posted',
      referenceType: meta.referenceType ? Security.sanitizeInput(meta.referenceType, { maxLength: 60 }) : undefined,
      referenceId: meta.referenceId ? Security.sanitizeInput(meta.referenceId, { maxLength: 120 }) : undefined,
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.id || fromId,
      _lastModified: getMonotonicTime(),
      _deleted: false
    };
    if (isServerModeEnabled()) {
      // The dedicated endpoint always debits the authenticated user. Admins
      // cannot use the client to spend another user's wallet.
      if (String(state.currentUser.id) !== fromId) throw new Error('A server transfer can only debit your own wallet');
      const response = await apiWalletTransfer({
        toUserId: toId,
        amountMinor,
        currency,
        idempotencyKey: idem,
        memo: tx.memo
      });
      return upsertServerBackedRecord('walletTransactions', response);
    }
    const savedOk = await addRecord(state.walletTransactions, tx);
    if (!savedOk) throw new Error('Failed to save wallet transfer');
    addAuditLog('wallet', tx.id, `Wallet transfer ${walletFormatMinor(amountMinor, currency)}`, { resourceType: 'walletTransactions', fromUserId: tx.fromUserId, toUserId: tx.toUserId });
    return tx;
  },
  // Create a compensating transaction (Admin-only) instead of editing history
  reverse: async (transactionId, meta = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    if (!isAdminRole(state.currentUser.role)) throw new Error('Admin only');
    const id = String(transactionId || '').trim();
    if (!id) throw new Error('Missing transaction id');
    const txs = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
    const original = txs.find(t => t && !t._deleted && String(t.id) === id);
    if (!original) throw new Error('Transaction not found');
    const currency = walletTxCurrency(original);
    const amountMinor = walletTxAmountMinor(original);
    if (!amountMinor || amountMinor <= 0) throw new Error('Invalid original amount');
    const fromId = String(original.toUserId || 'system');
    const toId = String(original.fromUserId || 'system');
    const idem = `rev:${id}`;
    if (isServerModeEnabled()) {
      const response = await apiWalletReversal({
        transactionId: id,
        memo: Security.sanitizeInput(meta.memo || `Reversal of ${id}`, { maxLength: 180 })
      });
      return upsertServerBackedRecord('walletTransactions', response);
    }
    return await WALLET.transfer(fromId, toId, 0, {
      type: 'reversal',
      amountMinor,
      currency,
      idempotencyKey: idem,
      memo: Security.sanitizeInput(meta.memo || `Reversal of ${id}`, { maxLength: 180 }),
      referenceType: 'reversalOf',
      referenceId: id
    });
  }
};

const SUBSCRIPTIONS = {
  // Service subscription records: { id, userId, serviceId, status, startedAt, expiresAt, price, currency }
  getActiveServiceIds: (userId) => {
    const uid = String(userId || '');
    if (!uid) return [];
    const now = Date.now();
    const subs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
    const active = subs.filter(s =>
      s && !s._deleted &&
      s.userId === uid &&
      s.status === 'active' &&
      (!s.expiresAt || new Date(s.expiresAt).getTime() > now)
    );
    return Array.from(new Set(active.map(s => s.serviceId))).filter(Boolean);
  },
  isActive: (userId, serviceId) => {
    const sid = String(serviceId || '');
    if (!sid) return false;
    return SUBSCRIPTIONS.getActiveServiceIds(userId).includes(sid);
  },
  // Subscribe by paying from wallet (default monthly)
  subscribe: async (userId, serviceId, opts = {}) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    const uid = String(userId || '');
    const sid = String(serviceId || '');
    if (!uid || !sid) throw new Error('Missing subscription data');
    const isAdmin = isAdminRole(state.currentUser.role);
    if (!isAdmin && String(state.currentUser.id) !== uid) throw new Error('Forbidden');

    const idem = ensureOperationIdempotencyKey(opts.idempotencyKey, 'subscription');
    const subs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
    // Check the exact retry key before the broader active-service guard so a
    // double tap/retry returns the already-committed purchase as success.
    const existing = subs.find(s => s && !s._deleted && s.userId === uid && s.serviceId === sid && String(s.idempotencyKey || '') === idem);
    if (existing) return existing;
    if (SUBSCRIPTIONS.isActive(uid, sid)) throw new Error('Already subscribed');

    const currency = walletNormalizeCurrency(opts.currency || WALLET.currency);
    const priceMinor = Number.isFinite(Number(opts.priceMinor))
      ? Math.trunc(Number(opts.priceMinor))
      : walletToMinor(Number(opts.price ?? 0), currency);
    const durationDays = Number(opts.durationDays ?? 30);
    if (!Number.isFinite(durationDays) || durationDays <= 0) throw new Error('Invalid duration');
    if (!Number.isFinite(priceMinor) || priceMinor < 0) throw new Error('Invalid price');

    if (isServerModeEnabled()) {
      // Price, duration, balance check, payment ledger row and subscription
      // are all owned by the server and committed atomically in one call.
      const response = await apiPurchaseSubscription({
        serviceId: sid,
        idempotencyKey: idem,
        userId: isAdmin && uid !== String(state.currentUser.id) ? uid : undefined
      });
      const saved = upsertServerBackedRecord('serviceSubscriptions', response);
      if (saved.paymentTxId) {
        try {
          const payment = await apiGetEntity('walletTransactions', saved.paymentTxId);
          upsertServerBackedRecord('walletTransactions', payment);
        } catch (e) {
          // Subscription is already committed; live sync will fetch the ledger
          // row. Do not retry the purchase with a new key or double-notify.
          if (ALBAYAN_DEBUG_MODE) console.warn('[SUBSCRIPTIONS.subscribe] Payment refresh failed:', e?.message || e);
        }
      }
      return saved;
    }

    let paymentTx = null;
    if (priceMinor > 0) {
      // charge wallet (debit) by transferring to system account
      paymentTx = await WALLET.transfer(uid, 'system', 0, {
        type: 'service_payment',
        amountMinor: priceMinor,
        currency,
        memo: `Subscription: ${sid}`,
        idempotencyKey: idem ? `subpay:${idem}` : undefined,
        referenceType: 'subscription',
        referenceId: sid
      });
    }

    const now = new Date();
    const expires = new Date(now.getTime() + durationDays * TIME_CONSTANTS.MILLISECONDS_PER_DAY);
    const rec = {
      id: generateId('sub'),
      userId: uid,
      serviceId: sid,
      status: 'active',
      startedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      priceMinor,
      // Keep a major value for convenience/debugging (NOT source of truth)
      price: walletFromMinor(priceMinor, currency),
      currency,
      paymentTxId: paymentTx?.id || undefined,
      idempotencyKey: idem || undefined,
      createdAt: now.toISOString(),
      createdBy: state.currentUser?.id || uid,
      _lastModified: getMonotonicTime(),
      _deleted: false
    };
    const savedOk = await addRecord(state.serviceSubscriptions, rec);
    if (!savedOk) throw new Error('Failed to save subscription');
    addAuditLog('subscription', rec.id, `Subscribed to ${sid} (${walletFormatMinor(priceMinor, currency)})`, { resourceType: 'serviceSubscriptions', serviceId: sid, userId: uid });
    return rec;
  },
  cancel: async (userId, serviceId) => {
    if (!state.currentUser?.id) throw new Error('Not logged in');
    const uid = String(userId || '');
    const sid = String(serviceId || '');
    if (!uid || !sid) throw new Error('Missing subscription data');
    const isAdmin = isAdminRole(state.currentUser.role);
    if (!isAdmin && String(state.currentUser.id) !== uid) throw new Error('Forbidden');

    const now = Date.now();
    const subs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
    const active = subs.find(s =>
      s && !s._deleted &&
      s.userId === uid &&
      s.serviceId === sid &&
      s.status === 'active' &&
      (!s.expiresAt || new Date(s.expiresAt).getTime() > now)
    );
    if (!active?.id) throw new Error('No active subscription');

    const ts = new Date().toISOString();
    const canceledOk = await updateRecord(state.serviceSubscriptions, active.id, { status: 'canceled', canceledAt: ts, expiresAt: ts });
    if (!canceledOk) throw new Error('Failed to cancel subscription');
    addAuditLog('subscription', active.id, `Canceled ${sid}`, { resourceType: 'serviceSubscriptions', serviceId: sid, userId: uid });

    // Keep legacy user.subscriptions in sync (optional compatibility)
    const user = Array.isArray(state.users) ? state.users.find(u => u && !u._deleted && String(u.id) === uid) : null;
    const legacy = Array.isArray(user?.subscriptions) ? user.subscriptions.slice() : null;
    if (legacy && legacy.includes(sid)) {
      const next = legacy.filter(x => x !== sid);
      await updateRecord(state.users, uid, { subscriptions: next });
    }
    return true;
  }
};

/** @type {AlbayanState} */
const state = {
  // Auth
  currentUser: null,
  currentView: 'services-hub', // Start at Services Hub
  isMobileMenuOpen: false,
  // Server mode (for multi-user internet deployments)
  serverMode: false,
  serverDetected: false, // runtime: whether a backend was detected
  serverModeOverride: 'auto', // 'auto' | 'local' | 'server'
  serverBaseUrl: '', // same-origin by default
  serverLastSyncAt: null,

  // Local Password Recovery (LOCAL MODE ONLY)
  // Stores a hash of the recovery key (never plaintext). Used for "Forgot password" in local mode.
  // Shape: { hash, salt, algo, iterations, createdAt }
  localRecovery: null,
  
  // UI
  language: 'en',
  theme: 'light',
  
  // Data
  // IMPORTANT: do NOT ship hardcoded credentials in a public website.
  // In serverMode, users come from the backend. Offline mode can import users via backup.
  users: [],
  
  ads: [],
  receipts: [],
  customers: [],
  pages: [],
  logs: [],
  // Server-side audit trail (server mode only). Fetched from GET /api/audit,
  // which scopes rows by auditLogs.view / viewOwn — this is what the Audit
  // Logs screen renders in server mode, NOT the device-local `logs` above.
  serverLogs: [],
  serverLogsLoadedAt: 0,
  walletTransactions: [], // ledger entries (huge-data safe via IndexedDB)
  serviceSubscriptions: [], // structured subscriptions (huge-data safe via IndexedDB)

  // Clothes System (Smart Systems child #4)
  clothesProducts: [], // items for sale: variants (color/size) with stock counts
  clothesShipments: [], // incoming goods from abroad (Ordered → Received)
  clothesOrders: [], // outgoing customer orders (delivery + payment tracking)
  clothesSettings: [], // one record per user: their own exchange rate etc.

  // Albayan Ads Studio. Campaign requests remain separate from the internal
  // `ads` accounting collection until an authorized manager approves them.
  adCampaignRequests: [],
  
  // Settings
  defaultExchangeRate: 0,
  exchangeRateHistory: [],
  
  // Cloud Sync
  cloudConfig: {
    enabled: false,
    endpoint: '',
    apiKey: ''
  },
  cloudSyncStatus: 'idle',
  lastCloudSync: null,
  
  // UI State
  commandPaletteOpen: false,
  activeModal: null,
  modalData: null,
  viewData: null,
  
  // Customer Filters
  customerSearch: '',
  customerSort: 'newest',
  customerFinancialFilter: 'all',
  
  // Ad Filters
  adSearch: '',

  // Receipt Filters
  receiptSearch: '',
  receiptStatusFilter: 'all',
  receiptPaymentFilter: 'all',
  receiptDateFilter: 'all',
  receiptDebtFilter: 'all',
  receiptCollectedFilter: 'all',
  receiptSortBy: 'newest',
  
  // Audit Log Filters & Pagination
  auditSearch: '',
  auditActionFilter: 'all',
  auditCategoryFilter: 'all',
  auditSeverityFilter: 'all',
  auditUserFilter: 'all',
  auditDateFrom: '',
  auditDateTo: '',
  auditPage: 1,
  auditPageSize: 25,

  // Delivery dashboard (Delivery role)
  deliveryDashboardFilterStatus: 'all' // 'all' | 'Needs Delivery' | 'In Progress' | 'Delivered' | 'Collected'
};
