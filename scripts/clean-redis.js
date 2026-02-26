#!/usr/bin/env node
/**
 * Clean Redis data for local development.
 *
 * Usage:
 *   npm run dev:redis:clean
 *   npm run dev:redis:clean -- --dry-run
 *   npm run dev:redis:clean -- --all
 *   npm run dev:redis:clean -- --all --force
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const Redis = require('ioredis');

const {
  logger,
  checkRedis,
  getRedisMemoryConfig,
} = require('./lib/utils');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFiles() {
  const envPath = path.join(ROOT_DIR, '.env');
  const envLocalPath = path.join(ROOT_DIR, '.env.local');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true });
  }
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    all: args.has('--all'),
    dryRun: args.has('--dry-run'),
    force: args.has('--force'),
    help: args.has('--help') || args.has('-h'),
  };
}

function printHelp() {
  logger.header('Redis Clean Utility');
  logger.info('Clears Redis data for local development.');
  logger.info('');
  logger.info('Options:');
  logger.info('  --dry-run   Show what would be cleaned without deleting data');
  logger.info('  --all       Use FLUSHALL instead of FLUSHDB');
  logger.info('  --force     Allow running when NODE_ENV is not development');
  logger.info('  --help      Show this help');
}

function buildRedisUrlFromEnv() {
  if (process.env.REDIS_URL && process.env.REDIS_URL.trim()) {
    return process.env.REDIS_URL.trim();
  }

  const host = process.env.REDIS_HOST || '127.0.0.1';
  const port = process.env.REDIS_PORT || '6379';
  const password = process.env.REDIS_PASSWORD || '';

  if (password) {
    return `redis://:${encodeURIComponent(password)}@${host}:${port}`;
  }

  return `redis://${host}:${port}`;
}

async function resolveRedisUrl() {
  const status = await checkRedis();
  if (!status.running) {
    throw new Error('Redis is not running. Start it with "npm run dev:redis" or "npm run dev:redis:memory".');
  }

  if (status.type === 'memory') {
    const cfg = getRedisMemoryConfig();
    if (!cfg?.host || !cfg?.port) {
      throw new Error('In-memory Redis detected but config is missing/invalid.');
    }
    return { url: `redis://${cfg.host}:${cfg.port}`, source: 'memory' };
  }

  return { url: buildRedisUrlFromEnv(), source: 'docker-or-env' };
}

async function main() {
  loadEnvFiles();
  const options = parseArgs(process.argv);

  if (options.help) {
    printHelp();
    return;
  }

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'development' && !options.force) {
    throw new Error(
      `Refusing to clean Redis in NODE_ENV=${nodeEnv}. ` +
      'Re-run with --force if this is intentional.'
    );
  }

  const { url, source } = await resolveRedisUrl();
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });

  try {
    await redis.connect();
    const before = await redis.dbsize();

    logger.header('Redis Clean');
    logger.info(`Mode: ${options.all ? 'FLUSHALL' : 'FLUSHDB'}`);
    logger.info(`Source: ${source}`);
    logger.info(`Keys before cleanup: ${before}`);

    if (options.dryRun) {
      logger.warning('Dry run enabled: no keys were deleted.');
      return;
    }

    if (options.all) {
      await redis.flushall('ASYNC');
    } else {
      await redis.flushdb('ASYNC');
    }

    const after = await redis.dbsize();
    logger.success(`Redis cleanup complete. Keys after cleanup: ${after}`);
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

main().catch((error) => {
  logger.error(`Redis cleanup failed: ${error.message}`);
  process.exit(1);
});

