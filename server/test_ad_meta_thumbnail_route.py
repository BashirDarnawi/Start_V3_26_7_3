"""Albayan's archived copy of a Meta ad creative is served by id.

Lean ad lists omit metaThumbnailData and the signed fbcdn link beside it expires,
so before this route an old, closed-month or deleted-at-Meta ad showed "Ad photo
is loading from Meta" forever. Access is reading the ad (a Delivery user only for
their own job); the Meta tile never needed View Photos.
"""
import base64
import secrets

import pytest
from sqlalchemy import text

from server import test_receipt_company_coverages as t
from server.db import db_conn, json_dumps, now_ms
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
SIGNED = "https://scontent.xx.fbcdn.net/v/t45.1600-4/123456789_987654321_n.jpg?oh=x&oe=66AA0000"
TAG = secrets.token_hex(4)
PASSWORD = "MetaThumbnailRoute123!Secure"


def _user(name: str, role: str, permissions: dict) -> dict:
    pw = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
    uid, email = new_id("user"), f"meta-thumb-{name}-{TAG}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,password_algo,"
                 "password_iterations,deleted,created_at,created_by,last_modified) VALUES (:id,:name,:email,:role,:perm,"
                 ":h,:s,:a,:i,false,:t,NULL,:t)"),
            {"id": uid, "name": name, "email": email, "role": role, "perm": json_dumps(permissions),
             "h": pw.hash_hex, "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "t": now_ms()},
        )
    return {"id": uid, "cookies": t._login(email, PASSWORD)}


def _ad(creator: str, *, deleted: bool = False, **data) -> str:
    ad_id, stamp = f"meta_thumb_{secrets.token_hex(5)}", now_ms()
    row = {"id": ad_id, "recordType": "ad", "metaAdId": "120000000000777", "metaThumbnailUrl": SIGNED,
           "metaThumbnailArchivedFrom": SIGNED, "createdBy": creator, "_created": stamp, "_lastModified": stamp, **data}
    with db_conn() as conn:
        conn.execute(text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                          "VALUES ('ads',:id,:d,:deleted,:t,:u,:t)"),
                     {"id": ad_id, "d": json_dumps(row), "deleted": deleted, "t": stamp, "u": creator})
    return ad_id


def _get(ad_id: str, cookies: dict):
    return t.client.get(f"/api/collections/ads/{ad_id}/meta-thumbnail?v=1", cookies=cookies)


@pytest.fixture(scope="module")
def actors():
    base = t.actors.__wrapped__()
    return {
        **base,
        "viewer": _user("viewer", "Employee", {"ads": ["view"]}),             # ads.view, no viewPhotos
        "own": _user("own", "Employee", {"ads": ["viewOwn"]}),
        "outsider": _user("outsider", "Employee", {"receipts": ["view"]}),     # no ads.view at all
        "driver": _user("driver", "Delivery", {"ads": ["view"], "deliveries": ["viewOwn"]}),
    }


def test_an_ads_viewer_gets_the_archived_creative_without_view_photos(actors):
    ad_id = _ad(actors["admin_id"], metaThumbnailData=PNG)
    for who in ("viewer", "admin"):
        served = _get(ad_id, actors[who]["cookies"] if who == "viewer" else actors[who])
        assert served.status_code == 200, (who, served.text)  # before: 404, no such route
        assert served.headers["content-type"].startswith("image/png")
        assert served.content == base64.b64decode(PNG.split(",", 1)[1])
        assert served.headers["cache-control"] == "private, max-age=300"


def test_without_ads_view_or_outside_a_drivers_own_job_it_is_403(actors):
    ad_id = _ad(actors["admin_id"], metaThumbnailData=PNG)
    assert _get(ad_id, actors["outsider"]["cookies"]).status_code == 403
    assert _get(ad_id, actors["own"]["cookies"]).status_code == 403             # viewOwn on someone else's ad
    assert _get(ad_id, actors["driver"]["cookies"]).status_code == 403          # not this driver's job
    mine = _ad(actors["own"]["id"], metaThumbnailData=PNG)
    assert _get(mine, actors["own"]["cookies"]).status_code == 200
    job = _ad(actors["admin_id"], metaThumbnailData=PNG, deliveryPersonId=actors["driver"]["id"])
    assert _get(job, actors["driver"]["cookies"]).status_code == 200


def test_no_archived_copy_a_remote_value_or_a_deleted_ad_is_404(actors):
    viewer = actors["viewer"]["cookies"]
    assert _get(_ad(actors["admin_id"]), viewer).status_code == 404                        # never archived
    assert _get(_ad(actors["admin_id"], metaThumbnailData=SIGNED), viewer).status_code == 404  # never an open proxy
    assert _get(_ad(actors["admin_id"], metaThumbnailData=PNG, deleted=True), viewer).status_code == 404
    assert _get(f"meta_thumb_missing_{TAG}", viewer).status_code == 404
