#!/bin/bash
# GCP Deployment Script for Coordinator Standby
#
# Deploys the coordinator standby instance to Google Cloud Run
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Docker installed for building images
#   - GCP project with Cloud Run API enabled
#
# @see ADR-006: Free Hosting Provider Selection
# @see ADR-007: Cross-Region Failover Strategy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Configuration
GCP_PROJECT="${GCP_PROJECT:-}"
GCP_REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="arbitrage-coordinator-standby"
IMAGE_NAME="gcr.io/${GCP_PROJECT}/arbitrage-coordinator"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v gcloud &> /dev/null; then
        log_error "gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install"
        exit 1
    fi

    if [ -z "$GCP_PROJECT" ]; then
        GCP_PROJECT=$(gcloud config get-value project 2>/dev/null)
        if [ -z "$GCP_PROJECT" ]; then
            log_error "GCP_PROJECT not set and no default project configured"
            exit 1
        fi
        log_info "Using GCP project: $GCP_PROJECT"
    fi

    # Check if Cloud Run API is enabled
    if ! gcloud services list --enabled --filter="name:run.googleapis.com" --format="value(name)" | grep -q "run.googleapis.com"; then
        log_info "Enabling Cloud Run API..."
        gcloud services enable run.googleapis.com
    fi
}

build_image() {
    log_info "Building Docker image..."
    cd "$PROJECT_ROOT"

    # Build the coordinator image
    docker build -t "$IMAGE_NAME:latest" -f services/coordinator/Dockerfile .

    log_info "Pushing image to GCR..."
    docker push "$IMAGE_NAME:latest"
}

setup_secrets() {
    log_info "Setting up secrets..."

    # Check if secret exists
    if ! gcloud secrets describe redis-url --project="$GCP_PROJECT" &> /dev/null; then
        log_info "Creating redis-url secret..."
        log_warn "Secret will be hidden from terminal output for security"
        echo -n "Enter Redis URL: "
        read -rs REDIS_URL
        echo ""
        echo -n "$REDIS_URL" | gcloud secrets create redis-url --data-file=- --project="$GCP_PROJECT"
    else
        log_info "redis-url secret already exists"
    fi
}

deploy_service() {
    log_info "Deploying coordinator standby to Cloud Run..."

    gcloud run deploy "$SERVICE_NAME" \
        --image "$IMAGE_NAME:latest" \
        --platform managed \
        --region "$GCP_REGION" \
        --allow-unauthenticated \
        --memory 256Mi \
        --cpu 1 \
        --min-instances 1 \
        --max-instances 1 \
        --set-env-vars "NODE_ENV=production,PORT=3000,REGION_ID=$GCP_REGION,LOG_LEVEL=info,ENABLE_CROSS_REGION_HEALTH=true,IS_STANDBY=true,CAN_BECOME_LEADER=true" \
        --set-secrets "REDIS_URL=redis-url:latest" \
        --project="$GCP_PROJECT"

    # Get service URL
    SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
        --platform managed \
        --region "$GCP_REGION" \
        --format="value(status.url)" \
        --project="$GCP_PROJECT")

    log_info "Service deployed: $SERVICE_URL"
    log_info "Health check: $SERVICE_URL/health"
}

show_status() {
    log_info "Service Status:"
    gcloud run services describe "$SERVICE_NAME" \
        --platform managed \
        --region "$GCP_REGION" \
        --project="$GCP_PROJECT" \
        --format="table(status.conditions.type,status.conditions.status,status.conditions.message)"
}

cleanup() {
    log_warn "Deleting service..."
    gcloud run services delete "$SERVICE_NAME" \
        --platform managed \
        --region "$GCP_REGION" \
        --project="$GCP_PROJECT" \
        --quiet
    log_info "Service deleted"
}

usage() {
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  deploy       Build and deploy the coordinator standby"
    echo "  build        Build and push Docker image only"
    echo "  status       Show service status"
    echo "  cleanup      Delete the service"
    echo "  secrets      Set up secrets"
    echo ""
    echo "Environment Variables:"
    echo "  GCP_PROJECT  GCP project ID (default: gcloud config)"
    echo "  GCP_REGION   GCP region (default: us-central1)"
}

main() {
    case "${1:-deploy}" in
        deploy)
            check_prerequisites
            setup_secrets
            build_image
            deploy_service
            show_status
            ;;
        build)
            check_prerequisites
            build_image
            ;;
        status)
            check_prerequisites
            show_status
            ;;
        cleanup)
            check_prerequisites
            cleanup
            ;;
        secrets)
            check_prerequisites
            setup_secrets
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown command: $1"
            usage
            exit 1
            ;;
    esac
}

main "$@"
