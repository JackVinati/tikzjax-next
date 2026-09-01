import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import prettier from 'eslint-config-prettier';

/**
 * This config exists for ONE job: the Obsidian community-store rules — no innerHTML/outerHTML
 * assignment, no global `app`, listeners registered for teardown, settings casing, manifest
 * hygiene. Day-to-day linting is `npm run lint` (oxlint), which is far faster; this runs in CI.
 *
 * It pins typescript@5.9.3 through package.json `overrides`, because typescript-eslint@8 peers cap
 * at `<6.1.0` while the project's typechecker is TypeScript 7. See docs/DECISIONS.md D5.
 *
 * TYPE-AWARE RULES ARE SCOPED, and that is the whole shape of this file. They need a program, so
 * they can only run over files tsconfig.json actually includes. Applied globally they crash the run
 * before a single source file is read — first on package.json, since obsidianmd's config lints JSON
 * too, then on engine-src/upstream/*.js.
 */

/**
 * Exactly what tsconfig.json includes. KEEP THE TWO IN STEP.
 *
 * A file in one list and not the other is the failure mode this whole config fights: in tsconfig
 * but not here, and a typed rule runs on it with no parserOptions and throws; here but not in
 * tsconfig, and the project service has nothing to give it. Either way the run dies before linting
 * anything, which is how this reached CI green-looking and red-running.
 */
const TYPED = ['src/**/*.ts', 'engine-src/*.ts', 'types/**/*.ts'];

export default tseslint.config(
	{
		ignores: [
			'main.js',
			'node_modules/**',
			'engine-build/out/**',
			'vendor/**',
			'docs/**',
			'*.config.mjs',
			// Not plugin source. These rules encode what a community-store reviewer looks at, which
			// is what ships — so build scripts, tests and tooling config are out of scope, and
			// holding them to store rules produces noise, not safety. `new Function` in a test that
			// evaluates the built worker is correct; in src/ it would not be. oxlint covers these.
			'scripts/**',
			'test/**',
			'vitest.config.ts',
			// The pristine upstream copy, kept verbatim for diffing against the fork. Linting it
			// produces findings nobody may act on without breaking that.
			'engine-src/upstream/**',
		],
	},

	js.configs.recommended,
	...tseslint.configs.recommended,

	// Taken whole. Splitting it with .map() separates the plugin registration from the rules that
	// name it, and ESLint then cannot resolve `obsidianmd/...` at all.
	//
	// Several of its rules are type-aware, and `disableTypeChecked` cannot reach them — that turns
	// off typescript-eslint's rules, not a third-party plugin's. So every file this config sees must
	// have a program: hence `vitest.config.ts` in tsconfig's include, and `scripts/**` ignored below.
	...obsidianmd.configs.recommended,

	{
		// Turn type-aware rules OFF everywhere except the files tsconfig includes.
		//
		// Necessary because obsidianmd's recommended set brings typed rules in globally, and a typed
		// rule with no program does not skip the file — it throws and takes the whole run with it.
		// It fell over on package.json, then on the pristine upstream .js, then on vitest.config.ts;
		// an allow-list of scopes plays whack-a-mole, so this states the rule once: no program, no
		// typed rules.
		ignores: TYPED,
		...tseslint.configs.disableTypeChecked,
	},

	{
		files: TYPED,
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/consistent-type-imports': 'error',
		},
	},

	{
		files: ['src/**/*.ts', 'engine-src/*.ts'],
		rules: {
			'no-restricted-globals': [
				'error',
				{
					name: 'app',
					message:
						'Use this.app / a passed App. The global is forbidden by the Obsidian guidelines.',
				},
				{
					name: 'activeDocument',
					message:
						'Use el.doc — activeDocument follows focus and misclassifies background pop-outs.',
				},
				{ name: 'activeWindow', message: 'Use el.win / el.doc.defaultView.' },
			],
			'no-restricted-syntax': [
				'error',
				{
					selector:
						'AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
					message: 'Build DOM nodes instead. See docs/DESIGN.md §7.2.',
				},
				{
					selector: "CallExpression[callee.property.name='replaceAll']",
					message:
						'String.prototype.replaceAll is monkey-patched by some community plugins and silently broke rendering (#48). Use a local helper.',
				},
			],
		},
	},

	{
		// The forked GPL engine sources. Keeping the diff against upstream small is worth more here
		// than satisfying rules the original never met.
		files: ['engine-src/*.ts'],
		rules: {
			// `memory!` and friends run through every WASM import. Upstream has no types at all, so
			// each one removed is a line that no longer diffs against the file it was forked from —
			// and that diff is how a future engine bump gets reviewed.
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
		},
	},

	{
		// Hash inner loops. `noUncheckedIndexedAccess` types every array read as possibly undefined,
		// which in a byte-shuffling loop means an assertion per access or a branch per access; the
		// branch would be dead code in a fixed-size buffer. Scoped to these two files so the rule
		// keeps its value everywhere it can actually catch something.
		files: ['src/cache/sha256.ts', 'src/cache/legacy-key.ts'],
		rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
	},

	prettier,
);
