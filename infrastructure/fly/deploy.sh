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
#   l2-fast            Deploy L2-Fast partition (Arbitrum, Optimism, Base)
#   high-value         Deploy High-Value partition (Ethereum, zkSync, Linea)
#   solana             Deploy Solana partition
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

# Set up secrets for L2-Fast partition
setup_l2_fast_secrets() {
    log_info "Setting up secrets for L2-Fast partition..."
    log_warn "Secrets will be hidden from terminal output for security"

    echo -n "Enter REDIS_URL (Upstash Redis connection URL): "
    read -rs REDIS_URL
    echo ""

    echo -n "Enter ARBITRUM_WS_URL: "
    read -rs ARBITRUM_WS_URL
    echo ""

    echo -n "Enter ARBITRUM_RPC_URL: "
    read -rs ARBITRUM_RPC_URL
    echo ""

    echo -n "Enter OPTIMISM_WS_URL: "
    read -rs OPTIMISM_WS_URL
    echo ""

    echo -n "Enter OPTIMISM_RPC_URL: "
    read -rs OPTIMISM_RPC_URL
    echo ""

    echo -n "Enter BASE_WS_URL: "
    read -rs BASE_WS_URL
    echo ""

    echo -n "Enter BASE_RPC_URL: "
    read -rs BASE_RPC_URL
    echo ""

    fly secrets set \
        REDIS_URL="$REDIS_URL" \
        ARBITRUM_WS_URL="$ARBITRUM_WS_URL" \
        ARBITRUM_RPC_URL="$ARBITRUM_RPC_URL" \
        OPTIMISM_WS_URL="$OPTIMISM_WS_URL" \
        OPTIMISM_RPC_URL="$OPTIMISM_RPC_URL" \
        BASE_WS_URL="$BASE_WS_URL" \
        BASE_RPC_URL="$BASE_RPC_URL" \
        -c "$SCRIPT_DIR/partition-l2-fast.toml"

    log_info "Secrets set for L2-Fast partition"
}

# Set up secrets for Coordinator standby
setup_coordinator_standby_secrets() {
    log_info "Setting up secrets for Coordinator standby..."
    log_warn "Secrets will be hidden from terminal output for security"

    echo -n "Enter REDIS_URL (Upstash Redis connection URL): "
    read -rs REDIS_URL
    echo ""

    fly secrets set \
        REDIS_URL="$REDIS_URL" \
        -c "$SCRIPT_DIR/coordinator-standby.toml"

    log_info "Secrets set for Coordinator standby"
}

# Set up secrets for Coordinator (primary)
setup_coordinator_secrets() {
    log_info "Setting up secrets for Coordinator (primary)..."
    log_warn "Secrets will be hidden from terminal output for security"

    echo -n "Enter REDIS_URL (Upstash Redis connection URL): "
    read -rs REDIS_URL
    echo ""

    fly secrets set \
        REDIS_URL="$REDIS_URL" \
        -c "$SCRIPT_DIR/coordinator.toml"

    log_info "Secrets set for Coordinator (primary)"
}

# Set up secrets for Execution Engine
setup_execution_engine_secrets() {
    log_info "Setting up secrets for Execution Engine..."
    log_warn "Secrets will be hidden from terminal output for security"

    echo -n "Enter REDIS_URL (Upstash Redis connection URL): "
    read -rs REDIS_URL
    echo ""

    echo -n "Enter WALLET_PRIVATE_KEY (primary wallet): "
    read -rs WALLET_PRIVATE_KEY
    echo ""

    echo -n "Enter ETHEREUM_RPC_URL: "
    read -rs ETHEREUM_RPC_URL
    echo ""

    echo -n "Enter BSC_RPC_URL: "
    read -rs BSC_RPC_URL
    echo ""

    echo -n "Enter ARBITRUM_RPC_URL: "
    read -rs ARBITRUM_RPC_URL
    echo ""

    echo -n "Enter BASE_RPC_URL: "
    read -rs BASE_RPC_URL
    echo ""

    echo -n "Enter POLYGON_RPC_URL: "
    read -rs POLYGON_RPC_URL
    echo ""

    echo -n "Enter OPTIMISM_RPC_URL: "
    read -rs OPTIMISM_RPC_URL
    echo ""

    fly secrets set \
        REDIS_URL="$REDIS_URL" \
        WALLET_PRIVATE_KEY="$WALLET_PRIVATE_KEY" \
        ETHEREUM_RPC_URL="$ETHEREUM_RPC_URL" \
        BSC_RPC_URL="$BSC_RPC_URL" \
        ARBITRUM_RPC_URL="$ARBITRUM_RPC_URL" \
        BASE_RPC_URL="$BASE_RPC_URL" \
        POLYGON_RPC_URL="$POLYGON_RPC_URL" \
        OPTIMISM_RPC_URL="$OPTIMISM_RPC_URL" \
        -c "$SCRIPT_DIR/execution-engine.toml"

    log_info "Secrets set for Execution Engine"
}

# Set up secrets for High-Value partition
setup_high_value_secrets() {
    log_info "Setting up secrets for High-Value partition..."
    log_warn "Secrets will be hidden from terminal output for security"

    echo -n "Enter REDIS_URL (Upstash Redis connection URL): "
    read -rs REDIS_URL
    echo ""

    echo -n "Enter ETHEREUM_WS_URL: "
    read -rs ETHEREUM_WS_URL
    echo ""

    echo -n "Enter ETHEREUM_RPC_URL: "
    read -rs ETHEREUM_RPC_URL
    echo ""

    echo -n "Enter ZKSYNC_WS_URL: "
    read -rs ZKSYNC_WS_URL
    echo ""

    echo -n "Enter ZKSYNC_RPC_URL: "
    read -rs ZKSYNC_RPC_URL
    echo ""

    echo -n "Enter LINEA_WS_URL: "
    read -rs LINEA_WS_URL
    echo ""

    echo -n "Enter LINEA_RPC_URL: "
    read -rs LINEA_RPC_URL
    echo ""

    fly secrets set \
        REDIS_URL="$REDIS_URL" \
        ETHEREUM_WS_URL="$ETHEREUM_WS_URL" \
        ETHEREUM_RPC_URL="$ETHEREUM_RPC_URL" \
        ZKSYNC_WS_URL="$ZKSYNC_WS_URL" \
        ZKSYNC_RPC_URL="$ZKSYNC_RPC_URL" \
        LINEA_WS_URL="$LINEA_WS_URL" \
        LINEA_RPC_URL="$LINEA_RPC_URL" \
        -c "$SCRIPT_DIR/partition-high-value.toml"

    log_info "Secrets set for High-Value partition"
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

# Deploy L2-Fast partition
deploy_l2_fast() {
    log_info "Deploying L2-Fast partition..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/partition-l2-fast.toml"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$SCRIPT_DIR/partition-l2-fast.toml" ]; then
        log_error "Config file not found: $SCRIPT_DIR/partition-l2-fast.toml"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "arbitrage-l2-fast"; then
        log_info "Creating app: arbitrage-l2-fast"
        if ! fly apps create arbitrage-l2-fast --org personal; then
            log_error "Failed to create app: arbitrage-l2-fast"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "$SCRIPT_DIR/partition-l2-fast.toml"; then
        log_error "Deployment failed for L2-Fast partition"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "arbitrage-l2-fast" "$SCRIPT_DIR/partition-l2-fast.toml"; then
        log_error "Deployment verification failed for L2-Fast partition"
        return 1
    fi

    log_info "L2-Fast partition deployed and verified successfully"
}

# Deploy Coordinator standby
deploy_coordinator_standby() {
    log_info "Deploying Coordinator standby..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/coordinator-standby.toml"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$SCRIPT_DIR/coordinator-standby.toml" ]; then
        log_error "Config file not found: $SCRIPT_DIR/coordinator-standby.toml"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "arbitrage-coordinator-standby"; then
        log_info "Creating app: arbitrage-coordinator-standby"
        if ! fly apps create arbitrage-coordinator-standby --org personal; then
            log_error "Failed to create app: arbitrage-coordinator-standby"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "$SCRIPT_DIR/coordinator-standby.toml"; then
        log_error "Deployment failed for Coordinator standby"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "arbitrage-coordinator-standby" "$SCRIPT_DIR/coordinator-standby.toml"; then
        log_error "Deployment verification failed for Coordinator standby"
        return 1
    fi

    log_info "Coordinator standby deployed and verified successfully"
}

# Deploy Coordinator (primary)
deploy_coordinator() {
    log_info "Deploying Coordinator (primary)..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/coordinator.toml"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$SCRIPT_DIR/coordinator.toml" ]; then
        log_error "Config file not found: $SCRIPT_DIR/coordinator.toml"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "arbitrage-coordinator"; then
        log_info "Creating app: arbitrage-coordinator"
        if ! fly apps create arbitrage-coordinator --org personal; then
            log_error "Failed to create app: arbitrage-coordinator"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "$SCRIPT_DIR/coordinator.toml"; then
        log_error "Deployment failed for Coordinator (primary)"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "arbitrage-coordinator" "$SCRIPT_DIR/coordinator.toml"; then
        log_error "Deployment verification failed for Coordinator (primary)"
        return 1
    fi

    log_info "Coordinator (primary) deployed and verified successfully"
}

# Deploy Execution Engine
deploy_execution_engine() {
    log_info "Deploying Execution Engine..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/execution-engine.toml"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$SCRIPT_DIR/execution-engine.toml" ]; then
        log_error "Config file not found: $SCRIPT_DIR/execution-engine.toml"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "arbitrage-execution-engine"; then
        log_info "Creating app: arbitrage-execution-engine"
        if ! fly apps create arbitrage-execution-engine --org personal; then
            log_error "Failed to create app: arbitrage-execution-engine"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "$SCRIPT_DIR/execution-engine.toml"; then
        log_error "Deployment failed for Execution Engine"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "arbitrage-execution-engine" "$SCRIPT_DIR/execution-engine.toml"; then
        log_error "Deployment verification failed for Execution Engine"
        return 1
    fi

    log_info "Execution Engine deployed and verified successfully"
}

# Deploy High-Value partition
deploy_high_value() {
    log_info "Deploying High-Value partition..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/partition-high-value.toml"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$SCRIPT_DIR/partition-high-value.toml" ]; then
        log_error "Config file not found: $SCRIPT_DIR/partition-high-value.toml"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "arbitrage-high-value"; then
        log_info "Creating app: arbitrage-high-value"
        if ! fly apps create arbitrage-high-value --org personal; then
            log_error "Failed to create app: arbitrage-high-value"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "$SCRIPT_DIR/partition-high-value.toml"; then
        log_error "Deployment failed for High-Value partition"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "arbitrage-high-value" "$SCRIPT_DIR/partition-high-value.toml"; then
        log_error "Deployment verification failed for High-Value partition"
        return 1
    fi

    log_info "High-Value partition deployed and verified successfully"
}

# Set up secrets for Solana partition
setup_solana_secrets() {
    log_info "Setting up secrets for Solana partition..."
    log_warn "Secrets will be hidden from terminal output for security"

    echo -n "Enter REDIS_URL (Upstash Redis connection URL): "
    read -rs REDIS_URL
    echo ""

    echo -n "Enter SOLANA_RPC_URL: "
    read -rs SOLANA_RPC_URL
    echo ""

    echo -n "Enter SOLANA_WS_URL: "
    read -rs SOLANA_WS_URL
    echo ""

    fly secrets set \
        REDIS_URL="$REDIS_URL" \
        SOLANA_RPC_URL="$SOLANA_RPC_URL" \
        SOLANA_WS_URL="$SOLANA_WS_URL" \
        -c "$SCRIPT_DIR/partition-solana.toml"

    log_info "Secrets set for Solana partition"
}

# Deploy Solana partition
deploy_solana() {
    log_info "Deploying Solana partition..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/partition-solana.toml"
        return 0
    fi

    # Verify config file exists
    if [ ! -f "$SCRIPT_DIR/partition-solana.toml" ]; then
        log_error "Config file not found: $SCRIPT_DIR/partition-solana.toml"
        return 1
    fi

    # Create app if it doesn't exist
    if ! fly apps list 2>/dev/null | grep -q "arbitrage-solana"; then
        log_info "Creating app: arbitrage-solana"
        if ! fly apps create arbitrage-solana --org personal; then
            log_error "Failed to create app: arbitrage-solana"
            return 1
        fi
    fi

    # Deploy with error handling
    if ! fly deploy -c "$SCRIPT_DIR/partition-solana.toml"; then
        log_error "Deployment failed for Solana partition"
        return 1
    fi

    # Verify deployment health
    if ! verify_deployment_health "arbitrage-solana" "$SCRIPT_DIR/partition-solana.toml"; then
        log_error "Deployment verification failed for Solana partition"
        return 1
    fi

    log_info "Solana partition deployed and verified successfully"
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
        echo "=== L2-Fast Partition ==="
        fly status -c "$SCRIPT_DIR/partition-l2-fast.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-high-value"; then
        echo "=== High-Value Partition ==="
        fly status -c "$SCRIPT_DIR/partition-high-value.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if echo "$apps_list" | grep -q "arbitrage-solana"; then
        echo "=== Solana Partition ==="
        fly status -c "$SCRIPT_DIR/partition-solana.toml" 2>/dev/null || echo "Not deployed"
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
            coordinator|coordinator-standby|execution-engine|l2-fast|high-value|solana|all|status)
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
                echo "  l2-fast              Deploy L2-Fast partition"
                echo "  high-value           Deploy High-Value partition"
                echo "  solana               Deploy Solana partition"
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
        l2-fast)
            [ "$SETUP_SECRETS" = true ] && setup_l2_fast_secrets
            deploy_l2_fast
            ;;
        high-value)
            [ "$SETUP_SECRETS" = true ] && setup_high_value_secrets
            deploy_high_value
            ;;
        solana)
            [ "$SETUP_SECRETS" = true ] && setup_solana_secrets
            deploy_solana
            ;;
        all)
            # Set up secrets for all services if requested
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_secrets
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_standby_secrets
            [ "$SETUP_SECRETS" = true ] && setup_execution_engine_secrets
            [ "$SETUP_SECRETS" = true ] && setup_l2_fast_secrets
            [ "$SETUP_SECRETS" = true ] && setup_high_value_secrets
            [ "$SETUP_SECRETS" = true ] && setup_solana_secrets
            # Deploy in dependency order: partitions first, then execution, then coordinator
            deploy_l2_fast
            deploy_high_value
            deploy_solana
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
