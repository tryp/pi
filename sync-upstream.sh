#!/bin/bash
set -e

# Sync our fork with upstream mainline.
#
# Our fix is kept as a single commit on main. This script:
# 1. Fetches the latest upstream (earendil-works/pi-mono)
# 2. Rebases our fix(es) on top
# 3. Pushes to our fork (tryp/pi-mono)
# 4. Rebuilds the dist and updates the local runtime
#
# Run from the repo root: ./sync-upstream.sh

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="/home/dev/.pi/local/pi-coding-agent"

cd "$REPO_DIR"

echo "=== 1. Fetching upstream (origin/main) ==="
git fetch origin main

echo ""
echo "=== 2. Checking status ==="
echo "Upstream is at:  $(git log --oneline origin/main -1)"
echo "We are at:       $(git log --oneline HEAD -1)"
echo ""

# Check if we're already up to date
if git merge-base --is-ancestor origin/main HEAD && [ "$(git rev-parse origin/main)" = "$(git rev-parse HEAD)" ]; then
    echo "Already up to date with upstream."
elif git merge-base --is-ancestor origin/main HEAD; then
    echo "We are ahead of upstream (good, nothing to rebase)."
else
    echo "=== 3. Rebasing our commit(s) on top of upstream ==="
    echo "Commits that will be rebased:"
    git log --oneline origin/main..HEAD
    echo ""

    if ! git rebase origin/main; then
        echo ""
        echo "!!! CONFLICT !!!"
        echo "Upstream changed one of the same files we patched."
        echo "Resolve conflicts, then run:"
        echo "  git add <resolved-files>"
        echo "  git rebase --continue"
        echo "  git push fork main --force-with-lease"
        echo "  $LOCAL_DIR/rebuild.sh"
        exit 1
    fi
fi

echo ""
echo "=== 4. Pushing to fork ==="
git push fork main --force-with-lease

echo ""
echo "=== 5. Rebuilding local runtime ==="
if [ -x "$LOCAL_DIR/rebuild.sh" ]; then
    "$LOCAL_DIR/rebuild.sh"
else
    echo "WARNING: Local runtime rebuild script not found at $LOCAL_DIR/rebuild.sh"
fi

echo ""
echo "=== Done ==="
echo "Fork is synced. pi is at: $(pi --version 2>/dev/null || echo 'check manually')"
