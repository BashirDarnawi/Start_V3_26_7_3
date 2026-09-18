"""Round 6 (2026-09-18): deployment safety nets."""

import inspect

import pytest

import server.main as main
from server import add_jsonb_indexes
from server.startup_support import read_env_int, refuse_sqlite_in_production


def test_sqlite_is_refused_in_production_unless_allowed():
    with pytest.raises(RuntimeError):
        refuse_sqlite_in_production("sqlite", debug_mode=False, allow_env="")
    refuse_sqlite_in_production("sqlite", debug_mode=True, allow_env="")          # developer
    refuse_sqlite_in_production("sqlite", debug_mode=False, allow_env="true")     # test runner / deliberate
    refuse_sqlite_in_production("postgresql", debug_mode=False, allow_env="")     # production
    with pytest.raises(RuntimeError):                                            # the URL form the boot passes
        refuse_sqlite_in_production("sqlite+pysqlite:////var/lib/albayan/albayan.db", debug_mode=False, allow_env="")
    refuse_sqlite_in_production("postgresql+psycopg://u:p@db/albayan", debug_mode=False, allow_env="")


def test_server_phone_key_matches_the_client_rules():
    canon = main._canonical_customer_phone
    assert canon("0218912345678") == canon("0912345678") == "218912345678"
    assert canon("0213334455") == canon("+218 21 333 4455") == "218213334455"
    assert canon("00218912345678") == "218912345678"


def test_liveness_is_async_and_database_free():
    from fastapi.testclient import TestClient

    from server.health import build_health_router

    live = next(r for r in build_health_router("v", "rel").routes if r.path == "/api/health/live")
    assert inspect.iscoroutinefunction(live.endpoint)
    assert "db_conn" not in inspect.getsource(live.endpoint)
    client = TestClient(main.app)
    assert client.get("/api/health/live").json()["release"] == main.RELEASE_SHA
    assert client.get("/api/health/ready").json()["dialect"] == "sqlite"


def test_env_ints_fall_back_instead_of_crashing(monkeypatch, capsys):
    monkeypatch.setenv("ALBAYAN_R6_TEST_INT", " 12 ")
    assert read_env_int("ALBAYAN_R6_TEST_INT", 5) == 12
    monkeypatch.setenv("ALBAYAN_R6_TEST_INT", "1O")
    assert read_env_int("ALBAYAN_R6_TEST_INT", 5) == 5
    assert "CONFIG ALBAYAN_R6_TEST_INT" in capsys.readouterr().out
    monkeypatch.delenv("ALBAYAN_R6_TEST_INT")
    assert read_env_int("ALBAYAN_R6_TEST_INT", 7, lo=1, hi=3) == 7          # the default is never clamped
    monkeypatch.setenv("ALBAYAN_R6_TEST_INT", "99")
    assert read_env_int("ALBAYAN_R6_TEST_INT", 7, lo=1, hi=3) == 3


def test_keyset_indexes_are_part_of_the_boot_stop_gap():
    assert {name for name, _t in add_jsonb_indexes.KEYSET_INDEXES} == {"entities_type_created_id", "entities_type_modified_id"}
