import { readOperationalState } from '../ops/metrics.js';
import { readDatabasePath } from '../runtime/config.js';
import { diagnostic } from '../runtime/diagnostics.js';
try {
  const state=readOperationalState(readDatabasePath());
  console.log(JSON.stringify({code:'OPERATIONAL_STATUS',timestamp:new Date().toISOString(),...state}));
  if(state.status!=='OK')process.exitCode=1;
}catch{diagnostic('OPERATIONAL_STATUS_UNAVAILABLE');process.exitCode=1;}
