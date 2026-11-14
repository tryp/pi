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
# Only objects already available locally may satisfy this pin. Capture the
# archive first so an archive failure cannot be hidden by a successful tar.
archive="$destination/.source-archive.tar"
git -C "$source_repo" archive --format=tar "$commit" > "$archive" || fail "cannot archive pinned commit from locally available objects"
tar -xf "$archive" -C "$destination" || fail "cannot extract pinned source archive"
rm -f "$archive"
git -C "$destination" init -q
# Reconstruct the exact tree from the archive, retaining the original tree object ID.
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
