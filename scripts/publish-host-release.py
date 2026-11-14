#!/usr/bin/env python3
"""Atomically publish a staged directory without replacing any existing path."""
import ctypes
import errno
import os
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: publish-host-release.py STAGE RELEASE")

libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit("renameat2 is unavailable; refusing non-atomic publication")
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1)  # RENAME_NOREPLACE
if result != 0:
    error = ctypes.get_errno()
    if error == errno.EEXIST:
        raise SystemExit(f"release path already exists; refusing overwrite: {sys.argv[2]}")
    raise OSError(error, os.strerror(error), sys.argv[2])
