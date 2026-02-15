#!/usr/bin/env node
/**
 * Cross-platform Environment Setup Script
 *
 * Copies .env.example to .env for local development.
 * If .env.local exists, it is used instead (local overrides).
 * Works on Windows, macOS, and Linux without error messages.
 *
 * Usage:
 *   npm run dev:setup
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const ENV_LOCAL = path.join(ROOT_DIR, '.env.local');
const ENV_EXAMPLE = path.join(ROOT_DIR, '.env.example');
const TARGET = path.join(ROOT_DIR, '.env');

function main() {
  // Prefer .env.local if it exists; fall back to .env.example
  let source;
  let sourceName;
  if (fs.existsSync(ENV_LOCAL)) {
    source = ENV_LOCAL;
    sourceName = '.env.local';
  } else if (fs.existsSync(ENV_EXAMPLE)) {
    source = ENV_EXAMPLE;
    sourceName = '.env.example';
  } else {
    console.error('Error: Neither .env.local nor .env.example found!');
    console.error('Please create a .env.example file with your base configuration.');
    process.exit(1);
  }

  // Check if target already exists
  if (fs.existsSync(TARGET)) {
    console.log('.env file already exists.');

    // Compare contents
    const sourceContent = fs.readFileSync(source, 'utf8');
    const targetContent = fs.readFileSync(TARGET, 'utf8');

    if (sourceContent === targetContent) {
      console.log(`Files are identical (source: ${sourceName}). No changes needed.`);
      return;
    }

    console.log(`Overwriting with latest ${sourceName} content...`);
  } else {
    console.log(`Creating .env file from ${sourceName}...`);
  }

  // Copy the file
  try {
    fs.copyFileSync(source, TARGET);
    console.log('Done! Environment configured successfully.');
    console.log('');
    console.log('IMPORTANT: Environment File Priority');
    console.log('   Priority Order (highest to lowest):');
    console.log('   1. .env.local (gitignored) - Your local overrides');
    console.log('   2. .env (created by this script) - Base config');
    console.log('   3. Defaults in code');
    console.log('');
    console.log('   How it works:');
    console.log('   - Scripts load .env first, then .env.local with override: true');
    console.log('   - Values in .env.local ALWAYS win over .env');
    console.log('   - Keep sensitive values ONLY in .env.local (never committed)');
    console.log('   - Use .env for team-shared defaults (can be committed)');
    console.log('');
    console.log('Next steps:');
    console.log('  1. npm run dev:redis         # Start Redis (Docker)');
    console.log('     npm run dev:redis:memory  # ...or in-memory (no Docker)');
    console.log('  2. npm run dev:start         # Start all services');
    console.log('');
  } catch (err) {
    console.error('Error copying file:', err.message);
    process.exit(1);
  }
}

main();
