#!/usr/bin/env python3
"""Durably publish a staged directory without replacing an existing path."""
import ctypes
import errno
import os
import stat
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: publish-host-release.py STAGE RELEASE")

stage = os.path.abspath(sys.argv[1])
release = os.path.abspath(sys.argv[2])
parent = os.path.dirname(release)
if os.path.dirname(stage) != parent:
    raise SystemExit("stage and release must share a parent directory")
if os.path.islink(stage) or not os.path.isdir(stage):
    raise SystemExit("stage must be a real directory")

# Reject symlinks (including dangling links) rather than relying on checksum
# behavior, which otherwise follows links outside the release tree.
directories = []
for root, dirs, files in os.walk(stage, topdown=True, followlinks=False):
    directories.append(root)
    for name in dirs + files:
        path = os.path.join(root, name)
        if stat.S_ISLNK(os.lstat(path).st_mode):
            raise SystemExit(f"symlink in release tree: {path}")
    for name in files:
        path = os.path.join(root, name)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

# Persist child directory entries before the stage root can be published.
for path in reversed(directories):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit("renameat2 is unavailable; refusing non-atomic publication")
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(-100, os.fsencode(stage), -100, os.fsencode(release), 1)  # RENAME_NOREPLACE
if result != 0:
    error = ctypes.get_errno()
    if error == errno.EEXIST:
        raise SystemExit(f"release path already exists; refusing overwrite: {release}")
    raise OSError(error, os.strerror(error), release)

try:
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
except OSError as error:
    # The rename already committed. Exit 3 tells callers not to report a clean
    # failure/rollback: the release exists, but directory durability is unknown.
    print(f"COMMITTED-BUT-UNCERTAIN: release published at {release}, parent fsync failed: {error}", file=sys.stderr)
    raise SystemExit(3)
