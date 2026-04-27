#!/bin/sh
# register-tenant.sh
#
# One-shot script that registers a Supavisor tenant via the admin REST API.
# Runs inside the sv-init container (curlimages/curl) after supavisor is healthy.
#
# Tasks: mt#1205 (umbrella), mt#1365 (child C – local docker harness)
#
# The JWT below is pre-computed for API_JWT_SECRET defined in docker-compose.integration.yml
# ("super-secret-jwt-token-with-at-least-32-characters-long"), valid until year 2125.
# No openssl/python needed in the container — curlimages/curl is intentionally minimal.
#
# Required env vars (set by docker-compose.integration.yml):
#   SUPAVISOR_API_URL   — e.g. http://supavisor:4000
#   TENANT_EXTERNAL_ID  — the tenant id (e.g. "local")
#   DB_HOST             — upstream postgres host (e.g. "postgres")
#   DB_PORT             — upstream postgres port (e.g. "5432")
#   DB_DATABASE         — upstream database name (e.g. "postgres")
#   DB_USER             — upstream postgres user (e.g. "postgres")
#   DB_PASSWORD         — upstream postgres password (e.g. "postgres")
#   POOL_SIZE           — session pool_size to configure (e.g. "5")

set -e

# Pre-computed HS256 JWT for API_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"
# role=service_role, iat=1700000000, exp=4853000000 (year ~2125)
# Regenerate with: python3 scripts/integration/gen-supavisor-jwt.py
JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6NDg1MzAwMDAwMH0.YfQuKmzR9lBpNOt7iDO8IY9et4RRxXlidbVmFR5Vbtc"

# ---------------------------------------------------------------------------
# Wait for the admin API to be responsive with a valid auth response.
# 404 = API up, tenant not yet registered (expected first run)
# 200 = tenant already registered (idempotent re-run)
# 500/403/000 = not ready yet
# ---------------------------------------------------------------------------
echo "[sv-init] waiting for Supavisor admin API at ${SUPAVISOR_API_URL}..."
for i in $(seq 1 60); do
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${JWT}" \
    "${SUPAVISOR_API_URL}/api/tenants/${TENANT_EXTERNAL_ID}" 2>/dev/null || echo "000")
  if [ "$HTTP" = "404" ] || [ "$HTTP" = "200" ]; then
    echo "[sv-init] API ready (HTTP ${HTTP})"
    break
  fi
  echo "[sv-init] attempt ${i}: HTTP ${HTTP}, retrying in 1s..."
  sleep 1
done

if [ "$HTTP" != "404" ] && [ "$HTTP" != "200" ]; then
  echo "[sv-init] ERROR: Supavisor API not ready after 60s (last HTTP: ${HTTP})"
  exit 1
fi

if [ "$HTTP" = "200" ]; then
  echo "[sv-init] tenant '${TENANT_EXTERNAL_ID}' already registered, skipping."
else
  # ---------------------------------------------------------------------------
  # Register the tenant. The PUT endpoint is idempotent.
  # ---------------------------------------------------------------------------
  echo "[sv-init] registering tenant '${TENANT_EXTERNAL_ID}' (pool_size=${POOL_SIZE})..."

  RESPONSE=$(curl -s -w '\n%{http_code}' -X PUT \
    -H "Authorization: Bearer ${JWT}" \
    -H "Content-Type: application/json" \
    -d "{
      \"tenant\": {
        \"external_id\": \"${TENANT_EXTERNAL_ID}\",
        \"db_host\": \"${DB_HOST}\",
        \"db_port\": ${DB_PORT},
        \"db_database\": \"${DB_DATABASE}\",
        \"default_pool_size\": ${POOL_SIZE},
        \"default_max_clients\": ${POOL_SIZE},
        \"upstream_ssl\": false,
        \"require_user\": false,
        \"auth_query\": \"SELECT rolname, rolpassword FROM pg_authid WHERE rolname=\$1\",
        \"users\": [{
          \"db_user\": \"${DB_USER}\",
          \"db_user_alias\": \"${DB_USER}\",
          \"db_password\": \"${DB_PASSWORD}\",
          \"pool_size\": ${POOL_SIZE},
          \"mode_type\": \"session\",
          \"is_manager\": true
        }]
      }
    }" \
    "${SUPAVISOR_API_URL}/api/tenants/${TENANT_EXTERNAL_ID}")

  BODY=$(printf '%s' "$RESPONSE" | head -n -1)
  HTTP=$(printf '%s' "$RESPONSE" | tail -n 1)

  echo "[sv-init] response HTTP ${HTTP}: ${BODY}"

  if [ "$HTTP" != "200" ] && [ "$HTTP" != "201" ]; then
    echo "[sv-init] ERROR: tenant registration failed with HTTP ${HTTP}"
    exit 1
  fi

  echo "[sv-init] tenant '${TENANT_EXTERNAL_ID}' registered successfully."
fi

echo ""
echo "[sv-init] ============================================================="
echo "[sv-init] Stack is ready. Connection strings:"
echo "[sv-init]   Direct Postgres : postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5440/${DB_DATABASE}"
echo "[sv-init]   Via Supavisor   : postgresql://${DB_USER}.${TENANT_EXTERNAL_ID}:${DB_PASSWORD}@localhost:6432/${DB_DATABASE}"
echo "[sv-init] ============================================================="
