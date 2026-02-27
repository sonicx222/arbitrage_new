#!/bin/bash
# Health Check Script
#
# Comprehensive health check for all arbitrage services
# Can be used for monitoring, CI/CD validation, or manual checks
#
# Usage:
#   ./health-check.sh              # Check all services
#   ./health-check.sh --json       # Output as JSON
#   ./health-check.sh --quiet      # Only exit code
#   ./health-check.sh --parallel   # Check services in parallel
#   ./health-check.sh <service>    # Check specific service
#
# @see ADR-007: Cross-Region Failover Strategy
# @see ADR-003: Partitioned Chain Detectors
# @see ADR-010: WebSocket Connection Resilience

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared health utilities if available (DRY principle)
if [ -f "$SCRIPT_DIR/lib/health-utils.sh" ]; then
    # shellcheck source=./lib/health-utils.sh
    source "$SCRIPT_DIR/lib/health-utils.sh"
    UTILS_SOURCED=true
else
    UTILS_SOURCED=false
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
# Standard health check interval: 15s (consistent across all services per ADR-007)
TIMEOUT=${TIMEOUT:-${HEALTH_TIMEOUT:-5}}
RETRIES=${RETRIES:-${HEALTH_RETRIES:-3}}
RETRY_DELAY=${RETRY_DELAY:-${HEALTH_RETRY_DELAY:-2}}

# Parallel execution mode
PARALLEL_MODE=false

# Lock file for preventing concurrent execution
LOCK_FILE="/tmp/arbitrage-health-check.lock"
LOCK_FD=200

# Check if a process exists (cross-platform fallback if not in utils)
# Args: $1 = pid
# Returns: 0 if exists, 1 if not
process_exists_local() {
    local pid="$1"
    # Use ps -p which works on Linux, macOS, BSD
    ps -p "$pid" > /dev/null 2>&1
}

# Acquire lock to prevent concurrent execution race conditions
# Uses improved locking with stale lock detection
acquire_lock() {
    # Use shared utility if available
    if [ "$UTILS_SOURCED" = true ] && type acquire_lock_safe &>/dev/null; then
        if ! acquire_lock_safe "$LOCK_FILE" "$LOCK_FD"; then
            echo "Another health check is already running" >&2
            exit 1
        fi
        trap release_lock EXIT
        return 0
    fi

    # Fallback implementation with stale lock detection
    mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
    exec 200>"$LOCK_FILE"

    if ! flock -n 200; then
        # Check if the process holding the lock is still alive
        local lock_pid
        lock_pid=$(cat "$LOCK_FILE" 2>/dev/null)

        # FIX P2-1: Use ps command instead of /proc for cross-platform support
        # Previously: [ -d "/proc/$lock_pid" ] only works on Linux
        # Now: ps -p works on Linux, macOS, BSD
        if [ -n "$lock_pid" ] && process_exists_local "$lock_pid"; then
            # Process is still running
            echo "Another health check is already running (PID: $lock_pid)" >&2
            exit 1
        else
            # Stale lock (process dead) - try to remove and reacquire
            rm -f "$LOCK_FILE" 2>/dev/null
            exec 200>"$LOCK_FILE"
            if ! flock -n 200; then
                echo "Another health check is already running" >&2
                exit 1
            fi
        fi
    fi

    # Write PID to lock file for stale detection
    echo "$$" > "$LOCK_FILE"
    trap release_lock EXIT
}

# Release lock safely
release_lock() {
    # Use shared utility if available
    if [ "$UTILS_SOURCED" = true ] && type release_lock_safe &>/dev/null; then
        release_lock_safe "$LOCK_FILE" "$LOCK_FD"
        return 0
    fi

    # Fallback implementation
    flock -u 200 2>/dev/null || true
    rm -f "$LOCK_FILE" 2>/dev/null || true
}

# Service definitions
# Port mappings (Docker partition compose external ports, base port + 10 offset):
#   - Coordinator:           3000  (no offset, same as base)
#   - partition-asia-fast:   3011  (base 3001 + 10)
#   - partition-l2-turbo:     3012  (base 3002 + 10)
#   - partition-high-value:  3013  (base 3003 + 10)
#   - partition-solana:      3014  (base 3004 + 10)
#   - execution-engine:      3015  (base 3005 + 10; Fly.io uses 8080 override)
#   - cross-chain-detector:  3016  (base 3006 + 10)
#   - Redis:                 6379  (configurable via REDIS_PORT)
#
# NOTE: Fly.io TOMLs use different internal ports (e.g., execution-engine=8080).
# These mappings are for Docker partition compose deployments only.
REDIS_PORT=${REDIS_PORT:-6379}

declare -A SERVICES=(
    ["coordinator"]="http://localhost:3000/health"
    ["partition-asia-fast"]="http://localhost:3011/health"
    ["partition-l2-turbo"]="http://localhost:3012/health"
    ["partition-high-value"]="http://localhost:3013/health"
    ["partition-solana"]="http://localhost:3014/health"
    ["cross-chain-detector"]="http://localhost:3016/health"
    ["execution-engine"]="http://localhost:3015/health"
    ["redis"]="redis://localhost:$REDIS_PORT"
)

# Override with environment variables
[ -n "$COORDINATOR_URL" ] && SERVICES["coordinator"]="$COORDINATOR_URL/health"
[ -n "$PARTITION_ASIA_FAST_URL" ] && SERVICES["partition-asia-fast"]="$PARTITION_ASIA_FAST_URL/health"
[ -n "$PARTITION_L2_TURBO_URL" ] && SERVICES["partition-l2-turbo"]="$PARTITION_L2_TURBO_URL/health"
[ -n "$PARTITION_HIGH_VALUE_URL" ] && SERVICES["partition-high-value"]="$PARTITION_HIGH_VALUE_URL/health"
[ -n "$PARTITION_SOLANA_URL" ] && SERVICES["partition-solana"]="$PARTITION_SOLANA_URL/health"
[ -n "$CROSS_CHAIN_URL" ] && SERVICES["cross-chain-detector"]="$CROSS_CHAIN_URL/health"
[ -n "$EXECUTION_URL" ] && SERVICES["execution-engine"]="$EXECUTION_URL/health"
[ -n "$REDIS_URL" ] && SERVICES["redis"]="$REDIS_URL"

# Output mode
OUTPUT_MODE="text"
QUIET=false

# Results storage
declare -A RESULTS
declare -A RESPONSE_TIMES
OVERALL_STATUS="healthy"

# Get timestamp in milliseconds (portable across Linux/macOS)
get_timestamp_ms() {
    # Try nanoseconds first (Linux), fall back to seconds*1000 (macOS)
    local ns
    ns=$(date +%s%N 2>/dev/null)
    if [ $? -eq 0 ] && [ ${#ns} -gt 10 ]; then
        echo $(( ns / 1000000 ))
    else
        echo $(( $(date +%s) * 1000 ))
    fi
}

# Check HTTP service health
check_http_health() {
    local service=$1
    local url=$2
    local attempt=1

    while [ $attempt -le $RETRIES ]; do
        local start_time=$(get_timestamp_ms)

        local response
        response=$(curl -s -w "\n%{http_code}" --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" "$url" 2>/dev/null)

        local end_time=$(get_timestamp_ms)
        local duration=$(( end_time - start_time ))

        local http_code=$(echo "$response" | tail -1)
        local body=$(echo "$response" | sed '$d')

        if [ "$http_code" = "200" ]; then
            RESULTS[$service]="healthy"
            RESPONSE_TIMES[$service]=$duration
            return 0
        fi

        attempt=$((attempt + 1))
        [ $attempt -le $RETRIES ] && sleep "$RETRY_DELAY"
    done

    RESULTS[$service]="unhealthy"
    RESPONSE_TIMES[$service]=0
    OVERALL_STATUS="unhealthy"
    return 1
}

# Check Redis health
check_redis_health() {
    local service=$1
    local url=$2

    # Extract host and port from URL (handles auth: redis://user:pass@host:port)
    local stripped=$(echo "$url" | sed -E 's|^redis[s]?://||')
    # Strip credentials if present (everything before @)
    if echo "$stripped" | grep -q '@'; then
        stripped=$(echo "$stripped" | sed 's|.*@||')
    fi
    local host=$(echo "$stripped" | cut -d: -f1 | cut -d/ -f1)
    local port=$(echo "$stripped" | cut -d: -f2 | cut -d/ -f1)
    # If port is same as host, no port was specified
    [ "$port" = "$host" ] && port=6379
    [ -z "$port" ] && port=6379

    local start_time=$(get_timestamp_ms)

    if command -v redis-cli &> /dev/null; then
        if redis-cli -h "$host" -p "$port" ping 2>/dev/null | grep -q "PONG"; then
            local end_time=$(get_timestamp_ms)
            local duration=$(( end_time - start_time ))
            RESULTS[$service]="healthy"
            RESPONSE_TIMES[$service]=$duration
            return 0
        fi
    else
        # Fallback: try TCP connection with portable nc or bash /dev/tcp
        local tcp_success=false
        if command -v nc &> /dev/null; then
            # Use netcat if available (more portable)
            if nc -z -w "$TIMEOUT" "$host" "$port" 2>/dev/null; then
                tcp_success=true
            fi
        else
            # Fallback to bash built-in /dev/tcp (bash-specific pseudo-device)
            # NOTE: /dev/tcp doesn't exist as a filesystem entry, it's a bash built-in
            # We check if bash supports it by checking BASH_VERSION
            if [ -n "$BASH_VERSION" ]; then
                # Use exec with file descriptor to test TCP connection
                if timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$host/$port && exec 3>&-" 2>/dev/null; then
                    tcp_success=true
                fi
            fi
        fi

        if [ "$tcp_success" = true ]; then
            local end_time=$(get_timestamp_ms)
            local duration=$(( end_time - start_time ))
            RESULTS[$service]="healthy"
            RESPONSE_TIMES[$service]=$duration
            return 0
        fi
    fi

    RESULTS[$service]="unhealthy"
    RESPONSE_TIMES[$service]=0
    OVERALL_STATUS="unhealthy"
    return 1
}

# Check a single service
check_service() {
    local service=$1
    local url=${SERVICES[$service]}

    if [ -z "$url" ]; then
        RESULTS[$service]="not_configured"
        return 2
    fi

    if [[ "$url" == redis://* ]]; then
        check_redis_health "$service" "$url"
    else
        check_http_health "$service" "$url"
    fi
}

# Check all services (serial mode)
check_all_serial() {
    for service in "${!SERVICES[@]}"; do
        check_service "$service" || true
    done
}

# Check all services (parallel mode - faster but more resource intensive)
check_all_parallel() {
    local pids=()
    local services=()
    local temp_dir=$(mktemp -d)

    # Launch checks in parallel
    for service in "${!SERVICES[@]}"; do
        (
            check_service "$service"
            echo "${RESULTS[$service]:-unhealthy}|${RESPONSE_TIMES[$service]:-0}" > "$temp_dir/$service"
        ) &
        pids+=($!)
        services+=("$service")
    done

    # Wait for all checks to complete
    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done

    # Collect results from temp files
    for service in "${services[@]}"; do
        if [ -f "$temp_dir/$service" ]; then
            local result
            result=$(cat "$temp_dir/$service")
            RESULTS[$service]="${result%|*}"
            RESPONSE_TIMES[$service]="${result#*|}"
            [ "${RESULTS[$service]}" = "unhealthy" ] && OVERALL_STATUS="unhealthy"
        else
            RESULTS[$service]="unhealthy"
            RESPONSE_TIMES[$service]=0
            OVERALL_STATUS="unhealthy"
        fi
    done

    # Cleanup
    rm -rf "$temp_dir"
}

# Check all services
check_all() {
    if [ "$PARALLEL_MODE" = true ]; then
        check_all_parallel
    else
        check_all_serial
    fi
}

# Output results as text
output_text() {
    echo ""
    echo "=== Arbitrage System Health Check ==="
    echo ""
    printf "%-25s %-12s %-15s\n" "SERVICE" "STATUS" "RESPONSE TIME"
    printf "%-25s %-12s %-15s\n" "-------" "------" "-------------"

    for service in "${!RESULTS[@]}"; do
        local status=${RESULTS[$service]}
        local response_time=${RESPONSE_TIMES[$service]:-0}

        local status_color=$NC
        [ "$status" = "healthy" ] && status_color=$GREEN
        [ "$status" = "unhealthy" ] && status_color=$RED
        [ "$status" = "not_configured" ] && status_color=$YELLOW

        if [ "$response_time" -gt 0 ]; then
            printf "%-25s ${status_color}%-12s${NC} %sms\n" "$service" "$status" "$response_time"
        else
            printf "%-25s ${status_color}%-12s${NC} -\n" "$service" "$status"
        fi
    done

    echo ""

    if [ "$OVERALL_STATUS" = "healthy" ]; then
        echo -e "Overall Status: ${GREEN}HEALTHY${NC}"
    else
        echo -e "Overall Status: ${RED}UNHEALTHY${NC}"
    fi
    echo ""
}

# Output results as JSON
output_json() {
    local services_json=""
    local first=true

    for service in "${!RESULTS[@]}"; do
        [ "$first" = true ] && first=false || services_json+=","
        services_json+="\"$service\":{\"status\":\"${RESULTS[$service]}\",\"response_time_ms\":${RESPONSE_TIMES[$service]:-0}}"
    done

    cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "overall_status": "$OVERALL_STATUS",
  "services": {$services_json}
}
EOF
}

# Output results
output_results() {
    if [ "$QUIET" = true ]; then
        return
    fi

    case "$OUTPUT_MODE" in
        json)
            output_json
            ;;
        text|*)
            output_text
            ;;
    esac
}

# Usage
usage() {
    echo "Health Check Script for Arbitrage System"
    echo ""
    echo "Usage: $0 [options] [service]"
    echo ""
    echo "Options:"
    echo "  --json           Output results as JSON"
    echo "  --quiet, -q      Quiet mode (exit code only)"
    echo "  --parallel, -p   Check services in parallel (faster)"
    echo "  -h, --help       Show this help"
    echo ""
    echo "Services:"
    for service in "${!SERVICES[@]}"; do
        echo "  $service"
    done
    echo ""
    echo "Environment Variables:"
    echo "  TIMEOUT       Connection timeout in seconds (default: 5)"
    echo "  RETRIES       Number of retries (default: 3)"
    echo "  RETRY_DELAY   Delay between retries (default: 2)"
    echo ""
    echo "Examples:"
    echo "  $0                          # Check all services (serial)"
    echo "  $0 --parallel               # Check all services (parallel)"
    echo "  $0 coordinator              # Check coordinator only"
    echo "  $0 --json                   # JSON output"
    echo "  $0 --quiet && echo 'OK'     # Silent check"
}

# Main
main() {
    local target_service=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --json)
                OUTPUT_MODE="json"
                shift
                ;;
            --quiet|-q)
                QUIET=true
                shift
                ;;
            --parallel|-p)
                PARALLEL_MODE=true
                shift
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                echo "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                target_service="$1"
                shift
                ;;
        esac
    done

    # Acquire lock to prevent race conditions with concurrent executions
    acquire_lock

    # Initialize result arrays to ensure clean state
    for service in "${!SERVICES[@]}"; do
        RESULTS[$service]=""
        RESPONSE_TIMES[$service]=0
    done

    # Run checks
    if [ -n "$target_service" ]; then
        if [ -z "${SERVICES[$target_service]:-}" ]; then
            echo "Unknown service: $target_service"
            exit 1
        fi
        check_service "$target_service"
    else
        check_all
    fi

    # Output results
    output_results

    # Exit with status
    if [ "$OVERALL_STATUS" = "healthy" ]; then
        exit 0
    else
        exit 1
    fi
}

main "$@"
