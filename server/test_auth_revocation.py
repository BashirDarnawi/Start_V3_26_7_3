"""Credential rotation must revoke old access, including in-flight issuers.

All records are disposable test accounts. Legacy rows are inserted without
today's issue routes so old unexpired codes cannot escape the same protection.
"""

import hashlib
import json
import secrets
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

import server.main as main
from server.db import db_conn, init_db, now_ms
from server.security import hash_password, hash_token, new_id, verify_password


OLD_PASSWORD = "RevocationBefore123!"
NEW_PASSWORD = "RevocationAfter123!"
COMPETING_PASSWORD = "OtherRotation123!"


def _request(method, path, *, cookie=None, body=None):
    headers = {"Origin": "http://testserver"}
    if cookie:
        headers["Cookie"] = f"albayan_session={cookie}"
    # Do not share a mutable browser cookie jar between concurrent requests.
    client = TestClient(main.app, headers=headers)
    return client.request(method, path, json=body)


def _seed_user(*, role="Employee", iterations=600_000):
    uid = new_id("revocation")
    email = f"{uid}@tests.albayanhub.com"
    pw = hash_password(OLD_PASSWORD, iterations=iterations)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                 "password_algo,password_iterations,deleted,created_at,last_modified) "
                 "VALUES (:id,'Revocation test',:email,:role,'{}',:h,:s,:a,:i,false,:n,:n)"),
            {"id": uid, "email": email, "role": role, "h": pw.hash_hex,
             "s": pw.salt_hex, "a": pw.algo, "i": pw.iterations, "n": now_ms()},
        )
    return {"id": uid, "email": email}


def _login(user, password=OLD_PASSWORD, *, remember=False):
    return _request("POST", "/api/auth/login", body={
        "email": user["email"], "password": password, "rememberMe": remember,
    })


def _cookie(response):
    assert response.status_code == 200, response.text
    value = response.cookies.get("albayan_session")
    assert value
    return value


def _raw_reset(uid):
    token = secrets.token_urlsafe(32)
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO password_resets (id,user_id,token_hash,created_at,expires_at) "
                 "VALUES (:id,:uid,:h,:n,:e)"),
            {"id": new_id("oldreset"), "uid": uid, "h": hash_token(token),
             "n": now_ms(), "e": now_ms() + 600_000},
        )
    return token


def _issue_credentials(user, cookie, *, legacy=False):
    verifier = secrets.token_hex(32)
    challenge = hashlib.sha256(verifier.encode()).hexdigest()
    if legacy:
        code = secrets.token_urlsafe(32)
        with db_conn() as conn:
            conn.execute(
                text("INSERT INTO app_logins (id,user_id,code_hash,challenge_hash,created_at,expires_at) "
                     "VALUES (:id,:uid,:h,:challenge,:n,:e)"),
                {"id": new_id("oldapp"), "uid": user["id"], "h": hash_token(code),
                 "challenge": challenge, "n": now_ms(), "e": now_ms() + 600_000},
            )
        reset = _raw_reset(user["id"])
    else:
        handoff = _request("POST", "/api/auth/app-login/handoff", cookie=cookie,
                           body={"challenge": challenge, "platform": "ios"})
        assert handoff.status_code == 200, handoff.text
        code = handoff.json()["code"]
        response = _request("POST", "/api/auth/password-reset/request", body={"email": user["email"]})
        assert response.status_code == 200, response.text
        reset = response.json()["resetCode"]
    return code, verifier, reset


def _exchange(code, verifier):
    return _request("POST", "/api/auth/app-login/exchange", body={"code": code, "verifier": verifier})


def _admin_rotate(user, password=COMPETING_PASSWORD):
    pw = hash_password(password)
    main._apply_user_update_atomic(user["id"], {
        "password_hash": pw.hash_hex, "password_salt": pw.salt_hex,
        "password_algo": pw.algo, "password_iterations": pw.iterations,
        "last_modified": now_ms(),
    }, {"id": "test-admin", "role": "Admin"})


def _credential_counts(uid):
    with db_conn() as conn:
        return {
            table: conn.execute(text(f"SELECT COUNT(*) FROM {table} WHERE user_id=:uid"),
                                {"uid": uid}).scalar()
            for table in ("sessions", "app_logins", "password_resets")
        }


@pytest.fixture(autouse=True)
def isolated_auth_limits(monkeypatch):
    init_db()
    # These tests target revocation, not shared global rate buckets. Existing
    # auth-limit suites exercise the genuine rate-limiting policy separately.
    for name in ("_rate_check", "_reset_rate_check", "_reset_confirm_rate_check",
                 "_app_handoff_rate_check", "_app_exchange_rate_check"):
        monkeypatch.setattr(main, name, lambda *args, **kwargs: (True, 0))
    monkeypatch.setattr(main, "DEBUG_MODE", True)
    monkeypatch.setattr(main, "PASSWORD_RESET_DEV_RETURN_CODE", True)


@pytest.mark.parametrize("operation", ["change", "reset", "admin-reset", "delete"])
@pytest.mark.parametrize("legacy", [False, True], ids=["current-api", "legacy-raw"])
def test_rotation_revokes_all_preexisting_credentials(operation, legacy):
    user = _seed_user()
    cookie = _cookie(_login(user))
    code, verifier, reset = _issue_credentials(user, cookie, legacy=legacy)
    # Historic races could leave more than one reset row; revoke all of them.
    second_reset = _raw_reset(user["id"])
    if operation == "change":
        response = _request("POST", "/api/auth/password-change", cookie=cookie,
                            body={"currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD})
    elif operation == "reset":
        response = _request("POST", "/api/auth/password-reset/confirm",
                            body={"token": reset, "newPassword": NEW_PASSWORD})
    else:
        admin = _seed_user(role="Admin")
        response = _request("PATCH", f"/api/users/{user['id']}", cookie=_cookie(_login(admin)),
                            body={"deleted": True} if operation == "delete" else {"password": NEW_PASSWORD})
    assert response.status_code == 200, response.text
    assert _credential_counts(user["id"]) == {"sessions": 0, "app_logins": 0, "password_resets": 0}
    assert _request("GET", "/api/auth/me", cookie=cookie).status_code == 401
    assert _exchange(code, verifier).status_code == 400
    for token in (reset, second_reset):
        assert _request("POST", "/api/auth/password-reset/confirm", body={
            "token": token, "newPassword": COMPETING_PASSWORD,
        }).status_code == 400

    if operation != "delete":
        # Normal remembered web and newly connected native sessions still work.
        fresh_cookie = _cookie(_login(user, NEW_PASSWORD, remember=True))
        fresh_code, fresh_verifier, _ = _issue_credentials(user, fresh_cookie)
        app_cookie = _cookie(_exchange(fresh_code, fresh_verifier))
        assert _request("GET", "/api/auth/me", cookie=app_cookie).status_code == 200
    else:
        assert _login(user).status_code == 401


def test_logout_revokes_pending_handoff_but_keeps_other_device_session():
    user = _seed_user()
    cookie = _cookie(_login(user))
    other_cookie = _cookie(_login(user))
    code, verifier, _ = _issue_credentials(user, cookie)
    assert _request("POST", "/api/auth/logout", cookie=cookie).status_code == 200
    assert _exchange(code, verifier).status_code == 400
    assert _request("GET", "/api/auth/me", cookie=cookie).status_code == 401
    assert _request("GET", "/api/auth/me", cookie=other_cookie).status_code == 200


@pytest.mark.parametrize("iterations", [600_000, 120_000], ids=["current-hash", "legacy-hash"])
def test_reset_after_password_verification_prevents_session_creation(monkeypatch, iterations):
    user = _seed_user(iterations=iterations)
    original = main.upgrade_password_hash_after_login

    def rotate_after_verification(snapshot, password):
        result = original(snapshot, password)
        _admin_rotate(user)
        return result

    monkeypatch.setattr(main, "upgrade_password_hash_after_login", rotate_after_verification)
    response = _login(user)
    assert response.status_code == 409, response.text
    assert not response.cookies.get("albayan_session")
    assert _credential_counts(user["id"])["sessions"] == 0


def test_legacy_password_upgrade_still_creates_valid_session():
    user = _seed_user(iterations=120_000)
    cookie = _cookie(_login(user))
    current = main._get_user_by_id(user["id"])
    assert current["password_iterations"] == 600_000
    assert _request("GET", "/api/auth/me", cookie=cookie).status_code == 200


@pytest.mark.parametrize("operation", ["password-change", "reset-confirm"])
def test_rotation_during_expensive_password_hash_cannot_be_overwritten(monkeypatch, operation):
    user = _seed_user()
    cookie = _cookie(_login(user))
    reset = _raw_reset(user["id"])
    original = main.hash_password

    def hash_with_competing_rotation(password, **kwargs):
        result = original(password, **kwargs)
        if password == NEW_PASSWORD:
            _admin_rotate(user)
        return result

    monkeypatch.setattr(main, "hash_password", hash_with_competing_rotation)
    if operation == "password-change":
        response = _request("POST", "/api/auth/password-change", cookie=cookie,
                            body={"currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD})
        assert response.status_code == 409, response.text
    else:
        response = _request("POST", "/api/auth/password-reset/confirm",
                            body={"token": reset, "newPassword": NEW_PASSWORD})
        assert response.status_code == 400, response.text
    current = main._get_user_by_id(user["id"])
    assert verify_password(COMPETING_PASSWORD, current["password_hash"], current["password_salt"],
                           current["password_algo"], current["password_iterations"])
    assert _credential_counts(user["id"])["sessions"] == 0


def test_handoff_rechecks_session_after_authentication(monkeypatch):
    user = _seed_user()
    cookie = _cookie(_login(user))

    def rotate_before_handoff(*args):
        _admin_rotate(user)
        return True, 0

    monkeypatch.setattr(main, "_app_handoff_rate_check", rotate_before_handoff)
    response = _request("POST", "/api/auth/app-login/handoff", cookie=cookie,
                        body={"challenge": hashlib.sha256(b"x" * 32).hexdigest()})
    assert response.status_code == 401, response.text
    assert _credential_counts(user["id"])["app_logins"] == 0


@pytest.mark.parametrize("operation", ["exchange", "reset-request"])
def test_rotation_between_capability_lookup_and_user_lock(monkeypatch, operation):
    user = _seed_user()
    cookie = _cookie(_login(user))
    code, verifier, _ = _issue_credentials(user, cookie)
    original = main._auth_mutation_guard
    rotated = False

    @contextmanager
    def rotate_once_before_lock():
        nonlocal rotated
        if not rotated:
            rotated = True
            _admin_rotate(user)
        with original():
            yield

    monkeypatch.setattr(main, "_auth_mutation_guard", rotate_once_before_lock)
    if operation == "exchange":
        response = _exchange(code, verifier)
        assert response.status_code == 400, response.text
    else:
        response = _request("POST", "/api/auth/password-reset/request", body={"email": user["email"]})
        assert response.status_code == 200, response.text
        assert "resetCode" not in response.json()
    assert _credential_counts(user["id"]) == {"sessions": 0, "app_logins": 0, "password_resets": 0}


def test_parallel_code_exchange_creates_exactly_one_app_session():
    user = _seed_user()
    cookie = _cookie(_login(user))
    code, verifier, _ = _issue_credentials(user, cookie)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: _exchange(code, verifier), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 400]
    assert _credential_counts(user["id"])["sessions"] == 2  # web + one app


def test_privacy_anonymization_removes_legacy_device_handoff_metadata():
    user = _seed_user()
    cookie = _cookie(_login(user))
    _issue_credentials(user, cookie, legacy=True)
    # Simulate an account disabled before this fix, with retained token rows.
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET deleted=true WHERE id=:uid"), {"uid": user["id"]})
    main._privacy_anonymize_deleted_user_atomic(user["id"])
    assert _credential_counts(user["id"]) == {"sessions": 0, "app_logins": 0, "password_resets": 0}


@pytest.mark.parametrize("role", ["Delivery", "Employee"])
@pytest.mark.parametrize("collection", ["walletTransactions", "serviceSubscriptions", "walletPaymentRequests"])
def test_personal_record_hydration_matches_own_only_list_scope(role, collection):
    user = _seed_user(role=role)
    other = _seed_user()
    cookie = _cookie(_login(user))
    ids = {"own": new_id("personal"), "other": new_id("personal"), "deleted": new_id("personal")}
    for name, eid in ids.items():
        owner = other["id"] if name == "other" else user["id"]
        data = {"userId": owner, "amountMinor": 500, "currency": "LYD", "status": "pending"}
        if collection == "walletTransactions":
            data.update({"fromUserId": "", "toUserId": owner, "type": "credit"})
        if collection == "walletPaymentRequests":
            data["receiptPhoto"] = "data:image/png;base64,YQ=="
        main.upsert_entity(collection, eid, data, owner, create_if_missing=True)
    with db_conn() as conn:
        conn.execute(text("UPDATE entities SET deleted=true WHERE type=:t AND id=:id"),
                     {"t": collection, "id": ids["deleted"]})

    listing = _request("GET", f"/api/collections/{collection}", cookie=cookie)
    assert listing.status_code == 200, listing.text
    assert {row["id"] for row in listing.json()} == {ids["own"]}
    own = _request("GET", f"/api/collections/{collection}/{ids['own']}", cookie=cookie)
    assert own.status_code == 200, own.text
    assert own.json()["id"] == ids["own"]
    if collection == "walletPaymentRequests":
        assert "receiptPhoto" not in listing.json()[0]["data"]
        assert own.json()["data"]["receiptPhoto"] == "data:image/png;base64,YQ=="
    assert _request("GET", f"/api/collections/{collection}/{ids['other']}", cookie=cookie).status_code == 403
    assert _request("GET", f"/api/collections/{collection}/{ids['deleted']}", cookie=cookie).status_code == 404


def test_driver_personal_reads_do_not_unlock_unassigned_business_records():
    user = _seed_user(role="Delivery")
    cookie = _cookie(_login(user))
    ad_id = new_id("unassigned")
    main.upsert_entity("ads", ad_id, {"deliveryPersonId": "other-driver"}, "other-user", create_if_missing=True)
    assert _request("GET", f"/api/collections/ads/{ad_id}", cookie=cookie).status_code == 403


def _photo_actor_context(extra_permissions):
    user = _seed_user()
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET permissions_json=:p WHERE id=:id"), {
            "id": user["id"], "p": json.dumps({
                "ads": ["view", "add", "edit", *extra_permissions],
                "receipts": ["view", "edit"],
            }),
        })
    customer_id, receipt_id = new_id("photoCustomer"), new_id("photoReceipt")
    phone = "09" + str(secrets.randbelow(100_000_000)).zfill(8)
    main.upsert_entity("customers", customer_id, {"name": "Photo customer", "phone": phone}, user["id"], create_if_missing=True)
    main.upsert_entity("receipts", receipt_id, {
        "customerId": customer_id, "status": "Not Paid", "amountUSD": 0, "amountLocal": 0,
        "debtAmountUSD": 100, "debtAmountLocal": 1000, "exchangeRate": 10,
        "tempReceiptNo": "D" + str(secrets.randbelow(10**14)),
        "deliveryStatus": "Needs Delivery", "deliveryPersonId": "test-driver",
    }, user["id"], create_if_missing=True)
    data = {
        "customerId": customer_id, "paymentStatus": "not_paid", "collectionMethod": "driver",
        "driverBudgetUSD": 10, "exchangeRate": 10, "linkedDeliveryReceiptId": receipt_id,
        "receiptId": receipt_id,
    }
    return user, _cookie(_login(user)), data


def _financial_photo_request(cookie, data, *, existing=None):
    return _request("POST", "/api/ads/mutate", cookie=cookie, body={
        "action": "update" if existing else "create",
        "adId": existing["id"] if existing else new_id("photoAd"),
        "idempotencyKey": new_id("photoMutation"),
        "expectedLastModified": existing["lastModified"] if existing else None,
        "data": data,
    })


@pytest.mark.parametrize("field", ["adPhotos", "photos"], ids=["current-field", "legacy-alias"])
@pytest.mark.parametrize("grants", [[], ["viewPhotos"], ["uploadPhotos"], ["viewPhotos", "uploadPhotos"]],
                         ids=["neither", "view-only", "upload-only", "both"])
def test_photo_permissions_cover_generic_and_financial_create_update(field, grants):
    user, cookie, funding = _photo_actor_context(grants)
    photo = "data:image/png;base64,YQ=="
    expected_create = 200 if "uploadPhotos" in grants else 403
    expected_update = 200 if {"viewPhotos", "uploadPhotos"}.issubset(grants) else 403

    generic = _request("POST", "/api/collections/ads", cookie=cookie,
                       body={"id": new_id("genericPhoto"), "data": {field: [photo]}})
    assert generic.status_code == expected_create, generic.text
    financial = _financial_photo_request(cookie, {**funding, field: [photo]})
    assert financial.status_code == expected_create, financial.text

    # Server-created legacy fixtures bypass today's upload route on purpose.
    ad = main.upsert_entity("ads", new_id("existingPhoto"), {
        **funding, "amountUSD": 10, "amountLocal": 100, "status": "Active", field: [photo],
    }, user["id"], create_if_missing=True)
    generic_update = _request("PATCH", f"/api/collections/ads/{ad['id']}", cookie=cookie,
                              body={"data": {field: []}, "expectedLastModified": ad["lastModified"]})
    assert generic_update.status_code == expected_update, generic_update.text
    expected_photos = [] if expected_update == 200 else [photo]
    assert main.get_entity("ads", ad["id"])["data"][field] == expected_photos

    ad = main.upsert_entity("ads", new_id("fundedPhoto"), {
        **funding, "amountUSD": 10, "amountLocal": 100, "status": "Active", field: [photo],
    }, user["id"], create_if_missing=True)
    financial_update = _financial_photo_request(cookie, {field: []}, existing=ad)
    assert financial_update.status_code == expected_update, financial_update.text
    assert main.get_entity("ads", ad["id"])["data"][field] == expected_photos


@pytest.mark.parametrize("financial", [False, True], ids=["generic-patch", "financial-update"])
def test_text_edits_preserve_hidden_photos_and_accept_unchanged_legacy_echoes(financial):
    user, cookie, funding = _photo_actor_context([])
    photos = ["data:image/png;base64,YQ=="]
    ad = main.upsert_entity("ads", new_id("unchangedPhoto"), {
        **funding, "amountUSD": 10, "amountLocal": 100, "status": "Active", "photos": photos,
    }, user["id"], create_if_missing=True)
    for updates in ({"notes": "Edit without hydration"}, {"photos": photos, "adPhotos": []}):
        if financial:
            response = _financial_photo_request(cookie, updates, existing=ad)
        else:
            response = _request("PATCH", f"/api/collections/ads/{ad['id']}", cookie=cookie,
                                body={"data": updates, "expectedLastModified": ad["lastModified"]})
        assert response.status_code == 200, response.text
        ad = main.get_entity("ads", ad["id"])
        assert ad["data"]["photos"] == photos


def test_selecting_existing_main_photo_needs_view_not_upload_permission():
    user, cookie, funding = _photo_actor_context(["viewPhotos"])
    ad = main.upsert_entity("ads", new_id("mainPhoto"), {
        **funding, "status": "Active", "adPhotos": ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="],
        "primaryAdPhotoIndex": 0,
    }, user["id"], create_if_missing=True)
    allowed = _request("PATCH", f"/api/collections/ads/{ad['id']}", cookie=cookie,
                       body={"data": {"primaryAdPhotoIndex": 1}})
    assert allowed.status_code == 200, allowed.text
    with db_conn() as conn:
        conn.execute(text("UPDATE users SET permissions_json=:p WHERE id=:id"), {
            "p": json.dumps({"ads": ["view", "edit"]}), "id": user["id"],
        })
    denied = _request("PATCH", f"/api/collections/ads/{ad['id']}", cookie=cookie,
                      body={"data": {"primaryAdPhotoIndex": 0}})
    assert denied.status_code == 403, denied.text
    assert main.get_entity("ads", ad["id"])["data"]["primaryAdPhotoIndex"] == 1


def test_photo_permission_check_uses_locked_state_after_concurrent_upload(monkeypatch):
    user, cookie, funding = _photo_actor_context([])
    ad = main.upsert_entity("ads", new_id("racingPhoto"), {**funding, "adPhotos": []}, user["id"], create_if_missing=True)
    original = main.patch_entity
    photo = "data:image/png;base64,YQ=="

    def upload_between_route_read_and_locked_write(*args, **kwargs):
        # An authorized concurrent/internal upload after the route's first read.
        original("ads", ad["id"], {"adPhotos": [photo]}, "system")
        return original(*args, **kwargs)

    monkeypatch.setattr(main, "patch_entity", upload_between_route_read_and_locked_write)
    response = _request("PATCH", f"/api/collections/ads/{ad['id']}", cookie=cookie,
                        body={"data": {"adPhotos": []}})
    assert response.status_code == 403, response.text
    assert main.get_entity("ads", ad["id"])["data"]["adPhotos"] == [photo]
