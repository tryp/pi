# Linux flock lease prototype

This is an isolated test prototype, not a production extension-loader backend. It acquires `flock(LOCK_SH)` directly in the Node process and returns an N-API object guarded by a unique type tag before any native handle unwrap. The descriptor uses `O_CLOEXEC`; the handle's finalizer closes it on process exit/GC, and explicit release is idempotent. Acquisition errors and invalid release handles throw. Linux `close()` is not retried after `EINTR` because the descriptor is already considered closed there. The shared-only API can pair with a collector that separately uses `flock(LOCK_EX)`.

Run on Linux with a C++ compiler, `flock`, and Node development headers:

```sh
node --test packages/coding-agent/test/native/flock-lease.test.mjs
```

Set `NODE_INCLUDE_DIR` if headers are not in `/usr/include/node` or `/usr/local/include/node`. The test compiles temporary `.node` addons and removes them afterward. The tests include foreign-addon external rejection, excess-argument rejection, forced GC while a handle is reachable and after it becomes unreachable, symlink/hard-link rejection, fork-only descriptor inheritance, and fork-plus-exec close-on-exec behavior.

## Packaging is not enabled

Do not load this prototype from the extension loader. It is not wired into the package build, bundle, published files, or deployment artifact. The current coding-agent package's normal build emits JS bundles and copies assets; no Linux addon build/prebuilt-artifact matrix is established. The package supports Node across multiple platforms and architectures (`node >=22.19.0`), while this prototype has only been compiled and exercised on Linux x64 with the local Node 26.2.0 headers, targeting Node-API 8. Node-API's ABI stability does not provide OS/architecture binaries or verify the supported runtime matrix. Therefore adding it to build/deploy or routing managed extensions through it is blocked pending a deliberate Linux target matrix and artifact packaging/release design. Missing binaries must remain fail-closed when a production loader integration is later implemented.

## Lock-path trust assumptions and limits

Acquisition applies `O_NOFOLLOW` to the final path component and verifies with `fstat()` that it is a regular file with link count exactly one. Parent directories and path components are assumed to be trusted and not writable by an attacker; intermediate symlinks are not prohibited by `O_NOFOLLOW`. These checks do not prevent replacement or rename of the stable lock pathname after acquisition. A test demonstrates that replacing that path makes later lockers open a different inode, while the existing lease still holds the old inode. Correct coordination therefore requires the trusted publisher/collector to preserve the stable lock inode and never replace/unlink it. `O_CLOEXEC` closes the descriptor on exec, not on fork alone: a fork-only child inherits the descriptor and continues holding the shared flock until it exits/closes it. Neither behavior is a security boundary against malicious same-UID native code.
