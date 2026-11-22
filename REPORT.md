# Lane B report: tmux selection / main-screen redraws

## Conclusion

The reported **selection drop is tmux-side, not caused by Pi redraws**. Under tmux 3.7c, the selection flag survives ED2, ED3, in-place output, and history-limit trimming; a pane geometry change clears it. The operator's three clients (186, 151, 151 columns) with `window-size latest` reproduce the loss when activity on another client resizes the pane from 151x57 to 186x57 (selection 1 -> 0). With `window-size largest`, the pane remains 186x57 and the selection survives (1 -> 1).

Pi has no DECSLPP (`ESC[8;...t`) emission, `stty` invocation, or tmux resize command in the TUI/interactive source. The only Pi `tmux` calls found are read-only capability/keyboard-option queries (`display-message` and `show -gv`). Thus Pi cannot prevent tmux from clearing a selection on a geometry change, and this change is **not** claimed to fix that report.

The renderer change below is limited to **content preservation**: a full content redraw no longer erases the old visible viewport while tmux is in copy-mode. It moves those rows into history before painting replacement content. Width changes still intentionally clear wrapped history.

## Measurements

Private tmux servers only; tmux 3.7c, 80x20 probes unless noted. For selection tests, `#{selection_present}` alone is insufficient: it stayed `1` even when the selected row text was erased. The mouse probe also inspected the selected row/copy buffer and client reverse-video output.

| Write/event | Measured result |
|---|---|
| Incremental in-place rewrite of selected cells | Selection flag stays `1`, but the selected text changes to the new line (the mouse probe's periodic status redraw replaced `SELECTABLE-LINE-080` with `PI-LIKE-STATUS-0017`). This is content replacement, not a tmux selection drop. Writes outside the selected cells leave the selected text intact. |
| Scrolling appends | In the parent history measurement, 200 -> 201 captured nonempty lines, APPEND_ONLY; selection flag stayed `1`. In a fresh mouse trial with 20 appended rows, the selected buffer text remained `CTABLE-LINE-087-abcdefghijklmnopqrstuvwxyz`; current pane row advanced to `APPEND-LINE-009`. At the history limit tmux re-points the anchor (LINE-127 -> LINE-187) while keeping the selection flag. |
| ED2 (`ESC[2J ESC[H`), pane at bottom | 200 -> 201 lines; visible rows are pushed into history; selection flag `1`. |
| ED2, pane in copy-mode | 200 -> 182 lines (18-row visible screenful lost); selection flag nevertheless `1`. Selected text can therefore disappear without the selection object being cleared. |
| ED3 (`ESC[3J`) | 200 -> 20 lines; all history erased; selection flag remains `1`. Pi's only source emitter is the main-screen width-change path. |
| Synchronized-output bracket plus cursor moves above selection, no cell writes | Mouse probe copy buffer retained `CTABLE-LINE-087-abcdefghijklmnopqrstuvwxyz`; selection flag `1`. Cursor motion/bracketing alone does not drop it. |
| Pane width/height change | Selection flag becomes `0`. Reproduced independently of Pi; specifically the second client caused 151x57 -> 186x57 under `window-size latest`. |

The parent's additional selection-specific measurement and the local mouse probes agree: text may mutate/vanish while `selection_present=1`; only pane geometry change cleared the selection flag.

## Pi-side redraw measurements

- Built Pi from this worktree and ran it in a private tmux pane (`80x20`, regular TUI, `PI_DEBUG_REDRAW=1`, `PI_OFFLINE=1`, faux provider; no network). During a 60-second streaming response, debug output contained only the startup `first render` event: 1 full render total, **0 additional full renders / 0 per second during streaming**. The turn had produced 33 response lines by the 60-second capture.
- Ran a `ProcessTerminal`/`TuiMainScreen` stream-and-shrink probe in a separate private tmux server. It appended 12 updates at 250ms intervals (3 seconds), then replaced 111 rows with a six-line compaction-like summary. Debug events: `first render (prev=0, new=100, height=19)` and exactly one shrink redraw, `firstChanged < viewportTop (0 < 92) (prev=111, new=6, height=19)`. Thus streaming rate was 0 full redraws/s; the compaction-like replacement caused 1 full redraw for that transaction (2 events total including startup).
- A real Pi faux-provider mouse-selection run held the selected row during streaming: `selection_established=True`, `selection_present_during_hold=True`, and row text stayed `Streaming output line 008 keeps the selected previous text stable.` A renderer stream-and-shrink mouse probe likewise retained the selected copy buffer text `CTABLE-LINE-089-abcdefghijklmnopqrstuvwxyz` through the shrink redraw (`selection_present=True`).

## Change

`packages/tui/src/tui-main-screen.ts`: for non-width full redraws with previous content, position at the bottom row, emit `\r\n` once per viewport row to scroll the old viewport into history, then home and render the replacement. Do not send ED2/ED3 on this content-redraw path. Width change remains the sole ED3 path.

Tests updated:
- `packages/tui/test/tui-main-screen-scrollback.test.ts`: byte-level assertion forbids ED2/ED3 on a content redraw, requires bottom-row newline scrolling, and verifies the formerly visible last row is now in scrollback.
- `packages/tui/test/tui-render.test.ts`: unsafe Kitty-image fallback now verifies old rows are scrolled into history rather than erased with ED2.

This preserves text/history and prevents ED2 from blanking the visible screenful when copy-mode is active. It does not suppress content changes to cells Pi actually updates (e.g. a spinner occupying the selected cells), and it does not affect tmux's geometry-triggered selection reset.

## Validation

- `npm test` in `packages/tui`: exit 0. Independent spec reporter: 932 tests, 932 pass, 0 fail, 0 skipped.
- `npm run build` in `packages/tui`: exit 0.
- `npm run build` in `packages/coding-agent` with the worktree's TUI package linked: exit 0; built the runtime bundle for the private Pi probe.
- Mutation check: temporarily restored the pre-change ED2 full-render path and ran `node --test test/tui-main-screen-scrollback.test.ts`; exit 1, failing the full-redraw regression with `content redraw must not erase the visible viewport`. Restored the change; focused tests pass 3/3.
- Private tmux probe with actual `TuiMainScreen` streaming plus shrink: selection established and selected text retained across the replacement redraw. Private tmux Pi faux-provider streaming probe also retained the selected output row.
- `git diff --check`: clean.
- LSP diagnostics report missing Node typings (`node:*`, `process`) for this worktree plus pre-existing strict undefined warnings in `tui-render.test.ts`; package build and tests pass. No fix was made for this unrelated workspace/LSP setup issue.
- An exploratory monorepo-root `npm run build` failed at untouched `packages/server/src/protocol.ts:59` (`TS2344`, `false` does not satisfy `true`); the touched package and coding-agent build commands above pass.

## Operator repro and mitigation

One-line monitor during reproduction: `python3 /home/dev/src/pi-session-analysis/scripts/tmux_selection_watch.py --seconds 180`. Reproduce with two clients attached at different widths, select text in copy-mode on one, and cause activity/resize from the other. Watch selection and pane geometry transitions together.

Mitigate on the tmux side: `tmux set -g window-size largest`, enable `aggressive-resize on`, or detach the other differently-sized client. The default `window-size latest` lets whichever client most recently changes size drive the shared pane geometry.

## Residual risks

- Width changes still intentionally clear history because prior wrapped rows are no longer readable; tmux also resets a copy-mode selection on pane resize before Pi can react.
- Incremental writes that replace the selected cells can change the text beneath a still-present selection. The renderer cannot query tmux copy-mode state or know which cells an operator selected.
- Do not describe this patch as fixing the selection-drop report; its scope is preserving old viewport text across Pi content redraws.
