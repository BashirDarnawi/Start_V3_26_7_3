# Albayan Manager - Production Dockerfile
# Build: docker build -t albayan -f server/Dockerfile .
# Run:   docker run -p 8000:8000 albayan

FROM python:3.12-slim-bookworm

WORKDIR /app

# Install dependencies first (better layer caching)
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

# Copy application code
COPY server /app/server
COPY index.html script.js style.css privacy.html delete-account.html alembic.ini /app/
COPY assets /app/assets

# Generate the production bundle while the build user can still write /app.
# Runtime minification is retained as a fallback for local development only.
RUN python -c "from pathlib import Path; from rjsmin import jsmin; p=Path('/app/script.js'); Path('/app/script.min.js').write_text(jsmin(p.read_text(encoding='utf-8')), encoding='utf-8')"

# Production defaults (can be overridden via docker-compose or env vars).
# ALBAYAN_COOKIE_SECURE is deliberately NOT set: unset means "auto" — the
# session cookie's Secure flag follows the request scheme (https direct or
# via x-forwarded-proto => Secure; plain-HTTP LAN => storable cookie), see
# _cookie_secure_for in server/main.py. Forcing true here made phone logins
# over http://<lan-ip> silently drop the cookie and loop back to the login
# screen. Set it explicitly only to pin one behavior.
ENV ALBAYAN_DB_PATH=/var/lib/albayan/albayan.db
ENV ALBAYAN_DEBUG_MODE=false

# Run the service without root privileges. Only the data directory and the
# generated minified file and runtime log directory need to be writable by the
# application user.
RUN groupadd --system albayan \
    && useradd --system --gid albayan --home-dir /app --no-create-home albayan \
    && mkdir -p /var/lib/albayan /app/logs \
    && chown -R albayan:albayan /var/lib/albayan /app/logs /app/script.min.js

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()"]

USER albayan

# Use exec form for proper signal handling
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
