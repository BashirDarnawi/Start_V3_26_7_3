// ==========================================
// CONSTANTS & ENUMS
// ==========================================

const PAYMENT_METHODS = [
  'Cash (LYD)', 'Cash (USD)', 'Libyana', 'Madar', 'LTT', 
  'Transfer Office', 'Bank Transfer', 'Bank Transfer (LYD)', 
  'Bank Transfer (USD)', 'Sadad', 'USDT'
];

const AD_STATUSES = ['Pending', 'Paused', 'Completed', 'Canceled', 'Lost', 'Stopped'];
const DELIVERY_STATUSES = ['Needs Delivery', 'In Progress', 'Delivered', 'Canceled', 'Office'];
const REFUND_TYPES = ['None', 'Full', 'Partial'];
const PLATFORMS = ['Facebook', 'WhatsApp', 'Instagram', 'Phone'];
const USER_ROLES = ['Admin', 'Employee', 'Delivery'];

// Business configuration constants (can be moved to settings in future)
const BUSINESS_CONFIG = {
  // Default processing fee for receipts (LYD)
  RECEIPT_PROCESSING_FEE_LYD: 0, // Set to 0 - was 2.00 as placeholder; make configurable in settings if needed
};

// ==========================================
// ADVANCED PERMISSIONS SYSTEM
// ==========================================

const PERMISSION_MODULES = {
  analytics: {
    name: 'Analytics',
    icon: 'bar-chart-3',
    color: 'indigo',
    description: 'Dashboard & reporting access',
    permissions: {
      view: { label: 'View Analytics', description: 'View dashboard and reports' },
      export: { label: 'Export Reports', description: 'Export analytics data to CSV/PDF' },
      viewFinancials: { label: 'View Financials', description: 'View revenue and financial metrics' },
      viewSensitive: { label: 'View Sensitive Data', description: 'View detailed financial breakdowns' }
    }
  },
  ads: {
    name: 'Ads',
    icon: 'megaphone',
    color: 'purple',
    description: 'Ad campaign management',
    permissions: {
      view: { label: 'View Ads', description: 'View all ad campaigns' },
      viewOwn: { label: 'View Own Ads', description: 'View only self-created ads' },
      add: { label: 'Create Ads', description: 'Create new ad campaigns' },
      edit: { label: 'Edit Ads', description: 'Edit any ad campaign' },
      editOwn: { label: 'Edit Own Ads', description: 'Edit only self-created ads' },
      delete: { label: 'Delete Ads', description: 'Delete ad campaigns' },
      changeStatus: { label: 'Change Status', description: 'Change ad status (pause, stop, complete)' },
      stopAd: { label: 'Stop Ads', description: 'Stop running ads and return funds' },
      assignDelivery: { label: 'Assign Delivery', description: 'Assign delivery personnel' },
      viewPhotos: { label: 'View Photos', description: 'View ad photos and screenshots' },
      uploadPhotos: { label: 'Upload Photos', description: 'Upload ad photos' }
    }
  },
  receipts: {
    name: 'Receipts',
    icon: 'receipt',
    color: 'emerald',
    description: 'Receipt & payment management',
    permissions: {
      view: { label: 'View Receipts', description: 'View all receipts' },
      viewOwn: { label: 'View Own Receipts', description: 'View only self-created receipts' },
      add: { label: 'Create Receipts', description: 'Create new receipts' },
      edit: { label: 'Edit Receipts', description: 'Edit any receipt' },
      editOwn: { label: 'Edit Own Receipts', description: 'Edit only self-created receipts' },
      delete: { label: 'Delete Receipts', description: 'Delete receipts' },
      markCollected: { label: 'Mark Collected', description: 'Mark receipts as collected' },
      transfer: { label: 'Transfer Balance', description: 'Transfer balance between accounts' },
      viewHistory: { label: 'View History', description: 'View receipt edit history' },
      export: { label: 'Export Receipts', description: 'Export receipt data' }
    }
  },
  customers: {
    name: 'Customers',
    icon: 'users',
    color: 'blue',
    description: 'Customer relationship management',
    permissions: {
      view: { label: 'View Customers', description: 'View all customers' },
      viewOwn: { label: 'View Own Customers', description: 'View only assigned customers' },
      add: { label: 'Add Customers', description: 'Add new customers' },
      edit: { label: 'Edit Customers', description: 'Edit customer information' },
      editOwn: { label: 'Edit Own Customers', description: 'Edit only assigned customers' },
      delete: { label: 'Delete Customers', description: 'Delete customers' },
      viewBalance: { label: 'View Balance', description: 'View customer financial balance' },
      viewContacts: { label: 'View Contacts', description: 'View customer phone numbers' },
      export: { label: 'Export Customers', description: 'Export customer data' }
    }
  },
  pages: {
    name: 'Pages',
    icon: 'file-text',
    color: 'amber',
    description: 'Page management',
    permissions: {
      view: { label: 'View Pages', description: 'View all pages' },
      add: { label: 'Add Pages', description: 'Add new pages' },
      edit: { label: 'Edit Pages', description: 'Edit page information' },
      delete: { label: 'Delete Pages', description: 'Delete pages' },
      linkCustomers: { label: 'Link Customers', description: 'Link customers to pages' }
    }
  },
  deliveries: {
    name: 'Deliveries',
    icon: 'truck',
    color: 'cyan',
    description: 'Delivery operations',
    permissions: {
      view: { label: 'View Deliveries', description: 'View all delivery operations' },
      viewOwn: { label: 'View Own Deliveries', description: 'View only assigned deliveries' },
      accept: { label: 'Accept Deliveries', description: 'Accept assigned deliveries' },
      complete: { label: 'Complete Deliveries', description: 'Mark deliveries as completed' },
      markCollected: { label: 'Mark Collected', description: 'Mark delivery payments as collected' },
      assign: { label: 'Assign Deliveries', description: 'Assign deliveries to personnel' },
      reassign: { label: 'Reassign Deliveries', description: 'Reassign deliveries to different personnel' },
      viewStats: { label: 'View Statistics', description: 'View delivery statistics' }
    }
  },
  users: {
    name: 'Users',
    icon: 'user-cog',
    color: 'rose',
    description: 'User management',
    permissions: {
      view: { label: 'View Users', description: 'View all users' },
      add: { label: 'Add Users', description: 'Add new users' },
      edit: { label: 'Edit Users', description: 'Edit user information' },
      delete: { label: 'Delete Users', description: 'Delete users' },
      managePermissions: { label: 'Manage Permissions', description: 'Manage user permissions' },
      changeRole: { label: 'Change Roles', description: 'Change user roles' },
      resetPassword: { label: 'Reset Password', description: 'Reset user passwords' },
      viewActivity: { label: 'View Activity', description: 'View user activity logs' }
    }
  },
  settings: {
    name: 'Settings',
    icon: 'settings',
    color: 'slate',
    description: 'System settings',
    // NOTE: backup/restore/clearData were removed — those are whole-database
    // operations the server only ever allows for the Admin ROLE, so offering
    // them as grantable toggles was misleading (they never did anything).
    permissions: {
      view: { label: 'View Settings', description: 'View system settings' },
      edit: { label: 'Edit Settings', description: 'Edit system settings' },
      manageExchangeRate: { label: 'Manage Exchange Rate', description: 'Change exchange rates' }
    }
  },
  auditLogs: {
    name: 'Audit Logs',
    icon: 'file-clock',
    color: 'violet',
    description: 'System audit trail',
    // NOTE: 'backup' was removed — no code ever honored it (log backup is an
    // Admin-role operation), so the toggle was decorative.
    permissions: {
      view: { label: 'View Audit Logs', description: 'View all audit logs' },
      viewOwn: { label: 'View Own Logs', description: 'View only own activity' },
      export: { label: 'Export Logs', description: 'Export audit logs' },
      clear: { label: 'Clear Logs', description: 'Clear audit logs' }
    }
  },
  // Clothes System (module keys MUST equal the collection names — the server
  // maps collection → permission module by name)
  clothesProducts: {
    name: 'Clothes — Products',
    icon: 'shirt',
    color: 'rose',
    description: 'Clothes System: products & stock',
    permissions: {
      view: { label: 'View All Products', description: 'View every user\'s products (platform staff)' },
      viewOwn: { label: 'View Own Products', description: 'View only self-created products (subscriber)' },
      add: { label: 'Add Products', description: 'Create new products' },
      edit: { label: 'Edit All Products', description: 'Edit any product' },
      editOwn: { label: 'Edit Own Products', description: 'Edit only self-created products' },
      delete: { label: 'Delete All Products', description: 'Delete any product' },
      deleteOwn: { label: 'Delete Own Products', description: 'Delete only self-created products' }
    }
  },
  clothesShipments: {
    name: 'Clothes — Shipments',
    icon: 'plane',
    color: 'rose',
    description: 'Clothes System: incoming shipments',
    permissions: {
      view: { label: 'View All Shipments', description: 'View every user\'s shipments (platform staff)' },
      viewOwn: { label: 'View Own Shipments', description: 'View only self-created shipments (subscriber)' },
      add: { label: 'Add Shipments', description: 'Create new shipments' },
      edit: { label: 'Edit All Shipments', description: 'Edit any shipment' },
      editOwn: { label: 'Edit Own Shipments', description: 'Edit only self-created shipments' },
      delete: { label: 'Delete All Shipments', description: 'Delete any shipment' },
      deleteOwn: { label: 'Delete Own Shipments', description: 'Delete only self-created shipments' }
    }
  },
  clothesOrders: {
    name: 'Clothes — Orders',
    icon: 'shopping-bag',
    color: 'rose',
    description: 'Clothes System: customer orders',
    permissions: {
      view: { label: 'View All Orders', description: 'View every user\'s orders (platform staff)' },
      viewOwn: { label: 'View Own Orders', description: 'View only self-created orders (subscriber)' },
      add: { label: 'Add Orders', description: 'Create new orders' },
      edit: { label: 'Edit All Orders', description: 'Edit any order' },
      editOwn: { label: 'Edit Own Orders', description: 'Edit only self-created orders' },
      delete: { label: 'Delete All Orders', description: 'Delete any order' },
      deleteOwn: { label: 'Delete Own Orders', description: 'Delete only self-created orders' }
    }
  },
  clothesSettings: {
    name: 'Clothes — Settings',
    icon: 'settings',
    color: 'rose',
    description: 'Clothes System: personal settings (exchange rate)',
    permissions: {
      viewOwn: { label: 'View Own Settings', description: 'View own clothes settings' },
      add: { label: 'Create Settings', description: 'Create own settings record' },
      editOwn: { label: 'Edit Own Settings', description: 'Edit own clothes settings' }
    }
  }
};

// Permission Templates / Presets
const PERMISSION_TEMPLATES = {
  fullAdmin: {
    name: 'Full Administrator',
    description: 'Complete access to all features',
    icon: 'crown',
    color: 'amber',
    permissions: Object.fromEntries(
      Object.entries(PERMISSION_MODULES).map(([module, config]) => [
        module,
        Object.keys(config.permissions)
      ])
    )
  },
  manager: {
    name: 'Manager',
    description: 'Manage operations without system settings',
    icon: 'briefcase',
    color: 'blue',
    permissions: {
      analytics: ['view', 'export', 'viewFinancials'],
      ads: ['view', 'add', 'edit', 'delete', 'changeStatus', 'assignDelivery', 'viewPhotos', 'uploadPhotos'],
      receipts: ['view', 'add', 'edit', 'markCollected', 'viewHistory', 'export'],
      customers: ['view', 'add', 'edit', 'viewBalance', 'viewContacts', 'export'],
      pages: ['view', 'add', 'edit', 'linkCustomers'],
      deliveries: ['view', 'accept', 'complete', 'markCollected', 'assign', 'viewStats'],
      users: ['view', 'viewActivity'],
      auditLogs: ['view', 'viewOwn']
    }
  },
  salesAgent: {
    name: 'Sales Agent',
    description: 'Sales and customer management',
    icon: 'user-check',
    color: 'emerald',
    permissions: {
      analytics: ['view'],
      ads: ['view', 'viewOwn', 'add', 'editOwn', 'viewPhotos', 'uploadPhotos'],
      receipts: ['view', 'viewOwn', 'add', 'editOwn'],
      customers: ['view', 'add', 'edit', 'viewContacts'],
      pages: ['view', 'add'],
      auditLogs: ['viewOwn']
    }
  },
  deliveryDriver: {
    name: 'Delivery Driver',
    description: 'Delivery operations only',
    icon: 'truck',
    color: 'cyan',
    permissions: {
      deliveries: ['viewOwn', 'accept', 'complete', 'markCollected'],
      ads: ['viewOwn'],
      customers: ['viewOwn', 'viewContacts']
    }
  },
  accountant: {
    name: 'Accountant',
    description: 'Financial management access',
    icon: 'calculator',
    color: 'purple',
    permissions: {
      analytics: ['view', 'export', 'viewFinancials', 'viewSensitive'],
      receipts: ['view', 'add', 'edit', 'markCollected', 'transfer', 'viewHistory', 'export'],
      customers: ['view', 'viewBalance'],
      ads: ['view'],
      auditLogs: ['view', 'export']
    }
  },
  viewer: {
    name: 'Read Only',
    description: 'View access only, no modifications',
    icon: 'eye',
    color: 'slate',
    permissions: {
      analytics: ['view'],
      ads: ['view', 'viewPhotos'],
      receipts: ['view'],
      customers: ['view'],
      pages: ['view'],
      deliveries: ['view'],
      auditLogs: ['viewOwn']
    }
  },
  clothesSubscriber: {
    name: 'Clothes Subscriber',
    description: 'Runs their own clothes business — sees only their own data',
    icon: 'shirt',
    color: 'rose',
    permissions: {
      clothesProducts: ['viewOwn', 'add', 'editOwn', 'deleteOwn'],
      clothesShipments: ['viewOwn', 'add', 'editOwn', 'deleteOwn'],
      clothesOrders: ['viewOwn', 'add', 'editOwn', 'deleteOwn'],
      clothesSettings: ['viewOwn', 'add', 'editOwn']
    }
  }
};

// Helper function to check if user has permission
function hasPermission(userId, module, action) {
  // System/admin always has access
  if (!userId || userId === 'system') return true;

  let user = (state.users || []).find(u => u && u.id === userId);
  // FALLBACK: state.users can be empty or hold a permission-less stub (e.g. the
  // /api/users/public list only carries {id,name,role}). The login and
  // /api/auth/me responses always carry the caller's full permissions on
  // state.currentUser — use that as the source of truth for the current user
  // so the whole UI can never lock out a properly-permissioned account.
  if ((!user || !user.permissions) && state.currentUser && String(state.currentUser.id) === String(userId)) {
    user = state.currentUser;
  }
  if (!user) return false;

  // Admins have all permissions
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  
  // Check specific permission - ensure permissions object exists
  const permissions = user.permissions;
  if (!permissions || typeof permissions !== 'object') return false;
  
  // Get module permissions array
  const modulePerms = permissions[module];
  if (!Array.isArray(modulePerms)) return false;
  
  // Check if action is in the permissions array (case-insensitive check as fallback)
  return modulePerms.includes(action) || modulePerms.some(p => String(p).toLowerCase() === String(action).toLowerCase());
}

// Refresh current user's permissions from server.
// Returns true when the permissions actually changed (callers use this to
// schedule a re-render so a locked sidebar can recover without re-login).
async function refreshCurrentUserPermissions() {
  if (!isServerModeEnabled() || !state.currentUser?.id) return false;
  try {
    const me = await apiAuthMe();
    if (me && me.permissions) {
      const changed = JSON.stringify(state.currentUser.permissions || null) !== JSON.stringify(me.permissions);
      state.currentUser.permissions = me.permissions;
      // Also update in users array — UPSERT: if the record is missing (users
      // list fetch failed or returned permission-less stubs), insert it so the
      // periodic refresh can repair an empty state.users.
      upsertCurrentUserIntoUsers();
      if (changed) console.log('[Permissions] Refreshed current user permissions');
      return changed;
    }
  } catch (e) {
    console.warn('[Permissions] Failed to refresh:', e?.message || e);
  }
  return false;
}

// Ensure state.users contains the current user's record WITH permissions.
// state.currentUser always carries the full permission map from the server
// login / /api/auth/me response; the users list for non-admins does not
// (GET /api/users/public returns only {id,name,role}).
function upsertCurrentUserIntoUsers() {
  const cu = state.currentUser;
  if (!cu || !cu.id) return;
  if (!Array.isArray(state.users)) state.users = [];
  const idx = state.users.findIndex(u => u && String(u.id) === String(cu.id));
  if (idx === -1) {
    state.users.push(cu);
  } else {
    state.users[idx] = { ...state.users[idx], ...cu };
  }
}

// Check if current user has permission
function currentUserHasPermission(module, action) {
  return hasPermission(state.currentUser?.id, module, action);
}

// User-management capability: Admin role OR the matching users.* permission.
// The server enforces the same rule (plus anti-escalation guards), so these
// buttons/actions now work for permission-granted non-admins too.
function canManageUsersAction(action) {
  return isCurrentUserAdmin() || currentUserHasPermission('users', action);
}

// Admin role OR the named permission. Use for every capability the
// Permissions Manager advertises, so a granted toggle actually does something.
function can(module, action) {
  return isCurrentUserAdmin() || currentUserHasPermission(module, action);
}

// The audit trail the current user is allowed to SEE.
// auditLogs.view => all entries; auditLogs.viewOwn => only their own.
// Without either, nothing. state.logs is a DEVICE-LOCAL trail (it can hold
// entries written while a different user was logged in on this browser), so
// this scoping is what keeps a viewOwn user from reading someone else's
// activity — never render or export state.logs directly.
function getVisibleAuditLogs() {
  // In server mode the server's trail is authoritative AND already scoped by
  // the caller's auditLogs.view/viewOwn permission (GET /api/audit).
  const source = isServerModeEnabled()
    ? (Array.isArray(state.serverLogs) ? state.serverLogs : [])
    : getVisibleRecords(state.logs);

  if (can('auditLogs', 'view')) return source;
  if (currentUserHasPermission('auditLogs', 'viewOwn')) {
    const uid = String(state.currentUser?.id || '');
    return source.filter(l => String(l?.userId || '') === uid);
  }
  return [];
}

// Refresh the server audit trail, then re-render the Audit Logs screen.
// Cheap guard so the render loop can call it without re-entering.
let _auditFetchInFlight = false;
async function refreshServerAuditLogs({ force = false } = {}) {
  if (!isServerModeEnabled() || !state.currentUser?.id) return;
  if (_auditFetchInFlight) return;
  const fresh = Date.now() - (state.serverLogsLoadedAt || 0) < 15000;
  if (!force && fresh) return;
  _auditFetchInFlight = true;
  try {
    state.serverLogs = await apiListAuditLogs(500);
    state.serverLogsLoadedAt = Date.now();
    if (state.currentView === 'audit') RenderQueue.schedule('auditLogs(server)');
  } catch (e) {
    console.warn('[Audit] Failed to load server logs:', e?.message || e);
  } finally {
    _auditFetchInFlight = false;
  }
}

// Get permission summary for display
function getPermissionSummary(permissions) {
  let total = 0;
  let granted = 0;
  
  Object.entries(PERMISSION_MODULES).forEach(([module, config]) => {
    const modulePerms = Object.keys(config.permissions).length;
    total += modulePerms;
    if (permissions[module]) {
      granted += permissions[module].length;
    }
  });
  
  return { total, granted, percentage: Math.round((granted / total) * 100) };
}

// Check if user can perform action on specific record (own vs all)
function canActOnRecord(module, action, recordCreatorId) {
  // Admin always can
  if (isAdminRole(state.currentUser?.role)) return true;
  
  // Check full permission first
  if (currentUserHasPermission(module, action)) return true;
  
  // Check "own" permission
  const ownAction = action + 'Own';
  if (currentUserHasPermission(module, ownAction) && recordCreatorId === state.currentUser?.id) {
    return true;
  }
  
  return false;
}

// ==========================================
// SUBSCRIPTION HELPERS (Services Hub)
// ==========================================

function hasSubscription(serviceId) {
  if (!state.currentUser) return false;
  if (isAdminRole(state.currentUser.role)) return true; // Admin gets all
  const uid = String(state.currentUser.id || '');
  if (uid && SUBSCRIPTIONS.isActive(uid, serviceId)) return true;
  const subs = state.currentUser.subscriptions || [];
  return subs.includes(serviceId);
}

function getServiceSubscriptionOffer(serviceId) {
  // Child systems (e.g. clothes_system) can carry their own offer too
  const svc = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  const offer = svc && typeof svc === 'object' ? svc.subscription : null;
  const currency = walletNormalizeCurrency(offer?.currency || WALLET.currency);
  const priceMinor = Number.isFinite(Number(offer?.priceMinor))
    ? Math.trunc(Number(offer?.priceMinor))
    : walletToMinor(Number(offer?.price ?? 0), currency);
  const durationDays = Number(offer?.durationDays ?? 30);
  return {
    currency,
    priceMinor: Number.isFinite(priceMinor) && priceMinor >= 0 ? priceMinor : 0,
    durationDays: Number.isFinite(durationDays) && durationDays > 0 ? Math.round(durationDays) : 30
  };
}

function checkServiceAccess(serviceId) {
  const service = SERVICES[serviceId];
  if (service) {
    if (service.comingSoon) return { allowed: false, reason: 'coming_soon' };
    if (service.requiresSubscription && !hasSubscription(service.id)) {
      return { allowed: false, reason: 'not_subscribed', subscribeToId: service.id };
    }
    return { allowed: true };
  }

  const child = SMART_SYSTEMS_CHILDREN[serviceId];
  if (child) {
    if (child.comingSoon) return { allowed: false, reason: 'coming_soon' };
    const required = Array.isArray(child.requiredSubscriptions) && child.requiredSubscriptions.length
      ? child.requiredSubscriptions
      : [child.id];
    const ok = !child.requiresSubscription || required.some((sid) => hasSubscription(sid));
    if (!ok) {
      return { allowed: false, reason: 'not_subscribed', subscribeToId: required[0] || 'smart_systems', requiredSubscriptions: required };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: 'Service not found' };
}

function showSubscriptionModal(serviceId, subscribeToId = serviceId) {
  const service = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  if (!service) return;
  
  const serviceName = state.language === 'ar' ? service.nameAr : service.name;
  
  state.activeModal = 'subscription-lock';
  // Idempotency key prevents double-charging if user retries
  const idem = Security.generateSecureId('idem');
  state.modalData = { serviceId, serviceName, subscribeToId, idempotencyKey: idem };
  renderModal();
}

function openServiceById(id) {
  if (SERVICES[id]) return handleServiceClick(id);
  if (SMART_SYSTEMS_CHILDREN[id]) return handleSmartSystemClick(id);
}

function handleSubscribe(subscribeToId, navigateToId = subscribeToId) {
  if (!state.currentUser?.id) return;
  try {
    // If already active, just continue
    if (hasSubscription(subscribeToId)) {
      closeModal();
      openServiceById(navigateToId);
      return;
    }

    const offer = getServiceSubscriptionOffer(subscribeToId);
    const idem = String(state.modalData?.idempotencyKey || '').trim() || Security.generateSecureId('idem');
    SUBSCRIPTIONS.subscribe(state.currentUser.id, subscribeToId, { ...offer, idempotencyKey: idem });

    // Optional legacy mirror (keeps older UI logic compatible)
    if (!Array.isArray(state.currentUser.subscriptions)) state.currentUser.subscriptions = [];
    if (!state.currentUser.subscriptions.includes(subscribeToId)) {
      state.currentUser.subscriptions.push(subscribeToId);
      // persist into the actual user record too (not only session)
      updateRecord(state.users, state.currentUser.id, { subscriptions: state.currentUser.subscriptions });
    }

    closeModal();
    showNotification(
      state.language === 'ar' ? 'تم الاشتراك' : 'Subscribed',
      state.language === 'ar' ? 'تم تفعيل الخدمة بنجاح' : 'Service activated successfully',
      'success'
    );

    // Now navigate to the originally clicked card
    openServiceById(navigateToId);
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Failed to subscribe', 'error');
  }
}

// ==========================================
// PASSWORD RESET (Advanced, Safe)
// ==========================================

function generateRecoveryKeyPlain() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return (hex.match(/.{1,4}/g) || [hex]).join('-');
}

async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to legacy copy
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

async function setLocalRecoveryKeyFromPlain(plainKey) {
  const key = String(plainKey ?? '').trim();
  if (!key) throw new Error('Recovery key is required');
  const hashed = await Security.hashPassword(key, null, { algo: 'pbkdf2-sha256' });
  state.localRecovery = {
    hash: hashed.hash,
    salt: hashed.salt,
    algo: hashed.algo,
    iterations: hashed.iterations,
    createdAt: Date.now()
  };
  saveState();
}

function showRecoveryKeyModal(plainKey) {
  state.activeModal = 'recovery-key';
  state.modalData = { recoveryKey: String(plainKey ?? '') };
  renderModal();
}

async function generateAndShowRecoveryKey() {
  if (isServerModeEnabled()) {
    showNotification(state.language === 'ar' ? 'غير متاح' : 'Not Available', state.language === 'ar' ? 'مفاتيح الاستعادة للوضع المحلي فقط. استخدم إعادة التعيين عبر البريد الإلكتروني على السيرفر.' : 'Recovery keys are for local mode only. Use email reset on the server.', 'info');
    return;
  }
  if (!state.currentUser || !isAdminRole(state.currentUser.role)) {
    showNotification(state.language === 'ar' ? 'تم رفض الوصول' : 'Access Denied', state.language === 'ar' ? 'فقط المسؤول يمكنه إنشاء مفتاح استعادة.' : 'Only Admin can generate a recovery key.', 'error');
    return;
  }
  const key = generateRecoveryKeyPlain();
  await setLocalRecoveryKeyFromPlain(key);
  showRecoveryKeyModal(key);
}

function showPasswordResetModal() {
  state.activeModal = 'password-reset';
  state.modalData = {
    step: isServerModeEnabled() ? 'request' : 'local',
    email: '',
    token: ''
  };
  renderModal();
}

async function apiPasswordResetRequest(email) {
  const payload = { email };
  return await apiJson('/api/auth/password-reset/request', { method: 'POST', body: payload }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_MS });
}

async function apiPasswordResetConfirm(token, newPassword) {
  const payload = { token, newPassword };
  return await apiJson('/api/auth/password-reset/confirm', { method: 'POST', body: payload }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
}

async function passwordResetRequestServer() {
  try {
    const emailInput = document.getElementById('pwreset-email');
    const email = Security.sanitizeInput(String(emailInput?.value || '').toLowerCase().trim(), { maxLength: 120 });
    if (!Security.isValidEmail(email)) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'الرجاء إدخال بريد إلكتروني صحيح' : 'Please enter a valid email address', 'error');
      return;
    }
    const res = await apiPasswordResetRequest(email);
    state.modalData = { step: 'confirm', email, token: String(res?.resetCode || '') };
    renderModal();
    showNotification(state.language === 'ar' ? 'تم إرسال رمز إعادة التعيين' : 'Reset Code Sent', state.language === 'ar' ? 'إذا كان هذا الحساب موجوداً، ستستلم رمز إعادة تعيين.' : 'If this account exists, you will receive a reset code.', 'success');
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e.message || (state.language === 'ar' ? 'فشل طلب إعادة التعيين' : 'Failed to request reset'), 'error');
  }
}

async function passwordResetConfirmServer() {
  try {
    const token = Security.sanitizeInput(String(document.getElementById('pwreset-token')?.value || '').trim(), { maxLength: 256 });
    const newPassword = String(document.getElementById('pwreset-new')?.value || '');
    const confirm = String(document.getElementById('pwreset-confirm')?.value || '');

    if (!token) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'رمز إعادة التعيين مطلوب' : 'Reset code is required', 'error');
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'يجب أن تكون كلمة المرور 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
      return;
    }
    if (newPassword !== confirm) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match', 'error');
      return;
    }

    await apiPasswordResetConfirm(token, newPassword);
    closeModal();
    showNotification(state.language === 'ar' ? 'نجاح' : 'Success', state.language === 'ar' ? 'تمت إعادة تعيين كلمة المرور بنجاح. الرجاء تسجيل الدخول.' : 'Password reset successfully. Please sign in.', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'فشلت إعادة التعيين' : 'Reset Failed', e.message || (state.language === 'ar' ? 'رمز إعادة التعيين غير صحيح أو منتهي الصلاحية' : 'Invalid or expired reset code'), 'error');
  }
}

async function passwordResetConfirmLocal() {
  try {
    if (isServerModeEnabled()) {
      showNotification(state.language === 'ar' ? 'وضع السيرفر' : 'Server Mode', state.language === 'ar' ? 'استخدم إعادة تعيين كلمة المرور عبر السيرفر.' : 'Use server password reset.', 'info');
      return;
    }
    const email = Security.sanitizeInput(String(document.getElementById('pwreset-email')?.value || '').toLowerCase().trim(), { maxLength: 120 });
    const recoveryKey = String(document.getElementById('pwreset-recovery')?.value || '').trim();
    const newPassword = String(document.getElementById('pwreset-new')?.value || '');
    const confirm = String(document.getElementById('pwreset-confirm')?.value || '');

    if (!Security.isValidEmail(email)) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'الرجاء إدخال بريد إلكتروني صحيح' : 'Please enter a valid email address', 'error');
      return;
    }
    if (!state.localRecovery?.hash || !state.localRecovery?.salt) {
      showNotification(state.language === 'ar' ? 'مفتاح الاستعادة غير مُعدّ' : 'Recovery Not Set', state.language === 'ar' ? 'لا يوجد مفتاح استعادة مُعدّ. اطلب من المسؤول إنشاء واحد من الإعدادات ← الأمان.' : 'No recovery key is configured. Ask Admin to create one in Settings → Security.', 'error');
      return;
    }
    const ok = await Security.verifyPassword(
      recoveryKey,
      state.localRecovery.hash,
      state.localRecovery.salt,
      state.localRecovery.algo || 'pbkdf2-sha256',
      state.localRecovery.iterations || 310000
    );
    if (!ok) {
      showNotification(state.language === 'ar' ? 'مفتاح استعادة غير صحيح' : 'Invalid Recovery Key', state.language === 'ar' ? 'مفتاح الاستعادة غير صحيح.' : 'The recovery key is incorrect.', 'error');
      addSecurityLog('password_reset_bad_recovery_key', email);
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'يجب أن تكون كلمة المرور 8 أحرف على الأقل' : 'Password must be at least 8 characters', 'error');
      return;
    }
    if (newPassword !== confirm) {
      showNotification(state.language === 'ar' ? 'تحقق' : 'Validation', state.language === 'ar' ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match', 'error');
      return;
    }

    const user = state.users.find(u => u && !u._deleted && String(u.email || '').toLowerCase() === email);
    if (!user) {
      showNotification(state.language === 'ar' ? 'غير موجود' : 'Not Found', state.language === 'ar' ? 'لا يوجد مستخدم بهذا البريد الإلكتروني (محلي).' : 'No user found with this email (local).', 'error');
      return;
    }

    const hashed = await Security.hashPassword(newPassword, null, { algo: 'pbkdf2-sha256' });
    const updates = {
      passwordHash: hashed.hash,
      salt: hashed.salt,
      passwordAlgo: hashed.algo,
      passwordIterations: hashed.iterations
    };
    updateRecord(state.users, user.id, updates);
    markCollectionDirty('users');
    saveState();
    flushDirtyCollections().catch(() => {});

    closeModal();
    showNotification(state.language === 'ar' ? 'نجاح' : 'Success', state.language === 'ar' ? 'تمت إعادة تعيين كلمة المرور بنجاح. الرجاء تسجيل الدخول.' : 'Password reset successfully. Please sign in.', 'success');
    render();
  } catch (e) {
    console.error('Local password reset error:', e);
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e.message || (state.language === 'ar' ? 'فشلت إعادة تعيين كلمة المرور' : 'Failed to reset password'), 'error');
  }
}

// ==========================================
// PASSKEYS (WebAuthn) - Local-first, Safe Verification
// ==========================================

function _bufToB64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return b64;
}

function _b64urlToBuf(b64url) {
  const s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function _sha256(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  const h = await crypto.subtle.digest('SHA-256', ab);
  return new Uint8Array(h);
}

function _concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Minimal CBOR decoder for WebAuthn objects (maps/arrays/bytes/ints/strings)
function _cborDecode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let offset = 0;

  function read(n) {
    const end = offset + n;
    if (end > bytes.length) throw new Error('CBOR: out of range');
    const out = bytes.slice(offset, end);
    offset = end;
    return out;
  }

  function readUInt(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return read(1)[0];
    if (ai === 25) {
      const v = read(2);
      return (v[0] << 8) | v[1];
    }
    if (ai === 26) {
      const v = read(4);
      return (v[0] * 2 ** 24) + (v[1] << 16) + (v[2] << 8) + v[3];
    }
    throw new Error('CBOR: unsupported int size');
  }

  function decodeItem() {
    const first = read(1)[0];
    const major = first >> 5;
    const ai = first & 0x1f;

    if (major === 0) return readUInt(ai);
    if (major === 1) return -1 - readUInt(ai);
    if (major === 2) {
      const len = readUInt(ai);
      return read(len); // Uint8Array
    }
    if (major === 3) {
      const len = readUInt(ai);
      const s = read(len);
      return new TextDecoder().decode(s);
    }
    if (major === 4) {
      const len = readUInt(ai);
      const arr = [];
      for (let i = 0; i < len; i++) arr.push(decodeItem());
      return arr;
    }
    if (major === 5) {
      const len = readUInt(ai);
      const m = new Map();
      for (let i = 0; i < len; i++) {
        const k = decodeItem();
        const v = decodeItem();
        m.set(k, v);
      }
      return m;
    }
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
    }
    throw new Error('CBOR: unsupported type');
  }

  const value = decodeItem();
  return { value, readBytes: offset };
}

function _getRpId() {
  const host = String(location.hostname || '').trim();
  return host || null;
}

function _isPasskeySupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

function _listAllStoredPasskeys() {
  const out = [];
  for (const u of (state.users || [])) {
    if (!u || u._deleted) continue;
    const keys = Array.isArray(u.passkeys) ? u.passkeys : [];
    for (const k of keys) {
      if (k && k.id && k.publicKeyJwk) out.push({ user: u, key: k });
    }
  }
  return out;
}

async function passkeyRegisterCurrentUser() {
  try {
    if (!_isPasskeySupported()) {
      showNotification(state.language === 'ar' ? 'غير مدعوم' : 'Not Supported', state.language === 'ar' ? 'مفاتيح المرور تتطلب HTTPS أو localhost.' : 'Passkeys require HTTPS or localhost.', 'error');
      return;
    }
    if (!state.currentUser?.id) {
      showNotification(state.language === 'ar' ? 'غير مسجل الدخول' : 'Not Logged In', state.language === 'ar' ? 'الرجاء تسجيل الدخول أولاً لإضافة مفتاح مرور.' : 'Please login first to add a passkey.', 'error');
      return;
    }

    const rpId = _getRpId();
    if (!rpId) {
      showNotification(state.language === 'ar' ? 'غير مدعوم' : 'Not Supported', state.language === 'ar' ? 'مفاتيح المرور تتطلب أصل ويب (HTTPS/localhost).' : 'Passkeys require a web origin (HTTPS/localhost).', 'error');
      return;
    }

    const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id) || state.currentUser;
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const publicKey = {
      challenge,
      rp: { name: t('appName') },
      user: {
        id: new TextEncoder().encode(String(user.id)),
        name: String(user.email || user.id),
        displayName: String(user.name || user.email || user.id)
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 } // ES256
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      },
      timeout: TIME_CONSTANTS.WEBAUTHN_TIMEOUT_MS,
      attestation: 'none'
    };

    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('Passkey creation cancelled');

    const rawId = cred.rawId;
    const credentialId = _bufToB64url(rawId);

    // Parse attestationObject → authData → COSE key
    const attObj = new Uint8Array(cred.response.attestationObject);
    const { value: attMap } = _cborDecode(attObj);
    if (!(attMap instanceof Map)) throw new Error('Invalid attestation');
    const authData = attMap.get('authData');
    if (!(authData instanceof Uint8Array)) throw new Error('Invalid authData');

    const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
    const flags = authData[32];
    const hasAttestedCredData = (flags & 0x40) !== 0;
    if (!hasAttestedCredData) throw new Error('Authenticator did not return credential data');

    // authData layout: rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | coseKey
    let p = 37; // 32 + 1 + 4
    p += 16; // aaguid
    const credIdLen = (authData[p] << 8) | authData[p + 1];
    p += 2;
    const credIdBytes = authData.slice(p, p + credIdLen);
    p += credIdLen;
    const coseBytes = authData.slice(p);
    const { value: coseKey } = _cborDecode(coseBytes);
    if (!(coseKey instanceof Map)) throw new Error('Invalid COSE key');

    const kty = coseKey.get(1);
    const alg = coseKey.get(3);
    const crv = coseKey.get(-1);
    const x = coseKey.get(-2);
    const y = coseKey.get(-3);
    if (kty !== 2 || alg !== -7 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error('Unsupported passkey algorithm (only ES256/P-256 supported)');
    }

    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: _bufToB64url(x),
      y: _bufToB64url(y),
      ext: true
    };

    if (!Array.isArray(user.passkeys)) user.passkeys = [];
    const exists = user.passkeys.some(k => k && k.id === credentialId);
    if (!exists) {
      user.passkeys.push({
        id: credentialId,
        publicKeyJwk: jwk,
        alg: 'ES256',
        createdAt: Date.now()
      });
      updateRecord(state.users, user.id, { passkeys: user.passkeys });
    }

    showNotification(state.language === 'ar' ? 'نجاح' : 'Success', state.language === 'ar' ? 'تمت إضافة مفتاح المرور بنجاح' : 'Passkey added successfully', 'success');
    render(); // refresh settings UI
  } catch (e) {
    console.error('Passkey register error:', e);
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e.message || (state.language === 'ar' ? 'فشلت إضافة مفتاح المرور' : 'Failed to add passkey'), 'error');
  }
}

async function passkeySignIn() {
  try {
    if (isServerModeEnabled()) {
      showNotification(state.language === 'ar' ? 'غير متاح' : 'Not Available', state.language === 'ar' ? 'تسجيل الدخول بمفتاح المرور يتطلب دعم WebAuthn على السيرفر (قريباً).' : 'Passkey sign-in requires server WebAuthn endpoints (next step).', 'info');
      return;
    }
    if (!_isPasskeySupported()) {
      showNotification(state.language === 'ar' ? 'غير مدعوم' : 'Not Supported', state.language === 'ar' ? 'مفاتيح المرور تتطلب HTTPS أو localhost.' : 'Passkeys require HTTPS or localhost.', 'error');
      return;
    }

    const rpId = _getRpId();
    if (!rpId) {
      showNotification(state.language === 'ar' ? 'غير مدعوم' : 'Not Supported', state.language === 'ar' ? 'مفاتيح المرور تتطلب أصل ويب (HTTPS/localhost).' : 'Passkeys require a web origin (HTTPS/localhost).', 'error');
      return;
    }

    const stored = _listAllStoredPasskeys();
    if (stored.length === 0) {
      showNotification(state.language === 'ar' ? 'لا توجد مفاتيح مرور' : 'No Passkeys', state.language === 'ar' ? 'لا توجد مفاتيح مرور. سجّل الدخول بكلمة المرور ثم أضف واحداً من الإعدادات ← الأمان.' : 'No passkeys found. Login with password then add one in Settings → Security.', 'info');
      return;
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const allowCredentials = stored.map(({ key }) => ({
      type: 'public-key',
      id: _b64urlToBuf(key.id)
    }));

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials,
        userVerification: 'preferred',
        timeout: 60000
      }
    });

    if (!assertion) throw new Error('Passkey sign-in cancelled');

    const credId = _bufToB64url(assertion.rawId);
    const match = stored.find(({ key }) => key.id === credId);
    if (!match) throw new Error('Unknown passkey');

    const { user, key } = match;
    const clientData = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON));
    if (clientData?.type !== 'webauthn.get') throw new Error('Invalid assertion type');
    if (clientData?.origin !== location.origin) throw new Error('Origin mismatch');

    const authData = new Uint8Array(assertion.response.authenticatorData);
    const rpIdHash = authData.slice(0, 32);
    const expectedRpIdHash = await _sha256(new TextEncoder().encode(rpId));
    for (let i = 0; i < 32; i++) {
      if (rpIdHash[i] !== expectedRpIdHash[i]) throw new Error('RP ID mismatch');
    }

    const clientDataHash = await _sha256(assertion.response.clientDataJSON);
    const signedData = _concatBytes(authData, clientDataHash);
    const signature = new Uint8Array(assertion.response.signature);

    const jwk = key.publicKeyJwk;
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signature,
      signedData
    );

    if (!ok) throw new Error('Passkey verification failed');

    // Login
    SessionManager.createSession(user.id);
    state.currentUser = user;
    if (!Array.isArray(state.currentUser.subscriptions)) {
      state.currentUser.subscriptions = [];
      if (isAdminRole(state.currentUser.role)) {
        state.currentUser.subscriptions = Object.keys(SERVICES);
      }
    }
    state.currentView = getPostLoginLandingViewForUser(user);
    saveState();
    showNotification(state.language === 'ar' ? 'مرحباً!' : 'Welcome!', state.language === 'ar' ? `تم تسجيل الدخول باسم ${Security.escapeHtml(user.name || user.email || user.id)}` : `Logged in as ${Security.escapeHtml(user.name || user.email || user.id)}`, 'success');
    render();
  } catch (e) {
    console.error('Passkey sign-in error:', e);
    showNotification(state.language === 'ar' ? 'فشل الدخول بمفتاح المرور' : 'Passkey Login Failed', e.message || (state.language === 'ar' ? 'فشل تسجيل الدخول بمفتاح المرور' : 'Failed to sign in with passkey'), 'error');
  }
}

function removePasskey(credentialId) {
  try {
    if (!state.currentUser?.id) {
      showNotification(state.language === 'ar' ? 'خطأ' : 'Error', state.language === 'ar' ? 'غير مسجل الدخول' : 'Not logged in', 'error');
      return;
    }
    const id = String(credentialId || '').trim();
    if (!id) return;
    const user = state.users.find(u => u && !u._deleted && u.id === state.currentUser.id);
    if (!user) return;
    const keys = Array.isArray(user.passkeys) ? user.passkeys : [];
    const next = keys.filter(k => k && k.id !== id);
    updateRecord(state.users, user.id, { passkeys: next });
    showNotification(state.language === 'ar' ? 'تم الحذف' : 'Removed', state.language === 'ar' ? 'تم حذف مفتاح المرور' : 'Passkey removed', 'success');
    render();
  } catch (e) {
    console.error('removePasskey error:', e);
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e.message || (state.language === 'ar' ? 'فشل حذف مفتاح المرور' : 'Failed to remove passkey'), 'error');
  }
}

function showChangePasswordModal() {
  state.activeModal = 'change-password';
  state.modalData = {};
  renderModal();
}

async function apiChangePassword(currentPassword, newPassword) {
  const payload = { currentPassword, newPassword };
  return await apiJson('/api/auth/password-change', { method: 'POST', body: payload }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
}

