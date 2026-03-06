// Minimal redis-cli replacement using ioredis
const Redis = require('ioredis');
const args = process.argv.slice(2);
const redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true, maxRetriesPerRequest: 1 });
(async () => {
  try {
    await redis.connect();
    if (args.length === 0) { console.log('Usage: node redis-cmd.cjs <command> [args...]'); process.exit(1); }
    const cmd = args[0].toLowerCase();
    const cmdArgs = args.slice(1);
    const result = await redis.call(cmd, ...cmdArgs);
    if (Array.isArray(result)) {
      const fmt = (arr, indent = 0) => {
        for (let i = 0; i < arr.length; i++) {
          if (Array.isArray(arr[i])) fmt(arr[i], indent + 2);
          else console.log(' '.repeat(indent) + (i + 1) + ') ' + (arr[i] === null ? '(nil)' : JSON.stringify(arr[i])));
        }
      };
      fmt(result);
    } else {
      console.log(result === null ? '(nil)' : result);
    }
  } catch (e) { console.error('ERR:', e.message); process.exit(1); }
  finally { redis.disconnect(); }
})();
