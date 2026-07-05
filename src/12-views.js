// ==========================================
// VIEW RENDERING FUNCTIONS  
// ==========================================

// All views and modals continue here...
// Due to file size, creating comprehensive vanilla_v1/COMPLETE_SCRIPT_CONTINUATION.txt
// with all remaining code that should be appended here.

// For now, here's a minimal working version:

// Track last rendered view to avoid unnecessary full re-renders
let _lastRenderedView = null;
let _lastRenderedUserId = null;
let _renderInProgress = false;
let _savedScrollPosition = { top: 0, left: 0 };

// Force a full re-render (bypasses partial update optimization)
function forceFullRender() {
  _lastRenderedView = null;
  _lastRenderedUserId = null;
  render();
}

// Helper: Lock layout during render to prevent jumps
function lockLayoutForRender(app) {
  if (!app) return;
  // Save current dimensions before render
  const currentHeight = app.offsetHeight;
  app.style.setProperty('--app-height', currentHeight + 'px');
  app.classList.add('is-rendering');
  document.documentElement.classList.add('is-rendering');
}

// Helper: Unlock layout after render
function unlockLayoutAfterRender(app) {
  if (!app) return;
  app.classList.remove('is-rendering');
  document.documentElement.classList.remove('is-rendering');
  app.style.removeProperty('--app-height');
}

// Capture the currently-focused text field (by id) and its caret, so a
// full/partial re-render can put the cursor back where the user was typing.
function _captureFocusState() {
  const el = document.activeElement;
  if (!el || !el.id) return null;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return null;
  const state = { id: el.id };
  try {
    if (tag !== 'SELECT' && typeof el.selectionStart === 'number') {
      state.start = el.selectionStart;
      state.end = el.selectionEnd;
    }
  } catch (_) { /* some input types disallow selection access */ }
  return state;
}

function _restoreFocusState(saved) {
  if (!saved) return;
  const el = document.getElementById(saved.id);
  if (!el || el === document.activeElement) return;
  try {
    el.focus({ preventScroll: true });
    if (typeof saved.start === 'number' && typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(saved.start, saved.end);
    }
  } catch (_) { /* ignore focus/caret restore failures */ }
}

function render() {
  // Prevent re-entrant rendering
  if (_renderInProgress) return;
  _renderInProgress = true;

  // IMPORTANT: Save scroll position BEFORE any DOM changes
  // Use multiple methods for reliability across browsers
  _savedScrollPosition = {
    top: window.pageYOffset || window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0,
    left: window.pageXOffset || window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0
  };

  const app = document.getElementById('app');

  try {
    if (!app) {
      _renderInProgress = false;
      return;
    }

    // Lock layout to prevent jumps during render
    lockLayoutForRender(app);

    // Hide loading screen on first render
    const loadingScreen = document.getElementById('app-loading-screen');
    if (loadingScreen) loadingScreen.style.display = 'none';

    // Determine what we're rendering
    const currentView = state.currentView;
    const currentUserId = state.currentUser?.id;
    const isLoggedIn = !!state.currentUser;

    // Check if we can do a partial update (same view, same user)
    const canPartialUpdate = _lastRenderedView === currentView &&
                             _lastRenderedUserId === currentUserId &&
                             isLoggedIn;

    if (!state.currentUser) {
      if (!isServerModeEnabled() && (!Array.isArray(state.users) || state.users.length === 0)) {
        app.innerHTML = renderFirstRunSetup();
        attachFirstRunHandlers();
      } else {
        app.innerHTML = renderLogin();
        attachLoginHandlers();
      }
      _lastRenderedView = null;
      _lastRenderedUserId = null;
    } else {
      // Enforce "secret ideas" gating for non-admin users
      enforceSecretFeaturesGate();

      // Preserve keyboard focus + caret across the innerHTML swap. Without
      // this, a background live-sync render() (every 3s) recreates the DOM and
      // steals focus while the user is typing in e.g. the receipts search box.
      const _focusBefore = _captureFocusState();

      // For main app, try to update only the content area if possible
      if (canPartialUpdate) {
        // Only update the view content, not the entire app
        const viewContainer = app.querySelector('.p-4.md\\:p-8');
        if (viewContainer) {
          viewContainer.innerHTML = renderView();
        } else {
          app.innerHTML = renderMainApp();
        }
      } else {
        app.innerHTML = renderMainApp();
      }

      _restoreFocusState(_focusBefore);

      _lastRenderedView = currentView;
      _lastRenderedUserId = currentUserId;
    }

    // Use scoped icon creation (faster than full DOM scan)
    IconQueue.schedule(app);
    renderSyncStatus();

    // IMPORTANT: Restore scroll position AFTER render using double-RAF for reliability
    // First RAF waits for layout, second ensures paint is complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Restore scroll position
        window.scrollTo({
          left: _savedScrollPosition.left,
          top: _savedScrollPosition.top,
          behavior: 'instant' // Use instant to prevent smooth scroll animation
        });
        // Unlock layout after scroll is restored
        unlockLayoutAfterRender(app);
      });
    });
  } catch (e) {
    console.error('[render] Error:', e);
    unlockLayoutAfterRender(app);
  } finally {
    _renderInProgress = false;
  }
}

function renderFirstRunSetup() {
  const modeNote = isServerModeEnabled()
    ? 'Server mode detected. Please login with your server account.'
    : 'First time setup (local testing). Create an Admin account to start.';

  return `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="glass-panel w-full max-w-md p-8 rounded-3xl animate-fade-in-up">
        <div class="text-center mb-6">
          <div class="w-16 h-16 alb-mark rounded-2xl mx-auto mb-4 flex items-center justify-center text-white text-2xl font-bold">A</div>
          <h1 class="text-2xl font-bold text-slate-800 dark:text-white">${t('appName')}</h1>
          <p class="text-slate-500 mt-1">${modeNote}</p>
        </div>

        <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 mb-6">
          <div class="text-xs text-slate-600 dark:text-slate-300">
            <div class="font-bold mb-1">Why this setup?</div>
            <div>For local testing you need one admin user. For internet deployment, users must be created on the server.</div>
          </div>
        </div>

        <form id="first-run-form" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-2">Admin Name</label>
            <input type="text" id="first-name" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Your name" maxlength="100" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('email')}</label>
            <input type="email" id="first-email" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="name@company.com" maxlength="120" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">${t('password')}</label>
            <input type="password" id="first-password" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Min. 8 characters" minlength="8" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">Confirm Password</label>
            <input type="password" id="first-password-confirm" required class="w-full px-4 py-3 glass-input rounded-xl" placeholder="Repeat password" minlength="8" />
          </div>
          <button type="submit" class="w-full btn-shine alb-btn-primary text-white font-bold py-3 rounded-xl transition-all">
            Create Admin (Local)
          </button>
        </form>

        <button onclick="toggleLanguage()" class="mt-4 text-xs text-slate-400 alb-hover-brand mx-auto block">${state.language === 'en' ? 'العربية' : 'English'}</button>
      </div>
    </div>
  `;
}

function attachFirstRunHandlers() {
  const form = document.getElementById('first-run-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (isServerModeEnabled()) {
        showNotification('Server Mode', 'Server mode is enabled. Please login with your server account.', 'error');
        render();
        return;
      }

      const name = Security.sanitizeInput(document.getElementById('first-name').value, { maxLength: 100 });
      const email = Security.sanitizeInput(document.getElementById('first-email').value, { maxLength: 120 }).toLowerCase();
      const password = document.getElementById('first-password').value;
      const confirm = document.getElementById('first-password-confirm').value;

      if (!name) {
        showNotification('Validation Error', 'Name is required', 'error');
        return;
      }
      if (!Security.isValidEmail(email)) {
        showNotification('Validation Error', 'Please enter a valid email', 'error');
        return;
      }
      if (!password || String(password).length < 8) {
        showNotification('Validation Error', 'Password must be at least 8 characters', 'error');
        return;
      }
      if (password !== confirm) {
        showNotification('Validation Error', 'Passwords do not match', 'error');
        return;
      }

      // Create local admin (hashed)
      const hashed = await Security.hashPassword(password, null, { algo: 'pbkdf2-sha256' });
      const admin = {
        id: generateId('user'),
        name,
        email,
        role: 'Admin',
        permissions: {},
        subscriptions: Object.keys(SERVICES), // Admin gets all services
        passwordHash: hashed.hash,
        salt: hashed.salt,
        passwordAlgo: hashed.algo,
        passwordIterations: hashed.iterations,
        _lastModified: Date.now(),
        _deleted: false
      };

      state.users = [admin];
      markCollectionDirty('users');
      saveState();

      SessionManager.createSession(admin.id);
      state.currentUser = admin;
      state.currentView = getPostLoginLandingViewForUser(admin);
      saveState();

      showNotification('Success', 'Admin account created (local)', 'success');
      render();

      // Generate a Recovery Key on first run (recommended for safe password resets in local mode)
      if (!state.localRecovery) {
        setTimeout(() => {
          generateAndShowRecoveryKey().catch(() => {});
        }, 300);
      }
    } catch (err) {
      console.error('First run setup error:', err);
      showNotification('Error', 'Failed to create admin', 'error');
    }
  });
}

function renderLogin() {
  const isRTL = state.language === 'ar';
  const passkeySupported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  const passkeyHint = passkeySupported
    ? (isRTL ? 'يمكنك استخدام بصمة/Face ID (Passkey) إذا تم إعدادها مسبقاً.' : 'You can use a Passkey (Face ID / Touch ID) if you already set one up.')
    : (isRTL ? 'Passkey يتطلب HTTPS أو localhost. افتح التطبيق عبر localhost لاستخدامه.' : 'Passkeys require HTTPS or localhost. Open the app via localhost to use it.');

  return `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <div class="glass-panel w-full p-8 rounded-3xl animate-fade-in-up">
          <div class="text-center mb-8">
            <div class="w-16 h-16 rounded-3xl mx-auto mb-4 alb-mark alb-mark-dot flex items-center justify-center">
              <span class="text-white text-2xl font-extrabold">A</span>
            </div>
            <h1 class="text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">${t('appName')}</h1>
            <p class="text-slate-500 mt-2">${t('signInTitle')}</p>
          </div>

          <form id="login-form" class="space-y-4">
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${t('email')}</label>
              <div class="relative">
                <i data-lucide="mail" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input type="email" id="login-email" required class="w-full pl-10 pr-4 py-3 glass-input rounded-xl" placeholder="name@company.com" autocomplete="username" />
              </div>
            </div>
            <div>
              <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase mb-2">${t('password')}</label>
              <div class="relative">
                <i data-lucide="lock" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
                <input type="password" id="login-password" required class="w-full pl-10 pr-4 py-3 glass-input rounded-xl" placeholder="••••••••" autocomplete="current-password" />
              </div>
            </div>

            <div class="flex items-center justify-between pt-1">
              <button type="button" onclick="showPasswordResetModal()" class="text-sm font-medium alb-link">
                ${t('forgotPassword')}
              </button>
              <button type="button" onclick="toggleLanguage()" class="text-sm font-bold text-slate-500 alb-hover-brand">
                ${state.language === 'en' ? 'العربية' : 'English'}
              </button>
            </div>

            <button type="submit" class="w-full btn-shine alb-btn-primary text-white font-extrabold py-3 rounded-xl transition-all">
              ${t('loginButton')}
            </button>
          </form>

          <div class="my-6 flex items-center gap-3">
            <div class="flex-1 h-px bg-slate-200 dark:bg-slate-800"></div>
            <div class="text-[11px] font-bold text-slate-400 uppercase">${isRTL ? 'أو' : 'or'}</div>
            <div class="flex-1 h-px bg-slate-200 dark:bg-slate-800"></div>
          </div>

          <button type="button"
            onclick="passkeySignIn()"
            ${passkeySupported ? '' : 'disabled'}
            class="w-full glass-panel rounded-xl px-4 py-3 font-extrabold flex items-center justify-center gap-2 ${passkeySupported ? 'hover:shadow-xl' : 'opacity-60 cursor-not-allowed'}"
            title="${Security.escapeHtml(passkeyHint)}"
          >
            <i data-lucide="key-round" class="w-5 h-5"></i>
            <span>${isRTL ? 'تسجيل الدخول باستخدام Passkey' : 'Sign in with a Passkey'}</span>
          </button>
          <div class="mt-2 text-[11px] text-slate-400 text-center">
            ${passkeyHint}
          </div>
        </div>
      </div>
    </div>
  `;
}

function attachLoginHandlers() {
  const form = document.getElementById('login-form');
  // #region agent log
  // Hypothesis H-LUI: User reports "login doesn't work" but we see no H-LOGIN logs.
  // Confirm whether the login handler is attached and whether submit fires (no PII).
  try {
    if (typeof window.__albayanDebugEmit === 'function') {
      window.__albayanDebugEmit('H-LUI', 'script.js:attachLoginHandlers', 'attach', {
        formFound: !!form,
        protocol: String(window.location?.protocol || '').slice(0, 16),
        serverMode: !!state.serverMode,
        serverDetected: !!state.serverDetected,
        override: String(state.serverModeOverride || '').slice(0, 16),
      });
    }
  } catch (_) {}
  // #endregion
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      // #region agent log
      try {
        if (typeof window.__albayanDebugEmit === 'function') {
          window.__albayanDebugEmit('H-LUI', 'script.js:attachLoginHandlers', 'submit', {
            emailLen: String(email || '').length,
            passwordLen: String(password || '').length,
            hasAt: String(email || '').includes('@'),
            protocol: String(window.location?.protocol || '').slice(0, 16),
            serverMode: !!state.serverMode,
          });
        }
      } catch (_) {}
      // #endregion
      handleLogin(email, password);
    });

    // #region agent log
    // Some browsers won't fire submit if HTML5 validity fails. Capture click + validity state.
    try {
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.addEventListener('click', (e) => {
          const emailEl = document.getElementById('login-email');
          const pwEl = document.getElementById('login-password');
          const email = emailEl ? emailEl.value : '';
          const password = pwEl ? pwEl.value : '';
          const emailOk = emailEl && typeof emailEl.checkValidity === 'function' ? emailEl.checkValidity() : null;
          const pwOk = pwEl && typeof pwEl.checkValidity === 'function' ? pwEl.checkValidity() : null;
          const formOk = typeof form.checkValidity === 'function' ? form.checkValidity() : null;
          try {
            if (typeof window.__albayanDebugEmit === 'function') {
              window.__albayanDebugEmit('H-LUI', 'script.js:attachLoginHandlers', 'click', {
                emailLen: String(email || '').length,
                passwordLen: String(password || '').length,
                emailOk,
                pwOk,
                formOk,
                serverMode: !!state.serverMode,
              });
            }
          } catch (_) {}
          // If valid, force the login call here so we don't depend on submit firing.
          if (formOk === true) {
            e.preventDefault();
            handleLogin(email, password);
          }
        });
      }
    } catch (_) {}
    // #endregion
  }
}

function renderMainApp() {
  const dir = getDir();
  const showSidebar = !['services-hub', 'smart-systems', 'service-placeholder', 'wallet'].includes(state.currentView);
  
  return `
    <div class="flex min-h-screen" dir="${dir}">
      ${showSidebar ? renderSidebar() : ''}
      <!-- Sidebar is fixed on desktop (md), so main content must offset by sidebar width for ALL roles -->
      <main class="flex-1 ${showSidebar ? (dir === 'rtl' ? 'md:mr-72' : 'md:ml-72') : ''}">
        ${showSidebar ? `
        <header class="sticky top-0 z-20 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-6 py-4 md:hidden flex justify-between items-center">
          <div class="font-bold">${t('adManager')}</div>
          <button onclick="toggleMobileMenu()" class="text-slate-600 dark:text-slate-300"><i data-lucide="menu" class="w-6 h-6"></i></button>
        </header>
        ` : ''}
        <div class="p-4 md:p-8 max-w-7xl mx-auto">${renderView()}</div>
      </main>
    </div>
  `;
}

function renderSidebar() {
  // Map nav items to their permission modules
  const navItemPermissions = {
    'analytics': 'analytics',
    'customers': 'customers',
    'receipts': 'receipts',
    'pages': 'pages',
    'ads': 'ads',
    'deliveries': 'deliveries',
    'reconciliation': 'analytics', // Part of analytics
    'users': 'users',
    'audit': 'auditLogs',
    'settings': 'settings'
  };
  
  const allNavItems = [
    { id: 'analytics', icon: 'layout-dashboard', label: 'analytics' },
    { id: 'customers', icon: 'smile', label: 'customers' },
    { id: 'receipts', icon: 'receipt', label: 'receipts' },
    { id: 'pages', icon: 'file-text', label: 'pages' },
    { id: 'ads', icon: 'megaphone', label: 'ads' },
    { id: 'deliveries', icon: 'truck', label: 'deliveries' },
    { id: 'reconciliation', icon: 'clipboard-check', label: 'jobReconciliation' },
    { id: 'users', icon: 'users', label: 'users' },
    { id: 'audit', icon: 'file-clock', label: 'auditLogs' },
    { id: 'settings', icon: 'settings', label: 'settings' },
  ];

  // Delivery users have a special dashboard view (not permission-gated).
  if (isDeliveryRole(state.currentUser?.role)) {
    allNavItems.unshift({ id: 'delivery-dashboard', icon: 'layout-dashboard', label: 'dashboard' });
  }
  
  // Filter nav items based on permissions (Admin sees all, others based on their permissions)
  const navItems = allNavItems.filter(item => {
    // Admin sees everything
    if (isAdminRole(state.currentUser?.role)) return true;
    
    // Delivery role - show delivery dashboard + deliveries
    if (isDeliveryRole(state.currentUser?.role)) {
      return item.id === 'delivery-dashboard' || item.id === 'deliveries';
    }
    
    // Check if user has view permission for this module
    const permModule = navItemPermissions[item.id];
    return currentUserHasPermission(permModule, 'view') || 
           currentUserHasPermission(permModule, 'viewOwn');
  });
  
  // If no nav items visible, show minimal sidebar
  if (navItems.length === 0) {
    return `
      <aside class="fixed inset-y-0 left-0 z-50 w-72 bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl border-r border-white/20 shadow-lg transform transition-transform duration-500 ${state.isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 flex flex-col">
        <div class="p-6 border-b border-white/10">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 alb-mark rounded-xl flex items-center justify-center text-white font-bold">A</div>
            <span class="font-bold text-slate-800 dark:text-white">${t('adManager')}</span>
          </div>
        </div>
        <div class="flex-1 flex items-center justify-center p-6">
          <div class="text-center">
            <i data-lucide="lock" class="w-12 h-12 mx-auto text-slate-300 mb-3"></i>
            <p class="text-sm text-slate-500">No access granted</p>
            <p class="text-xs text-slate-400 mt-1">Contact admin for permissions</p>
          </div>
        </div>
        <div class="p-4 border-t border-white/10">
          <button onclick="handleLogout()" class="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl font-medium text-rose-600 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100">
            <i data-lucide="log-out" class="w-5 h-5"></i>
            <span>${t('logout')}</span>
          </button>
        </div>
      </aside>
    `;
  }
  
  const showServicesHubLink = isCurrentUserAdmin();
  return `
    ${state.isMobileMenuOpen ? '<div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 md:hidden" onclick="toggleMobileMenu()"></div>' : ''}
    <aside class="fixed inset-y-0 left-0 z-50 w-72 bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl border-r border-white/20 shadow-lg transform transition-transform duration-500 ${state.isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 flex flex-col">
      <div class="p-6 border-b border-white/10 flex items-center justify-between">
        <button type="button" onclick="navigateTo(getPostLoginLandingViewForUser(state.currentUser))" class="flex items-center space-x-3 text-left">
          <div class="w-10 h-10 alb-mark rounded-xl flex items-center justify-center text-white font-bold">A</div>
          <span class="font-bold text-slate-800 dark:text-white">${t('adManager')}</span>
        </button>
        <button onclick="toggleMobileMenu()" class="md:hidden"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <nav class="flex-1 p-4 space-y-2 overflow-y-auto">
        ${showServicesHubLink ? `
          <!-- Back to Services Hub (Admin only) -->
          <button onclick="navigateTo('services-hub')" class="flex items-center space-x-3 w-full px-4 py-3 rounded-xl font-medium text-slate-600 dark:text-slate-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 mb-3 border-b border-slate-200 dark:border-slate-700 pb-3">
            <i data-lucide="grid-3x3" class="w-5 h-5"></i>
            <span>${state.language === 'ar' ? 'الخدمات' : 'Services Hub'}</span>
          </button>
        ` : ''}
        
        ${navItems.map(item => `
          <button onclick="navigateTo('${item.id}')" class="flex items-center space-x-3 w-full px-4 py-3 rounded-xl font-medium ${state.currentView === item.id ? 'alb-nav-active' : 'text-slate-600 dark:text-slate-400 hover:bg-white/20'}">
            <i data-lucide="${item.icon}" class="w-5 h-5"></i>
            <span>${t(item.label)}</span>
          </button>
        `).join('')}
      </nav>
      <div class="p-4 space-y-3 border-t border-white/10">
        <!-- Current User Profile -->
        <div class="flex items-center space-x-3 p-3 bg-white/30 dark:bg-slate-800/30 rounded-xl">
          <div class="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-md">
            ${state.currentUser?.name?.charAt(0) || 'U'}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm text-slate-800 dark:text-white truncate">${Security.escapeHtml(state.currentUser?.name || 'User')}</div>
            <div class="text-xs text-slate-500 truncate">${Security.escapeHtml(state.currentUser?.role || 'Employee')}</div>
          </div>
          <button onclick="editUser('${state.currentUser?.id}')" class="p-2 rounded-lg hover:bg-white/50 dark:hover:bg-slate-700/50 transition-colors" title="Edit Your Profile">
            <i data-lucide="settings" class="w-4 h-4 text-slate-600 dark:text-slate-400"></i>
          </button>
        </div>
        
        <div class="flex items-center justify-between bg-white/20 dark:bg-slate-800/20 rounded-xl p-2">
          <button onclick="toggleTheme()" class="flex-1 flex items-center justify-center space-x-2 py-2 rounded-lg text-xs font-bold hover:bg-white/20">
            <i data-lucide="${state.theme === 'dark' ? 'moon' : state.theme === 'light' ? 'sun' : 'monitor'}" class="w-4 h-4"></i>
            <span>${state.theme}</span>
          </button>
          <button onclick="toggleLanguage()" class="flex-1 flex items-center justify-center space-x-2 py-2 rounded-lg text-xs font-bold hover:bg-white/20">
            <i data-lucide="globe" class="w-4 h-4"></i>
            <span>${state.language.toUpperCase()}</span>
          </button>
        </div>
        <button onclick="handleLogout()" class="w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-xl font-medium text-rose-600 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100">
          <i data-lucide="log-out" class="w-5 h-5"></i>
          <span>${t('logout')}</span>
        </button>
      </div>
    </aside>
  `;
}

function renderView() {
  switch (state.currentView) {
    case 'services-hub': return renderServicesHub();
    case 'smart-systems': return renderSmartSystems();
    case 'service-placeholder': return renderServicePlaceholder();
    case 'wallet': return renderWalletView();
    case 'analytics': return renderAnalyticsView();
    case 'customers': return renderCustomersView();
    case 'receipts': return renderReceiptsView();
    case 'pages': return renderPagesView();
    case 'ads': return renderAdsView();
    case 'deliveries': return renderDeliveriesView();
    case 'reconciliation': return renderReconciliationView();
    case 'users': return renderUsersView();
    case 'audit': return renderAuditView();
    case 'settings': return renderSettingsView();
    case 'delivery-dashboard': return renderDeliveryDashboard();
    case 'no-access': return renderNoAccessView();
    default: return `<div class="text-center py-12"><h2 class="text-2xl font-bold mb-4">${t('welcome')}</h2><p class="text-slate-500">Select a view from the sidebar</p></div>`;
  }
}

function renderNoAccessView() {
  const isRTL = state.language === 'ar';
  return `
    <div class="min-h-[70vh] flex items-center justify-center">
      <div class="text-center max-w-md mx-auto p-8">
        <div class="w-24 h-24 rounded-full alb-gradient-brand flex items-center justify-center mx-auto mb-6 shadow-2xl">
          <i data-lucide="lock" class="w-12 h-12 text-white"></i>
        </div>
        <h1 class="text-3xl font-bold text-slate-800 dark:text-white mb-4">
          ${isRTL ? 'لا توجد صلاحية' : 'No Access Granted'}
        </h1>
        <p class="text-slate-600 dark:text-slate-400 mb-8">
          ${isRTL 
            ? 'لم يتم منحك أي صلاحية بعد. يرجى التواصل مع المدير لتفعيل حسابك.'
            : 'You have not been granted any permissions yet. Please contact your administrator to activate your account.'}
        </p>
        <button onclick="handleLogout()" class="btn-shine alb-btn-secondary text-white px-6 py-3 rounded-xl font-bold">
          <i data-lucide="log-out" class="w-5 h-5 inline mr-2"></i>
          ${t('logout')}
        </button>
      </div>
    </div>
  `;
}

// ==========================================
// SERVICES HUB - Multi-Service Home Page
// ==========================================

function renderServicesHub() {
  const userName = state.currentUser?.name || 'User';
  const isRTL = state.language === 'ar';
  const walletBalanceMinor = state.currentUser?.id ? WALLET.getBalanceMinor(state.currentUser.id, WALLET.currency) : 0;
  const walletBalanceLabel = walletFormatMinor(walletBalanceMinor, WALLET.currency);

  const hubServices = Object.values(SERVICES)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const serviceCards = hubServices.map(service => {
    if (!service || !service.id) return '';

    const serviceName = isRTL ? service.nameAr : service.name;
    const serviceDesc = isRTL ? service.descriptionAr : service.description;
    const access = checkServiceAccess(service.id);
    const disabled = !!service.comingSoon;

    return `
      <button
        type="button"
        onclick="handleServiceClick('${service.id}')"
        class="group relative glass-panel p-6 rounded-2xl ${isRTL ? 'text-right' : 'text-left'} transition-all duration-300 hover:scale-105 hover:shadow-xl ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"
        ${disabled ? 'disabled' : ''}
      >
        ${disabled ? `
          <div class="absolute top-3 right-3 px-3 py-1 rounded-full text-[10px] font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
            ${isRTL ? 'قريباً' : 'Coming Soon'}
          </div>
        ` : ''}

        ${access.reason === 'not_subscribed' && !disabled ? `
          <div class="absolute top-3 right-3">
            <i data-lucide="lock" class="w-4 h-4 text-amber-500"></i>
          </div>
        ` : ''}

        <div class="w-14 h-14 rounded-2xl bg-gradient-to-br ${service.color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg">
          <i data-lucide="${service.icon}" class="w-7 h-7 text-white"></i>
        </div>

        <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-1">${serviceName}</h3>
        <p class="text-sm text-slate-500 dark:text-slate-400">${serviceDesc}</p>

        ${service.hasChildren ? `
          <div class="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold">
            <i data-lucide="layers" class="w-3.5 h-3.5"></i>
            <span>${(service.children?.length || 0)} ${isRTL ? 'أنظمة' : 'systems'}</span>
          </div>
        ` : ''}
      </button>
    `;
  }).join('');
  
  return `
    <div class="max-w-6xl mx-auto">
      <!-- Header -->
      <div class="mb-8 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-full bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center text-white text-xl font-bold shadow-lg">
            ${userName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 class="text-2xl font-bold text-slate-800 dark:text-white">
              ${isRTL ? `مرحبا، ${userName}!` : `Welcome, ${userName}!`}
            </h1>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL ? 'اختر خدمة للبدء' : 'Choose a service to get started'}
            </p>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <button onclick="navigateTo('wallet')" class="px-4 py-3 glass-panel rounded-xl hover:scale-105 transition-transform flex items-center gap-2">
            <i data-lucide="wallet" class="w-5 h-5 text-indigo-600"></i>
            <span class="text-sm font-bold text-slate-700 dark:text-slate-200">${walletBalanceLabel}</span>
          </button>
          <button onclick="toggleTheme()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform">
            <i data-lucide="sun" class="w-5 h-5"></i>
          </button>
          <button onclick="toggleLanguage()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform text-sm font-bold">
            ${isRTL ? 'EN' : 'عربي'}
          </button>
          <button onclick="handleLogout()" class="p-3 glass-panel rounded-xl hover:scale-105 transition-transform text-rose-500">
            <i data-lucide="log-out" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
      
      <!-- Hero Banner (Optional) -->
      <div class="glass-panel p-8 rounded-3xl mb-8 alb-hero">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-2xl font-bold text-slate-800 dark:text-white mb-2 alb-gradient-text">
              ${isRTL ? 'فروع جديدة!' : 'New Services!'}
            </h2>
            <p class="text-slate-600 dark:text-slate-300">
              ${isRTL ? 'أهلاً بشركاء النجاح' : 'Welcome to our partner success platform'}
            </p>
          </div>
          <div class="hidden md:block">
            <i data-lucide="sparkles" class="w-16 h-16 text-indigo-400 opacity-50"></i>
          </div>
        </div>
      </div>
      
      <!-- Services Grid -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        ${serviceCards}
      </div>
    </div>
  `;
}

function renderSmartSystems() {
  const isRTL = state.language === 'ar';
  
  const children = Object.values(SMART_SYSTEMS_CHILDREN)
    .slice()
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999));

  const childCards = children.map(child => {
    const childName = isRTL ? child.nameAr : child.name;
    const childDesc = isRTL ? child.descriptionAr : child.description;
    const access = checkServiceAccess(child.id);
    const disabled = child.comingSoon;
    
    return `
      <button 
        type="button"
        onclick="handleSmartSystemClick('${child.id}')"
        class="group relative glass-panel p-8 rounded-2xl ${isRTL ? 'text-right' : 'text-left'} transition-all duration-300 hover:scale-105 hover:shadow-2xl ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"
        ${disabled ? 'disabled' : ''}
      >
        ${child.comingSoon ? `
          <div class="absolute top-4 right-4 px-3 py-1 rounded-full text-xs font-bold uppercase bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-lg">
            ${isRTL ? 'قريباً' : 'Coming Soon'}
          </div>
        ` : ''}
        
        ${access.reason === 'not_subscribed' && !disabled ? `
          <div class="absolute top-4 right-4">
            <i data-lucide="lock" class="w-5 h-5 text-amber-500"></i>
          </div>
        ` : ''}
        
        <div class="w-20 h-20 rounded-3xl bg-gradient-to-br ${child.color} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform shadow-2xl">
          <i data-lucide="${child.icon}" class="w-10 h-10 text-white"></i>
        </div>
        
        <h3 class="text-2xl font-bold text-slate-800 dark:text-white mb-2">${childName}</h3>
        <p class="text-slate-500 dark:text-slate-400">${childDesc}</p>
      </button>
    `;
  }).join('');
  
  return `
    <div class="max-w-6xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>
      
      <!-- Header -->
      <div class="mb-8">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-2xl">
            <i data-lucide="cpu" class="w-8 h-8 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">
              ${isRTL ? 'الأنظمة الذكية' : 'Smart Systems'}
            </h1>
            <p class="text-slate-500 dark:text-slate-400">
              ${isRTL ? 'أدوات الأعمال المتقدمة' : 'Advanced business tools'}
            </p>
          </div>
        </div>
      </div>
      
      <!-- Systems Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        ${childCards}
      </div>
    </div>
  `;
}

function renderServicePlaceholder() {
  const serviceId = state.viewData?.serviceId || state.modalData?.serviceId || '';
  const service = SERVICES[serviceId] || SMART_SYSTEMS_CHILDREN[serviceId];
  const isRTL = state.language === 'ar';
  
  if (!service) {
    return `<div class="text-center py-12"><p class="text-slate-500">Service not found</p></div>`;
  }
  
  const serviceName = isRTL ? service.nameAr : service.name;
  const serviceDesc = isRTL ? service.descriptionAr : service.description;
  
  return `
    <div class="max-w-4xl mx-auto">
      <!-- Back Button -->
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>
      
      <!-- Placeholder Content -->
      <div class="glass-panel p-12 rounded-3xl text-center">
        <div class="w-24 h-24 rounded-3xl bg-gradient-to-br ${service.color} flex items-center justify-center mx-auto mb-6 shadow-2xl">
          <i data-lucide="${service.icon}" class="w-12 h-12 text-white"></i>
        </div>
        
        <h1 class="text-3xl font-bold text-slate-800 dark:text-white mb-3">${serviceName}</h1>
        <p class="text-lg text-slate-500 dark:text-slate-400 mb-8">${serviceDesc}</p>
        
        ${service.comingSoon ? `
          <div class="inline-flex items-center space-x-3 px-6 py-3 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-white font-bold shadow-lg">
            <i data-lucide="clock" class="w-5 h-5"></i>
            <span>${isRTL ? 'قريباً' : 'Coming Soon'}</span>
          </div>
        ` : `
          <p class="text-slate-600 dark:text-slate-300">${isRTL ? 'هذه الخدمة قيد الإنشاء' : 'This service is under construction'}</p>
        `}
      </div>
    </div>
  `;
}

function findUserByEmailOrId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const users = Array.isArray(state.users) ? state.users : [];
  // Prefer exact id match first
  let u = users.find(x => x && !x._deleted && String(x.id || '') === raw);
  if (u) return u;
  // Then email match
  u = users.find(x => x && !x._deleted && String(x.email || '').toLowerCase() === lower);
  return u || null;
}

function walletTransferFromUi() {
  try {
    if (!state.currentUser?.id) return;
    const toValue = document.getElementById('wallet-transfer-to')?.value || '';
    const amountValue = document.getElementById('wallet-transfer-amount')?.value || '';
    const memoValue = document.getElementById('wallet-transfer-memo')?.value || '';
    const currency = walletNormalizeCurrency(document.getElementById('wallet-transfer-currency')?.value || WALLET.currency);

    const toUser = findUserByEmailOrId(toValue);
    if (!toUser?.id) {
      showNotification('Validation', state.language === 'ar' ? 'المستلم غير موجود' : 'Recipient not found', 'error');
      return;
    }

    const amt = Number(amountValue);
    const amountMinor = walletToMinor(amt, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const fingerprint = `${state.currentUser.id}|${toUser.id}|${currency}|${amountMinor}|${String(memoValue || '').trim()}`;
    if (WalletUiGuard.hit(fingerprint)) {
      showNotification('Please wait', state.language === 'ar' ? 'يرجى الانتظار... تم منع تكرار العملية' : 'Please wait... duplicate prevented', 'warning');
      return;
    }
    WALLET.transfer(state.currentUser.id, toUser.id, 0, { memo: memoValue, currency, amountMinor, idempotencyKey: `p2p:${Security.generateSecureId('idem')}` });

    const toEl = document.getElementById('wallet-transfer-to');
    const amtEl = document.getElementById('wallet-transfer-amount');
    const memoEl = document.getElementById('wallet-transfer-memo');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    if (memoEl) memoEl.value = '';

    showNotification('Success', state.language === 'ar' ? 'تم التحويل بنجاح' : 'Transfer completed', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Transfer failed', 'error');
  }
}

function walletTopUpFromUi() {
  try {
    if (!state.currentUser?.id) return;
    if (!isAdminRole(state.currentUser.role)) {
      showNotification('Not Allowed', state.language === 'ar' ? 'للأدمن فقط' : 'Admin only', 'error');
      return;
    }
    const toValue = document.getElementById('wallet-topup-to')?.value || '';
    const amountValue = document.getElementById('wallet-topup-amount')?.value || '';
    const memoValue = document.getElementById('wallet-topup-memo')?.value || '';
    const currency = walletNormalizeCurrency(document.getElementById('wallet-topup-currency')?.value || WALLET.currency);

    const toUser = findUserByEmailOrId(toValue);
    if (!toUser?.id) {
      showNotification('Validation', state.language === 'ar' ? 'المستلم غير موجود' : 'Recipient not found', 'error');
      return;
    }

    const amt = Number(amountValue);
    const amountMinor = walletToMinor(amt, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Invalid amount');
    const fingerprint = `${toUser.id}|${currency}|${amountMinor}|${String(memoValue || '').trim()}`;
    if (WalletUiGuard.hit(fingerprint)) {
      showNotification('Please wait', state.language === 'ar' ? 'يرجى الانتظار... تم منع تكرار العملية' : 'Please wait... duplicate prevented', 'warning');
      return;
    }
    WALLET.credit(toUser.id, 0, { memo: memoValue || 'Top-up', currency, amountMinor, idempotencyKey: `topup:${Security.generateSecureId('idem')}` });

    const toEl = document.getElementById('wallet-topup-to');
    const amtEl = document.getElementById('wallet-topup-amount');
    const memoEl = document.getElementById('wallet-topup-memo');
    if (toEl) toEl.value = '';
    if (amtEl) amtEl.value = '';
    if (memoEl) memoEl.value = '';

    showNotification('Success', state.language === 'ar' ? 'تم الشحن' : 'Top-up completed', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Top-up failed', 'error');
  }
}

function cancelSubscriptionFromUi(serviceId) {
  try {
    if (!state.currentUser?.id) return;
    const sid = String(serviceId || '').trim();
    if (!sid) return;
    const isRTL = state.language === 'ar';
    const ok = confirm(isRTL ? 'هل تريد إلغاء الاشتراك؟' : 'Cancel this subscription?');
    if (!ok) return;
    SUBSCRIPTIONS.cancel(state.currentUser.id, sid);
    showNotification('Success', isRTL ? 'تم إلغاء الاشتراك' : 'Subscription canceled', 'success');
    render();
  } catch (e) {
    showNotification(state.language === 'ar' ? 'خطأ' : 'Error', e?.message || 'Failed to cancel subscription', 'error');
  }
}

function renderWalletView() {
  const isRTL = state.language === 'ar';
  const uid = String(state.currentUser?.id || '');
  const isAdmin = isAdminRole(state.currentUser?.role);

  const balances = [];
  if (uid) {
    for (const c of WALLET_SUPPORTED_CURRENCIES) {
      const m = WALLET.getBalanceMinor(uid, c);
      if (m !== 0 || c === WALLET.currency) balances.push({ c, m });
    }
  }
  const balancesHtml = balances.length
    ? balances.map(({ c, m }) => `<div class="text-sm font-black text-slate-800 dark:text-white">${walletFormatMinor(m, c)}</div>`).join('')
    : `<div class="text-sm font-black text-slate-800 dark:text-white">${walletFormatMinor(0, WALLET.currency)}</div>`;
  const currencyOptions = WALLET_SUPPORTED_CURRENCIES
    .map(c => `<option value="${c}" ${c === WALLET.currency ? 'selected' : ''}>${c}</option>`)
    .join('');
  const users = Array.isArray(state.users) ? state.users : [];
  const userById = new Map();
  for (const u of users) {
    if (!u || u._deleted || !u.id) continue;
    userById.set(String(u.id), u);
  }

  const allTx = Array.isArray(state.walletTransactions) ? state.walletTransactions : [];
  const visibleTx = getVisibleRecords(allTx);
  const txs = (isAdmin ? visibleTx : visibleTx.filter(t => t && (t.fromUserId === uid || t.toUserId === uid))).slice(0, 50);

  const allSubs = Array.isArray(state.serviceSubscriptions) ? state.serviceSubscriptions : [];
  const now = Date.now();
  const activeSubs = getVisibleRecords(allSubs)
    .filter(s => s && s.userId === uid && s.status === 'active' && (!s.expiresAt || new Date(s.expiresAt).getTime() > now))
    .slice(0, 50);

  const txRows = txs.map(tx => {
    const isIn = tx.toUserId === uid;
    const otherId = isIn ? tx.fromUserId : tx.toUserId;
    const other =
      !otherId || otherId === 'system'
        ? (isRTL ? 'النظام' : 'System')
        : (userById.get(String(otherId))?.name || userById.get(String(otherId))?.email || String(otherId || ''));

    const amountStr = walletFormatMinor(walletTxAmountMinor(tx), walletTxCurrency(tx));
    const when = tx.createdAt ? new Date(tx.createdAt).toLocaleString() : '';
    const memo = Security.escapeHtml(String(tx.memo || ''));

    return `
      <div class="flex items-start justify-between gap-4 py-3 border-b border-slate-200/60 dark:border-slate-700/60">
        <div class="min-w-0">
          <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(tx.type || 'tx')}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${Security.escapeHtml(other)} ${when ? `• ${Security.escapeHtml(when)}` : ''}</div>
          ${memo ? `<div class="text-[11px] text-slate-400 mt-1 break-words">${memo}</div>` : ''}
        </div>
        <div class="text-right font-black ${isIn ? 'text-emerald-600' : 'text-rose-600'}">
          ${isIn ? '+' : '-'}${Security.escapeHtml(amountStr)}
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">${isRTL ? 'لا توجد معاملات بعد' : 'No transactions yet'}</div>`;

  const subsRows = activeSubs.map(s => {
    const svc = SERVICES[s.serviceId];
    const name = svc ? (isRTL ? svc.nameAr : svc.name) : s.serviceId;
    const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '';
    return `
      <div class="flex items-center justify-between gap-4 py-2 border-b border-slate-200/60 dark:border-slate-700/60">
        <div class="font-bold text-slate-800 dark:text-white min-w-0 truncate">${Security.escapeHtml(name)}</div>
        <div class="flex items-center gap-3 shrink-0">
          <div class="text-xs text-slate-500 dark:text-slate-400">
            ${exp ? (isRTL ? `ينتهي: ${Security.escapeHtml(exp)}` : `Expires: ${Security.escapeHtml(exp)}`) : ''}
          </div>
          <button onclick="cancelSubscriptionFromUi('${s.serviceId}')" class="text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50 dark:bg-rose-900/20 px-3 py-1.5 rounded-lg">
            ${isRTL ? 'إلغاء' : 'Cancel'}
          </button>
        </div>
      </div>
    `;
  }).join('') || `<div class="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">${isRTL ? 'لا توجد اشتراكات نشطة' : 'No active subscriptions'}</div>`;

  return `
    <div class="max-w-6xl mx-auto">
      <button onclick="navigateTo('services-hub')" class="mb-6 flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-medium">
        <i data-lucide="${isRTL ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
        <span>${isRTL ? 'العودة للخدمات' : 'Back to Services'}</span>
      </button>

      <div class="mb-8 flex items-center justify-between gap-4 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-xl">
            <i data-lucide="wallet" class="w-7 h-7 text-white"></i>
          </div>
          <div>
            <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('wallet')}</h1>
            <p class="text-slate-500 dark:text-slate-400">${isRTL ? 'محفظتك واشتراكاتك' : 'Your balance and subscriptions'}</p>
          </div>
        </div>
        <div class="glass-panel px-5 py-3 rounded-2xl">
          <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">${t('balance')}</div>
          <div class="space-y-1 mt-1">${balancesHtml}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div class="glass-panel p-6 rounded-2xl">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${t('transfer')}</h3>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-2">${t('recipient')}</label>
              <input id="wallet-transfer-to" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'بريد المستلم أو المعرّف' : 'Recipient email or ID'}" maxlength="140" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('amount')}</label>
                <input id="wallet-transfer-amount" type="text" inputmode="decimal" min="0" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="0" oninput="sanitizeMoneyInput(this)" />
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${isRTL ? 'العملة' : 'Currency'}</label>
                <select id="wallet-transfer-currency" class="w-full px-4 py-3 glass-input rounded-xl">
                  ${currencyOptions}
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-2">${t('note')}</label>
                <input id="wallet-transfer-memo" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'اختياري' : 'Optional'}" maxlength="180" />
              </div>
            </div>
            <button onclick="walletTransferFromUi()" class="w-full btn-shine bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700">
              <i data-lucide="send" class="w-4 h-4 inline mr-2"></i>${t('send')}
            </button>
            <div class="text-[11px] text-slate-400">
              ${isRTL ? 'ملاحظة: في الوضع المحلي، هذا للعرض والتجربة فقط.' : 'Note: In local mode this is for testing/demo only.'}
            </div>
          </div>
        </div>

        ${isAdmin ? (isServerModeEnabled() ? `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-2">${t('topUp')}</h3>
            <p class="text-sm text-slate-500 dark:text-slate-400">
              ${isRTL
                ? 'في وضع السيرفر: شحن الرصيد يتم فقط عبر قنوات التمويل الخارجية (البنك/المعالج) وليس يدوياً.'
                : 'In server mode: top-ups must come from external funding rails (bank/processor), not manual admin credits.'}
            </p>
          </div>
        ` : `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${t('topUp')} (Admin)</h3>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-2">${t('recipient')}</label>
                <input id="wallet-topup-to" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'بريد المستخدم أو المعرّف' : 'User email or ID'}" maxlength="140" />
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label class="block text-sm font-medium mb-2">${t('amount')}</label>
                  <input id="wallet-topup-amount" type="text" inputmode="decimal" min="0" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="0" oninput="sanitizeMoneyInput(this)" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-2">${isRTL ? 'العملة' : 'Currency'}</label>
                  <select id="wallet-topup-currency" class="w-full px-4 py-3 glass-input rounded-xl">
                    ${currencyOptions}
                  </select>
                </div>
                <div>
                  <label class="block text-sm font-medium mb-2">${t('note')}</label>
                  <input id="wallet-topup-memo" class="w-full px-4 py-3 glass-input rounded-xl" placeholder="${isRTL ? 'اختياري' : 'Optional'}" maxlength="180" />
                </div>
              </div>
              <button onclick="walletTopUpFromUi()" class="w-full btn-shine bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700">
                <i data-lucide="plus" class="w-4 h-4 inline mr-2"></i>${t('topUp')}
              </button>
            </div>
          </div>
        `) : `
          <div class="glass-panel p-6 rounded-2xl">
            <h3 class="text-lg font-bold text-slate-800 dark:text-white mb-4">${isRTL ? 'الاشتراكات' : 'Subscriptions'}</h3>
            ${subsRows}
            <button onclick="navigateTo('services-hub')" class="mt-4 w-full bg-slate-200 dark:bg-slate-700 px-6 py-3 rounded-xl font-bold hover:bg-slate-300">
              ${isRTL ? 'إدارة الخدمات' : 'Manage services'}
            </button>
          </div>
        `}
      </div>

      <div class="glass-panel p-6 rounded-2xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-slate-800 dark:text-white">${t('transactions')}</h3>
          <div class="text-xs text-slate-500 dark:text-slate-400">${isAdmin ? (isRTL ? 'آخر 50 (الكل)' : 'Latest 50 (all)') : (isRTL ? 'آخر 50 (لك فقط)' : 'Latest 50 (yours)')}</div>
        </div>
        ${txRows}
      </div>
    </div>
  `;
}

function handleServiceClick(serviceId) {
  const service = SERVICES[serviceId];
  if (!service) return;
  
  if (service.comingSoon) {
    showNotification(
      state.language === 'ar' ? 'قريباً' : 'Coming Soon',
      state.language === 'ar' ? 'هذه الخدمة ستكون متاحة قريباً' : 'This service will be available soon',
      'info'
    );
    return;
  }
  
  const access = checkServiceAccess(serviceId);
  if (!access.allowed) {
    if (access.reason === 'not_subscribed') {
      showSubscriptionModal(serviceId, access.subscribeToId || serviceId);
      return;
    }
  }
  
  // Navigate to service
  const targetView = service.openView || (serviceId === 'smart_systems' ? 'smart-systems' : 'service-placeholder');
  state.currentView = targetView;
  state.viewData = targetView === 'service-placeholder' ? { serviceId } : null;
  
  saveState();
  render();
}

function handleSmartSystemClick(systemId) {
  const system = SMART_SYSTEMS_CHILDREN[systemId];
  if (!system) return;
  
  if (system.comingSoon) {
    showNotification(
      state.language === 'ar' ? 'قريباً' : 'Coming Soon',
      state.language === 'ar' ? 'هذا النظام سيكون متاحاً قريباً' : 'This system will be available soon',
      'info'
    );
    return;
  }
  
  const access = checkServiceAccess(systemId);
  if (!access.allowed) {
    if (access.reason === 'not_subscribed') {
      showSubscriptionModal(systemId, access.subscribeToId || systemId);
      return;
    }
  }
  
  // Navigate to system
  const targetView = system.openView || (systemId === 'albayan_manager' ? 'analytics' : 'service-placeholder');
  state.currentView = targetView;
  state.viewData = targetView === 'service-placeholder' ? { serviceId: systemId } : null;
  saveState();
  render();
}

function renderAnalyticsView() {
  const ads = getVisibleRecords(state.ads).filter(ad => ad.recordType !== 'receipt');
  const receipts = getVisibleRecords(state.receipts);
  const users = getVisibleRecords(state.users);
  const now = Date.now();
  const last7 = now - 7 * 24 * 60 * 60 * 1000;

  // Calculate ad revenue - separate paid vs pending/unpaid for clarity
  const paidAds = ads.filter(ad => ad.isPaid === true || ad.paymentStatus === 'paid');
  const unpaidAds = ads.filter(ad => ad.isPaid !== true && ad.paymentStatus !== 'paid');
  const paidAdRevenue = paidAds.reduce((sum, ad) => sum + (ad.amountUSD || 0), 0);
  const unpaidAdRevenue = unpaidAds.reduce((sum, ad) => sum + (ad.amountUSD || 0), 0);
  const totalAdRevenue = paidAdRevenue + unpaidAdRevenue;  // Keep for backwards compatibility

  const totalReceiptsUSD = receipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const paidReceipts = receipts.filter(r => (r.status || '').toLowerCase() === 'paid');
  const pendingReceipts = receipts.filter(r => {
    const s = (r.status || '').toLowerCase();
    return s === 'pending' || s === 'not paid';
  });
  const paidUSD = paidReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const pendingUSD = pendingReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);

  // Calculate actual balance: paid receipts - used funds - transferred funds.
  // MONEY-MATH: transfers consume a receipt exactly like usage does (the
  // per-receipt cards already subtract them), so the dashboard must subtract
  // them too or every transferred dollar shows as still "available".
  const totalUsedFromReceipts = paidReceipts.reduce((sum, r) => {
    const stats = getReceiptUsageStats(r);
    return sum + (stats.usedUSD || 0) + (stats.transferredUSD || 0);
  }, 0);
  const availableReceiptBalance = Math.max(paidUSD - totalUsedFromReceipts, 0);
  
  // Collection status (admin collected vs not collected)
  const collectedReceipts = receipts.filter(r => r.collected);
  const notCollectedReceipts = receipts.filter(r => !r.collected);
  const collectedUSD = collectedReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const notCollectedUSD = notCollectedReceipts.reduce((sum, r) => sum + (r.amountUSD || 0), 0);
  const collectionRate = receipts.length > 0 ? ((collectedReceipts.length / receipts.length) * 100).toFixed(1) : 0;

  const deliveryAds = ads.filter(a => a.deliveryStatus && a.deliveryStatus !== 'Office');
  const activeDeliveries = deliveryAds.filter(a => (a.deliveryStatus || '').toLowerCase() !== 'completed').length;
  const completedDeliveries = deliveryAds.filter(a => (a.deliveryStatus || '').toLowerCase() === 'completed').length;

  const adsLast7 = ads.filter(a => new Date(a.createdAt || 0).getTime() >= last7).length;
  const receiptsLast7 = receipts.filter(r => new Date(r.createdAt || 0).getTime() >= last7).length;

  // Top customers by spend
  const spendByCustomer = {};
  ads.forEach(ad => {
    if (!ad.customerId) return;
    spendByCustomer[ad.customerId] = (spendByCustomer[ad.customerId] || 0) + (ad.amountUSD || 0);
  });
  const topCustomers = Object.entries(spendByCustomer)
    .map(([customerId, spend]) => ({
      customerId,
      name: state.customers.find(c => c.id === customerId)?.name || 'Unknown',
      spend
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5);

  // Top pages by ad count
  const adsByPage = {};
  ads.forEach(ad => {
    if (!ad.pageId) return;
    adsByPage[ad.pageId] = (adsByPage[ad.pageId] || 0) + 1;
  });
  const topPages = Object.entries(adsByPage)
    .map(([pageId, count]) => ({
      pageId,
      name: state.pages.find(p => p.id === pageId)?.name || 'Unknown',
      count
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Recent activity (ads + receipts)
  const recentItems = [
    ...ads.map(ad => ({ type: 'Ad', name: state.customers.find(c => c.id === ad.customerId)?.name || 'Unknown', value: ad.amountUSD || 0, status: ad.status || 'Pending', at: ad.createdAt })),
    ...receipts.map(r => ({ type: 'Receipt', name: state.customers.find(c => c.id === r.customerId)?.name || 'Unknown', value: r.amountUSD || 0, status: r.status || 'Paid', at: r.createdAt }))
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 6);

  const renderProgress = (label, value, target, color) => {
    const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
    return `
      <div class="flex items-center justify-between text-xs font-medium mb-1">
        <span class="text-slate-500">${label}</span>
        <span class="text-slate-700 dark:text-slate-200">${value.toLocaleString()} / ${target.toLocaleString()}</span>
      </div>
      <div class="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div class="h-2 ${color} rounded-full" style="width:${pct}%"></div>
      </div>
    `;
  };

  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 class="text-3xl font-bold text-slate-900 dark:text-white">${t('analytics')}</h1>
          <p class="text-sm text-slate-500">Advanced tracking across revenue, receipts, delivery, and activity</p>
        </div>
        <div class="flex items-center gap-3">
          <div class="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-200">Last 7 days: ${adsLast7} ads • ${receiptsLast7} receipts</div>
          <div class="px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-xs font-semibold text-emerald-700 dark:text-emerald-300">Users: ${users.length}</div>
        </div>
      </div>

      <!-- KPI Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <!-- Show paid ad revenue separately for clarity -->
        <div class="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:scale-[1.02] transition-transform">
          <div class="absolute inset-0 bg-gradient-to-br from-emerald-500 to-teal-600 opacity-10 group-hover:opacity-20 transition-opacity"></div>
          <div class="flex items-start justify-between relative">
            <div>
              <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Ad Revenue (Paid)</p>
              <p class="text-2xl font-bold text-slate-800 dark:text-white">$${paidAdRevenue.toFixed(2)}</p>
              <p class="text-xs text-slate-500 mt-1">Pending: $${unpaidAdRevenue.toFixed(2)}</p>
            </div>
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg">
              <i data-lucide="dollar-sign" class="w-6 h-6 text-white"></i>
            </div>
          </div>
        </div>
        ${renderStatCard('Receipts Volume', '$' + totalReceiptsUSD.toFixed(2), 'file-text', 'from-indigo-500 to-purple-600')}
        <!-- Show available balance (paid receipts - used) -->
        <div class="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:scale-[1.02] transition-transform">
          <div class="absolute inset-0 bg-gradient-to-br from-blue-500 to-cyan-600 opacity-10 group-hover:opacity-20 transition-opacity"></div>
          <div class="flex items-start justify-between relative">
            <div>
              <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Available Balance</p>
              <p class="text-2xl font-bold text-slate-800 dark:text-white">$${availableReceiptBalance.toFixed(2)}</p>
              <p class="text-xs text-slate-500 mt-1">Used: $${totalUsedFromReceipts.toFixed(2)} / Paid: $${paidUSD.toFixed(2)}</p>
            </div>
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center shadow-lg">
              <i data-lucide="piggy-bank" class="w-6 h-6 text-white"></i>
            </div>
          </div>
        </div>
        
        <!-- Collection Status Card -->
        <div class="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:scale-[1.02] transition-transform cursor-pointer" onclick="state.receiptCollectedFilter='not-collected';navigateTo('receipts');">
          <div class="absolute inset-0 bg-gradient-to-br from-amber-500 to-orange-600 opacity-10 group-hover:opacity-20 transition-opacity"></div>
          <div class="flex items-start justify-between relative">
            <div>
              <p class="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Collection Status</p>
              <div class="flex items-baseline space-x-2">
                <p class="text-2xl font-bold text-slate-800 dark:text-white">${collectedReceipts.length}/${receipts.length}</p>
                <span class="text-sm font-medium ${collectionRate >= 80 ? 'text-emerald-600' : collectionRate >= 50 ? 'text-amber-600' : 'text-rose-600'}">${collectionRate}%</span>
              </div>
              <div class="flex items-center space-x-3 mt-2 text-xs">
                <span class="text-emerald-600 font-medium">✓ $${collectedUSD.toFixed(0)}</span>
                <span class="text-amber-600 font-medium">○ $${notCollectedUSD.toFixed(0)}</span>
              </div>
            </div>
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg">
              <i data-lucide="wallet" class="w-6 h-6 text-white"></i>
            </div>
          </div>
          <!-- Progress bar -->
          <div class="mt-3 w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all duration-500" style="width: ${collectionRate}%"></div>
          </div>
        </div>
      </div>

      <!-- Tracking Panels -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="glass-panel rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100">Revenue & Collections</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40">Cashflow</span>
          </div>
          ${renderProgress('Collected (Receipts)', paidUSD, Math.max(paidUSD + pendingUSD, 1), 'bg-emerald-500')}
          ${renderProgress('Pending (Receipts)', pendingUSD, Math.max(paidUSD + pendingUSD, 1), 'bg-amber-500')}
          ${renderProgress('Ad Revenue (all time)', totalAdRevenue, Math.max(totalAdRevenue, 1), 'bg-indigo-500')}
        </div>

        <div class="glass-panel rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100">Receipts & Transfers</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40">Usage</span>
          </div>
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
              <p class="text-slate-500 text-xs">Receipts</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${receipts.length}</p>
              <p class="text-[11px] text-slate-500">${receiptsLast7} created in last 7 days</p>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
              <p class="text-slate-500 text-xs">Transfers</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${receipts.filter(r => r.transfers?.length).length}</p>
              <p class="text-[11px] text-slate-500">With balance moves</p>
            </div>
          </div>
          ${renderProgress('Remaining (vs receipts)', Math.max(totalReceiptsUSD - paidUSD, 0), Math.max(totalReceiptsUSD, 1), 'bg-sky-500')}
        </div>

        <div class="glass-panel rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-bold text-slate-800 dark:text-slate-100">Delivery Tracking</h2>
            <span class="text-xs px-3 py-1 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/40">Drivers</span>
          </div>
          <div class="grid grid-cols-3 gap-3 text-sm">
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg text-center">
              <p class="text-slate-500 text-xs">Active</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${activeDeliveries}</p>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg text-center">
              <p class="text-slate-500 text-xs">Completed</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${completedDeliveries}</p>
            </div>
            <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg text-center">
              <p class="text-slate-500 text-xs">Total</p>
              <p class="text-xl font-bold text-slate-800 dark:text-white">${deliveryAds.length}</p>
            </div>
          </div>
          ${renderProgress('Delivery completion', completedDeliveries, Math.max(deliveryAds.length, 1), 'bg-emerald-500')}
        </div>
      </div>

      <!-- Lists -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-slate-800 dark:text-white">Top Customers (Spend)</h3>
            <i data-lucide="users" class="w-4 h-4 text-slate-400"></i>
          </div>
          ${topCustomers.length === 0 ? '<p class="text-sm text-slate-500">No data</p>' : `
            <div class="space-y-2">
              ${topCustomers.map(c => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div>
                    <p class="font-medium">${Security.escapeHtml(c.name || '')}</p>
                    <p class="text-[11px] text-slate-500">${c.spend.toFixed(2)} USD</p>
                  </div>
                  <span class="text-xs px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40">Top</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-slate-800 dark:text-white">Top Pages (Ads)</h3>
            <i data-lucide="layout-dashboard" class="w-4 h-4 text-slate-400"></i>
          </div>
          ${topPages.length === 0 ? '<p class="text-sm text-slate-500">No data</p>' : `
            <div class="space-y-2">
              ${topPages.map(p => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div>
                    <p class="font-medium">${Security.escapeHtml(p.name || '')}</p>
                    <p class="text-[11px] text-slate-500">${p.count} ads</p>
                  </div>
                  <span class="text-xs px-2 py-1 rounded-full bg-sky-50 text-sky-700 dark:bg-sky-900/40">Active</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-slate-800 dark:text-white">Recent Activity</h3>
            <i data-lucide="activity" class="w-4 h-4 text-slate-400"></i>
          </div>
          ${recentItems.length === 0 ? '<p class="text-sm text-slate-500">No activity yet</p>' : `
            <div class="space-y-2">
              ${recentItems.map(item => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <div>
                    <p class="font-medium">${Security.escapeHtml(item.type || '')}: ${Security.escapeHtml(item.name || '')}</p>
                    <p class="text-[11px] text-slate-500">$${item.value.toFixed(2)} • ${Security.escapeHtml(item.status || '')}</p>
                  </div>
                  <span class="text-[10px] text-slate-400">${item.at ? new Date(item.at).toLocaleDateString() : ''}</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

function renderStatCard(title, value, icon, gradient, onClick = '', isActive = false) {
  const clickable = !!onClick;
  const activeClass = isActive ? ' ring-2 ring-indigo-400/70' : '';
  const clickClass = clickable ? ' cursor-pointer' : '';
  const clickAttr = clickable ? ` onclick="${onClick}"` : '';
  return `
    <div class="glass-panel rounded-xl md:rounded-2xl p-3 md:p-6 hover:scale-105 transition-transform${clickClass}${activeClass}"${clickAttr}>
      <div class="flex items-start justify-between">
        <div class="min-w-0 flex-1">
          <p class="text-[10px] md:text-sm text-slate-500 font-medium uppercase truncate">${title}</p>
          <p class="text-lg md:text-3xl font-bold mt-1 md:mt-2 truncate">${value}</p>
        </div>
        <div class="w-8 h-8 md:w-12 md:h-12 bg-gradient-to-br ${gradient} rounded-lg md:rounded-xl flex items-center justify-center text-white shadow-lg flex-shrink-0 ml-2">
          <i data-lucide="${icon}" class="w-4 h-4 md:w-6 md:h-6"></i>
        </div>
      </div>
    </div>
  `;
}

function renderProgress(label, value, max, colorClass) {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const displayValue = typeof value === 'number' ? (value >= 1000 ? '$' + value.toFixed(0) : '$' + value.toFixed(2)) : value;
  return `
    <div class="mt-3">
      <div class="flex justify-between text-xs mb-1">
        <span class="text-slate-600 dark:text-slate-400">${label}</span>
        <span class="font-medium text-slate-800 dark:text-white">${displayValue}</span>
      </div>
      <div class="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div class="${colorClass} h-full rounded-full transition-all duration-500" style="width: ${percentage}%"></div>
      </div>
    </div>
  `;
}

let _customerSearchTimer = null;
function onCustomerSearchInput(value) {
  const v = String(value || '');
  const clean = Security.sanitizeInput(v, { maxLength: 200 });
  // #region agent log
  // Hypothesis H2: Search strings can contain quotes; combined with innerHTML templates this can break rendering.
  if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
  try {
    const dbg = (window.__albayanDebugAudit = window.__albayanDebugAudit || {});
    const hasQuote = v.includes('"');
    const hasApos = v.includes("'");
    const hasAngle = v.includes('<') || v.includes('>');
    if (!dbg.customerSearchLogged && (hasQuote || hasApos || hasAngle)) {
      dbg.customerSearchLogged = true;
        window.__albayanDebugEmit('H2', 'script.js:onCustomerSearchInput', 'customerSearch contains special chars', {len:v.length,hasQuote,hasApos,hasAngle});
    }
  } catch (_) {}
  }
  // #endregion
  state.customerSearch = clean;
  if (_customerSearchTimer) clearTimeout(_customerSearchTimer);
  // Small debounce to keep typing smooth (customer cards can be heavy to compute).
  _customerSearchTimer = setTimeout(() => {
    _customerSearchTimer = null;
    updateCustomersViewFiltered();
  }, 60);
}

function updateCustomersViewFiltered() {
  if (state.currentView !== 'customers') return;
  const grid = document.getElementById('customers-grid');
  const countEl = document.getElementById('customers-count');
  if (!grid || !countEl) {
    // View structure not on screen (e.g. mid-navigation): fall back to a full render.
    render();
    if (window.lucide) lucide.createIcons();
    return;
  }
  // Build the fresh view HTML off-screen, then swap in only the grid + count so
  // the search input keeps its caret (same approach as updateReceiptsViewFiltered).
  // renderCustomersView owns the pagination fingerprint/slice + Load-more button.
  const tpl = document.createElement('template');
  tpl.innerHTML = renderCustomersView();
  const src = tpl.content;
  const newGrid = src.querySelector('#customers-grid');
  const newCount = src.querySelector('#customers-count');
  if (newGrid) grid.innerHTML = newGrid.innerHTML;
  if (newCount) countEl.textContent = newCount.textContent;
  if (window.lucide) lucide.createIcons();
}

function renderCustomersGrid(customers) {
  if (!Array.isArray(customers) || customers.length === 0) {
    return '<div class="col-span-full glass-panel rounded-2xl p-12 text-center"><i data-lucide="users" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">No customers found</p></div>';
  }

  const totalCustomers = customers.length;
  const statsIndex = buildCustomerStatsIndex();
  return customers.map((c, idx) => {
          const stats = getCustomerStats(c.id, statsIndex);
          const lastAdText = stats.lastAdDate 
            ? new Date(stats.lastAdDate).toLocaleDateString()
            : 'Never';
          
    const phones = Array.isArray(c.phones) ? c.phones : [];
    const profileLinks = Array.isArray(c.profileLinks) ? c.profileLinks : [];
          // Display number: total - index (so first item = highest number, matching newest-first sort)
          const displayNum = totalCustomers - idx;
          
          return `
            <div class="glass-panel rounded-xl p-5 hover:scale-[1.02] transition-transform" data-customer-id="${c.id}">
              <div class="flex justify-between items-start mb-4">
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded-md bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400 text-xs font-bold">#${displayNum}</span>
                  <h3 class="font-bold text-lg text-slate-800 dark:text-white">${Security.escapeHtml(c.name || '')}</h3>
                  </div>
                  <div class="flex items-center space-x-2 mt-1">
                    <span class="text-xs px-2 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full">${Security.escapeHtml(c.platform || '')}</span>
                    ${stats.linkedPagesCount > 0 ? `<span class="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full">${stats.linkedPagesCount} pages</span>` : ''}
                  </div>
                </div>
                <div class="flex space-x-1">
                  <button onclick="editCustomer('${c.id}')" class="text-blue-600 hover:text-blue-700 p-1" title="Edit">
                    <i data-lucide="edit" class="w-4 h-4"></i>
                  </button>
                  <button onclick="deleteCustomer('${c.id}')" class="text-rose-600 hover:text-rose-700 p-1" title="Delete">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              </div>

              <div class="space-y-2 text-sm border-t border-slate-200 dark:border-slate-700 pt-3">
                <div class="flex items-start space-x-2">
                  <i data-lucide="phone" class="w-4 h-4 text-slate-400 mt-0.5"></i>
                  <div class="flex-1">
              ${phones.length > 0 ? phones.map(phone => `<div class="text-slate-700 dark:text-slate-300">${Security.escapeHtml(phone || '')}</div>`).join('') : '<span class="text-slate-400">No phone</span>'}
                  </div>
                </div>

          ${profileLinks.length > 0 ? `
                  <div class="flex items-start space-x-2">
                    <i data-lucide="link" class="w-4 h-4 text-slate-400 mt-0.5"></i>
                    <div class="flex-1">
                ${profileLinks.map(link => `<a href="${Security.escapeHtml(link || '')}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-700 text-xs block truncate">${Security.escapeHtml(link || '')}</a>`).join('')}
                    </div>
                  </div>
                ` : ''}

                <!-- Last Ad -->
                <div class="flex items-center space-x-2 text-xs">
                  <i data-lucide="clock" class="w-3 h-3 text-slate-400"></i>
                  <span class="text-slate-600 dark:text-slate-400">Last ad: ${lastAdText}</span>
                </div>

                <!-- Financial Summary -->
                <div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                  <!-- LYD Section - TOTAL PAID -->
                  <div class="mb-2">
                    <div class="text-[10px] font-bold text-slate-500 uppercase mb-1">Total Paid (LYD)</div>
                    <div class="grid grid-cols-3 gap-1 text-xs">
                      <div class="text-center p-1.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                        <div class="text-[10px] text-slate-400">Spent</div>
                        <div class="font-bold text-slate-700 dark:text-slate-300">${stats.totalSpentLYD.toFixed(0)}</div>
                      </div>
                      <div class="text-center p-1.5 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                        <div class="text-[10px] text-emerald-600">Paid</div>
                        <div class="font-bold text-emerald-600">${stats.totalPaidLYD.toFixed(0)}</div>
                      </div>
                      <div class="text-center p-1.5 ${stats.balanceLYD >= 0 ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-rose-50 dark:bg-rose-900/20'} rounded-lg">
                        <div class="text-[10px] ${stats.balanceLYD >= 0 ? 'text-blue-600' : 'text-rose-600'}">Balance</div>
                        <div class="font-bold ${stats.balanceLYD >= 0 ? 'text-blue-600' : 'text-rose-600'}">${stats.balanceLYD >= 0 ? '+' : ''}${stats.balanceLYD.toFixed(0)}</div>
                      </div>
                    </div>
                  </div>
                  <!-- USD Section - TOTAL ADS CREDIT -->
                  <div>
                    <div class="text-[10px] font-bold text-slate-500 uppercase mb-1">Ads Credit (USD)</div>
                    <div class="grid grid-cols-3 gap-1 text-xs">
                      <div class="text-center p-1.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                        <div class="text-[10px] text-slate-400">Spent</div>
                        <div class="font-bold text-slate-700 dark:text-slate-300">$${stats.totalSpentUSD.toFixed(2)}</div>
                      </div>
                      <div class="text-center p-1.5 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                        <div class="text-[10px] text-emerald-600">Paid</div>
                        <div class="font-bold text-emerald-600">$${stats.totalPaidUSD.toFixed(2)}</div>
                      </div>
                      <div class="text-center p-1.5 ${stats.balanceUSD >= 0 ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-rose-50 dark:bg-rose-900/20'} rounded-lg">
                        <div class="text-[10px] ${stats.balanceUSD >= 0 ? 'text-blue-600' : 'text-rose-600'}">Balance</div>
                        <div class="font-bold ${stats.balanceUSD >= 0 ? 'text-blue-600' : 'text-rose-600'}">${stats.balanceUSD >= 0 ? '+' : ''}$${stats.balanceUSD.toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `;
  }).join('');
}

// PAGINATION ("Load more") for the customers grid — mirrors the receipts grid.
// Rendering every customer card at once (each card has two financial grids and
// several icons) freezes the view past a few hundred customers; render the first
// CUSTOMERS_PAGE_SIZE and reveal more on demand. The limit resets automatically
// whenever the search/sort/financial-filter changes (fingerprint check below).
const CUSTOMERS_PAGE_SIZE = 50;
let _customersShowLimit = CUSTOMERS_PAGE_SIZE;
let _customersFilterFingerprint = '';

function loadMoreCustomers() {
  _customersShowLimit += CUSTOMERS_PAGE_SIZE;
  updateCustomersViewFiltered();
}

function renderCustomersView() {
  const allFilteredCustomers = getFilteredCustomers();
  const allCustomers = getVisibleRecords(state.customers);

  // Reset pagination whenever the filter/sort/search combination changes.
  const filterFingerprint = JSON.stringify([
    state.customerSearch, state.customerSort, state.customerFinancialFilter
  ]);
  if (filterFingerprint !== _customersFilterFingerprint) {
    _customersFilterFingerprint = filterFingerprint;
    _customersShowLimit = CUSTOMERS_PAGE_SIZE;
  }
  const visibleCustomers = allFilteredCustomers.slice(0, _customersShowLimit);
  const remainingCustomers = allFilteredCustomers.length - visibleCustomers.length;

  // Calculate overall stats
  let totalRevenue = 0;
  let totalDebts = 0;

  const statsIndex = buildCustomerStatsIndex();
  allCustomers.forEach(c => {
    const stats = getCustomerStats(c.id, statsIndex);
    totalRevenue += stats.totalPaid;
    if (stats.balance < 0) {
      totalDebts += Math.abs(stats.balance);
    }
  });
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('customers')}</h1>
          <p id="customers-count" class="text-sm text-slate-500 mt-1">${allFilteredCustomers.length} of ${allCustomers.length} customers</p>
        </div>
        <button onclick="showCustomerModal()" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="user-plus" class="w-4 h-4"></i>
          <span>${t('addCustomer')}</span>
        </button>
      </div>

      <!-- Stats Cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        ${renderStatCard('Total Customers', allCustomers.length, 'users', 'from-indigo-500 to-purple-600')}
        ${renderStatCard('Lifetime Revenue (Receipts)', totalRevenue.toFixed(0) + ' LYD', 'dollar-sign', 'from-emerald-500 to-teal-600')}
        ${renderStatCard('Outstanding Debts', totalDebts.toFixed(0) + ' LYD', 'alert-circle', 'from-rose-500 to-pink-600')}
      </div>

      <!-- Search and Filters -->
      <div class="glass-panel rounded-xl p-4">
        <div class="flex flex-col md:flex-row gap-4">
          <input type="text" id="customer-search" placeholder="Search customers..." value="${Security.escapeHtml(state.customerSearch || '')}" class="flex-1 glass-input px-4 py-2 rounded-lg" oninput="onCustomerSearchInput(this.value)" autocomplete="off" />
          
          <div class="flex gap-2">
            <!-- Sort Dropdown -->
            <div class="relative">
              <select id="customer-sort" onchange="state.customerSort = this.value; render();" class="glass-input px-4 py-2 pr-10 rounded-lg appearance-none cursor-pointer">
                <option value="newest" ${state.customerSort === 'newest' ? 'selected' : ''}>Newest First</option>
                <option value="oldest" ${state.customerSort === 'oldest' ? 'selected' : ''}>Oldest First</option>
                <option value="lastActive" ${state.customerSort === 'lastActive' ? 'selected' : ''}>Last Active (Recently)</option>
                <option value="highestPaid" ${state.customerSort === 'highestPaid' ? 'selected' : ''}>Highest Paid (Revenue)</option>
                <option value="lowestPaid" ${state.customerSort === 'lowestPaid' ? 'selected' : ''}>Lowest Paid</option>
                <option value="mostSpend" ${state.customerSort === 'mostSpend' ? 'selected' : ''}>Most Spend (Ads)</option>
                <option value="leastSpend" ${state.customerSort === 'leastSpend' ? 'selected' : ''}>Least Spend</option>
                <option value="biggestCredit" ${state.customerSort === 'biggestCredit' ? 'selected' : ''}>Biggest Credit Balance</option>
                <option value="highestDebt" ${state.customerSort === 'highestDebt' ? 'selected' : ''}>Highest Debt</option>
              </select>
              <i data-lucide="arrow-up-down" class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400"></i>
            </div>
            
            <!-- Financial Filter -->
            <div class="relative">
              <select id="customer-financial-filter" onchange="state.customerFinancialFilter = this.value; render();" class="glass-input px-4 py-2 pr-10 rounded-lg appearance-none cursor-pointer">
                <option value="all" ${state.customerFinancialFilter === 'all' ? 'selected' : ''}>All Financials</option>
                <option value="hasCredit" ${state.customerFinancialFilter === 'hasCredit' ? 'selected' : ''}>Has Credit</option>
                <option value="hasDebt" ${state.customerFinancialFilter === 'hasDebt' ? 'selected' : ''}>Has Debt</option>
              </select>
              <i data-lucide="filter" class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400"></i>
            </div>
          </div>
        </div>
      </div>

      <div id="customers-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${renderCustomersGrid(visibleCustomers)}
        ${remainingCustomers > 0 ? `
          <div class="col-span-full flex justify-center py-2">
            <button onclick="loadMoreCustomers()" class="px-6 py-3 glass-panel rounded-xl text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:scale-105 transition-transform flex items-center gap-2">
              <i data-lucide="chevron-down" class="w-4 h-4"></i>
              <span>${state.language === 'ar' ? `عرض المزيد (${remainingCustomers} متبقي)` : `Load more (${remainingCustomers} remaining)`}</span>
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// PAGINATION ("Load more") for the receipts grid. Rendering every receipt
// card at once makes the view slow past a few hundred receipts; we render
// the first RECEIPTS_PAGE_SIZE and reveal more on demand. The limit resets
// automatically whenever the search/filters/sort change (fingerprint check
// inside renderReceiptsView), so filtering always starts from page one.
const RECEIPTS_PAGE_SIZE = 50;
let _receiptsShowLimit = RECEIPTS_PAGE_SIZE;
let _receiptsFilterFingerprint = '';

function loadMoreReceipts() {
  _receiptsShowLimit += RECEIPTS_PAGE_SIZE;
  updateReceiptsViewFiltered();
}

function renderReceiptsView() {
  const allReceipts = getVisibleRecords(state.receipts);
  // PERFORMANCE: one Map lookup per receipt instead of scanning the whole
  // customers array for every receipt (same strict-equality semantics).
  const customersById = new Map(state.customers.map(c => [c.id, c]));

  // Apply filters
  let filteredReceipts = allReceipts.filter(receipt => {
    const customer = customersById.get(receipt.customerId);
    const customerName = customer?.name?.toLowerCase() || '';
    const finalNo = (receipt.finalReceiptNo || receipt.serialNumber || '').toLowerCase();
    const tempNo = (receipt.tempReceiptNo || '').toLowerCase();
    const phoneNumber = (receipt.phoneNumber || '').toLowerCase();
    const searchTerm = (state.receiptSearch || '').toLowerCase();
    
    // Search filter
    if (searchTerm && !customerName.includes(searchTerm) && !finalNo.includes(searchTerm) && !tempNo.includes(searchTerm) && !phoneNumber.includes(searchTerm)) {
      return false;
    }
    
    // Status filter
    if (state.receiptStatusFilter !== 'all') {
      const status = (receipt.status || '').toLowerCase();
      if (status !== state.receiptStatusFilter.toLowerCase()) return false;
    }
    
    // Payment method filter
    if (state.receiptPaymentFilter !== 'all') {
      const paymentMethod = (receipt.paymentMethod || '').toLowerCase();
      if (!paymentMethod.includes(state.receiptPaymentFilter.toLowerCase())) return false;
    }
    
    // Date filter
    if (state.receiptDateFilter !== 'all') {
      const receiptDate = new Date(receipt.createdAt || receipt.startDate);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      if (state.receiptDateFilter === 'today' && receiptDate < today) return false;
      if (state.receiptDateFilter === 'week' && receiptDate < weekAgo) return false;
      if (state.receiptDateFilter === 'month' && receiptDate < monthAgo) return false;
    }
    
    // Collected filter
    if (state.receiptCollectedFilter !== 'all') {
      if (state.receiptCollectedFilter === 'collected' && !receipt.collected) return false;
      if (state.receiptCollectedFilter === 'not-collected' && receipt.collected) return false;
    }
    
    return true;
  });
  
  // Sort receipts
  filteredReceipts.sort((a, b) => {
    const dateA = new Date(a.createdAt || a.startDate);
    const dateB = new Date(b.createdAt || b.startDate);
    
    switch (state.receiptSortBy) {
      case 'oldest':
        return dateA - dateB;
      case 'amount-high':
        return (b.amountUSD || 0) - (a.amountUSD || 0);
      case 'amount-low':
        return (a.amountUSD || 0) - (b.amountUSD || 0);
      case 'newest':
      default:
        return dateB - dateA;
    }
  });
  
  const hasActiveFilters = state.receiptSearch || state.receiptStatusFilter !== 'all' || state.receiptPaymentFilter !== 'all' || state.receiptDateFilter !== 'all' || state.receiptCollectedFilter !== 'all';

  // Reset pagination whenever the filter/sort/search combination changes.
  const filterFingerprint = JSON.stringify([
    state.receiptSearch, state.receiptStatusFilter, state.receiptPaymentFilter,
    state.receiptDateFilter, state.receiptCollectedFilter, state.receiptSortBy
  ]);
  if (filterFingerprint !== _receiptsFilterFingerprint) {
    _receiptsFilterFingerprint = filterFingerprint;
    _receiptsShowLimit = RECEIPTS_PAGE_SIZE;
  }
  const visibleReceipts = filteredReceipts.slice(0, _receiptsShowLimit);
  const remainingReceipts = filteredReceipts.length - visibleReceipts.length;

  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('receipts')}</h1>
          <p id="receipts-count" class="text-sm text-slate-500 mt-1">${filteredReceipts.length}${hasActiveFilters ? ` of ${allReceipts.length}` : ''} receipts</p>
        </div>
        <button onclick="showReceiptModal()" class="btn-shine bg-purple-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="receipt" class="w-4 h-4"></i>
          <span>New Receipt</span>
        </button>
      </div>

      <!-- Search & Filter Bar -->
      <div class="glass-panel rounded-2xl p-4">
        <div class="flex flex-col lg:flex-row gap-4">
          <!-- Search Input -->
          <div class="flex-1 relative">
            <i data-lucide="search" class="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input 
              type="text" 
              id="receipt-search-input"
              placeholder="Search by customer, serial #, or phone..." 
              value="${Security.escapeHtml(state.receiptSearch || '')}"
              oninput="updateReceiptSearch(this.value)"
              class="w-full pl-12 pr-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20 transition-all placeholder:text-slate-400"
            />
            <span id="receipt-search-clear">${state.receiptSearch ? `<button onclick="clearReceiptSearch()" class="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors"><i data-lucide="x" class="w-4 h-4 text-slate-400"></i></button>` : ''}</span>
          </div>
          
          <!-- Filter Dropdowns -->
          <div class="flex flex-wrap gap-2">
            <!-- Status Filter -->
            <select onchange="updateReceiptFilter('status', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptStatusFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptStatusFilter === 'all' ? 'selected' : ''}>All Status</option>
              <option value="paid" ${state.receiptStatusFilter === 'paid' ? 'selected' : ''}>✓ Paid</option>
              <option value="pending" ${state.receiptStatusFilter === 'pending' ? 'selected' : ''}>⏳ Pending</option>
              <option value="cancelled" ${state.receiptStatusFilter === 'cancelled' ? 'selected' : ''}>✕ Cancelled</option>
            </select>
            
            <!-- Payment Method Filter -->
            <select onchange="updateReceiptFilter('payment', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptPaymentFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptPaymentFilter === 'all' ? 'selected' : ''}>All Payments</option>
              <option value="cash" ${state.receiptPaymentFilter === 'cash' ? 'selected' : ''}>💵 Cash</option>
              <option value="usdt" ${state.receiptPaymentFilter === 'usdt' ? 'selected' : ''}>💎 USDT</option>
              <option value="bank" ${state.receiptPaymentFilter === 'bank' ? 'selected' : ''}>🏦 Bank Transfer</option>
              <option value="split" ${state.receiptPaymentFilter === 'split' ? 'selected' : ''}>📊 Split Payment</option>
            </select>
            
            <!-- Date Filter -->
            <select onchange="updateReceiptFilter('date', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptDateFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptDateFilter === 'all' ? 'selected' : ''}>All Time</option>
              <option value="today" ${state.receiptDateFilter === 'today' ? 'selected' : ''}>📅 Today</option>
              <option value="week" ${state.receiptDateFilter === 'week' ? 'selected' : ''}>📆 This Week</option>
              <option value="month" ${state.receiptDateFilter === 'month' ? 'selected' : ''}>🗓️ This Month</option>
            </select>
            
            <!-- Collected Filter -->
            <select onchange="updateReceiptFilter('collected', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer ${state.receiptCollectedFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all" ${state.receiptCollectedFilter === 'all' ? 'selected' : ''}>All Collection</option>
              <option value="collected" ${state.receiptCollectedFilter === 'collected' ? 'selected' : ''}>✓ Collected</option>
              <option value="not-collected" ${state.receiptCollectedFilter === 'not-collected' ? 'selected' : ''}>○ Not Collected</option>
            </select>
            
            <!-- Sort By -->
            <select onchange="updateReceiptFilter('sort', this.value)" class="px-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 transition-all cursor-pointer">
              <option value="newest" ${state.receiptSortBy === 'newest' ? 'selected' : ''}>🕐 Newest First</option>
              <option value="oldest" ${state.receiptSortBy === 'oldest' ? 'selected' : ''}>🕐 Oldest First</option>
              <option value="amount-high" ${state.receiptSortBy === 'amount-high' ? 'selected' : ''}>💰 Highest Amount</option>
              <option value="amount-low" ${state.receiptSortBy === 'amount-low' ? 'selected' : ''}>💰 Lowest Amount</option>
            </select>
            
            <!-- Clear Filters Button (span uses display:contents so the button stays a direct flex item) -->
            <span id="receipt-clear-filters" class="contents">${hasActiveFilters ? `
              <button onclick="clearAllReceiptFilters()" class="px-4 py-3 bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border-2 border-rose-200 dark:border-rose-800 rounded-xl text-sm font-bold hover:bg-rose-200 dark:hover:bg-rose-900/50 transition-all flex items-center space-x-2">
                <i data-lucide="x-circle" class="w-4 h-4"></i>
                <span>Clear</span>
              </button>
            ` : ''}</span>
          </div>
        </div>
        
        <!-- Active Filters Display -->
        <div id="receipt-active-filters">${hasActiveFilters ? `
          <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
            <span class="text-xs font-medium text-slate-500">Active filters:</span>
            ${state.receiptSearch ? `<span class="px-2 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full text-xs font-medium flex items-center"><i data-lucide="search" class="w-3 h-3 mr-1"></i>"${Security.escapeHtml(state.receiptSearch)}"</span>` : ''}
            ${state.receiptStatusFilter !== 'all' ? `<span class="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-xs font-medium">${state.receiptStatusFilter}</span>` : ''}
            ${state.receiptPaymentFilter !== 'all' ? `<span class="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 rounded-full text-xs font-medium">${state.receiptPaymentFilter}</span>` : ''}
            ${state.receiptDateFilter !== 'all' ? `<span class="px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full text-xs font-medium">${state.receiptDateFilter}</span>` : ''}
            ${state.receiptCollectedFilter !== 'all' ? `<span class="px-2 py-1 ${state.receiptCollectedFilter === 'collected' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300'} rounded-full text-xs font-medium">${state.receiptCollectedFilter}</span>` : ''}
          </div>
        ` : ''}</div>
      </div>

      <div id="receipts-grid" class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        ${filteredReceipts.length === 0 ? `<div class="col-span-full glass-panel rounded-2xl p-12 text-center"><i data-lucide="${hasActiveFilters ? 'search-x' : 'receipt'}" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">${hasActiveFilters ? 'No receipts match your filters' : 'No receipts yet'}</p>${hasActiveFilters ? '<button onclick="clearAllReceiptFilters()" class="mt-4 text-purple-600 hover:text-purple-700 font-medium">Clear all filters</button>' : ''}</div>` : visibleReceipts.map((receipt, idx) => {
          const customer = customersById.get(receipt.customerId);
          const displayFinalNo = receipt.finalReceiptNo || receipt.serialNumber || '';
          const displayTempNo = receipt.tempReceiptNo || '';
          // Display number: total - index (so first item = highest number, matching newest-first sort)
          const receiptDisplayNum = filteredReceipts.length - idx;
          // Normalize payments
          const payments = Array.isArray(receipt.payments) ? receipt.payments : [];
          const hasMultiplePayments = payments.length > 1;

          // Calculate total paid as sum of R1 values (amount × rate)
          const totalPaid = payments.reduce((sum, p) => sum + ((p.amount || 0) * (p.rate || 1)), 0) || receipt.amountLocal;
          const usage = getReceiptUsageStats(receipt);
          const hasTransfers = (receipt.transfers && receipt.transfers.length > 0);
          const lastTransfer = hasTransfers ? receipt.transfers[receipt.transfers.length - 1] : null;
          const lastTransferName = lastTransfer ? (customersById.get(lastTransfer.toCustomerId)?.name || 'Unknown') : '';
          const lastTransferNameSafe = Security.escapeHtml(String(lastTransferName || ''));
          // Defensive: ensure exchange rate is always positive and reasonable
          const rawFxRate = (receipt.exchangeRate || state.defaultExchangeRate || 1);
          const fxRate = (typeof rawFxRate === 'number' && rawFxRate > 0 && rawFxRate < 1000) ? rawFxRate : 1;
          const remainingLYD = (usage.remainingUSD || 0) * fxRate;
          const spentLYD = (usage.usedUSD || 0) * fxRate;

          const creatorId = receipt.createdBy || receipt.creatorId || '';
          const creatorNameRaw = creatorId
            ? (state.users.find(u => String(u.id) === String(creatorId))?.name || (creatorId === 'system' ? 'System' : 'Unknown'))
            : 'Unknown';
          const creatorName = Security.escapeHtml(String(creatorNameRaw || 'Unknown'));
          
          return `
            <div class="glass-panel rounded-2xl p-6 hover:scale-[1.01] transition-transform">
              <div class="flex justify-between items-start mb-4">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded-md bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 text-xs font-bold">#${receiptDisplayNum}</span>
                  <h3 class="text-lg font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
                  </div>
                  ${(displayTempNo || displayFinalNo) ? `
                    <p class="text-sm text-indigo-600 font-medium">
                      Serial: ${displayTempNo && displayFinalNo ? `${displayTempNo} → ${displayFinalNo}` : (displayTempNo ? `${displayTempNo} (Temp)` : displayFinalNo)}
                    </p>
                  ` : ''}
                  <p class="text-xs text-slate-400 mt-1">${new Date(receipt.createdAt || receipt.startDate).toLocaleString()}</p>
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-slate-500">
                    <span class="inline-flex items-center gap-1" title="Created by">
                      <i data-lucide="user" class="w-3 h-3"></i>
                      <span>${state.language === 'ar' ? 'تم الإنشاء بواسطة' : 'Created by'}: <span class="font-medium text-slate-700 dark:text-slate-300">${creatorName}</span></span>
                    </span>
                    <span class="inline-flex items-center gap-1" title="Ads credit usage from this receipt">
                      <i data-lucide="trending-down" class="w-3 h-3"></i>
                      <span>${state.language === 'ar' ? 'رصيد الإعلانات' : 'Ads credit'}: <span class="font-semibold text-emerald-600">$${usage.usedUSD.toFixed(2)}</span> ${state.language === 'ar' ? 'مصروف' : 'spent'} • <span class="font-semibold text-blue-600">$${usage.remainingUSD.toFixed(2)}</span> ${state.language === 'ar' ? 'متبقي' : 'left'} <span class="text-slate-400">(${remainingLYD.toFixed(2)} LYD)</span></span>
                    </span>
                  </div>
                  ${receipt.updatedAt ? `
                    <div class="flex items-center mt-0.5 space-x-2">
                      <p class="text-[10px] text-amber-500 flex items-center"><i data-lucide="edit-3" class="w-2.5 h-2.5 mr-1"></i>Edited: ${new Date(receipt.updatedAt).toLocaleString()}</p>
                      ${receipt.editCount ? `<button onclick="showReceiptEditHistory('${receipt.id}')" class="text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors font-medium">${receipt.editCount} edit${receipt.editCount > 1 ? 's' : ''}</button>` : ''}
                    </div>
                  ` : ''}
                </div>
                <div class="text-right">
                  <div class="text-2xl font-bold text-emerald-600">$${receipt.amountUSD?.toFixed(2)}</div>
                  <div class="text-sm text-slate-500">${receipt.amountLocal?.toFixed(2)} LYD</div>
                  ${receipt.isPaid ? '<div class="text-xs text-emerald-600 mt-1">✓ Paid</div>' : '<div class="text-xs text-amber-600 mt-1">⏳ Unpaid</div>'}
                  ${receipt.paymentResult ? `
                    <div class="text-[10px] mt-1 ${receipt.paymentResult === 'UNDERPAID' ? 'text-rose-600' : receipt.paymentResult === 'OVERPAID' ? 'text-blue-600' : 'text-emerald-600'} font-bold">
                      ${receipt.paymentResult === 'PAID_EXACT' ? 'Paid exact' : receipt.paymentResult === 'OVERPAID' ? `Overpaid +${Number(receipt.overpaidAmount || 0).toFixed(0)} LYD` : `Remaining ${Number(receipt.remainingDue || 0).toFixed(0)} LYD`}
                    </div>
                  ` : ''}
                  ${receipt.feeDifferenceStatus ? `
                    <div class="text-[10px] ${receipt.feeDifferenceStatus === 'SAME' ? 'text-slate-500' : receipt.feeDifferenceStatus === 'LOWER' ? 'text-amber-600' : 'text-purple-600'} font-bold">
                      Fee ${receipt.feeDifferenceStatus.toLowerCase()}
                    </div>
                  ` : ''}
                  ${hasTransfers ? `<div class="text-xs text-blue-600 mt-1 flex items-center justify-end space-x-1" title="Transferred${lastTransferNameSafe ? ' to ' + lastTransferNameSafe : ''}"><i data-lucide="swap" class="w-3 h-3"></i><span>Transferred</span></div>` : ''}
                </div>
              </div>

              <div class="space-y-2 mb-4 text-sm border-t border-b border-slate-200 dark:border-slate-700 py-3">
                <div class="flex justify-between"><span class="text-slate-500">Exchange Rate:</span><span class="font-medium">${receipt.exchangeRate?.toFixed(2)}</span></div>
                ${receipt.officeFee ? `<div class="flex justify-between"><span class="text-slate-500">Office Fee:</span><span class="font-medium text-amber-600">+${receipt.officeFee?.toFixed(2)} LYD</span></div>` : ''}
                ${receipt.discount ? `<div class="flex justify-between"><span class="text-slate-500">Discount:</span><span class="font-medium text-emerald-600">-${receipt.discount?.toFixed(2)} LYD</span></div>` : ''}
              </div>

              ${hasMultiplePayments ? `
                <div class="mb-4">
                  <h4 class="text-xs font-bold text-slate-500 uppercase mb-2 flex items-center">
                    <i data-lucide="credit-card" class="w-3 h-3 mr-1"></i>
                    Split Payments (${payments.length})
                  </h4>
                  <div class="space-y-2">
                    ${payments.map((payment, idx) => {
                      // Calculate R1 = amount × rate
                      const r1 = (payment.amount || 0) * (payment.rate || 1);
                      return `
                      <div class="split-payment-item flex justify-between items-center">
                        <div>
                          <span class="font-medium text-sm">${payment.method}</span>
                          ${payment.collectionType ? `<span class="text-xs text-slate-500 ml-2 px-2 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">${payment.collectionType}</span>` : ''}
                          ${payment.deliveryPersonId ? `<div class="text-xs text-slate-500">${Security.escapeHtml(state.users.find(u => u.id === payment.deliveryPersonId)?.name || 'Unknown')}</div>` : ''}
                        </div>
                        <div class="text-right">
                          <div class="font-bold text-indigo-600">${r1.toFixed(2)} LYD</div>
                          ${payment.rate ? `<div class="text-xs text-slate-500">@ ${payment.rate}</div>` : ''}
                        </div>
                      </div>
                    `}).join('')}
                  </div>
                  <div class="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between font-bold text-emerald-600">
                    <span>Total Paid:</span><span>${totalPaid.toFixed(2)} LYD</span>
                  </div>
                </div>
              ` : `
                <div class="mb-4">
                  <h4 class="text-xs font-bold text-slate-500 uppercase mb-2 flex items-center">
                    <i data-lucide="activity" class="w-3 h-3 mr-1"></i>
                    Usage & Balance
                  </h4>
                  <div class="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="link-2" class="w-3 h-3"></i><span>Linked Ads</span>
                      </div>
                      <div class="font-bold text-slate-700 dark:text-slate-300">${usage.fundedAds.length}</div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="dollar-sign" class="w-3 h-3"></i><span>Usage</span>
                      </div>
                      <div class="font-bold text-emerald-600">$${usage.usedUSD.toFixed(2)} used</div>
                      <div class="text-xs text-slate-500">Left: $${usage.remainingUSD.toFixed(2)} (${remainingLYD.toFixed(2)} LYD)</div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="gauge" class="w-3 h-3"></i><span>Status</span>
                      </div>
                      <span class="status-badge status-${usage.usageStatus.toLowerCase().replace(' ', '-')}">${usage.usageStatus}</span>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="clock" class="w-3 h-3"></i><span>Last Used</span>
                      </div>
                      <div class="text-xs text-slate-600 dark:text-slate-400">${formatDateShort(usage.lastUsedAt)}</div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="check-circle" class="w-3 h-3"></i><span>Used?</span>
                      </div>
                      <div class="text-xs font-medium ${usage.usedUSD > 0 ? 'text-emerald-600' : 'text-amber-600'}">
                        ${usage.usedUSD === 0 ? 'Not used yet' : (usage.remainingUSD === 0 ? 'Fully used' : 'Partially used')}
                      </div>
                    </div>
                    <div>
                      <div class="text-slate-500 text-xs mb-1 flex items-center space-x-1">
                        <i data-lucide="calendar" class="w-3 h-3"></i><span>Total Allocated</span>
                      </div>
                      <div class="font-bold text-slate-700 dark:text-slate-300">$${usage.totalUSD.toFixed(2)}</div>
                    </div>
                    <div class="col-span-2 flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40">
                      <div class="text-xs text-slate-600 dark:text-slate-300 flex items-center space-x-2">
                        <i data-lucide="swap" class="w-3 h-3"></i>
                        <span>Transferred: $${usage.transferredUSD.toFixed(2)}</span>
                        ${hasTransfers && lastTransferName ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-100">Last: ${lastTransferName}</span>` : ''}
                      </div>
                      <div class="flex items-center space-x-3">
                        ${hasTransfers ? `<button class="text-xs text-blue-600 hover:text-blue-700" title="View transfer history" onclick="showReceiptTransferHistory('${receipt.id}')">History</button>` : ''}
                        <button class="text-xs text-blue-600 hover:text-blue-700" title="Transfer balance" onclick="showReceiptTransferModal('${receipt.id}')">Transfer</button>
                      </div>
                    </div>
                  </div>
                </div>
              `}

              ${receipt.receiptImage ? `<div class="mb-4"><img src="${Security.escapeHtml(receipt.receiptImage)}" alt="Receipt" class="w-full h-32 object-cover rounded-lg border border-slate-200 dark:border-slate-700" /></div>` : ''}

              <!-- Collected Toggle -->
              <div class="flex items-center justify-between py-2 px-3 mb-3 rounded-xl ${receipt.collected ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800' : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'}">
                <div class="flex items-center space-x-2">
                  <i data-lucide="${receipt.collected ? 'check-circle-2' : 'circle'}" class="w-4 h-4 ${receipt.collected ? 'text-emerald-600' : 'text-amber-600'}"></i>
                  <span class="text-sm font-medium ${receipt.collected ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}">
                    ${receipt.collected ? 'Collected' : 'Not Collected'}
                  </span>
                  ${receipt.collectedAt ? `<span class="text-[10px] text-slate-500">${new Date(receipt.collectedAt).toLocaleDateString()}</span>` : ''}
                  ${receipt.collectedBy ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400">${Security.escapeHtml(state.users.find(u => u.id === receipt.collectedBy)?.name || 'Admin')}</span>` : ''}
                </div>
                <button onclick="toggleReceiptCollected('${receipt.id}')" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${receipt.collected ? 'bg-amber-100 hover:bg-amber-200 text-amber-700 dark:bg-amber-900/40 dark:hover:bg-amber-900/60 dark:text-amber-300' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700 dark:bg-emerald-900/40 dark:hover:bg-emerald-900/60 dark:text-emerald-300'}">
                  ${receipt.collected ? 'Mark Not Collected' : 'Mark Collected'}
                </button>
              </div>

              <div class="flex flex-col space-y-2 pt-3 border-t border-slate-200 dark:border-slate-700">
                <div class="flex justify-between items-center">
                  <span class="status-badge status-${(receipt.status || '').toLowerCase()}">${receipt.status || 'Unknown'}</span>
                  <div class="flex space-x-2">
                    <button onclick="showReceiptTransferModal('${receipt.id}')" class="text-blue-600 hover:text-blue-700" title="Transfer balance">
                      <i data-lucide="swap" class="w-4 h-4"></i>
                    </button>
                    <button onclick="manageSplitPayments('${receipt.id}')" class="text-purple-600 hover:text-purple-700" title="${state.language === 'ar' ? 'تعديل الدفعات المقسّمة' : 'Manage split payments'}"><i data-lucide="credit-card" class="w-4 h-4"></i></button>
                    <button onclick="editReceipt('${receipt.id}')" class="text-blue-600 hover:text-blue-700" title="Edit"><i data-lucide="edit" class="w-4 h-4"></i></button>
                    <button onclick="printReceiptCard(this)" class="text-slate-600 hover:text-slate-700" title="Print"><i data-lucide="printer" class="w-4 h-4"></i></button>
                    <button onclick="deleteReceipt('${receipt.id}')" class="text-rose-600 hover:text-rose-700" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
        ${remainingReceipts > 0 ? `
          <div class="col-span-full flex justify-center py-2">
            <button onclick="loadMoreReceipts()" class="px-6 py-3 glass-panel rounded-xl text-sm font-bold text-purple-600 dark:text-purple-400 hover:scale-105 transition-transform flex items-center gap-2">
              <i data-lucide="chevron-down" class="w-4 h-4"></i>
              <span>${state.language === 'ar' ? `عرض المزيد (${remainingReceipts} متبقي)` : `Load more (${remainingReceipts} remaining)`}</span>
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderPagesView() {
  const visiblePages = getVisibleRecords(state.pages);
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('pages')}</h1>
          <p class="text-sm text-slate-500 mt-1">${visiblePages.length} Facebook pages</p>
        </div>
        <button onclick="showPageModal()" class="btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="file-plus" class="w-4 h-4"></i>
          <span>${t('addPage')}</span>
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${visiblePages.length === 0 ? '<div class="col-span-full glass-panel rounded-2xl p-12 text-center"><i data-lucide="file-text" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">No pages yet</p></div>' : visiblePages.map((p, idx) => {
          const linkedCustomers = p.customerIds ? p.customerIds.map(cid => state.customers.find(c => c.id === cid)).filter(Boolean) : [];
          const pageAds = getVisibleRecords(state.ads).filter(ad => ad.pageId === p.id && ad.recordType === 'ad');
          
          // Calculate page statistics
          const totalSpent = pageAds.reduce((sum, ad) => sum + (ad.adSpent || 0), 0);
          const lastAdDate = pageAds.length > 0 
            ? Math.max(...pageAds.map(ad => new Date(ad.date || ad.createdAt).getTime()))
            : null;
          const lastAdText = lastAdDate 
            ? new Date(lastAdDate).toLocaleDateString()
            : 'Never';
          // Display number: total - index (so first item = highest number)
          const pageDisplayNum = visiblePages.length - idx;
          
          return `
            <div class="glass-panel rounded-xl p-5 hover:scale-[1.02] transition-transform">
              <div class="flex justify-between items-start mb-4">
                <div class="flex-1">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-400 text-xs font-bold">#${pageDisplayNum}</span>
                  </div>
                  <h3 class="font-bold text-lg text-slate-800 dark:text-white flex items-center">
                    <i data-lucide="facebook" class="w-4 h-4 mr-2 text-blue-600"></i>
                    ${Security.escapeHtml(p.name || '')}
                  </h3>
                  <p class="text-sm text-slate-500 mt-1">${Security.escapeHtml(p.category || '')}</p>
                </div>
                <div class="flex space-x-1">
                  <button onclick="editPage('${p.id}')" class="text-blue-600 hover:text-blue-700 p-1" title="Edit">
                    <i data-lucide="edit" class="w-4 h-4"></i>
                  </button>
                  <button onclick="deletePage('${p.id}')" class="text-rose-600 hover:text-rose-700 p-1" title="Delete">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              </div>

              <div class="space-y-2 border-t border-slate-200 dark:border-slate-700 pt-3">
                <!-- Owner(s) -->
                  <div>
                  <div class="text-xs font-medium text-slate-500 mb-1.5 flex items-center">
                    <i data-lucide="user" class="w-3 h-3 mr-1"></i>
                    Owner${linkedCustomers.length > 1 ? 's' : ''}
                    </div>
                  ${linkedCustomers.length > 0 ? `
                    <div class="space-y-1">
                      ${linkedCustomers.slice(0, 2).map(c => `
                        <div class="text-sm text-slate-700 dark:text-slate-300 flex items-center space-x-2">
                          <span class="w-1.5 h-1.5 bg-indigo-500 rounded-full"></span>
                          <span>${Security.escapeHtml(c.name || '')}</span>
                        </div>
                      `).join('')}
                      ${linkedCustomers.length > 2 ? `<div class="text-xs text-slate-500 ml-3.5">+${linkedCustomers.length - 2} more</div>` : ''}
                    </div>
                  ` : '<div class="text-sm text-slate-400 ml-4">No owner</div>'}
                  </div>

                <!-- Last Ad Time -->
                  <div class="flex items-center space-x-2 text-xs">
                  <i data-lucide="clock" class="w-3 h-3 text-slate-400"></i>
                  <span class="text-slate-600 dark:text-slate-400">Last ad: ${lastAdText}</span>
                  </div>

                <!-- Stats -->
                <div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                  <div class="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div class="text-slate-500 mb-1">Total Ads</div>
                      <div class="font-bold text-slate-700 dark:text-slate-300">${pageAds.length}</div>
                    </div>
                    <div>
                      <div class="text-slate-500 mb-1">Total Spend</div>
                      <div class="font-bold text-emerald-600 dark:text-emerald-400">${totalSpent.toFixed(0)} LYD</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

let _adSearchTimer = null;
function onAdSearchInput(value) {
  // Debounced ads search: keep the term in state and swap only the table, instead
  // of the old oninput="render()" which rebuilt the ENTIRE app (and the whole ads
  // table) synchronously on every keystroke.
  state.adSearch = Security.sanitizeInput(String(value || ''), { maxLength: 200 });
  if (_adSearchTimer) clearTimeout(_adSearchTimer);
  _adSearchTimer = setTimeout(() => {
    _adSearchTimer = null;
    updateAdsViewFiltered();
  }, 80);
}

function updateAdsViewFiltered() {
  if (state.currentView !== 'ads') return;
  const container = document.getElementById('ads-table-container');
  const countEl = document.getElementById('ads-count');
  if (!container) {
    // View not on screen (e.g. mid-navigation): fall back to a full render.
    render();
    if (window.lucide) lucide.createIcons();
    return;
  }
  // Build the fresh view off-screen and swap only the table + count so the search
  // input keeps its caret (same approach as updateReceiptsViewFiltered).
  const tpl = document.createElement('template');
  tpl.innerHTML = renderAdsView();
  const src = tpl.content;
  const newContainer = src.querySelector('#ads-table-container');
  const newCount = src.querySelector('#ads-count');
  if (newContainer) container.innerHTML = newContainer.innerHTML;
  if (countEl && newCount) countEl.textContent = newCount.textContent;
  if (window.lucide) lucide.createIcons();
}

function renderAdsView() {
  // PERFORMANCE: build id->record Maps ONCE so each table row does O(1) lookups
  // instead of scanning state.customers / state.receipts / state.users per row
  // (was O(ads × (customers+receipts+users)) on every keystroke). Same Map is
  // passed into getFilteredAds so the search filter is O(1)-per-ad too.
  const customersById = new Map(state.customers.map(c => [c.id, c]));
  const receiptsById = new Map(state.receipts.map(r => [r.id, r]));
  const usersById = new Map(state.users.map(u => [u.id, u]));
  const allAds = getFilteredAds(customersById);

  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('ads')}</h1>
          <p id="ads-count" class="text-sm text-slate-500 mt-1">${allAds.length} total ads</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button onclick="showAdModal()" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
            <i data-lucide="plus" class="w-4 h-4"></i>
            <span>${t('addAd')}</span>
          </button>
          <button onclick="window.print()" class="btn-shine bg-slate-600 text-white px-3 py-2 rounded-xl">
            <i data-lucide="printer" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <div class="glass-panel rounded-xl p-4">
        <input type="text" id="ad-search" placeholder="Search ads..." value="${Security.escapeHtml(state.adSearch || '')}" class="w-full glass-input px-4 py-2 rounded-lg" oninput="onAdSearchInput(this.value)" autocomplete="off" />
      </div>

      <div id="ads-table-container" class="glass-panel rounded-2xl p-6 overflow-x-auto">
        ${allAds.length === 0 ? '<div class="text-center py-12"><i data-lucide="inbox" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i><p class="text-slate-500">No ads yet</p></div>' : `
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b-2 border-indigo-200 dark:border-indigo-800">
                <th class="text-left py-3 px-2 w-12">#</th>
                <th class="text-left py-3 px-2">Customer</th>
                <th class="text-left py-3 px-2">Amount</th>
                <th class="text-left py-3 px-2">Rate</th>
                <th class="text-left py-3 px-2">Local</th>
                <th class="text-left py-3 px-2">Payment</th>
                <th class="text-left py-3 px-2">Status</th>
                <th class="text-left py-3 px-2">Delivery</th>
                <th class="text-left py-3 px-2">Serial</th>
                <th class="text-left py-3 px-2">Date</th>
                <th class="text-left py-3 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${allAds.map((ad, idx) => {
                const customer = customersById.get(ad.customerId);
                // For ads linked to delivery receipts, get delivery status from the receipt (source of truth)
                const linkedReceipt = ad.linkedDeliveryReceiptId ? receiptsById.get(ad.linkedDeliveryReceiptId) : null;
                const effectiveDeliveryStatus = linkedReceipt ? (linkedReceipt.deliveryStatus || 'Needs Delivery') : (ad.deliveryStatus || 'Office');
                const effectiveDeliveryPersonId = linkedReceipt ? linkedReceipt.deliveryPersonId : ad.deliveryPersonId;
                const deliveryPerson = effectiveDeliveryPersonId ? usersById.get(effectiveDeliveryPersonId) : null;
                const isLinkedToDeliveryReceipt = !!linkedReceipt;
                // Use consistent exchange rate calculation
                const receiptExchangeRate = getEffectiveExchangeRate(ad);
                // Display number: total - index (so first item = highest number)
                const adDisplayNum = allAds.length - idx;
                return `
                  <tr class="border-b border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td class="py-3 px-2" data-label="#">
                      <div class="font-medium">#${adDisplayNum} - ${Security.escapeHtml(customer?.name || 'Unknown')}</div>
                      ${ad.phoneNumber ? `<div class="text-xs text-slate-500">${Security.escapeHtml(ad.phoneNumber)}</div>` : ''}
                    </td>
                    <td class="py-3 px-2 hidden md:table-cell">
                      <div class="font-medium">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
                      ${ad.phoneNumber ? `<div class="text-xs text-slate-500">${Security.escapeHtml(ad.phoneNumber)}</div>` : ''}
                    </td>
                    <td class="py-3 px-2 font-bold text-emerald-600" data-label="Amount">$${ad.amountUSD?.toFixed(2) || '0.00'}</td>
                    <td class="py-3 px-2" data-label="Rate">${receiptExchangeRate?.toFixed(2) || ad.exchangeRate?.toFixed(2) || '0.00'}</td>
                    <td class="py-3 px-2" data-label="Local">${ad.amountLocal?.toFixed(2)} LYD</td>
                    <td class="py-3 px-2" data-label="Payment"><span class="payment-badge text-xs">${ad.paymentMethod}</span></td>
                    <td class="py-3 px-2" data-label="Status">
                      <select class="glass-input px-2 py-1 rounded-lg text-xs w-full md:w-auto" onchange="updateAdStatusFromList('${ad.id}', this.value)">
                        ${AD_STATUSES.map(s => `<option value="${s}" ${ad.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                      </select>
                      ${ad.isPaid ? '<div class="text-xs text-emerald-600 mt-1">✓ Paid</div>' : ''}
                      ${ad.status === 'Stopped' && ad.spentUSD !== undefined ? `
                        <div class="text-xs mt-1 space-y-0.5">
                          <div class="text-orange-600">Spent: $${ad.spentUSD.toFixed(2)}</div>
                          <div class="text-emerald-600">Remaining: $${((ad.amountUSD || 0) - ad.spentUSD).toFixed(2)}</div>
                        </div>
                      ` : ''}
                    </td>
                    <td class="py-3 px-2" data-label="Delivery">
                      ${isLinkedToDeliveryReceipt ? `
                        <div class="px-2 py-1 rounded-lg text-xs delivery-${effectiveDeliveryStatus.toLowerCase().replace(' ', '')} bg-slate-100 dark:bg-slate-700">
                          ${effectiveDeliveryStatus}
                          <div class="text-[10px] text-slate-400 mt-0.5">via Receipt</div>
                        </div>
                      ` : `
                        <select class="glass-input px-2 py-1 rounded-lg text-xs w-full md:w-auto delivery-${effectiveDeliveryStatus.toLowerCase().replace(' ', '')}" onchange="updateAdDeliveryStatus('${ad.id}', this.value)">
                          ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${effectiveDeliveryStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                      `}
                      ${deliveryPerson ? `<div class="text-xs text-slate-500 mt-1">${Security.escapeHtml(deliveryPerson.name || '')}</div>` : ''}
                    </td>
                    <td class="py-3 px-2" data-label="Serial">
                      ${ad.serialNumber ? `<span class="font-mono text-xs">${ad.serialNumber}</span>` : '-'}
                      ${ad.editCount ? `<button onclick="showAdEditHistory('${ad.id}')" class="block mt-1 text-[10px] px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors font-medium">${ad.editCount} edit${ad.editCount > 1 ? 's' : ''}</button>` : ''}
                    </td>
                    <td class="py-3 px-2 text-xs text-slate-500" data-label="Date">${new Date(ad.startDate).toLocaleDateString()}</td>
                    <td class="py-3 px-2" data-label="Actions">
                      <div class="flex flex-wrap gap-2 md:gap-1 justify-center md:justify-start">
                        <button onclick="manageTopUps('${ad.id}')" class="text-blue-600 hover:text-blue-700 p-2 md:p-0" title="Top-ups">
                          <i data-lucide="trending-up" class="w-5 h-5 md:w-4 md:h-4"></i>
                          ${ad.topUps && ad.topUps.length > 0 ? `<span class="text-xs">${ad.topUps.length}</span>` : ''}
                        </button>
                        <button onclick="manageRefund('${ad.id}')" class="text-amber-600 hover:text-amber-700 p-2 md:p-0" title="Refund">
                          <i data-lucide="arrow-left-circle" class="w-5 h-5 md:w-4 md:h-4"></i>
                          ${ad.refundType && ad.refundType !== 'None' ? `<span class="text-xs">!</span>` : ''}
                        </button>
                        <button onclick="stopAd('${ad.id}')" class="text-orange-600 hover:text-orange-700 p-2 md:p-0" title="${ad.status === 'Stopped' ? 'Edit Stop Details' : 'Stop Ad'}">
                          <i data-lucide="${ad.status === 'Stopped' ? 'edit' : 'square'}" class="w-5 h-5 md:w-4 md:h-4"></i>
                          ${ad.status === 'Stopped' ? '<span class="text-xs">!</span>' : ''}
                        </button>
                        <button onclick="editAd('${ad.id}')" class="text-indigo-600 hover:text-indigo-700 p-2 md:p-0" title="Edit"><i data-lucide="edit" class="w-5 h-5 md:w-4 md:h-4"></i></button>
                        <button onclick="deleteAd('${ad.id}')" class="text-rose-600 hover:text-rose-700 p-2 md:p-0" title="Delete"><i data-lucide="trash-2" class="w-5 h-5 md:w-4 md:h-4"></i></button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;
}

function renderDeliveriesView() {
  // Deliveries are tracked ONLY on receipts (ads are not a delivery source of truth).
  const allReceipts = getVisibleRecords(state.receipts);
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));

  const deliveryReceipts = allReceipts
    .filter(r => {
      if (!r) return false;
      const ds = String(r.deliveryStatus || '').trim();
      if (ds && ds !== 'Office') return true;
      const sd = (r && typeof r.statusDetail === 'object' && r.statusDetail) ? r.statusDetail : {};
      const npc = String(sd.notPaidCollection || '').trim();
      return String(r.status || '').trim() === 'Not Paid' && npc === 'delivery';
    })
    .map(r => ({
      ...r,
      isReceipt: true,
      deliveryStatus: String(r.deliveryStatus || '').trim() || 'Needs Delivery',
      amountLocal: Number(r.amountLocal || 0) || 0,
      amountUSD: Number(r.amountUSD || 0) || 0
    }));

  const deliveredRows = deliveryReceipts.filter(d => d.deliveryStatus === 'Delivered');
  const heldRows = deliveredRows.filter(d => !_isReceivedInOffice(d) && _getCollectedCashLocal(d) > 0);

  const stats = {
    pendingDelivery: deliveryReceipts.filter(d => d.deliveryStatus === 'Needs Delivery').length,
    pendingAssignment: deliveryReceipts.filter(d => !d.deliveryPersonId && d.deliveryStatus !== 'Canceled' && d.deliveryStatus !== 'Delivered').length,
    inProgress: deliveryReceipts.filter(d => d.deliveryStatus === 'In Progress').length,
    delivered: deliveredRows.length,
    completed: deliveredRows.filter(d => _isReceivedInOffice(d) || _getCollectedCashLocal(d) <= 0).length,
    canceled: deliveryReceipts.filter(d => d.deliveryStatus === 'Canceled').length,
    uncollectedLYD: deliveryReceipts.reduce((sum, d) => sum + _getOutstandingDueLocal(d), 0),
    heldByDrivers: heldRows.length,
    driverCashLYD: heldRows.reduce((sum, d) => sum + _getCollectedCashLocal(d), 0),
  };

  const driverPerformance = deliveryUsers.map(driver => {
    const driverDeliveries = deliveryReceipts.filter(d => String(d.deliveryPersonId || '') === String(driver.id || ''));
    const delivered = driverDeliveries.filter(d => d.deliveryStatus === 'Delivered');
    const completed = delivered.filter(d => _isReceivedInOffice(d) || _getCollectedCashLocal(d) <= 0);
    const inProgress = driverDeliveries.filter(d => d.deliveryStatus === 'In Progress');
    const pending = driverDeliveries.filter(d => d.deliveryStatus === 'Needs Delivery');
    const heldCash = delivered.filter(d => !_isReceivedInOffice(d)).reduce((sum, d) => sum + _getCollectedCashLocal(d), 0);
    return {
      ...driver,
      totalAssigned: driverDeliveries.length,
      completed: completed.length,
      inProgress: inProgress.length,
      pending: pending.length,
      heldCash,
      successRate: driverDeliveries.length > 0 ? Math.round((delivered.length / driverDeliveries.length) * 100) : 0
    };
  }).sort((a, b) => b.completed - a.completed);

  const filterStatus = state.deliveryFilter?.status || 'all';
  const filterDriver = state.deliveryFilter?.driver || 'all';
  const searchTerm = state.deliveryFilter?.search || '';

  let filteredDeliveries = [...deliveryReceipts];
  if (filterStatus !== 'all') filteredDeliveries = filteredDeliveries.filter(d => d.deliveryStatus === filterStatus);
  if (filterDriver !== 'all') filteredDeliveries = filteredDeliveries.filter(d => String(d.deliveryPersonId || '') === String(filterDriver || ''));
  if (searchTerm) {
    const term = String(searchTerm).toLowerCase();
    filteredDeliveries = filteredDeliveries.filter(d => {
      const customer = state.customers.find(c => c.id === d.customerId);
      const name = String(customer?.name || '').toLowerCase();
      const phone = String(d.phoneNumber || customer?.phones?.[0] || '').toLowerCase();
      const receiptNo = String(d.tempReceiptNo || d.finalReceiptNo || d.serialNumber || '').toLowerCase();
      return name.includes(term) || phone.includes(term) || receiptNo.includes(term);
    });
  }
  filteredDeliveries.sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0));

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  const canAssign = roleLower !== 'delivery' && (currentUserHasPermission('deliveries', 'assign') || isCurrentUserAdmin());
  const canOffice = roleLower !== 'delivery' && (currentUserHasPermission('deliveries', 'markCollected') || isCurrentUserAdmin());

  const activeDeliveries = deliveryReceipts.filter(d => d.deliveryStatus === 'In Progress' || d.deliveryStatus === 'Needs Delivery');

  return `
    <div class="space-y-6 animate-fade-in-up">
      <!-- Header -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent flex items-center space-x-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
              <i data-lucide="truck" class="w-5 h-5 text-white"></i>
            </span>
            <span>Delivery Operations</span>
          </h1>
          <p class="text-sm text-slate-500 mt-1">${deliveryReceipts.length} deliveries • Tracking receipts only</p>
        </div>
        <div class="flex items-center space-x-2">
          <button onclick="refreshDeliveries()" class="glass-panel px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
            <span>Refresh</span>
          </button>
          <button onclick="checkStuckDeliveries()" class="glass-panel px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2 hover:bg-amber-50 dark:hover:bg-amber-900/20 border-2 border-amber-200 dark:border-amber-800 transition-all" title="Find deliveries stuck in progress for more than 3 days">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-600"></i>
            <span class="text-amber-700 dark:text-amber-400">Check Stuck</span>
          </button>
          <button onclick="exportDeliveryReport()" class="btn-shine bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
            <i data-lucide="download" class="w-4 h-4"></i>
            <span>Export</span>
          </button>
        </div>
      </div>

      <!-- Primary Stats Row -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 text-white shadow-xl shadow-orange-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Pending Delivery</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="package" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.pendingDelivery}</div>
            <div class="text-xs text-white/70 mt-1">Receipts not yet delivered</div>
          </div>
        </div>

        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-emerald-400 via-teal-500 to-cyan-500 text-white shadow-xl shadow-emerald-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Uncollected Value</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="wallet" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.uncollectedLYD.toLocaleString()}<span class="text-lg ml-1">LYD</span></div>
            <div class="text-xs text-white/70 mt-1">To be collected from customers</div>
          </div>
        </div>

        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-violet-400 via-purple-500 to-fuchsia-500 text-white shadow-xl shadow-purple-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Held by Drivers</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="hand-coins" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.heldByDrivers}</div>
            <div class="text-xs text-white/70 mt-1">Delivered but not in office</div>
          </div>
        </div>

        <div class="relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br from-blue-400 via-indigo-500 to-purple-500 text-white shadow-xl shadow-indigo-500/20">
          <div class="absolute top-0 right-0 w-24 h-24 bg-white/10 rounded-full -translate-y-8 translate-x-8"></div>
          <div class="relative">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-white/80 uppercase tracking-wider">Driver Cash Value</span>
              <span class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <i data-lucide="banknote" class="w-4 h-4"></i>
              </span>
            </div>
            <div class="text-3xl font-black">${stats.driverCashLYD.toLocaleString()}<span class="text-lg ml-1">LYD</span></div>
            <div class="text-xs text-white/70 mt-1">To be collected from drivers</div>
          </div>
        </div>
      </div>

      <!-- Status Pipeline -->
      <div class="glass-panel rounded-2xl p-5">
        <div class="flex items-center space-x-2 mb-4">
          <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <i data-lucide="git-branch" class="w-4 h-4 text-white"></i>
          </span>
          <h2 class="text-lg font-bold text-slate-800 dark:text-white">Delivery Pipeline</h2>
        </div>
        <div class="flex items-center justify-between">
          ${renderPipelineStage('Pending Assignment', stats.pendingAssignment, 'clock', 'slate', 0)}
          <div class="flex-1 h-1 mx-2 bg-gradient-to-r from-slate-300 to-amber-300 dark:from-slate-700 dark:to-amber-700 rounded"></div>
          ${renderPipelineStage('In Progress', stats.inProgress, 'truck', 'blue', 1)}
          <div class="flex-1 h-1 mx-2 bg-gradient-to-r from-blue-300 to-emerald-300 dark:from-blue-700 dark:to-emerald-700 rounded"></div>
          ${renderPipelineStage('Completed', stats.completed, 'check-circle', 'emerald', 2)}
          <div class="flex-1 h-1 mx-2 bg-gradient-to-r from-emerald-300 to-rose-300 dark:from-emerald-700 dark:to-rose-700 rounded"></div>
          ${renderPipelineStage('Canceled', stats.canceled, 'x-circle', 'rose', 3)}
        </div>
      </div>

      <!-- Driver Performance & Delivery Log Grid -->
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <!-- Driver Performance -->
        <div class="glass-panel rounded-2xl p-5">
          <div class="flex items-center justify-between mb-4">
            <div class="flex items-center space-x-2">
              <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                <i data-lucide="users" class="w-4 h-4 text-white"></i>
              </span>
              <h2 class="text-lg font-bold text-slate-800 dark:text-white">Driver Performance</h2>
            </div>
          </div>
          <div class="space-y-3 max-h-80 overflow-y-auto">
            ${driverPerformance.length === 0 ? `
              <div class="text-center py-8 text-slate-500">
                <i data-lucide="user-x" class="w-12 h-12 mx-auto mb-2 opacity-50"></i>
                <p>No delivery drivers found</p>
              </div>
            ` : driverPerformance.map((driver, idx) => `
              <div class="relative p-4 rounded-xl border-2 ${idx === 0 ? 'border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800' : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50'} transition-all hover:shadow-md">
                ${idx === 0 ? '<div class="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg"><i data-lucide="crown" class="w-4 h-4 text-white"></i></div>' : ''}
                <div class="flex items-center space-x-3 mb-3">
                  <div class="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-md">
                    ${driver.name?.charAt(0) || '?'}
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="font-bold text-sm text-slate-800 dark:text-white truncate">${Security.escapeHtml(driver.name || '')}</h4>
                    <p class="text-xs text-slate-500">${driver.totalAssigned} assigned</p>
                  </div>
                  <div class="text-right">
                    <div class="text-lg font-black ${driver.successRate >= 80 ? 'text-emerald-600' : driver.successRate >= 50 ? 'text-amber-600' : 'text-slate-500'}">${driver.successRate}%</div>
                    <div class="text-[10px] text-slate-500">Success</div>
                  </div>
                </div>
                <div class="grid grid-cols-4 gap-2 text-center">
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-slate-700 dark:text-slate-300">${driver.pending}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Pending</div>
                  </div>
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-blue-600">${driver.inProgress}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Active</div>
                  </div>
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-emerald-600">${driver.completed}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Done</div>
                  </div>
                  <div class="p-2 rounded-lg bg-white dark:bg-slate-900/50">
                    <div class="text-sm font-bold text-purple-600">${driver.heldCash.toLocaleString()}</div>
                    <div class="text-[9px] text-slate-500 uppercase">Held LYD</div>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Delivery Log -->
        <div class="xl:col-span-2 glass-panel rounded-2xl p-5">
          <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-4">
            <div class="flex items-center space-x-2">
              <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                <i data-lucide="clipboard-list" class="w-4 h-4 text-white"></i>
              </span>
              <h2 class="text-lg font-bold text-slate-800 dark:text-white">Delivery Log</h2>
            </div>
            <div class="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <div class="relative flex-1 md:flex-none">
                <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"></i>
                <input type="text" placeholder="Search..." value="${Security.escapeHtml(searchTerm)}" oninput="filterDeliveries('search', this.value)" class="glass-input w-full md:w-40 pl-9 pr-3 py-2 rounded-lg text-sm">
              </div>
              <select onchange="filterDeliveries('status', this.value)" class="glass-input px-3 py-2 rounded-lg text-sm">
                <option value="all" ${filterStatus === 'all' ? 'selected' : ''}>All Status</option>
                ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${filterStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <select onchange="filterDeliveries('driver', this.value)" class="glass-input px-3 py-2 rounded-lg text-sm">
                <option value="all" ${filterDriver === 'all' ? 'selected' : ''}>All Drivers</option>
                ${deliveryUsers.map(u => `<option value="${u.id}" ${filterDriver === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
              </select>
            </div>
          </div>

          <!-- Delivery Table -->
          <div class="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-slate-50 dark:bg-slate-800/50">
                  <th class="text-left px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Customer</th>
                  <th class="text-left px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Delivery Person</th>
                  <th class="text-right px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Amount</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Status</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Office Handover</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Date</th>
                  <th class="text-center px-4 py-3 font-bold text-slate-600 dark:text-slate-400 uppercase text-xs tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
                ${filteredDeliveries.length === 0 ? `
                  <tr>
                    <td colspan="7" class="px-4 py-12 text-center">
                      <i data-lucide="inbox" class="w-12 h-12 mx-auto text-slate-300 mb-3"></i>
                      <p class="text-slate-500">No deliveries found</p>
                    </td>
                  </tr>
                ` : filteredDeliveries.slice(0, 20).map(ad => {
          const customer = state.customers.find(c => c.id === ad.customerId);
          const deliveryPerson = ad.deliveryPersonId ? deliveryUsers.find(u => u.id === ad.deliveryPersonId) : null;
                  const collectedCash = _getCollectedCashLocal(ad);
                  const receivedInOffice = _isReceivedInOffice(ad);
                  const officeEligible = String(ad.deliveryStatus || '') === 'Delivered' && collectedCash > 0;
                  const debtLocal = Number(ad.debtAmountLocal ?? ad.amountLocal ?? 0) || 0;
                  const debtUSD = Number(ad.debtAmountUSD ?? ad.amountUSD ?? 0) || 0;
                  const statusColors = {
                    'Needs Delivery': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                    'In Progress': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                    'Delivered': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
                    'Canceled': 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                  };
                  const isReceipt = true;
                  return `
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td class="px-4 py-3">
                        <div class="flex items-center space-x-3">
                          <div class="w-9 h-9 rounded-full bg-gradient-to-br ${isReceipt ? 'from-purple-500 to-pink-600' : 'from-indigo-500 to-purple-600'} flex items-center justify-center text-white font-bold text-sm shadow-md">
                            ${isReceipt ? '<i data-lucide="receipt" class="w-4 h-4"></i>' : (customer?.name?.charAt(0) || '?')}
                          </div>
                          <div>
                            <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
                            <div class="text-xs text-slate-500">${Security.escapeHtml(ad.phoneNumber || customer?.phones?.[0] || 'No phone')}</div>
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 font-medium">Receipt</span>
                          </div>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        ${deliveryPerson ? `
                          <div class="flex items-center space-x-2">
                            <div class="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-xs font-bold">
                              ${deliveryPerson.name?.charAt(0) || '?'}
                            </div>
                            <span class="font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(deliveryPerson.name || '')}</span>
                          </div>
                        ` : (canAssign ? `
                          <select onchange="assignDelivery('${ad.id}', this.value)" class="glass-input px-2 py-1 rounded-lg text-xs">
                            <option value="">Assign...</option>
                            ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
                          </select>
                        ` : `<span class="text-xs text-slate-400">Unassigned</span>`)}
                      </td>
                      <td class="px-4 py-3 text-right">
                        <div class="font-bold text-emerald-600">${debtLocal.toLocaleString()} LYD</div>
                        <div class="text-xs text-slate-500">$${debtUSD.toFixed(2)}</div>
                        ${String(ad.deliveryStatus || '') === 'Delivered' ? `
                          <div class="text-[10px] text-slate-500 mt-1">Collected: <span class="font-bold text-slate-700 dark:text-slate-300">${collectedCash.toLocaleString()} LYD</span></div>
                        ` : ''}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <span class="inline-flex px-2.5 py-1 rounded-full text-xs font-bold ${statusColors[ad.deliveryStatus] || 'bg-slate-100 text-slate-700'}">
                          ${ad.deliveryStatus}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-center">
                        ${!officeEligible ? `
                          <span class="text-slate-400 text-xs">—</span>
                        ` : receivedInOffice ? `
                          <div class="inline-flex flex-col items-center gap-1">
                            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                              <i data-lucide="check" class="w-3 h-3 mr-1"></i>Received
                            </span>
                            ${canOffice ? `<button onclick="undoOfficeHandover('${ad.id}')" class="text-[10px] font-bold text-rose-600 hover:text-rose-700">Undo</button>` : ''}
                          </div>
                        ` : `
                          ${canOffice ? `
                            <button onclick="markOfficeHandover('${ad.id}')" class="inline-flex items-center px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 transition-colors">
                              <i data-lucide="hand" class="w-3 h-3 mr-1"></i>Receive
                            </button>
                          ` : `<span class="text-xs text-slate-500">Pending</span>`}
                        `}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <div class="text-xs text-slate-600 dark:text-slate-400">${formatDateShort(ad.createdAt || ad.date)}</div>
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex items-center justify-center space-x-1">
                          <select onchange="updateDeliveryStatus('${ad.id}', this.value)" class="glass-input px-2 py-1 rounded-lg text-xs w-24">
                            ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${ad.deliveryStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
                          </select>
                          <button onclick="showDeliveryDetails('${ad.id}')" class="p-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 transition-colors" title="View Details">
                            <i data-lucide="eye" class="w-4 h-4"></i>
                          </button>
                          ${canAssign && String(ad.deliveryStatus || '') !== 'Delivered' ? `
                            <button onclick="removeDeliveryMission('${ad.id}')" class="p-1.5 rounded-lg bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-900/30 dark:text-rose-300 transition-colors" title="Delete Mission">
                              <i data-lucide="trash-2" class="w-4 h-4"></i>
                            </button>
                          ` : ''}
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          ${filteredDeliveries.length > 20 ? `
            <div class="mt-3 text-center text-sm text-slate-500">
              Showing 20 of ${filteredDeliveries.length} deliveries
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Active Deliveries Grid -->
      <div class="glass-panel rounded-2xl p-5">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center space-x-2">
            <span class="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <i data-lucide="zap" class="w-4 h-4 text-white"></i>
            </span>
            <h2 class="text-lg font-bold text-slate-800 dark:text-white">Active Deliveries</h2>
            <span class="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              ${activeDeliveries.length}
            </span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          ${activeDeliveries.length === 0 ? `
            <div class="col-span-full py-12 text-center">
              <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/20 dark:to-teal-900/20 flex items-center justify-center">
                <i data-lucide="check-circle" class="w-10 h-10 text-emerald-500"></i>
              </div>
              <p class="text-slate-500 font-medium">All caught up!</p>
              <p class="text-sm text-slate-400">No pending deliveries at the moment</p>
            </div>
          ` : activeDeliveries.map(ad => {
            const customer = state.customers.find(c => c.id === ad.customerId);
            const deliveryPerson = ad.deliveryPersonId ? deliveryUsers.find(u => u.id === ad.deliveryPersonId) : null;
            const isUrgent = ad.deliveryStatus === 'Needs Delivery' && !ad.deliveryPersonId;
          
          return `
              <div class="relative overflow-hidden rounded-xl border-2 ${isUrgent ? 'border-rose-300 dark:border-rose-700 bg-gradient-to-br from-rose-50 to-orange-50 dark:from-rose-900/20 dark:to-orange-900/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50'} p-4 transition-all hover:shadow-lg">
                ${isUrgent ? '<div class="absolute top-0 right-0 px-2 py-1 bg-rose-500 text-white text-[10px] font-bold uppercase rounded-bl-lg">Urgent</div>' : ''}
                
                <div class="flex items-start justify-between mb-3">
                  <div class="flex items-center space-x-3">
                    <div class="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-lg">
                      ${customer?.name?.charAt(0) || '?'}
                </div>
                    <div>
                      <h3 class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
                      <p class="text-xs text-slate-500 flex items-center space-x-1">
                        <i data-lucide="phone" class="w-3 h-3"></i>
                        <span>${Security.escapeHtml(ad.phoneNumber || customer?.phones?.[0] || 'No phone')}</span>
                      </p>
                    </div>
                  </div>
                  <span class="px-2 py-1 rounded-lg text-xs font-bold ${ad.deliveryStatus === 'In Progress' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}">
                    ${ad.deliveryStatus}
                  </span>
              </div>

                <div class="grid grid-cols-2 gap-3 mb-3 text-sm">
                  <div class="p-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                    <div class="text-[10px] text-slate-500 uppercase">Amount</div>
                    <div class="font-bold text-emerald-600">${(ad.amountLocal || 0).toLocaleString()} LYD</div>
                  </div>
                  <div class="p-2 rounded-lg bg-slate-50 dark:bg-slate-900/50">
                    <div class="text-[10px] text-slate-500 uppercase">USD Value</div>
                    <div class="font-bold text-slate-700 dark:text-slate-300">$${(ad.amountUSD || 0).toFixed(2)}</div>
                  </div>
              </div>

                ${deliveryPerson ? `
                  <div class="mb-3 p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 flex items-center space-x-2">
                    <div class="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                      ${deliveryPerson.name?.charAt(0)}
                    </div>
                    <span class="text-xs font-medium text-indigo-700 dark:text-indigo-300">${Security.escapeHtml(deliveryPerson.name || '')}</span>
                  </div>
                ` : (canAssign ? `
                  <select onchange="assignDelivery('${ad.id}', this.value)" class="w-full glass-input px-3 py-2 rounded-lg text-sm mb-3">
                    <option value="">⚡ Assign driver...</option>
                    ${deliveryUsers.map(u => `<option value="${u.id}">${Security.escapeHtml(u.name || '')}</option>`).join('')}
                  </select>
                ` : `<div class="mb-3 text-xs text-slate-400">Unassigned</div>`)}

                <div class="flex space-x-2">
                  ${String(ad.deliveryStatus || '') !== 'Delivered' && String(ad.deliveryStatus || '') !== 'Canceled' ? `
                    <button onclick="openDeliveryCancelModal('${ad.id}')" class="flex-1 btn-shine bg-rose-600 text-white px-3 py-2 rounded-lg text-sm font-bold flex items-center justify-center space-x-1">
                      <i data-lucide="x-circle" class="w-4 h-4"></i>
                      <span>Cancel</span>
                    </button>
                  ` : ''}
                  <button onclick="showDeliveryDetails('${ad.id}')" class="btn-shine bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-3 py-2 rounded-lg text-sm">
                    <i data-lucide="more-horizontal" class="w-4 h-4"></i>
                  </button>
                  ${canAssign && String(ad.deliveryStatus || '') !== 'Delivered' ? `
                    <button onclick="removeDeliveryMission('${ad.id}')" class="btn-shine bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 px-3 py-2 rounded-lg text-sm" title="Delete Mission">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  ` : ''}
              </div>
            </div>
          `;
        }).join('')}
        </div>
      </div>
    </div>
  `;
}

// Helper function to render pipeline stages
function renderPipelineStage(label, count, icon, color, index) {
  const colors = {
    slate: 'from-slate-400 to-gray-500',
    amber: 'from-amber-400 to-orange-500',
    blue: 'from-blue-400 to-indigo-500',
    emerald: 'from-emerald-400 to-teal-500',
    rose: 'from-rose-400 to-red-500'
  };
  
  return `
    <div class="flex flex-col items-center">
      <div class="w-14 h-14 rounded-2xl bg-gradient-to-br ${colors[color]} flex items-center justify-center shadow-lg mb-2 animate-pulse-slow" style="animation-delay: ${index * 200}ms">
        <i data-lucide="${icon}" class="w-6 h-6 text-white"></i>
      </div>
      <div class="text-2xl font-black text-slate-800 dark:text-white">${count}</div>
      <div class="text-[10px] text-slate-500 text-center uppercase tracking-wide">${label}</div>
    </div>
  `;
}

// Filter deliveries
function filterDeliveries(type, value) {
  if (!state.deliveryFilter) state.deliveryFilter = {};
  state.deliveryFilter[type] = value;
  render();
  lucide.createIcons();
}

// Refresh deliveries
function refreshDeliveries() {
  showNotification('Refreshing', 'Delivery data updated', 'success');
  render();
  lucide.createIcons();
}

// Export delivery report
function exportDeliveryReport() {
  // Delivery Operations: receipts are the source of truth (ads must not create deliveries).
  const deliveryAds = getVisibleRecords(state.receipts).filter(r => {
    const ds = String(r?.deliveryStatus || '').trim();
    if (ds && ds !== 'Office') return true;
    const sd = (r && typeof r.statusDetail === 'object' && r.statusDetail) ? r.statusDetail : {};
    const npc = String(sd.notPaidCollection || '').trim();
    return String(r?.status || '').trim() === 'Not Paid' && npc === 'delivery';
  }).map(r => ({ ...r, isReceipt: true }));
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
  
  let csv = 'Customer,Phone,Debt LYD,Collected LYD,Remaining Due,Status,Driver,Office Received,Date\n';
  deliveryAds.forEach(r => {
    const customer = state.customers.find(c => c.id === r.customerId);
    const driver = r.deliveryPersonId ? deliveryUsers.find(u => u.id === r.deliveryPersonId) : null;
    const debt = Number(r.debtAmountLocal ?? r.amountLocal ?? 0) || 0;
    const collected = Number(r.amountCollectedFromCustomer ?? (String(r.deliveryStatus || '') === 'Delivered' ? (r.amountLocal || 0) : 0)) || 0;
    const remaining = Number(r.remainingDue ?? Math.max(0, debt - collected)) || 0;
    const received = (typeof r.isReceivedInOffice === 'boolean') ? r.isReceivedInOffice : !!r.officeHandover;
    csv += `"${customer?.name || 'Unknown'}","${r.phoneNumber || customer?.phones?.[0] || ''}",${debt},${collected},${remaining},"${r.deliveryStatus || ''}","${driver?.name || ''}",${received ? 'Yes' : 'No'},"${formatDateShort(r.createdAt || r.date)}"\n`;
  });
  
  // Prepend a UTF-8 BOM so Excel reads Arabic customer/driver names correctly
  // instead of garbling them (mojibake).
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `delivery-report-${getTodayDateString()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showNotification('Export Complete', 'Delivery report downloaded', 'success');
}

// Check for stuck deliveries (In Progress for more than X hours)
async function checkStuckDeliveries() {
  if (!isCurrentUserAdmin() && !currentUserHasPermission('deliveries', 'assign')) {
    showNotification('Access Denied', 'Admin or delivery manager only', 'error');
    return;
  }
  
  const hoursInput = prompt('Find deliveries stuck for more than how many hours? (default: 72 = 3 days)', '72');
  if (!hoursInput) return;
  
  const hours = parseInt(hoursInput);
  if (isNaN(hours) || hours < 1) {
    showNotification('Validation Error', 'Minimum 1 hour required', 'error');
    return;
  }
  
  try {
    const res = await fetch(`/api/deliveries/check-stuck`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session': getSessionToken()
      },
      body: JSON.stringify({ hours_threshold: hours })
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Check failed' }));
      showNotification('Error', err.detail || 'Check failed', 'error');
      return;
    }
    
    const result = await res.json();
    
    if (result.stuck_count === 0) {
      showNotification('All Good!', `No deliveries stuck for more than ${hours} hours`, 'success');
      return;
    }
    
    // Show stuck deliveries in a modal
    const modal = document.getElementById('app-modal') || document.createElement('div');
    modal.id = 'app-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const stuckList = result.stuck_deliveries.map(d => {
      const customer = state.customers.find(c => c.id === d.customerId);
      const driver = state.users.find(u => u.id === d.deliveryPersonId);
      return `
        <div class="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700">
          <div class="flex justify-between items-start mb-2">
            <div>
              <div class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</div>
              <div class="text-xs text-slate-500">Receipt: ${Security.escapeHtml(d.tempReceiptNo || d.finalReceiptNo || d.id)}</div>
            </div>
            <div class="text-right">
              <div class="text-sm font-bold text-amber-700">${d.hoursStuck}h stuck</div>
              <div class="text-xs text-slate-500">${Security.escapeHtml(driver?.name || 'Unassigned')}</div>
            </div>
          </div>
          <div class="flex justify-between text-xs">
            <span class="text-slate-600 dark:text-slate-400">Amount: ${(d.amountLocal || 0).toLocaleString()} LYD</span>
            <button onclick="navigateTo('deliveries'); this.closest('#app-modal').remove();" class="text-indigo-600 hover:text-indigo-700 font-bold">View →</button>
          </div>
        </div>
      `;
    }).join('');
    
    modal.innerHTML = `
      <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center space-x-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <i data-lucide="alert-triangle" class="w-5 h-5 text-white"></i>
            </span>
            <div>
              <div class="text-lg font-bold text-slate-800 dark:text-white">⚠️ Stuck Deliveries</div>
              <div class="text-xs text-slate-500">${result.stuck_count} found (> ${hours} hours)</div>
            </div>
          </div>
          <button onclick="this.closest('#app-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
          </button>
        </div>
        
        <div class="space-y-3 max-h-96 overflow-y-auto">
          ${stuckList}
        </div>
        
        <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700 text-center text-xs text-slate-500">
          <i data-lucide="info" class="w-3 h-3 inline mr-1"></i>
          Consider following up with drivers or canceling stuck deliveries
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    IconQueue.schedule(modal);
  } catch (error) {
    showNotification('Error', 'Check failed: ' + error.message, 'error');
  }
}

function _isReceivedInOffice(item) {
  if (!item) return false;
  if (typeof item.isReceivedInOffice === 'boolean') return item.isReceivedInOffice;
  if (typeof item.officeHandover === 'boolean') return item.officeHandover;
  return false;
}

function _getCollectedCashLocal(item) {
  const v = Number(item?.amountCollectedFromCustomer);
  if (Number.isFinite(v)) return v;
  if (String(item?.deliveryStatus || '') === 'Delivered') {
    const a = Number(item?.amountLocal);
    if (Number.isFinite(a)) return a;
  }
  return 0;
}

function _getOutstandingDueLocal(item) {
  if (!item) return 0;
  const ds = String(item.deliveryStatus || '').trim();
  if (ds === 'Canceled') return 0;
  const rem = Number(item.remainingDue);
  if (Number.isFinite(rem)) return Math.max(0, rem);
  const debt = Number(item.debtAmountLocal);
  if (Number.isFinite(debt)) return Math.max(0, debt - _getCollectedCashLocal(item));
  if (item.isPaid) return 0;
  const amt = Number(item.amountLocal);
  if (Number.isFinite(amt)) return Math.max(0, amt);
  return 0;
}

function setOfficeHandover(itemId, received) {
  const id = String(itemId || '');
  if (!id) return;

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  if (!roleLower) {
    showNotification('Access Denied', 'Please login', 'error');
    return;
  }
  // Office handover is an office/admin action (not a driver action).
  if (roleLower === 'delivery') {
    showNotification('Not Allowed', 'Office handover can only be done by office/admin.', 'warning');
    return;
  }
  if (!currentUserHasPermission('deliveries', 'markCollected') && !isCurrentUserAdmin()) {
    showNotification('Access Denied', 'You do not have permission to mark office handover', 'error');
    return;
  }

  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === id);
  const ad = receipt ? null : state.ads.find(a => a && !a._deleted && String(a.id) === id);
  const item = receipt || ad;
  if (!item) return;

  const next = !!received;
  const nowIso = new Date().toISOString();
  const updates = {
    // Canonical field name (server uses this)
    isReceivedInOffice: next,
    receivedInOfficeAt: next ? nowIso : '',
    // Back-compat (older UI field name)
    officeHandover: next,
    officeHandoverAt: next ? nowIso : ''
  };

  if (receipt) updateRecord(state.receipts, id, updates);
  else updateRecord(state.ads, id, updates);

  addAuditLog('update', id, next ? 'Office handover marked as received' : 'Office handover undone', { isReceipt: !!receipt });
  showNotification('Success', next ? 'Cash received at office' : 'Office handover undone', 'success');
  render();
  if (window.lucide) lucide.createIcons();
}

// Backwards-compatible wrapper (mark as received)
function markOfficeHandover(itemId) {
  setOfficeHandover(itemId, true);
}

function undoOfficeHandover(itemId) {
  setOfficeHandover(itemId, false);
}

// "Delete mission" (remove from delivery tracking) without deleting the receipt itself.
function removeDeliveryMission(itemId) {
  const id = String(itemId || '');
  if (!id) return;

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  if (!roleLower) {
    showNotification('Access Denied', 'Please login', 'error');
    return;
  }
  if (roleLower === 'delivery') {
    showNotification('Not Allowed', 'Drivers cannot delete delivery missions.', 'warning');
    return;
  }
  if (!currentUserHasPermission('deliveries', 'assign') && !isCurrentUserAdmin()) {
    showNotification('Access Denied', 'You do not have permission to remove delivery missions', 'error');
    return;
  }

  const receipt = state.receipts.find(r => r && !r._deleted && String(r.id) === id);
  if (!receipt) {
    showNotification('Error', 'Delivery receipt not found', 'error');
    return;
  }

  const ds = String(receipt.deliveryStatus || '').trim();
  if (ds === 'Delivered') {
    showNotification(
      state.language === 'ar' ? 'غير مسموح' : 'Not Allowed',
      state.language === 'ar'
        ? 'لا يمكن إزالة مهمة تم توصيلها. استخدم تسليم المكتب (تراجع) أو أدرها من شاشة الوصولات.'
        : 'Delivered missions cannot be removed. Use Office Handover (Undo) or manage the receipt from the Receipts screen.',
      'warning'
    );
    return;
  }

  const removeMsg = state.language === 'ar'
    ? 'إزالة مهمة التوصيل هذه؟\n\nسيتم إلغاء تعيين السائق وإزالتها من عمليات التوصيل.\nسيبقى الوصل في شاشة الوصولات.'
    : 'Remove this delivery mission?\n\nThis will unassign the driver and remove it from Delivery Operations.\nThe receipt will remain in Receipts.';
  if (!confirm(removeMsg)) return;

  const nowIso = new Date().toISOString();
  const uid = state.currentUser?.id || '';
  const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
  nextHistory.push({ ts: nowIso, userId: uid, action: 'MISSION_REMOVED' });

  const sd0 = (receipt.statusDetail && typeof receipt.statusDetail === 'object') ? receipt.statusDetail : {};
  const nextStatusDetail = { ...sd0 };
  if (String(receipt.status || '').trim() === 'Not Paid' && String(nextStatusDetail.notPaidCollection || '').trim() === 'delivery') {
    nextStatusDetail.notPaidCollection = 'office';
  }

  updateRecord(state.receipts, id, {
    deliveryStatus: 'Office',
    deliveryPersonId: '',
    acceptedDate: '',
    deliveryCancelReason: '',
    deliveryCancelledAt: '',
    deliveryCancelledBy: '',
    isReceivedInOffice: false,
    receivedInOfficeAt: '',
    officeHandover: false,
    officeHandoverAt: '',
    deliveryHistory: nextHistory,
    statusDetail: nextStatusDetail
  });

  showNotification('Removed', 'Delivery mission removed', 'success');
  render();
  if (window.lucide) lucide.createIcons();
}

// Show delivery details modal
function showDeliveryDetails(itemId) {
  // Check if it's a receipt or an ad
  const isReceipt = state.receipts.find(r => r.id === itemId);
  const ad = isReceipt || state.ads.find(a => a.id === itemId);
  if (!ad) return;
  
  const customer = state.customers.find(c => c.id === ad.customerId);
  const deliveryUsers = getVisibleRecords(state.users).filter(u => isDeliveryRole(u.role));
  const deliveryPerson = ad.deliveryPersonId ? deliveryUsers.find(u => u.id === ad.deliveryPersonId) : null;
  const receivedInOffice = _isReceivedInOffice(ad);
  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  const canOffice = roleLower !== 'delivery' && (currentUserHasPermission('deliveries', 'markCollected') || isCurrentUserAdmin());
  const editHandler = isReceipt ? 'editReceipt' : 'editAd';
  
  const modal = document.getElementById('app-modal') || document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); } };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-lg animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center space-x-2">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <i data-lucide="truck" class="w-5 h-5 text-white"></i>
          </span>
          <span>Delivery Details</span>
        </h2>
        <button onclick="this.closest('#app-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>
      
      <div class="space-y-4">
        <!-- Customer Info -->
        <div class="p-4 rounded-xl bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 border border-indigo-100 dark:border-indigo-800">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
              ${customer?.name?.charAt(0) || '?'}
            </div>
            <div>
              <h3 class="font-bold text-slate-800 dark:text-white">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
              <p class="text-sm text-slate-500 flex items-center space-x-1">
                <i data-lucide="phone" class="w-3 h-3"></i>
                <span>${Security.escapeHtml(ad.phoneNumber || customer?.phones?.[0] || 'No phone')}</span>
              </p>
            </div>
          </div>
        </div>
        
        <!-- Amount Details -->
        <div class="grid grid-cols-2 gap-3">
          <div class="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800">
            <div class="text-xs text-emerald-600 dark:text-emerald-400 font-medium mb-1">Amount (LYD)</div>
            <div class="text-2xl font-black text-emerald-700 dark:text-emerald-300">${(ad.amountLocal || 0).toLocaleString()}</div>
          </div>
          <div class="p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800">
            <div class="text-xs text-blue-600 dark:text-blue-400 font-medium mb-1">Amount (USD)</div>
            <div class="text-2xl font-black text-blue-700 dark:text-blue-300">$${(ad.amountUSD || 0).toFixed(2)}</div>
          </div>
        </div>
        
        <!-- Status & Driver -->
        <div class="grid grid-cols-2 gap-3">
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="text-xs text-slate-500 font-medium mb-2">Status</div>
            <select onchange="updateDeliveryStatus('${ad.id}', this.value); this.closest('#app-modal').remove();" class="w-full glass-input px-3 py-2 rounded-lg text-sm font-medium">
              ${DELIVERY_STATUSES.map(s => `<option value="${s}" ${ad.deliveryStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
            <div class="text-xs text-slate-500 font-medium mb-2">Driver</div>
            <select onchange="assignDelivery('${ad.id}', this.value); this.closest('#app-modal').remove();" class="w-full glass-input px-3 py-2 rounded-lg text-sm font-medium">
              <option value="">Unassigned</option>
              ${deliveryUsers.map(u => `<option value="${u.id}" ${ad.deliveryPersonId === u.id ? 'selected' : ''}>${Security.escapeHtml(u.name || '')}</option>`).join('')}
            </select>
          </div>
        </div>
        
        <!-- Tracking Info -->
        <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-500 font-medium mb-3">Tracking Information</div>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-slate-500">Payment Method:</span>
              <span class="font-medium">${ad.paymentMethod || 'N/A'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Wasil Card:</span>
              <span class="font-mono">${ad.deliveryCardNumber || 'N/A'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Collected:</span>
              <span class="${ad.isPaid ? 'text-emerald-600 font-bold' : 'text-amber-600'}">${ad.isPaid ? 'Yes' : 'No'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Office Handover:</span>
              <span class="${receivedInOffice ? 'text-emerald-600 font-bold' : 'text-amber-600'}">${receivedInOffice ? 'Yes' : 'No'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-500">Created:</span>
              <span>${formatDateShort(ad.createdAt || ad.date)}</span>
            </div>
          </div>
        </div>
        
        <!-- Actions -->
        <div class="flex space-x-3">
          ${!ad.isPaid ? `
            <button onclick="markAsCollected('${ad.id}'); this.closest('#app-modal').remove();" class="flex-1 btn-shine bg-gradient-to-r from-emerald-500 to-teal-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="dollar-sign" class="w-5 h-5"></i>
              <span>Mark Collected</span>
            </button>
          ` : !receivedInOffice ? `
            ${canOffice ? `
              <button onclick="markOfficeHandover('${ad.id}'); this.closest('#app-modal').remove();" class="flex-1 btn-shine bg-gradient-to-r from-purple-500 to-indigo-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
                <i data-lucide="hand" class="w-5 h-5"></i>
                <span>Office Handover</span>
              </button>
            ` : `
              <div class="flex-1 px-4 py-3 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-bold flex items-center justify-center space-x-2">
                <i data-lucide="clock" class="w-5 h-5"></i>
                <span>Pending Office</span>
              </div>
            `}
          ` : `
            <div class="flex-1 px-4 py-3 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-bold flex items-center justify-center space-x-2">
              <i data-lucide="check-circle" class="w-5 h-5"></i>
              <span>Received</span>
            </div>
          `}
          <button onclick="${editHandler}('${ad.id}'); this.closest('#app-modal').remove();" class="btn-shine bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
            <i data-lucide="edit" class="w-5 h-5"></i>
            <span>Edit</span>
          </button>
          ${canOffice && receivedInOffice ? `
            <button onclick="undoOfficeHandover('${ad.id}'); this.closest('#app-modal').remove();" class="btn-shine bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300 px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2">
              <i data-lucide="rotate-ccw" class="w-5 h-5"></i>
              <span>Undo</span>
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function renderDeliveryDashboard() {
  const filterStatus = String(state.deliveryDashboardFilterStatus || 'all');
  const uid = String(state.currentUser?.id || '');
  const receiptDeliveries = getVisibleRecords(state.receipts)
    .filter(r =>
      r &&
      String(r.deliveryPersonId || '') === uid &&
      (String(r.deliveryStatus || '') !== 'Office' || (
        String(r.status || '').trim() === 'Not Paid' &&
        String((r.statusDetail && typeof r.statusDetail === 'object' ? r.statusDetail.notPaidCollection : '') || '').trim() === 'delivery'
      ))
    )
    .map(r => ({
      ...r,
      isReceipt: true,
      deliveryStatus: String(r.deliveryStatus || '').trim() || 'Needs Delivery',
      amountLocal: r.amountLocal || 0,
      amountUSD: r.amountUSD || 0
    }));

  const myDeliveries = [...receiptDeliveries]
    .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0));
  const needsDelivery = myDeliveries.filter(ad => ad.deliveryStatus === 'Needs Delivery');
  const inProgress = myDeliveries.filter(ad => ad.deliveryStatus === 'In Progress');
  const delivered = myDeliveries.filter(ad => ad.deliveryStatus === 'Delivered');
  // Cash held by driver = delivered items that have NOT been handed over to the office yet
  const heldByDriver = delivered.filter(d => !_isReceivedInOffice(d) && _getCollectedCashLocal(d) > 0);
  const cashHeldByDriver = heldByDriver.reduce((sum, ad) => sum + _getCollectedCashLocal(ad), 0);

  let visibleDeliveries = myDeliveries;
  if (filterStatus === 'Needs Delivery') visibleDeliveries = myDeliveries.filter(d => d.deliveryStatus === 'Needs Delivery');
  if (filterStatus === 'In Progress') visibleDeliveries = myDeliveries.filter(d => d.deliveryStatus === 'In Progress');
  if (filterStatus === 'Delivered') visibleDeliveries = myDeliveries.filter(d => d.deliveryStatus === 'Delivered');
  // "Held" filter shows items driver is holding (delivered but not handed to office)
  if (filterStatus === 'Held') visibleDeliveries = heldByDriver;
  
  return `
    <div class="space-y-4 md:space-y-6 animate-fade-in-up px-2 md:px-0 max-w-full overflow-x-hidden">
      <!-- Header with Logout -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 class="text-xl sm:text-2xl md:text-3xl font-bold text-slate-800 dark:text-white">Delivery Dashboard</h1>
          <p class="text-xs sm:text-sm text-slate-500 mt-1">Welcome, ${Security.escapeHtml(state.currentUser?.name || '')}!</p>
        </div>
        <div class="flex items-center gap-2 w-full sm:w-auto">
          <button onclick="refreshDeliveryDashboard()" class="btn-shine bg-blue-600 text-white px-3 py-2 rounded-xl font-bold flex items-center justify-center space-x-1 flex-1 sm:flex-none text-sm" title="Refresh to see latest updates">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
            <span>Refresh</span>
          </button>
          <button onclick="handleLogout()" class="btn-shine bg-rose-600 text-white px-3 py-2 rounded-xl font-bold flex items-center justify-center space-x-1 flex-1 sm:flex-none text-sm">
            <i data-lucide="log-out" class="w-4 h-4"></i>
            <span>Logout</span>
          </button>
        </div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-2 gap-2 md:gap-4 md:grid-cols-4">
        ${renderStatCard('Needs Delivery', needsDelivery.length, 'clock', 'from-amber-500 to-orange-600', "setDeliveryDashboardFilter('Needs Delivery')", filterStatus === 'Needs Delivery')}
        ${renderStatCard('In Progress', inProgress.length, 'truck', 'from-blue-500 to-cyan-600', "setDeliveryDashboardFilter('In Progress')", filterStatus === 'In Progress')}
        ${renderStatCard('Delivered', delivered.length, 'check-circle', 'from-emerald-500 to-teal-600', "setDeliveryDashboardFilter('Delivered')", filterStatus === 'Delivered')}
        ${renderStatCard('Held', `${heldByDriver.length} (${cashHeldByDriver.toFixed(0)} LYD)`, 'wallet', 'from-purple-500 to-pink-600', "setDeliveryDashboardFilter('Held')", filterStatus === 'Held')}
      </div>

      <!-- My Deliveries -->
      <div class="glass-panel rounded-2xl p-3 md:p-6">
        <div class="flex items-center justify-between mb-3 md:mb-4">
          <h2 class="text-lg md:text-xl font-bold">My Deliveries ${filterStatus !== 'all' ? `<span class="ml-1 md:ml-2 text-xs md:text-sm font-bold text-indigo-600">(${Security.escapeHtml(filterStatus)})</span>` : ''}</h2>
          ${filterStatus !== 'all' ? `
            <button type="button" onclick="setDeliveryDashboardFilter('all')" class="text-xs font-bold text-slate-600 hover:text-slate-800">Show All</button>
          ` : ''}
        </div>
        ${visibleDeliveries.length === 0 ? '<p class="text-center text-slate-500 py-8">No deliveries for this filter</p>' : `
          <div class="space-y-3 w-full">
            ${visibleDeliveries.map(ad => {
              const customer = state.customers.find(c => c.id === ad.customerId);
              const phone = String(ad.phoneNumber || customer?.phones?.[0] || '').trim();
              const wa = phone ? buildWhatsAppLink(phone) : '';
              const displayFinalNo = ad.finalReceiptNo || ad.serialNumber || '';
              const displayTempNo = ad.tempReceiptNo || '';
              return `
                <div class="glass-panel rounded-xl p-3 md:p-4 w-full box-border">
                  <div class="flex flex-col gap-3 md:gap-4">
                    <div class="w-full min-w-0">
                      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                        <h3 class="font-bold text-base md:text-lg truncate">${Security.escapeHtml(customer?.name || 'Unknown')}</h3>
                        ${phone ? `
                          <div class="flex items-center gap-2 flex-shrink-0">
                            <a href="tel:${encodeURIComponent(phone)}" class="text-xs font-bold text-blue-600 hover:text-blue-700 px-2 py-1 bg-blue-50 rounded-lg">Call</a>
                            ${wa ? `<a href="${wa}" target="_blank" rel="noopener noreferrer" class="text-xs font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 bg-emerald-50 rounded-lg">WhatsApp</a>` : ''}
                            <button type="button" data-phone="${Security.escapeHtml(phone)}" onclick='copyTextToClipboard(this.dataset.phone).then(ok => showNotification(ok ? "Copied" : "Copy Failed", ok ? "Phone number copied" : "Could not copy phone number", ok ? "success" : "error"))' class="text-xs font-bold text-slate-600 hover:text-slate-700 px-2 py-1 bg-slate-100 rounded-lg">Copy</button>
                          </div>
                        ` : ''}
                      </div>
                      <p class="text-xs md:text-sm text-slate-500 mt-1">${Security.escapeHtml(phone || 'No phone')}</p>
                      ${ad.isReceipt && (displayTempNo || displayFinalNo) ? `
                        <div class="text-xs text-indigo-600 font-bold mt-1">
                          Receipt: ${displayTempNo && displayFinalNo ? `${displayTempNo} → ${displayFinalNo}` : (displayTempNo ? `${displayTempNo} (Temp)` : displayFinalNo)}
                        </div>
                      ` : ''}
                      ${ad.isReceipt && ad.deliveryPlaceName ? `
                        <div class="text-xs text-slate-600 dark:text-slate-300 mt-1">
                          <span class="font-bold">📍</span> ${Security.escapeHtml(String(ad.deliveryPlaceName || ''))}
                        </div>
                      ` : ''}
                      ${ad.isReceipt && (ad.quotedDeliveryFee !== undefined && ad.quotedDeliveryFee !== null) ? `
                        <div class="text-[11px] text-slate-500 mt-0.5">
                          Quoted fee: <span class="font-bold text-emerald-600">${Number(ad.quotedDeliveryFee || 0).toFixed(0)} LYD</span>
                        </div>
                      ` : ''}
                      ${ad.isReceipt && ad.deliveryInstructions ? `
                        <div class="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 rounded-lg p-2 mt-1 border border-amber-200 dark:border-amber-800">
                          <span class="font-bold">📝 Instructions:</span> ${Security.escapeHtml(String(ad.deliveryInstructions || ''))}
                        </div>
                      ` : ''}
                      <div class="flex flex-wrap items-center gap-1.5 md:gap-2 mt-2">
                        <span class="text-xs font-bold text-emerald-600">$${Number(ad.amountUSD || 0).toFixed(2)} (${Number(ad.amountLocal || 0).toFixed(0)} LYD)</span>
                        <span class="payment-badge text-[10px] md:text-xs">${Security.escapeHtml(ad.paymentMethod || '')}</span>
                        <span class="delivery-${(ad.deliveryStatus || '').toLowerCase().replace(' ', '')} px-2 py-0.5 md:py-1 rounded-full text-[10px] md:text-xs font-bold">${Security.escapeHtml(ad.deliveryStatus || '')}</span>
                        ${ad.editCount ? `<button onclick="showReceiptEditHistory('${ad.id}')" class="text-[10px] px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-full hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors font-medium flex items-center gap-1"><i data-lucide="history" class="w-3 h-3"></i>${ad.editCount}</button>` : ''}
                      </div>
                    </div>
                    <div class="flex flex-row md:flex-col gap-2 w-full md:w-auto">
                      ${ad.deliveryStatus === 'Needs Delivery' ? `
                        <button onclick="acceptDelivery('${ad.id}')" class="btn-shine bg-blue-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="check" class="w-4 h-4 mr-1"></i>Accept
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'In Progress' && ad.isReceipt ? `
                        <button onclick="openReceiptDeliveryCompletionModal('${ad.id}')" class="btn-shine bg-emerald-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="check-circle" class="w-4 h-4 mr-1"></i>Delivered
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'In Progress' && !ad.isReceipt && !ad.isPaid ? `
                        <button onclick="markAsCollected('${ad.id}')" class="btn-shine bg-emerald-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="dollar-sign" class="w-4 h-4 mr-1"></i>Collected
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'In Progress' && !ad.isReceipt && ad.isPaid ? `
                        <button onclick="markAsDelivered('${ad.id}')" class="btn-shine bg-emerald-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="check-circle" class="w-4 h-4 mr-1"></i>Delivered
                        </button>
                        <button onclick="openDeliveryCancelModal('${ad.id}')" class="btn-shine bg-rose-600 text-white px-3 md:px-4 py-2 rounded-lg font-bold text-sm flex-1 md:flex-none flex items-center justify-center">
                          <i data-lucide="x-circle" class="w-4 h-4 mr-1"></i>Cancel
                        </button>
                      ` : ''}
                      ${ad.deliveryStatus === 'Delivered' ? `
                        <div class="text-emerald-600 font-bold text-sm flex items-center justify-center py-2">
                          <i data-lucide="check-circle" class="w-4 h-4 mr-1"></i>Complete
                        </div>
                      ` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

function setDeliveryDashboardFilter(status) {
  const next = String(status || 'all');
  // Don't toggle back to 'all' on double-click - stay on selected filter
  state.deliveryDashboardFilterStatus = next;
  render();
  if (window.lucide) lucide.createIcons();
}

// Manual refresh button for delivery dashboard - forces immediate sync from server
async function refreshDeliveryDashboard() {
  if (!isServerModeEnabled()) {
    render();
    showNotification('Refreshed', 'Dashboard refreshed', 'success');
    return;
  }

  updateSyncIndicator('syncing');
  showNotification('Syncing', 'Fetching latest data...', 'info');

  try {
    // Clear cache to force fresh data
    _collectionCache.receipts = { data: null, timestamp: 0 };
    _collectionCache.customers = { data: null, timestamp: 0 };

    // Force immediate sync from server
    const [receipts, customers] = await Promise.all([
      apiLoadCollectionAll('receipts'),
      apiLoadCollectionAll('customers')
    ]);

    if (Array.isArray(receipts)) state.receipts = receipts;
    if (Array.isArray(customers)) state.customers = customers;

    markCollectionDirty('receipts');
    markCollectionDirty('customers');
    saveState();

    render();
    if (window.lucide) lucide.createIcons();
    updateSyncIndicator('synced');
    showNotification('Refreshed', 'Dashboard updated with latest data', 'success');
  } catch (e) {
    console.error('Failed to refresh delivery dashboard:', e);
    updateSyncIndicator('error');
    showNotification('Refresh Failed', 'Could not fetch latest data. Please try again.', 'error');
    // Still render with current data
    render();
  }
}

function _findAdForDeliveryModal(adId) {
  const aid = String(adId || '');
  const ad = state.ads.find(a => a && !a._deleted && String(a.id) === aid);
  return ad || null;
}

function openDeliveryCancelModal(itemId) {
  const rid = String(itemId || '');
  const receipt = _findReceiptForDeliveryModal(rid);
  const ad = receipt ? null : _findAdForDeliveryModal(rid);
  const item = receipt || ad;
  const itemType = receipt ? 'receipt' : 'ad';

  if (!item) {
    showNotification('Error', 'Delivery not found', 'error');
    return;
  }

  const roleLower = String(state.currentUser?.role || '').toLowerCase();
  if (roleLower === 'delivery') {
    if (String(item.deliveryPersonId || '') !== String(state.currentUser?.id || '')) {
      showNotification('Access Denied', 'This delivery is not assigned to you', 'error');
      return;
    }
  } else if (!roleLower) {
    showNotification('Access Denied', 'Please login', 'error');
    return;
  }

  if (String(item.deliveryStatus || '') === 'Delivered') {
    showNotification('Not Allowed', 'Already delivered.', 'warning');
    return;
  }

  const customer = state.customers.find(c => c && !c._deleted && String(c.id) === String(item.customerId || ''));
  const phone = String(item.phoneNumber || customer?.phones?.[0] || '').trim();
  const ref = receipt
    ? String(receipt.tempReceiptNo || receipt.finalReceiptNo || receipt.serialNumber || receipt.id)
    : String(ad?.id || '');

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
            <div class="text-xs text-slate-500">
              ${Security.escapeHtml(customer?.name || 'Unknown')}
              ${ref ? ` • ${itemType === 'receipt' ? 'Receipt' : 'Delivery'} ${Security.escapeHtml(ref)}` : ''}
              ${phone ? ` • ${Security.escapeHtml(phone)}` : ''}
            </div>
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
          <button type="button" onclick='submitDeliveryCancel(${JSON.stringify(itemType)}, ${JSON.stringify(String(item.id || ""))})' class="flex-1 btn-shine bg-rose-600 text-white px-4 py-2.5 rounded-lg text-sm font-bold">
            Confirm Cancel
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function submitDeliveryCancel(itemType, itemId) {
  const type = String(itemType || '');
  const id = String(itemId || '');
  const reason = String(document.getElementById('delivery-cancel-reason')?.value || '').trim();
  if (!reason) {
    showNotification('Validation', 'Cancel reason is required.', 'error');
    return;
  }

  const nowIso = new Date().toISOString();
  const uid = state.currentUser?.id || '';

  if (type === 'receipt') {
    const receipt = _findReceiptForDeliveryModal(id);
    if (!receipt) return;
    const nextHistory = Array.isArray(receipt.deliveryHistory) ? [...receipt.deliveryHistory] : [];
    nextHistory.push({ ts: nowIso, userId: uid, action: 'CANCELLED_BY_DRIVER', reason });
    updateRecord(state.receipts, receipt.id, {
      deliveryStatus: 'Canceled',
      deliveryCancelReason: reason,
      deliveryCancelledAt: nowIso,
      deliveryCancelledBy: uid,
      deliveryHistory: nextHistory
    });
  } else {
    const ad = _findAdForDeliveryModal(id);
    if (!ad) return;
    const nextHistory = Array.isArray(ad.deliveryHistory) ? [...ad.deliveryHistory] : [];
    nextHistory.push({ ts: nowIso, userId: uid, action: 'CANCELLED_BY_DRIVER', reason });
    updateRecord(state.ads, ad.id, {
      deliveryStatus: 'Canceled',
      deliveryCancelReason: reason,
      deliveryCancelledAt: nowIso,
      deliveryCancelledBy: uid,
      deliveryHistory: nextHistory
    });
  }

  document.getElementById('delivery-cancel-modal')?.remove();
  document.getElementById('delivery-complete-modal')?.remove();
  showNotification('Canceled', 'Delivery canceled', 'success');
  render();
}

function renderReconciliationView() {
  const visibleAds = getVisibleRecords(state.ads).filter(ad => ad.spentUSD);
  return `
    <div class="space-y-6">
      <h1 class="text-3xl font-bold">${t('jobReconciliation')}</h1>
      <div class="glass-panel rounded-2xl p-6">
        ${visibleAds.length === 0 ? '<p class="text-center text-slate-500 py-8">No reconciliation data</p>' : `
          <div class="space-y-3">
            ${visibleAds.map(ad => {
              const customer = state.customers.find(c => c.id === ad.customerId);
              const diff = (ad.spentUSD || 0) - (ad.amountUSD || 0);
              const reconClass = diff === 0 ? 'recon-match' : diff > 0 ? 'recon-overspent' : 'recon-underspent';
              return `<div class="${reconClass} p-4 rounded-lg">
                <div class="flex justify-between items-center">
                  <div>
                    <span class="font-medium">${Security.escapeHtml(customer?.name || 'Unknown')}</span>
                    <p class="text-sm">Collected: $${ad.amountUSD} | Spent: $${ad.spentUSD} | Diff: $${diff.toFixed(2)}</p>
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

function renderUsersView() {
  const visibleUsers = getVisibleRecords(state.users);
  const isAdmin = isCurrentUserAdmin();
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('users')}</h1>
          <p class="text-sm text-slate-500 mt-1">${visibleUsers.length} system users</p>
        </div>
        ${isAdmin ? `
        <button onclick="showUserModal()" class="btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold flex items-center space-x-2">
          <i data-lucide="user-plus" class="w-4 h-4"></i>
          <span>${t('addUser')}</span>
        </button>
        ` : ''}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${visibleUsers.map(u => {
          const userAds = getVisibleRecords(state.ads).filter(ad => ad.creatorId === u.id);
          const deliveredAds = getVisibleRecords(state.ads).filter(ad => ad.deliveryPersonId === u.id && ad.isPaid);
          const deliveredReceipts = getVisibleRecords(state.receipts).filter(r => r.deliveryPersonId === u.id && r.deliveryStatus === 'Delivered');
          const deliveryFeesLYD = deliveredReceipts.reduce((sum, r) => sum + (Number(r.deliveryFeeCollected ?? r.actualDeliveryFeeCollected ?? 0) || 0), 0);
          
          return `
            <div class="glass-panel rounded-xl p-5 hover:scale-[1.02] transition-transform">
              <div class="flex items-start justify-between mb-4">
                <div class="flex items-center space-x-3 flex-1">
                  <div class="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold text-xl shadow-lg">
                    ${u.name.charAt(0)}
                  </div>
                  <div class="flex-1">
                    <h3 class="font-bold text-lg text-slate-800 dark:text-white">${Security.escapeHtml(u.name || '')}</h3>
                    <div class="flex items-center space-x-2 mt-1">
                      <span class="text-xs px-2 py-1 ${isAdminRole(u.role) ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' : isDeliveryRole(u.role) ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'} rounded-full font-medium">${u.role}</span>
                      ${u.id === state.currentUser?.id ? '<span class="text-xs text-indigo-600 font-medium">(You)</span>' : ''}
                    </div>
                  </div>
                </div>
                <div class="flex space-x-1">
                  ${isAdmin && u.id !== state.currentUser?.id && !isAdminRole(u.role) ? `
                    <button onclick="showPermissionsModal('${u.id}')" class="text-purple-600 hover:text-purple-700 p-1" title="Manage Permissions">
                      <i data-lucide="shield" class="w-4 h-4"></i>
                    </button>
                  ` : ''}
                  ${isAdmin || u.id === state.currentUser?.id ? `
                  <button onclick="editUser('${u.id}')" class="text-blue-600 hover:text-blue-700 p-1" title="${u.id === state.currentUser?.id ? 'Edit Your Profile' : 'Edit'}">
                    <i data-lucide="edit" class="w-4 h-4"></i>
                  </button>
                  ` : ''}
                  ${isAdmin && u.id !== state.currentUser?.id ? `
                    <button onclick="deleteUser('${u.id}')" class="text-rose-600 hover:text-rose-700 p-1" title="Delete">
                      <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                  ` : ''}
                </div>
              </div>

              <div class="space-y-2 text-sm border-t border-slate-200 dark:border-slate-700 pt-3">
                <div class="flex items-center space-x-2 text-slate-600 dark:text-slate-400">
                  <i data-lucide="mail" class="w-4 h-4 text-slate-400"></i>
                  <span class="truncate">${Security.escapeHtml(u.email || '')}</span>
                </div>

                ${isDeliveryRole(u.role) && u.stats ? `
                  <div class="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg space-y-1">
                    <div class="text-xs font-bold text-blue-700 dark:text-blue-300 uppercase mb-2">Delivery Stats</div>
                    <div class="flex justify-between text-xs"><span>Total Assigned:</span><span class="font-bold">${u.stats.totalAds || 0}</span></div>
                    <div class="flex justify-between text-xs"><span>Accepted:</span><span class="font-bold text-blue-600">${u.stats.accepted || 0}</span></div>
                    <div class="flex justify-between text-xs"><span>Collected:</span><span class="font-bold text-emerald-600">${u.stats.collected || 0}</span></div>
                    <div class="flex justify-between text-xs"><span>Fees Earned:</span><span class="font-bold text-purple-600">${deliveryFeesLYD.toFixed(0)} LYD</span></div>
                  </div>
                ` : ''}

                ${userAds.length > 0 ? `
                  <div class="flex items-center space-x-2 text-xs text-slate-500 mt-2">
                    <i data-lucide="megaphone" class="w-3 h-3"></i>
                    <span>Created ${userAds.length} ads</span>
                  </div>
                ` : ''}

                ${deliveredAds.length > 0 ? `
                  <div class="flex items-center space-x-2 text-xs text-emerald-600 mt-2">
                    <i data-lucide="truck" class="w-3 h-3"></i>
                    <span>Delivered ${deliveredAds.length} ads</span>
                  </div>
                ` : ''}
                
                <!-- Permission Summary -->
                ${!isAdminRole(u.role) ? (() => {
                  const permSummary = getPermissionSummary(u.permissions || {});
                  return `
                    <div class="mt-3 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                      <div class="flex items-center justify-between mb-2">
                        <div class="flex items-center space-x-1">
                          <i data-lucide="shield" class="w-3 h-3 text-purple-600"></i>
                          <span class="text-[10px] font-bold text-purple-700 dark:text-purple-300 uppercase">Permissions</span>
                        </div>
                        <span class="text-xs font-bold ${permSummary.percentage > 50 ? 'text-emerald-600' : 'text-purple-600'}">${permSummary.granted}/${permSummary.total}</span>
                      </div>
                      <div class="w-full h-1.5 bg-purple-200 dark:bg-purple-800 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full transition-all" style="width: ${permSummary.percentage}%"></div>
                      </div>
                      ${isAdmin ? `
                      <button onclick="showPermissionsModal('${u.id}')" class="mt-2 w-full text-xs text-purple-600 hover:text-purple-700 font-medium flex items-center justify-center space-x-1">
                        <i data-lucide="settings" class="w-3 h-3"></i>
                        <span>Manage Access</span>
                      </button>
                      ` : `
                        <div class="mt-2 text-[11px] text-slate-500 text-center">
                          ${state.language === 'ar' ? 'التعديل للأدمن فقط' : 'Admin only'}
                        </div>
                      `}
                    </div>
                  `;
                })() : `
                  <div class="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg text-center">
                    <div class="flex items-center justify-center space-x-1 text-amber-700 dark:text-amber-300">
                      <i data-lucide="crown" class="w-4 h-4"></i>
                      <span class="text-xs font-bold">Full Admin Access</span>
                    </div>
                  </div>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderAuditView() {
  const allLogs = getVisibleRecords(state.logs);
  
  // Apply filters
  let filteredLogs = allLogs.filter(log => {
    // Search filter
    if (state.auditSearch) {
      const search = state.auditSearch.toLowerCase();
      const matchesSearch = 
        (log.description || '').toLowerCase().includes(search) ||
        (log.userName || '').toLowerCase().includes(search) ||
        (log.action || '').toLowerCase().includes(search) ||
        (log.resourceId || '').toLowerCase().includes(search);
      if (!matchesSearch) return false;
    }
    
    // Action filter
    if (state.auditActionFilter !== 'all' && log.action !== state.auditActionFilter) return false;
    
    // Category filter
    if (state.auditCategoryFilter !== 'all' && log.category !== state.auditCategoryFilter) return false;
    
    // Severity filter
    if (state.auditSeverityFilter !== 'all' && log.severity !== state.auditSeverityFilter) return false;
    
    // User filter
    if (state.auditUserFilter !== 'all' && log.userId !== state.auditUserFilter) return false;
    
    // Date range filter
    if (state.auditDateFrom) {
      const logDate = new Date(log.date);
      const fromDate = new Date(state.auditDateFrom);
      if (logDate < fromDate) return false;
    }
    if (state.auditDateTo) {
      const logDate = new Date(log.date);
      const toDate = new Date(state.auditDateTo);
      toDate.setHours(23, 59, 59, 999);
      if (logDate > toDate) return false;
    }
    
    return true;
  });
  
  // Sort by date (newest first)
  filteredLogs.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Pagination
  const totalLogs = filteredLogs.length;
  const totalPages = Math.ceil(totalLogs / state.auditPageSize);
  const currentPage = Math.min(state.auditPage, totalPages) || 1;
  const startIndex = (currentPage - 1) * state.auditPageSize;
  const paginatedLogs = filteredLogs.slice(startIndex, startIndex + state.auditPageSize);
  
  // Get unique values for filters
  const uniqueActions = [...new Set(allLogs.map(l => l.action).filter(Boolean))];
  const uniqueCategories = [...new Set(allLogs.map(l => l.category || 'general').filter(Boolean))];
  const uniqueUsers = [...new Set(allLogs.map(l => l.userId).filter(Boolean))];
  
  const hasActiveFilters = state.auditSearch || state.auditActionFilter !== 'all' || 
    state.auditCategoryFilter !== 'all' || state.auditSeverityFilter !== 'all' || 
    state.auditUserFilter !== 'all' || state.auditDateFrom || state.auditDateTo;
  
  // Severity badge colors
  const severityColors = {
    'info': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    'warning': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    'error': 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    'critical': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  };
  
  // Category icons
  const categoryIcons = {
    'auth': 'shield',
    'data': 'database',
    'financial': 'dollar-sign',
    'general': 'file-text'
  };
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <!-- Header -->
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-bold bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 bg-clip-text text-transparent flex items-center space-x-3">
            <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
              <i data-lucide="file-clock" class="w-5 h-5 text-white"></i>
            </span>
            <span>${t('auditLogs')}</span>
          </h1>
          <p class="text-sm text-slate-500 mt-1">${totalLogs.toLocaleString()} total entries ${hasActiveFilters ? `(filtered from ${allLogs.length.toLocaleString()})` : ''}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button onclick="backupAuditLogs()" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border-2 border-emerald-200 dark:border-emerald-800 transition-all" title="Create full backup of all logs">
            <i data-lucide="archive" class="w-4 h-4 text-emerald-600"></i>
            <span class="text-emerald-700 dark:text-emerald-400">Backup</span>
          </button>
          <button onclick="restoreAuditLogs()" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-800 transition-all" title="Restore logs from backup file">
            <i data-lucide="upload" class="w-4 h-4 text-blue-600"></i>
            <span class="text-blue-700 dark:text-blue-400">Restore</span>
          </button>
          <button onclick="cleanupAuditLogs()" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-rose-50 dark:hover:bg-rose-900/20 border-2 border-rose-200 dark:border-rose-800 transition-all" title="Delete old audit logs (keeps last 1 year)">
            <i data-lucide="trash-2" class="w-4 h-4 text-rose-600"></i>
            <span class="text-rose-700 dark:text-rose-400">Cleanup</span>
          </button>
          <div class="w-px h-6 bg-slate-300 dark:bg-slate-600"></div>
          <button onclick="exportAuditLogs('csv')" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
            <i data-lucide="download" class="w-4 h-4"></i>
            <span>CSV</span>
          </button>
          <button onclick="exportAuditLogs('json')" class="glass-panel px-3 py-2 rounded-xl text-xs font-medium flex items-center space-x-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">
            <i data-lucide="file-json" class="w-4 h-4"></i>
            <span>JSON</span>
          </button>
        </div>
      </div>
      
      <!-- Storage Status Banner -->
      <div class="glass-panel rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 border border-indigo-200 dark:border-indigo-800">
        <div class="flex items-center space-x-3">
          <div class="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-800 flex items-center justify-center">
            <i data-lucide="database" class="w-4 h-4 text-indigo-600 dark:text-indigo-300"></i>
          </div>
          <div>
            <div class="text-xs font-bold text-indigo-700 dark:text-indigo-300">Persistent Storage Enabled</div>
            <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">${db ? 'IndexedDB Active - Logs stored permanently' : 'LocalStorage Only - Consider backing up'}</div>
          </div>
        </div>
        <div class="flex items-center space-x-4 text-xs">
          <div class="text-center">
            <div class="font-bold text-indigo-700 dark:text-indigo-300">${allLogs.length.toLocaleString()}</div>
            <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">Total Logs</div>
          </div>
          <div class="text-center">
            <div class="font-bold text-indigo-700 dark:text-indigo-300">${db ? '∞' : Math.min(allLogs.length, MAX_LOGS_IN_LOCALSTORAGE || 500)}</div>
            <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">In Storage</div>
          </div>
          <div class="w-2 h-2 rounded-full ${db ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}"></div>
        </div>
      </div>

      <!-- Stats Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <i data-lucide="activity" class="w-5 h-5 text-blue-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Total Logs</div>
        </div>
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
            <i data-lucide="plus-circle" class="w-5 h-5 text-emerald-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.filter(l => l.action === 'create').length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Creates</div>
        </div>
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <i data-lucide="edit-3" class="w-5 h-5 text-amber-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.filter(l => l.action === 'update').length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Updates</div>
        </div>
        <div class="glass-panel rounded-xl p-4 text-center">
          <div class="w-10 h-10 mx-auto mb-2 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
            <i data-lucide="trash-2" class="w-5 h-5 text-rose-600"></i>
          </div>
          <div class="text-2xl font-bold text-slate-800 dark:text-white">${allLogs.filter(l => l.action === 'delete' || l.action === 'Delete').length.toLocaleString()}</div>
          <div class="text-xs text-slate-500">Deletes</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="glass-panel rounded-2xl p-4">
        <div class="flex flex-col lg:flex-row gap-4">
          <!-- Search -->
          <div class="flex-1 relative">
            <i data-lucide="search" class="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
            <input 
              type="text" 
              placeholder="Search logs by description, user, action..." 
              value="${Security.escapeHtml(state.auditSearch || '')}"
              oninput="updateAuditFilter('search', this.value)"
              class="w-full pl-12 pr-4 py-3 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20 transition-all"
            />
            ${state.auditSearch ? `<button onclick="updateAuditFilter('search', '')" class="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full"><i data-lucide="x" class="w-4 h-4 text-slate-400"></i></button>` : ''}
          </div>
          
          <!-- Filter Dropdowns -->
          <div class="flex flex-wrap gap-2">
            <select onchange="updateAuditFilter('action', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditActionFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Actions</option>
              ${uniqueActions.map(a => `<option value="${Security.escapeHtml(a)}" ${state.auditActionFilter === a ? 'selected' : ''}>${Security.escapeHtml(a)}</option>`).join('')}
            </select>
            
            <select onchange="updateAuditFilter('category', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditCategoryFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Categories</option>
              <option value="auth" ${state.auditCategoryFilter === 'auth' ? 'selected' : ''}>🔐 Auth</option>
              <option value="data" ${state.auditCategoryFilter === 'data' ? 'selected' : ''}>💾 Data</option>
              <option value="financial" ${state.auditCategoryFilter === 'financial' ? 'selected' : ''}>💰 Financial</option>
              <option value="general" ${state.auditCategoryFilter === 'general' ? 'selected' : ''}>📄 General</option>
            </select>
            
            <select onchange="updateAuditFilter('severity', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditSeverityFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Severity</option>
              <option value="info" ${state.auditSeverityFilter === 'info' ? 'selected' : ''}>ℹ️ Info</option>
              <option value="warning" ${state.auditSeverityFilter === 'warning' ? 'selected' : ''}>⚠️ Warning</option>
              <option value="error" ${state.auditSeverityFilter === 'error' ? 'selected' : ''}>❌ Error</option>
              <option value="critical" ${state.auditSeverityFilter === 'critical' ? 'selected' : ''}>🚨 Critical</option>
            </select>
            
            <select onchange="updateAuditFilter('user', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditUserFilter !== 'all' ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}">
              <option value="all">All Users</option>
              ${uniqueUsers.map(userId => {
                const user = state.users.find(u => u.id === userId);
                return `<option value="${Security.escapeHtml(userId)}" ${state.auditUserFilter === userId ? 'selected' : ''}>${Security.escapeHtml(user?.name || userId)}</option>`;
              }).join('')}
            </select>
            
            <input type="date" value="${Security.escapeHtml(state.auditDateFrom || '')}" onchange="updateAuditFilter('dateFrom', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditDateFrom ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}" title="From Date" />
            
            <input type="date" value="${Security.escapeHtml(state.auditDateTo || '')}" onchange="updateAuditFilter('dateTo', this.value)" class="px-3 py-2 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium ${state.auditDateTo ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : ''}" title="To Date" />
            
            ${hasActiveFilters ? `
              <button onclick="clearAuditFilters()" class="px-3 py-2 bg-rose-100 dark:bg-rose-900/30 text-rose-600 border-2 border-rose-200 dark:border-rose-800 rounded-xl text-xs font-bold hover:bg-rose-200 transition-all flex items-center space-x-1">
                <i data-lucide="x-circle" class="w-3 h-3"></i>
                <span>Clear</span>
              </button>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- Logs Table -->
      <div class="glass-panel rounded-2xl overflow-hidden">
        ${paginatedLogs.length === 0 ? `
          <div class="p-12 text-center">
            <i data-lucide="${hasActiveFilters ? 'search-x' : 'file-clock'}" class="w-16 h-16 mx-auto text-slate-300 mb-4"></i>
            <p class="text-slate-500 font-medium">${hasActiveFilters ? 'No logs match your filters' : 'No activity logs yet'}</p>
            ${hasActiveFilters ? '<button onclick="clearAuditFilters()" class="mt-4 text-purple-600 hover:text-purple-700 font-medium">Clear all filters</button>' : ''}
          </div>
        ` : `
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Timestamp</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">User</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Action</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Category</th>
                  <th class="text-left px-4 py-3 text-xs font-bold text-slate-500 uppercase">Description</th>
                  <th class="text-center px-4 py-3 text-xs font-bold text-slate-500 uppercase">Severity</th>
                  <th class="text-center px-4 py-3 text-xs font-bold text-slate-500 uppercase">Details</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                ${paginatedLogs.map(log => {
                  const user = state.users.find(u => u.id === log.userId);
                  const severity = log.severity || 'info';
                  const category = log.category || 'general';
                  return `
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td class="px-4 py-3">
                        <div class="text-xs font-medium text-slate-700 dark:text-slate-300">${new Date(log.date).toLocaleDateString()}</div>
                        <div class="text-[10px] text-slate-500">${new Date(log.date).toLocaleTimeString()}</div>
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex items-center space-x-2">
                          <div class="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                            ${(log.userName || user?.name || 'S').charAt(0).toUpperCase()}
                          </div>
                          <span class="text-xs font-medium text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.userName || user?.name || 'System')}</span>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        <span class="inline-flex px-2 py-1 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                          ${Security.escapeHtml(log.action)}
                        </span>
                      </td>
                      <td class="px-4 py-3">
                        <span class="inline-flex items-center space-x-1 text-xs text-slate-600 dark:text-slate-400">
                          <i data-lucide="${categoryIcons[category] || 'file-text'}" class="w-3 h-3"></i>
                          <span class="capitalize">${Security.escapeHtml(category)}</span>
                        </span>
                      </td>
                      <td class="px-4 py-3 max-w-md">
                        <p class="text-xs text-slate-600 dark:text-slate-400 truncate" title="${Security.escapeHtml(log.description || '')}">${Security.escapeHtml(log.description || '')}</p>
                        ${log.resourceId ? `<p class="text-[10px] text-slate-400 mt-0.5">ID: ${log.resourceId.substring(0, 12)}...</p>` : ''}
                      </td>
                      <td class="px-4 py-3 text-center">
                        <span class="inline-flex px-2 py-1 rounded-full text-[10px] font-bold uppercase ${severityColors[severity] || severityColors['info']}">
                          ${severity}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-center">
                        <button onclick="showLogDetails('${log.id}')" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors" title="View Details">
                          <i data-lucide="eye" class="w-4 h-4 text-slate-600 dark:text-slate-400"></i>
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
          
          <!-- Pagination -->
          <div class="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex flex-col md:flex-row items-center justify-between gap-3">
            <div class="flex items-center space-x-2 text-xs text-slate-500">
              <span>Show</span>
              <select onchange="updateAuditPageSize(this.value)" class="px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs">
                <option value="25" ${state.auditPageSize === 25 ? 'selected' : ''}>25</option>
                <option value="50" ${state.auditPageSize === 50 ? 'selected' : ''}>50</option>
                <option value="100" ${state.auditPageSize === 100 ? 'selected' : ''}>100</option>
                <option value="250" ${state.auditPageSize === 250 ? 'selected' : ''}>250</option>
              </select>
              <span>entries</span>
              <span class="text-slate-400">|</span>
              <span>Showing ${startIndex + 1}-${Math.min(startIndex + state.auditPageSize, totalLogs)} of ${totalLogs}</span>
            </div>
            
            <div class="flex items-center space-x-1">
              <button onclick="updateAuditPage(1)" ${currentPage === 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage === 1 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevrons-left" class="w-3 h-3"></i>
              </button>
              <button onclick="updateAuditPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage === 1 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevron-left" class="w-3 h-3"></i>
              </button>
              
              <span class="px-3 py-1.5 text-xs font-bold text-slate-700 dark:text-slate-300">
                Page ${currentPage} of ${totalPages || 1}
              </span>
              
              <button onclick="updateAuditPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage >= totalPages ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevron-right" class="w-3 h-3"></i>
              </button>
              <button onclick="updateAuditPage(${totalPages})" ${currentPage >= totalPages ? 'disabled' : ''} class="px-3 py-1.5 rounded-lg text-xs font-medium ${currentPage >= totalPages ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700'}">
                <i data-lucide="chevrons-right" class="w-3 h-3"></i>
              </button>
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

// Audit log helper functions
function updateAuditFilter(filterType, value) {
  switch (filterType) {
    case 'search': {
      const v = String(value || '');
      const clean = Security.sanitizeInput(v, { maxLength: 200 });
      // #region agent log
      // Hypothesis H3: Audit search is injected into templates as an attribute value; quotes can break HTML.
      if (ALBAYAN_DEBUG_MODE && typeof window.__albayanDebugEmit === 'function') {
      try {
        const dbg = (window.__albayanDebugAudit = window.__albayanDebugAudit || {});
        const hasQuote = v.includes('"');
        const hasApos = v.includes("'");
        const hasAngle = v.includes('<') || v.includes('>');
        if (!dbg.auditSearchLogged && (hasQuote || hasApos || hasAngle)) {
          dbg.auditSearchLogged = true;
            window.__albayanDebugEmit('H3', 'script.js:updateAuditFilter', 'auditSearch contains special chars', {len:v.length,hasQuote,hasApos,hasAngle});
        }
      } catch (_) {}
      }
      // #endregion
      state.auditSearch = clean;
      break;
    }
    case 'action': state.auditActionFilter = value; break;
    case 'category': state.auditCategoryFilter = value; break;
    case 'severity': state.auditSeverityFilter = value; break;
    case 'user': state.auditUserFilter = value; break;
    case 'dateFrom': state.auditDateFrom = value; break;
    case 'dateTo': state.auditDateTo = value; break;
  }
  state.auditPage = 1; // Reset to first page when filtering
  render();
  lucide.createIcons();
}

function clearAuditFilters() {
  state.auditSearch = '';
  state.auditActionFilter = 'all';
  state.auditCategoryFilter = 'all';
  state.auditSeverityFilter = 'all';
  state.auditUserFilter = 'all';
  state.auditDateFrom = '';
  state.auditDateTo = '';
  state.auditPage = 1;
  render();
  lucide.createIcons();
}

function updateAuditPage(page) {
  state.auditPage = Math.max(1, page);
  render();
  lucide.createIcons();
}

function updateAuditPageSize(size) {
  state.auditPageSize = parseInt(size) || 25;
  state.auditPage = 1;
  render();
  lucide.createIcons();
}

function showLogDetails(logId) {
  const log = state.logs.find(l => l.id === logId);
  if (!log) return;
  
  const user = state.users.find(u => u.id === log.userId);
  const modal = document.getElementById('app-modal') || document.createElement('div');
  modal.id = 'app-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  modal.innerHTML = `
    <div class="glass-panel rounded-2xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto animate-slide-up" onclick="event.stopPropagation()">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-slate-800 dark:text-white flex items-center space-x-2">
          <span class="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
            <i data-lucide="file-text" class="w-5 h-5 text-white"></i>
          </span>
          <span>Log Details</span>
        </h2>
        <button onclick="this.closest('#app-modal').remove()" class="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
          <i data-lucide="x" class="w-4 h-4 text-slate-600 dark:text-slate-300"></i>
        </button>
      </div>
      
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Log ID</div>
            <div class="text-xs font-mono text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.id)}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Timestamp</div>
            <div class="text-xs text-slate-700 dark:text-slate-300">${new Date(log.date).toLocaleString()}</div>
          </div>
        </div>
        
        <div class="grid grid-cols-3 gap-4">
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">User</div>
            <div class="text-xs text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.userName || user?.name || 'System')}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Action</div>
            <div class="text-xs font-bold text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.action)}</div>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Category</div>
            <div class="text-xs text-slate-700 dark:text-slate-300 capitalize">${Security.escapeHtml(log.category || 'general')}</div>
          </div>
        </div>
        
        <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
          <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Description</div>
          <div class="text-sm text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.description)}</div>
        </div>
        
        ${log.resourceId ? `
          <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
            <div class="text-[10px] font-bold text-slate-400 uppercase mb-1">Resource ID</div>
            <div class="text-xs font-mono text-slate-700 dark:text-slate-300">${Security.escapeHtml(log.resourceId)}</div>
          </div>
        ` : ''}
        
        <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50">
          <div class="text-[10px] font-bold text-slate-400 uppercase mb-2">Metadata</div>
          <pre class="text-xs text-slate-600 dark:text-slate-400 overflow-x-auto whitespace-pre-wrap bg-slate-100 dark:bg-slate-900 p-3 rounded-lg">${Security.escapeHtml(JSON.stringify(log.metadata || {}, null, 2))}</pre>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  IconQueue.schedule(modal);
}

function exportAuditLogs(format) {
  const allLogs = getVisibleRecords(state.logs);
  
  if (format === 'csv') {
    const headers = ['Date', 'Time', 'User', 'Action', 'Category', 'Severity', 'Description', 'Resource ID'];
    const rows = allLogs.map(log => {
      const user = state.users.find(u => u.id === log.userId);
      const date = new Date(log.date);
      return [
        // Pin an unambiguous, sortable Gregorian format. On ar-SA devices the
        // locale-less calls rendered Hijri Arabic-Indic dates, inconsistent
        // with the stored Gregorian timestamps.
        date.toLocaleDateString('en-CA'),                       // YYYY-MM-DD
        date.toLocaleTimeString('en-GB', { hour12: false }),    // HH:MM:SS
        log.userName || user?.name || 'System',
        log.action,
        log.category || 'general',
        log.severity || 'info',
        `"${(log.description || '').replace(/"/g, '""')}"`,
        log.resourceId || ''
      ].join(',');
    });
    
    const csv = [headers.join(','), ...rows].join('\n');
    // UTF-8 BOM so Excel reads Arabic text correctly (downloadFile is shared
    // with JSON export, so add the BOM here rather than inside it).
    downloadFile('﻿' + csv, `audit-logs-${new Date().toISOString().split('T')[0]}.csv`, 'text/csv;charset=utf-8');
  } else {
    const json = JSON.stringify(allLogs, null, 2);
    downloadFile(json, `audit-logs-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  }
  
  showNotification('Export Complete', `Audit logs exported as ${format.toUpperCase()}`, 'success');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Backup all audit logs for permanent storage
async function backupAuditLogs() {
  const allLogs = getVisibleRecords(state.logs);
  
  const backup = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    exportedBy: state.currentUser?.name || 'System',
    totalLogs: allLogs.length,
    logs: allLogs
  };
  
  const json = JSON.stringify(backup, null, 2);
  downloadFile(json, `audit-logs-backup-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  
  // Add backup log entry
  addAuditLog('backup', 'system', `Backed up ${allLogs.length} audit logs`, { backupSize: json.length });
  
  showNotification('Backup Complete', `${allLogs.length} logs backed up successfully`, 'success');
}

// Restore audit logs from backup file
function restoreAuditLogs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        
        if (!backup.logs || !Array.isArray(backup.logs)) {
          showNotification('Error', 'Invalid backup file format', 'error');
          return;
        }
        
        // Merge logs without duplicates
        const existingIds = new Set(state.logs.map(l => l.id));
        let imported = 0;
        
        for (const log of backup.logs) {
          if (!existingIds.has(log.id)) {
            state.logs.push(log);
            existingIds.add(log.id);
            imported++;
            
            // Also save to IndexedDB
            if (db) {
              await saveLogToIndexedDB(log);
            }
          }
        }
        
        // Sort by date (handle invalid dates safely)
        state.logs.sort((a, b) => {
          const dateA = new Date(a.date || 0).getTime() || 0;
          const dateB = new Date(b.date || 0).getTime() || 0;
          return dateB - dateA;
        });
        
        saveState();
        
        addAuditLog('restore', 'system', `Restored ${imported} audit logs from backup`, { 
          backupDate: backup.exportDate,
          totalInBackup: backup.totalLogs
        });
        
        showNotification('Restore Complete', `Imported ${imported} new logs (${backup.totalLogs - imported} duplicates skipped)`, 'success');
        render();
        lucide.createIcons();
      } catch (error) {
        console.error('Restore error:', error);
        showNotification('Error', 'Failed to restore backup: ' + error.message, 'error');
      }
    };
    
    reader.readAsText(file);
  };
  
  input.click();
}

// Cleanup old audit logs
async function cleanupAuditLogs() {
  if (!isCurrentUserAdmin()) {
    showNotification('Access Denied', 'Admin only', 'error');
    return;
  }
  
  const daysToKeep = prompt('Delete audit logs older than how many days? (default: 365)', '365');
  if (!daysToKeep) return;
  
  const days = parseInt(daysToKeep);
  if (isNaN(days) || days < 30) {
    showNotification('Validation Error', 'Minimum 30 days required', 'error');
    return;
  }
  
  if (!confirm(`⚠️ Delete all audit logs older than ${days} days?\n\nThis action cannot be undone.\nConsider backing up first.`)) {
    return;
  }
  
  try {
    const res = await fetch('/api/audit/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session': getSessionToken()
      },
      body: JSON.stringify({ days_to_keep: days })
    });
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Cleanup failed' }));
      showNotification('Error', err.detail || 'Cleanup failed', 'error');
      return;
    }
    
    const result = await res.json();
    showNotification(
      'Cleanup Complete',
      `Deleted ${result.deleted_count} old audit logs`,
      'success'
    );
    
    // Refresh audit logs from server
    if (isServerModeEnabled()) {
      await syncFromServer();
      render();
      lucide.createIcons();
    }
  } catch (error) {
    showNotification('Error', 'Cleanup failed: ' + error.message, 'error');
  }
}

function renderSettingsView() {
  const history = state.exchangeRateHistory || [];
  
  return `
    <div class="space-y-6 animate-fade-in-up">
      <h1 class="text-3xl font-bold text-slate-800 dark:text-white">${t('settings')}</h1>

      <!-- Security -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="shield" class="w-5 h-5 mr-2 text-indigo-600"></i>
          ${t('security')}
        </h2>
        <div class="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-700 mb-4">
          <p class="text-sm text-slate-600 dark:text-slate-300">
            <i data-lucide="info" class="w-4 h-4 inline mr-1"></i>
            ${isServerModeEnabled()
              ? (state.language === 'ar'
                ? 'في وضع السيرفر: استخدم \"نسيت كلمة المرور\" للحصول على رمز استعادة (أو البريد الإلكتروني لاحقاً).'
                : 'Server mode: use \"Forgot password\" to get a reset code (email later).')
              : (state.language === 'ar'
                ? 'في الوضع المحلي: أنشئ مفتاح استعادة لاسترجاع كلمة المرور عند نسيانها.'
                : 'Local mode: create a Recovery Key to reset passwords if forgotten.')}
          </p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button onclick="showChangePasswordModal()" class="btn-shine bg-emerald-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-emerald-700">
            <i data-lucide="lock" class="w-5 h-5"></i>
            <span>${t('changePassword')}</span>
          </button>
          ${!isServerModeEnabled() ? `
            <button onclick="generateAndShowRecoveryKey()" class="btn-shine bg-indigo-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-indigo-700">
              <i data-lucide="key" class="w-5 h-5"></i>
              <span>${t('generateRecoveryKey')}</span>
            </button>
          ` : ''}
        </div>
        <div class="mt-3">
          <button onclick="passkeyRegisterCurrentUser()" class="w-full glass-panel rounded-xl px-4 py-3 font-bold flex items-center justify-center space-x-2 hover:shadow-xl">
            <i data-lucide="key-round" class="w-5 h-5"></i>
            <span>${state.language === 'ar' ? 'إضافة Passkey (Face ID / Touch ID)' : 'Add a Passkey (Face ID / Touch ID)'}</span>
          </button>
          <div class="mt-2 text-[11px] text-slate-400">
            ${state.language === 'ar'
              ? 'ملاحظة: Passkey يتطلب HTTPS أو localhost. لن يعمل عند فتح الملف مباشرة.'
              : 'Note: Passkeys require HTTPS or localhost. They won’t work when opening the file directly.'}
          </div>
          <div id="passkey-list" class="mt-3">
            ${(() => {
              const keys = Array.isArray(state.currentUser?.passkeys) ? state.currentUser.passkeys : [];
              if (!keys.length) {
                return `<div class="text-xs text-slate-400">${state.language === 'ar' ? 'لا يوجد Passkey مضاف بعد.' : 'No passkeys added yet.'}</div>`;
              }
              return `
                <div class="space-y-2">
                  ${keys.map((k, idx) => `
                    <div class="flex items-center justify-between p-3 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                      <div class="text-xs">
                        <div class="font-bold text-slate-700 dark:text-slate-200">${state.language === 'ar' ? 'Passkey' : 'Passkey'} #${idx + 1}</div>
                        <div class="font-mono text-[10px] text-slate-400 break-all">${Security.escapeHtml(String(k.id || '').slice(0, 20))}…</div>
                      </div>
                      <button type="button" onclick="removePasskey('${Security.escapeHtml(String(k.id || ''))}')" class="text-rose-600 hover:text-rose-700 text-xs font-bold">
                        <i data-lucide="trash-2" class="w-4 h-4 inline mr-1"></i>${state.language === 'ar' ? 'حذف' : 'Remove'}
                      </button>
                    </div>
                  `).join('')}
                </div>
              `;
            })()}
          </div>
        </div>
        ${!isServerModeEnabled() ? `
          <div class="mt-3 p-3 rounded-xl bg-white/60 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs text-slate-500">
            ${state.localRecovery?.createdAt
              ? (state.language === 'ar'
                ? `مفتاح الاستعادة مُنشأ بتاريخ: ${new Date(state.localRecovery.createdAt).toLocaleString()}`
                : `Recovery key created: ${new Date(state.localRecovery.createdAt).toLocaleString()}`)
              : (state.language === 'ar'
                ? 'لم يتم إنشاء مفتاح استعادة بعد.'
                : 'No recovery key created yet.')}
          </div>
        ` : ''}
      </div>

      <!-- Performance mode (for slow devices) -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="zap" class="w-5 h-5 mr-2 text-amber-500"></i>
          ${state.language === 'ar' ? 'الأداء' : 'Performance'}
        </h2>
        <label class="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <div class="font-medium text-slate-800 dark:text-slate-100">
              ${state.language === 'ar' ? 'وضع الأداء (للأجهزة البطيئة)' : 'Performance mode (for slow devices)'}
            </div>
            <div class="text-xs text-slate-500 mt-1">
              ${state.language === 'ar'
                ? 'يوقف تأثيرات الزجاج والخلفية المتحركة لجعل التطبيق أخف وأسرع. جميع الميزات تبقى كما هي. يُفعَّل تلقائياً على الأجهزة الضعيفة.'
                : 'Turns off the glass-blur effects and animated background so the app runs lighter and faster. All features stay the same. Enabled automatically on weak devices.'}
            </div>
          </div>
          <input type="checkbox" ${isPerformanceModeOn() ? 'checked' : ''} onchange="togglePerformanceMode(this.checked)" class="w-5 h-5 accent-indigo-600 flex-shrink-0" />
        </label>
      </div>

      <!-- Exchange Rate -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="dollar-sign" class="w-5 h-5 mr-2 text-emerald-600"></i>
          Exchange Rate Management
        </h2>
        <div class="space-y-4">
          <div class="flex flex-col md:flex-row md:items-center space-y-2 md:space-y-0 md:space-x-4">
            <label class="text-sm font-medium text-slate-700 dark:text-slate-300">Current Rate (USD to LYD):</label>
            <input type="text" id="default-rate-input" inputmode="decimal" value="${Security.escapeHtml(String(state.defaultExchangeRate ?? ''))}" oninput="sanitizeMoneyInput(this, 4)" onchange="updateExchangeRate(this.value)" class="glass-input px-4 py-2 rounded-xl w-32 font-bold text-emerald-600" />
            <button onclick="updateExchangeRate(document.getElementById('default-rate-input').value)" class="btn-shine bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm">Save Rate</button>
          </div>

          ${history.length > 0 ? `
            <div class="mt-6">
              <h3 class="text-sm font-bold text-slate-500 uppercase mb-3">Rate History (Last 10)</h3>
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-slate-200 dark:border-slate-700">
                      <th class="text-left py-2">Date</th>
                      <th class="text-left py-2">Rate</th>
                      <th class="text-left py-2">Changed By</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${history.slice(0, 10).map(h => {
                      const user = state.users.find(u => u.id === h.userId);
                      return `
                        <tr class="border-b border-slate-100 dark:border-slate-800">
                          <td class="py-2 text-xs text-slate-500">${new Date(h.date).toLocaleString()}</td>
                          <td class="py-2 font-mono font-bold text-emerald-600">${h.rate.toFixed(2)}</td>
                          <td class="py-2 text-slate-600 dark:text-slate-400">${Security.escapeHtml(user?.name || 'System')}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Data Management -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4 flex items-center">
          <i data-lucide="database" class="w-5 h-5 mr-2 text-blue-600"></i>
          Data Management
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onclick="exportData()" class="btn-shine bg-blue-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-blue-700">
            <i data-lucide="download" class="w-5 h-5"></i>
            <span>Export Backup</span>
          </button>
          <button onclick="importData()" class="btn-shine bg-green-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-green-700">
            <i data-lucide="upload" class="w-5 h-5"></i>
            <span>Import Backup</span>
          </button>
          <button onclick="clearAllData()" class="btn-shine bg-rose-600 text-white px-4 py-3 rounded-xl font-bold flex items-center justify-center space-x-2 hover:bg-rose-700">
            <i data-lucide="trash-2" class="w-5 h-5"></i>
            <span>Clear All Data</span>
          </button>
        </div>
        <div class="mt-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl">
          <p class="text-sm text-slate-600 dark:text-slate-400">
            <i data-lucide="info" class="w-4 h-4 inline mr-1"></i>
            Your data is stored locally in your browser. Export regularly to create backups.
          </p>
        </div>
      </div>

      <!-- Cloud Sync -->
      ${state.cloudConfig.enabled ? `
        <div class="glass-panel rounded-2xl p-6">
          <h2 class="text-xl font-bold mb-4 flex items-center">
            <i data-lucide="cloud" class="w-5 h-5 mr-2 text-indigo-600"></i>
            Cloud Sync
          </h2>
          <div class="space-y-4">
            <div class="flex items-center space-x-3 p-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
              <i data-lucide="check-circle" class="w-5 h-5 text-emerald-600"></i>
              <div class="flex-1">
                <p class="font-medium text-emerald-700 dark:text-emerald-300">Cloud Sync Enabled</p>
                <p class="text-xs text-emerald-600 dark:text-emerald-400 mt-1">Last sync: ${state.lastCloudSync ? new Date(state.lastCloudSync).toLocaleString() : 'Never'}</p>
              </div>
            </div>
            <div class="flex space-x-3">
              <button onclick="pushToCloud()" class="flex-1 btn-shine bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold">
                <i data-lucide="upload-cloud" class="w-4 h-4 inline mr-2"></i>Push Now
              </button>
              <button onclick="pullFromCloud()" class="flex-1 btn-shine bg-blue-600 text-white px-4 py-2 rounded-xl font-bold">
                <i data-lucide="download-cloud" class="w-4 h-4 inline mr-2"></i>Pull Now
              </button>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- App Info -->
      <div class="glass-panel rounded-2xl p-6">
        <h2 class="text-xl font-bold mb-4">Application Info</h2>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between"><span class="text-slate-500">Version:</span><span class="font-mono">3.5.0 Vanilla</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Total Ads:</span><span class="font-bold">${getVisibleRecords(state.ads).length}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Total Customers:</span><span class="font-bold">${getVisibleRecords(state.customers).length}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Total Users:</span><span class="font-bold">${getVisibleRecords(state.users).length}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Audit Logs:</span><span class="font-bold">${getVisibleRecords(state.logs).length}</span></div>
        </div>
      </div>
    </div>
  `;
}

