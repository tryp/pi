# Testing

The model-data directory is gitignored, so every fresh worktree starts without it. Two guards catch that before a test file can fail on a missing JSON file:

- **Vitest** (`npm test`, or a single-file `npx vitest --run test/x.test.ts`): `globalSetup` runs `scripts/vitest-model-data-setup.ts`, which fully validates the data against the committed shards.
- **Bun from `packages/ai`**: `bunfig.toml` preloads `scripts/bun-model-data-preload.ts`, which checks manifest presence and schema only, so it costs nothing on a warm run.

Both print `Model data is missing or stale. Run \`npm run hydrate:model-data\` from the repository root.` and exit non-zero before any test runs.

Not covered: `bun test packages/ai/test/...` invoked from the repository root, because Bun loads its config from the current directory.

If network hydration is unavailable, run `npm run bootstrap:model-data` from `packages/ai`. It copies the data and manifest from the primary checkout inferred from Git's common directory, validates the copy, and prints its generation time and age so a stale copy cannot be mistaken for a fresh one.
