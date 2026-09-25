"""E2E-only seed door for the Albayan Studio browser tests (plan task P2-13; PLAN.md §7.3).

``POST /api/studio/test/seed-results`` writes one ``adCampaignResults`` row (Meta's view of one
request) the same way the results sync does (studio_results.write_results_row), so the browser
tests can show Meta-fed stages and the results card without a Meta connection. With ``link``
it first stamps the Meta link on the request (``metaAdAccountId`` + ``metaCampaignId``), which in
real life only the staff link step writes after Meta confirmed the campaign.

The door exists ONLY in the disposable e2e server (scripts/start-e2e-server.js). It is mounted
when ALL of these hold while the studio router is built:

* ``ALBAYAN_E2E_STUDIO_SEED`` is exactly ``true`` (unset, ``1``, ``TRUE`` or anything else = off);
* the database is SQLite. With the flag on and any other database (PostgreSQL = production),
  building the router raises, so that server refuses to start instead of running with a seed door;
* ``ALBAYAN_DB_PATH`` and the database file in use are the same file under ``<repo>/.tmp/e2e``
  (the database start-e2e-server.js deletes and recreates on every run).

Otherwise nothing is mounted and the path answers 404 like any unknown route. Even when mounted,
only a signed-in admin may call it (403 ADMIN_ONLY), from the site itself (403 CROSS_SITE).

Body: ``{campaignId, results: {<adCampaignResults fields>}, link?: {metaAdAccountId,
metaCampaignId}}``. Unknown result fields are dropped by normalize_results like any stored row.
Answer: ``{campaignId, linked, results}`` (the normalized row).
"""

import os
import re
from pathlib import Path
from typing import Any, Callable, Mapping

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.engine import make_url

from ...db import db_conn, get_database_url, json_dumps, json_loads, now_ms
from .ad_campaign_actions import AD_CAMPAIGN_COLLECTION
from .studio_errors import studio_error
from .studio_results import ResultsRowChanged, load_request, write_results_row

SEED_FLAG = "ALBAYAN_E2E_STUDIO_SEED"
DB_PATH_ENV = "ALBAYAN_DB_PATH"
# server/systems/ads_studio/<this file> -> the repository root, then the e2e scratch folder.
E2E_DB_DIR = Path(__file__).resolve().parents[3] / ".tmp" / "e2e"
BODY_FIELDS = ("campaignId", "results", "link")
LINK_FIELDS = ("metaAdAccountId", "metaCampaignId")
_CAMPAIGN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")
_META_ID_RE = re.compile(r"[0-9]{1,40}")


def _resolved(raw: str) -> Path | None:
    try:
        return Path(raw).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def e2e_seed_enabled(env: Mapping[str, str] | None = None, database_url: Any = None) -> bool:
    """True only inside the disposable e2e server; raises when the flag meets a real database."""
    env = os.environ if env is None else env
    if env.get(SEED_FLAG) != "true":
        return False
    url = make_url(database_url if database_url is not None else get_database_url())
    backend = url.get_backend_name()
    if backend != "sqlite":
        raise RuntimeError(
            f"{SEED_FLAG}=true is only for the disposable SQLite e2e database; "
            f"refusing to start the studio router on {backend}"
        )
    database = str(url.database or "")
    declared = str(env.get(DB_PATH_ENV) or "").strip()
    if not database or database == ":memory:" or database.startswith("file:") or not declared:
        return False
    in_use, wanted, folder = _resolved(database), _resolved(declared), _resolved(str(E2E_DB_DIR))
    if in_use is None or wanted is None or folder is None:
        return False
    return in_use == wanted and folder in in_use.parents


def _link_ids(raw: Any) -> tuple[str, str]:
    if not isinstance(raw, dict):
        studio_error(400, "INVALID_REQUEST", "link must be {metaAdAccountId, metaCampaignId}")
    extra = sorted(set(raw) - set(LINK_FIELDS))
    if extra:
        studio_error(400, "UNKNOWN_FIELD", f"Unknown field 'link.{str(extra[0])[:40]}'. Allowed: {', '.join(LINK_FIELDS)}")
    account = str(raw.get("metaAdAccountId") or "").strip()
    account = account[4:] if account.startswith("act_") else account
    campaign = str(raw.get("metaCampaignId") or "").strip()
    if not _META_ID_RE.fullmatch(account) or not _META_ID_RE.fullmatch(campaign):
        studio_error(400, "INVALID_VALUE", "link ids must be Meta ids (digits; the account may start with act_)")
    return f"act_{account}", campaign


def _stamp_link(conn: Any, campaign_id: str, account: str, campaign: str) -> None:
    """Write the Meta link on the request row (version-checked, like every entities write)."""
    row = conn.execute(
        text("SELECT data_json, last_modified FROM entities WHERE type = :type AND id = :id AND deleted = false"),
        {"type": AD_CAMPAIGN_COLLECTION, "id": campaign_id},
    ).mappings().first()
    if not row:
        studio_error(404, "UNKNOWN_CAMPAIGN", "Campaign request not found")
    baseline = int(row["last_modified"])
    modified = max(now_ms(), baseline + 1)
    data = json_loads(row["data_json"]) or {}
    data.update({"metaAdAccountId": account, "metaCampaignId": campaign, "_lastModified": modified})
    result = conn.execute(
        text(
            "UPDATE entities SET data_json = :data, last_modified = :modified "
            "WHERE type = :type AND id = :id AND last_modified = :baseline"
        ),
        {"data": json_dumps(data), "modified": modified, "type": AD_CAMPAIGN_COLLECTION, "id": campaign_id,
         "baseline": baseline},
    )
    if int(result.rowcount or 0) != 1:
        studio_error(409, "VERSION_CONFLICT", "The request changed while it was being seeded. Try again.")


def create_studio_e2e_seed_router(
    *,
    current_user_dependency: Callable[..., Any],
    require_same_origin: Callable[[Request], None],
    ctx: dict[str, Any],
) -> APIRouter | None:
    """The seed routes (under the studio router's /api/studio prefix), or None outside the e2e server."""
    if not e2e_seed_enabled():
        return None
    router = APIRouter()

    @router.post("/test/seed-results")
    def seed_results(request: Request, body: Any = Body(None), user: dict[str, Any] = Depends(current_user_dependency)):
        try:
            require_same_origin(request)
        except HTTPException as error:
            if error.status_code != 403:
                raise
            studio_error(403, "CROSS_SITE", "This change must come from the Albayan site itself")
        if str(user.get("role") or "").lower() != "admin":
            studio_error(403, "ADMIN_ONLY", "Only an admin can use this")
        if not isinstance(body, dict):
            studio_error(400, "INVALID_REQUEST", "Send {campaignId, results, link?}")
        extra = sorted(set(body) - set(BODY_FIELDS))
        if extra:
            studio_error(400, "UNKNOWN_FIELD", f"Unknown field '{str(extra[0])[:40]}'. Allowed: {', '.join(BODY_FIELDS)}")
        campaign_id = body.get("campaignId")
        if not isinstance(campaign_id, str) or not _CAMPAIGN_ID_RE.fullmatch(campaign_id):
            studio_error(400, "INVALID_REQUEST", "campaignId (a request id) is required")
        fields = body.get("results")
        if not isinstance(fields, dict):
            studio_error(400, "INVALID_REQUEST", "results must be an object of adCampaignResults fields")
        link = _link_ids(body["link"]) if body.get("link") is not None else None
        with db_conn() as conn:
            campaign = load_request(conn, campaign_id)
            if not campaign or campaign["archived"]:
                studio_error(404, "UNKNOWN_CAMPAIGN", "Campaign request not found")
            if link:
                _stamp_link(conn, campaign_id, *link)
                fields = {**fields, "metaAdAccountId": link[0], "metaCampaignId": link[1]}
            try:
                row = write_results_row(conn, campaign_id, campaign["ownerId"], fields)
            except ResultsRowChanged:
                studio_error(409, "VERSION_CONFLICT", "The results row changed while it was being seeded. Try again.")
        return {"campaignId": campaign_id, "linked": bool(link), "results": row}

    return router
