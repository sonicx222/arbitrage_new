#!/bin/bash
# Fly.io Deployment Script
#
# Deploys arbitrage services to Fly.io
#
# Usage:
#   ./deploy.sh [service] [--secrets]
#
# Services:
#   l2-fast            Deploy L2-Fast partition (Arbitrum, Optimism, Base)
#   coordinator-standby Deploy Coordinator standby instance
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
setup_coordinator_secrets() {
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

# Deploy L2-Fast partition
deploy_l2_fast() {
    log_info "Deploying L2-Fast partition..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/partition-l2-fast.toml"
        return
    fi

    # Create app if it doesn't exist
    if ! fly apps list | grep -q "arbitrage-l2-fast"; then
        log_info "Creating app: arbitrage-l2-fast"
        fly apps create arbitrage-l2-fast --org personal
    fi

    fly deploy -c "$SCRIPT_DIR/partition-l2-fast.toml"

    log_info "L2-Fast partition deployed successfully"
}

# Deploy Coordinator standby
deploy_coordinator_standby() {
    log_info "Deploying Coordinator standby..."

    cd "$PROJECT_ROOT"

    if [ "$DRY_RUN" = true ]; then
        log_info "[DRY-RUN] Would deploy: fly deploy -c $SCRIPT_DIR/coordinator-standby.toml"
        return
    fi

    # Create app if it doesn't exist
    if ! fly apps list | grep -q "arbitrage-coordinator-standby"; then
        log_info "Creating app: arbitrage-coordinator-standby"
        fly apps create arbitrage-coordinator-standby --org personal
    fi

    fly deploy -c "$SCRIPT_DIR/coordinator-standby.toml"

    log_info "Coordinator standby deployed successfully"
}

# Show status of all Fly.io services
show_status() {
    log_info "Fly.io Services Status:"
    echo ""

    if fly apps list | grep -q "arbitrage-l2-fast"; then
        echo "=== L2-Fast Partition ==="
        fly status -c "$SCRIPT_DIR/partition-l2-fast.toml" 2>/dev/null || echo "Not deployed"
        echo ""
    fi

    if fly apps list | grep -q "arbitrage-coordinator-standby"; then
        echo "=== Coordinator Standby ==="
        fly status -c "$SCRIPT_DIR/coordinator-standby.toml" 2>/dev/null || echo "Not deployed"
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
            l2-fast|coordinator-standby|all|status)
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
                echo "  l2-fast              Deploy L2-Fast partition"
                echo "  coordinator-standby  Deploy Coordinator standby"
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
        l2-fast)
            [ "$SETUP_SECRETS" = true ] && setup_l2_fast_secrets
            deploy_l2_fast
            ;;
        coordinator-standby)
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_secrets
            deploy_coordinator_standby
            ;;
        all)
            [ "$SETUP_SECRETS" = true ] && setup_l2_fast_secrets
            [ "$SETUP_SECRETS" = true ] && setup_coordinator_secrets
            deploy_l2_fast
            deploy_coordinator_standby
            ;;
        status)
            show_status
            ;;
    esac

    log_info "Done!"
}

main "$@"
