# Terminal restore cherry-picks

## Commits

Cherry-picks are separate commits in requested order, each with its upstream `-x` trailer:

- `bf72c7e08` / `3107a58d2` — APPLIED. Carries the TUI ownership lifecycle change in `packages/tui/src/tui.ts` and its tests. Does not touch `tui-main-screen.ts`. Changelog hunks intentionally dropped. Conflicts: `packages/tui/src/tui.ts`, the added `suspend-signal.test.ts`, and `packages/tui/CHANGELOG.md`; code was reconciled against the fork, and changelog hunks were discarded.
- `38cc822f6` / `e4f50d76d` — APPLIED. Conflicts in interactive mode, TUI signal code/test, and changelogs. Upstream's TUI API call was not retained for main-screen mode; see Deviation from upstream. Changelog hunks intentionally dropped.
- `294aa95aa` / `7c05885bc` — APPLIED. Conflicts in startup UI and coding-agent changelog; the local startup UI import structure was preserved and stdout flush calls applied. Changelog hunks intentionally dropped.
- `4533ca8a0` — fork adaptation: external SIGTSTP registration in interactive mode, tied to interactive terminal ownership and reusing `handleCtrlZ()`.

A first attempt produced conflict markers in a changelog; the branch was rebuilt with `git reset --hard 2b4e05910`, discarding only the two broken cherry-pick commits, then the cherries were reapplied. The final branch has no markers in any changed file. Existing markers in the base branch's coding-agent changelog are not part of this branch's diff; parent confirmed the mainline fix is being handled separately.

## Changelog policy

The fork changelogs describe 0.84.3 and are fork-owned. Upstream 1.6.0 changelog hunks were intentionally dropped rather than merged or replaced. Cherry-pick provenance is recorded by the `-x` trailers and this report.

## Deviation from upstream

Upstream's 3107a58d2 change adds TUI signal-handler plumbing, and e4f50d76d calls it from interactive mode. That API path is not suitable for this fork's main-screen mode: the main-screen renderer does not expose the upstream TUI handler contract, and adding a no-op contract implementation would leave tmux users unfixed. The fork adaptation registers SIGTSTP in `interactive-mode.ts` after the UI starts, removes it during teardown and while suspension is in progress, guards reentrancy, and re-registers after SIGCONT. Both external SIGTSTP and Ctrl+Z use the existing `handleCtrlZ()` restore/resume path. `packages/tui/src/tui-main-screen.ts` was not modified.

## Validation

- TUI tests at branch point: 932 passed, 0 failed.
- TUI tests after changes: 936 passed, 0 failed (4 new cases).
- Coding-agent tests: `test/flush-stdout.test.ts`, all 4 passed: queued callback ordering; bounded timeout; queued output before `process.exit()`; clean exit with closed stdout. No coding-agent suspend-specific test exists in this branch.
- `node_modules` symlink to `/home/dev/src/pi-mono/node_modules` was created. It was insufficient for a CLI/PTY run: startup failed resolving `packages/ai/src/providers/data/amazon-bedrock.json`.
- PTY byte-level SIGTSTP/SIGCONT verification: UNVERIFIED. The local CLI could not start due to the missing `amazon-bedrock.json`, so no terminal byte capture was possible.
- `npm run check`: failed at Biome because of an unrelated warning in `packages/ai/test/models-setup-abort-signal.test.ts` (`_init` unused); its `--write` phase modified 27 unrelated files, which were restored to HEAD. Targeted Biome check on all changed TypeScript files passed.
- `npx tsgo --noEmit`: failed with existing broad project type errors (including generated-model/package mismatch); after correcting the new test's type annotation, no diagnostics referenced changed files.
- `git diff main --stat -- packages/tui/src/tui-main-screen.ts`: empty.
- `git diff main --stat -- packages/coding-agent/CHANGELOG.md` and `packages/tui/CHANGELOG.md`: empty.
- `git grep -nE '^(<{7}|={7}|>{7})' -- $(git diff main --name-only)`: no hits.
- `git diff --check`: passed.

## tmux main-screen behavior (intended)

External SIGTSTP is handled while the interactive UI owns the terminal and enters the same `handleCtrlZ()` path as Ctrl+Z, which stops the UI before suspending. SIGCONT restarts the UI, reinstalls the listener, and requests a full render. The stdout flush cherry waits for queued terminal restore bytes before exit. This intended behavior is not claimed as byte-level verified; see UNVERIFIED above.

## Branch verification

`verify=ok path=/home/dev/src/wt/pimono-terminal-restore branch=wip/cherry-terminal-restore head=4533ca8a0c36532c0880e8e95b396b00577d630d checkout=linked-worktree`

No staged files at report creation. No merge, deploy, or push performed.
