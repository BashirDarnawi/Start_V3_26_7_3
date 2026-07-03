// Minimal global types for the Albayan vanilla JS frontend.
// These are used by JSDoc annotations in `script.js` to provide IntelliSense + safer refactors.
//
// IMPORTANT:
// - This does NOT affect runtime (it's editor-only).
// - We keep these types intentionally flexible (index signatures) to avoid breaking the current JS code.

type AlbayanRole = "Admin" | "Employee" | "Delivery" | string;

type AlbayanPermissionAction = string;
type AlbayanPermissions = Record<string, AlbayanPermissionAction[]>;

interface AlbayanUserPublic {
  id: string;
  name: string;
  email: string;
  role: AlbayanRole;
  permissions: AlbayanPermissions;
  subscriptions?: string[];
  stats?: Record<string, unknown>;
  _deleted?: boolean;
  _created?: number;
  _lastModified?: number;
  [key: string]: unknown;
}

interface AlbayanEntity<TData = Record<string, unknown>> {
  id: string;
  type: string;
  deleted: boolean;
  createdAt: number;
  createdBy?: string | null;
  lastModified: number;
  data: TData;
}

interface AlbayanCloudConfig {
  enabled: boolean;
  endpoint: string;
  apiKey?: string;
  [key: string]: unknown;
}

type AlbayanCloudSyncStatus = "idle" | "syncing" | "success" | "error" | string;

interface AlbayanServerApiConfig {
  enabledByDefault: boolean;
  requestTimeoutMs: number;
  pageSize: number;
}

interface AlbayanState {
  // Auth / routing
  currentUser: AlbayanUserPublic | null;
  currentView: string;
  isMobileMenuOpen: boolean;

  // Server mode
  serverMode: boolean;
  serverDetected: boolean;
  serverModeOverride: "auto" | "local" | "server" | string;
  serverBaseUrl: string;
  serverLastSyncAt: string | null;

  // UI
  language: "en" | "ar" | string;
  theme: "light" | "dark" | "system" | string;

  // Data collections (runtime shapes vary; keep flexible)
  users: AlbayanUserPublic[];
  ads: Record<string, unknown>[];
  receipts: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  pages: Record<string, unknown>[];
  logs: Record<string, unknown>[];
  exchangeRateHistory: Record<string, unknown>[];
  walletTransactions: Record<string, unknown>[];
  serviceSubscriptions: Record<string, unknown>[];

  // Settings / cloud sync
  defaultExchangeRate: number;
  cloudConfig: AlbayanCloudConfig;
  cloudSyncStatus: AlbayanCloudSyncStatus;
  lastCloudSync: string | null;

  // Allow other existing fields without forcing a huge typing migration today.
  [key: string]: unknown;
}


