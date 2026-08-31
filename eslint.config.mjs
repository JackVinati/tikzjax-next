import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import prettier from 'eslint-config-prettier';

// This config exists for ONE job: the Obsidian community-store rules (no innerHTML/outerHTML
// assignment, no global `app`, listeners registered for teardown, settings casing, manifest
// hygiene). Day-to-day linting is `npm run lint` (oxlint), which is ~100x faster; this runs in CI.
//
// It pins typescript@5.9.3 via package.json `overrides` because typescript-eslint@8 peers cap at
// `<6.1.0` while the typechecker is TypeScript 7. See docs/DECISIONS.md D5.
export default tseslint.config(
	{
		ignores: [
			'main.js',
			'node_modules/**',
			'engine-build/out/**',
			'vendor/**',
			'docs/**',
			'*.config.mjs',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// The engine fork deliberately mirrors upstream's shapes; churn there is a merge hazard.
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/consistent-type-imports': 'error',
			'no-restricted-globals': [
				'error',
				{ name: 'app', message: 'Use this.app / a passed App. The global is forbidden by the Obsidian guidelines.' },
				{ name: 'activeDocument', message: 'Use el.doc — activeDocument follows focus and misclassifies background pop-outs.' },
				{ name: 'activeWindow', message: 'Use el.win / el.doc.defaultView.' },
			],
			'no-restricted-syntax': [
				'error',
				{
					selector: "AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]",
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
		files: ['engine-src/**/*.ts'],
		rules: {
			// Forked GPL source: keep the diff against upstream small and reviewable.
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
		},
	},
	prettier,
);
