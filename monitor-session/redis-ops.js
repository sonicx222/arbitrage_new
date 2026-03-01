const { createClient } = require('redis');
const fs = require('fs');

async function main() {
  const op = process.argv[2];
  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  
  try {
    switch(op) {
      case 'ping':
        console.log(await client.ping());
        break;
      case 'scan-streams': {
        const keys = [];
        for await (const key of client.scanIterator({ MATCH: 'stream:*', COUNT: 100 })) keys.push(key);
        keys.sort();
        for (const k of keys) console.log(k);
        break;
      }
      case 'xlen': {
        const stream = process.argv[3];
        console.log(await client.xLen(stream));
        break;
      }
      case 'xinfo-stream': {
        const stream = process.argv[3];
        try {
          const info = await client.xInfoStream(stream);
          console.log(JSON.stringify(info, null, 2));
        } catch(e) { console.log('ERROR:', e.message); }
        break;
      }
      case 'xinfo-groups': {
        const stream = process.argv[3];
        try {
          const groups = await client.xInfoGroups(stream);
          console.log(JSON.stringify(groups, null, 2));
        } catch(e) { console.log('ERROR:', e.message); }
        break;
      }
      case 'xpending': {
        const stream = process.argv[3];
        const group = process.argv[4];
        try {
          const pending = await client.xPending(stream, group);
          console.log(JSON.stringify(pending, null, 2));
        } catch(e) { console.log('ERROR:', e.message); }
        break;
      }
      case 'xrevrange': {
        const stream = process.argv[3];
        const count = parseInt(process.argv[4]) || 5;
        try {
          const msgs = await client.xRevRange(stream, '+', '-', { COUNT: count });
          console.log(JSON.stringify(msgs, null, 2));
        } catch(e) { console.log('ERROR:', e.message); }
        break;
      }
      case 'get': {
        const key = process.argv[3];
        const val = await client.get(key);
        console.log(val ?? '(nil)');
        break;
      }
      case 'ttl': {
        const key = process.argv[3];
        console.log(await client.ttl(key));
        break;
      }
      case 'info-memory': {
        const info = await client.info('memory');
        console.log(info);
        break;
      }
      case 'stream-audit': {
        const expected = [
          'stream:price-updates','stream:swap-events','stream:opportunities',
          'stream:whale-alerts','stream:service-health','stream:service-events',
          'stream:coordinator-events','stream:health','stream:health-alerts',
          'stream:execution-requests','stream:execution-results',
          'stream:pending-opportunities','stream:volume-aggregates',
          'stream:circuit-breaker','stream:system-failover','stream:system-commands',
          'stream:fast-lane','stream:dead-letter-queue','stream:forwarding-dlq'
        ];
        const discovered = [];
        for await (const key of client.scanIterator({ MATCH: 'stream:*', COUNT: 100 })) discovered.push(key);
        discovered.sort();
        
        const result = { discovered: [], missing: [], unexpected: [], details: {} };
        result.discovered = discovered;
        result.missing = expected.filter(s => !discovered.includes(s));
        result.unexpected = discovered.filter(s => !expected.includes(s));
        
        for (const s of discovered) {
          try {
            const info = await client.xInfoStream(s);
            let groups = [];
            try { groups = await client.xInfoGroups(s); } catch(e) {}
            result.details[s] = { length: info.length, groups: groups.map(g => ({ name: g.name, consumers: g.consumers, pending: g.pending, lastDeliveredId: g.lastDeliveredId })) };
          } catch(e) { result.details[s] = { error: e.message }; }
        }
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'multi-xlen': {
        const streams = process.argv.slice(3);
        for (const s of streams) {
          try { console.log(`${s}: ${await client.xLen(s)}`); }
          catch(e) { console.log(`${s}: ERROR ${e.message}`); }
        }
        break;
      }
      default:
        console.error('Unknown operation:', op);
    }
  } finally {
    await client.quit();
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
