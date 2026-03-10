#!/usr/bin/env node
// Unified Redis CLI replacement for monitoring sessions.
// Reads connection from REDIS_URL or REDIS_HOST/REDIS_PORT env vars.
//
// Usage:
//   node redis-cli.cjs <command> [args...]
//   node redis-cli.cjs --scan --pattern "stream:*"
//   REDIS_HOST=10.0.0.5 REDIS_PORT=6380 node redis-cli.cjs INFO server

const Redis = require('ioredis');
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage: node redis-cli.cjs <command> [args...]');
  console.log('       node redis-cli.cjs --scan --pattern "stream:*"');
  console.log('');
  console.log('Environment:');
  console.log('  REDIS_URL   Full Redis URL (e.g. redis://:password@host:6379)');
  console.log('  REDIS_HOST  Redis host (default: 127.0.0.1)');
  console.log('  REDIS_PORT  Redis port (default: 6379)');
  process.exit(1);
}

function createClient() {
  const url = process.env.REDIS_URL;
  if (url) {
    return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  }
  return new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}

function formatResult(result, indent) {
  indent = indent || 0;
  if (result === null) {
    console.log(' '.repeat(indent) + '(nil)');
  } else if (Array.isArray(result)) {
    if (result.length === 0) {
      console.log(' '.repeat(indent) + '(empty array)');
    } else {
      for (let i = 0; i < result.length; i++) {
        if (Array.isArray(result[i])) {
          console.log(' '.repeat(indent) + (i + 1) + ')');
          formatResult(result[i], indent + 2);
        } else {
          const val = result[i] === null ? '(nil)' : String(result[i]);
          console.log(' '.repeat(indent) + (i + 1) + ') ' + val);
        }
      }
    }
  } else {
    console.log(String(result));
  }
}

async function runScan(pattern) {
  const redis = createClient();
  try {
    await redis.connect();
    const stream = redis.scanStream({ match: pattern, count: 100 });
    let total = 0;
    for await (const keys of stream) {
      for (const key of keys) {
        console.log(key);
        total++;
      }
    }
    if (total === 0) console.error('(no keys matched)');
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    redis.disconnect();
  }
}

async function runCommand(cmdArgs) {
  const redis = createClient();
  try {
    await redis.connect();
    const cmd = cmdArgs[0].toLowerCase();
    const rest = cmdArgs.slice(1);
    const result = await redis.call(cmd, ...rest);
    formatResult(result);
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  } finally {
    redis.disconnect();
  }
}

if (args[0] === '--scan' && args[1] === '--pattern') {
  runScan(args[2] || '*');
} else {
  runCommand(args);
}
