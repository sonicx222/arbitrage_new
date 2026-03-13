#!/usr/bin/env node
/**
 * Clean runtime artifacts (logs, coverage, data, monitor sessions, etc.)
 *
 * Usage:
 *   npm run clean:artifacts           # Remove all runtime artifacts
 *   npm run clean:artifacts -- --dry-run  # Preview what would be removed
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const TARGETS = [
  'logs',
  'coverage',
  'data',
  'test-results',
  'models',
  'monitor-session',
  '.agent-reports',
  '.worktrees',
  // Per-service runtime dirs
  'services/coordinator/logs',
  'services/coordinator/data',
  'services/cross-chain-detector/logs',
  'services/execution-engine/logs',
  'services/execution-engine/coverage',
  'services/mempool-detector/logs',
  'services/partition-solana/logs',
  'services/unified-detector/logs',
];

let totalRemoved = 0;
let totalBytes = 0;

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else {
        try { size += fs.statSync(fullPath).size; } catch { /* stat may fail on broken symlinks */ }
      }
    }
  } catch { /* dir may not exist or be unreadable */ }
  return size;
}

function removeDir(dirPath) {
  const abs = path.resolve(ROOT, dirPath);
  if (!fs.existsSync(abs)) return;

  const size = getDirSize(abs);
  const sizeMB = (size / 1024 / 1024).toFixed(1);

  if (dryRun) {
    console.log(`  [dry-run] Would remove: ${dirPath} (${sizeMB} MB)`);
  } else {
    fs.rmSync(abs, { recursive: true, force: true });
    console.log(`  Removed: ${dirPath} (${sizeMB} MB)`);
  }
  totalRemoved++;
  totalBytes += size;
}

console.log(dryRun ? 'Dry run — no files will be removed:\n' : 'Cleaning runtime artifacts:\n');

for (const target of TARGETS) {
  removeDir(target);
}

const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
console.log(`\n${dryRun ? 'Would remove' : 'Removed'}: ${totalRemoved} directories (${totalMB} MB)`);
