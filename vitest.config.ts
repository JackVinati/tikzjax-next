import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	test: {
		// Node by default: the bulk of this codebase is pure functions (source normalization, the
		// cache key, the state machine, the SVG stages, the log parser) and they are deliberately
		// written to need no DOM. The two modules that legitimately need a document opt in per-file
		// with `// @vitest-environment happy-dom`.
		environment: 'node',
		include: ['test/**/*.test.ts'],
		alias: {
			// Obsidian's package is a type-only stub with no runtime; anything importing it in a
			// test resolves to our hand-written fake instead.
			obsidian: fileURLToPath(new URL('./test/stubs/obsidian.ts', import.meta.url)),
		},
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// platform/ and ui/ are thin Obsidian adapters; the logic they wrap is tested directly.
			exclude: ['src/platform/**', 'src/ui/**', 'src/main.ts'],
			// The table for the terminal, the JSON for CI's job summary.
			reporter: ['text', 'json-summary'],
			// Floors, not targets: a little under what the suite measured on 2026-10-13 (statements
			// 92.6, branches 85.8, functions 92.5, lines 95.3; it was 76.9, 72.8, 67.1 and 78.6 the day
			// before, until 0.1.5's work brought the block lifecycle, the processor, the commands and
			// the cache under test), so a change that lands a pile of untested code fails
			// `npm run test:coverage` instead of lowering the numbers quietly. Raise them as the gaps
			// close — the least-covered files are listed first in CI's job summary.
			thresholds: {
				statements: 90,
				branches: 83,
				functions: 90,
				lines: 93,
			},
		},
	},
});
