#!/usr/bin/env node
/**
 * Migrate remaining @arbitrage/core barrel imports to sub-entry points.
 *
 * Run: node scripts/migrate-remaining-barrel.mjs [--dry-run]
 */
import fs from 'fs';
import path from 'path';


const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = process.cwd();

// Symbol -> sub-entry point mapping
const SYMBOL_MAP = {
  // NOTE: createLogger, Logger, PerformanceLogger, getPerformanceLogger stay on barrel
  // (backward-compat facades in logger.ts, not in logging/ sub-entry point)
  // Pino-specific symbols available in logging sub-entry point:
  'ILogger': 'logging',
  'IPerformanceLogger': 'logging',
  'createPinoLogger': 'logging',
  'getLogger': 'logging',
  'getPinoPerformanceLogger': 'logging',
  'PinoPerformanceLogger': 'logging',
  'resetLoggerCache': 'logging',
  'resetPerformanceLoggerCache': 'logging',
  'RecordingLogger': 'logging',
  'RecordingPerformanceLogger': 'logging',
  'NullLogger': 'logging',
  'createMockLoggerFactory': 'logging',
  'LogEntry': 'logging',
  'LoggerConfig': 'logging',
  'LogLevel': 'logging',
  'LogMeta': 'logging',
  'ServiceLogger': 'logging',
  'getOtelTransport': 'logging',
  'shutdownOtelTransport': 'logging',

  // NOTE: FactorySubscriptionService, WebSocketManager, etc. stay on barrel
  // (parent-path re-exports from factory-subscription/ don't work with composite builds)

  // utils
  'FeeBasisPoints': 'utils',
  'FeeDecimal': 'utils',
  'bpsToDecimal': 'utils',
  'decimalToBps': 'utils',
  'v3TierToDecimal': 'utils',
  'percentToDecimal': 'utils',
  'isValidFeeDecimal': 'utils',
  'getDefaultFeeForDex': 'utils',
  'asBps': 'utils',
  'asDecimal': 'utils',
  'disconnectWithTimeout': 'utils',
  'parseEnvInt': 'utils',
  'parseEnvIntSafe': 'utils',
  'withRetryAsync': 'async',

  // caching
  'HierarchicalCache': 'caching',
  'createHierarchicalCache': 'caching',
  'getHierarchicalCache': 'caching',
  'resetHierarchicalCache': 'caching',
  'PriceMatrix': 'caching',
  'getPriceMatrix': 'caching',
  'resetPriceMatrix': 'caching',
  'GasPriceCache': 'caching',
  'getGasPriceCache': 'caching',
  'resetGasPriceCache': 'caching',
  'SharedMemoryCache': 'caching',
  'ReserveCache': 'caching',
  'PairCacheService': 'caching',
  'CorrelationAnalyzer': 'caching',
  'LRUQueue': 'caching',

  // monitoring
  'EnhancedHealthMonitor': 'monitoring',
  'getEnhancedHealthMonitor': 'monitoring',
  'resetEnhancedHealthMonitor': 'monitoring',
  'StreamHealthMonitor': 'monitoring',
  'ProviderHealthScorer': 'monitoring',
  'CrossRegionHealthManager': 'monitoring',
  'LatencyTracker': 'monitoring',
  'getLatencyTracker': 'monitoring',
  'resetLatencyTracker': 'monitoring',

  // partition (only symbols actually in partition/index.ts)
  'createPartitionEntry': 'partition',
  'createHealthServer': 'partition',
  'setupProcessHandlers': 'partition',
  // NOTE: parseStandbyConfig is in cross-region/bootstrap.ts, barrel-only

  // service-lifecycle
  'ServiceStateManager': 'service-lifecycle',
  'ServiceState': 'service-lifecycle',
  'createServiceState': 'service-lifecycle',

  // circuit-breaker
  'SimpleCircuitBreaker': 'circuit-breaker',
  'CircuitBreaker': 'circuit-breaker',
  'resetCircuitBreakerRegistry': 'circuit-breaker',

  // redis
  'getRedisClient': 'redis',
  'getRedisStreamsClient': 'redis',
  'getDistributedLockManager': 'redis',

  // resilience
  'getErrorMessage': 'resilience',
  'RetryConfig': 'resilience',
  'CircuitBreakerConfig': 'resilience',
};

// Files to skip (self-references within shared/core/src/)
const SKIP_PATHS = [
  'shared/core/src/',
  'shared/config/src/mev-config.d.ts',
];

function shouldSkip(filePath) {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  return SKIP_PATHS.some(p => rel.startsWith(p));
}

function findBarrelImportFiles() {
  const results = [];
  const dirs = ['services', 'shared', 'tests'];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes("from '@arbitrage/core'")) {
            results.push(full);
          }
        } catch { /* skip */ }
      }
    }
  }
  for (const d of dirs) {
    const dirPath = path.join(ROOT, d);
    if (fs.existsSync(dirPath)) walk(dirPath);
  }
  return results;
}

function parseImportStatement(content) {
  // Match: import { X, Y, Z } from '@arbitrage/core';
  // Also: import type { X, Y } from '@arbitrage/core';
  // Can be multiline
  const regex = /import\s+(type\s+)?{([^}]+)}\s+from\s+'@arbitrage\/core'\s*;/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const isType = !!match[1];
    const symbolBlock = match[2].replace(/\/\/[^\n]*/g, ''); // strip comments
    const symbols = symbolBlock
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => {
        // Handle "type Foo" within value imports
        const typeMatch = s.match(/^type\s+(\w+)$/);
        if (typeMatch) return { name: typeMatch[1], isType: true };
        // Handle "Foo as Bar"
        const aliasMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
        if (aliasMatch) return { name: aliasMatch[1], alias: aliasMatch[2], isType };
        return { name: s, isType };
      });
    matches.push({
      fullMatch: match[0],
      isTypeImport: isType,
      symbols,
      index: match.index,
    });
  }
  return matches;
}

function migrateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const imports = parseImportStatement(content);

  if (imports.length === 0) return null;

  const changes = [];

  for (const imp of imports) {
    // Group symbols by sub-entry point
    const groups = new Map(); // subpath -> symbols[]
    const unmapped = [];

    for (const sym of imp.symbols) {
      const subpath = SYMBOL_MAP[sym.name];
      if (subpath) {
        if (!groups.has(subpath)) groups.set(subpath, []);
        groups.get(subpath).push(sym);
      } else {
        unmapped.push(sym);
      }
    }

    // If all symbols are unmapped, skip this import
    if (groups.size === 0) continue;

    // Build replacement import statements
    const newImports = [];

    for (const [subpath, syms] of groups) {
      const typeSyms = syms.filter(s => s.isType);
      const valueSyms = syms.filter(s => !s.isType);

      if (imp.isTypeImport) {
        // All are type imports
        const symStr = syms.map(s => s.alias ? `${s.name} as ${s.alias}` : s.name).join(', ');
        newImports.push(`import type { ${symStr} } from '@arbitrage/core/${subpath}';`);
      } else {
        // Mix of type and value imports
        if (valueSyms.length > 0) {
          const parts = [];
          for (const s of valueSyms) {
            parts.push(s.alias ? `${s.name} as ${s.alias}` : s.name);
          }
          // Include inline "type X" for type-only symbols
          for (const s of typeSyms) {
            parts.push(`type ${s.alias ? `${s.name} as ${s.alias}` : s.name}`);
          }
          newImports.push(`import { ${parts.join(', ')} } from '@arbitrage/core/${subpath}';`);
        } else if (typeSyms.length > 0) {
          const symStr = typeSyms.map(s => s.alias ? `${s.name} as ${s.alias}` : s.name).join(', ');
          newImports.push(`import type { ${symStr} } from '@arbitrage/core/${subpath}';`);
        }
      }
    }

    // Keep unmapped symbols on barrel
    if (unmapped.length > 0) {
      if (imp.isTypeImport) {
        const symStr = unmapped.map(s => s.alias ? `${s.name} as ${s.alias}` : s.name).join(', ');
        newImports.push(`import type { ${symStr} } from '@arbitrage/core';`);
      } else {
        const parts = unmapped.map(s => {
          const prefix = s.isType ? 'type ' : '';
          return s.alias ? `${prefix}${s.name} as ${s.alias}` : `${prefix}${s.name}`;
        });
        newImports.push(`import { ${parts.join(', ')} } from '@arbitrage/core';`);
      }
    }

    const replacement = newImports.join('\n');
    content = content.replace(imp.fullMatch, replacement);
    changes.push({
      original: imp.fullMatch,
      replacement,
      symbolCount: imp.symbols.length,
      mappedCount: imp.symbols.length - unmapped.length,
    });
  }

  if (changes.length === 0) return null;

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, content);
  }

  return changes;
}

// Main
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

const files = findBarrelImportFiles();
console.log(`Found ${files.length} files with @arbitrage/core barrel imports\n`);

let totalFiles = 0;
let totalMigrated = 0;
let totalSymbols = 0;

for (const file of files) {
  if (shouldSkip(file)) continue;

  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const changes = migrateFile(file);

  if (changes) {
    totalFiles++;
    for (const c of changes) {
      totalMigrated += c.mappedCount;
      totalSymbols += c.symbolCount;
    }
    console.log(`${DRY_RUN ? '[DRY]' : '[OK]'} ${rel}`);
    for (const c of changes) {
      console.log(`  ${c.mappedCount}/${c.symbolCount} symbols migrated`);
    }
  }
}

console.log(`\n--- Summary ---`);
console.log(`Files modified: ${totalFiles}`);
console.log(`Symbols migrated: ${totalMigrated} / ${totalSymbols}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no files changed)' : 'LIVE (files updated)'}`);
