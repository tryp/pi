# Upstream cherry-pick report

Worktree verification: `verify=ok path=/home/dev/src/wt/pimono-codex-cache branch=wip/cherry-codex-cache head=2b4e0591092d2cdc7c72c33b636759de4e32e933 checkout=linked-worktree`.

Dependency setup: symlinking the primary checkout's root `node_modules` was not sufficient by itself; the AI test setup could not find `packages/ai/src/providers/data/amazon-bedrock.json`. A read-only symlink to the corresponding primary-checkout data directory enabled the test command. No package install was run.

Tests (`cd packages/ai && npx vitest --run`):

| Point | Test Files | Tests | Errors |
|---|---:|---:|---:|
| Branch point, before cherry-picks | 29 failed, 122 passed, 11 skipped (162) | 61 failed, 1281 passed, 827 skipped (2169) | 2 |
| After commit `bb1a2b354` | 29 failed, 122 passed, 11 skipped (162) | 61 failed, 1281 passed, 827 skipped (2169) | 2 |
| Final; commit 3 was not applicable | same | same | same |

The failures match at baseline and after the applied commit, including existing live/provider-dependent cases and test/catalog discrepancies. The two unhandled errors are the missing-model cases in `openai-completions-cache-control-format.test.ts` and `openai-responses-compat.test.ts`.

## Commit decisions

1. `caa6967b62122bad12e4a2af287932b9e881bdf0` — **NOT_APPLICABLE**. The upstream change is based on a transcript-replay layer and old API converter arrangement (`packages/ai/src/utils/transcript.ts`, deleted from this fork's HEAD) and conflicts with the current `convertResponsesMessages` implementation, which already contains extensive custom tool replay and deferred-tool handling. The cherry-pick was aborted rather than replacing the fork's prompt/cache behavior with code for the incompatible transcript pipeline.
2. `bb1a2b3542b50998cda94d6bbd01c1624e1ce251` — **APPLIED** as `9b4788a33a6be6d137212e184489363db50af126`. The fork has the corresponding websocket session lifecycle and retry layer. The implementation changes the websocket cache max age from 55 to 45 minutes and retries the `websocket_connection_limit_reached` provider error. Conflict resolution retained fork versions of its churned AI test files and changelog; the upstream regression test file was included. This proactively opens a fresh socket before the 60-minute server limit and retries errors explicitly reporting that limit.
3. `fcc33744b072b9bb5529fa4ff8b151f9fa578e14` — **NOT_APPLICABLE**. Its catalog-based model compatibility mechanism is absent: the upstream files `packages/ai/catalog/families/openai.ts`, `packages/ai/catalog/providers/openai-codex.ts`, `packages/ai/catalog/providers/openai.ts`, and `packages/ai/src/providers/compat-schema.ts` are deleted from this fork's HEAD. The conflicting provider implementation also assumes that schema and `supportsMidConvoEffort` capability. Existing provider source has `OpenAICodexResponsesOptions` at `packages/ai/src/api/openai-codex-responses.ts:84-98` and no corresponding compatibility setting. This was not forced into the incompatible model-definition pipeline.

The cache-across-tool-changes fix addresses preserving a stable prompt prefix when tool availability changes; this fork already has custom deferred-tool/replay code instead of the upstream transcript system. The websocket fix protects long-running Codex responses and recovers from expired sockets. The thinking-level fix aims to send level changes without varying cache-sensitive request parameters, but its upstream catalog/compatibility plumbing does not exist here.

Typecheck: `npx tsgo -p packages/ai/tsconfig.build.json --noEmit` — passed (no output). The upstream regression test passed: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/regressions/12124-websocket-connection-limit-retry.test.ts` from `packages/coding-agent` (1 passed).

Final repository checks: `git diff --check` passed; no staged files. `REPORT.md` is the sole uncommitted file; commit `9b4788a33` is the only new commit. No merge, deployment, or push performed.
