#!/bin/sh
# Materialize one exact reviewed commit without fetching unrelated history.
set -eu
fail() { echo "FAIL: $*" >&2; exit 1; }
usage() { echo "usage: materialize-host-release-source.sh SOURCE_REPO COMMIT TREE DESTINATION" >&2; exit 2; }
[ "$#" -eq 4 ] || usage
source_repo=$1
commit=$2
tree=$3
destination=$4
export GIT_NO_LAZY_FETCH=1

[ "$(git -C "$source_repo" rev-parse --verify "$commit^{commit}" 2>/dev/null)" = "$commit" ] || fail "reviewed commit object missing locally: $commit"
[ "$(git -C "$source_repo" rev-parse --verify "$commit^{tree}" 2>/dev/null)" = "$tree" ] || fail "reviewed commit tree mismatch"
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "destination already exists"
mkdir -p "$destination"
# Materialize raw tree blobs, not git archive output: archive attributes such as
# export-subst, export-ignore, and EOL conversion must not alter tree contents.
python3 - "$source_repo" "$commit" "$destination" <<'PY'
import os
import subprocess
import sys

source, commit, destination = sys.argv[1:]
entries = subprocess.check_output(
    ["git", "-C", source, "ls-tree", "-rz", "--full-tree", commit]
)
for entry in entries.split(b"\0"):
    if not entry:
        continue
    header, rel = entry.split(b"\t", 1)
    mode, kind, oid = header.decode().split()
    if kind != "blob" or mode not in ("100644", "100755", "120000"):
        raise SystemExit(f"unsupported pinned tree entry: {os.fsdecode(rel)}")
    try:
        data = subprocess.check_output(["git", "-C", source, "cat-file", "blob", oid])
    except subprocess.CalledProcessError:
        raise SystemExit(f"required pinned blob unavailable locally: {os.fsdecode(rel)}")
    path = os.path.join(os.fsencode(destination), rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if mode == "120000":
        os.symlink(os.fsdecode(data), path)
    else:
        with open(path, "xb") as stream:
            stream.write(data)
        os.chmod(path, 0o755 if mode == "100755" else 0o644)
PY
git -C "$destination" init -q
# Reconstruct the exact tree from the raw files, retaining the original tree object ID.
GIT_NO_LAZY_FETCH=1 git -C "$destination" add -A
reconstructed_tree=$(GIT_NO_LAZY_FETCH=1 git -C "$destination" write-tree)
[ "$reconstructed_tree" = "$tree" ] || fail "materialized archive tree mismatch (expected $tree got $reconstructed_tree)"
# The source commit object is copied verbatim; its parents are intentionally not copied.
commit_copy=$(GIT_NO_LAZY_FETCH=1 git -C "$source_repo" cat-file commit "$commit" | GIT_NO_LAZY_FETCH=1 git -C "$destination" hash-object -t commit -w --stdin)
[ "$commit_copy" = "$commit" ] || fail "copied commit object ID mismatch"
GIT_NO_LAZY_FETCH=1 git -C "$destination" update-ref refs/heads/reviewed "$commit"
GIT_NO_LAZY_FETCH=1 git -C "$destination" symbolic-ref HEAD refs/heads/reviewed
GIT_NO_LAZY_FETCH=1 git -C "$destination" read-tree "$commit"
[ "$(GIT_NO_LAZY_FETCH=1 git -C "$destination" rev-parse HEAD)" = "$commit" ] || fail "materialized HEAD does not match reviewed commit"
[ "$(GIT_NO_LAZY_FETCH=1 git -C "$destination" rev-parse HEAD^{tree})" = "$tree" ] || fail "materialized HEAD tree does not match reviewed tree"
[ -z "$(GIT_NO_LAZY_FETCH=1 git -C "$destination" status --porcelain=v1)" ] || fail "materialized source checkout is not clean"
printf 'OK: materialized pinned commit %s tree %s without history fetch\n' "$commit" "$tree"
