#!/usr/bin/env node
/**
 * Cross-platform Environment Setup Script
 *
 * Copies .env.example to .env for local development.
 * .env.local is loaded separately at runtime with override: true.
 * Works on Windows, macOS, and Linux without error messages.
 *
 * Usage:
 *   npm run dev:setup
 */

const fs = require('fs');
const path = require('path');

const { ROOT_DIR } = require('./lib/constants');
const ENV_EXAMPLE = path.join(ROOT_DIR, '.env.example');
const TARGET = path.join(ROOT_DIR, '.env');

function main() {
  // Only copy .env.example -> .env (base config).
  // .env.local is loaded separately at runtime with override: true by services-config.js.
  // Copying .env.local -> .env would eliminate the layered override benefit.
  if (!fs.existsSync(ENV_EXAMPLE)) {
    console.error('Error: .env.example not found!');
    console.error('Please create a .env.example file with your base configuration.');
    process.exit(1);
  }

  // Skip if target already exists
  if (fs.existsSync(TARGET)) {
    console.log('.env file already exists. No changes needed.');
    console.log('(To reset, delete .env and re-run this script.)');
    return;
  }

  // Copy .env.example -> .env
  console.log('Creating .env file from .env.example...');
  try {
    fs.copyFileSync(ENV_EXAMPLE, TARGET);
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
