"""Server-side bookkeeping for staff-confirmed final Meta ad spend."""

from __future__ import annotations

from typing import Any, Callable

from .financial_core import _financial_minor, _financial_usd


def confirm_final_ad_spend(
    plan: dict[str, Any],
    ad: dict[str, Any],
    actor: dict[str, Any],
    spent_minor_usd: int,
    iso_utc: Callable[[], str],
    sanitize_str: Callable[[str, int], str],
) -> dict[str, Any]:
    """Freeze an operator-confirmed spend while retaining raw Meta evidence."""
    confirmed_at = iso_utc()
    actor_id = str(actor.get("id") or "")
    actor_name = sanitize_str(str(actor.get("name") or ""), 120) or "System"
    previous_spent_minor = (
        _financial_minor(ad.get("spentUSD"), "previous final ad spend")
        if ad.get("spentUSD") not in (None, "")
        else None
    )
    raw_meta_minor: int | None = None
    try:
        if ad.get("metaSpendMinor") not in (None, ""):
            raw_meta_minor = min(max(int(ad.get("metaSpendMinor")), 0), 1_000_000_000)
        elif (
            str(ad.get("metaCurrency") or "").upper() == "USD"
            and ad.get("metaSpend") not in (None, "")
        ):
            raw_meta_minor = _financial_minor(ad.get("metaSpend"), "Meta ad spend")
    except (TypeError, ValueError, OverflowError):
        # Provider metadata is evidence only and must not block reconciliation.
        raw_meta_minor = None

    plan["manualSpentOverride"] = True
    plan["finalSpendConfirmedAt"] = confirmed_at
    plan["finalSpendConfirmedBy"] = actor_id
    if raw_meta_minor is not None:
        plan["finalSpendMetaMinorAtConfirmation"] = raw_meta_minor
        plan["finalSpendMetaCurrencyAtConfirmation"] = (
            sanitize_str(str(ad.get("metaCurrency") or "USD"), 12).upper() or "USD"
        )
    else:
        plan.pop("finalSpendMetaMinorAtConfirmation", None)
        plan.pop("finalSpendMetaCurrencyAtConfirmation", None)

    history = (
        [dict(row) for row in plan.get("editHistory", []) if isinstance(row, dict)]
        if isinstance(plan.get("editHistory"), list)
        else []
    )[-499:]
    if previous_spent_minor is not None:
        from_value = f"${_financial_usd(previous_spent_minor):.2f} confirmed"
    elif raw_meta_minor is not None and str(ad.get("metaCurrency") or "USD").upper() == "USD":
        from_value = f"${_financial_usd(raw_meta_minor):.2f} Meta"
    else:
        from_value = "Not confirmed"
    history.append(
        {
            "editedAt": confirmed_at,
            "editedBy": actor_name,
            "changes": [
                {
                    "field": "Final Spend (USD)",
                    "from": from_value,
                    "to": f"${_financial_usd(spent_minor_usd):.2f} manually confirmed",
                }
            ],
        }
    )
    plan["editHistory"] = history
    plan["editCount"] = len(history)
    return plan


def final_spend_audit_metadata(saved_data: dict[str, Any]) -> dict[str, Any]:
    """Return non-secret evidence describing a confirmed spend decision."""
    saved_spent = _financial_minor(saved_data.get("spentUSD"), "saved ad spend")
    raw_meta_minor = saved_data.get("finalSpendMetaMinorAtConfirmation")
    raw_meta_currency = str(saved_data.get("finalSpendMetaCurrencyAtConfirmation") or "")
    return {
        "manualSpentOverride": saved_data.get("manualSpentOverride") is True,
        "manualDiffersFromMeta": (
            isinstance(raw_meta_minor, int)
            and raw_meta_currency == "USD"
            and raw_meta_minor != saved_spent
        ),
        "metaSpendAtConfirmation": (
            _financial_usd(raw_meta_minor) if isinstance(raw_meta_minor, int) else None
        ),
        "metaCurrencyAtConfirmation": raw_meta_currency or None,
    }
