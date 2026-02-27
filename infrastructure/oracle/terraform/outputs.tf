# Oracle Cloud Terraform Outputs
#
# Outputs from the arbitrage infrastructure deployment
#
# @see ADR-006: Free Hosting Provider Selection

# =============================================================================
# Network Outputs
# =============================================================================

output "singapore_vcn_id" {
  description = "OCID of the Singapore VCN"
  value       = oci_core_vcn.singapore_vcn.id
}

output "us_east_vcn_id" {
  description = "OCID of the US-East VCN"
  value       = oci_core_vcn.us_east_vcn.id
}

output "singapore_public_subnet_id" {
  description = "OCID of the Singapore public subnet"
  value       = oci_core_subnet.singapore_public_subnet.id
}

output "us_east_public_subnet_id" {
  description = "OCID of the US-East public subnet"
  value       = oci_core_subnet.us_east_public_subnet.id
}

# =============================================================================
# Compute Outputs - Asia-Fast Partition
# =============================================================================

output "asia_fast_instance_id" {
  description = "OCID of the Asia-Fast partition instance"
  value       = oci_core_instance.asia_fast_partition.id
}

output "asia_fast_public_ip" {
  description = "Public IP of the Asia-Fast partition"
  value       = oci_core_instance.asia_fast_partition.public_ip
}

output "asia_fast_private_ip" {
  description = "Private IP of the Asia-Fast partition"
  value       = oci_core_instance.asia_fast_partition.private_ip
}

output "asia_fast_health_url" {
  description = "Health check URL for Asia-Fast partition"
  value       = "http://${oci_core_instance.asia_fast_partition.public_ip}:3011/health"
}

# =============================================================================
# Compute Outputs - High-Value Partition
# =============================================================================

output "high_value_instance_id" {
  description = "OCID of the High-Value partition instance"
  value       = oci_core_instance.high_value_partition.id
}

output "high_value_public_ip" {
  description = "Public IP of the High-Value partition"
  value       = oci_core_instance.high_value_partition.public_ip
}

output "high_value_private_ip" {
  description = "Private IP of the High-Value partition"
  value       = oci_core_instance.high_value_partition.private_ip
}

output "high_value_health_url" {
  description = "Health check URL for High-Value partition"
  value       = "http://${oci_core_instance.high_value_partition.public_ip}:3013/health"
}

# =============================================================================
# Compute Outputs - Cross-Chain Detector
# =============================================================================

output "cross_chain_instance_id" {
  description = "OCID of the Cross-Chain Detector instance"
  value       = oci_core_instance.cross_chain_detector.id
}

output "cross_chain_public_ip" {
  description = "Public IP of the Cross-Chain Detector"
  value       = oci_core_instance.cross_chain_detector.public_ip
}

output "cross_chain_private_ip" {
  description = "Private IP of the Cross-Chain Detector"
  value       = oci_core_instance.cross_chain_detector.private_ip
}

output "cross_chain_health_url" {
  description = "Health check URL for Cross-Chain Detector"
  value       = "http://${oci_core_instance.cross_chain_detector.public_ip}:3016/health"
}

# =============================================================================
# Summary Output
# =============================================================================

output "deployment_summary" {
  description = "Summary of deployed resources"
  value = {
    asia_fast_partition = {
      region          = "ap-singapore-1"
      public_ip       = oci_core_instance.asia_fast_partition.public_ip
      health_url      = "http://${oci_core_instance.asia_fast_partition.public_ip}:3011/health"
      chains          = var.partition_asia_fast.chains
      redis           = var.redis_self_hosted ? "self-hosted (localhost:6379)" : "external"
    }
    high_value_partition = {
      region          = "us-ashburn-1"
      public_ip       = oci_core_instance.high_value_partition.public_ip
      health_url      = "http://${oci_core_instance.high_value_partition.public_ip}:3013/health"
      chains          = var.partition_high_value.chains
      redis           = var.redis_self_hosted ? "self-hosted (localhost:6379)" : "external"
    }
    cross_chain_detector = {
      region          = "us-ashburn-1"
      public_ip       = oci_core_instance.cross_chain_detector.public_ip
      health_url      = "http://${oci_core_instance.cross_chain_detector.public_ip}:3016/health"
      redis           = var.redis_self_hosted ? "self-hosted (localhost:6379)" : "external"
    }
  }
}

# =============================================================================
# SSH Commands
# =============================================================================

output "ssh_commands" {
  description = "SSH commands to connect to instances"
  value = {
    asia_fast    = "ssh opc@${oci_core_instance.asia_fast_partition.public_ip}"
    high_value   = "ssh opc@${oci_core_instance.high_value_partition.public_ip}"
    cross_chain  = "ssh opc@${oci_core_instance.cross_chain_detector.public_ip}"
  }
}
