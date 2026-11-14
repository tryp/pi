# Linux flock lease prototype

This is an isolated test prototype, not a production extension-loader backend. It acquires `flock(LOCK_SH)` directly in the Node process and returns an N-API object guarded by a unique type tag before any native handle unwrap. The descriptor uses `O_CLOEXEC`; the handle's finalizer closes it on process exit/GC, and explicit release is idempotent. Acquisition errors and invalid release handles throw. Linux `close()` is not retried after `EINTR` because the descriptor is already considered closed there. The shared-only API can pair with a collector that separately uses `flock(LOCK_EX)`.

Run on Linux with a C++ compiler, `flock`, and Node development headers:

```sh
node --test packages/coding-agent/test/native/flock-lease.test.mjs
```

Set `NODE_INCLUDE_DIR` if headers are not in `/usr/include/node` or `/usr/local/include/node`. The test compiles temporary `.node` addons and removes them afterward. The tests include foreign-addon external rejection, excess-argument rejection, forced GC while a handle is reachable and after it becomes unreachable, symlink/hard-link rejection, fork-only descriptor inheritance, and fork-plus-exec close-on-exec behavior.

## Packaging is not enabled

Do not load this prototype from the extension loader. It is not wired into the package build, bundle, published files, or deployment artifact. Inspection of `packages/coding-agent/package.json` shows the normal build is TypeScript plus an esbuild JS bundle; `files` ships `dist`, but there is no addon build step. `scripts/deploy-runtime.sh` copies `dist` and validates JS entrypoints only. `scripts/build-binaries.sh` supports linux-x64 and linux-arm64 for Bun executables and explicitly copies existing native modules for other features, but has no Node addon build/copy step; its release workflow builds on ubuntu-latest and cross-targets Bun binaries. The npm package is platform-generic and declares `node >=22.19.0`; the N-API prototype has only been compiled and exercised on Linux x64 with local Node 26.2.0 headers, targeting Node-API 8. Node-API ABI stability does not provide OS/architecture artifacts or prove Bun compatibility.

Packaging and loader integration are therefore blocked. No managed-loader failure behavior was added or claimed: only direct missing-addon `require()` failure is tested. Before loader routing, establish a Node-only target policy (at minimum decide Linux x64 and arm64 coverage), build per-architecture prebuilt `.node` artifacts on matching Linux CI runners using Node-API 8 and the oldest supported Node headers, verify the glibc baseline and Node 22/latest runtimes, include those artifacts in npm `dist` and the staged runtime, and add artifact-presence/load smoke gates. Do not compile native code in a live runtime or silently fall back to an unleased managed import. If non-Linux or Bun hosts are in scope, separately prove support or fail managed loading there. Missing/incompatible artifacts must produce an explicit fail-closed error in the eventual loader.

## Lock-path trust assumptions and limits

Acquisition applies `O_NOFOLLOW` to the final path component and verifies with `fstat()` that it is a regular file with link count exactly one. Parent directories and path components are assumed to be trusted and not writable by an attacker; intermediate symlinks are not prohibited by `O_NOFOLLOW`. These checks do not prevent replacement or rename of the stable lock pathname after acquisition. A test demonstrates that replacing that path makes later lockers open a different inode, while the existing lease still holds the old inode. Correct coordination therefore requires the trusted publisher/collector to preserve the stable lock inode and never replace/unlink it. `O_CLOEXEC` closes the descriptor on exec, not on fork alone: a fork-only child inherits the descriptor and continues holding the shared flock until it exits/closes it. Neither behavior is a security boundary against malicious same-UID native code.
