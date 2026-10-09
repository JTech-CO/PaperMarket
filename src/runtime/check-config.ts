import { readRuntimeConfig } from './config.js';
import { diagnostic } from './diagnostics.js';

try {
  readRuntimeConfig();
  console.log(JSON.stringify({ mode: 'ECONOMY', configuration: 'VALID', secrets: 'REDACTED' }));
} catch { diagnostic('CONFIGURATION_INVALID_CHECK_ENVIRONMENT'); process.exitCode = 1; }
