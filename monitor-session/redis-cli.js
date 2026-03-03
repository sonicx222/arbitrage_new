#!/usr/bin/env node
/**
 * Redis CLI wrapper using ioredis — replacement for redis-cli binary.
 * Usage: node monitor-session/redis-cli.js <command> [args...]
 * Examples:
 *   node redis-cli.js PING
 *   node redis-cli.js XLEN stream:price-updates
 *   node redis-cli.js XINFO STREAM stream:price-updates
 *   node redis-cli.js --scan --pattern 'stream:*'
 */
const Redis = require('ioredis');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node redis-cli.js <command> [args...]');
    process.exit(1);
  }

  const redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    await redis.connect();

    // Handle --scan mode
    if (args[0] === '--scan') {
      const patternIdx = args.indexOf('--pattern');
      const pattern = patternIdx >= 0 ? args[patternIdx + 1] : '*';
      const stream = redis.scanStream({ match: pattern, count: 100 });
      const keys = [];
      for await (const batch of stream) {
        keys.push(...batch);
      }
      // Deduplicate and sort
      const unique = [...new Set(keys)].sort();
      unique.forEach(k => console.log(k));
      await redis.disconnect();
      return;
    }

    // Handle SHUTDOWN
    if (args[0].toUpperCase() === 'SHUTDOWN') {
      try {
        await redis.shutdown(args[1] || 'NOSAVE');
      } catch (e) {
        // Redis closes connection on shutdown, this is expected
        console.log('OK');
      }
      return;
    }

    // Execute command
    const cmd = args[0].toLowerCase();
    const cmdArgs = args.slice(1);

    const result = await redis.call(cmd, ...cmdArgs);

    // Format output similar to redis-cli
    if (result === null) {
      console.log('(nil)');
    } else if (Array.isArray(result)) {
      formatArray(result, 0);
    } else {
      console.log(result);
    }

    await redis.disconnect();
  } catch (err) {
    console.error(`(error) ${err.message}`);
    try { await redis.disconnect(); } catch(e) {}
    process.exit(1);
  }
}

function formatArray(arr, indent) {
  if (!Array.isArray(arr) || arr.length === 0) {
    console.log(`${' '.repeat(indent)}(empty array)`);
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const prefix = `${' '.repeat(indent)}${i + 1}) `;
    if (Array.isArray(arr[i])) {
      console.log(`${prefix}`);
      formatArray(arr[i], indent + 3);
    } else if (arr[i] === null) {
      console.log(`${prefix}(nil)`);
    } else {
      console.log(`${prefix}${arr[i]}`);
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
