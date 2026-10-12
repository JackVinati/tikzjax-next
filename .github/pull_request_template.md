<!-- What changes, and why. If it fixes an issue, link it. -->

- [ ] `npm run format:check`, `lint`, `lint:store`, `typecheck`, `typecheck:legacy`, `test` and
      `build` pass, and `lint:store` reports no new warning
- [ ] A bug fix comes with a test that fails without it
- [ ] No network call, `innerHTML`, `replaceAll` or `element.style` assignment, and no Obsidian API
      newer than 1.7.2 (CONTRIBUTING.md says why)
- [ ] If `engine-src/` or `engine-build/` changed: `npm run scan:native` was run, and
      `src/source/native-unicode.ts` (and `engine-build/out/`) are committed with it
- [ ] Anything a user would notice has a line in the newest section of `CHANGELOG.md`
