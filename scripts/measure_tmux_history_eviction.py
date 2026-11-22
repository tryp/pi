#!/usr/bin/env python3
"""Measure how much old pane history a later render evicts at a given limit.

Each run creates a uniquely named private tmux server, writes numbered baseline
rows, snapshots the complete pane history, then writes a second numbered batch.
It reports old rows evicted and how far the oldest surviving history moved.
The default push size (1450) models a full document redraw after compaction.

Examples:
  python3 scripts/measure_tmux_history_eviction.py
  python3 scripts/measure_tmux_history_eviction.py --history-limit 300 --baseline-lines 1000 --push-lines 1450 --json
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass


@dataclass
class Measurement:
    tmux_version: str
    history_limit: int
    pane_width: int
    pane_height: int
    baseline_lines_requested: int
    lines_pushed: int
    old_rows_before: int
    old_rows_after: int
    new_rows_after: int
    evicted_old_rows: int
    top_before: str | None
    top_after: str | None
    top_moved_rows: int
    captured_rows_before: int
    captured_rows_after: int
    history_size_before: int
    history_size_after: int
    effective_history_limit: int


class PrivateTmux:
    def __init__(self) -> None:
        self.server = f"pi-history-eviction-{uuid.uuid4().hex[:10]}"

    def __call__(self, *args: str) -> str:
        proc = subprocess.run(
            ["tmux", "-L", self.server, *args],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode:
            raise RuntimeError(f"tmux {args}: {proc.stderr.strip()}")
        return proc.stdout.rstrip("\n")

    def capture(self) -> str:
        return self("capture-pane", "-p", "-S", "-", "-t", "probe:0.0")

    def send_request(self, tag: str, count: int) -> None:
        self("send-keys", "-l", "-t", "probe:0.0", f"{tag} {count}")
        self("send-keys", "-t", "probe:0.0", "Enter")
        marker = f"DONE-{tag}"
        for _ in range(500):
            if marker in self.capture():
                return
            time.sleep(0.01)
        raise TimeoutError(f"pane did not finish writing {count} {tag} rows")

    def kill(self) -> None:
        subprocess.run(["tmux", "-L", self.server, "kill-server"], capture_output=True, check=False)


def markers(text: str, prefix: str) -> list[tuple[int, str]]:
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d{{6}})$")
    rows: list[tuple[int, str]] = []
    for line in text.splitlines():
        match = pattern.fullmatch(line.strip())
        if match:
            rows.append((int(match.group(1)), match.group(0)))
    return rows


def measure(args: argparse.Namespace) -> Measurement:
    tmux = PrivateTmux()
    try:
        # Keep the private server alive while configuring its global window option.
        tmux("new-session", "-d", "-s", "config", "sleep", "60")
        tmux("set-option", "-gw", "history-limit", str(args.history_limit))
        code = (
            "import sys\n"
            "print('READY', flush=True)\n"
            "for request in sys.stdin:\n"
            "    tag, count = request.split()\n"
            "    for i in range(1, int(count) + 1): print(f'{tag}-{i:06d}')\n"
            "    print(f'DONE-{tag}', flush=True)\n"
        )
        producer = "stty -echo; exec python3 -u -c " + shlex.quote(f"import sys; exec({code!r})")
        tmux("new-session", "-d", "-s", "probe", "-x", str(args.width), "-y", str(args.height), producer)
        for _ in range(500):
            if "READY" in tmux.capture():
                break
            time.sleep(0.01)
        else:
            raise TimeoutError("pane producer did not become ready")

        tmux.send_request("old", args.baseline_lines)
        before = tmux.capture()
        before_rows = markers(before, "old")
        history_before = int(tmux("display-message", "-p", "-t", "probe:0.0", "#{history_size}"))
        if not before_rows:
            raise RuntimeError("baseline rows were not present in capture-pane output")

        tmux.send_request("new", args.push_lines)
        after = tmux.capture()
        history_after = int(tmux("display-message", "-p", "-t", "probe:0.0", "#{history_size}"))
        old_after = markers(after, "old")
        new_after = markers(after, "new")
        evicted = len(before_rows) - len(old_after)
        top_before = before_rows[0][1]
        top_after = old_after[0][1] if old_after else (new_after[0][1] if new_after else None)
        if old_after:
            top_moved = old_after[0][0] - before_rows[0][0]
        else:
            top_moved = len(before_rows)
        version = subprocess.run(["tmux", "-V"], capture_output=True, text=True, check=True).stdout.strip()
        return Measurement(
            tmux_version=version,
            history_limit=args.history_limit,
            pane_width=args.width,
            pane_height=args.height,
            baseline_lines_requested=args.baseline_lines,
            lines_pushed=args.push_lines,
            old_rows_before=len(before_rows),
            old_rows_after=len(old_after),
            new_rows_after=len(new_after),
            evicted_old_rows=evicted,
            top_before=top_before,
            top_after=top_after,
            top_moved_rows=top_moved,
            captured_rows_before=len(before.splitlines()),
            captured_rows_after=len(after.splitlines()),
            history_size_before=history_before,
            history_size_after=history_after,
            effective_history_limit=args.history_limit,
        )
    finally:
        tmux.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history-limit", type=int, default=2000)
    parser.add_argument("--baseline-lines", type=int, default=1000)
    parser.add_argument("--push-lines", type=int, default=1450)
    parser.add_argument("--width", type=int, default=120)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if min(args.history_limit, args.baseline_lines, args.push_lines, args.width, args.height) < 1:
        parser.error("history limit, line counts, and pane dimensions must be positive")
    try:
        result = measure(args)
    except (RuntimeError, TimeoutError) as error:
        parser.exit(1, f"error: {error}\n")
    if args.json:
        print(json.dumps(asdict(result), indent=2))
    else:
        print(f"tmux: {result.tmux_version}; pane {result.pane_width}x{result.pane_height}; history-limit={result.history_limit}")
        print(f"lines pushed: {result.lines_pushed}")
        print(f"numbered rows: old {result.old_rows_before} -> {result.old_rows_after}; new present={result.new_rows_after}; old evicted={result.evicted_old_rows}")
        print(f"oldest history marker: {result.top_before} -> {result.top_after}; moved={result.top_moved_rows} rows")
        print(f"capture-pane rows: {result.captured_rows_before} -> {result.captured_rows_after}")
        print(f"tmux history_size: {result.history_size_before} -> {result.history_size_after}; configured limit={result.effective_history_limit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
