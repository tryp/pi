# Cache telemetry

Cache telemetry is disabled by default. Set `PI_CACHE_TELEMETRY=1` to opt in when creating an SDK agent session. It records bounded request metadata and normalized usage for supported providers; it does not change provider requests or add records to session/conversation history.

## Local storage and privacy

Records are written only to a dedicated `cache-telemetry` directory under the local agent directory. The directory is restricted to mode `0700`; JSONL files use `0600` and opaque random names. Nothing is uploaded, exported, or added to provider context. Do not share these files: hashes and metadata are local diagnostics even though prompt text and cache-key/header values are not persisted.

Provider/model labels are allowlisted; unknown values become `custom`/`unknown`. Payload fingerprints are HMAC-SHA-256 values under an in-memory key. Arbitrary SDK objects are intentionally unavailable rather than traversed; fingerprints are available only for bounded provider-owned wire JSON. Thus some requests have no comparable fingerprint. A key epoch is random per agent session, so hashes cannot be compared across sessions or process restarts.

Cache-key/header metadata reports effective values observable without invoking getters. It never stores their values. Identity comparison is `null` when values are absent or unavailable. A matching key, common prefix, or reported cache usage does not prove a cache hit or miss.

## Attempts and persistence limits

SDK consumers should `await session.dispose()` when finished. Listener removal and cancellation begin synchronously; the returned, idempotent completion barrier waits for the active agent, drains observer work, and closes the private writer. Runtime shutdown and session replacement await that same barrier. Hard process termination can still lose pending diagnostics.

A logical request can have multiple explicit adapter attempts, each with a distinct attempt ID. One request and terminal outcome are admitted as a bounded batch per attempt; Codex can also record canonical and final-wire phases in that batch. If the queue is full, a new attempt is rejected rather than recording an orphan outcome. The provider never waits for telemetry hashing, callbacks, or file I/O. A stalled or failed local sink can delay/drop persistence, and a process crash before an admitted attempt reaches its terminal outcome can lose the entire pending batch. Hidden retries inside provider SDKs are not visible and are not reported as separate attempts.

When enabled, the same private sink can include bounded `cache_context_operation` records for each context handler and the final message/system-prompt/tool surfaces, linked to the request and attempt IDs. These records contain only categorical change classifications, bounded counts/timing, and approved optional operation annotations; prompt/tool data is used only in-memory for comparison and is never persisted. Fingerprints use a per-session ephemeral HMAC key and are not stored. The operation sequence has a per-session random epoch. Unsupported or oversized observations are marked unavailable or dropped, and telemetry remains fail-open.

## Offline analysis

Analyze only an explicit local sidecar directory, for example:

```sh
python3 -m session_analysis.cache_misses --max-files 1000 --telemetry-dir /path/to/agent/cache-telemetry --output /path/to/private-summary.json
```

Keep both input records and output private. Telemetry metrics are distinct from historical assistant-message metrics.
