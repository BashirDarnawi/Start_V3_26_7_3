"""Photo sources on the transactional ad and receipt routes accept only image data URLs
uploaded from the device (the generic routes already refuse anything else)."""
import pytest

from server import test_receipt_company_coverages as t

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
REMOTE = "https://attacker.example/pixel.png"


@pytest.fixture(scope="module")
def actors():
    return t.actors.__wrapped__()


def _update(ad, data, key, actors):
    return t.client.post("/api/ads/mutate", json={
        "action": "update", "adId": ad["id"], "idempotencyKey": key,
        "expectedLastModified": ad["lastModified"], "data": data,
    }, cookies=actors["admin"])


def test_ad_mutate_refuses_remote_photos_and_serves_data_urls(actors):
    cid, rid, aid = "photo_tx_c", "photo_tx_r", "photo_tx_a"
    t._customer(cid, actors)
    t._unpaid_receipt(rid, cid, 200, actors)
    created = t.client.post("/api/ads/mutate", json={
        "action": "create", "adId": aid, "idempotencyKey": aid + "-create-remote",
        "data": {"customerId": cid, "paymentStatus": "not_paid", "collectionMethod": "in_shop", "exchangeRate": 5,
                 "receiptId": rid, "dueAllocations": [{"receiptId": rid, "amountUSD": 100}], "receiptAllocations": [],
                 "adPhotos": [REMOTE]},
    }, cookies=actors["admin"])
    assert created.status_code == 400, created.text
    ad = t._create_ad(aid, cid, rid, 100, actors)
    remote = _update(ad, {"adPhotos": [REMOTE]}, aid + "-remote", actors)
    assert remote.status_code == 400, remote.text
    accepted = _update(ad, {"adPhotos": [PNG]}, aid + "-png", actors)
    assert accepted.status_code == 200, accepted.text
    served = t.client.get(f"/api/collections/ads/{aid}/primary-photo?index=0", cookies=actors["admin"])
    assert served.status_code == 200, served.text
    assert served.headers["content-type"].startswith("image/png")


def test_settle_refuses_remote_receipt_photos(actors):
    cid, rid, aid = "photo_tx2_c", "photo_tx2_r", "photo_tx2_a"
    t._customer(cid, actors)
    t._unpaid_receipt(rid, cid, 200, actors)
    t._create_ad(aid, cid, rid, 100, actors)
    current = t.client.get(f"/api/collections/receipts/{rid}", cookies=actors["admin"]).json()
    refused = t.client.post(f"/api/receipts/{rid}/settle", json={
        "expectedLastModified": current["lastModified"], "idempotencyKey": rid + "-settle-remote",
        "data": {"photos": [REMOTE]},
    }, cookies=actors["admin"])
    assert refused.status_code == 400, refused.text
    still = t.client.get(f"/api/collections/receipts/{rid}", cookies=actors["admin"]).json()
    assert str(still["data"].get("status") or "") != "Paid"
