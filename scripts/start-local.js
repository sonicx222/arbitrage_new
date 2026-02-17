#!/usr/bin/env node
/**
 * Local Development Startup Script
 *
 * Starts all arbitrage system components for local development.
 * Cross-platform compatible (Windows, macOS, Linux).
 *
 * Usage:
 *   npm run dev:start          # Start all services
 *   npm run dev:simulate       # Start with simulation mode (no real blockchain)
 */

const { spawn } = require('child_process');

const {
  logger,      // P3-4: Modern logger interface (preferred)
  log,         // Legacy - kept for formatting/dim output
  logService,  // Service-specific logging (keep for now)
  isWindows,
  checkRedis,
  checkHealth,
  getRedisMemoryConfig,
  updatePid,
  removePid,
  loadPids,    // FIX #6: Needed by interrupt handler to find PID of currently-starting service
  killProcess,
  killAllPids,
  killTsNodeProcesses,
  findProcessesByPort,
  processExists,
  ROOT_DIR
} = require('./lib/utils');

const { getStartupServices, PORTS, checkAndPrintDeprecations } = require('./lib/services-config');

// Task P2-2: Use shared constants
const {
  REDIS_STARTUP_TIMEOUT_SEC,
  REDIS_CHECK_INTERVAL_MS,
  SERVICE_STARTUP_MAX_ATTEMPTS,
  HEALTH_CHECK_INTERVAL_MS,
  SERVICE_START_DELAY_MS
} = require('./lib/constants');

// =============================================================================
// Configuration
// =============================================================================

// Check for deprecated environment variables
checkAndPrintDeprecations();

const SERVICES = getStartupServices();

// =============================================================================
// Redis Check
// =============================================================================

async function waitForRedis(maxAttempts = REDIS_STARTUP_TIMEOUT_SEC) {
  // P3-4: Migrated to modern logger
  logger.info('\nChecking Redis connection...');

  for (let i = 0; i < maxAttempts; i++) {
    const status = await checkRedis();
    if (status.running) {
      if (status.type === 'docker') {
        logger.success('Redis is ready! (Docker container)');
      } else if (status.type === 'memory') {
        logger.success('Redis is ready! (In-memory server)');
      }
      // FIX #23: Return Redis type so caller can set REDIS_MEMORY_MODE for child processes
      return status.type || 'unknown';
    }
    await new Promise(r => setTimeout(r, REDIS_CHECK_INTERVAL_MS));
    process.stdout.write('.');
  }

  logger.error('\nRedis is not running. Start it with one of these commands:');
  logger.warning('  npm run dev:redis         # Docker (requires Docker Hub access)');
  logger.warning('  npm run dev:redis:memory  # In-memory (no Docker required)');
  return false;
}

// =============================================================================
// Stream Helpers
// =============================================================================

/**
 * Map Pino numeric log levels to short labels.
 * @see https://getpino.io/#/docs/api?id=loggerlevel
 */
const PINO_LEVELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };

/**
 * Minimum Pino numeric level to display in script output.
 * Controlled by LOG_LEVEL env var. Defaults to 30 (INFO).
 */
const LOG_LEVEL_NAMES = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const SCRIPT_MIN_LEVEL = LOG_LEVEL_NAMES[(process.env.LOG_LEVEL ?? 'info').toLowerCase()] ?? 30;

/**
 * Map Pino numeric levels to display colors.
 */
const PINO_LEVEL_COLORS = { 10: 'dim', 20: 'dim', 30: 'cyan', 40: 'yellow', 50: 'red', 60: 'red' };

/**
 * FIX L4: Pipe a child process stream to logService, one line at a time.
 * Parses Pino JSON output to extract level + message, eliminating the
 * double-timestamp/double-prefix problem when pino-pretty was active.
 * Falls back to raw passthrough for non-JSON lines (stack traces, warnings).
 *
 * @param {import('stream').Readable} stream - The readable stream (stdout or stderr)
 * @param {string} serviceName - Service name for log prefix
 * @param {string} defaultColor - Color for non-JSON lines or fallback
 * @param {function} [filter] - Optional filter predicate; line is logged only if filter returns true
 */
function pipeStreamToLog(stream, serviceName, defaultColor, filter) {
  stream.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (filter && !filter(line)) continue;

      // Try to parse as Pino JSON
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.msg && parsed.level !== undefined) {
          // Filter out messages below the configured minimum level
          if (parsed.level < SCRIPT_MIN_LEVEL) continue;
          const levelLabel = PINO_LEVELS[parsed.level] || 'INFO';
          const levelColor = PINO_LEVEL_COLORS[parsed.level] || defaultColor;
          logService(serviceName, `[${levelLabel}] ${parsed.msg}`, levelColor);
          continue;
        }
      } catch {
        // Not JSON — fall through to raw passthrough
      }
      logService(serviceName, line, defaultColor);
    }
  });
}

// =============================================================================
// Service Startup
// =============================================================================

async function startService(service, runtimeEnvOverrides = {}) {
  logService(service.name, `Starting on port ${service.port}...`, 'yellow');

  // FIX H4: Filter sensitive env vars before passing to child processes.
  // Services load their own secrets from .env via dotenv/config.
  // Note: API_KEY intentionally NOT filtered — RPC provider keys (ALCHEMY_API_KEY,
  // INFURA_API_KEY, etc.) are needed by services and are not dangerous secrets.
  const SENSITIVE_PATTERNS = /PRIVATE_KEY|MNEMONIC|SECRET|PASSWORD|AUTH_TOKEN/i;
  const filteredEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_PATTERNS.test(key)) {
      filteredEnv[key] = value;
    }
  }
  const env = {
    ...filteredEnv,
    ...runtimeEnvOverrides,
    ...service.env,
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    LOG_FORMAT: 'json',  // Force JSON output so script can parse and reformat
  };

  // FIX #7 + FIX #20: Spawn ts-node via node directly (not npx).
  // Node.js v25+ on Windows broke spawn() with .cmd files (EINVAL),
  // and npx.cmd also triggers DEP0190 with shell:true.
  // Using `node ts-node/dist/bin.js` bypasses both issues on all platforms.
  const tsNodeBin = require.resolve('ts-node/dist/bin.js');

  // FIX #21: Set max-old-space-size to prevent OOM crashes.
  // Partition detectors allocate ~563MB SharedArrayBuffer each and grow unbounded,
  // causing silent crashes at ~3.5GB. Cap at 2GB for stability.
  const maxOldSpace = process.env.NODE_MAX_OLD_SPACE_SIZE ?? '2048';
  const spawnArgs = [`--max-old-space-size=${maxOldSpace}`, tsNodeBin, '-r', 'dotenv/config', '-r', 'tsconfig-paths/register', service.script];
  const spawnOpts = {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    ...(isWindows() ? { windowsHide: true } : {})
  };
  const child = spawn(process.execPath, spawnArgs, spawnOpts);

  // FIX #4: Track child PID in currentlyStarting so interrupt handler can kill it directly
  if (currentlyStarting) {
    currentlyStarting.pid = child.pid;
  }

  // Track spawn errors asynchronously
  let spawnError = null;
  child.on('error', (error) => {
    logService(service.name, `Failed to start: ${error.message}`, 'red');
    spawnError = error;
  });

  // Store PID for later cleanup using atomic update (prevents race conditions)
  // FIX C1: await is now legal — startService is a plain async function (no Promise executor)
  try {
    await updatePid(service.name, child.pid);
  } catch (err) {
    logService(service.name, `CRITICAL: Failed to save PID - killing process to prevent ghost`, 'red');
    await killProcess(child.pid);
    throw new Error(
      `Cannot track ${service.name} process (PID ${child.pid}).\n` +
      `PID file update failed: ${err.message}\n\n` +
      `This prevents proper cleanup via "npm run dev:stop".\n` +
      `Possible causes:\n` +
      `  - Disk full\n` +
      `  - Permission denied writing to ${ROOT_DIR}/.local-services.pid\n` +
      `  - Lock timeout (another script holding lock)\n\n` +
      `To fix:\n` +
      `  1. Check disk space: df -h (Unix) or dir (Windows)\n` +
      `  2. Check file permissions on .local-services.pid\n` +
      `  3. Run: npm run dev:cleanup (to clear stale locks)\n` +
      `  4. Retry: npm run dev:start`
    );
  }

  // FIX L4: Extract duplicated stream→logService piping into shared helper
  pipeStreamToLog(child.stdout, service.name, 'dim');
  pipeStreamToLog(child.stderr, service.name, 'red', (line) =>
    !line.includes('ExperimentalWarning')
  );

  // Detach the child process to allow parent to exit independently
  child.unref();

  // Wait for startup delay before health checking
  await new Promise(r => setTimeout(r, service.delay));

  // Check if spawn error occurred during delay
  if (spawnError) {
    throw spawnError;
  }

  // Health check polling
  const maxAttempts = SERVICE_STARTUP_MAX_ATTEMPTS;
  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    const healthResult = await checkHealth(service.port, service.healthEndpoint);
    if (healthResult.running) {
      // FIX #4: Post-health-check liveness verification to catch ghost PIDs.
      // Process can die immediately after responding to health check.
      await new Promise(r => setTimeout(r, 500));
      const stillAlive = await processExists(child.pid);
      if (!stillAlive) {
        logService(service.name, 'Process died immediately after health check passed (ghost PID)', 'red');
        await removePid(service.name).catch(() => {});
        throw new Error(
          `${service.name} passed health check but died immediately after.\n\n` +
          `This usually indicates an initialization error that occurs after the\n` +
          `health endpoint becomes available (e.g., OOM, unhandled rejection).\n\n` +
          `To debug:\n` +
          `  1. Start the service directly to see full output:\n` +
          `     npx ts-node ${service.script}\n` +
          `  2. Check system memory usage (services may be OOM-killed)`
        );
      }
      // FIX #19: Clean up pipe listeners to prevent garbled output during subsequent service startups
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      logService(service.name, `Started successfully! (PID: ${child.pid})`, 'green');
      return child.pid;
    }

    // Check if process is still running
    // FIX P2-1: Use processExists() for Windows compatibility
    const isRunning = await processExists(child.pid);
    if (!isRunning) {
      // Process has died - clean up PID entry to prevent ghost processes
      logService(service.name, 'Process terminated unexpectedly', 'red');
      await removePid(service.name).catch(() => {});
      throw new Error(
        `${service.name} process died during startup.\n\n` +
        `Possible causes:\n` +
        `  - Missing dependencies (run: npm install)\n` +
        `  - Configuration error in .env file\n` +
        `  - Port ${service.port} already in use\n` +
        `  - TypeScript compilation error\n\n` +
        `To debug:\n` +
        `  1. Check the error output above for details\n` +
        `  2. Try starting the service directly:\n` +
        `     npx ts-node ${service.script}\n` +
        `  3. Check if port ${service.port} is available:\n` +
        `     npx kill-port ${service.port}`
      );
    }

    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }

  // Health check timeout - kill the process and clean up to prevent ghost processes
  logService(service.name, 'Health check timeout - killing process', 'red');
  await killProcess(child.pid);
  await removePid(service.name).catch(() => {});
  const actualTimeoutSec = (maxAttempts * HEALTH_CHECK_INTERVAL_MS) / 1000;
  throw new Error(
    `${service.name} health check timeout after ${actualTimeoutSec}s (${maxAttempts} attempts).\n\n` +
    `The service started but failed to respond on ${service.healthEndpoint}.\n\n` +
    `Possible causes:\n` +
    `  - Service is still initializing (normal for first start)\n` +
    `  - Health check endpoint incorrect or not implemented\n` +
    `  - Service crashed after starting\n` +
    `  - Firewall blocking port ${service.port}\n\n` +
    `To debug:\n` +
    `  1. Check if service is listening:\n` +
    `     curl http://localhost:${service.port}${service.healthEndpoint}\n` +
    `  2. Increase timeout (currently ${maxAttempts} attempts × ${HEALTH_CHECK_INTERVAL_MS}ms) in scripts/lib/constants.js\n` +
    `  3. Check service logs for startup errors\n` +
    `  4. Try starting service directly to see full output:\n` +
    `     npx ts-node ${service.script}`
  );
}

// =============================================================================
// Main Entry Point
// =============================================================================

// Track started PIDs for cleanup on interruption
const startedPids = [];
let interrupted = false;
// FIX #6: Track the service currently being started so Ctrl+C during health
// check can clean it up. PID is written to file (via updatePid) before being
// added to startedPids[], so without this the interrupt handler would miss it.
let currentlyStarting = null; // { name: string, pid: number } | null

async function cleanupOnInterrupt() {
  if (interrupted) return; // Prevent double cleanup
  interrupted = true;

  // Safety net: force exit if cleanup hangs (e.g., tasklist on Windows)
  const forceExitTimer = setTimeout(() => process.exit(130), 10000);
  forceExitTimer.unref(); // Don't keep process alive just for this timer

  logger.warning('\nInterrupted! Cleaning up started services...');

  // FIX #6 + FIX #4: Clean up the service that's currently starting (if any).
  // Use the tracked PID directly when available; fall back to PID file lookup.
  if (currentlyStarting) {
    try {
      let pid = currentlyStarting.pid;
      if (!pid) {
        // Fallback: PID may not be set yet if spawn hasn't returned
        const pids = await loadPids();
        pid = pids[currentlyStarting.name];
      }
      if (pid) {
        await killProcess(pid);
      }
      await removePid(currentlyStarting.name).catch(() => {});
      logger.info(`  Stopped ${currentlyStarting.name} (PID: ${pid ?? 'unknown'}) [was starting]`);
    } catch (err) {
      console.warn('Warning: cleanup of currently-starting service failed:', err?.message ?? err);
    }
  }

  // FIX #10 + #9: Kill all started services in parallel using shared killAllPids
  const pidMap = {};
  for (const { name, pid } of startedPids) {
    pidMap[name] = pid;
  }
  try {
    const results = await killAllPids(pidMap);
    for (const r of results) {
      if (r.existed && r.killed) {
        logger.info(`  Stopped ${r.name} (PID: ${r.pid})`);
      }
    }
    for (const { name } of startedPids) {
      await removePid(name).catch(() => {});
    }
  } catch (err) {
    console.warn('Warning: cleanup of started services failed:', err?.message ?? err);
  }

  // Fallback: kill any remaining ts-node/tsx processes
  try { await killTsNodeProcesses(); } catch (err) { console.warn('Warning: ts-node process cleanup failed:', err?.message ?? err); }

  // Fallback: port-based cleanup for any orphaned child processes
  try {
    const { getCleanupPorts } = require('./lib/services-config');
    const ports = getCleanupPorts();
    for (const svc of ports) {
      const portPids = await findProcessesByPort(svc.port);
      for (const portPid of portPids) {
        await killProcess(portPid);
      }
    }
  } catch (err) {
    console.warn('Warning: port-based cleanup failed:', err?.message ?? err);
  }

  // FIX #10: Clean up metadata file on interrupt
  try {
    require('fs').unlinkSync(require('path').join(ROOT_DIR, '.local-services.meta'));
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('Warning: metadata file cleanup failed:', err?.message ?? err);
  }
  process.exit(130);
}

process.on('SIGINT', cleanupOnInterrupt);
process.on('SIGTERM', cleanupOnInterrupt);

async function main() {
  // P3-4: Use modern logger.header() for section headers
  logger.header('Arbitrage System - Local Development Startup');

  // Check simulation modes
  if (process.env.SIMULATION_MODE === 'true') {
    logger.warning('Running in PRICE SIMULATION MODE - No real blockchain connections');
  }
  if (process.env.EXECUTION_SIMULATION_MODE === 'true') {
    logger.warning('Running in EXECUTION SIMULATION MODE - No real transactions');
  }

  // Check Redis
  const redisType = await waitForRedis();
  if (!redisType) {
    process.exit(1);
  }

  // If using in-memory Redis, force child services to use a passwordless local URL.
  // This avoids noisy AUTH warnings when REDIS_PASSWORD exists in .env for Docker mode.
  const runtimeEnvOverrides = {};
  if (redisType === 'memory') {
    const memoryConfig = getRedisMemoryConfig();
    const redisHost = memoryConfig?.host ?? '127.0.0.1';
    const redisPort = memoryConfig?.port ?? PORTS.REDIS;
    runtimeEnvOverrides.REDIS_URL = `redis://${redisHost}:${redisPort}`;
    runtimeEnvOverrides.REDIS_PASSWORD = '';
    runtimeEnvOverrides.REDIS_IN_MEMORY = 'true';
    logger.info(`Using in-memory Redis override for child services: ${runtimeEnvOverrides.REDIS_URL}`);
  }

  // Start services
  logger.info('\nStarting services...\n');

  const startupBegin = Date.now();
  const serviceDurations = {};
  const failedServices = [];
  for (const service of SERVICES) {
    // FIX #6: Track currently-starting service for interrupt cleanup
    currentlyStarting = { name: service.name };
    const serviceStart = Date.now();
    try {
      const pid = await startService(service, runtimeEnvOverrides);
      serviceDurations[service.name] = Date.now() - serviceStart;
      startedPids.push({ name: service.name, pid });
      currentlyStarting = null;
      // Small delay between services
      await new Promise(r => setTimeout(r, SERVICE_START_DELAY_MS));
    } catch (error) {
      serviceDurations[service.name] = Date.now() - serviceStart;
      currentlyStarting = null;
      // logService already printed the inline error in startService()
      // Store short summary (first line only) for end-of-run report
      const shortReason = error.message.split('\n')[0];
      failedServices.push({ name: service.name, error: shortReason });
    }
  }
  const totalDurationSec = ((Date.now() - startupBegin) / 1000).toFixed(1);

  // FIX P1-2: Show failed services summary
  if (failedServices.length > 0) {
    // FIX #5: Signal partial failure to CI/CD and wrapper scripts
    process.exitCode = 1;
    logger.warning('\n⚠️  Some services failed to start:');
    failedServices.forEach(({ name, error }) => {
      logger.warning(`  • ${name}: ${error}`);
    });
    logger.info('\nTo cleanup and retry:');
    log('  npm run dev:cleanup', 'dim');  // Keep log() for dim formatting
    log('  npm run dev:start', 'dim');
  }

  // FIX #10: Persist startup metadata for cross-session status display
  const META_FILE = require('path').join(ROOT_DIR, '.local-services.meta');
  if (startedPids.length > 0) {
    const metadata = {
      startedAt: new Date().toISOString(),
      simulationMode: process.env.SIMULATION_MODE === 'true',
      executionSimulationMode: process.env.EXECUTION_SIMULATION_MODE === 'true',
      services: startedPids.map(s => s.name),
      failedServices: failedServices.map(f => f.name)
    };
    try {
      require('fs').writeFileSync(META_FILE, JSON.stringify(metadata, null, 2));
    } catch (err) {
      console.warn('Warning: metadata file write failed:', err?.message ?? err);
    }
  } else {
    // All services failed — remove stale metadata from a previous run
    try {
      require('fs').unlinkSync(META_FILE);
    } catch (err) {
      if (err?.code !== 'ENOENT') console.warn('Warning: metadata file cleanup failed:', err?.message ?? err);
    }
  }

  // Print summary
  const failedNames = new Set(failedServices.map(f => f.name));
  console.log('\n' + '='.repeat(60));
  if (failedServices.length === 0) {
    logger.success(`  All ${SERVICES.length} Services Started in ${totalDurationSec}s`);
  } else if (startedPids.length > 0) {
    logger.warning(`  ${startedPids.length}/${SERVICES.length} Services Started in ${totalDurationSec}s (${failedServices.length} failed)`);
  } else {
    logger.error('  All Services Failed to Start!');
  }
  console.log('='.repeat(60));
  logger.info('\nServices:');
  SERVICES.forEach(service => {
    const duration = serviceDurations[service.name];
    const durationStr = duration != null ? `${(duration / 1000).toFixed(1)}s` : '';
    if (failedNames.has(service.name)) {
      logger.error(`  ${service.name.padEnd(22)} :${service.port}  FAILED  ${durationStr}`);
    } else {
      logger.success(`  ${service.name.padEnd(22)} :${service.port}  OK      ${durationStr}`);
    }
  });
  logger.info('\nCommands:');
  log('  npm run dev:status      Check service status', 'dim');
  log('  npm run dev:stop        Stop all services', 'dim');
  log('  npm run dev:redis:logs  View Redis logs', 'dim');
  console.log('');
}

main().catch(error => {
  logger.error(`\nStartup failed: ${error.message}`);
  process.exit(1);
});
