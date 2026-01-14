# Oracle Cloud Infrastructure Terraform Configuration
#
# Deploys arbitrage services on Oracle Cloud Free Tier:
# - Asia-Fast partition (BSC, Polygon) - Singapore
# - High-Value partition (Ethereum) - US-East
# - Cross-Chain Detector - US-East
#
# Free Tier Resources (as of 2025):
# - 4 ARM OCPU, 24GB RAM total
# - 2 AMD VMs (1 OCPU, 1GB each)
# - 200GB block storage
# - 10TB outbound data
#
# @see ADR-003: Partitioned Chain Detectors
# @see ADR-006: Free Hosting Provider Selection
# @see ADR-007: Cross-Region Failover Strategy

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
  }
}

# =============================================================================
# Provider Configuration
# =============================================================================

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.primary_region
}

# Provider alias for US-East region
provider "oci" {
  alias            = "us_east"
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region_us_east
}

# =============================================================================
# Data Sources
# =============================================================================

data "oci_identity_availability_domains" "singapore" {
  compartment_id = var.compartment_id
}

data "oci_identity_availability_domains" "us_east" {
  provider       = oci.us_east
  compartment_id = var.compartment_id
}

# Get Oracle Linux 8 ARM image - Singapore region (default provider)
data "oci_core_images" "oracle_linux_arm_singapore" {
  compartment_id           = var.compartment_id
  operating_system         = "Oracle Linux"
  operating_system_version = "8"
  shape                    = var.instance_shape_arm
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# Get Oracle Linux 8 ARM image - US-East region
# CRITICAL: Each region requires its own image lookup as images are region-specific
data "oci_core_images" "oracle_linux_arm_us_east" {
  provider                 = oci.us_east
  compartment_id           = var.compartment_id
  operating_system         = "Oracle Linux"
  operating_system_version = "8"
  shape                    = var.instance_shape_arm
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# Get Oracle Linux 8 AMD image - US-East region (for cross-chain detector)
data "oci_core_images" "oracle_linux_amd_us_east" {
  provider                 = oci.us_east
  compartment_id           = var.compartment_id
  operating_system         = "Oracle Linux"
  operating_system_version = "8"
  shape                    = var.instance_shape_amd
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# =============================================================================
# Network - Singapore Region (Asia-Fast)
# =============================================================================

resource "oci_core_vcn" "singapore_vcn" {
  compartment_id = var.compartment_id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "arbitrage-singapore-vcn"
  dns_label      = "arbsgvcn"

  freeform_tags = var.tags
}

resource "oci_core_internet_gateway" "singapore_igw" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.singapore_vcn.id
  display_name   = "arbitrage-singapore-igw"
  enabled        = true

  freeform_tags = var.tags
}

resource "oci_core_route_table" "singapore_public_rt" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.singapore_vcn.id
  display_name   = "arbitrage-singapore-public-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.singapore_igw.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }

  freeform_tags = var.tags
}

resource "oci_core_security_list" "singapore_public_sl" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.singapore_vcn.id
  display_name   = "arbitrage-singapore-public-sl"

  # Allow SSH
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # Allow health check port (3011 for Asia-Fast)
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 3011
      max = 3011
    }
  }

  # Allow all outbound
  egress_security_rules {
    protocol         = "all"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
  }

  freeform_tags = var.tags
}

resource "oci_core_subnet" "singapore_public_subnet" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.singapore_vcn.id
  cidr_block        = var.public_subnet_cidr
  display_name      = "arbitrage-singapore-public-subnet"
  dns_label         = "pubsubnet"
  route_table_id    = oci_core_route_table.singapore_public_rt.id
  security_list_ids = [oci_core_security_list.singapore_public_sl.id]

  freeform_tags = var.tags
}

# =============================================================================
# Network - US-East Region (High-Value)
# =============================================================================

resource "oci_core_vcn" "us_east_vcn" {
  provider       = oci.us_east
  compartment_id = var.compartment_id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "arbitrage-us-east-vcn"
  dns_label      = "arbusvcn"

  freeform_tags = var.tags
}

resource "oci_core_internet_gateway" "us_east_igw" {
  provider       = oci.us_east
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.us_east_vcn.id
  display_name   = "arbitrage-us-east-igw"
  enabled        = true

  freeform_tags = var.tags
}

resource "oci_core_route_table" "us_east_public_rt" {
  provider       = oci.us_east
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.us_east_vcn.id
  display_name   = "arbitrage-us-east-public-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.us_east_igw.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }

  freeform_tags = var.tags
}

resource "oci_core_security_list" "us_east_public_sl" {
  provider       = oci.us_east
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.us_east_vcn.id
  display_name   = "arbitrage-us-east-public-sl"

  # Allow SSH
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # Allow health check ports
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 3013
      max = 3015
    }
  }

  # Allow coordinator port
  ingress_security_rules {
    protocol    = "6"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    tcp_options {
      min = 3000
      max = 3000
    }
  }

  # Allow all outbound
  egress_security_rules {
    protocol         = "all"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
  }

  freeform_tags = var.tags
}

resource "oci_core_subnet" "us_east_public_subnet" {
  provider          = oci.us_east
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.us_east_vcn.id
  cidr_block        = var.public_subnet_cidr
  display_name      = "arbitrage-us-east-public-subnet"
  dns_label         = "pubsubnet"
  route_table_id    = oci_core_route_table.us_east_public_rt.id
  security_list_ids = [oci_core_security_list.us_east_public_sl.id]

  freeform_tags = var.tags
}

# =============================================================================
# Compute - Asia-Fast Partition (Singapore)
# =============================================================================

resource "oci_core_instance" "asia_fast_partition" {
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.singapore.availability_domains[0].name
  display_name        = "arbitrage-partition-asia-fast"
  shape               = var.instance_shape_arm

  shape_config {
    ocpus         = var.arm_ocpus
    memory_in_gbs = var.arm_memory_gb
  }

  source_details {
    source_type = "image"
    # Use Singapore region-specific ARM image
    source_id   = data.oci_core_images.oracle_linux_arm_singapore.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.singapore_public_subnet.id
    assign_public_ip = true
    display_name     = "asia-fast-vnic"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/scripts/cloud-init-partition.yaml", {
      partition_id     = var.partition_asia_fast.name
      chains           = join(",", var.partition_asia_fast.chains)
      region_id        = "asia-southeast1"
      health_port      = var.partition_asia_fast.health_port
      redis_url        = var.redis_url
      log_level        = var.log_level
      bsc_ws_url       = var.bsc_ws_url
      bsc_rpc_url      = var.bsc_rpc_url
      polygon_ws_url   = var.polygon_ws_url
      polygon_rpc_url  = var.polygon_rpc_url
      ethereum_ws_url  = ""  # Not used for asia-fast partition
      ethereum_rpc_url = ""  # Not used for asia-fast partition
      docker_image     = var.docker_image_asia_fast
    }))
  }

  freeform_tags = merge(var.tags, {
    Partition = "asia-fast"
    Region    = "singapore"
  })
}

# =============================================================================
# Compute - High-Value Partition (US-East)
# =============================================================================

resource "oci_core_instance" "high_value_partition" {
  provider            = oci.us_east
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.us_east.availability_domains[0].name
  display_name        = "arbitrage-partition-high-value"
  shape               = var.instance_shape_arm

  shape_config {
    ocpus         = var.arm_ocpus
    memory_in_gbs = var.arm_memory_gb
  }

  source_details {
    source_type = "image"
    # CRITICAL: Use US-East region-specific ARM image (not Singapore image)
    source_id   = data.oci_core_images.oracle_linux_arm_us_east.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.us_east_public_subnet.id
    assign_public_ip = true
    display_name     = "high-value-vnic"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/scripts/cloud-init-partition.yaml", {
      partition_id     = var.partition_high_value.name
      chains           = join(",", var.partition_high_value.chains)
      region_id        = "us-east1"
      health_port      = var.partition_high_value.health_port
      redis_url        = var.redis_url
      log_level        = var.log_level
      bsc_ws_url       = ""
      bsc_rpc_url      = ""
      polygon_ws_url   = ""
      polygon_rpc_url  = ""
      ethereum_ws_url  = var.ethereum_ws_url
      ethereum_rpc_url = var.ethereum_rpc_url
      docker_image     = var.docker_image_high_value
    }))
  }

  freeform_tags = merge(var.tags, {
    Partition = "high-value"
    Region    = "us-east"
  })
}

# =============================================================================
# Compute - Cross-Chain Detector (US-East, AMD)
# =============================================================================

resource "oci_core_instance" "cross_chain_detector" {
  provider            = oci.us_east
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.us_east.availability_domains[0].name
  display_name        = "arbitrage-cross-chain-detector"
  shape               = var.instance_shape_amd

  source_details {
    source_type = "image"
    # Use US-East region-specific AMD image
    source_id   = data.oci_core_images.oracle_linux_amd_us_east.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.us_east_public_subnet.id
    assign_public_ip = true
    display_name     = "cross-chain-vnic"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/scripts/cloud-init-cross-chain.yaml", {
      redis_url    = var.redis_url
      log_level    = var.log_level
      docker_image = var.docker_image_cross_chain
    }))
  }

  freeform_tags = merge(var.tags, {
    Service = "cross-chain-detector"
    Region  = "us-east"
  })
}
