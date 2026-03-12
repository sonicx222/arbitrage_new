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

// Single Jest invocation for both unit + integration projects.
// Jest runs them in the same process, sharing the global setup (Redis server)
// and avoiding the ~6s overhead of a second process + Redis startup.
const result = spawnSync('npx', [
  'jest',
  '--selectProjects', 'unit', 'integration',
  '--maxWorkers=50%',
  '--workerThreads',
], {
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
