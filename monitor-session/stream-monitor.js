const net = require('net');
const fs = require('fs');
const path = require('path');

const STREAMS = [
  'stream:pending-opportunities',
  'stream:system-failover',
  'stream:opportunities',
  'stream:swap-events',
  'stream:service-degradation',
  'stream:dead-letter-queue',
  'stream:whale-alerts',
  'stream:price-updates',
  'stream:execution-results',
  'stream:health',
  'stream:volume-aggregates',
  'stream:execution-requests'
];

const POLL_INTERVAL = 30000; // 30 seconds
const SNAPSHOT_INTERVAL = 60000; // 60 seconds
const MAX_RUNTIME = 8 * 60 * 1000; // 8 minutes
const FINDINGS_FILE = path.join(__dirname, 'findings', 'stream-analyst.jsonl');
const TOPOLOGY_FILE = path.join(__dirname, 'streams', 'topology_current.txt');
const STOP_FILE = path.join(__dirname, 'STOP');

let pollHistory = [];
let findingCounter = 1;
let lastSnapshotTime = Date.now();

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

async function getStreamLength(streamName) {
  try {
    const raw = await sendCommand(['XLEN', streamName]);
    const parsed = parseRespFull(raw);
    return parsed.val;
  } catch (err) {
    console.error(`Failed to get length for ${streamName}:`, err.message);
    return null;
  }
}

async function getStreamGroups(streamName) {
  try {
    const raw = await sendCommand(['XINFO', 'GROUPS', streamName]);
    const parsed = parseRespFull(raw);
    return parsed.val;
  } catch (err) {
    console.error(`Failed to get groups for ${streamName}:`, err.message);
    return [];
  }
}

async function getGroupPending(streamName, groupName) {
  try {
    const raw = await sendCommand(['XPENDING', streamName, groupName, '-', '+', '50']);
    const parsed = parseRespFull(raw);
    return parsed.val;
  } catch (err) {
    console.error(`Failed to get pending for ${streamName}/${groupName}:`, err.message);
    return null;
  }
}

function writeFinding(finding) {
  const jsonLine = JSON.stringify(finding) + '\n';
  fs.appendFileSync(FINDINGS_FILE, jsonLine);
  console.log(`[FINDING] ${finding.category} - ${finding.severity} - ${finding.stream || 'N/A'}`);
}

async function pollStream(streamName) {
  const xlen = await getStreamLength(streamName);
  const groupsRaw = await getStreamGroups(streamName);

  const streamData = {
    stream: streamName,
    timestamp: new Date().toISOString(),
    xlen: xlen,
    groups: []
  };

  if (groupsRaw && Array.isArray(groupsRaw)) {
    // Parse groups array format: [[name, value, name, value, ...], [...]]
    for (const groupArray of groupsRaw) {
      if (!Array.isArray(groupArray)) continue;

      const groupInfo = {};
      for (let i = 0; i < groupArray.length; i += 2) {
        const key = groupArray[i];
        const value = groupArray[i + 1];
        groupInfo[key] = value;
      }

      streamData.groups.push(groupInfo);
    }
  }

  return streamData;
}

async function analyzeStreamData(currentPoll, previousPoll) {
  const findings = [];

  for (const streamData of currentPoll) {
    const streamName = streamData.stream;
    const xlen = streamData.xlen;
    const groups = streamData.groups;

    // Find previous data for this stream
    const previousStreamData = previousPoll ? previousPoll.find(s => s.stream === streamName) : null;

    // Check for no consumer groups
    if (!groups || groups.length === 0) {
      if (xlen > 0) {
        findings.push({
          agentId: 'REDIS_STREAM_ANALYST',
          findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
          category: 'NO_CONSUMER_GROUP',
          severity: 'MEDIUM',
          stream: streamName,
          timestamp: streamData.timestamp,
          metrics: { streamLen: xlen, pendingCount: 0, consumerLagMessages: 0 },
          evidence: `Stream has ${xlen} messages but no consumer groups`,
          hypothesis: 'Stream is producing data but no service is consuming it',
          recommendation: 'Create consumer group or investigate why consumers are not attached'
        });
      }
      continue;
    }

    // Check for unbounded streams (no MAXLEN cap)
    if (xlen > 50000) {
      findings.push({
        agentId: 'REDIS_STREAM_ANALYST',
        findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
        category: 'UNBOUNDED_STREAM',
        severity: 'MEDIUM',
        stream: streamName,
        timestamp: streamData.timestamp,
        metrics: { streamLen: xlen, pendingCount: 0, consumerLagMessages: 0 },
        evidence: `Stream length is ${xlen} messages, indicating no MAXLEN cap`,
        hypothesis: 'Stream may grow unbounded and consume excessive memory',
        recommendation: 'Configure MAXLEN ~ 10000 with XADD or use XTRIM'
      });
    }

    // Check for stream growth
    if (previousStreamData && previousStreamData.xlen !== null && xlen !== null && previousStreamData.xlen < xlen) {
      const growth = xlen - previousStreamData.xlen;
      if (growth > 100) {
        findings.push({
          agentId: 'REDIS_STREAM_ANALYST',
          findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
          category: 'STREAM_GROWING',
          severity: 'HIGH',
          stream: streamName,
          timestamp: streamData.timestamp,
          metrics: { streamLen: xlen, pendingCount: 0, consumerLagMessages: growth },
          evidence: `Stream grew from ${previousStreamData.xlen} to ${xlen} (+${growth} messages)`,
          hypothesis: 'Stream is accumulating messages faster than consumers can process',
          recommendation: 'Scale consumers or investigate processing bottleneck'
        });
      }
    }

    // Analyze each consumer group
    for (const group of groups) {
      const groupName = group.name;
      const consumers = group.consumers;
      const pending = group.pending;
      const lag = group.lag;

      // Check for dead consumers
      if (consumers === 0) {
        findings.push({
          agentId: 'REDIS_STREAM_ANALYST',
          findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
          category: 'DEAD_CONSUMER',
          severity: 'CRITICAL',
          stream: streamName,
          consumerGroup: groupName,
          timestamp: streamData.timestamp,
          metrics: { streamLen: xlen, pendingCount: pending, consumerLagMessages: lag ?? 0 },
          evidence: `Consumer group "${groupName}" has 0 active consumers, ${pending} pending messages`,
          hypothesis: 'All consumers in group have disconnected or crashed',
          recommendation: 'Restart consumers or transfer messages to active group'
        });
      }

      // Check for high consumer lag
      if (lag !== null && lag > 100) {
        findings.push({
          agentId: 'REDIS_STREAM_ANALYST',
          findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
          category: 'CONSUMER_LAG',
          severity: 'CRITICAL',
          stream: streamName,
          consumerGroup: groupName,
          timestamp: streamData.timestamp,
          metrics: { streamLen: xlen, pendingCount: pending, consumerLagMessages: lag },
          evidence: `Consumer group "${groupName}" has lag of ${lag} messages`,
          hypothesis: 'Consumers are falling behind on message processing',
          recommendation: 'Scale consumers or optimize processing logic'
        });
      }

      // Check for pending messages without consumer lag growth
      if (pending > 10) {
        const previousGroup = previousStreamData?.groups.find(g => g.name === groupName);
        if (previousGroup && previousGroup.pending <= pending) {
          findings.push({
            agentId: 'REDIS_STREAM_ANALYST',
            findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
            category: 'MISSING_ACK',
            severity: 'HIGH',
            stream: streamName,
            consumerGroup: groupName,
            timestamp: streamData.timestamp,
            metrics: { streamLen: xlen, pendingCount: pending, consumerLagMessages: lag ?? 0 },
            evidence: `Consumer group "${groupName}" has ${pending} pending messages (previous: ${previousGroup.pending})`,
            hypothesis: 'Consumers are processing messages but not ACKing them',
            recommendation: 'Check consumer code for missing XACK calls or processing failures'
          });
        }
      }

      // Check for stuck messages (requires XPENDING detail)
      if (pending > 0 && pending < 100) {
        const pendingDetails = await getGroupPending(streamName, groupName);
        if (pendingDetails && Array.isArray(pendingDetails)) {
          for (const msgDetail of pendingDetails) {
            if (!Array.isArray(msgDetail) || msgDetail.length < 4) continue;

            const messageId = msgDetail[0];
            const consumerName = msgDetail[1];
            const idleTime = msgDetail[2];
            const deliveryCount = msgDetail[3];

            // Check for high delivery count
            if (deliveryCount > 3) {
              findings.push({
                agentId: 'REDIS_STREAM_ANALYST',
                findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
                category: 'DELIVERY_FAILURE',
                severity: 'HIGH',
                stream: streamName,
                consumerGroup: groupName,
                timestamp: streamData.timestamp,
                metrics: { streamLen: xlen, pendingCount: 1, consumerLagMessages: lag ?? 0 },
                evidence: `Message ${messageId} has delivery-count ${deliveryCount} in consumer "${consumerName}"`,
                hypothesis: 'Consumer is repeatedly failing to process specific message',
                recommendation: 'Move message to dead-letter queue and investigate processing logic'
              });
            }

            // Check for stuck messages (idle > 30 seconds)
            if (idleTime > 30000) {
              findings.push({
                agentId: 'REDIS_STREAM_ANALYST',
                findingId: `RSA-${String(findingCounter++).padStart(3, '0')}`,
                category: 'STUCK_MESSAGE',
                severity: 'HIGH',
                stream: streamName,
                consumerGroup: groupName,
                timestamp: streamData.timestamp,
                metrics: { streamLen: xlen, pendingCount: 1, consumerLagMessages: lag ?? 0 },
                evidence: `Message ${messageId} has been idle for ${idleTime}ms in consumer "${consumerName}"`,
                hypothesis: 'Consumer claimed message but is not processing it',
                recommendation: 'Use XCLAIM to reassign message or investigate consumer health'
              });
            }
          }
        }
      }
    }
  }

  return findings;
}

function writeTopologySnapshot(pollData) {
  let output = `=== REDIS STREAM TOPOLOGY SNAPSHOT ===\n`;
  output += `Timestamp: ${new Date().toISOString()}\n\n`;

  for (const streamData of pollData) {
    output += `STREAM: ${streamData.stream}\n`;
    output += `  Length: ${streamData.xlen ?? 'N/A'} messages\n`;

    if (streamData.groups.length === 0) {
      output += `  Consumer Groups: NONE\n`;
    } else {
      output += `  Consumer Groups:\n`;
      for (const group of streamData.groups) {
        output += `    - ${group.name}\n`;
        output += `      Consumers: ${group.consumers}\n`;
        output += `      Pending: ${group.pending}\n`;
        output += `      Lag: ${group.lag ?? 'N/A'}\n`;
        output += `      Last Delivered: ${group['last-delivered-id']}\n`;
      }
    }
    output += `\n`;
  }

  fs.writeFileSync(TOPOLOGY_FILE, output);
  console.log(`[SNAPSHOT] Topology written to ${TOPOLOGY_FILE}`);
}

async function monitorLoop() {
  const startTime = Date.now();
  let pollCount = 0;

  console.log('=== REDIS STREAM MONITORING STARTED ===');
  console.log(`Monitoring ${STREAMS.length} streams`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`Max runtime: ${MAX_RUNTIME}ms (~${MAX_RUNTIME / 60000} minutes)`);
  console.log();

  while (true) {
    // Check for stop signal
    if (fs.existsSync(STOP_FILE)) {
      console.log('[STOP] Stop signal detected, exiting...');
      break;
    }

    // Check runtime
    const elapsed = Date.now() - startTime;
    if (elapsed > MAX_RUNTIME) {
      console.log('[TIMEOUT] Max runtime reached, exiting...');
      break;
    }

    console.log(`\n[POLL ${++pollCount}] ${new Date().toISOString()}`);

    // Poll all streams
    const currentPoll = [];
    for (const streamName of STREAMS) {
      const streamData = await pollStream(streamName);
      currentPoll.push(streamData);
      console.log(`  ${streamName}: xlen=${streamData.xlen}, groups=${streamData.groups.length}`);
    }

    // Analyze for anomalies
    const previousPoll = pollHistory.length > 0 ? pollHistory[pollHistory.length - 1] : null;
    const findings = await analyzeStreamData(currentPoll, previousPoll);

    // Write findings
    for (const finding of findings) {
      writeFinding(finding);
    }

    if (findings.length === 0) {
      console.log('  No anomalies detected');
    }

    // Store poll data
    pollHistory.push(currentPoll);
    if (pollHistory.length > 20) {
      pollHistory.shift(); // Keep last 20 polls only
    }

    // Write topology snapshot every 60 seconds
    const timeSinceSnapshot = Date.now() - lastSnapshotTime;
    if (timeSinceSnapshot >= SNAPSHOT_INTERVAL) {
      writeTopologySnapshot(currentPoll);
      lastSnapshotTime = Date.now();
    }

    // Wait for next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }

  // Final snapshot
  if (pollHistory.length > 0) {
    writeTopologySnapshot(pollHistory[pollHistory.length - 1]);
  }

  console.log('\n=== MONITORING COMPLETE ===');
  console.log(`Total polls: ${pollCount}`);
  console.log(`Total findings: ${findingCounter - 1}`);
  console.log(`Findings file: ${FINDINGS_FILE}`);
  console.log(`Topology file: ${TOPOLOGY_FILE}`);
}

// Run the monitor
monitorLoop().catch(err => {
  console.error('Monitor crashed:', err);
  process.exit(1);
});
