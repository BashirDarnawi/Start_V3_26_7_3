"""Libyan payment-method catalog for wallet charges.

Server-owned config: the client renders whatever this returns, so adding or
retiring a payment channel needs no app rebuild. Each entry's ``instructions``
are templates with ``{reference}``, ``{amountUSD}``, ``{amountLYD}`` and
``{rate}`` placeholders the client fills from the created request row.
The ``webhook`` slot is server-internal (stripped from public output): when a
provider is contracted, its signed callback will drive the SAME confirm path
the admin uses today — the payreq idempotent credit makes doubles harmless.
"""

PAYMENT_METHOD_CATALOG: tuple[dict, ...] = (
    {
        "id": "adfali",
        "name": {"en": "Adfali", "ar": "ادفع لي"},
        "desc": {"en": "Pay from your phone balance", "ar": "ادفع من رصيد هاتفك"},
        "icon": "smartphone",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Pay {amountLYD} LYD via Adfali and keep the code {reference} in the payment note.",
            "ar": "ادفع {amountLYD} د.ل عبر ادفع لي واذكر الرمز {reference} في ملاحظة الدفع.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "bank_transfer",
        "name": {"en": "Bank transfer", "ar": "حوالة مصرفية"},
        "desc": {"en": "Transfer and attach the receipt photo", "ar": "حوّل وأرفق صورة الإيصال"},
        "icon": "landmark",
        "requiresReceiptPhoto": True,
        "instructions": {
            "en": "Transfer {amountLYD} LYD, write {reference} in the transfer note, then attach the receipt photo here.",
            "ar": "حوّل {amountLYD} د.ل واكتب {reference} في بيان الحوالة ثم أرفق صورة الإيصال هنا.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "mobicash",
        "name": {"en": "MobiCash", "ar": "موبي كاش"},
        "desc": {"en": "Al-Wahda bank mobile wallet", "ar": "خاصة بمصرف الوحدة"},
        "icon": "smartphone",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Send {amountLYD} LYD via MobiCash with the code {reference} in the note.",
            "ar": "أرسل {amountLYD} د.ل عبر موبي كاش مع الرمز {reference} في الملاحظة.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "sahara_pay",
        "name": {"en": "Sahara Pay", "ar": "صحاري باي"},
        "desc": {"en": "Sahara bank mobile wallet", "ar": "خاصة بمصرف الصحاري"},
        "icon": "building-2",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Send {amountLYD} LYD via Sahara Pay with the code {reference} in the note.",
            "ar": "أرسل {amountLYD} د.ل عبر صحاري باي مع الرمز {reference} في الملاحظة.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "masarfi_pay",
        "name": {"en": "Masarfi Pay", "ar": "مصرفي باي"},
        "desc": {"en": "Jumhouria bank mobile wallet", "ar": "خاصة بمصرف الجمهورية"},
        "icon": "building-2",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Send {amountLYD} LYD via Masarfi Pay with the code {reference} in the note.",
            "ar": "أرسل {amountLYD} د.ل عبر مصرفي باي مع الرمز {reference} في الملاحظة.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "onepay",
        "name": {"en": "OnePay", "ar": "ون باي"},
        "desc": {"en": "OnePay electronic wallet", "ar": "محفظة ون باي الإلكترونية"},
        "icon": "credit-card",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Pay {amountLYD} LYD via OnePay with the code {reference} in the note.",
            "ar": "ادفع {amountLYD} د.ل عبر ون باي مع الرمز {reference} في الملاحظة.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "yusr_pay",
        "name": {"en": "Yusr Pay", "ar": "يسر باي"},
        "desc": {"en": "National Commercial Bank wallet", "ar": "خاصة بالمصرف التجاري الوطني"},
        "icon": "wallet",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Pay {amountLYD} LYD via Yusr Pay with the code {reference} in the note.",
            "ar": "ادفع {amountLYD} د.ل عبر يسر باي مع الرمز {reference} في الملاحظة.",
        },
        "enabled": True,
        "webhook": None,
    },
    {
        "id": "yusr_pay_qr",
        "name": {"en": "Yusr Pay QR", "ar": "يسر باي باركود"},
        "desc": {"en": "Scan the QR code at the shop", "ar": "عبر مسح الباركود QR"},
        "icon": "qr-code",
        "requiresReceiptPhoto": False,
        "instructions": {
            "en": "Scan the shop QR, pay {amountLYD} LYD, and keep the code {reference}.",
            "ar": "امسح باركود المحل وادفع {amountLYD} د.ل واحتفظ بالرمز {reference}.",
        },
        "enabled": True,
        "webhook": None,
    },
    # Legacy ids from the first wallet release: old pending rows keep a label,
    # but pickers never offer them again.
    {
        "id": "card",
        "name": {"en": "Libyan card", "ar": "بطاقة ليبية"},
        "desc": {"en": "Legacy method", "ar": "طريقة قديمة"},
        "icon": "credit-card",
        "requiresReceiptPhoto": False,
        "instructions": {"en": "Pay with reference {reference}.", "ar": "ادفع بذكر الرمز {reference}."},
        "enabled": False,
        "webhook": None,
    },
    {
        "id": "qr",
        "name": {"en": "QR payment", "ar": "دفع QR"},
        "desc": {"en": "Legacy method", "ar": "طريقة قديمة"},
        "icon": "qr-code",
        "requiresReceiptPhoto": False,
        "instructions": {"en": "Pay with reference {reference}.", "ar": "ادفع بذكر الرمز {reference}."},
        "enabled": False,
        "webhook": None,
    },
)


def get_payment_method(method_id: str) -> dict | None:
    wanted = str(method_id or "").strip().lower()
    for entry in PAYMENT_METHOD_CATALOG:
        if entry["id"] == wanted:
            return entry
    return None


def enabled_payment_method_ids() -> frozenset[str]:
    return frozenset(e["id"] for e in PAYMENT_METHOD_CATALOG if e.get("enabled"))


def public_payment_methods() -> list[dict]:
    """Enabled entries only, minus server-internal keys."""
    out = []
    for entry in PAYMENT_METHOD_CATALOG:
        if not entry.get("enabled"):
            continue
        public = {k: v for k, v in entry.items() if k != "webhook"}
        out.append(public)
    return out


def latest_usd_lyd_rate() -> tuple[float, str] | None:
    """Newest exchangeRateHistory row by data.date — the same rule the client
    uses for state.defaultExchangeRate. None until a rate exists."""
    from sqlalchemy import text

    from .db import db_conn, json_loads
    from .financial_core import MAX_EXCHANGE_RATE, MIN_EXCHANGE_RATE

    try:
        with db_conn() as conn:
            rows = conn.execute(
                text("SELECT data_json FROM entities WHERE type='exchangeRateHistory' AND deleted=false")
            ).mappings().all()
        best = None
        for row in rows:
            data = json_loads(row.get("data_json") or "{}") or {}
            date = str(data.get("date") or "")
            try:
                rate_value = float(data.get("rate"))
            except (TypeError, ValueError):
                continue  # a garbage row must never stamp rate 1.0 on real cash
            if not (MIN_EXCHANGE_RATE <= rate_value <= MAX_EXCHANGE_RATE):
                continue
            if best is None or date > best[1]:
                best = (rate_value, date)
        return best
    except Exception:
        return None
