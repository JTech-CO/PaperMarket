import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoadValidation, type LoadProfile } from '../validation/load.js';

async function verify(): Promise<void> {
  const options: Partial<LoadProfile> = {};
  const numeric = new Set(['markets', 'accounts', 'burst', 'rounds', 'ticks', 'historyRecords']);
  for (const argument of process.argv.slice(2)) {
    if (argument === '--no-volume') { options.projectionVolume = false; continue; }
    const match = /^--([A-Za-z]+)=([0-9]{1,5})$/.exec(argument);
    if (!match || !numeric.has(match[1]!)) throw new Error('Unsupported load option.');
    Object.assign(options, { [match[1]!]: Number(match[2]) });
  }
  const report = await runLoadValidation(options, { onProgress(message) { console.log(JSON.stringify({ milestone: 6, phase: 'LOAD', progress: message })); } });
  const destination = resolve(process.cwd(), 'artifacts', 'milestone6'); mkdirSync(destination, { recursive: true });
  const stamp = report.startedAt.replace(/[^0-9]/g, '');
  const file = `load-${report.profile.markets}m-${report.profile.accounts}a-${report.profile.burst}b-${stamp}.json`;
  writeFileSync(join(destination, file), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report, artifact: file }, null, 2));
  if (!report.measuredTargetsPassed) process.exitCode = 1;
}
void verify().catch(() => { console.error(JSON.stringify({ milestone: 6, result: 'FAIL', code: 'LOCAL_LOAD_CHECK_FAILED' })); process.exitCode = 1; });
