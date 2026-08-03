"""App-link verification files: silent until configured, strict once they are.

Serving a malformed file is worse than serving none — the platform silently
falls back to the unverified custom scheme while the owner believes deep-link
hijacking is fixed. So a bad value must produce a 404, never a broken file.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

from fastapi.testclient import TestClient

from server.main import ORIGIN_BYPASS_PATHS, app

client = TestClient(app)

GOOD_FINGERPRINT = ":".join(["AB"] * 32)
OTHER_FINGERPRINT = ":".join(["CD"] * 32)

ANDROID_PATH = "/.well-known/assetlinks.json"
APPLE_PATH = "/.well-known/apple-app-site-association"


def test_both_files_are_absent_until_configured(monkeypatch):
    monkeypatch.delenv("ALBAYAN_ANDROID_CERT_FINGERPRINTS", raising=False)
    monkeypatch.delenv("ALBAYAN_IOS_APP_ID", raising=False)
    assert client.get(ANDROID_PATH).status_code == 404
    assert client.get(APPLE_PATH).status_code == 404


def test_android_file_names_the_app_and_its_fingerprints(monkeypatch):
    monkeypatch.setenv("ALBAYAN_ANDROID_CERT_FINGERPRINTS", f"{GOOD_FINGERPRINT}, {OTHER_FINGERPRINT}")
    monkeypatch.setenv("ALBAYAN_ANDROID_PACKAGE", "com.albayan.app")
    response = client.get(ANDROID_PATH)
    assert response.status_code == 200, response.text
    body = json.loads(response.text)
    assert body[0]["target"]["package_name"] == "com.albayan.app"
    assert body[0]["target"]["sha256_cert_fingerprints"] == [GOOD_FINGERPRINT, OTHER_FINGERPRINT]
    assert "delegate_permission/common.handle_all_urls" in body[0]["relation"]


def test_a_malformed_fingerprint_is_dropped_rather_than_published(monkeypatch):
    monkeypatch.setenv("ALBAYAN_ANDROID_PACKAGE", "com.albayan.app")
    # Too short, wrong separator, and outright junk.
    for bad in ("AB:CD", GOOD_FINGERPRINT.replace(":", ""), "not-a-fingerprint"):
        monkeypatch.setenv("ALBAYAN_ANDROID_CERT_FINGERPRINTS", bad)
        assert client.get(ANDROID_PATH).status_code == 404, f"published a bad fingerprint: {bad}"
    # A good one beside a bad one keeps only the good one.
    monkeypatch.setenv("ALBAYAN_ANDROID_CERT_FINGERPRINTS", f"nonsense,{GOOD_FINGERPRINT}")
    body = json.loads(client.get(ANDROID_PATH).text)
    assert body[0]["target"]["sha256_cert_fingerprints"] == [GOOD_FINGERPRINT]


def test_apple_file_is_json_without_a_json_extension(monkeypatch):
    monkeypatch.setenv("ALBAYAN_IOS_APP_ID", "ABCDE12345.com.albayan.app")
    response = client.get(APPLE_PATH)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    body = json.loads(response.text)
    assert body["applinks"]["details"][0]["appID"] == "ABCDE12345.com.albayan.app"


def test_a_malformed_apple_app_id_is_not_published(monkeypatch):
    for bad in ("com.albayan.app", "SHORT.com.albayan.app", "abcde12345.com.albayan.app"):
        monkeypatch.setenv("ALBAYAN_IOS_APP_ID", bad)
        assert client.get(APPLE_PATH).status_code == 404, f"published a bad app id: {bad}"


def test_the_crawlers_can_reach_them_without_the_private_origin_header():
    """Google and Apple cannot send it, so these paths must bypass the check."""
    for path in (ANDROID_PATH, APPLE_PATH):
        assert path in ORIGIN_BYPASS_PATHS
