# Deep scan — 18 September 2026

Scope: bugs, errors and security across the backend (`server/`), the frontend
(`src/`), deployment files and dependencies, on top of the three 15–16 September
reviews (which were found uncommitted and landed as commit `89a323d`). Six
independent read-only hunters (frontend XSS, backend auth/web hardening,
uploads/SSRF/injection/webhooks, wallet/paywall/Social Studio logic, a
regression review of the uncommitted batch, and frontend/native robustness)
reported findings with file/line evidence; each fix below was re-read in code
before it was made and is covered by a regression test or a static guard.

No production data was read or changed. Only the public health endpoint, the
login error shape and response headers of the live site were inspected.

## Fixed

### Backend

| Area | Problem | Fix |
| --- | --- | --- |
| API docs | `/docs`, `/redoc` and `/openapi.json` were public on production, describing every route, body field and idempotency namespace. | Docs routes exist only when `ALBAYAN_DEBUG_MODE` is on (`server/main.py`). |
| Signature checks | `hmac.compare_digest` raises on non-ASCII strings, so a garbage media signature, webhook signature, verify token or origin-secret header from an anonymous caller became a 500 with a traceback (and fed the error-rate alert). | `constant_time_equal` in `server/security.py` compares UTF-8 bytes; used in `social_studio.py`, `meta_ads.py`, `http_security.py`. |
| Webhook comments | Every public comment loaded all of the owner's published posts including base64 photos, under the global comment lock. | `process_comment` uses the media-free `_lean_posts` projection. |
| Media rate limit | The Social Studio media route keyed its limit on the leftmost `X-Forwarded-For` entry, which the client controls. | Shares `auth_limits._client_ip`. |
| Signed media URLs | Signed with the raw Meta app secret, never expired, and a random per-boot key when the secret was unset. | Dedicated derived key, `exp` parameter (default 48 h, `ALBAYAN_SOCIAL_MEDIA_URL_TTL_SECONDS`), signature covers post, index and expiry. |
| Rate-limit identity | Session/reset/app-login rows and the password-change limit used the raw peer address instead of the shared resolver. | All use `_client_ip`. When proxy headers arrive while `ALBAYAN_TRUST_PROXY_HEADERS` is off, the server logs one warning; deploy docs updated. |
| Error logs | Unhandled-exception logs could include SQLAlchemy `[parameters: …]` (bound values such as password hashes). | `_safe_exception_text` redacts parameters; the traceback no longer repeats the raw message. |
| Stylesheets | The four new workspace stylesheets were served without cache-busting (1 h at the browser and the Cloudflare edge) while `script.js` was versioned. | Added to the `?v=` loop in `_serve_versioned_index`. |
| `/studio/` | A trailing slash made the shell resolve `script.js` relative to `/studio/`, which does not exist: "Loading…" forever. | 308 redirect to the slash-less route, query preserved. |

### Frontend

| Area | Problem | Fix |
| --- | --- | --- |
| Lazy bundles | When `clothes.js`, `studio.js` or `admin-tools.js` failed to load, every render re-requested it (offline phone: a tight request loop, spinner forever, Retry card unreachable). | 30 s cooldown after a failure in all three loaders; the Retry button resets it. |
| Filter panels | The 15 September batch collapsed every list's "Filters & sort" panel by default and forgot the choice on reload. | Choice persisted per list in `localStorage`; wide screens default open, phones default folded. |
| Phone header | The current view title had been replaced by a static label. | Shows the view title again, brand name beneath. |
| WhatsApp reminders | Arabic-digit phones produced an empty link (the app opened itself), and local `09…` numbers were not international; the customer was still marked "reminded". | Uses the existing phone normaliser (`218…`), refuses unreadable numbers, reminder log is per account. |
| Sign-out | Search boxes, the receipt customer filter, the charge-wallet reference card and Control Center data survived into the next sign-in on the same device. | Cleared in the sign-out teardown. |
| Sidebar | Staff with `analytics` view saw "Control Center", which the router then refused. | Platform-owner views never listed for non-admins. |
| Driver tab | Removing `deliveries.viewOwn` from a driver left a Deliveries tab that bounced back. | Permission gate mirrors the router exemption. |
| Blank screen | A first render that threw left an empty page. | Bilingual "reload" card, only when the page is blank. |
| Plans page | A failed price fetch spun "Loading prices…" forever. | Failure state with retry. |
| Social composer | A keystroke during a slow save silently dropped the result. | Saved-as-draft notice; a completed publish always shows its result. |
| Deliveries | The Cancel action was hidden for the rare `Office` status. | Negative condition restored. |
| Plan manager | A half-typed or malformed price became 0 and saved an active free plan. | Invalid input keeps the previous price. |
| LYD previews | Ads Studio preview/estimate used floating-point rounding that disagreed with the server's LYD instruction by a piastre. | Same integer arithmetic as the server. |
| Idempotency keys | Wallet top-up keys were `paycreate-<uid>-<ms>` (guessable, cross-user existence oracle). | Random secure ids. |
| Paywall | The Subscribe button state came from a possibly stale local ledger. | One live-sync tick when the paywall opens. |
| XSS hardening | One unescaped customer name (transfer modal); Meta page ids inside an inline `onclick` string; the client stripper could be bypassed by doubling (`oonclick=nclick=`). | Escaped; data attributes; strip-until-stable loop. No exploitable XSS was found — output encoding is applied consistently and the server strips angle brackets on every write. |

## Verified and left as is

- Cookies (HttpOnly, SameSite, Secure), CSRF via strict same-origin checks on
  every mutation, PBKDF2-HMAC-SHA256 600k, hashed tokens, single-use reset
  codes, PKCE app login, CORS allowlist, HSTS/CSP/frame denial, request size
  limit 10 MB, image validation by magic bytes and pixel limits, Meta Graph
  SSRF guards, webhook HMAC (503 when unsigned), backups with constant names
  and AES-GCM, bound SQL parameters everywhere, no `eval`/`pickle`/shell.
- `npm audit`: 0 advisories. `pip-audit` (49 packages): 0 advisories. Bandit
  medium+/medium+: one flag, the operator-configured alert webhook URL.
- Git history of source files: no credential markers.
- The native-reminder pause deliberately survives sign-out (fail-closed; pinned
  by `scripts/test-social-native-regressions.js`).

## Needs the owner's decision (not changed)

1. **Smart Systems plan is a client-only paywall.** No server route checks a
   `smart_systems` subscription; the Albayan Manager APIs are RBAC-only. If this
   plan is ever priced, it is unenforceable. Either add a server gate (admin and
   staff exempt) or keep the plan presentation-only.
2. **Customer self-stop refunds** the full captured budget whenever the campaign
   has no launch marker and its start date is in the future — including an ad
   staff launched by hand and forgot to mark. Consider requiring the launch
   marker before an approved campaign counts as live.
3. **Global `adCampaignRequests.submit`** lets staff submit a customer's draft,
   which places a hold on the customer's wallet with no customer action.
4. **Deliveries compact rows** from 12 September were replaced by job cards in
   the 15 September batch; the helper `shellDeliverySummaryRow` is now unused.
   Keep the cards or restore the rows.
5. **Deployment:** set `ALBAYAN_TRUST_PROXY_HEADERS=true` on the Jelastic app
   node (the container is only reachable through Cloudflare and the platform
   load balancer). Without it all visitors share one login-attempt allowance and
   one stranger can lock the office out of signing in. Optionally add
   `ALBAYAN_ORIGIN_SECRET` with a matching Cloudflare header rule.
6. **CSP** still allows inline scripts (`'unsafe-inline'`) because the UI uses
   inline handlers; moving to delegated handlers with a nonce is a larger
   refactor.
7. Sessions have no idle timeout and no "sign out other devices" action.
