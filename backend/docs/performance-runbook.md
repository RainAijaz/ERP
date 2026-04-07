# ERP Performance Runbook

This runbook defines practical speed presets and operating steps for multi-user ERP workloads.

## 1) Environment Presets

Apply one profile in environment variables, restart app processes, and monitor for 1-2 business cycles.

### Low Traffic (up to ~40 concurrent active users)

- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `HTTP_COMPRESSION=1`
- `HTTP_JSON_LIMIT=1mb`
- `HTTP_FORM_LIMIT=1mb`
- `STATIC_MAX_AGE=1h`
- `STATIC_VENDOR_MAX_AGE=30d`
- `SERVER_KEEP_ALIVE_TIMEOUT_MS=65000`
- `SERVER_HEADERS_TIMEOUT_MS=66000`
- `SERVER_REQUEST_TIMEOUT_MS=120000`
- `DB_POOL_MIN=2`
- `DB_POOL_MAX=20`
- `DB_POOL_TIMEOUT_MS=60000`
- `DB_POOL_CREATE_TIMEOUT_MS=30000`
- `DB_POOL_IDLE_TIMEOUT_MS=30000`
- `DB_POOL_REAP_INTERVAL_MS=1000`
- `DB_POOL_CREATE_RETRY_MS=200`
- `DB_STATEMENT_TIMEOUT_MS=12000`
- `DB_LOCK_TIMEOUT_MS=5000`
- `DB_IDLE_IN_TX_TIMEOUT_MS=15000`
- `SESSION_TOUCH_INTERVAL_MS=60000`
- `USER_CONTEXT_CACHE_TTL_MS=60000`
- `USER_CONTEXT_CACHE_MAX_ENTRIES=5000`
- `BRANCH_OPTIONS_CACHE_TTL_MS=60000`

### Medium Traffic (up to ~120 concurrent active users)

- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `HTTP_COMPRESSION=1`
- `HTTP_JSON_LIMIT=1mb`
- `HTTP_FORM_LIMIT=1mb`
- `STATIC_MAX_AGE=2h`
- `STATIC_VENDOR_MAX_AGE=45d`
- `SERVER_KEEP_ALIVE_TIMEOUT_MS=65000`
- `SERVER_HEADERS_TIMEOUT_MS=66000`
- `SERVER_REQUEST_TIMEOUT_MS=120000`
- `DB_POOL_MIN=4`
- `DB_POOL_MAX=40`
- `DB_POOL_TIMEOUT_MS=60000`
- `DB_POOL_CREATE_TIMEOUT_MS=30000`
- `DB_POOL_IDLE_TIMEOUT_MS=30000`
- `DB_POOL_REAP_INTERVAL_MS=1000`
- `DB_POOL_CREATE_RETRY_MS=200`
- `DB_STATEMENT_TIMEOUT_MS=10000`
- `DB_LOCK_TIMEOUT_MS=4000`
- `DB_IDLE_IN_TX_TIMEOUT_MS=12000`
- `SESSION_TOUCH_INTERVAL_MS=90000`
- `USER_CONTEXT_CACHE_TTL_MS=90000`
- `USER_CONTEXT_CACHE_MAX_ENTRIES=12000`
- `BRANCH_OPTIONS_CACHE_TTL_MS=120000`

### High Traffic (up to ~300 concurrent active users)

- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `HTTP_COMPRESSION=1`
- `HTTP_JSON_LIMIT=1mb`
- `HTTP_FORM_LIMIT=1mb`
- `STATIC_MAX_AGE=4h`
- `STATIC_VENDOR_MAX_AGE=60d`
- `SERVER_KEEP_ALIVE_TIMEOUT_MS=65000`
- `SERVER_HEADERS_TIMEOUT_MS=66000`
- `SERVER_REQUEST_TIMEOUT_MS=120000`
- `DB_POOL_MIN=8`
- `DB_POOL_MAX=70`
- `DB_POOL_TIMEOUT_MS=60000`
- `DB_POOL_CREATE_TIMEOUT_MS=30000`
- `DB_POOL_IDLE_TIMEOUT_MS=30000`
- `DB_POOL_REAP_INTERVAL_MS=1000`
- `DB_POOL_CREATE_RETRY_MS=200`
- `DB_STATEMENT_TIMEOUT_MS=8000`
- `DB_LOCK_TIMEOUT_MS=3000`
- `DB_IDLE_IN_TX_TIMEOUT_MS=10000`
- `SESSION_TOUCH_INTERVAL_MS=120000`
- `USER_CONTEXT_CACHE_TTL_MS=120000`
- `USER_CONTEXT_CACHE_MAX_ENTRIES=25000`
- `BRANCH_OPTIONS_CACHE_TTL_MS=180000`

Notes:

- Keep `DB_POOL_MAX` lower than your DB connection budget once PgBouncer is deployed.
- If timeouts are too strict for month-end reports, increase `DB_STATEMENT_TIMEOUT_MS` only for that workload window.

## 2) Why Infra Steps Improve Speed

### PgBouncer (transaction pooling)

- Without a proxy, each Node worker keeps many direct PostgreSQL backends; context switching and memory overhead rise quickly.
- PgBouncer multiplexes short app transactions over a smaller pool of real DB backends.
- Result: lower connection churn, better CPU usage, and more stable latency under spikes.

### PostgreSQL instance tuning

- App code can reduce query count, but execution speed depends on shared memory, sort/hash memory, checkpoint behavior, and cache hit ratio.
- Right-sized `shared_buffers`, `work_mem`, and checkpoint parameters reduce IO stalls and temporary-file pressure.
- Result: lower p95/p99 on heavy reports and fewer random latency spikes.

### Query-level verification and targeted indexes

- Indexes speed reads but add write overhead.
- Running `EXPLAIN (ANALYZE, BUFFERS)` identifies where scans/sorts dominate real runtime.
- Result: only high-value indexes are added, minimizing write amplification.

### Horizontal app scaling

- One Node process eventually becomes CPU/event-loop bound.
- Multiple workers behind a reverse proxy parallelize request handling and isolate GC pauses.
- Result: higher throughput and improved tail latency during concurrent usage.

### Load-test gate before release

- Prevents regression by validating realistic flows (login, report load, voucher save) against SLOs.
- Result: performance issues are caught before users are impacted.

## 3) PgBouncer Baseline

Start with transaction pooling and conservative pool sizing.

- `pool_mode = transaction`
- `max_client_conn = 1000`
- `default_pool_size = 100`
- `min_pool_size = 20`
- `reserve_pool_size = 20`
- `reserve_pool_timeout = 3`
- `server_idle_timeout = 60`
- `ignore_startup_parameters = extra_float_digits`

Capacity rule:

- Sum of app-side active DB demand across all app instances should not exceed PgBouncer `max_client_conn`.
- Sum of PostgreSQL backend pools from PgBouncer should stay below PostgreSQL safe backend limit for your RAM.

## 4) PostgreSQL Baseline (starting point)

Use these as starting values, then tune using actual metrics.

- `shared_buffers = 25% of RAM`
- `effective_cache_size = 50-75% of RAM`
- `work_mem = 8MB to 32MB` (do not over-allocate globally)
- `maintenance_work_mem = 256MB to 1GB`
- `checkpoint_completion_target = 0.9`
- `random_page_cost = 1.1 to 1.5` (SSD)
- `max_connections` should be modest when using PgBouncer (for example 100-300)

## 5) Query Verification Workflow

1. Enable slow query logging (temporary):

```sql
ALTER SYSTEM SET log_min_duration_statement = '500ms';
SELECT pg_reload_conf();
```

2. Capture top report SQL and run:

```sql
EXPLAIN (ANALYZE, BUFFERS) <query>;
```

3. Compare before/after:

- Total time
- Shared hit vs read blocks
- Sort method (memory vs disk)
- Rows removed by filter

4. Keep indexes that improve p95 and do not materially hurt write workloads.

## 6) Load-Test Gate

Use the provided k6 script at `tests/load/k6-erp-critical.js`.

Mandatory tracked metrics:

- `http_req_duration` p95 and p99
- `http_req_failed` rate
- App CPU and memory
- DB CPU
- Active DB connections
- Lock wait events

Suggested release gate:

- p95 under 1200ms
- p99 under 2500ms
- error rate under 2%
- no lock-wait blowups

## 7) Rollback Safety

- Keep previous env preset values.
- Apply one preset change set at a time.
- If p99 worsens by >20%, revert the latest change set immediately.
