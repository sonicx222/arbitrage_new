#!/usr/bin/env node
/**
 * Shared environment loader for scripts.
 *
 * Load order and precedence:
 * 1) Existing process.env values (shell/CI/test overrides)
 * 2) .env.local values
 * 3) .env values
 *
 * This preserves explicit runtime overrides while still allowing .env.local
 * to override .env defaults.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const { ROOT_DIR } = require('./constants');

let loaded = false;

/**
 * Parse an env file if it exists.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return dotenv.parse(content);
  } catch (error) {
    console.warn(`Warning: Error loading ${path.basename(filePath)}: ${error.message}`);
    return {};
  }
}

/**
 * Load .env and .env.local once for the current process.
 */
function loadEnvFiles() {
  if (loaded) return;
  loaded = true;

  const baseEnv = parseEnvFile(path.join(ROOT_DIR, '.env'));
  const localEnv = parseEnvFile(path.join(ROOT_DIR, '.env.local'));

  // .env.local overrides .env for file-sourced values.
  const merged = { ...baseEnv, ...localEnv };

  // Explicit process.env values take precedence over files.
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFiles();

module.exports = {
  loadEnvFiles
};
