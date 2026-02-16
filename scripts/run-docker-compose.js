#!/usr/bin/env node
/**
 * Cross-platform Docker Compose runner.
 *
 * Tries:
 *  1) docker compose ...
 *  2) docker-compose ...
 *
 * This avoids hard-coding one binary name across macOS/Windows/Linux environments.
 *
 * Usage:
 *   node scripts/run-docker-compose.js -f docker-compose.local.yml up -d redis
 */

const { spawnSync } = require('child_process');
const { ROOT_DIR } = require('./lib/utils');

/**
 * Execute a command and capture output.
 * @param {string} command
 * @param {string[]} args
 * @returns {{status: number|null, error?: NodeJS.ErrnoException, stdout: string, stderr: string}}
 */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8'
  });

  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

/**
 * Write buffered command output to current process stdio.
 * @param {{stdout: string, stderr: string}} output
 */
function printOutput(output) {
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/run-docker-compose.js <compose args>');
    process.exit(1);
  }

  // Prefer modern "docker compose" first.
  const first = run('docker', ['compose', ...args]);

  if (!first.error && first.status === 0) {
    printOutput(first);
    process.exit(0);
  }

  // If docker exists but compose plugin is unavailable, fall back to docker-compose.
  const firstOutput = `${first.stdout}\n${first.stderr}`.trim();
  const shouldFallback =
    (first.error && first.error.code === 'ENOENT') ||
    /is not a docker command|unknown command.*compose|docker: 'compose'/i.test(firstOutput);

  if (shouldFallback) {
    const second = run('docker-compose', args);

    if (!second.error && second.status === 0) {
      printOutput(second);
      process.exit(0);
    }

    if (second.error && second.error.code === 'ENOENT') {
      console.error('Neither "docker compose" nor "docker-compose" is available on PATH.');
      process.exit(1);
    }

    printOutput(second);
    process.exit(second.status ?? 1);
  }

  // docker compose ran but failed for a real reason (daemon unavailable, invalid args, etc.).
  printOutput(first);
  process.exit(first.status ?? 1);
}

main();
