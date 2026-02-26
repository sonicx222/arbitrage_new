#!/usr/bin/env node
/**
 * Cross-platform script to clean all dist folders
 * Works on Windows, macOS, and Linux
 */

const fs = require('fs');
const path = require('path');

const { ROOT_DIR } = require('./lib/constants');
const rootDir = ROOT_DIR;

// Dynamically find all dist/ directories under known package roots.
// This avoids a hardcoded list that falls out of sync when services are added or removed.
function findDistDirs() {
  const dirs = [];

  // Root-level dist
  if (fs.existsSync(path.join(rootDir, 'dist'))) {
    dirs.push('dist');
  }

  // Scan shared/ and services/ for packages with dist/ directories
  for (const parent of ['shared', 'services', 'infrastructure']) {
    const parentDir = path.join(rootDir, parent);
    if (!fs.existsSync(parentDir)) continue;
    try {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          const distPath = path.join(parent, entry.name, 'dist');
          if (fs.existsSync(path.join(rootDir, distPath))) {
            dirs.push(distPath);
          }
        }
      }
    } catch {
      // Ignore errors scanning directories
    }
  }

  return dirs;
}

const dirsToClean = findDistDirs();

function rmdir(dir) {
  const fullPath = path.join(rootDir, dir);
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`Cleaned: ${dir}`);
    return true;
  }
  return false;
}

console.log('Cleaning dist folders...\n');

let cleaned = 0;
for (const dir of dirsToClean) {
  if (rmdir(dir)) {
    cleaned++;
  }
}

// Also clean any .tsbuildinfo files
function cleanTsBuildInfo(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        cleanTsBuildInfo(fullPath);
      } else if (entry.name.endsWith('.tsbuildinfo')) {
        fs.unlinkSync(fullPath);
        console.log(`Deleted: ${path.relative(rootDir, fullPath)}`);
        cleaned++;
      }
    }
  } catch (err) {
    // Ignore errors
  }
}

// Clean stale root-level compiled files (from packages that were refactored to src/)
function cleanStaleRootFiles(pkgDir) {
  const fullPkgDir = path.join(rootDir, pkgDir);
  const extensions = ['.js', '.js.map', '.d.ts', '.d.ts.map'];

  try {
    if (!fs.existsSync(fullPkgDir)) return;

    const entries = fs.readdirSync(fullPkgDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = extensions.find(e => entry.name.endsWith(e));
        // Don't delete configuration files like jest.config.js or other specific scripts if they exist at root
        // But for shared/types, we know common.js, etc should be gone.
        // We generally shouldn't have .js files at root of typescript packages unless they are config.
        const isConfig = ['jest.config.js', 'eslint.config.js', 'rollup.config.js'].includes(entry.name);

        if (ext && !isConfig) {
          fs.unlinkSync(path.join(fullPkgDir, entry.name));
          console.log(`Deleted stale: ${path.join(pkgDir, entry.name)}`);
          cleaned++;
        }
      }
    }
  } catch (err) {
    console.error(`Error cleaning stale files in ${pkgDir}:`, err.message);
  }
}

cleanTsBuildInfo(rootDir);
cleanStaleRootFiles('shared/types');

// Clean stale compiled artifacts (.d.ts, .d.ts.map, .js, .js.map) that sit
// alongside .ts source files in src/ directories.
// These are the #1 cause of cross-platform build failures (TS6305 errors)
function cleanStaleCompiledInSource(baseDir) {
  const exclude = ['node_modules', 'dist', 'typechain-types'];
  // Patterns: compiled file extension -> corresponding source extension
  const stalePatterns = [
    { ext: '.d.ts', srcExt: '.ts' },
    { ext: '.d.ts.map', srcExt: '.ts' },
    { ext: '.js.map', srcExt: '.ts' },
  ];

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!exclude.includes(entry.name)) {
            walk(fullPath);
          }
          continue;
        }

        // Check each stale pattern
        for (const { ext, srcExt } of stalePatterns) {
          if (entry.name.endsWith(ext)) {
            const baseName = fullPath.slice(0, fullPath.length - ext.length);
            const srcFile = baseName + srcExt;
            if (fs.existsSync(srcFile)) {
              fs.unlinkSync(fullPath);
              console.log(`Deleted stale ${ext}: ${path.relative(rootDir, fullPath)}`);
              cleaned++;
            }
            break;
          }
        }

        // Handle .js files alongside .ts (but skip config files like jest.config.js)
        if (entry.name.endsWith('.js') && !entry.name.endsWith('.config.js')) {
          const tsFile = fullPath.replace(/\.js$/, '.ts');
          if (fs.existsSync(tsFile)) {
            fs.unlinkSync(fullPath);
            console.log(`Deleted stale .js: ${path.relative(rootDir, fullPath)}`);
            cleaned++;
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  const fullBaseDir = path.join(rootDir, baseDir);
  if (fs.existsSync(fullBaseDir)) {
    walk(fullBaseDir);
  }
}

for (const dir of ['shared', 'services', 'infrastructure']) {
  cleanStaleCompiledInSource(dir);
}

console.log(`\n✓ Cleaned ${cleaned} items`);
