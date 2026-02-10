#!/usr/bin/env node
/**
 * Cross-platform Environment Setup Script
 *
 * Copies .env.local to .env for local development.
 * Works on Windows, macOS, and Linux without error messages.
 *
 * Usage:
 *   npm run dev:setup
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SOURCE = path.join(ROOT_DIR, '.env.local');
const TARGET = path.join(ROOT_DIR, '.env');

function main() {
  // Check if source file exists
  if (!fs.existsSync(SOURCE)) {
    console.error('Error: .env.local file not found!');
    console.error('Please create a .env.local file with your configuration.');
    process.exit(1);
  }

  // Check if target already exists
  if (fs.existsSync(TARGET)) {
    console.log('.env file already exists.');

    // Compare contents
    const sourceContent = fs.readFileSync(SOURCE, 'utf8');
    const targetContent = fs.readFileSync(TARGET, 'utf8');

    if (sourceContent === targetContent) {
      console.log('Files are identical. No changes needed.');
      return;
    }

    console.log('Overwriting with latest .env.local content...');
  } else {
    console.log('Creating .env file from .env.local...');
  }

  // Copy the file
  try {
    fs.copyFileSync(SOURCE, TARGET);
    console.log('Done! Environment configured successfully.');
    console.log('');
    console.log('📝 IMPORTANT: Environment File Priority');
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
