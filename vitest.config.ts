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
		},
	},
});
