# Historical AWS / ALB / ECS Recommendations (Albayan)

> This is not the current production platform. Albayan production is hosted by
> Libyan Spider. Keep this file only as reference if an AWS migration is planned.

This file is a practical checklist to keep Albayan stable under load and during rapid refreshes.

## ALB (Application Load Balancer)

- **Target Group health check**
  - **Path**: `/api/health`
  - **Port**: `8000` (must match container port)
  - **Success codes**: `200`
  - **Interval**: 15s
  - **Timeout**: 5s
  - **Healthy threshold**: 2
  - **Unhealthy threshold**: 3

- **Idle timeout**
  - Set **60–120 seconds** (default 60s is usually OK).
  - If you see 504s on large data loads, increase to **120s**.

- **Deregistration delay**
  - Set **10–30 seconds** so deployments drain cleanly without hanging too long.

## ECS Service

- **Desired tasks**
  - Use **2 tasks** minimum for zero-downtime deployments.

- **Deployment configuration**
  - **Minimum healthy percent**: `100`
  - **Maximum percent**: `200`

- **Task size (CPU / Memory)**
  - Start with **0.5 vCPU** + **2 GB** RAM.
  - If you see **Exit code 137 (OOM)**, increase memory (e.g., 3–4 GB).

- **Container port**
  - Ensure your task definition maps container port **8000** to the target group.

## Cloudflare (if used)

- **Origin errors (502/520)**
  - Usually means **no healthy targets** behind ALB (ECS tasks restarting/OOM).
  - Fix by keeping **2 tasks** + enough memory.

- **Caching**
  - Albayan serves `index.html` with `Cache-Control: no-store`.
  - Avoid aggressive caching rules that might serve stale JS/CSS.

## Notes about the latest code changes

- The backend now logs **JSON access logs** with `request_id` so you can correlate UI issues with CloudWatch logs.
- The frontend now sends **`X-Request-ID`** on every API request.
- The frontend now limits server-load concurrency (no more 5 collections in parallel) to reduce refresh spikes.

