# Experimental Linux flock generation leases

This is an experimental, opt-in extension-loader backend, not a generally supported or normally packaged feature. It acquires `flock(LOCK_SH)` directly in the Node process and returns an N-API object guarded by a unique type tag before any native handle unwrap. The descriptor uses `O_CLOEXEC`; the handle's finalizer closes it on process exit/GC, and explicit release is idempotent. Acquisition errors and invalid release handles throw. Linux `close()` is not retried after `EINTR` because the descriptor is already considered closed there. The shared-only API can pair with a collector that separately uses `flock(LOCK_EX)`. Managed extension generation leases are disabled by default. Set `PI_EXPERIMENTAL_NATIVE_EXTENSION_LEASE=1` only when using a locally built, verified Linux x64 Node-API 8 package; marked managed extensions otherwise fail clearly instead of loading without a lease.

Run on Linux with a C++ compiler, `flock`, and Node development headers:

```sh
node --test packages/coding-agent/test/native/flock-lease.node-test.mjs
```

Set `NODE_INCLUDE_DIR` if headers are not in `/usr/include/node` or `/usr/local/include/node`. The test compiles temporary `.node` addons and removes them afterward. The tests include foreign-addon external rejection, excess-argument rejection, forced GC while a handle is reachable and after it becomes unreachable, symlink/hard-link rejection, fork-only descriptor inheritance, and fork-plus-exec close-on-exec behavior.

## Optional local packaging prototype

The normal build and package remain cross-platform and do not compile or ship this native addon. For an experimental local Linux x64 package artifact, run `npm run build:native-extension-lease` from `packages/coding-agent`, then `npm run pack:native-extension-lease -- --pack-destination /path/to/output`. Enable loader activation only with `PI_EXPERIMENTAL_NATIVE_EXTENSION_LEASE=1`. The build writes only to ignored `native-artifacts/linux-x64`, outside the package files whitelist. The opt-in pack command copies whitelisted package files and the verified addon into a private temporary package tree, then runs `npm pack --ignore-scripts` there; it never mutates shared `dist`. The ordinary package whitelist structurally excludes `dist/native/linux-x64`, including with `npm pack --ignore-scripts`, so stale artifacts cannot leak into a default pack. The same explicit build flag is available for local runtime staging: `make deploy NATIVE_EXTENSION_LEASE=1`. Default deploy excludes any legacy `dist/native/linux-x64` output. The manifest records Node-API 8, target, source SHA-256, and artifact SHA-256; staging and load verification reject missing, altered, or incompatible artifacts. No live install compilation or normal release packaging/deployment support is claimed.

The build target intentionally rejects non-Linux or non-x64 hosts. It does not claim arm64, macOS, Windows, or Bun support. Node-API 8 is compiled against local Node headers; the addon was exercised with Node 26.2.0, while the project runtime floor is Node >=22.19.0. This prototype has not established an oldest-Node test matrix or a portable glibc floor: the compiled artifact may require the glibc version of its build host or newer. Keep it local-only until matching CI builds verify supported Node versions and an explicit glibc baseline. Never compile native code at live startup or silently fall back to an unleased managed import.

Packaging regression test (Linux x64 with Node headers, g++, npm, and tar):

```sh
node --test scripts/native-extension-lease.node-test.mjs
```
It synchronizes concurrent ordinary `npm pack --ignore-scripts` and isolated opt-in packing behind a barrier, inspects both tarballs, and also checks an ordinary pack after opt-in while stale bytes remain in the source workspace. It verifies and loads the unpacked opt-in bytes, rejects missing/corrupt/unsupported artifacts, and mutates the ELF `e_machine` field to exercise rejection of an AArch64-marked fixture. The latter is a wrong-architecture ELF-header fixture, not a genuine AArch64 compiled binary.

## Lock-path trust assumptions and limits

Acquisition applies `O_NOFOLLOW` to the final path component and verifies with `fstat()` that it is a regular file with link count exactly one. Parent directories and path components are assumed to be trusted and not writable by an attacker; intermediate symlinks are not prohibited by `O_NOFOLLOW`. These checks do not prevent replacement or rename of the stable lock pathname after acquisition. A test demonstrates that replacing that path makes later lockers open a different inode, while the existing lease still holds the old inode. Correct coordination therefore requires the trusted publisher/collector to preserve the stable lock inode and never replace/unlink it. `O_CLOEXEC` closes the descriptor on exec, not on fork alone: a fork-only child inherits the descriptor and continues holding the shared flock until it exits/closes it. Neither behavior is a security boundary against malicious same-UID native code.
