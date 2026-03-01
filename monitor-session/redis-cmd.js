#!/usr/bin/env node
// Advanced Redis helper for multi-command and SCAN operations
// Usage: node redis-cmd.js <operation> [args...]
// Operations: scan, xinfo-stream, xinfo-groups, xlen, xpending, info, keys-type, multi-cmd

const net = require('net');

const operation = process.argv[2];
const args = process.argv.slice(3);

function buildResp(parts) {
  let resp = `*${parts.length}\r\n`;
  for (const part of parts) {
    resp += `$${Buffer.byteLength(String(part))}\r\n${part}\r\n`;
  }
  return resp;
}

function sendCommand(cmdParts) {
  return new Promise((resolve, reject) => {
    const client = net.connect(6379, '127.0.0.1');
    let data = Buffer.alloc(0);

    client.on('connect', () => {
      client.write(buildResp(cmdParts));
    });

    client.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
    });

    // Give time for full response
    client.setTimeout(500);
    client.on('timeout', () => {
      resolve(data.toString());
      client.end();
    });

    client.on('error', reject);
    client.on('end', () => resolve(data.toString()));
  });
}

function parseRespFull(raw) {
  const lines = raw.split('\r\n');
  return parseAt(lines, 0);
}

function parseAt(lines, idx) {
  if (idx >= lines.length) return { val: null, next: idx };
  const line = lines[idx];

  if (line.startsWith('+')) return { val: line.slice(1), next: idx + 1 };
  if (line.startsWith('-')) return { val: 'ERR:' + line.slice(1), next: idx + 1 };
  if (line.startsWith(':')) return { val: parseInt(line.slice(1)), next: idx + 1 };
  if (line.startsWith('$')) {
    const len = parseInt(line.slice(1));
    if (len === -1) return { val: null, next: idx + 1 };
    return { val: lines[idx + 1], next: idx + 2 };
  }
  if (line.startsWith('*')) {
    const count = parseInt(line.slice(1));
    if (count <= 0) return { val: [], next: idx + 1 };
    let arr = [];
    let cur = idx + 1;
    for (let i = 0; i < count; i++) {
      const r = parseAt(lines, cur);
      arr.push(r.val);
      cur = r.next;
    }
    return { val: arr, next: cur };
  }
  return { val: line, next: idx + 1 };
}

async function scanAllKeys() {
  let cursor = '0';
  let allKeys = [];
  do {
    const raw = await sendCommand(['SCAN', cursor, 'COUNT', '100']);
    const parsed = parseRespFull(raw);
    if (parsed.val && Array.isArray(parsed.val)) {
      cursor = String(parsed.val[0]);
      if (Array.isArray(parsed.val[1])) {
        allKeys = allKeys.concat(parsed.val[1]);
      }
    } else {
      break;
    }
  } while (cursor !== '0');
  return allKeys;
}

async function getKeyType(key) {
  const raw = await sendCommand(['TYPE', key]);
  const parsed = parseRespFull(raw);
  return parsed.val;
}

async function main() {
  try {
    switch (operation) {
      case 'discover-streams': {
        const keys = await scanAllKeys();
        const streams = [];
        for (const key of keys) {
          const type = await getKeyType(key);
          if (type === 'stream') {
            streams.push(key);
          }
        }
        console.log(JSON.stringify(streams, null, 2));
        break;
      }

      case 'all-keys-typed': {
        const keys = await scanAllKeys();
        const result = {};
        for (const key of keys) {
          const type = await getKeyType(key);
          if (!result[type]) result[type] = [];
          result[type].push(key);
        }
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'stream-info': {
        const stream = args[0];
        const raw = await sendCommand(['XINFO', 'STREAM', stream]);
        const parsed = parseRespFull(raw);
        console.log(JSON.stringify(parsed.val, null, 2));
        break;
      }

      case 'stream-groups': {
        const stream = args[0];
        const raw = await sendCommand(['XINFO', 'GROUPS', stream]);
        const parsed = parseRespFull(raw);
        console.log(JSON.stringify(parsed.val, null, 2));
        break;
      }

      case 'xlen': {
        const stream = args[0];
        const raw = await sendCommand(['XLEN', stream]);
        const parsed = parseRespFull(raw);
        console.log(parsed.val);
        break;
      }

      case 'xpending': {
        const stream = args[0];
        const group = args[1];
        const raw = await sendCommand(['XPENDING', stream, group, '-', '+', '50']);
        const parsed = parseRespFull(raw);
        console.log(JSON.stringify(parsed.val, null, 2));
        break;
      }

      case 'info': {
        const section = args[0] || 'all';
        const raw = await sendCommand(['INFO', section]);
        const parsed = parseRespFull(raw);
        console.log(parsed.val);
        break;
      }

      case 'baseline': {
        // Full baseline: discover streams, get info+groups+len for each, plus memory stats
        const keys = await scanAllKeys();
        const streams = [];
        for (const key of keys) {
          const type = await getKeyType(key);
          if (type === 'stream') streams.push(key);
        }

        const baseline = { timestamp: new Date().toISOString(), streams: {}, keyCount: keys.length, allKeys: {} };

        // Categorize all keys
        for (const key of keys) {
          const type = await getKeyType(key);
          if (!baseline.allKeys[type]) baseline.allKeys[type] = [];
          baseline.allKeys[type].push(key);
        }

        for (const stream of streams) {
          const infoRaw = await sendCommand(['XINFO', 'STREAM', stream]);
          const groupsRaw = await sendCommand(['XINFO', 'GROUPS', stream]);
          const lenRaw = await sendCommand(['XLEN', stream]);

          baseline.streams[stream] = {
            info: parseRespFull(infoRaw).val,
            groups: parseRespFull(groupsRaw).val,
            length: parseRespFull(lenRaw).val
          };
        }

        // Memory info
        const memRaw = await sendCommand(['INFO', 'memory']);
        baseline.memory = parseRespFull(memRaw).val;

        const statsRaw = await sendCommand(['INFO', 'stats']);
        baseline.stats = parseRespFull(statsRaw).val;

        console.log(JSON.stringify(baseline, null, 2));
        break;
      }

      case 'poll-streams': {
        // Poll all streams: xlen + groups + pending for each
        const streamsFile = args[0]; // path to discovered_streams.json
        const fs = require('fs');
        const streamsList = JSON.parse(fs.readFileSync(streamsFile, 'utf8'));

        const poll = { timestamp: new Date().toISOString(), streams: {} };

        for (const stream of streamsList) {
          const lenRaw = await sendCommand(['XLEN', stream]);
          const groupsRaw = await sendCommand(['XINFO', 'GROUPS', stream]);
          const groupsParsed = parseRespFull(groupsRaw).val;

          const streamData = {
            length: parseRespFull(lenRaw).val,
            groups: groupsParsed,
            pending: {}
          };

          // Get pending for each group
          if (Array.isArray(groupsParsed)) {
            for (let i = 0; i < groupsParsed.length; i += 2) {
              if (groupsParsed[i] === 'name' || (Array.isArray(groupsParsed[i]) && groupsParsed[i].includes('name'))) {
                // Try to extract group name
              }
            }
          }

          poll.streams[stream] = streamData;
        }

        console.log(JSON.stringify(poll, null, 2));
        break;
      }

      case 'client-list': {
        const raw = await sendCommand(['CLIENT', 'LIST']);
        const parsed = parseRespFull(raw);
        console.log(parsed.val);
        break;
      }

      case 'ping': {
        const raw = await sendCommand(['PING']);
        const parsed = parseRespFull(raw);
        console.log(parsed.val);
        break;
      }

      case 'command-info': {
        // Check if stream commands are available
        const cmds = ['XADD', 'XREAD', 'XREADGROUP', 'XPENDING', 'XINFO', 'XACK', 'XLEN', 'XCLAIM'];
        for (const cmd of cmds) {
          const raw = await sendCommand(['COMMAND', 'INFO', cmd]);
          const parsed = parseRespFull(raw);
          const available = parsed.val && !String(parsed.val).includes('ERR');
          console.log(`${cmd}: ${available ? 'OK' : 'MISSING'}`);
        }
        break;
      }

      default:
        console.error(`Unknown operation: ${operation}`);
        console.error('Available: discover-streams, all-keys-typed, stream-info, stream-groups, xlen, xpending, info, baseline, poll-streams, client-list, ping, command-info');
        process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }

  // Force exit after commands complete
  setTimeout(() => process.exit(0), 600);
}

main();
