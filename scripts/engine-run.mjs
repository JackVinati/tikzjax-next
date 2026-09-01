/**
 * Runs the engine build container and drops its artifacts in engine-build/out.
 *
 *   node scripts/engine-run.mjs [apt|net]
 *
 * A wrapper rather than a plain npm script because the bind mount needs an absolute host path,
 * and `$PWD` is not expanded by the shell npm uses on Windows — `docker run -v "$PWD/..."` fails
 * there with "includes invalid characters for a local volume name". This repo is maintained from
 * Windows; CI runs on Linux. Both go through here so they cannot diverge.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const flavour = process.argv[2] ?? 'apt';
if (flavour !== 'apt' && flavour !== 'net') {
	console.error(`unknown flavour "${flavour}" — expected apt or net`);
	process.exit(2);
}

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'engine-build', 'out');

// Docker creates a missing mount point as root inside the VM, which then owns it on the host too.
// Creating it here keeps it owned by whoever runs the build.
mkdirSync(out, { recursive: true });

const args = ['run', '--rm', '-v', `${out}:/out`, `tikzjax-engine:${flavour}`];
console.log(`docker ${args.join(' ')}`);

const result = spawnSync('docker', args, {
	stdio: 'inherit',
	// MSYS/Git Bash rewrites anything that looks like a Unix path in an argument — `/out` becomes
	// `C:/Program Files/Git/out` — and silently mounts the wrong target.
	env: { ...process.env, MSYS_NO_PATHCONV: '1' },
	shell: false,
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
