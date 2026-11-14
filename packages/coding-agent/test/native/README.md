# Linux flock lease prototype

This is an isolated test prototype, not a production extension-loader backend. It acquires `flock(LOCK_SH)` directly in the Node process and returns a native external handle. The descriptor uses `O_CLOEXEC`; the handle's finalizer closes it on process exit/GC, and explicit release is idempotent. Acquisition errors and invalid release handles throw. Linux `close()` is not retried after `EINTR` because the descriptor is already considered closed there.

Run on Linux with a C++ compiler, `flock`, and Node development headers:

```sh
node --test packages/coding-agent/test/native/flock-lease.test.mjs
```

Set `NODE_INCLUDE_DIR` if headers are not in `/usr/include/node` or `/usr/local/include/node`. The test compiles a temporary `.node` addon and removes it afterward.

## Packaging is not enabled

Do not load this prototype from the extension loader. It is not wired into the package build, bundle, published files, or deployment artifact. The current coding-agent package's normal build emits JS bundles and copies assets; no Linux addon build/prebuilt-artifact matrix is established. The package supports Node across multiple platforms and architectures (`node >=22.19.0`), while this prototype has only been compiled and exercised on Linux x64 with the local Node 26.2.0 headers, targeting Node-API 8. Node-API's ABI stability does not provide OS/architecture binaries or verify the supported runtime matrix. Therefore adding it to build/deploy or routing managed extensions through it is blocked pending a deliberate Linux target matrix and artifact packaging/release design. Missing binaries must remain fail-closed when a production loader integration is later implemented.
