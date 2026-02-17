#!/usr/bin/env node
/**
 * Stop local Redis (in-memory and/or Docker) safely.
 *
 * Cross-platform compatible (Windows, macOS, Linux).
 * Never hard-fails just because Docker daemon is unavailable.
 *
 * Usage:
 *   npm run dev:redis:down
 */

const { spawnSync } = require('child_process');
const path = require('path');

const {
  logger,
  log,
  processExists,
  killProcess,
  findProcessesByPort,
  getRedisMemoryConfig,
  deleteRedisMemoryConfig,
  ROOT_DIR
} = require('./lib/utils');

const DOCKER_COMPOSE_FILE = path.join(ROOT_DIR, 'docker-compose.local.yml');

/**
 * Stop redis-memory-server instance when tracked via config file.
 * @returns {Promise<boolean>} true if an in-memory instance was found and handled
 */
async function stopInMemoryRedis() {
  const config = getRedisMemoryConfig();
  if (!config || !config.pid) {
    log('No in-memory Redis config found.', 'dim');
    return false;
  }

  logger.info(`Found in-memory Redis config (PID ${config.pid}).`);

  const isRunning = await processExists(config.pid);
  if (isRunning) {
    const killed = await killProcess(config.pid);
    if (killed) {
      logger.success('Stopped in-memory Redis process.');
    } else {
      logger.warning('Could not stop in-memory Redis process (it may have already exited).');
    }
  } else {
    log('In-memory Redis process is not running.', 'dim');
  }

  // Safety net: also kill any process still listening on the configured Redis port.
  // This handles orphaned child redis-server processes when the parent launcher is gone.
  const redisPort = config.port ?? 6379;
  const lingeringPids = await findProcessesByPort(redisPort);
  for (const pid of lingeringPids) {
    if (pid === process.pid) continue;
    const killed = await killProcess(pid);
    if (killed) {
      logger.info(`Stopped lingering process on Redis port ${redisPort} (PID ${pid}).`);
    }
  }

  deleteRedisMemoryConfig();
  logger.success('Removed in-memory Redis config file.');
  return true;
}

/**
 * Run docker compose down using a specific command variant.
 * @param {string} command
 * @param {string[]} args
 * @returns {{ok: boolean, notInstalled?: boolean, daemonUnavailable?: boolean, output?: string}}
 */
function runDockerDown(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { ok: false, notInstalled: true };
    }
    return { ok: false, output: result.error.message };
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status === 0) {
    return { ok: true, output };
  }

  // Docker CLI found, but daemon is not reachable/running.
  if (/cannot connect to the docker daemon|error during connect|is the docker daemon running|docker daemon is not running/i.test(output)) {
    return { ok: false, daemonUnavailable: true, output };
  }

  return { ok: false, output };
}

/**
 * Stop Docker Redis containers if Docker is available.
 * @returns {boolean} true if docker compose down ran successfully
 */
function stopDockerRedis() {
  const composeArgs = ['-f', DOCKER_COMPOSE_FILE, 'down'];

  // Try modern "docker compose" first, then legacy "docker-compose".
  const attempts = [
    ['docker', ['compose', ...composeArgs]],
    ['docker-compose', composeArgs]
  ];

  for (const [cmd, args] of attempts) {
    const result = runDockerDown(cmd, args);

    if (result.notInstalled) {
      continue;
    }

    if (result.ok) {
      logger.success(`Docker Redis stopped via "${cmd}".`);
      if (result.output) {
        log(result.output, 'dim');
      }
      return true;
    }

    if (result.daemonUnavailable) {
      logger.warning('Docker daemon is unavailable. Skipping Docker Redis shutdown.');
      return false;
    }

    // Command exists but failed for another reason (keep non-fatal).
    logger.warning(`Docker Redis shutdown via "${cmd}" failed (non-fatal).`);
    if (result.output) {
      log(result.output, 'dim');
    }
    return false;
  }

  log('Docker CLI not found. Skipping Docker Redis shutdown.', 'dim');
  return false;
}

async function main() {
  logger.header('Stopping Local Redis');

  const memoryHandled = await stopInMemoryRedis();
  const dockerStopped = stopDockerRedis();

  if (!memoryHandled && !dockerStopped) {
    logger.info('No active Redis instance detected (or nothing needed to stop).');
  }

  console.log('');
}

main().catch((error) => {
  logger.error(`Failed to stop Redis cleanly: ${error.message}`);
  process.exit(1);
});
