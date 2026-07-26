from server.monitoring import ApplicationMonitor


def test_monitor_tracks_errors_and_latency_percentiles():
    monitor = ApplicationMonitor(log_file="", sample_size=20)
    for duration in (10, 20, 30, 100):
        monitor.observe_request(500 if duration == 100 else 200, duration)

    metrics = monitor.get_metrics()
    assert metrics["total_requests"] == 4
    assert metrics["total_errors"] == 1
    assert metrics["error_rate"] == 0.25
    assert metrics["response_ms_p50"] == 30.0
    assert metrics["response_ms_p95"] == 100.0
    assert metrics["sample_size"] == 4


def test_monitor_writes_only_when_a_file_is_configured(tmp_path):
    path = tmp_path / "monitor.ndjson"
    monitor = ApplicationMonitor(log_file=str(path))
    monitor.log_business_event("receipt_created", {"receipt_id": "r1"})
    assert '"type":"business_event"' in path.read_text(encoding="utf-8")
