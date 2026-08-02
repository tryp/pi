#!/bin/bash
set -euo pipefail

# Sync our fork with upstream mainline.
#
# Today's workflow (dated rebase branches, not single-commit-on-main):
#   1. Fetches the latest upstream (earendil-works/pi-mono, origin/main)
#   2. Tags pre-rebase-YYYY-MM-DD at the current branch tip (rollback point)
#   3. Rebases the local branch (rebase/YYYY-MM-DD) on top of upstream
#   4. Verifies all local commits were preserved (aborts if any were dropped)
#   5. Builds all packages and rsyncs the dist to the local runtime
#   6. Records a deploy event (session_analysis.cli change deploy)
#   7. Pushes the REBASE BRANCH to the fork (never main unless --promote)
#
# Promotion to the fork's mainline is a separate, explicit step that should
# only happen after the rebase has been tested and demonstrated stable:
#   ./sync-upstream.sh --promote
#
# Usage:
#   ./sync-upstream.sh              fetch + rebase + build + deploy + push branch
#   ./sync-upstream.sh --check      fetch + report only, no rebase/build/push
#   ./sync-upstream.sh --skip-build rebase + push, skip build/deploy
#   ./sync-upstream.sh --promote    point local+fork main at the rebased branch
#
# Run from the repo root.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="/home/dev/.pi/local/pi-coding-agent"
FORK_REMOTE="fork"
UPSTREAM_BRANCH="origin/main"
DATE="$(date +%Y-%m-%d)"
PROMOTE=0
CHECK=0
SKIP_BUILD=0

for arg in "$@"; do
    case "$arg" in
        --promote) PROMOTE=1 ;;
        --check) CHECK=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        --help|-h)
            grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30
            exit 0
            ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

cd "$REPO_DIR"

if [ "$PROMOTE" = "1" ]; then
    echo "=== Promoting rebased branch to main ==="
    echo "Current branch: $(git branch --show-current)"
    echo "Main is at:     $(git log --oneline main -1)"
    echo "We are at:      $(git log --oneline HEAD -1)"
    echo ""

    # Safety: refuse to promote a dirty tree
    if [ -n "$(git status --porcelain)" ]; then
        echo "!!! Working tree is dirty. Commit or stash before promoting. Aborting."
        exit 1
    fi

    # Refuse to promote if main has commit SUBJECTS not present in the current
    # branch (would lose work). Rebased commits have new SHAs, so compare
    # subjects, not SHAs. The pre-rebase tag covers the rollback case.
    MISSING="$(comm -23 \
        <(git log --format=%s main | sort) \
        <(git log --format=%s HEAD | sort))"
    if [ -n "$MISSING" ]; then
        echo "!!! main has commit(s) whose subject is not in the current branch:"
        echo "$MISSING" | sed 's/^/    /'
        echo "    Promoting would orphan them. Aborting."
        echo "    If they were intentionally superseded, run: git branch -f main HEAD"
        exit 1
    fi

    if git merge-base --is-ancestor HEAD main; then
        echo "main already contains the current branch tip. Nothing to do."
        exit 0
    fi

    echo "Promoting $(git rev-list --count main..HEAD) commit(s) to main..."
    git branch -f main HEAD
    git checkout main
    echo "=== Pushing main to fork ==="
    git push "$FORK_REMOTE" main
    echo ""
    echo "=== Done ==="
    echo "main is now at: $(git log --oneline main -1)"
    echo "Verify:         git log --oneline origin/main..main"
    exit 0
fi

echo "=== 1. Fetching upstream ($UPSTREAM_BRANCH) ==="
git fetch origin main

echo ""
echo "=== 2. Checking status ==="
echo "Upstream is at:  $(git log --oneline $UPSTREAM_BRANCH -1)"
echo "We are at:       $(git log --oneline HEAD -1)"
echo "Branch:          $(git branch --show-current)"
echo ""

# Already up to date?
if git merge-base --is-ancestor "$UPSTREAM_BRANCH" HEAD; then
    AHEAD="$(git rev-list --count $UPSTREAM_BRANCH..HEAD)"
    if [ "$AHEAD" = "0" ]; then
        echo "Already up to date with upstream (HEAD == upstream). Nothing to do."
        exit 0
    fi
    echo "We are ahead of upstream by $AHEAD commit(s) (nothing to rebase)."
    if [ "$CHECK" = "1" ]; then exit 0; fi
else
    echo "Upstream has commits we don't have. Rebase needed."
    BEHIND="$(git rev-list --count HEAD..$UPSTREAM_BRANCH)"
    AHEAD="$(git rev-list --count $UPSTREAM_BRANCH..HEAD)"
    echo "  Behind:  $BEHIND commit(s) (upstream-only)"
    echo "  Ahead:   $AHEAD commit(s) (local, will be replayed)"
    if [ "$CHECK" = "1" ]; then exit 0; fi

    # Pre-flight: file overlap between local and upstream changes since merge-base
    BASE="$(git merge-base HEAD $UPSTREAM_BRANCH)"
    OVERLAP="$(comm -12 \
        <(git diff --name-only "$BASE"..HEAD | sort) \
        <(git diff --name-only "$BASE"..$UPSTREAM_BRANCH | sort) || true)"
    if [ -n "$OVERLAP" ]; then
        echo ""
        echo "!!! WARNING: file overlap between local and upstream changes:"
        echo "$OVERLAP" | sed 's/^/    /'
        echo "    Conflicts are likely. Resolve them during the rebase."
        if [ "${SYNC_FORCE:-0}" != "1" ]; then
            echo "    Set SYNC_FORCE=1 to proceed anyway."
            exit 1
        fi
    fi

    echo ""
    echo "=== 3. Tagging pre-rebase rollback point ==="
    git tag -f "pre-rebase-$DATE" HEAD
    echo "Tagged: pre-rebase-$DATE -> $(git log --oneline -1 HEAD)"

    echo ""
    echo "=== 4. Rebasing local commits on top of upstream ==="
    git rebase "$UPSTREAM_BRANCH"
    echo "Rebase succeeded."

    echo ""
    echo "=== 5. Verifying local commits preserved ==="
    NEW_AHEAD="$(git rev-list --count $UPSTREAM_BRANCH..HEAD)"
    echo "Local commits after rebase: $NEW_AHEAD (expected: $AHEAD)"
    if [ "$NEW_AHEAD" != "$AHEAD" ]; then
        echo "!!! COMMIT COUNT MISMATCH. Aborting before build/deploy."
        echo "    Restore with: git reset --hard pre-rebase-$DATE"
        exit 1
    fi
    if ! git merge-base --is-ancestor "$UPSTREAM_BRANCH" HEAD; then
        echo "!!! Upstream is not an ancestor of HEAD. Something is wrong. Aborting."
        exit 1
    fi
    echo "Upstream fully contained. All local commits preserved."
fi

# Build + deploy unless skipped
if [ "$SKIP_BUILD" = "1" ]; then
    echo ""
    echo "=== 6. Skipping build/deploy (--skip-build) ==="
else
    echo ""
    echo "=== 6. Building all packages ==="
    (cd packages/tui && npm run build)
    (cd packages/ai && npm run build)
    (cd packages/agent && npm run build)
    (cd packages/coding-agent && npm run build)

    echo ""
    echo "=== 7. Deploying to local runtime ==="
    rsync -a packages/coding-agent/dist/ "$LOCAL_DIR/dist/"
    rsync -a packages/agent/dist/ \
        "$LOCAL_DIR/node_modules/@earendil-works/pi-agent-core/dist/"
    rsync -a packages/ai/dist/ \
        "$LOCAL_DIR/node_modules/@earendil-works/pi-ai/dist/"
    rsync -a packages/tui/dist/ \
        "$LOCAL_DIR/node_modules/@earendil-works/pi-tui/dist/"

    # Record deploy event (best-effort; session_analysis lives in another repo)
    if command -v python3 >/dev/null 2>&1 \
        && [ -d /home/dev/src/pi-session-analysis/session_analysis ]; then
        (cd /home/dev/src/pi-session-analysis && python3 -m session_analysis.cli change deploy \
            --description "pi-core: sync upstream to $(git log --oneline $UPSTREAM_BRANCH -1 | cut -c1-9) — $NEW_AHEAD local commits preserved" \
            >/dev/null 2>&1) || echo "    (deploy event recording skipped)"
    fi
fi

echo ""
echo "=== 8. Pushing rebase branch to fork ==="
BRANCH="$(git branch --show-current)"
if [ "$BRANCH" = "main" ]; then
    echo "!!! On main. The script does not push main without --promote."
    echo "    Push manually if intended: git push $FORK_REMOTE main"
else
    git push "$FORK_REMOTE" "$BRANCH" --force-with-lease
    echo "Pushed: $FORK_REMOTE/$BRANCH"
fi

echo ""
echo "=== Done ==="
echo "Fork branch synced. Runtime rebuilt. pi is at: $(pi --version 2>/dev/null || echo 'check manually')"
echo ""
echo "Next steps:"
echo "  1. Test the rebased build (smoke test, regressions)"
echo "  2. Once stable: ./sync-upstream.sh --promote"
