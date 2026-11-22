# SIGTSTP PTY verification report

Verdict: UNVERIFIED. The interactive process could not be started with the faux-provider path, so no terminal UI byte stream or external-SIGTSTP restore behavior was captured. No product code was changed.

## Commands and observations

Preflight passed:

```text
pwd -> /home/dev/src/wt/pimono-terminal-restore
git rev-parse --abbrev-ref HEAD -> wip/cherry-terminal-restore
git status --short -> empty
```

The repository faux-provider references were inspected in `packages/coding-agent/test/suite/harness.ts` and tests. I attempted an interactive start from this worktree using a temporary extension that invokes `registerFauxProvider()`:

```text
node packages/coding-agent/src/cli.ts --no-extensions --extension /tmp/pi-faux-pty.ts --provider faux --model faux-1 --no-session --no-context-files
```

The CLI exited before interactive startup. The captured PTY bytes were:

```text
\x1b[31mError: Unknown provider "faux". Use --list-models to see available providers/models.\x1b[39m\r\n
```

No mouse/cursor/keyboard enable sequences or SIGTSTP restore sequences were observed; there are therefore no relevant byte offsets to report. No SIGTSTP was sent because the process had already exited. This does not establish that restore fails; it leaves the requested behavior unverified.

Tests run from this worktree:

```text
cd packages/tui && node --test test/*.test.ts
# tests 936; pass 936; fail 0

cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/flush-stdout.test.ts
# Test Files 1 passed (1); Tests 4 passed (4)
```

## Review findings

- Blocker for attestation: `packages/coding-agent/src/cli.ts` runtime rejected the registered faux provider as unknown, preventing interactive mode and byte-level SIGTSTP validation.
- No product files were edited. The captured-byte validation is incomplete, not a code defect finding.

## Residual risks

- External SIGTSTP terminal restoration remains unverified. A usable local faux provider must be registered in a way recognized by CLI model selection before the PTY test can proceed.

## Verification completed (parent, after the blocker above)

The faux-provider path was the wrong instrument: the faux provider is test-only, so the CLI rejects it before
interactive startup. The branch CLI runs directly from TypeScript source (`node src/cli.ts`, Node 26 strips types), so
no build is needed, and terminal features are enabled at startup independently of any model request.

Instrument: `scripts/verify_sigtstp_restore.py` in `pi-session-analysis` — starts the CLI in a private pty, waits for
the UI to enable terminal features, sends `SIGTSTP` to the process (the external-signal path, not Ctrl+Z through the
pty), reads the captured bytes, then `SIGCONT` and reads again.

Branch (`--args " -ne"`, extensions disabled so no extension can mask the result):

```
verdict: VERIFIED
  enabled at start:   ['cursor_hide'] kitty=True
  restore on TSTP:    ['cursor_show'] kitty_off=True
  re-enabled on CONT: ['cursor_hide']
  bytes: {'startup': 126887, 'stopped': 26, 'resumed': 126985}
```

Control, same probe against `main` at `2b4e05910` (before these commits):

```
verdict: FAILED
  enabled at start:   ['cursor_hide'] kitty=True
  restore on TSTP:    []  kitty_off=False
  re-enabled on CONT: []
  bytes: {'startup': 7007, 'stopped': 0, 'resumed': 0}
```

Identical startup state, and zero bytes of restore on `main`: the process stops with Kitty keyboard reporting still
enabled and the cursor still hidden, so the shell prompt that follows receives keyboard-protocol bytes. On this branch
the restore sequences are emitted before the stop and re-enabled on `SIGCONT`.

Mouse tracking was not enabled in this configuration (main-screen, no tmux), so the probe could not assert
`?1000l`/`?1006l`; it asserted what the UI had actually enabled. The unit suite covers the TUI-level contract
(`packages/tui/test/suspend-signal.test.ts`).
