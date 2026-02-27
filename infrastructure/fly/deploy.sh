#!/bin/bash
# Fly.io Deployment Script
#
# Deploys arbitrage services to Fly.io
#
# Usage:
#   ./deploy.sh [service] [--secrets]
#
# Services:
#   coordinator        Deploy Coordinator (primary)
#   coordinator-standby Deploy Coordinator standby instance
#   execution-engine   Deploy Execution Engine
#   l2-turbo           Deploy L2-Turbo partition (Arbitrum, Optimism, Base, Scroll, Blast)
#   high-value         Deploy High-Value partition (Ethereum, zkSync, Linea)
#   asia-fast           Deploy Asia-Fast partition (BSC, Polygon, Avalanche, Fantom)
#   solana             Deploy Solana partition
#   cross-chain        Deploy Cross-Chain Detector
#   all                Deploy all Fly.io services
#
# Options:
#   --secrets          Set up secrets before deployment
#   --dry-run          Show what would be deployed without deploying
#
# @see ADR-003: Partitioned Chain Detectors
# @see ADR-006: Free Hosting Provider Selection

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if fly CLI is installed
check_fly_cli() {
    if ! command -v fly &> /dev/null; then
        log_error "Fly CLI (flyctl) not found. Install from https://fly.io/docs/hands-on/install-flyctl/"
        exit 1
    fi
    log_info "Fly CLI found: $(fly version)"
}

# Check if logged in to Fly.io
check_fly_auth() {
    if ! fly auth whoami &> /dev/null; then
        log_error "Not logged in to Fly.io. Run 'fly auth login' first."
        exit 1
    fi
    log_info "Logged in to Fly.io as: $(fly auth whoami)"
}

# =============================================================================
# Generic secrets setup — all setup_*_secrets() functions delegate to this
# =============================================================================
# Args: $1=display_name, $2=config_file, $3...=additional secret names
# Common secrets (REDIS_URL, STREAM_SIGNING_KEY) are always prompted first.
# Additional secrets are prompted in the order specified.
setup_service_secrets() {
    local display_name="$1"
    local config_file="$2"
    shift 2
    local extra_secrets=("$@")

    log_info "Setting up secrets for ${display_name}..."
    log_warn "Secrets will be hidden from terminal output for security"

    local args=()
    local value

    # Common secrets (all services need these)
    echo -n "Enter REDIS_URL (Redis connection URL — self-hosted recommended): "
    read -rs value; echo ""
    args+=("REDIS_URL=${value}")

    echo -n "Enter STREAM_SIGNING_KEY (HMAC key for Redis Streams — must match all services): "
    read -rs value; echo ""
    args+=("STREAM_SIGNING_KEY=${value}")

    # Service-specific secrets
    for secret_name in "${extra_secrets[@]}"; do
        echo -n "Enter ${secret_name}: "
        read -rs value; echo ""
        args+=("${secret_name}=${value}")
    done

    fly secrets set "${args[@]}" -c "${config_file}"

    log_info "Secrets set for ${display_name}"
}

# Service-specific secret setup wrappers — all delegate to setup_service_secrets()
setup_l2_turbo_secrets() {
    setup_service_secrets "L2-Turbo partition" "$SCRIPT_DIR/partition-l2-turbo.toml" \
        ARBITRUM_WS_URL ARBITRUM_RPC_URL OPTIMISM_WS_URL OPTIMISM_RPC_URL \
        BASE_WS_URL BASE_RPC_URL SCROLL_WS_URL SCROLL_RPC_URL BLAST_WS_URL BLAST_RPC_URL
}

setup_coordinator_standby_secrets() {
    setup_service_secrets "Coordinator standby" "$SCRIPT_DIR/coordinator-standby.toml"
}

setup_coordinator_secrets() {
    setup_service_secrets "Coordinator (primary)" "$SCRIPT_DIR/coordinator.toml"
}

setup_execution_engine_secrets() {
    setup_service_secrets "Execution Engine" "$SCRIPT_DIR/execution-engine.toml" \
        WALLET_PRIVATE_KEY ETHEREUM_RPC_URL BSC_RPC_URL ARBITRUM_RPC_URL \
        BASE_RPC_URL POLYGON_RPC_URL OPTIMISM_RPC_URL
}

setup_high_value_secrets() {
    setup_service_secrets "High-Value partition" "$SCRIPT_DIR/partition-high-value.toml" \
        ETHEREUM_WS_URL ETHEREUM_RPC_URL ZKSYNC_WS_URL ZKSYNC_RPC_URL LINEA_WS_URL LINEA_RPC_URL
}

# Generic deploy function — all deploy_* functions delegate to this
# Args: $1=display_name, $2=app_name, $3=config_file, $4=grep_pattern (optional, defaults to app_name)
deploy_service() {
    local display_name="$1"
    local app_name="$2"
    local config_file="$3"
    local grep_pattern="${4:-$app_name}"

    log_info "Deploying ${display_name}..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c ${config_file}"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$config_file" ]; then
        log_error "Config file not found: ${config_file}"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "${grep_pattern}"; then
        log_info "Creating app: ${app_name}"
        if ! fly apps create "${app_name}" --org personal; then
            log_error "Failed to create app: ${app_name}"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "${config_file}"; then
        log_error "Deployment failed for ${display_name}"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "${app_name}" "${config_file}"; then
        log_error "Deployment verification failed for ${display_name}"
        return 1
    fi

    log_info "${display_name} deployed and verified successfully"
}

# Verify deployment health
verify_deployment_health() {
    local app_name=$1
    local config_file=$2
    local max_attempts=${3:-10}
    local wait_time=${4:-10}

    log_info "Verifying deployment health for $app_name..."

    for attempt in $(seq 1 "$max_attempts"); do
        log_info "Health check attempt $attempt/$max_attempts..."

        # Check if any machine is running
        local status
        status=$(fly status -c "$config_file" --json 2>/dev/null | grep -o '"state":"started"' | head -1 || true)

        if [ -n "$status" ]; then
            log_info "Deployment healthy: $app_name is running"
            return 0
        fi

        if [ "$attempt" -lt "$max_attempts" ]; then
            log_warn "Waiting ${wait_time}s before next health check..."
            sleep "$wait_time"
        fi
    done

    log_error "Deployment verification failed: $app_name did not become healthy after $max_attempts attempts"
    return 1
}

# Service-specific deploy wrappers — all delegate to deploy_service()
deploy_l2_turbo() {
    deploy_service "L2-Turbo partition" "arbitrage-l2-fast" "$SCRIPT_DIR/partition-l2-turbo.toml"
}

deploy_coordinator_standby() {
    deploy_service "Coordinator standby" "arbitrage-coordinator-standby" "$SCRIPT_DIR/coordinator-standby.toml"
}

# Coordinator uses [^-] grep pattern to avoid matching coordinator-standby
deploy_coordinator() {
    deploy_service "Coordinator (primary)" "arbitrage-coordinator" "$SCRIPT_DIR/coordinator.toml" "arbitrage-coordinator[^-]"
}

deploy_execution_engine() {
    deploy_service "Execution Engine" "arbitrage-execution-engine" "$SCRIPT_DIR/execution-engine.toml"
}

deploy_high_value() {
    deploy_service "High-Value partition" "arbitrage-high-value" "$SCRIPT_DIR/partition-high-value.toml"
}

deploy_asia_fast() {
    deploy_service "Asia-Fast partition" "arbitrage-asia-fast" "$SCRIPT_DIR/partition-asia-fast.toml"
}

setup_asia_fast_secrets() {
    setup_service_secrets "Asia-Fast partition" "$SCRIPT_DIR/partition-asia-fast.toml" \
        BSC_WS_URL BSC_RPC_URL POLYGON_WS_URL POLYGON_RPC_URL \
        AVALANCHE_WS_URL AVALANCHE_RPC_URL FANTOM_WS_URL FANTOM_RPC_URL
}

setup_solana_secrets() {
    setup_service_secrets "Solana partition" "$SCRIPT_DIR/partition-solana.toml" \
        SOLANA_RPC_URL SOLANA_WS_URL
}

deploy_solana() {
    deploy_service "Solana partition" "arbitrage-solana" "$SCRIPT_DIR/partition-solana.toml"
}

setup_cross_chain_secrets() {
    setup_service_secrets "Cross-Chain Detector" "$SCRIPT_DIR/cross-chain-detector.toml" \
        ETHEREUM_RPC_URL ARBITRUM_RPC_URL BASE_RPC_URL OPTIMISM_RPC_URL BSC_RPC_URL POLYGON_RPC_URL
}

deploy_cross_chain() {
    deploy_service "Cross-Chain Detector" "arbitrage-cross-chain" "$SCRIPT_DIR/cross-chain-detector.toml"
}

# Show status of all Fly.io services
show_status() {
    log_info "Fly.io Services Status:"
    echo ""

    local apps_list
    apps_list=$(fly apps list 2>/dev/null || true)

    if echo "$apps_list" | grep -q "arbitrage-coordinator[^-]"; then
        echo "=== Coordinator (Primary) ==="
        fly status -c "$SCRIPT_DIR/coordinator.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-coordinator-standby"; then
        echo "=== Coordinator Standby ==="
        fly status -c "$SCRIPT_DIR/coordinator-standby.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-execution-engine"; then
        echo "=== Execution Engine ==="
        fly status -c "$SCRIPT_DIR/execution-engine.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-l2-fast"; then
        echo "=== L2-Turbo Partition ==="
        fly status -c "$SCRIPT_DIR/partition-l2-turbo.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-high-value"; then
        echo "=== High-Value Partition ==="
        fly status -c "$SCRIPT_DIR/partition-high-value.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-asia-fast"; then
        echo "=== Asia-Fast Partition ==="
        fly status -c "$SCRIPT_DIR/partition-asia-fast.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-solana"; then
        echo "=== Solana Partition ==="
        fly status -c "$SCRIPT_DIR/partition-solana.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-cross-chain"; then
        echo "=== Cross-Chain Detector ==="
        fly status -c "$SCRIPT_DIR/cross-chain-detector.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi
}

# Main
main() {
    SERVICE=""
    SETUP_SECRETS=false
    DRY_RUN=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            coordinator|coordinator-standby|execution-engine|l2-turbo|high-value|asia-fast|solana|cross-chain|all|status)
                SERVICE="$1"
                shift
                ;;
            --secrets)
                SETUP_SECRETS=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            -h|--help)
                echo "Usage: $0 [service] [--secrets] [--dry-run]"
                echo ""
                echo "Services:"
                echo "  coordinator          Deploy Coordinator (primary)"
                echo "  coordinator-standby  Deploy Coordinator standby"
                echo "  execution-engine     Deploy Execution Engine"
                echo "  l2-turbo             Deploy L2-Turbo partition"
                echo "  high-value           Deploy High-Value partition"
                echo "  asia-fast            Deploy Asia-Fast partition"
                echo "  solana               Deploy Solana partition"
                echo "  cross-chain          Deploy Cross-Chain Detector"
                echo "  all                  Deploy all services"
                echo "  status               Show status of all services"
                echo ""
                echo "Options:"
                echo "  --secrets            Set up secrets before deployment"
                echo "  --dry-run            Show what would be deployed"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    if [ -z "$SERVICE" ]; then
        log_error "No service specified. Use -h for help."
        exit 1
    fi

    check_fly_cli
    check_fly_auth

    case $SERVICE in
        coordinator)
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_secrets
            deploy_coordinator
            ;;
        coordinator-standby)
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_standby_secrets
            deploy_coordinator_standby
            ;;
        execution-engine)
            [ "$SETUP_SECRETS" = true ] && setup_execution_engine_secrets
            deploy_execution_engine
            ;;
        l2-turbo)
            [ "$SETUP_SECRETS" = true ] && setup_l2_turbo_secrets
            deploy_l2_turbo
            ;;
        high-value)
            [ "$SETUP_SECRETS" = true ] && setup_high_value_secrets
            deploy_high_value
            ;;
        asia-fast)
            [ "$SETUP_SECRETS" = true ] && setup_asia_fast_secrets
            deploy_asia_fast
            ;;
        solana)
            [ "$SETUP_SECRETS" = true ] && setup_solana_secrets
            deploy_solana
            ;;
        cross-chain)
            [ "$SETUP_SECRETS" = true ] && setup_cross_chain_secrets
            deploy_cross_chain
            ;;
        all)
            # Set up secrets for all services if requested
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_secrets
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_standby_secrets
            [ "$SETUP_SECRETS" = true ] && setup_execution_engine_secrets
            [ "$SETUP_SECRETS" = true ] && setup_l2_turbo_secrets
            [ "$SETUP_SECRETS" = true ] && setup_high_value_secrets
            [ "$SETUP_SECRETS" = true ] && setup_asia_fast_secrets
            [ "$SETUP_SECRETS" = true ] && setup_solana_secrets
            [ "$SETUP_SECRETS" = true ] && setup_cross_chain_secrets
            # Deploy partitions in parallel (independent services), then dependent services sequentially
            log_info "Deploying partitions in parallel..."
            deploy_l2_turbo &
            deploy_high_value &
            deploy_asia_fast &
            deploy_solana &
            wait
            log_info "All partitions deployed, continuing with dependent services..."
            deploy_cross_chain
            deploy_execution_engine
            deploy_coordinator
            deploy_coordinator_standby
            ;;
        status)
            show_status
            ;;
    esac

    log_info "Done!"
}

main "$@"
