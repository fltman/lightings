// Load .env BEFORE any other local module is evaluated. This file is imported
// first in index.js, so its side effect (populating process.env) runs before
// modules that read keys/config at import time. Optional — no .env is fine.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url))
} catch {
  // no .env present, or already loaded — ignore
}
