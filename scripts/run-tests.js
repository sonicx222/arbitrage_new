#!/usr/bin/env node
/**
 * Sequential Test Runner
 *
 * Runs unit tests first, then always runs integration tests regardless of
 * whether unit tests had failures. Returns a combined exit code so CI will
 * fail if EITHER phase fails.
 *
 * Why this exists:
 *   On Windows, Jest workers occasionally exit with exitCode=0 (a clean exit
 *   that Jest treats as an unexpected crash) due to OS memory management.
 *   This happens to a random test file each run and is unrelated to test logic.
 *   Using `&&` in the npm test script caused integration tests to be skipped
 *   whenever this intermittent crash occurred, hiding real integration failures.
 *
 * Usage:
 *   node scripts/run-tests.js
 *   npm test
 */
'use strict';

const { spawnSync } = require('child_process');

function runPhase(name, args) {
  console.log(`\n${'='.repeat(68)}`);
  console.log(`  ${name.toUpperCase()} TESTS`);
  console.log('='.repeat(68));
  const result = spawnSync('npx', ['jest', ...args], {
    stdio: 'inherit',
    shell: true,
  });
  const code = result.status ?? 1;
  console.log(`\n--- ${name} tests finished (exit code: ${code}) ---`);
  return code;
}

const unitCode = runPhase('unit', ['--selectProjects', 'unit']);
const intCode  = runPhase('integration', ['--selectProjects', 'integration', '--maxWorkers=1']);

// Exit non-zero if either phase failed
const combined = (unitCode !== 0 || intCode !== 0) ? 1 : 0;
process.exit(combined);
