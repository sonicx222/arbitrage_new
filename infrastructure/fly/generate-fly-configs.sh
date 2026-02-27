#!/usr/bin/env bash
#
# Fly.io TOML Configuration Generator
#
# Generates all fly/*.toml files from a central configuration table.
# Ensures consistency across services (metrics port, check intervals,
# deploy strategy, vm settings, etc.).
#
# Usage:
#   ./generate-fly-configs.sh              # Generate all TOML files
#   ./generate-fly-configs.sh --dry-run    # Show what would be generated
#   ./generate-fly-configs.sh --diff       # Show diff against existing files
#
# After running, review the generated files and commit the changes.
#
# @see ADR-003: Partitioned Chain Detectors
# @see ADR-006: Free Hosting Provider Selection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=false
DIFF_MODE=false

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        --diff) DIFF_MODE=true; shift ;;
        -h|--help)
            grep '^#' "$0" | grep -v '#!/usr/bin/env bash' | sed 's/^# //' | sed 's/^#//'
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# =============================================================================
# Service Configuration Table
# =============================================================================
# Each service is defined by a set of variables. The generate_toml function
# reads these to produce a consistent TOML file.

generate_partition_toml() {
    local title="$1" partition_id="$2" chains="$3" region_code="$4"
    local region_id="$5" port="$6" memory="$7" dockerfile="$8"
    local app_name="$9" filename="${10}" extra_notes="${11:-}"
    local concurrency_hard="${12:-25}" concurrency_soft="${13:-20}"

    cat <<EOF
# Fly.io Deployment Configuration for ${title}
#
# Partition: ${partition_id}
# Chains: ${chains}
# Region: ${region_id}
# Resource Profile: ${memory}MB
#
# @see ADR-003: Partitioned Chain Detectors
# @see ADR-006: Free Hosting Provider Selection
# @see ADR-007: Cross-Region Failover Strategy
#
# Deployment:
#   fly deploy -c infrastructure/fly/${filename}
#
# Scaling:
#   fly scale memory ${memory} -c infrastructure/fly/${filename}
${extra_notes}
app = "${app_name}"
primary_region = "${region_code}"

[build]
  dockerfile = "${dockerfile}"
  [build.args]
    NODE_ENV = "production"

[env]
  NODE_ENV = "production"
  PARTITION_ID = "${partition_id}"
  PARTITION_CHAINS = "${chains}"
  REGION_ID = "${region_id}"
  LOG_LEVEL = "info"
  HEALTH_CHECK_PORT = "${port}"
  ENABLE_CROSS_REGION_HEALTH = "true"
  # Chain-specific RPC URLs set via secrets

[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [http_service.concurrency]
    type = "connections"
    hard_limit = ${concurrency_hard}
    soft_limit = ${concurrency_soft}

# NOTE: Using [http_service] and [checks] (Machines V2 syntax)

[vm]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = ${memory}

[metrics]
  port = 9091
  path = "/metrics"

[checks]
  [checks.health]
    grace_period = "30s"
    interval = "15s"
    method = "GET"
    path = "/health"
    port = ${port}
    timeout = "5s"
    type = "http"

  [checks.ready]
    grace_period = "60s"
    interval = "15s"
    method = "GET"
    path = "/ready"
    port = ${port}
    timeout = "5s"
    type = "http"

# Processes
[processes]
  app = "node dist/index.js"

# Deploy strategy
[deploy]
  release_command = "echo '${title} deploying...'"
  strategy = "rolling"
EOF
}

generate_service_toml() {
    local title="$1" region_code="$2" region_id="$3" port="$4"
    local memory="$5" dockerfile="$6" app_name="$7" filename="$8"
    local health_path="$9" extra_env="${10:-}" extra_notes="${11:-}"
    local concurrency_hard="${12:-25}" concurrency_soft="${13:-20}"
    local has_ready_check="${14:-false}"

    cat <<EOF
# Fly.io Deployment Configuration for ${title}
#
# Service: ${title}
# Region: ${region_code} (${region_id})
#
# @see ADR-003: Partitioned Chain Detectors
# @see ADR-006: Free Hosting Provider Selection
# @see ADR-007: Cross-Region Failover Strategy
#
# Deployment:
#   fly deploy -c infrastructure/fly/${filename}
${extra_notes}
app = "${app_name}"
primary_region = "${region_code}"

[build]
  dockerfile = "${dockerfile}"
  [build.args]
    NODE_ENV = "production"

[env]
  NODE_ENV = "production"
  REGION_ID = "${region_id}"
  LOG_LEVEL = "info"
  HEALTH_CHECK_PORT = "${port}"
  ENABLE_CROSS_REGION_HEALTH = "true"
${extra_env}
[http_service]
  internal_port = ${port}
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

  [http_service.concurrency]
    type = "connections"
    hard_limit = ${concurrency_hard}
    soft_limit = ${concurrency_soft}

# NOTE: Using [http_service] and [checks] (Machines V2 syntax)

[vm]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = ${memory}

[metrics]
  port = 9091
  path = "/metrics"

[checks]
  [checks.health]
    grace_period = "30s"
    interval = "15s"
    method = "GET"
    path = "${health_path}"
    port = ${port}
    timeout = "5s"
    type = "http"
EOF

    if [[ "$has_ready_check" == "true" ]]; then
        cat <<EOF

  [checks.ready]
    grace_period = "60s"
    interval = "15s"
    method = "GET"
    path = "/ready"
    port = ${port}
    timeout = "5s"
    type = "http"
EOF
    fi

    cat <<EOF

[processes]
  app = "node dist/index.js"

[deploy]
  release_command = "echo '${title} deploying...'"
  strategy = "rolling"
EOF
}

# =============================================================================
# Generate all configs
# =============================================================================

write_or_diff() {
    local filename="$1"
    local content="$2"
    local filepath="${SCRIPT_DIR}/${filename}"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "=== Would generate: ${filename} ==="
        echo "$content" | head -5
        echo "  ... ($(echo "$content" | wc -l) lines total)"
        echo ""
        return
    fi

    if [[ "$DIFF_MODE" == "true" ]]; then
        if [[ -f "$filepath" ]]; then
            echo "=== Diff for ${filename} ==="
            diff <(cat "$filepath") <(echo "$content") || true
            echo ""
        else
            echo "=== NEW FILE: ${filename} ==="
            echo "$content" | head -10
            echo "  ..."
            echo ""
        fi
        return
    fi

    echo "$content" > "$filepath"
    echo "Generated: ${filename}"
}

main() {
    echo "Generating Fly.io TOML configurations..."
    echo ""

    # --- Partition services ---

    # L2-Turbo (historical app name: arbitrage-l2-fast)
    write_or_diff "partition-l2-turbo.toml" "$(generate_partition_toml \
        "L2-Turbo partition" "l2-turbo" "arbitrum,optimism,base,scroll,blast" \
        "sin" "asia-southeast1" "3002" "640" \
        "services/unified-detector/Dockerfile" "arbitrage-l2-fast" \
        "partition-l2-turbo.toml" \
        "#
# NOTE: Fly app name remains \"arbitrage-l2-fast\" (historical — renaming requires app migration)
")"

    # Asia-Fast
    write_or_diff "partition-asia-fast.toml" "$(generate_partition_toml \
        "Asia-Fast partition" "asia-fast" "bsc,polygon,avalanche,fantom" \
        "sin" "asia-southeast1" "3001" "768" \
        "services/unified-detector/Dockerfile" "arbitrage-asia-fast" \
        "partition-asia-fast.toml")"

    # High-Value
    write_or_diff "partition-high-value.toml" "$(generate_partition_toml \
        "High-Value partition" "high-value" "ethereum,zksync,linea" \
        "iad" "us-east1" "3003" "768" \
        "services/unified-detector/Dockerfile" "arbitrage-high-value" \
        "partition-high-value.toml")"

    # Solana
    write_or_diff "partition-solana.toml" "$(generate_partition_toml \
        "Solana partition" "solana-native" "solana" \
        "sjc" "us-west1" "3004" "512" \
        "services/partition-solana/Dockerfile" "arbitrage-solana" \
        "partition-solana.toml")"

    # --- Non-partition services ---

    # Coordinator (primary)
    write_or_diff "coordinator.toml" "$(generate_service_toml \
        "Coordinator (Primary)" "sjc" "us-west1" "3000" "256" \
        "services/coordinator/Dockerfile" "arbitrage-coordinator" \
        "coordinator.toml" "/api/health" \
        "  PORT = \"3000\"
  IS_STANDBY = \"false\"
  CAN_BECOME_LEADER = \"true\"
" "" "50" "40")"

    # Coordinator (standby)
    write_or_diff "coordinator-standby.toml" "$(generate_service_toml \
        "Coordinator (Standby)" "sjc" "us-west1" "3000" "256" \
        "services/coordinator/Dockerfile" "arbitrage-coordinator-standby" \
        "coordinator-standby.toml" "/api/health" \
        "  PORT = \"3000\"
  IS_STANDBY = \"true\"
  CAN_BECOME_LEADER = \"true\"
" "" "50" "40")"

    # Execution Engine
    write_or_diff "execution-engine.toml" "$(generate_service_toml \
        "Execution Engine" "sjc" "us-west1" "8080" "384" \
        "services/execution-engine/Dockerfile" "arbitrage-execution-engine" \
        "execution-engine.toml" "/health" \
        "  # RPC URLs and private keys set via secrets (fly secrets set)
" "#
# Notes:
# - Hot-path service: latency-critical (<50ms target)
# - Requires wallet private keys via secrets (NEVER in env/toml)
# - Internal port 8080 (overrides code default of 3005 via HEALTH_CHECK_PORT env var)
" "25" "20" "true")"

    # Cross-Chain Detector
    write_or_diff "cross-chain-detector.toml" "$(generate_service_toml \
        "Cross-Chain Detector" "sjc" "us-west1" "3006" "256" \
        "services/cross-chain-detector/Dockerfile" "arbitrage-cross-chain" \
        "cross-chain-detector.toml" "/health" \
        "  PORT = \"3006\"
" "" "50" "40")"

    echo ""
    echo "Done! Review generated files and commit."
}

main
