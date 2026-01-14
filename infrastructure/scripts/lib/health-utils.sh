#!/bin/bash
# Shared Health Check Utilities Library
#
# Common functions for health checking services across the arbitrage system.
# Used by both health-check.sh and failover.sh for consistency.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/health-utils.sh"
#
# @see ADR-007: Cross-Region Failover Strategy

# =============================================================================
# Configuration
# =============================================================================

# Default timeouts (can be overridden by sourcing script)
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-5}
HEALTH_RETRIES=${HEALTH_RETRIES:-3}
HEALTH_RETRY_DELAY=${HEALTH_RETRY_DELAY:-2}

# =============================================================================
# Timestamp Utilities
# =============================================================================

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

# =============================================================================
# URL Utilities
# =============================================================================

# Build health endpoint URL safely
# Args: $1 = base_url
# Returns: full health URL or empty string if no URL provided
build_health_url() {
    local base_url="$1"
    if [ -n "$base_url" ]; then
        # Remove trailing slash if present, then add /health
        base_url="${base_url%/}"
        echo "${base_url}/health"
    else
        echo ""
    fi
}

# Extract host from URL
# Args: $1 = url (e.g., redis://localhost:6379 or http://example.com:8080)
extract_url_host() {
    local url="$1"
    echo "$url" | sed -E 's|^[a-z]+://||' | cut -d: -f1 | cut -d/ -f1
}

# Extract port from URL
# Args: $1 = url, $2 = default_port
extract_url_port() {
    local url="$1"
    local default_port="${2:-80}"
    local port
    port=$(echo "$url" | sed -E 's|^[a-z]+://||' | grep -oE ':[0-9]+' | tr -d ':')
    echo "${port:-$default_port}"
}

# =============================================================================
# HTTP Health Check
# =============================================================================

# Check HTTP service health with retries
# Args: $1 = url, $2 = timeout (optional), $3 = retries (optional)
# Returns: 0 if healthy, 1 if unhealthy
# Outputs: response_time_ms to stdout on success
http_health_check() {
    local url="$1"
    local timeout="${2:-$HEALTH_TIMEOUT}"
    local retries="${3:-$HEALTH_RETRIES}"
    local attempt=1

    while [ $attempt -le $retries ]; do
        local start_time=$(get_timestamp_ms)

        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" \
            --connect-timeout "$timeout" \
            --max-time "$timeout" \
            "$url" 2>/dev/null)

        local end_time=$(get_timestamp_ms)
        local duration=$(( end_time - start_time ))

        if [ "$http_code" = "200" ]; then
            echo "$duration"
            return 0
        fi

        attempt=$((attempt + 1))
        [ $attempt -le $retries ] && sleep "$HEALTH_RETRY_DELAY"
    done

    echo "0"
    return 1
}

# =============================================================================
# TCP Health Check
# =============================================================================

# Check TCP port connectivity
# Args: $1 = host, $2 = port, $3 = timeout (optional)
# Returns: 0 if reachable, 1 if not
tcp_health_check() {
    local host="$1"
    local port="$2"
    local timeout="${3:-$HEALTH_TIMEOUT}"

    # Try netcat first (most portable)
    if command -v nc &> /dev/null; then
        if nc -z -w "$timeout" "$host" "$port" 2>/dev/null; then
            return 0
        fi
    fi

    # Fallback to bash /dev/tcp (bash-specific pseudo-device)
    # NOTE: /dev/tcp doesn't exist as a filesystem entry, it's a bash built-in
    if [ -n "$BASH_VERSION" ]; then
        if timeout "$timeout" bash -c "exec 3<>/dev/tcp/$host/$port && exec 3>&-" 2>/dev/null; then
            return 0
        fi
    fi

    return 1
}

# =============================================================================
# Redis Health Check
# =============================================================================

# Check Redis health
# Args: $1 = url (redis://host:port format), $2 = timeout (optional)
# Returns: 0 if healthy, 1 if unhealthy
# Outputs: response_time_ms to stdout on success
redis_health_check() {
    local url="$1"
    local timeout="${2:-$HEALTH_TIMEOUT}"

    local host=$(extract_url_host "$url")
    local port=$(extract_url_port "$url" 6379)

    local start_time=$(get_timestamp_ms)

    # Try redis-cli first (best method)
    if command -v redis-cli &> /dev/null; then
        if redis-cli -h "$host" -p "$port" ping 2>/dev/null | grep -q "PONG"; then
            local end_time=$(get_timestamp_ms)
            echo $(( end_time - start_time ))
            return 0
        fi
    else
        # Fallback to TCP check
        if tcp_health_check "$host" "$port" "$timeout"; then
            local end_time=$(get_timestamp_ms)
            echo $(( end_time - start_time ))
            return 0
        fi
    fi

    echo "0"
    return 1
}

# =============================================================================
# Service Health Check (Auto-detect protocol)
# =============================================================================

# Check service health, auto-detecting protocol from URL
# Args: $1 = url, $2 = timeout (optional)
# Returns: 0 if healthy, 1 if unhealthy, 2 if not configured
# Outputs: response_time_ms to stdout
check_service_url() {
    local url="$1"
    local timeout="${2:-$HEALTH_TIMEOUT}"

    # Check if URL is configured
    if [ -z "$url" ]; then
        echo "0"
        return 2
    fi

    # Detect protocol and call appropriate checker
    case "$url" in
        redis://*)
            redis_health_check "$url" "$timeout"
            ;;
        http://*|https://*)
            http_health_check "$url" "$timeout"
            ;;
        *)
            # Unknown protocol, try HTTP
            http_health_check "$url" "$timeout"
            ;;
    esac
}

# =============================================================================
# Locking Utilities
# =============================================================================

# Acquire an exclusive lock with stale lock detection
# Args: $1 = lock_file, $2 = lock_fd (file descriptor number)
# Returns: 0 if lock acquired, 1 if failed
acquire_lock_safe() {
    local lock_file="$1"
    local lock_fd="${2:-200}"

    # Create lock file directory if needed
    mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true

    # Open the lock file
    eval "exec $lock_fd>\"$lock_file\""

    # Try to acquire lock
    if ! flock -n "$lock_fd"; then
        # Check if the process holding the lock is still alive
        local lock_pid
        lock_pid=$(cat "$lock_file" 2>/dev/null)

        if [ -n "$lock_pid" ] && [ -d "/proc/$lock_pid" ]; then
            # Process is still running
            return 1
        else
            # Stale lock, try to remove and reacquire
            rm -f "$lock_file" 2>/dev/null
            eval "exec $lock_fd>\"$lock_file\""
            if ! flock -n "$lock_fd"; then
                return 1
            fi
        fi
    fi

    # Write our PID to the lock file
    echo "$$" > "$lock_file"
    return 0
}

# Release a lock
# Args: $1 = lock_file, $2 = lock_fd (file descriptor number)
release_lock_safe() {
    local lock_file="$1"
    local lock_fd="${2:-200}"

    flock -u "$lock_fd" 2>/dev/null || true
    rm -f "$lock_file" 2>/dev/null || true
}

# =============================================================================
# Validation Utilities
# =============================================================================

# Validate a URL format
# Args: $1 = url
# Returns: 0 if valid, 1 if invalid
validate_url() {
    local url="$1"

    if [[ "$url" =~ ^https?://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(\:[0-9]+)?(/.*)?$ ]]; then
        return 0
    elif [[ "$url" =~ ^redis(s)?://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(\:[0-9]+)?$ ]]; then
        return 0
    fi

    return 1
}

# Validate port number
# Args: $1 = port
# Returns: 0 if valid, 1 if invalid
validate_port() {
    local port="$1"

    if [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then
        return 0
    fi

    return 1
}
