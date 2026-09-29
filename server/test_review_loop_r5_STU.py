"""Review loop round 5, batch STU: studio texts and screens (server side). Every test here failed before its fix.

* n10: an after-hours stop request offered the on-duty WhatsApp line (and the phone) "right now" at any hour,
  even after ``hours.onDutyUntil`` had passed (02:30 or 07:00 Tripoli time, late on a Friday night). The line
  is offered only inside the on-duty window: from the day's closing time (a closed day: its usual opening)
  until ``onDutyUntil``; with no ``onDutyUntil`` set nothing changes.

The client parts of the batch (n2, n26, n27, n28, n29) are checked in scripts/test-mobile-ui.js.

Every test builds its own users (unique e-mails per run) and removes every row they own afterwards (the stop
rows and their tickets too), and puts the studio settings back exactly.
"""

import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from server.db import db_conn, init_db, json_dumps, now_ms
from server.main import app
from server.rate_limiter import reset_rate_limit
from server.security import PBKDF2_ITERATIONS_DEFAULT, hash_password, new_id
from server.systems.ads_studio import studio_hours, studio_settings, studio_stop
from server.systems.ads_studio.studio_stop import STOP_TYPE, stop_row_id

TAG = secrets.token_hex(4)
PASSWORD = "ReviewLoopR5StuPassword123!"
_HASH = hash_password(PASSWORD, iterations=PBKDF2_ITERATIONS_DEFAULT)
client = TestClient(app, headers={"Origin": "http://testserver"})
CAMPAIGNS = "adCampaignRequests"
CUSTOMER_PERMISSIONS = {CAMPAIGNS: ["viewOwn", "add", "editOwn", "deleteOwn", "submitOwn", "stopOwn"]}
URGENT = "+218910000001"
PHONE = "+218210000002"
# Default hours: Sun-Thu 09:00-17:00 Tripoli time (UTC+2), Friday and Saturday closed.
THU_0230 = datetime(2026, 9, 24, 0, 30, tzinfo=timezone.utc)   # Thu 02:30 Tripoli: after the on-duty line ended
THU_0700 = datetime(2026, 9, 24, 5, 0, tzinfo=timezone.utc)    # Thu 07:00 Tripoli: before opening
THU_2000 = datetime(2026, 9, 24, 18, 0, tzinfo=timezone.utc)   # Thu 20:00 Tripoli: after closing, before 23:00
THU_2330 = datetime(2026, 9, 24, 21, 30, tzinfo=timezone.utc)  # Thu 23:30 Tripoli
FRI_0030 = datetime(2026, 9, 24, 22, 30, tzinfo=timezone.utc)  # Fri 00:30 Tripoli
FRI_0130 = datetime(2026, 9, 24, 23, 30, tzinfo=timezone.utc)  # Fri 01:30 Tripoli
FRI_1200 = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)   # Fri 12:00 Tripoli: a closed day, on duty
FRI_2330 = datetime(2026, 9, 25, 21, 30, tzinfo=timezone.utc)  # Fri 23:30 Tripoli: late on a Friday night
_USERS: list[str] = []
_counter = [0]


def _insert_user(label: str, role: str, permissions: dict) -> dict:
    _counter[0] += 1
    stamp = now_ms()
    user_id = new_id("rl5stu_user")
    email = f"review-loop-r5-stu-{label}-{TAG}-{_counter[0]}@tests.albayanhub.com"
    with db_conn() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id,name,email,role,permissions_json,password_hash,password_salt,"
                "password_algo,password_iterations,deleted,created_at,created_by,last_modified) "
                "VALUES (:id,:name,:email,:role,:permissions,:hash,:salt,:algo,:iterations,false,:stamp,NULL,:stamp)"
            ),
            {"id": user_id, "name": f"R5 STU {label}", "email": email, "role": role, "permissions": json_dumps(permissions),
             "hash": _HASH.hash_hex, "salt": _HASH.salt_hex, "algo": _HASH.algo, "iterations": _HASH.iterations,
             "stamp": stamp},
        )
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    cookies = {"albayan_session": response.cookies.get("albayan_session")}
    client.cookies.clear()
    _USERS.append(user_id)
    return {"id": user_id, "email": email, "cookies": cookies}


@pytest.fixture(scope="module")
def people():
    init_db()
    return {"owner": _insert_user("owner", "Employee", CUSTOMER_PERMISSIONS)}


@pytest.fixture(autouse=True)
def _isolated(people):
    """Settings rows put back exactly, every row of this module's users removed (stop rows and tickets too),
    rate limits reset."""
    with db_conn() as conn:
        saved = [dict(row) for row in conn.execute(text("SELECT * FROM entities WHERE type = 'studioSettings'")).mappings().all()]
    for uid in _USERS:
        for bucket in ("ad-studio:mutations", "studio:ticket-write", "studio:ticket-read"):
            reset_rate_limit(f"{bucket}:{uid}")
    studio_stop.reset_pulse_cache()
    yield
    with db_conn() as conn:
        for chunk in (_USERS[i:i + 50] for i in range(0, len(_USERS), 50)):
            params = {f"u{i}": uid for i, uid in enumerate(chunk)}
            names = ", ".join(f":u{i}" for i in range(len(chunk)))
            conn.execute(text(f"DELETE FROM entities WHERE created_by IN ({names})"), params)
        conn.execute(text("DELETE FROM entities WHERE type = 'studioSettings'"))
        for row in saved:
            conn.execute(
                text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                     "VALUES (:type,:id,:data_json,:deleted,:created_at,:created_by,:last_modified)"),
                row,
            )
    studio_stop.reset_pulse_cache()


def _setting(key: str, **fields) -> None:
    record = studio_settings.read_setting(key)
    studio_settings.save_setting(key, fields, record["version"], "", "2026-09-25T00:00:00Z", audit=lambda *args: None)


def _campaign(owner_id: str, label: str) -> str:
    campaign_id = f"rl5stu_{label}_{TAG}_{secrets.token_hex(3)}"
    stamp = now_ms()
    body = {"id": campaign_id, "createdBy": owner_id, "_created": stamp, "_lastModified": stamp, "_deleted": False,
            "name": f"R5 STU ad {label}", "status": "Approved", "creativeImages": ["data:image/png;base64,AAAA"],
            "studioRef": "ALB-S-ABCDEFGH"}
    with db_conn() as conn:
        conn.execute(
            text("INSERT INTO entities (type,id,data_json,deleted,created_at,created_by,last_modified) "
                 "VALUES (:type,:id,:data,false,:stamp,:owner,:stamp)"),
            {"type": CAMPAIGNS, "id": campaign_id, "data": json_dumps(body), "stamp": stamp, "owner": owner_id},
        )
    return campaign_id


def _ask_at(monkeypatch, user: dict, moment: datetime, label: str) -> dict:
    monkeypatch.setattr(studio_stop, "utc_now", lambda: moment)
    campaign_id = _campaign(user["id"], label)
    response = client.post(f"/api/ad-studio/campaigns/{campaign_id}/stop-request",
                           json={"operationId": f"stop-{secrets.token_hex(6)}"}, cookies=user["cookies"])
    assert response.status_code == 200, response.text
    assert response.json()["ticket"]["id"]
    return {"campaignId": campaign_id, **response.json()}


def _on_duty_setup(until: str | None = "23:00") -> None:
    _setting("rollout", services={"help": "on", "stopRequest": "on", "tiktok": "off"})
    _setting("hours", onDutyUntil=until)
    _setting("contact", urgentWhatsapp=URGENT, phone=PHONE)


# ------------------------------------------------------------------ n10: the stop answer keeps the on-duty window


def test_after_hours_stop_answer_offers_no_urgent_line_after_on_duty_ended(people, monkeypatch):
    _on_duty_setup("23:00")
    owner = people["owner"]
    for moment, label in ((THU_0230, "night"), (THU_0700, "early"), (FRI_2330, "fri_late")):
        answer = _ask_at(monkeypatch, owner, moment, label)
        assert answer["afterHours"] is True, label
        # Nobody answers "right now": nothing offered, the screen says the team handles it at the next opening.
        assert answer["urgentContact"] == {}, (label, answer["urgentContact"])
        with db_conn() as conn:  # the staff queue row is written the same as before
            stop =conn.execute(text("SELECT id FROM entities WHERE type = :t AND id = :id"),
                                {"t": STOP_TYPE, "id": stop_row_id(answer["campaignId"])}).first()
        assert stop is not None, label


def test_after_hours_stop_answer_still_offers_the_line_inside_the_on_duty_window(people, monkeypatch):
    _on_duty_setup("23:00")
    owner = people["owner"]
    for moment, label in ((THU_2000, "evening"), (FRI_1200, "friday")):
        answer = _ask_at(monkeypatch, owner, moment, label)
        assert answer["afterHours"] is True, label
        assert answer["urgentContact"] == {"whatsapp": URGENT, "phone": PHONE}, (label, answer["urgentContact"])


def test_without_an_on_duty_time_the_after_hours_answer_is_unchanged(people, monkeypatch):
    _on_duty_setup(None)
    answer = _ask_at(monkeypatch, people["owner"], THU_0230, "no_window")
    assert answer["afterHours"] is True and answer["urgentContact"] == {"whatsapp": URGENT, "phone": PHONE}


def test_a_repeated_stop_request_reads_the_window_at_the_time_of_the_repeat(people, monkeypatch):
    _on_duty_setup("23:00")
    owner = people["owner"]
    first = _ask_at(monkeypatch, owner, THU_2000, "repeat")
    assert first["urgentContact"] == {"whatsapp": URGENT, "phone": PHONE}
    monkeypatch.setattr(studio_stop, "utc_now", lambda: THU_2330)
    again = client.post(f"/api/ad-studio/campaigns/{first['campaignId']}/stop-request",
                        json={"operationId": f"stop-{secrets.token_hex(6)}"}, cookies=owner["cookies"])
    assert again.status_code == 200, again.text
    assert again.json()["ticket"]["id"] == first["ticket"]["id"] and again.json()["urgentContact"] == {}


def test_on_duty_window_rule():
    hours = {**studio_settings.default_value("hours"), "onDutyUntil": "23:00"}
    on_duty = studio_hours.on_duty_at
    assert on_duty(THU_2000, hours) and on_duty(FRI_1200, hours)
    assert not on_duty(THU_0230, hours) and not on_duty(THU_0700, hours) and not on_duty(FRI_2330, hours)
    assert not on_duty(THU_2330, hours)  # 23:00 has passed
    # a holiday on a working weekday: on duty from that weekday's usual opening
    holiday = {**hours, "holidays": [{"date": "2026-09-24", "labelEn": "", "labelAr": ""}]}
    assert on_duty(datetime(2026, 9, 24, 10, 0, tzinfo=timezone.utc), holiday)  # Thu 12:00
    assert not on_duty(THU_0700, holiday)
    # past midnight: 01:00 carries the evening into the next morning
    late = {**hours, "onDutyUntil": "01:00"}
    assert on_duty(THU_2330, late) and on_duty(FRI_0030, late) and not on_duty(FRI_0130, late) and not on_duty(THU_0700, late)
    # the on-duty time equal to closing: no window; none set: always (unchanged behaviour)
    assert not on_duty(THU_2000, {**hours, "onDutyUntil": "17:00"})
    assert on_duty(THU_0230, {**hours, "onDutyUntil": None})
    # the whole settings work too (as _answer passes them)
    assert on_duty(THU_2000, {"hours": hours}) and not on_duty(THU_0230, {"hours": hours})
