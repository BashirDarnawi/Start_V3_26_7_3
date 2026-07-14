"""Focused tests for Redis-backed authentication rate limiting."""
from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from server import rate_limiter


@pytest.fixture(autouse=True)
def isolated_rate_limiter(monkeypatch):
    """Keep module-level fallback and Redis state isolated between tests."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    rate_limiter._REDIS_CLIENT = None
    rate_limiter._REDIS_ENABLED = False
    rate_limiter._MEMORY_STORE.clear()
    rate_limiter._LAST_CLEANUP = 0
    yield
    rate_limiter._REDIS_CLIENT = None
    rate_limiter._REDIS_ENABLED = False
    rate_limiter._MEMORY_STORE.clear()
    rate_limiter._LAST_CLEANUP = 0


class EvalRedis:
    def __init__(self, results=None, error: Exception | None = None):
        self.results = list(results or [])
        self.error = error
        self.calls = []

    def eval(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return self.results.pop(0)


def enable_fake_redis(client):
    rate_limiter._REDIS_CLIENT = client
    rate_limiter._REDIS_ENABLED = True


def test_redis_check_is_one_atomic_eval_and_same_millisecond_members_are_unique(monkeypatch):
    client = EvalRedis(results=[[1, 2, 0], [1, 1, 0]])
    enable_fake_redis(client)
    monkeypatch.setattr(rate_limiter, "now_ms", lambda: 123_456)

    assert rate_limiter.check_rate_limit("login:user", 3, 10_000) == (True, 2, 0)
    assert rate_limiter.check_rate_limit("login:user", 3, 10_000) == (True, 1, 0)

    assert len(client.calls) == 2
    first, second = client.calls
    assert first[1:6] == (1, "login:user", 113_456, 123_456, 3)
    assert first[7] == 10_000
    assert first[6].startswith("123456:")
    assert second[6].startswith("123456:")
    assert first[6] != second[6]

    script = first[0]
    assert script.index("ZREMRANGEBYSCORE") < script.index("ZCARD")
    assert script.index("ZCARD") < script.index("ZADD")
    assert script.index("ZADD") < script.index("PEXPIRE")


def test_atomic_redis_result_preserves_block_without_recording_contract(monkeypatch):
    client = EvalRedis(results=[[0, 0, 4_250]])
    enable_fake_redis(client)
    monkeypatch.setattr(rate_limiter, "now_ms", lambda: 50_000)

    assert rate_limiter.check_rate_limit("login:user", 2, 10_000) == (False, 0, 4_250)
    assert len(client.calls) == 1
    script = client.calls[0][0]
    assert "if current_count >= max_attempts" in script
    assert script.index("return {0, 0, retry_after_ms}") < script.index("ZADD")


def test_redis_failure_warns_without_leaking_credentials_and_falls_back(monkeypatch, capsys):
    secret_url = "redis://private-user:super-secret-token@redis.example.test:6379/0"
    client = EvalRedis(error=RuntimeError(secret_url))
    enable_fake_redis(client)
    monkeypatch.setattr(rate_limiter, "now_ms", lambda: 20_000)

    assert rate_limiter.check_rate_limit("login:user", 2, 1_000) == (True, 1, 0)
    assert rate_limiter.check_rate_limit("login:user", 2, 1_000) == (True, 0, 0)
    assert rate_limiter.check_rate_limit("login:user", 2, 1_000) == (False, 0, 1_000)

    output = capsys.readouterr().out
    assert "WARNING" in output
    assert "single-process in-memory fallback" in output
    assert "RuntimeError" in output
    assert "super-secret-token" not in output
    assert secret_url not in output


def test_redis_initialization_does_not_log_configured_url(monkeypatch, capsys):
    secret_url = "redis://private-user:another-secret@redis.example.test:6379/1"
    received = {}

    class Client:
        def ping(self):
            return True

    def from_url(url, **kwargs):
        received["url"] = url
        received["kwargs"] = kwargs
        return Client()

    monkeypatch.setenv("REDIS_URL", secret_url)
    monkeypatch.setitem(sys.modules, "redis", SimpleNamespace(from_url=from_url))

    rate_limiter._init_redis()

    output = capsys.readouterr().out
    assert rate_limiter._REDIS_ENABLED is True
    assert received["url"] == secret_url
    assert received["kwargs"]["decode_responses"] is True
    assert "Redis rate limiting enabled" in output
    assert "another-secret" not in output
    assert secret_url not in output


def test_redis_initialization_failure_redacts_exception_text(monkeypatch, capsys):
    secret_url = "redis://user:credential-in-error@redis.example.test:6379/0"

    class Client:
        def ping(self):
            raise ConnectionError(secret_url)

    monkeypatch.setenv("REDIS_URL", secret_url)
    monkeypatch.setitem(
        sys.modules,
        "redis",
        SimpleNamespace(from_url=lambda *_args, **_kwargs: Client()),
    )

    rate_limiter._init_redis()

    output = capsys.readouterr().out
    assert rate_limiter._REDIS_ENABLED is False
    assert "WARNING" in output
    assert "ConnectionError" in output
    assert "credential-in-error" not in output
    assert secret_url not in output


def test_reset_clears_stale_memory_state_even_when_redis_succeeds():
    deleted = []
    client = SimpleNamespace(delete=lambda key: deleted.append(key))
    enable_fake_redis(client)
    rate_limiter._MEMORY_STORE["login:user"] = [1, 2]

    rate_limiter.reset_rate_limit("login:user")

    assert deleted == ["login:user"]
    assert "login:user" not in rate_limiter._MEMORY_STORE
