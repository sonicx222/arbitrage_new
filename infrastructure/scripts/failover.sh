#!/bin/bash
# Failover Automation Script
#
# Monitors service health and triggers failover when primary services fail
# Implements ADR-007 Cross-Region Failover Strategy
#
# Usage:
#   ./failover.sh monitor      # Start continuous health monitoring
#   ./failover.sh check        # One-time health check
#   ./failover.sh trigger <service>  # Manual failover trigger
#   ./failover.sh status       # Show all service status
#
# @see ADR-007: Cross-Region Failover Strategy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared health utilities if available
if [ -f "$SCRIPT_DIR/lib/health-utils.sh" ]; then
    # shellcheck source=./lib/health-utils.sh
    source "$SCRIPT_DIR/lib/health-utils.sh"
fi

# Default configuration
# HEALTH_CHECK_INTERVAL: Time between health checks in seconds (default: 15s per ADR-007)
HEALTH_CHECK_INTERVAL=${HEALTH_CHECK_INTERVAL:-15}
# FAILOVER_THRESHOLD: Number of consecutive health check failures before triggering failover
# Example: FAILOVER_THRESHOLD=3 means "fail 3 times in a row, then failover"
FAILOVER_THRESHOLD=${FAILOVER_THRESHOLD:-3}
# ALERT_WEBHOOK: URL to send failover alerts (optional)
ALERT_WEBHOOK=${ALERT_WEBHOOK:-}

# Lock file for preventing concurrent monitor instances
LOCK_FILE="/tmp/arbitrage-failover-monitor.lock"
LOCK_FD=201
FAILURE_COUNTS_INITIALIZED=false

# Acquire lock to prevent concurrent monitor instances
acquire_monitor_lock() {
    exec 201>"$LOCK_FILE"
    if ! flock -n 201; then
        log_error "Another failover monitor is already running"
        exit 1
    fi
    # Clean up on exit
    trap cleanup_on_exit EXIT INT TERM
}

# Cleanup function
cleanup_on_exit() {
    log_info "Shutting down failover monitor..."
    flock -u 201 2>/dev/null || true
    rm -f "$LOCK_FILE" 2>/dev/null || true
}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }
log_debug() { [ "$DEBUG" = "true" ] && echo -e "${BLUE}[DEBUG]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }

# Service endpoints (configure via environment or config file)
# Helper function to build health endpoint URL safely
build_health_url() {
    local base_url="$1"
    if [ -n "$base_url" ]; then
        echo "${base_url}/health"
    else
        echo ""  # Return empty if no URL configured
    fi
}

# Service endpoint definitions
# Port mappings (per ADR-003 and docker-compose.partition.yml):
#   - Coordinator:           3000
#   - partition-asia-fast:   3011
#   - partition-l2-fast:     3012
#   - partition-high-value:  3013
#   - partition-solana:      3014
#   - execution-engine:      3015
#   - cross-chain-detector:  3016
declare -A SERVICE_ENDPOINTS=(
    ["coordinator-primary"]="$(build_health_url "${COORDINATOR_PRIMARY_URL:-http://localhost:3000}")"
    ["coordinator-standby"]="$(build_health_url "${COORDINATOR_STANDBY_URL:-}")"
    ["partition-asia-fast"]="$(build_health_url "${PARTITION_ASIA_FAST_URL:-http://localhost:3011}")"
    ["partition-l2-fast"]="$(build_health_url "${PARTITION_L2_FAST_URL:-http://localhost:3012}")"
    ["partition-high-value"]="$(build_health_url "${PARTITION_HIGH_VALUE_URL:-http://localhost:3013}")"
    ["partition-solana"]="$(build_health_url "${PARTITION_SOLANA_URL:-http://localhost:3014}")"
    ["cross-chain-detector"]="$(build_health_url "${CROSS_CHAIN_URL:-http://localhost:3016}")"
    ["execution-engine"]="$(build_health_url "${EXECUTION_URL:-http://localhost:3015}")"
)

# Standby service mappings
# Maps primary services to their standby counterparts for failover
# Empty string means no standby configured (service enters degraded mode on failure)
declare -A STANDBY_SERVICES=(
    ["coordinator-primary"]="coordinator-standby"
    ["partition-asia-fast"]=""
    ["partition-l2-fast"]=""
    ["partition-high-value"]=""
    ["partition-solana"]=""
)

# Failure counters
declare -A FAILURE_COUNTS

# Initialize failure counts (safe to call multiple times)
init_failure_counts() {
    if [ "$FAILURE_COUNTS_INITIALIZED" = "true" ]; then
        return
    fi
    for service in "${!SERVICE_ENDPOINTS[@]}"; do
        FAILURE_COUNTS[$service]=0
    done
    FAILURE_COUNTS_INITIALIZED=true
}

# Safe getter for failure count (returns 0 if not initialized)
get_failure_count() {
    local service=$1
    # Ensure initialized
    if [ "$FAILURE_COUNTS_INITIALIZED" != "true" ]; then
        init_failure_counts
    fi
    echo "${FAILURE_COUNTS[$service]:-0}"
}

# Safe increment for failure count
increment_failure_count() {
    local service=$1
    # Ensure initialized
    if [ "$FAILURE_COUNTS_INITIALIZED" != "true" ]; then
        init_failure_counts
    fi
    local current="${FAILURE_COUNTS[$service]:-0}"
    FAILURE_COUNTS[$service]=$((current + 1))
}

# Reset failure count for a service
reset_failure_count() {
    local service=$1
    if [ "$FAILURE_COUNTS_INITIALIZED" != "true" ]; then
        init_failure_counts
    fi
    FAILURE_COUNTS[$service]=0
}

# Check health of a single service
check_service_health() {
    local service=$1
    local endpoint=${SERVICE_ENDPOINTS[$service]}

    # Skip if endpoint is empty (not configured)
    if [ -z "$endpoint" ]; then
        log_debug "Service $service not configured, skipping"
        return 2
    fi

    log_debug "Checking health of $service at $endpoint"

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$endpoint" 2>/dev/null)

    if [ "$http_code" = "200" ]; then
        return 0
    else
        return 1
    fi
}

# Check all services health
check_all_health() {
    local all_healthy=true

    # Ensure failure counts are initialized
    init_failure_counts

    echo ""
    printf "%-25s %-10s %-15s\n" "SERVICE" "STATUS" "FAILURES"
    printf "%-25s %-10s %-15s\n" "-------" "------" "--------"

    for service in "${!SERVICE_ENDPOINTS[@]}"; do
        local endpoint="${SERVICE_ENDPOINTS[$service]:-}"
        # Skip if endpoint is empty (not configured)
        if [ -z "$endpoint" ]; then
            printf "%-25s %-10s %-15s\n" "$service" "SKIPPED" "-"
            continue
        fi

        if check_service_health "$service"; then
            reset_failure_count "$service"
            printf "%-25s ${GREEN}%-10s${NC} %-15s\n" "$service" "HEALTHY" "0"
        else
            increment_failure_count "$service"
            local current_count
            current_count=$(get_failure_count "$service")
            printf "%-25s ${RED}%-10s${NC} %-15s\n" "$service" "UNHEALTHY" "$current_count"
            all_healthy=false

            # Check if failover threshold reached
            if [ "$current_count" -ge "$FAILOVER_THRESHOLD" ]; then
                log_warn "Service $service has reached failover threshold ($current_count/$FAILOVER_THRESHOLD)"
                trigger_failover "$service"
            fi
        fi
    done

    echo ""

    if $all_healthy; then
        return 0
    else
        return 1
    fi
}

# Trigger failover for a service
trigger_failover() {
    local service=$1

    # Validate service parameter
    if [ -z "$service" ]; then
        log_error "trigger_failover called with empty service name"
        return 1
    fi

    local standby="${STANDBY_SERVICES[$service]:-}"
    local failure_count
    failure_count=$(get_failure_count "$service")

    log_warn "Triggering failover for $service"

    # Record failover event with safe JSON escaping
    local failover_event
    failover_event=$(cat <<EOF
{
    "type": "failover_triggered",
    "service": "$service",
    "standby": "${standby:-null}",
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "consecutive_failures": $failure_count
}
EOF
)

    log_info "Failover event: $failover_event"

    # Send alert if webhook configured
    if [ -n "$ALERT_WEBHOOK" ]; then
        send_alert "$failover_event"
    fi

    # Activate standby if available and configured
    if [ -n "$standby" ]; then
        log_info "Activating standby service: $standby"
        activate_standby "$standby"
    else
        log_warn "No standby configured for $service - entering degraded mode"
        # Log to system log for visibility
        logger -t "arbitrage-failover" "No standby for $service, degraded mode"
    fi

    # Reset failure counter
    reset_failure_count "$service"
}

# Activate a standby service
activate_standby() {
    local standby=$1

    case $standby in
        coordinator-standby)
            log_info "Coordinator standby activation requested"
            # Standby coordinator activates automatically via leader election
            # This is handled by CrossRegionHealthManager
            log_info "Standby will acquire leadership via Redis distributed lock"
            ;;
        *)
            log_warn "Unknown standby service: $standby"
            ;;
    esac
}

# Send alert notification
send_alert() {
    local payload=$1

    if [ -z "$ALERT_WEBHOOK" ]; then
        return
    fi

    log_info "Sending alert to webhook..."

    curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$ALERT_WEBHOOK" || log_error "Failed to send alert"
}

# Continuous monitoring
monitor() {
    # Acquire lock to prevent multiple monitor instances
    acquire_monitor_lock

    log_info "Starting continuous health monitoring"
    log_info "Check interval: ${HEALTH_CHECK_INTERVAL}s"
    log_info "Failover threshold: ${FAILOVER_THRESHOLD} consecutive failures"
    log_info "PID: $$"

    init_failure_counts

    while true; do
        check_all_health || true  # Don't exit on check failure
        sleep "$HEALTH_CHECK_INTERVAL"
    done
}

# Show current status
show_status() {
    log_info "Current service status:"
    init_failure_counts
    check_all_health
}

# Manual failover trigger
manual_trigger() {
    local service=$1

    if [ -z "$service" ]; then
        log_error "Service name required"
        echo "Usage: $0 trigger <service>"
        exit 1
    fi

    if [ -z "${SERVICE_ENDPOINTS[$service]:-}" ]; then
        log_error "Unknown service: $service"
        echo "Available services: ${!SERVICE_ENDPOINTS[*]}"
        exit 1
    fi

    # Initialize and set failure count to threshold
    init_failure_counts
    FAILURE_COUNTS[$service]=$FAILOVER_THRESHOLD

    log_warn "Manual failover triggered for $service"
    trigger_failover "$service"
}

# Usage
usage() {
    echo "Failover Automation Script"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  monitor        Start continuous health monitoring"
    echo "  check          Perform one-time health check"
    echo "  trigger <svc>  Manually trigger failover for a service"
    echo "  status         Show current service status"
    echo ""
    echo "Environment Variables:"
    echo "  HEALTH_CHECK_INTERVAL  Check interval in seconds (default: 15)"
    echo "  FAILOVER_THRESHOLD     Failures before failover (default: 3)"
    echo "  ALERT_WEBHOOK          Webhook URL for alerts"
    echo "  DEBUG                  Enable debug logging (true/false)"
    echo ""
    echo "Service URL Environment Variables:"
    echo "  COORDINATOR_PRIMARY_URL"
    echo "  COORDINATOR_STANDBY_URL"
    echo "  PARTITION_ASIA_FAST_URL"
    echo "  PARTITION_L2_FAST_URL"
    echo "  PARTITION_HIGH_VALUE_URL"
    echo "  PARTITION_SOLANA_URL"
    echo "  CROSS_CHAIN_URL"
    echo "  EXECUTION_URL"
}

# Main
main() {
    case "${1:-}" in
        monitor)
            monitor
            ;;
        check)
            init_failure_counts
            check_all_health
            ;;
        trigger)
            init_failure_counts
            manual_trigger "$2"
            ;;
        status)
            show_status
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown command: ${1:-}"
            usage
            exit 1
            ;;
    esac
}

main "$@"
