# Managed runtime generation protocol

This protocol lets a host process keep using one immutable runtime generation while a deployer publishes a newer generation. The managed bootstrap directory contains `managed-runtime.json`, which makes the host fail closed if its launcher omits `PI_RUNTIME_GENERATION_ROOT`; the launcher must set that variable to the managed root. `PI_RUNTIME_MANAGED=1` also forces managed mode. A missing or invalid protocol state is a hard startup error; the host never falls back to importing from the unversioned runtime path.

## Layout

```text
<root>/
  bootstrap/cli.js            # stable launcher, outside every generation
  bootstrap/rpc-entry.js      # stable RPC launcher, outside every generation
  bootstrap/runtime-bootstrap-child.js # stable Node-only lease child
  bootstrap/chunks/            # all bundle chunks required by CLI/RPC bootstrap
  bootstrap/managed-runtime.json # marker: never start this launcher unmanaged
  active.json                 # atomically replaced by the deployer
  .publish.lock               # deployer-only publication serialization
  generations/<id>/
    generation.json           # {"protocol":1,"entry":"bundle/runtime-entry.js"}
    .lease.lock               # created before publication; never replace while active
    ...                       # complete immutable runtime, including runtime-only files
```

`active.json` has shape `{"protocol":1,"generation":"generations/<id>"}`. IDs must be a single safe path component. The host resolves the active record and validates both manifests and the entry path before importing application code. It then starts the child through `flock -F -s <generation>/.lease.lock`; `-F` makes the application process itself retain the kernel lock for its lifetime. The child revalidates the generation after acquiring the lock and verifies that the selected descriptor's `/proc/self/fdinfo` entry reports an active shared `FLOCK` lock on `.lease.lock`; matching the file's device and inode alone is insufficient. It sets `PI_RUNTIME_GENERATION` to its canonical path and only then imports the entry point. SDK/session guards repeat the descriptor-specific lock attestation.

The deployer must keep the built CLI/RPC bootstrap launchers, their Node-only child script, and all bundle chunks they import at stable paths outside `generations/`; updating those files is a separate migration and must not happen while hosts using them are running. The bootstrap entries (`src/cli.ts` and `src/rpc-entry.ts`) import no application modules. In managed mode they use only the bootstrap helper before starting the leased child. `runtime-entry.ts`, including `main.ts` and its static dependencies, is imported inside the child. The Bun launcher checks the same marker/environment before application imports and fails closed because managed Bun launches are unsupported. Extension loading verifies that its host loader resides within `PI_RUNTIME_GENERATION`; jiti resolution and host package aliases are consequently rooted in the selected immutable generation. Extensions can read the selected identity from `PI_RUNTIME_GENERATION`.

## Publication and collection

1. Build a complete new generation in a staging directory on the same filesystem. Create its `.lease.lock` and `generation.json` before it can be referenced. Preserve all runtime-only files that are part of the existing runtime.
2. Take an exclusive lock on `<root>/.publish.lock` to serialize deployers. Move the complete stage to `generations/<id>` without modifying an existing generation.
3. Write a temporary `active.json`, flush it, and atomically rename it over `active.json`. This rename is the sole commit point. Release the publication lock.
4. Do not mutate a published generation. A process that read the old active record may still pin that generation after the pointer changes; retain it until collection can acquire `flock -x <generation>/.lease.lock`. While holding that exclusive lease, atomically rename the generation directory out of `generations/` before deleting any contents; never unlink or replace `.lease.lock` in place. If collection wins before a host pins it, the host detects the reclaimed generation before import and retries from the active record. Never collect the active generation.

Crash recovery follows from this ordering: a crash before the active-record rename leaves the old active generation selected; a crash after it leaves the complete new generation selected. Unreferenced stage directories are not importable and may be inspected or removed later. An invalid or missing active record is not repaired speculatively: startup fails before imports. The deployer must ensure its filesystem provides atomic same-filesystem rename and use the same lock paths and ordering.

## Limits and migration

The host requires a standard Node.js process on Linux, a `flock` executable supporting `-F`, shared/exclusive locks, and command execution, readable `/proc/self/fdinfo` lock attestations, plus a local filesystem with the documented advisory-lock and same-filesystem atomic-rename semantics. It fails closed if the required `flock` behavior or kernel lock attestation is unavailable. Managed mode is unsupported on non-Linux platforms, Bun, and Node SEA binaries. The lease is kernel-backed and is released when the application process exits or is killed. The protocol pins host-managed application, lazy, and jiti imports. Extensions are arbitrary code and can bypass those paths with hard-coded absolute imports or direct filesystem reads; runtime code that must follow the lease protocol must use generation-relative imports. This protocol does not make an old host cooperative retroactively. Before the first conversion of a mutable legacy runtime, an operator must fully shut down every legacy host and ensure none can start during conversion. No host-side lock, PID scan, or filesystem inspection can machine-prove the absence of those processes. Preserve the complete legacy tree as an immutable generation during conversion; do not delete unknown files.

The guarantee covers Node CLI/RPC processes started through the marked bootstrap launchers. Host subprocess helpers explicitly remap the attested lease descriptor to child descriptor 3; arbitrary subprocesses are covered only if callers preserve that descriptor and the managed runtime environment. `main()`, SDK session creation, and extension loading reject managed mode without the bootstrap lease. Direct SDK module imports are not a supported managed launcher, and arbitrary extensions can launch processes or use absolute paths that bypass host resolution; such code is outside this guarantee and must not be treated as isolated by the lease.

This repository implements the host half only. The deployer must implement the layout, atomic publication, exclusive collection locks, stable launcher placement, and launcher environment contract above before enabling managed mode. Do not point the managed launcher at an existing mutable runtime until that work is complete.
