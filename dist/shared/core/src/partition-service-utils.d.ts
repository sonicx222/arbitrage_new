/**
 * Shared Partition Service Utilities
 *
 * Common utilities for all partition detector services (P1-P4).
 * Reduces code duplication and ensures consistency across partitions.
 *
 * Features:
 * - Port validation and parsing
 * - Chain validation and filtering
 * - HTTP health server creation
 * - Graceful shutdown handling
 * - Event handler setup
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.3-S3.1.6: Partition service implementations
 */
import { Server } from 'http';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
export interface PartitionServiceConfig {
    /** Partition ID (e.g., 'asia-fast', 'l2-turbo') */
    partitionId: string;
    /** Service name for logging and health responses */
    serviceName: string;
    /** Default chains for this partition */
    defaultChains: readonly string[];
    /** Default health check port */
    defaultPort: number;
    /** Region ID for health responses */
    region: string;
    /** Provider name (e.g., 'oracle', 'fly') */
    provider: string;
}
export interface HealthServerOptions {
    /** Port to listen on */
    port: number;
    /** Service config for responses */
    config: PartitionServiceConfig;
    /** Detector instance for health checks */
    detector: PartitionDetectorInterface;
    /** Logger instance */
    logger: ReturnType<typeof createLogger>;
}
export interface PartitionDetectorInterface extends EventEmitter {
    getPartitionHealth(): Promise<{
        status: string;
        partitionId: string;
        chainHealth: Map<string, unknown>;
        uptimeSeconds: number;
        totalEventsProcessed: number;
        memoryUsage: number;
    }>;
    getHealthyChains(): string[];
    getStats(): {
        partitionId: string;
        chains: string[];
        totalEventsProcessed: number;
        totalOpportunitiesFound: number;
        uptimeSeconds: number;
        memoryUsageMB: number;
        chainStats: Map<string, unknown>;
    };
    isRunning(): boolean;
    getPartitionId(): string;
    getChains(): string[];
    start(): Promise<void>;
    stop(): Promise<void>;
}
/**
 * Validates and parses a port number from environment variable.
 * Returns defaultPort if the value is invalid or not provided.
 *
 * @param portEnv - The port environment variable value
 * @param defaultPort - Default port to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Valid port number
 */
export declare function parsePort(portEnv: string | undefined, defaultPort: number, logger?: ReturnType<typeof createLogger>): number;
/**
 * Validates chains from environment variable against known chain IDs.
 * Returns only valid chains, or defaults if none are valid.
 *
 * @param chainsEnv - Comma-separated chain IDs from environment
 * @param defaultChains - Default chains to use if validation fails
 * @param logger - Logger instance for warnings
 * @returns Array of valid chain IDs
 */
export declare function validateAndFilterChains(chainsEnv: string | undefined, defaultChains: readonly string[], logger?: ReturnType<typeof createLogger>): string[];
/**
 * Creates an HTTP health check server for partition services.
 * Provides consistent endpoints across all partitions.
 *
 * Endpoints:
 * - GET / - Service info
 * - GET /health, /healthz - Health status
 * - GET /ready - Readiness check
 * - GET /stats - Detailed statistics
 *
 * @param options - Health server configuration
 * @returns HTTP Server instance
 */
export declare function createPartitionHealthServer(options: HealthServerOptions): Server;
/** Default timeout for shutdown operations in milliseconds */
export declare const SHUTDOWN_TIMEOUT_MS = 5000;
/**
 * Gracefully shuts down a partition service.
 * Handles health server and detector shutdown with timeouts.
 *
 * @param signal - Signal that triggered shutdown
 * @param healthServer - HTTP server to close
 * @param detector - Detector instance to stop
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 */
export declare function shutdownPartitionService(signal: string, healthServer: Server | null, detector: PartitionDetectorInterface, logger: ReturnType<typeof createLogger>, serviceName: string): Promise<void>;
/**
 * Sets up standard event handlers for a partition detector.
 * Provides consistent logging across all partitions.
 *
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param partitionId - Partition ID for log context
 */
export declare function setupDetectorEventHandlers(detector: PartitionDetectorInterface, logger: ReturnType<typeof createLogger>, partitionId: string): void;
/**
 * Cleanup function returned by setupProcessHandlers to remove registered listeners.
 * Call this during testing or when reinitializing handlers.
 */
export type ProcessHandlerCleanup = () => void;
/**
 * Sets up process signal handlers for graceful shutdown.
 *
 * P19-FIX: Uses a shutdown flag to prevent multiple concurrent shutdown attempts
 * when signals arrive close together (e.g., SIGTERM followed by SIGINT).
 *
 * S3.2.3-FIX: Returns cleanup function to prevent MaxListenersExceeded warnings
 * when handlers are registered multiple times (e.g., in tests).
 *
 * @param healthServerRef - Reference to health server (use object to allow mutation)
 * @param detector - Detector instance
 * @param logger - Logger instance
 * @param serviceName - Service name for logging
 * @returns Cleanup function to remove all registered handlers
 */
export declare function setupProcessHandlers(healthServerRef: {
    current: Server | null;
}, detector: PartitionDetectorInterface, logger: ReturnType<typeof createLogger>, serviceName: string): ProcessHandlerCleanup;
//# sourceMappingURL=partition-service-utils.d.ts.map