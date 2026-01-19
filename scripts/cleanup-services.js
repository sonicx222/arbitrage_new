#!/usr/bin/env node
/**
 * Cleanup ALL local services ghost processes and stale config files.
 * Covers Redis, Coordinator, and all Detector services.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const REDIS_CONFIG_FILE = path.join(ROOT_DIR, '.redis-memory-config.json');

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

const SERVICES = [
    { name: 'Redis', port: 6379 },
    { name: 'Coordinator', port: 3000 },
    { name: 'P1 Asia-Fast', port: 3001 },
    { name: 'P2 L2-Turbo', port: 3002 },
    { name: 'P3 High-Value', port: 3003 },
    { name: 'Cross-Chain Detector', port: 3004 },
    { name: 'Execution Engine', port: 3005 },
    { name: 'Redis Commander', port: 8081 }
];

async function cleanup() {
    log('\n' + '='.repeat(60), 'cyan');
    log('  Local Services Cleanup Utility', 'cyan');
    log('='.repeat(60) + '\n', 'cyan');

    // 1. Cleanup Redis specifically (config file + process)
    log('--- Cleaning up Redis ---', 'yellow');
    if (fs.existsSync(REDIS_CONFIG_FILE)) {
        try {
            const config = JSON.parse(fs.readFileSync(REDIS_CONFIG_FILE, 'utf8'));
            log(`Found stale Redis config for PID ${config.pid}`, 'dim');
            try {
                process.kill(config.pid, 0);
                log(`Killing Redis process ${config.pid}...`, 'dim');
                process.kill(config.pid, 'SIGKILL');
            } catch (e) { }
            fs.unlinkSync(REDIS_CONFIG_FILE);
            log('Deleted Redis config file.', 'green');
        } catch (e) { }
    }

    // 2. Kill any node/redis processes by port
    log('\n--- Cleaning up ports ---', 'yellow');
    for (const svc of SERVICES) {
        try {
            const portCheck = execSync(`lsof -t -i :${svc.port} || true`).toString().trim();
            if (portCheck) {
                const pids = portCheck.split('\n');
                log(`${svc.name} (port ${svc.port}) is occupied by PIDs: ${pids.join(', ')}`, 'yellow');
                for (const pid of pids) {
                    try {
                        log(`  Killing PID ${pid}...`, 'dim');
                        process.kill(parseInt(pid), 'SIGKILL');
                    } catch (e) {
                        log(`  Failed to kill PID ${pid}: ${e.message}`, 'red');
                    }
                }
                log(`  Port ${svc.port} released.`, 'green');
            } else {
                log(`${svc.name} (port ${svc.port}) is already free.`, 'dim');
            }
        } catch (e) {
            log(`Error checking port ${svc.port}: ${e.message}`, 'red');
        }
    }

    // 3. Cleanup any other ghost node processes related to the project
    log('\n--- Cleaning up ghost node processes ---', 'yellow');
    try {
        const psOutput = execSync('ps aux | grep -E "ts-node|services/.*/src/index.ts" | grep -v grep || true').toString().trim();
        if (psOutput) {
            const lines = psOutput.split('\n');
            log(`Found ${lines.length} other potential ghost processes.`, 'yellow');
            for (const line of lines) {
                const parts = line.split(/\s+/);
                const pid = parts[1];
                const cmd = parts.slice(10).join(' ');
                log(`  Killing ghost process ${pid}: ${cmd.substring(0, 60)}...`, 'dim');
                try {
                    process.kill(parseInt(pid), 'SIGKILL');
                } catch (e) { }
            }
        } else {
            log('No other ghost node processes found.', 'green');
        }
    } catch (e) { }

    log('\nCleanup complete! Your local environment is now clean.', 'cyan');
    log('You can now start services using:', 'cyan');
    log('  npm run dev:start         # Start all services', 'dim');
    log('  npm run dev:coordinator   # Start only coordinator', 'dim');
    log('  npm run dev:redis:memory  # Start only Redis', 'dim');
    console.log();
}

cleanup();
