const Redis = require('ioredis');
const r = new Redis(6379);

async function main() {
  try {
    // Discover streams
    const keys = [];
    let cursor = '0';
    do {
      const [newCursor, batch] = await r.scan(cursor, 'MATCH', 'stream:*', 'COUNT', 100);
      cursor = newCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    keys.sort();
    console.log('=== Discovered Streams ===');
    console.log(JSON.stringify(keys, null, 2));
    console.log('Total:', keys.length);

    // Get stream info
    console.log('\n=== Stream Lengths ===');
    for (const key of keys) {
      const len = await r.xlen(key);
      console.log(key + ': ' + len);
    }

    // Get consumer groups per stream
    console.log('\n=== Consumer Groups ===');
    for (const key of keys) {
      try {
        const groups = await r.xinfo('GROUPS', key);
        if (groups && groups.length > 0) {
          for (let i = 0; i < groups.length; i += 2) {
            // ioredis returns flat array: [field, value, field, value, ...]
          }
          console.log(key + ': ' + JSON.stringify(groups));
        }
      } catch (e) {
        // Stream may not exist
      }
    }

    // Memory info
    const mem = await r.info('memory');
    const usedMem = (mem.match(/used_memory_human:([^\r\n]+)/) || [])[1] || 'unknown';
    const peakMem = (mem.match(/used_memory_peak_human:([^\r\n]+)/) || [])[1] || 'unknown';
    console.log('\n=== Redis Memory ===');
    console.log('Used:', usedMem, 'Peak:', peakMem);
  } catch (e) {
    console.error(e.message);
  } finally {
    r.disconnect();
  }
}

main();
