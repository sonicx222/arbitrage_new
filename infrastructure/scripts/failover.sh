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
CONFIG_FILE="${SCRIPT_DIR}/failover-config.json"

# Default configuration
HEALTH_CHECK_INTERVAL=${HEALTH_CHECK_INTERVAL:-10}
FAILOVER_THRESHOLD=${FAILOVER_THRESHOLD:-3}
ALERT_WEBHOOK=${ALERT_WEBHOOK:-}

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
declare -A SERVICE_ENDPOINTS=(
    ["coordinator-primary"]="${COORDINATOR_PRIMARY_URL:-http://localhost:3000}/health"
    ["coordinator-standby"]="${COORDINATOR_STANDBY_URL:-}/health"
    ["partition-asia-fast"]="${PARTITION_ASIA_FAST_URL:-http://localhost:3011}/health"
    ["partition-l2-fast"]="${PARTITION_L2_FAST_URL:-http://localhost:3012}/health"
    ["partition-high-value"]="${PARTITION_HIGH_VALUE_URL:-http://localhost:3013}/health"
    ["cross-chain-detector"]="${CROSS_CHAIN_URL:-http://localhost:3014}/health"
    ["execution-engine"]="${EXECUTION_URL:-http://localhost:3015}/health"
)

# Standby service mappings
declare -A STANDBY_SERVICES=(
    ["coordinator-primary"]="coordinator-standby"
    ["partition-asia-fast"]=""
    ["partition-l2-fast"]=""
    ["partition-high-value"]=""
)

# Failure counters
declare -A FAILURE_COUNTS

# Initialize failure counts
init_failure_counts() {
    for service in "${!SERVICE_ENDPOINTS[@]}"; do
        FAILURE_COUNTS[$service]=0
    done
}

# Check health of a single service
check_service_health() {
    local service=$1
    local endpoint=${SERVICE_ENDPOINTS[$service]}

    if [ -z "$endpoint" ] || [ "$endpoint" = "/health" ]; then
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

    echo ""
    printf "%-25s %-10s %-15s\n" "SERVICE" "STATUS" "FAILURES"
    printf "%-25s %-10s %-15s\n" "-------" "------" "--------"

    for service in "${!SERVICE_ENDPOINTS[@]}"; do
        local endpoint=${SERVICE_ENDPOINTS[$service]}
        if [ -z "$endpoint" ] || [ "$endpoint" = "/health" ]; then
            printf "%-25s %-10s %-15s\n" "$service" "SKIPPED" "-"
            continue
        fi

        if check_service_health "$service"; then
            FAILURE_COUNTS[$service]=0
            printf "%-25s ${GREEN}%-10s${NC} %-15s\n" "$service" "HEALTHY" "0"
        else
            ((FAILURE_COUNTS[$service]++))
            printf "%-25s ${RED}%-10s${NC} %-15s\n" "$service" "UNHEALTHY" "${FAILURE_COUNTS[$service]}"
            all_healthy=false

            # Check if failover threshold reached
            if [ "${FAILURE_COUNTS[$service]}" -ge "$FAILOVER_THRESHOLD" ]; then
                log_warn "Service $service has reached failover threshold (${FAILURE_COUNTS[$service]}/$FAILOVER_THRESHOLD)"
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
    local standby=${STANDBY_SERVICES[$service]:-}

    log_warn "Triggering failover for $service"

    # Record failover event
    local failover_event=$(cat <<EOF
{
    "type": "failover_triggered",
    "service": "$service",
    "standby": "$standby",
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "consecutive_failures": ${FAILURE_COUNTS[$service]}
}
EOF
)

    log_info "Failover event: $failover_event"

    # Send alert if webhook configured
    if [ -n "$ALERT_WEBHOOK" ]; then
        send_alert "$failover_event"
    fi

    # Activate standby if available
    if [ -n "$standby" ]; then
        log_info "Activating standby service: $standby"
        activate_standby "$standby"
    else
        log_warn "No standby configured for $service - entering degraded mode"
    fi

    # Reset failure counter
    FAILURE_COUNTS[$service]=0
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
    log_info "Starting continuous health monitoring"
    log_info "Check interval: ${HEALTH_CHECK_INTERVAL}s"
    log_info "Failover threshold: ${FAILOVER_THRESHOLD} consecutive failures"

    init_failure_counts

    while true; do
        check_all_health
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

    if [ -z "${SERVICE_ENDPOINTS[$service]}" ]; then
        log_error "Unknown service: $service"
        echo "Available services: ${!SERVICE_ENDPOINTS[*]}"
        exit 1
    fi

    log_warn "Manual failover triggered for $service"
    FAILURE_COUNTS[$service]=$FAILOVER_THRESHOLD
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
    echo "  HEALTH_CHECK_INTERVAL  Check interval in seconds (default: 10)"
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
