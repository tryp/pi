# Compaction scrollback findings

## Finding

The deployed-pi byte probe supports the resize/ED3 path, not compaction alone: at the bottom of the pane, `/compact` emitted ED2=1 and ED3=0, and history grew from 1,210 to 1,432 rows. Widening the pane during compaction emitted ED2=2 and ED3=1; the history then contained the re-rendered post-compaction document. The resize is the condition that reaches the width-change full render. The ED3 removal below therefore fixes the pi-owned destructive resize path; it does not establish that copy-mode compaction is harmless. A real compaction while already in copy mode was not measured in this lane.

This supersedes the width contract introduced by `cf46eb07b`. That contract avoided one duplicate viewport on a width change by erasing the entire scrollback. tmux 3.7c reflows saved history itself: the reusable erase-semantics measurement reports 200 rows becoming 100 after widening an 80-column pane to 110 (`REFLOWS_HISTORY`). Preserving history is the better trade. A width change still re-emits the full document afterwards, so it can still evict old rows at the pane's history limit; removing ED3 does not make resize free.

The low-history-limit real compaction probe (`--history-limit 300`, seeded session, pane at bottom) recorded history 181 -> 182, ED2=0, ED3=0, and `summary_first=true`. This run stayed below the 300-row cap and did not reproduce eviction. The reusable controlled eviction instrument does reproduce the limit: at history-limit 300, baseline 1,000 lines and a 1,450-line render produced 311 captured old rows -> 0, evicted all 311 old rows; the oldest marker moved 311 rows, to the new output. This illustrates why full-document re-renders can still displace history under a low cap. Run it with `python3 scripts/measure_tmux_history_eviction.py --history-limit 300 --baseline-lines 1000 --push-lines 1450 --json`.

To raise the cap for pi panes, change tmux's `history-limit` and recreate the existing pi panes: the option only applies to panes created after the change. This work preserves terminal content/history; it does not fix “selection dropped.” The measured operator pane had no tmux selection in 0/532 samples at 50 ms; the highlight was Konsole's local selection and died on repaint.

## Change and checks

Width-change full renders now archive the departing viewport without ED3, and report full-render reason/dimensions/tmux status to the session as `pi.tui_full_render`. The width regression test asserts no ED3 and retained scrollback.

- `node --test test/tui-main-screen-scrollback.test.ts test/tui-render.test.ts` (from `packages/tui`): 30 passed, 0 failed.
- `npm run check`: failed on existing diagnostics in unrelated files (1 warning, 4 infos); the check auto-fixed unrelated files, which were restored. No change from those files remains in this worktree.
- Real compaction probe: `tmp/compaction-probe-20261122T100732`; low cap 300; history 181 -> 182; ED2=0, ED3=0; summary first.
- Eviction instrument: tmux 3.7c; history-limit 300; old rows 311 -> 0; 311 evicted; top moved 311 rows.
