"""No-network regressions for isolated Meta media work and restricted egress."""
import os
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("ALBAYAN_META_BACKGROUND_SYNC", "false")

import httpx
import pytest
from server import meta_ads as meta


PUBLIC_IP = "157.240.1.35"
CDN_URL = "https://scontent.xx.fbcdn.net/image.jpg?signature=keep%2Fthis"


@pytest.fixture
def media_network(monkeypatch):
    """Every connection and every DNS lookup in these tests is synthetic."""
    visited = []
    replies = []
    original_client = httpx.Client
    dns_calls = []

    def resolve(*args, **kwargs):
        dns_calls.append(args)
        return [(2, 1, 6, "", (PUBLIC_IP, 443))]

    def respond(request):
        visited.append(request)
        if replies:
            response = replies.pop(0)
            if isinstance(response, Exception):
                raise response
            return response
        return httpx.Response(200, headers={"content-type": "image/png"}, content=b"synthetic-image")

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return original_client(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr(meta.socket, "getaddrinfo", resolve)
    monkeypatch.setattr(meta.httpx, "Client", client)
    return SimpleNamespace(visited=visited, replies=replies, dns_calls=dns_calls)


@pytest.mark.parametrize("host", ["scontent.xx.fbcdn.net", "lookaside.fbsbx.com", "scontent.cdninstagram.com"])
def test_known_cdn_image_uses_pinned_public_ip_with_original_tls_identity(media_network, host):
    url = CDN_URL.replace("scontent.xx.fbcdn.net", host)
    assert meta._archive_meta_image(url).startswith("data:image/png;base64,")
    request = media_network.visited[0]
    assert request.url.host == PUBLIC_IP
    assert request.headers["host"] == host
    assert request.extensions["sni_hostname"] == host
    assert str(request.url).endswith("/image.jpg?signature=keep%2Fthis")
    assert len(media_network.dns_calls) == 1
    assert "authorization" not in request.headers


@pytest.mark.parametrize("url", [
    "http://scontent.fbcdn.net/a", "https://127.0.0.1/a", "https://[::1]/a",
    "https://localhost/a", "https://fbcdn.net.evil.invalid/a",
    "https://evilfbcdn.net/a", "https://example.invalid/a",
    "https://fbcdn.net:8443/a", "https://fbcdn.net:bad/a",
    "https://user:password@fbcdn.net/a", "https://graph.facebook.com/a",
    "https://fbcdn.net./a", "file:///tmp/a",
])
def test_untrusted_media_urls_never_resolve_or_connect(media_network, url):
    assert meta._archive_meta_image(url) == ""
    assert not media_network.visited
    assert not media_network.dns_calls


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fe80::1", "::ffff:127.0.0.1"])
def test_private_dns_answers_are_rejected_even_among_public_answers(media_network, monkeypatch, address):
    monkeypatch.setattr(meta.socket, "getaddrinfo", lambda *a, **k: [
        (2, 1, 6, "", (PUBLIC_IP, 443)), (2, 1, 6, "", (address, 443)),
    ])
    assert meta._archive_meta_image(CDN_URL) == ""
    assert not media_network.visited


def test_dual_stack_dns_prefers_ipv4_for_deployments_without_ipv6(media_network, monkeypatch):
    monkeypatch.setattr(meta.socket, "getaddrinfo", lambda *a, **k: [
        (10, 1, 6, "", ("2a03:2880:f10a:83:face:b00c:0:25de", 443, 0, 0)),
        (2, 1, 6, "", (PUBLIC_IP, 443)),
    ])
    assert meta._archive_meta_image(CDN_URL)
    assert media_network.visited[0].url.host == PUBLIC_IP


@pytest.mark.parametrize("location", ["http://127.0.0.1/private", "https://other.fbcdn.net/new", "https://example.invalid/new"])
def test_redirect_is_never_followed_even_to_another_cdn(media_network, location):
    media_network.replies.append(httpx.Response(302, headers={"location": location}))
    assert meta._archive_meta_image(CDN_URL) == ""
    assert len(media_network.visited) == 1


@pytest.mark.parametrize("headers,body", [
    ({"content-type": "text/html"}, b"not an image"),
    ({"content-type": "image/svg+xml"}, b"not permitted"),
    ({"content-type": "image/png", "content-length": str(meta._META_MEDIA_MAX_BYTES + 1)}, b"small"),
    ({"content-type": "image/png"}, b"x" * (meta._META_MEDIA_MAX_BYTES + 1)),
    ({"content-type": "image/png", "content-encoding": "custom"}, b"compressed"),
    ({"content-type": "image/png"}, b""),
], ids=["html", "svg", "declared-oversize", "actual-oversize", "transport-encoding", "empty"])
def test_media_mime_encoding_and_size_caps(media_network, headers, body):
    media_network.replies.append(httpx.Response(200, headers=headers, content=body))
    assert meta._archive_meta_image(CDN_URL) == ""


def test_slow_stream_cannot_exceed_overall_read_budget(media_network, monkeypatch):
    clock = SimpleNamespace(now=0.0)
    monkeypatch.setattr(meta.time, "monotonic", lambda: clock.now)

    class SlowStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"a"
            clock.now = meta._META_MEDIA_REQUEST_SECONDS + 1
            yield b"b"

    media_network.replies.append(httpx.Response(200, headers={"content-type": "image/png"}, stream=SlowStream()))
    assert meta._archive_meta_image(CDN_URL) == ""


def test_network_failure_does_not_retry_inside_image_request(media_network):
    media_network.replies.append(httpx.ConnectError("synthetic connection failure"))
    assert meta._archive_meta_image(CDN_URL) == ""
    assert len(media_network.visited) == 1


def fake_candidates(monkeypatch, rows):
    class Result:
        def mappings(self):
            return self

        def all(self):
            return rows

    @contextmanager
    def connection():
        yield SimpleNamespace(execute=lambda *args: Result())

    monkeypatch.setattr(meta, "db_conn", connection)
    monkeypatch.setattr(meta, "_META_MEDIA_FAILURES", {})


def test_failed_media_uses_backoff_and_retries_after_cooldown(monkeypatch):
    fake_candidates(monkeypatch, [{"id": "ad", "media_url": CDN_URL}])
    clock = SimpleNamespace(now=100.0)
    calls = []
    stored = []
    monkeypatch.setattr(meta.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: calls.append(url) or "")
    monkeypatch.setattr(meta, "_store_archived_image", lambda *args: stored.append(args))
    assert meta.archive_meta_media(limit=1) == 0
    for _ in range(10):
        assert meta.archive_meta_media(limit=1) == 0
    assert len(calls) == 1 and not stored
    clock.now += 61
    meta.archive_meta_media(limit=1)
    assert len(calls) == 2
    clock.now += 61
    meta.archive_meta_media(limit=1)
    assert len(calls) == 2, "second failure must have a longer cooldown"
    clock.now += 60
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: calls.append(url) or "data:image/png;base64,eA==")
    assert meta.archive_meta_media(limit=1) == 1
    assert len(calls) == 3 and len(stored) == 1
    assert not meta._META_MEDIA_FAILURES


def test_one_failed_shared_url_is_not_fetched_repeatedly_in_same_batch(monkeypatch):
    fake_candidates(monkeypatch, [{"id": str(i), "media_url": CDN_URL} for i in range(20)])
    calls = []
    monkeypatch.setattr(meta, "_archive_meta_image", lambda url: calls.append(url) or "")
    assert meta.archive_meta_media(limit=20) == 0
    assert len(calls) == 1


def test_media_batch_yields_on_time_budget_and_stop(monkeypatch):
    fake_candidates(monkeypatch, [{"id": str(i), "media_url": CDN_URL + str(i)} for i in range(20)])
    clock = SimpleNamespace(now=0.0)
    calls = []
    monkeypatch.setattr(meta.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(meta, "_store_archived_image", lambda *args: None)

    def download(url):
        calls.append(url)
        clock.now += 16
        return "data:image/png;base64,eA=="

    monkeypatch.setattr(meta, "_archive_meta_image", download)
    assert meta.archive_meta_media(limit=20) == 2
    assert len(calls) == 2
    stop = threading.Event()
    stop.set()
    assert meta.archive_meta_media(limit=20, stop_event=stop) == 0
    assert len(calls) == 2


def test_media_archive_does_not_apply_an_image_after_sync_changed_its_url(monkeypatch):
    class Result:
        def mappings(self):
            return self

        def first(self):
            return {"data_json": '{"metaThumbnailUrl":"https://scontent.xx.fbcdn.net/new.jpg"}'}

    @contextmanager
    def connection():
        yield SimpleNamespace(execute=lambda *args: Result())

    monkeypatch.setattr(meta, "db_conn", connection)
    writes = []
    monkeypatch.setattr(meta, "_write_entity_data", lambda *args: writes.append(args))
    meta._store_archived_image("ads", "ad", CDN_URL, "metaThumbnailData", "metaThumbnailArchivedFrom", "data:image/png;base64,eA==")
    assert not writes


def test_slow_media_is_not_called_on_primary_sync_worker(monkeypatch):
    clock = SimpleNamespace(now=0.0)
    discoveries = []
    slow_calls = []

    class Stop:
        loops = 0

        def wait(self, seconds):
            clock.now += 601 if seconds == 2 else seconds
            self.loops += 1
            return self.loops > 5

        def is_set(self):
            return self.loops > 5

    def forbidden(*a, **k):
        slow_calls.append(True)

    config = SimpleNamespace(auto_import=True, discovery_interval_seconds=10, worker_sync_interval_seconds=10)
    monkeypatch.setattr(meta.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(meta, "load_meta_ads_config", lambda: config)
    monkeypatch.setattr(meta, "_server_token_matches", lambda *a: False)
    monkeypatch.setattr(meta, "_meta_remote_backoff_remaining", lambda: 0)
    monkeypatch.setattr(meta, "discover_meta_ads", lambda **k: discoveries.append(clock.now))
    monkeypatch.setattr(meta, "archive_meta_media", forbidden)
    monkeypatch.setattr(meta, "backfill_placeholder_page_names", forbidden)
    meta._worker_loop(Stop(), "fixed-startup")
    assert len(discoveries) == 5
    assert all(b - a == 601 for a, b in zip(discoveries, discoveries[1:]))
    assert not slow_calls


def test_primary_discovery_continues_while_real_media_thread_is_blocked(monkeypatch):
    halted = threading.Event()
    media_started = threading.Event()
    release_media = threading.Event()
    discovery_progress = threading.Event()

    class AcceleratedStop:
        def wait(self, seconds):
            return halted.wait(min(seconds, 0.001))

        def is_set(self):
            return halted.is_set()

    stop = AcceleratedStop()
    config = SimpleNamespace(auto_import=True, discovery_interval_seconds=10, worker_sync_interval_seconds=10)

    def archive(**kwargs):
        media_started.set()
        assert release_media.wait(2), "test did not release its synthetic archive"
        return 0

    monkeypatch.setattr(meta, "load_meta_ads_config", lambda: config)
    monkeypatch.setattr(meta, "_server_token_matches", lambda *a: False)
    monkeypatch.setattr(meta, "_meta_remote_backoff_remaining", lambda: 0)
    monkeypatch.setattr(meta, "archive_meta_media", archive)
    monkeypatch.setattr(meta, "discover_meta_ads", lambda **k: discovery_progress.set())
    monkeypatch.setattr(meta, "sync_due_meta_ads", lambda: None)
    media = threading.Thread(target=meta._media_worker_loop, args=(stop,))
    primary = threading.Thread(target=meta._worker_loop, args=(stop, "test-start"))
    try:
        media.start()
        assert media_started.wait(1)
        primary.start()
        assert discovery_progress.wait(1), "media blocked new-ad discovery"
        assert not release_media.is_set()
    finally:
        halted.set()
        release_media.set()
        media.join(2)
        if primary.ident:
            primary.join(2)
    assert not media.is_alive() and not primary.is_alive()


def test_worker_lifecycle_never_overlaps_draining_generations(monkeypatch):
    created = []

    class Thread:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.alive = False
            created.append(self)

        def start(self):
            self.alive = True

        def is_alive(self):
            return self.alive

        def join(self, timeout):
            assert timeout <= 3
            # Model a network call still draining after bounded shutdown.

    monkeypatch.setattr(meta, "load_meta_ads_config", lambda: SimpleNamespace(configured=True, background_sync=True))
    monkeypatch.setattr(meta, "_server_token_matches", lambda *a: False)
    monkeypatch.setattr(meta.threading, "Thread", Thread)
    monkeypatch.setattr(meta, "_WORKER_THREAD", None)
    monkeypatch.setattr(meta, "_MEDIA_WORKER_THREAD", None)
    monkeypatch.setattr(meta, "_WORKER_STOP", threading.Event())
    meta.start_meta_ads_worker()
    meta.start_meta_ads_worker()
    assert len(created) == 2
    old_stop = meta._WORKER_STOP
    assert all(t.kwargs["args"][0] is old_stop for t in created)
    meta.stop_meta_ads_worker()
    assert old_stop.is_set()
    meta.start_meta_ads_worker()
    assert len(created) == 2 and old_stop.is_set()
    for thread in created:
        thread.alive = False
    meta.start_meta_ads_worker()
    assert len(created) == 4
    assert meta._WORKER_STOP is not old_stop and old_stop.is_set()
    assert not meta._WORKER_STOP.is_set()
    for thread in created:
        thread.alive = False
    meta.stop_meta_ads_worker()
    assert meta._WORKER_THREAD is None and meta._MEDIA_WORKER_THREAD is None


def test_background_page_name_repair_does_not_overlap_boot_or_manual_pass(monkeypatch):
    calls = []
    monkeypatch.setattr(meta, "_backfill_placeholder_page_names", lambda n: calls.append(n) or 1)
    with meta._META_PAGE_NAME_BACKFILL_LOCK:
        assert meta.backfill_placeholder_page_names() == 0
    assert not calls
    assert meta.backfill_placeholder_page_names(5) == 1
    assert calls == [5]
