"""
Application monitoring and observability utilities.

Provides structured logging, metrics collection, and error tracking.
"""
import json
import time
from pathlib import Path
from typing import Any


class ApplicationMonitor:
    """
    Centralized monitoring for API requests, errors, and performance.
    
    Features:
        - Request logging (method, path, status, duration)
        - Error tracking (exceptions, stack traces)
        - Performance metrics (slow queries, response times)
        - Business metrics (logins, receipts created, deliveries completed)
    """
    
    def __init__(self, log_file: str = "logs/app.log"):
        """
        Initialize monitor with log file path.
        
        Args:
            log_file: Path to JSON log file (created automatically)
        """
        self.log_file = Path(log_file)
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        self.request_count = 0
        self.error_count = 0
        self.start_time = time.time()
    
    def log_request(self, method: str, path: str, status: int, duration_ms: float, user_id: str = None):
        """
        Log an HTTP request.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            path: Request path
            status: HTTP status code
            duration_ms: Request duration in milliseconds
            user_id: User ID (if authenticated)
        """
        self.request_count += 1
        
        log_entry = {
            "timestamp": int(time.time() * 1000),
            "type": "request",
            "method": method,
            "path": path,
            "status": status,
            "duration_ms": duration_ms,
            "user_id": user_id,
            "is_error": status >= 400
        }
        
        self._write_log(log_entry)
        
        if status >= 500:
            self.error_count += 1
    
    def log_error(self, error_type: str, message: str, context: dict[str, Any] = None):
        """
        Log an application error.
        
        Args:
            error_type: Error category (e.g., 'validation', 'database', 'auth')
            message: Error description
            context: Additional context (user_id, entity_id, etc.)
        """
        self.error_count += 1
        
        log_entry = {
            "timestamp": int(time.time() * 1000),
            "type": "error",
            "error_type": error_type,
            "message": message,
            "context": context or {}
        }
        
        self._write_log(log_entry)
    
    def log_business_event(self, event_type: str, details: dict[str, Any]):
        """
        Log a business event (receipt created, delivery completed, etc.).
        
        Args:
            event_type: Event name (e.g., 'receipt_created', 'delivery_completed')
            details: Event-specific data
        """
        log_entry = {
            "timestamp": int(time.time() * 1000),
            "type": "business_event",
            "event_type": event_type,
            "details": details
        }
        
        self._write_log(log_entry)
    
    def get_metrics(self) -> dict[str, Any]:
        """
        Get current application metrics.
        
        Returns:
            Dict with uptime, request count, error count, error rate
        """
        uptime_seconds = time.time() - self.start_time
        return {
            "uptime_seconds": uptime_seconds,
            "uptime_hours": uptime_seconds / 3600,
            "total_requests": self.request_count,
            "total_errors": self.error_count,
            "error_rate": self.error_count / max(self.request_count, 1),
            "requests_per_minute": (self.request_count / max(uptime_seconds / 60, 1))
        }
    
    def _write_log(self, entry: dict[str, Any]):
        """Write log entry to file (NDJSON format)"""
        try:
            with self.log_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            # Fail silently (don't break app if logging fails)
            print(f"⚠️  Monitoring log write failed: {e}")


# Global monitor instance
monitor = ApplicationMonitor()


def log_request(method: str, path: str, status: int, duration_ms: float, user_id: str = None):
    """Convenience function for request logging"""
    monitor.log_request(method, path, status, duration_ms, user_id)


def log_error(error_type: str, message: str, context: dict[str, Any] = None):
    """Convenience function for error logging"""
    monitor.log_error(error_type, message, context)


def log_business_event(event_type: str, details: dict[str, Any]):
    """Convenience function for business event logging"""
    monitor.log_business_event(event_type, details)


def get_metrics() -> dict[str, Any]:
    """Convenience function to get metrics"""
    return monitor.get_metrics()

