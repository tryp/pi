#!/usr/bin/env python3
"""Durably publish a staged directory without replacing an existing path."""
import ctypes
import errno
import hashlib
import json
import os
import re
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

# Validate that the authenticated checksum index describes every payload file,
# and only payload files. Never follow links or accept multiple names for one inode.
manifest_path = os.path.join(stage, ".host-release.json")
sums_path = os.path.join(stage, "SHA256SUMS")
for path in (manifest_path, sums_path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise SystemExit(f"release metadata must be an unlinked regular file: {path}")
with open(manifest_path, "rb") as stream:
    metadata_bytes = stream.read()
with open(sums_path, "rb") as stream:
    sums_bytes = stream.read()
try:
    metadata = json.loads(metadata_bytes)
except (UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid release manifest: {error}")
if metadata.get("checksumsSha256") != hashlib.sha256(sums_bytes).hexdigest():
    raise SystemExit("release checksum index digest mismatch")
expected = {}
for line in sums_bytes.decode("utf-8").splitlines():
    match = re.fullmatch(r"([0-9a-f]{64})  (\./.+)", line)
    if not match:
        raise SystemExit("unsafe or malformed checksum entry")
    relative = match.group(2)[2:]
    parts = relative.split("/")
    if (not relative or "\\" in relative or any(part in ("", ".", "..") for part in parts)
            or any(ord(char) < 32 or ord(char) == 127 for char in relative)):
        raise SystemExit(f"unsafe checksum path: {relative}")
    if relative in (".host-release.json", "SHA256SUMS") or relative in expected:
        raise SystemExit(f"duplicate or forbidden checksum path: {relative}")
    expected[relative] = match.group(1)

directories = []
actual = set()
for root, dirs, files in os.walk(stage, topdown=True, followlinks=False):
    directories.append(root)
    for name in dirs + files:
        path = os.path.join(root, name)
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"symlink in release tree: {path}")
        if name in dirs:
            if not stat.S_ISDIR(info.st_mode):
                raise SystemExit(f"non-directory in release tree: {path}")
            continue
        relative = os.path.relpath(path, stage)
        if not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"non-regular file in release tree: {path}")
        if info.st_nlink != 1:
            raise SystemExit(f"hardlink in release tree: {path}")
        if relative not in (".host-release.json", "SHA256SUMS"):
            actual.add(relative)
            digest = hashlib.sha256()
            with open(path, "rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if expected.get(relative) != digest.hexdigest():
                raise SystemExit(f"release checksum mismatch or unlisted file: {relative}")
if actual != set(expected):
    raise SystemExit("release file inventory does not exactly match checksum manifest")

for root, dirs, files in os.walk(stage, topdown=True, followlinks=False):
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
