#!/usr/bin/env node
// Minimal redis-cli replacement for monitoring
const net = require('net');
const args = process.argv.slice(2);
if (args.length === 0) { console.error('Usage: node redis-cli.js <command>'); process.exit(1); }

// Handle --scan --pattern specially
if (args[0] === '--scan' && args[1] === '--pattern') {
  const pattern = args[2] || '*';
  const c = net.createConnection(6379, '127.0.0.1');
  let buf = '';
  const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp('^' + regexPattern + '$');

  function doScan(cursor) {
    c.write(`SCAN ${cursor} MATCH ${pattern} COUNT 1000\r\n`);
  }

  c.on('connect', () => doScan(0));
  c.on('data', d => {
    buf += d.toString();
    // Parse RESP array response
    const lines = buf.split('\r\n');
    if (lines.length >= 4 && lines[0].startsWith('*2')) {
      // cursor is lines[1] (after $N), actual cursor value at lines[2]
      const cursor = lines[2];
      // Parse the array of keys
      const countMatch = lines[3];
      if (countMatch && countMatch.startsWith('*')) {
        const count = parseInt(countMatch.substring(1));
        const keys = [];
        let idx = 4;
        for (let i = 0; i < count && idx + 1 < lines.length; i++) {
          idx++; // skip $N
          if (idx < lines.length) keys.push(lines[idx]);
          idx++;
        }
        keys.forEach(k => { if (k) console.log(k); });
        buf = '';
        if (cursor === '0') {
          c.end();
        } else {
          doScan(cursor);
        }
      }
    }
  });
  c.on('error', e => { console.error('ERR:', e.message); process.exit(1); });
  c.on('end', () => process.exit(0));
  setTimeout(() => process.exit(0), 10000);
} else {
  // Regular command
  const cmd = args.map(a => `$${Buffer.byteLength(a)}\r\n${a}`).join('\r\n');
  const resp = `*${args.length}\r\n${cmd}\r\n`;

  const c = net.createConnection(6379, '127.0.0.1');
  let buf = '';
  c.on('connect', () => c.write(resp));
  c.on('data', d => {
    buf += d.toString();
    // Simple heuristic: if we got a complete response, print and close
    process.stdout.write(d.toString());
  });
  c.on('error', e => { console.error('ERR:', e.message); process.exit(1); });
  // Give time for response then close
  setTimeout(() => { c.end(); process.exit(0); }, 3000);
}
