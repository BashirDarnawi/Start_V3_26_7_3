# Albayan Manager - Production Dockerfile
# Build: docker build -t albayan -f server/Dockerfile .
# Run:   docker run -p 8000:8000 albayan

FROM python:3.12-slim-bookworm AS backup-tools

WORKDIR /app

# Bookworm's default client is PostgreSQL 15, which cannot dump the PostgreSQL
# 16 server in docker-compose.yml. Install the matching major from PostgreSQL's
# signed official repository (keep this major aligned with the database image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --show-error --silent --location \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && pg_dump --version \
    && rm -rf /var/lib/apt/lists/*

FROM backup-tools AS runtime

# Install dependencies first (better layer caching)
COPY server/requirements.txt /app/server/requirements.txt
# pip's default 15s socket timeout is too short on a slow link: a timed-out
# metadata fetch makes a package look like it has NO candidates, so the resolver
# backtracks through every release and dies with a misleading
# "ResolutionImpossible" instead of a network error. Seen 2026-07-30 on
# pydantic-core, which the previous image had installed without trouble.
#
# The BuildKit cache mount keeps already-downloaded wheels on the build host
# between attempts, so a dropped connection resumes instead of re-pulling the
# whole ~200 MB. The mount is not a layer, so the image does not grow — which is
# why --no-cache-dir is no longer needed here.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --timeout 120 --retries 10 -r /app/server/requirements.txt

# The release stamp changes on every publish. It MUST stay below the apt and
# pip layers: declared any earlier it invalidates their cache, forcing every
# release to rebuild and re-upload ~200 MB of unchanged dependencies — and
# forcing the Jelastic node to re-download all of it on redeploy.
ARG ALBAYAN_BUILD_SHA=development
ENV ALBAYAN_RELEASE_SHA=${ALBAYAN_BUILD_SHA}

# Copy application code
COPY server /app/server
COPY index.html script.js studio.js clothes.js admin-tools.js style.css privacy.html delete-account.html alembic.ini /app/
COPY assets /app/assets

# Fail closed before publishing if build exclusions ever regress. Only inspect
# the image's copied files; mounted production data is never touched.
RUN python /app/server/image_safety.py /app

# NO minification step. rjsmin cannot parse nested template literals and was
# silently corrupting the served bundle's text and class attributes — see
# _ensure_minified_script in server/main.py for the full explanation. script.js
# is shipped and served exactly as npm built it.

# Production defaults (can be overridden via docker-compose or env vars).
# ALBAYAN_COOKIE_SECURE is deliberately NOT set: unset means "auto" — the
# session cookie's Secure flag follows the request scheme (https direct or
# via x-forwarded-proto => Secure; plain-HTTP LAN => storable cookie), see
# _cookie_secure_for in server/main.py. Forcing true here made phone logins
# over http://<lan-ip> silently drop the cookie and loop back to the login
# screen. Set it explicitly only to pin one behavior.
# No SQLite default: a production container without DATABASE_URL must fail
# loudly (server/startup_support.refuse_sqlite_in_production), never start
# empty. Test runners pass ALBAYAN_DB_PATH + ALBAYAN_ALLOW_SQLITE explicitly.
ENV ALBAYAN_DEBUG_MODE=false
# Print lines reach the platform log immediately, including the last ones before a crash.
ENV PYTHONUNBUFFERED=1

# Run the service without root privileges. Only the data directory and the
# runtime log directory need to be writable by the application user (there is no
# generated minified bundle to own any more).
RUN groupadd --system albayan \
    && useradd --system --gid albayan --home-dir /app --no-create-home albayan \
    && mkdir -p /var/lib/albayan /app/logs \
    && chown -R albayan:albayan /var/lib/albayan /app/logs

# Backups and any deliberate single-file database live here; a Dockerfile
# volume survives a redeploy, the writable layer does not.
VOLUME ["/var/lib/albayan"]

EXPOSE 8000

# The probe is the async, database-free liveness route: under load the sync
# readiness route waits for a worker thread and a pooled connection and the
# platform would restart a merely busy container. Startup does index and
# backfill work on big tables, so the grace period is honest.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health/live', timeout=3).read()"]

USER albayan

# Use exec form for proper signal handling
# --limit-concurrency counts EVERY open connection (idle keep-alive included)
# and answers the excess with a raw 503 before FastAPI ever sees the request —
# so it never appears in the app's own error metrics. One admin tab's live
# sync fans out 14 collection GETs per tick; 12 was below a single tab and
# painted the "Sync failed" badge on healthy servers. 64 leaves room for
# several tabs/phones while still bounding a runaway client; 128 keeps the
# liveness probe answered during a short burst (uvicorn 503s it above the cap).
# --timeout-graceful-shutdown bounds the wait for in-flight requests on redeploy
# (Docker sends SIGKILL after 10 s anyway; without a bound uvicorn waited forever).
# 5 s drain + worker joins (1 + 1 + 2 s) stays inside Docker's 10 s SIGKILL
# budget; the stop functions are single-shot, so the routers' own shutdown
# hooks (which run after the app hook) add nothing even mid-backup.
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--limit-concurrency", "128", "--timeout-graceful-shutdown", "5", "--no-server-header"]
