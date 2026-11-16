"""Guards of the generic data store and the notice for out-of-date tabs.

Kept out of server/main.py, which has a line budget (scripts/test-architecture.js): each of these
is self-contained and is imported there under its private name.
"""
from __future__ import annotations

import re
from typing import Any, Callable

from fastapi import HTTPException

from .rbac import _load_permissions, user_has_permission

_SAFE_ENTITY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")  # the same rule as main.SAFE_ENTITY_ID_RE

# What a tab opened BEFORE the current release gets when it asks for a lazy bundle (its ?v= is the
# old main bundle's). The new bundle was written for the new main bundle: loaded into the old one it
# can stop half-way, which left a menu item that did nothing until a manual reload, and a Retry
# that could never succeed. This small script says so instead and offers the reload. It also runs
# in tabs whose (old) loaders know nothing about it; "Later" keeps whatever the person is typing.
STALE_BUILD_SCRIPT = """(function () {
  window.__albayanStaleBuild = true;
  try {
    if (document.getElementById('albayan-stale-build') || !document.body) return;
    var ar = String(document.documentElement.getAttribute('lang') || '').toLowerCase().indexOf('ar') === 0;
    var overlay = document.createElement('div');
    overlay.id = 'albayan-stale-build';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('dir', ar ? 'rtl' : 'ltr');
    overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.6);font-family:inherit';
    var card = document.createElement('div');
    card.style.cssText = 'max-width:26rem;width:100%;background:#fff;color:#0f172a;border-radius:16px;padding:24px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.3)';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:800;font-size:1.125rem;margin-bottom:8px';
    title.textContent = ar ? 'يتوفر إصدار جديد' : 'A new version is available';
    var text = document.createElement('div');
    text.style.cssText = 'font-size:.875rem;color:#475569;margin-bottom:16px';
    text.textContent = ar
      ? 'تم تحديث البيان منذ فتح هذه الصفحة. أعد التحميل لفتح هذا القسم. إن كنت تكتب شيئاً، احفظه أولاً ثم أعد التحميل.'
      : 'Albayan was updated since this page was opened. Reload to open this section. If you are in the middle of typing something, save it first, then reload.';
    var reload = document.createElement('button');
    reload.type = 'button';
    reload.style.cssText = 'min-height:44px;padding:0 20px;margin:4px;border:0;border-radius:12px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer';
    reload.textContent = ar ? 'إعادة التحميل الآن' : 'Reload now';
    reload.addEventListener('click', function () { window.location.reload(); });
    var later = document.createElement('button');
    later.type = 'button';
    later.style.cssText = 'min-height:44px;padding:0 20px;margin:4px;border:0;border-radius:12px;background:#e2e8f0;color:#0f172a;font-weight:700;cursor:pointer';
    later.textContent = ar ? 'لاحقاً' : 'Later';
    later.addEventListener('click', function () { overlay.parentNode && overlay.parentNode.removeChild(overlay); });
    card.appendChild(title); card.appendChild(text); card.appendChild(reload); card.appendChild(later);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    reload.focus();
  } catch (_) {}
})();
"""


MAX_RECORD_TEXT_CHARS = 1_000_000  # one record's text, photos not counted: far above any real record
MAX_RECORD_NODES = 100_000


def refuse_oversized_record(data: Any) -> None:
    """413 for a record body no real record comes near, before any of the costly cleaning.

    The only limit used to be the 10 MB request: any add or edit grant could store 9 MB of junk
    in one record (940 keys of 10,000 characters, or a list of a million items), which every
    later bootstrap and list then carried, and each such request held the server for 3 to 17
    seconds. Photos (data:image/ strings) are not counted: they have their own limit."""
    stack: list[Any] = [data]
    chars = nodes = 0
    while stack:
        value = stack.pop()
        nodes += 1
        if isinstance(value, str):
            if not value.startswith("data:image/"):
                chars += len(value)
        elif isinstance(value, dict):
            for key, child in value.items():
                chars += len(key) if isinstance(key, str) else 0
                stack.append(child)
        elif isinstance(value, list):
            stack.extend(value)
        if chars > MAX_RECORD_TEXT_CHARS or nodes > MAX_RECORD_NODES:
            raise HTTPException(status_code=413, detail="This record is too large to save")


def refuse_unseen_customer_reference(
    user: dict[str, Any], collection: str, data: Any, existing_data: dict[str, Any] | None = None,
    *, get_entity: Callable[[str, str], dict[str, Any] | None],
) -> None:
    """An account LIMITED to its own customers (customers.viewOwn, no customers.view) may hang a receipt
    or an ad only on a customer of its own.

    Without this, customers.viewOwn plus receipts.add (or ads.add) was enough to put a receipt on ANY
    customer whose id the account knew (pages list them), and the reply named that customer. Admins,
    accounts with customers.view, drivers (who never choose the customer) and receipts/ads-only roles
    with no customer grant at all (they work from the customerName stamp, by design) are not affected;
    an unchanged link on an edit and a customer that does not exist yet (drafts save in either order) pass."""
    if collection not in {"receipts", "ads"} or not isinstance(data, dict):
        return
    if str(user.get("role") or "").lower() in {"admin", "delivery"} or user_has_permission(user, "customers", "view"):
        return
    if "viewOwn" not in _load_permissions(user.get("permissions_json")).get("customers", []):
        return
    customer_id = data.get("customerId")
    # Only a well-formed id is looked up (the regular validation refuses the rest with 400; a lone
    # surrogate here could not even be sent to the database: an unhandled 500 found by fuzzing).
    if not isinstance(customer_id, str) or not _SAFE_ENTITY_ID_RE.fullmatch(customer_id):
        return
    if customer_id == str((existing_data or {}).get("customerId") or "").strip():
        return
    customer = get_entity("customers", customer_id)
    if not customer:
        return
    creator = customer.get("createdBy") or (customer.get("data") or {}).get("createdBy") or (customer.get("data") or {}).get("creatorId")
    if not user_has_permission(user, "customers", "view", record_creator_id=str(creator or "")):
        raise HTTPException(status_code=403, detail="You cannot use a customer you do not have access to")
