#!/usr/bin/env node
// Redis CLI helper - sends raw Redis commands via Node.js
// Usage: node redis-helper.js COMMAND [args...]
const net = require('net');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node redis-helper.js COMMAND [args...]');
  process.exit(1);
}

// Build RESP protocol
function buildResp(parts) {
  let resp = `*${parts.length}\r\n`;
  for (const part of parts) {
    resp += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
  }
  return resp;
}

const client = net.connect(6379, '127.0.0.1');
let data = '';

client.on('connect', () => {
  client.write(buildResp(args));
});

client.on('data', (chunk) => {
  data += chunk.toString();
  // Simple heuristic: wait for complete response
  setTimeout(() => {
    process.stdout.write(parseResp(data));
    client.end();
  }, 100);
});

client.on('error', (e) => {
  console.error('Redis error:', e.message);
  process.exit(1);
});

client.on('end', () => {
  process.exit(0);
});

function parseResp(raw) {
  const lines = raw.split('\r\n');
  return parseLines(lines, 0).value + '\n';
}

function parseLines(lines, idx) {
  if (idx >= lines.length) return { value: '', next: idx };
  const line = lines[idx];

  if (line.startsWith('+')) {
    return { value: line.slice(1), next: idx + 1 };
  }
  if (line.startsWith('-')) {
    return { value: 'ERROR: ' + line.slice(1), next: idx + 1 };
  }
  if (line.startsWith(':')) {
    return { value: line.slice(1), next: idx + 1 };
  }
  if (line.startsWith('$')) {
    const len = parseInt(line.slice(1));
    if (len === -1) return { value: '(nil)', next: idx + 1 };
    return { value: lines[idx + 1] || '', next: idx + 2 };
  }
  if (line.startsWith('*')) {
    const count = parseInt(line.slice(1));
    if (count === -1) return { value: '(empty array)', next: idx + 1 };
    let result = [];
    let cur = idx + 1;
    for (let i = 0; i < count; i++) {
      const parsed = parseLines(lines, cur);
      result.push(parsed.value);
      cur = parsed.next;
    }
    return { value: result.join('\n'), next: cur };
  }
  return { value: line, next: idx + 1 };
}
