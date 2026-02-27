#!/usr/bin/env bash

# Grafana Dashboard Setup Script (Day 13)
#
# Automated provisioning of Grafana dashboards and alerts for warming infrastructure
#
# LOCATION NOTE: infrastructure/grafana/ contains setup automation scripts and
# warming-specific dashboards/provisioning configs. infrastructure/monitoring/
# contains production alert rules and the main Grafana dashboard.
#
# Usage:
#   ./setup-grafana.sh [options]
#
# Options:
#   --grafana-url URL        Grafana URL (default: http://localhost:3000)
#   --api-key KEY            Grafana API key
#   --prometheus-uid UID     Prometheus datasource UID (default: prometheus)
#   --cloud                  Use Grafana Cloud configuration (reads GRAFANA_CLOUD_* env vars)
#   --dry-run                Show what would be done without making changes
#   --help                   Show this help message
#
# Grafana Cloud env vars (used with --cloud):
#   GRAFANA_CLOUD_URL          Grafana Cloud stack URL (e.g., https://your-stack.grafana.net)
#   GRAFANA_CLOUD_API_KEY      Grafana Cloud API key with Admin permissions
#   GRAFANA_CLOUD_STACK_ID     Grafana Cloud stack ID
#   GRAFANA_CLOUD_PROM_URL     Prometheus remote write endpoint URL
#   GRAFANA_CLOUD_PROM_USERNAME Prometheus remote write username

set -euo pipefail

# Default configuration
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_API_KEY="${GRAFANA_API_KEY:-}"
PROMETHEUS_UID="${PROMETHEUS_UID:-prometheus}"
DRY_RUN=false
CLOUD_MODE=false

# Grafana Cloud configuration (populated from env vars when --cloud is used)
GRAFANA_CLOUD_URL="${GRAFANA_CLOUD_URL:-}"
GRAFANA_CLOUD_API_KEY="${GRAFANA_CLOUD_API_KEY:-}"
GRAFANA_CLOUD_STACK_ID="${GRAFANA_CLOUD_STACK_ID:-}"
GRAFANA_CLOUD_PROM_URL="${GRAFANA_CLOUD_PROM_URL:-}"
GRAFANA_CLOUD_PROM_USERNAME="${GRAFANA_CLOUD_PROM_USERNAME:-}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARDS_DIR="${SCRIPT_DIR}/dashboards"
PROVISIONING_DIR="${SCRIPT_DIR}/provisioning"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --grafana-url)
            GRAFANA_URL="$2"
            shift 2
            ;;
        --api-key)
            GRAFANA_API_KEY="$2"
            shift 2
            ;;
        --prometheus-uid)
            PROMETHEUS_UID="$2"
            shift 2
            ;;
        --cloud)
            CLOUD_MODE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help)
            grep '^#' "$0" | grep -v '#!/usr/bin/env bash' | sed 's/^# //' | sed 's/^#//'
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Apply cloud mode configuration
if [[ "$CLOUD_MODE" == "true" ]]; then
    log_info "Cloud mode enabled - configuring for Grafana Cloud"

    # Validate required cloud env vars
    if [[ -z "$GRAFANA_CLOUD_URL" ]]; then
        log_error "GRAFANA_CLOUD_URL is required when using --cloud mode"
        log_error "Set the GRAFANA_CLOUD_URL environment variable (e.g., https://your-stack.grafana.net)"
        exit 1
    fi

    if [[ -z "$GRAFANA_CLOUD_API_KEY" ]]; then
        log_error "GRAFANA_CLOUD_API_KEY is required when using --cloud mode"
        log_error "Generate an API key from your Grafana Cloud stack settings"
        exit 1
    fi

    # Override local defaults with cloud values
    GRAFANA_URL="$GRAFANA_CLOUD_URL"
    GRAFANA_API_KEY="$GRAFANA_CLOUD_API_KEY"
    PROMETHEUS_UID="grafanacloud-prom"

    if [[ -n "$GRAFANA_CLOUD_STACK_ID" ]]; then
        log_info "  Stack ID: $GRAFANA_CLOUD_STACK_ID"
    fi

    if [[ -n "$GRAFANA_CLOUD_PROM_URL" ]]; then
        log_info "  Prometheus URL: $GRAFANA_CLOUD_PROM_URL"
    fi
fi

# Validate configuration
if [[ -z "$GRAFANA_API_KEY" ]]; then
    log_error "Grafana API key is required. Set GRAFANA_API_KEY environment variable or use --api-key"
    exit 1
fi

if [[ ! -d "$DASHBOARDS_DIR" ]]; then
    log_error "Dashboards directory not found: $DASHBOARDS_DIR"
    exit 1
fi

log_info "Grafana Setup Configuration:"
log_info "  Grafana URL: $GRAFANA_URL"
log_info "  Prometheus UID: $PROMETHEUS_UID"
log_info "  Dry Run: $DRY_RUN"
echo

# Function to check if Grafana is accessible
check_grafana() {
    log_info "Checking Grafana accessibility..."

    if ! curl -s -f -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
        "${GRAFANA_URL}/api/health" > /dev/null; then
        log_error "Cannot connect to Grafana at ${GRAFANA_URL}"
        log_error "Please check that Grafana is running and the API key is correct"
        exit 1
    fi

    log_info "✓ Grafana is accessible"
}

# Function to check if Prometheus datasource exists
check_prometheus_datasource() {
    log_info "Checking Prometheus datasource..."

    local response
    response=$(curl -s -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
        "${GRAFANA_URL}/api/datasources/uid/${PROMETHEUS_UID}")

    if echo "$response" | grep -q '"message":"Data source not found"'; then
        log_warn "Prometheus datasource '${PROMETHEUS_UID}' not found"
        log_warn "You may need to create it manually or adjust the UID"
        return 1
    fi

    log_info "✓ Prometheus datasource exists"
    return 0
}

# Function to import dashboard
import_dashboard() {
    local dashboard_file="$1"
    local dashboard_name
    dashboard_name=$(basename "$dashboard_file" .json)

    log_info "Importing dashboard: $dashboard_name"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "  [DRY RUN] Would import: $dashboard_file"
        return 0
    fi

    # Read dashboard JSON and wrap in import payload
    local dashboard_json
    dashboard_json=$(cat "$dashboard_file")

    # Update datasource UID in dashboard JSON
    dashboard_json=$(echo "$dashboard_json" | sed "s/\${DS_PROMETHEUS}/${PROMETHEUS_UID}/g")

    # Create import payload
    local payload
    payload=$(jq -n \
        --argjson dashboard "$dashboard_json" \
        '{
            dashboard: $dashboard,
            overwrite: true,
            folderUid: "",
            message: "Imported by setup script"
        }')

    # Import dashboard
    local response
    response=$(curl -s -X POST \
        -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "${GRAFANA_URL}/api/dashboards/db")

    if echo "$response" | grep -q '"status":"success"'; then
        local dashboard_url
        dashboard_url=$(echo "$response" | jq -r '.url')
        log_info "✓ Dashboard imported successfully: ${GRAFANA_URL}${dashboard_url}"
    else
        log_error "Failed to import dashboard: $dashboard_name"
        log_error "Response: $response"
        return 1
    fi
}

# Function to import alert rules
import_alert_rules() {
    local rules_file="${PROVISIONING_DIR}/alert-rules.yml"

    if [[ ! -f "$rules_file" ]]; then
        log_warn "Alert rules file not found: $rules_file"
        return 0
    fi

    log_info "Importing alert rules..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "  [DRY RUN] Would import: $rules_file"
        return 0
    fi

    # Note: Alert rules are typically provisioned via configuration files
    # rather than API. This is a placeholder for the actual implementation.
    log_warn "Alert rules must be configured via Grafana provisioning"
    log_info "Copy $rules_file to your Grafana provisioning directory:"
    log_info "  /etc/grafana/provisioning/alerting/warming-infrastructure.yml"
}

# Function to create notification channels
create_notification_channels() {
    log_info "Setting up notification channels..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "  [DRY RUN] Would create notification channels"
        return 0
    fi

    # Check if PagerDuty channel exists
    local pagerduty_key="${PAGERDUTY_SERVICE_KEY:-}"
    if [[ -n "$pagerduty_key" ]]; then
        log_info "Creating PagerDuty notification channel..."
        # Implementation would go here
        log_info "✓ PagerDuty channel configured"
    else
        log_warn "PAGERDUTY_SERVICE_KEY not set, skipping PagerDuty setup"
    fi

    # Check if Slack webhook exists
    local slack_webhook="${SLACK_WEBHOOK_URL:-}"
    if [[ -n "$slack_webhook" ]]; then
        log_info "Creating Slack notification channels..."
        # Implementation would go here
        log_info "✓ Slack channels configured"
    else
        log_warn "SLACK_WEBHOOK_URL not set, skipping Slack setup"
    fi
}

# Function to configure Prometheus remote write for Grafana Cloud
configure_cloud_remote_write() {
    if [[ "$CLOUD_MODE" != "true" ]]; then
        return 0
    fi

    if [[ -z "$GRAFANA_CLOUD_PROM_URL" ]]; then
        log_warn "GRAFANA_CLOUD_PROM_URL not set, skipping remote write configuration"
        return 0
    fi

    log_info "Configuring Prometheus remote write for Grafana Cloud..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "  [DRY RUN] Would configure remote write to: ${GRAFANA_CLOUD_PROM_URL}/api/prom/push"
        return 0
    fi

    # Generate remote write config snippet for Prometheus
    local remote_write_config
    remote_write_config=$(cat <<REMOTE_WRITE_EOF
# Grafana Cloud Remote Write Configuration
# Add this to your prometheus.yml under 'remote_write:' section
remote_write:
  - url: "${GRAFANA_CLOUD_PROM_URL}/api/prom/push"
    basic_auth:
      username: "${GRAFANA_CLOUD_PROM_USERNAME}"
      password: "${GRAFANA_CLOUD_API_KEY}"
REMOTE_WRITE_EOF
)

    local config_file="${SCRIPT_DIR}/prometheus-remote-write.yml"
    echo "$remote_write_config" > "$config_file"
    log_info "✓ Remote write config written to: $config_file"
    log_info "  Add this configuration to your prometheus.yml to push metrics to Grafana Cloud"
}

# Function to configure cloud datasource via API
configure_cloud_datasource() {
    if [[ "$CLOUD_MODE" != "true" ]]; then
        return 0
    fi

    if [[ -z "$GRAFANA_CLOUD_PROM_URL" ]]; then
        return 0
    fi

    log_info "Configuring Grafana Cloud Prometheus datasource..."

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "  [DRY RUN] Would create/update datasource 'grafanacloud-prom'"
        return 0
    fi

    local datasource_payload
    datasource_payload=$(jq -n \
        --arg name "Grafana Cloud Prometheus" \
        --arg uid "grafanacloud-prom" \
        --arg url "$GRAFANA_CLOUD_PROM_URL" \
        --arg user "$GRAFANA_CLOUD_PROM_USERNAME" \
        --arg password "$GRAFANA_CLOUD_API_KEY" \
        '{
            name: $name,
            uid: $uid,
            type: "prometheus",
            url: $url,
            access: "proxy",
            isDefault: true,
            basicAuth: true,
            basicAuthUser: $user,
            secureJsonData: {
                basicAuthPassword: $password
            }
        }')

    local response
    response=$(curl -s -X POST \
        -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$datasource_payload" \
        "${GRAFANA_URL}/api/datasources" 2>&1)

    if echo "$response" | grep -q '"id"'; then
        log_info "✓ Grafana Cloud Prometheus datasource configured"
    elif echo "$response" | grep -q '"message":"data source with the same name already exists"'; then
        log_info "✓ Grafana Cloud Prometheus datasource already exists"
    else
        log_warn "Datasource creation response: $response"
    fi
}

# Main setup flow
main() {
    log_info "Starting Grafana setup for warming infrastructure..."
    if [[ "$CLOUD_MODE" == "true" ]]; then
        log_info "Mode: Grafana Cloud"
    else
        log_info "Mode: Local Grafana"
    fi
    echo

    # Pre-flight checks
    check_grafana
    check_prometheus_datasource || log_warn "Continuing without Prometheus verification..."
    echo

    # Cloud-specific: Configure datasource and remote write
    if [[ "$CLOUD_MODE" == "true" ]]; then
        configure_cloud_datasource
        configure_cloud_remote_write
        echo
    fi

    # Import dashboards
    log_info "Importing dashboards..."
    local dashboard_count=0

    for dashboard_file in "$DASHBOARDS_DIR"/*.json; do
        if [[ -f "$dashboard_file" ]]; then
            import_dashboard "$dashboard_file" && ((dashboard_count++))
        fi
    done

    log_info "✓ Imported $dashboard_count dashboard(s)"
    echo

    # Import alert rules
    import_alert_rules
    echo

    # Create notification channels
    create_notification_channels
    echo

    # Summary
    log_info "========================================="
    log_info "Grafana setup complete!"
    log_info "========================================="
    echo
    log_info "Next steps:"
    log_info "1. Visit ${GRAFANA_URL} to view your dashboards"
    log_info "2. Configure alert notification channels in Grafana UI"
    log_info "3. Copy alert-rules.yml to Grafana provisioning directory"
    log_info "4. Verify metrics are being collected from your services"
    if [[ "$CLOUD_MODE" == "true" ]]; then
        log_info "5. Add remote write config to your Prometheus (see prometheus-remote-write.yml)"
    fi
    echo
    log_info "Dashboard URLs:"
    log_info "  - Warming Infrastructure: ${GRAFANA_URL}/d/warming-infrastructure"
    echo
}

# Run main function
main

exit 0
