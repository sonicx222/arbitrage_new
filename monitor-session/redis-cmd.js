#!/usr/bin/env node
/**
 * Minimal redis-cli replacement using ioredis
 * Usage: node redis-cmd.js <COMMAND> [args...]
 */
const args = process.argv.slice(2);
if (!args.length) { process.exit(0); }

let Redis;
try { Redis = require('ioredis'); } catch(e) {
  try { Redis = require('/c/Users/kj2bn8f/arbitrage_new/node_modules/ioredis'); } catch(e2) {
    console.error('ioredis not found'); process.exit(1);
  }
}

const client = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false, connectTimeout: 3000, maxRetriesPerRequest: 1 });
client.on('error', () => {});

async function run() {
  try {
    await new Promise(r => setTimeout(r, 200));
    const cmd = args[0].toLowerCase();
    const rest = args.slice(1);
    let result;
    if (cmd === 'ping') result = await client.ping();
    else if (cmd === 'xlen') result = await client.xlen(rest[0]);
    else if (cmd === 'get') result = await client.get(rest[0]);
    else if (cmd === 'ttl') result = await client.ttl(rest[0]);
    else if (cmd === 'xrevrange') result = await client.xrevrange(rest[0], rest[1] || '+', rest[2] || '-', 'COUNT', rest[4] || 10);
    else if (cmd === 'xpending') result = await client.xpending(rest[0], rest[1]);
    else if (cmd === 'xinfo' && rest[0] === 'stream') result = await client.xinfo('STREAM', rest[1]);
    else if (cmd === 'xinfo' && rest[0] === 'groups') result = await client.xinfo('GROUPS', rest[1]);
    else if (cmd === 'info') result = await client.info(rest[0] || '');
    else if (cmd === 'scan') {
      // --scan --pattern 'stream:*'
      const patIdx = args.indexOf('--pattern');
      const pattern = patIdx >= 0 ? args[patIdx+1] : '*';
      let cursor = '0'; const keys = [];
      do {
        const r = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = r[0]; keys.push(...r[1]);
      } while (cursor !== '0');
      result = keys.join('\n');
    }
    else if (cmd === 'command' && rest[0] === 'info') result = 'ok';
    else result = await client.call(cmd, ...rest);
    
    if (Array.isArray(result)) {
      // Pretty print arrays
      function printArr(arr, indent) {
        if (!Array.isArray(arr)) { console.log(' '.repeat(indent) + (arr === null ? '(nil)' : arr)); return; }
        arr.forEach((item, i) => {
          if (Array.isArray(item)) { console.log(' '.repeat(indent) + (i+1) + ')'); printArr(item, indent+3); }
          else console.log(' '.repeat(indent) + (i+1) + ') ' + (item === null ? '(nil)' : item));
        });
      }
      printArr(result, 0);
    } else {
      console.log(result === null ? '(nil)' : result);
    }
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    client.disconnect();
  }
}
run();
