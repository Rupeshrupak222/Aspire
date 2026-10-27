// Minimal, dependency-free .env loader.
// Reads KEY=VALUE lines from backend/.env (if present) and copies them into
// process.env WITHOUT overriding variables already set in the environment.
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const rootEnv = path.join(__dirname, '..', '..', '..', '.env');
  const backendEnv = path.join(__dirname, '..', '..', '.env');
  const targetFiles = file ? [file] : [backendEnv, rootEnv];

  for (const envPath of targetFiles) {
    let raw;
    try {
      raw = fs.readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes if present.
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

module.exports = { loadEnv };
