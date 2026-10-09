import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';

// The fixed target is relative to this file, never a caller-supplied path.
const workspace = fileURLToPath(new URL('../', import.meta.url));
const target = resolve(workspace, 'dist');
if (relative(workspace, target) !== 'dist') throw new Error('Invalid build cleanup target');
rmSync(target, { recursive: true, force: true });
