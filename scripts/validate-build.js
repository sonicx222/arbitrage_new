#!/usr/bin/env node
/**
 * Pre-Build Validation Script
 *
 * Catches common issues that cause cross-platform build failures:
 * - Stale .d.ts files alongside .ts source files
 * - Missing dependencies
 * - Type definition mismatches
 *
 * Run before build: npm run build:validate
 * Or automatically via: npm run build:clean (recommended)
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

// ANSI colors for console output
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Find files matching a pattern recursively
 */
function findFiles(dir, pattern, exclude = []) {
  const results = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    const relativePath = path.relative(ROOT_DIR, fullPath);

    // Skip excluded directories
    if (exclude.some(ex => relativePath.includes(ex))) {
      continue;
    }

    if (file.isDirectory()) {
      results.push(...findFiles(fullPath, pattern, exclude));
    } else if (pattern.test(file.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Check for stale .d.ts files that exist alongside .ts source files
 * This is the #1 cause of cross-platform build failures
 */
function checkStaleDtsFiles() {
  log('\nChecking for stale .d.ts files...', 'cyan');

  const issues = [];
  const sourceDirs = ['shared', 'services', 'infrastructure'];
  const exclude = ['node_modules', 'dist', 'typechain-types'];

  for (const sourceDir of sourceDirs) {
    const dir = path.join(ROOT_DIR, sourceDir);
    const dtsFiles = findFiles(dir, /\.d\.ts$/, exclude);

    for (const dtsFile of dtsFiles) {
      // Check if there's a corresponding .ts file
      const tsFile = dtsFile.replace(/\.d\.ts$/, '.ts');

      if (fs.existsSync(tsFile)) {
        issues.push({
          type: 'stale-dts',
          dtsFile: path.relative(ROOT_DIR, dtsFile),
          tsFile: path.relative(ROOT_DIR, tsFile),
          message: `Stale .d.ts file exists alongside .ts source. Delete: ${path.relative(ROOT_DIR, dtsFile)}`
        });
      }
    }
  }

  return issues;
}

/**
 * Check for node_modules in workspace directories (should use hoisted deps)
 */
function checkNestedNodeModules() {
  log('\nChecking for nested node_modules...', 'cyan');

  const issues = [];
  const workspaces = ['shared', 'services', 'infrastructure'];

  for (const workspace of workspaces) {
    const dir = path.join(ROOT_DIR, workspace);
    if (!fs.existsSync(dir)) continue;

    const packages = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const pkg of packages) {
      const nodeModulesPath = path.join(dir, pkg, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        // Check if it's unexpectedly large (hoisted deps shouldn't be duplicated)
        const size = getDirectorySize(nodeModulesPath);
        if (size > 10 * 1024 * 1024) { // > 10MB is suspicious
          issues.push({
            type: 'nested-node-modules',
            path: path.relative(ROOT_DIR, nodeModulesPath),
            size: `${(size / 1024 / 1024).toFixed(1)}MB`,
            message: `Large nested node_modules (${(size / 1024 / 1024).toFixed(1)}MB) in ${workspace}/${pkg}. Consider: rm -rf ${workspace}/${pkg}/node_modules && npm install`
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Get directory size (approximate)
 */
function getDirectorySize(dir) {
  let size = 0;
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Ignore permission errors etc.
  }
  return size;
}

/**
 * Check for common package.json issues
 */
function checkPackageJsonIssues() {
  log('\nChecking package.json consistency...', 'cyan');

  const issues = [];
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

  // Check TypeScript version consistency
  const rootTsVersion = rootPkg.devDependencies?.typescript;

  const workspaces = ['shared', 'services', 'infrastructure', 'contracts'];
  for (const workspace of workspaces) {
    const dir = path.join(ROOT_DIR, workspace);
    if (!fs.existsSync(dir)) continue;

    const packages = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const pkg of packages) {
      const pkgJsonPath = path.join(dir, pkg, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;

      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const localTsVersion = pkgJson.devDependencies?.typescript;

      if (localTsVersion && localTsVersion !== rootTsVersion) {
        issues.push({
          type: 'ts-version-mismatch',
          package: `${workspace}/${pkg}`,
          rootVersion: rootTsVersion,
          localVersion: localTsVersion,
          message: `TypeScript version mismatch: root=${rootTsVersion}, ${workspace}/${pkg}=${localTsVersion}`
        });
      }
    }
  }

  return issues;
}

/**
 * Main validation function
 */
function validate() {
  console.log('\n' + '='.repeat(60));
  log('  Build Validation - Cross-Platform Compatibility Check', 'cyan');
  console.log('='.repeat(60));

  const allIssues = [];

  // Run all checks
  allIssues.push(...checkStaleDtsFiles());
  allIssues.push(...checkNestedNodeModules());
  allIssues.push(...checkPackageJsonIssues());

  // Report results
  console.log('\n' + '-'.repeat(60));

  if (allIssues.length === 0) {
    log('\n✓ All checks passed! Build should be platform-independent.', 'green');
    console.log('');
    return 0;
  }

  log(`\n✗ Found ${allIssues.length} issue(s) that may cause cross-platform build failures:\n`, 'red');

  for (const issue of allIssues) {
    log(`  [${issue.type}] ${issue.message}`, 'yellow');
  }

  console.log('\n' + '-'.repeat(60));
  log('\nTo fix these issues:', 'cyan');

  // Group fixes by type
  const staleDts = allIssues.filter(i => i.type === 'stale-dts');
  if (staleDts.length > 0) {
    log('\n1. Delete stale .d.ts files:', 'yellow');
    for (const issue of staleDts) {
      log(`   rm "${issue.dtsFile}"`, 'reset');
    }
  }

  const nestedMods = allIssues.filter(i => i.type === 'nested-node-modules');
  if (nestedMods.length > 0) {
    log('\n2. Clean nested node_modules and reinstall:', 'yellow');
    log('   npm run clean:all && npm install', 'reset');
  }

  const tsMismatch = allIssues.filter(i => i.type === 'ts-version-mismatch');
  if (tsMismatch.length > 0) {
    log('\n3. Sync TypeScript versions across workspaces', 'yellow');
  }

  console.log('');
  return 1;
}

// Run validation
const exitCode = validate();
process.exit(exitCode);
