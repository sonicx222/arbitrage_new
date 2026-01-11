# Oracle Cloud Terraform Variables
#
# Variables for deploying arbitrage services on Oracle Cloud Free Tier
#
# @see ADR-006: Free Hosting Provider Selection
# @see ADR-003: Partitioned Chain Detectors

# =============================================================================
# Provider Configuration
# =============================================================================

variable "tenancy_ocid" {
  description = "OCID of the tenancy"
  type        = string
}

variable "user_ocid" {
  description = "OCID of the user"
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the API key"
  type        = string
}

variable "private_key_path" {
  description = "Path to the private key file"
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "compartment_id" {
  description = "OCID of the compartment to create resources in"
  type        = string
}

# =============================================================================
# Region Configuration (ADR-006)
# =============================================================================

variable "region_singapore" {
  description = "Singapore region for Asia-Fast partition"
  type        = string
  default     = "ap-singapore-1"
}

variable "region_us_east" {
  description = "US East region for High-Value partition"
  type        = string
  default     = "us-ashburn-1"
}

variable "primary_region" {
  description = "Primary region for deployment"
  type        = string
  default     = "ap-singapore-1"
}

# =============================================================================
# Compute Configuration
# =============================================================================

variable "availability_domain" {
  description = "Availability domain for compute instances"
  type        = string
  default     = "1"
}

variable "instance_shape_arm" {
  description = "Shape for ARM instances (free tier)"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_shape_amd" {
  description = "Shape for AMD instances (free tier)"
  type        = string
  default     = "VM.Standard.E2.1.Micro"
}

variable "arm_ocpus" {
  description = "Number of OCPUs for ARM instances"
  type        = number
  default     = 2
}

variable "arm_memory_gb" {
  description = "Memory in GB for ARM instances"
  type        = number
  default     = 12
}

# =============================================================================
# Partition Configuration (ADR-003)
# =============================================================================

variable "partition_asia_fast" {
  description = "Asia-Fast partition configuration"
  type = object({
    name          = string
    chains        = list(string)
    memory_mb     = number
    ocpus         = number
    region        = string
    health_port   = number
  })
  default = {
    name          = "asia-fast"
    chains        = ["bsc", "polygon"]
    memory_mb     = 512
    ocpus         = 2
    region        = "ap-singapore-1"
    health_port   = 3011
  }
}

variable "partition_high_value" {
  description = "High-Value partition configuration"
  type = object({
    name          = string
    chains        = list(string)
    memory_mb     = number
    ocpus         = number
    region        = string
    health_port   = number
  })
  default = {
    name          = "high-value"
    chains        = ["ethereum"]
    memory_mb     = 512
    ocpus         = 2
    region        = "us-ashburn-1"
    health_port   = 3013
  }
}

# =============================================================================
# Network Configuration
# =============================================================================

variable "vcn_cidr" {
  description = "CIDR block for VCN"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for public subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "private_subnet_cidr" {
  description = "CIDR block for private subnet"
  type        = string
  default     = "10.0.2.0/24"
}

# =============================================================================
# SSH Configuration
# =============================================================================

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
}

# =============================================================================
# Docker Configuration
# =============================================================================

variable "docker_image_asia_fast" {
  description = "Docker image for Asia-Fast partition"
  type        = string
  default     = "ghcr.io/YOUR_ORG/arbitrage-unified-detector:latest"
}

variable "docker_image_high_value" {
  description = "Docker image for High-Value partition"
  type        = string
  default     = "ghcr.io/YOUR_ORG/arbitrage-unified-detector:latest"
}

variable "docker_image_cross_chain" {
  description = "Docker image for Cross-Chain detector"
  type        = string
  default     = "ghcr.io/YOUR_ORG/arbitrage-cross-chain-detector:latest"
}

# =============================================================================
# Environment Configuration
# =============================================================================

variable "redis_url" {
  description = "Upstash Redis connection URL"
  type        = string
  sensitive   = true
}

variable "log_level" {
  description = "Application log level"
  type        = string
  default     = "info"
}

# Chain-specific RPC URLs
variable "bsc_ws_url" {
  description = "BSC WebSocket URL"
  type        = string
  sensitive   = true
}

variable "bsc_rpc_url" {
  description = "BSC RPC URL"
  type        = string
  sensitive   = true
}

variable "polygon_ws_url" {
  description = "Polygon WebSocket URL"
  type        = string
  sensitive   = true
}

variable "polygon_rpc_url" {
  description = "Polygon RPC URL"
  type        = string
  sensitive   = true
}

variable "ethereum_ws_url" {
  description = "Ethereum WebSocket URL"
  type        = string
  sensitive   = true
}

variable "ethereum_rpc_url" {
  description = "Ethereum RPC URL"
  type        = string
  sensitive   = true
}

# =============================================================================
# Tags
# =============================================================================

variable "tags" {
  description = "Common tags for all resources"
  type        = map(string)
  default = {
    Project     = "arbitrage"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}
