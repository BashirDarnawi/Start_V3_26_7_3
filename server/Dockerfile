# Albayan Manager - Production Dockerfile
# Build: docker build -t albayan -f server/Dockerfile .
# Run:   docker run -p 8000:8000 albayan

FROM python:3.12.3-slim-bookworm

WORKDIR /app

# Install dependencies first (better layer caching)
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

# Copy application code
COPY server /app/server
COPY index.html script.js style.css /app/
COPY assets /app/assets

# Production defaults (can be overridden via docker-compose or env vars)
ENV ALBAYAN_COOKIE_SECURE=true
ENV ALBAYAN_DB_PATH=/var/lib/albayan/albayan.db
ENV ALBAYAN_DEBUG_MODE=false

# Create data directory for SQLite (if using file-based DB)
RUN mkdir -p /var/lib/albayan

EXPOSE 8000

# Use exec form for proper signal handling
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
