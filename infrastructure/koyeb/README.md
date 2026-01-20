# Koyeb Deployment (Placeholder)

This directory is reserved for future Koyeb deployment configurations.

## Status: Not Implemented

Per ADR-006 (Free Hosting Provider Selection), Koyeb was considered as a potential
free-tier hosting provider but was not selected for the initial deployment.

## If Implemented

This directory would contain:
- `koyeb.yaml` - Koyeb service definition
- `deploy.sh` - Deployment automation script

## Current Deployment Strategy

See the following directories for active deployments:
- `../fly/` - Fly.io (L2-Fast partition, Coordinator standby)
- `../oracle/` - Oracle Cloud (Asia-Fast, High-Value partitions)
- `../gcp/` - GCP Cloud Run (Coordinator standby backup)

@see ADR-006: Free Hosting Provider Selection
