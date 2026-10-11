# pi-mono deployment helpers.
#
# pi runs the deployed copy at $(RUNTIME_DIR) — a dist mirror with PINNED
# node_modules, not this checkout. Never edit files there directly; build and
# deploy from here with `make deploy`.
#
#   make deploy            # build all local packages, stage, verify, and smoke-test
#   make deploy-full       # compatibility alias for the complete deployment
#   make verify            # deployed tree matches this build
#   make smoke-test        # fresh-process startup test with configured extensions
#   make test-deploy-runtime # preflight failure must not alter live runtime
#   make deployed-commit   # show what is deployed
#
# Verification that needs a real process, not a mock:
#
#   make verify-models-dev-cache    # the catalog is cached across pi processes
#   make verify-production-cache-path # the default cache path works in ~/.pi/agent
#   make measure-models-dev-latency # network fetch vs disk seed vs memory hit
#   make compare-ai-failures        # is the ai suite's failure count mine?
#   make mutcheck-deploy-gates      # revert the build gates; do they still fail?
#
# Deployment is staged: every package build, dependency install, and verification
# runs before scripts/deploy-runtime.sh replaces RUNTIME_DIR. This keeps a failed
# preflight from leaving a mixed live runtime. Do not replace the staged deploy
# with direct rsync/cp operations in this file.
#
# Traps encoded here (do not "simplify" them away):
#
# 1. tsgo EMITS the dist even when it reports type errors, and the npm build
#    script chains chmod/copy-assets with &&, so those post-steps are silently
#    skipped on any type error. We run them unconditionally. The errors are not
#    tolerated: every build step is a hard gate (measured 2026-10-11, all seven
#    build configs exit 0). Tolerating them is what shipped a pi-ai whose catalog
#    was missing a provider -- the TS2307 naming the deleted generated shard was
#    in the build log and the exit code carrying it was discarded, so the deploy
#    reported OK. `make mutcheck-deploy-gates` reverts that state and requires the
#    build to stop.
# 2. coding-agent dist MUST be deployed together with every local package it
#    imports: agent, telemetry, ai, client, protocol, and tui. The runtime
#    pins its own node_modules: a dist-only deploy leaves new agent APIs or
#    runtime imports unresolved — extra call args are silently dropped, new
#    methods raise TypeError, or startup fails on a missing export.
# 3. The coding-agent bundle build is a required step. Missing sparse-checkout
#    build scripts or bundle failures must stop deployment rather than leave a
#    partially refreshed runtime. The bundle is the entry point npm users run
#    (`bin.pi` -> dist/bundle/cli.js), so it gets the same freshness assertion as
#    the package dists and is content-compared by `make verify` -- it is built by
#    esbuild from the dists, and esbuild strips types without checking them.
# 4. Verify the staged tree before the live runtime is replaced, then verify
#    again through the public deployed interface.

RUNTIME_DIR ?= $(HOME)/.pi/local/pi-coding-agent
CORE_PKGS := telemetry agent coding-agent ai client protocol tui
PI ?= pi
SMOKE_TIMEOUT ?= 90

# A dist that EXISTS is not a dist that was REBUILT. A compile can exit 0 and
# still leave a stale entry point (an aborted emit, a config that stopped
# including it), and `test -f` cannot tell the two apart. Compare mtimes against
# the sources instead. This is a backstop behind the hard typecheck gates, not a
# substitute for them: it cannot see a dist rebuilt from broken sources.
# $1 = package directory, $2 = dist entry point relative to the package.
define assert-dist-fresh
	@if [ ! -e packages/$(1)/$(2) ]; then \
		echo "FAIL: packages/$(1)/$(2) not emitted" >&2; exit 1; \
	fi; \
	if [ -n "$$(find packages/$(1)/src -name '*.ts' -newer packages/$(1)/$(2) -print -quit 2>/dev/null)" ]; then \
		echo "FAIL: packages/$(1)/$(2) is older than its sources (it was not rebuilt)" >&2; exit 1; \
	fi
endef

.PHONY: deploy deploy-full verify smoke-test test-deploy-runtime deployed-commit build-telemetry build-agent build-ai build-client build-protocol build-tui build-coding-agent build-extra mutcheck-deploy-gates

build-telemetry:
	cd packages/telemetry && npm run build
	$(call assert-dist-fresh,telemetry,dist/index.js)

build-agent:
	cd packages/agent && npm run build
	$(call assert-dist-fresh,agent,dist/agent.js)

# The generated catalog is an INPUT, not an artifact to shrug off. This target
# used to be `npm run build || true` (i.e. `generate-models && build:offline`),
# which hid a regeneration failure behind the same `|| true` that exists for
# tsgo's emit-with-error behavior (trap 1); the follow-up check only asserted
# that dist/index.js existed, so an older dist passed and the deploy shipped a
# pi-ai whose catalog was missing a provider.
#
# All three steps are hard gates now, the typecheck included: a regeneration that
# drops a provider deletes its generated shard and leaves the importing module with
# a TS2307, which is the only signal left when the generated output agrees with
# itself (check:model-data compares generated to generated, so it cannot see it).
# See `make mutcheck-deploy-gates`. The post-steps run unconditionally (same
# reasoning as build-coding-agent below).
#
# Keep the emit/copy steps in sync with `build:offline` in packages/ai/package.json.
build-ai:
	cd packages/ai && npm run generate-models
	cd packages/ai && npm run check:model-data
	cd packages/ai && npx tsgo -p tsconfig.build.json
	rm -rf packages/ai/dist/providers/data
	cp -r packages/ai/src/providers/data packages/ai/dist/providers/data
	$(call assert-dist-fresh,ai,dist/index.js)
	@cmp -s packages/ai/src/providers/data/.manifest.json packages/ai/dist/providers/data/.manifest.json || { \
		echo "FAIL: packages/ai/dist model data is stale (it does not match src/providers/data)" >&2; exit 1; }

build-client:
	cd packages/client && npm run build
	$(call assert-dist-fresh,client,dist/index.js)

build-protocol:
	cd packages/protocol && npm run build
	$(call assert-dist-fresh,protocol,dist/index.js)

build-tui:
	cd packages/tui && npm run build
	$(call assert-dist-fresh,tui,dist/index.js)

build-coding-agent:
	test -f scripts/build-coding-agent-bundle.mjs || { echo "FAIL: coding-agent bundle script missing; hydrate it with 'git sparse-checkout add scripts'" >&2; exit 1; }
	cd packages/coding-agent && npm run build:unbundled
	$(call assert-dist-fresh,coding-agent,dist/cli.js)
	test -f packages/coding-agent/dist/index.js || { echo "FAIL: packages/coding-agent index dist not emitted" >&2; exit 1; }
	chmod +x packages/coding-agent/dist/cli.js packages/coding-agent/dist/rpc-entry.js
	cd packages/coding-agent && npm run copy-assets
	node scripts/build-coding-agent-bundle.mjs
	$(call assert-dist-fresh,coding-agent,dist/bundle/cli.js)

# Refuse to build from a tree that is mid-merge or carries conflict markers.
#
# A conflicted file is not the loud compile error you would expect: tsgo's error
# recovery dropped the marker lines and emitted BOTH sides of the conflict, so
# `make deploy` bundled a merge of two branches and the only signal was an
# esbuild "Duplicate member" warning. One bare `git stash pop` in a worktree
# whose newest stash was months old was enough to ship that, which is why this
# checks the index (unmerged paths) and the sources (markers) before any build.
check-tree-clean:
	@unmerged=$$(git diff --name-only --diff-filter=U); \
	if [ -n "$$unmerged" ]; then \
		echo "FAIL: unmerged paths (resolve them before building):" >&2; echo "$$unmerged" >&2; exit 1; \
	fi; \
	markers=$$(rg -n --no-heading '^(<<<<<<< |>>>>>>> |=======$$)' packages/*/src --type ts || true); \
	if [ -n "$$markers" ]; then \
		echo "FAIL: conflict markers in src:" >&2; echo "$$markers" >&2; exit 1; \
	fi

deploy: check-tree-clean build-telemetry build-agent build-extra build-coding-agent  ## Build all local runtime packages, stage dependencies, verify, install, and smoke-test
	./scripts/deploy-runtime.sh --source-dir "$(CURDIR)" --runtime-dir "$(RUNTIME_DIR)"
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory smoke-test

deploy-full: deploy  ## Compatibility alias for the complete local-package deployment

# protocol before client: packages/client imports @earendil-works/pi-protocol's
# emitted types. The order was load-bearing when a failed compile was swallowed
# (only a stale dist saved it); it is still required, and now a wrong order fails
# loudly instead.
build-extra: build-ai build-protocol build-client build-tui

# Compare the deployed tree against this build. The bundle is included because it
# is the entry point npm users run (`bin.pi` -> dist/bundle/cli.js): it is built by
# esbuild from the dists, and esbuild strips types without checking them, so it is
# only as good as the gated dists behind it. Asserting that it merely existed left
# the one artifact `pi` executes uncompared.
verify:  ## Verify deployed dist matches this build (versions + content + exec bits)
	@test -x $(RUNTIME_DIR)/dist/cli.js || { echo "FAIL: $(RUNTIME_DIR)/dist/cli.js missing or not executable" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' $(RUNTIME_DIR)/.deployed-commit 2>/dev/null)" = "$$(git rev-parse HEAD)" || { \
		echo "FAIL: deployed commit != checkout HEAD (run make deploy)" >&2; exit 1; }
	@src=$$(node -p "require('./packages/telemetry/package.json').version"); \
	dep=$$(node -p "require('$(RUNTIME_DIR)/node_modules/@earendil-works/pi-telemetry/package.json').version"); \
	[ "$$src" = "$$dep" ] || { echo "FAIL: pi-telemetry version drift: source $$src vs deployed $$dep" >&2; exit 1; }
	@src=$$(node -p "require('./packages/agent/package.json').version"); \
	dep=$$(node -p "require('$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/package.json').version"); \
	[ "$$src" = "$$dep" ] || { echo "FAIL: pi-agent-core version drift: source $$src vs deployed $$dep" >&2; exit 1; }
	@test -f $(RUNTIME_DIR)/node_modules/grok-mermaid/package.json || { echo "FAIL: grok-mermaid runtime dependency missing (run make deploy)" >&2; exit 1; }
	@cmp -s packages/telemetry/dist/index.js \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-telemetry/dist/index.js || { \
		echo "FAIL: pi-telemetry dist drift (run make deploy)" >&2; exit 1; }
	@cmp -s packages/agent/dist/agent.js \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/dist/agent.js || { \
		echo "FAIL: pi-agent-core dist drift (run make deploy)" >&2; exit 1; }
	@cmp -s packages/coding-agent/dist/cli.js $(RUNTIME_DIR)/dist/cli.js || { \
		echo "FAIL: coding-agent dist drift (run make deploy)" >&2; exit 1; }
	@diff -rq packages/coding-agent/dist/bundle $(RUNTIME_DIR)/dist/bundle >/dev/null 2>&1 || { \
		echo "FAIL: coding-agent bundle drift (run make deploy); first differences:" >&2; \
		diff -rq packages/coding-agent/dist/bundle $(RUNTIME_DIR)/dist/bundle 2>&1 | head -10 >&2; exit 1; }
	@src=$$(node -p "require('./packages/coding-agent/package.json').version"); \
	dep=$$(node -p "require('$(RUNTIME_DIR)/package.json').version"); \
	[ "$$src" = "$$dep" ] || { echo "FAIL: coding-agent version drift: source $$src vs deployed $$dep" >&2; exit 1; }
	@for pkg in ai client protocol tui; do \
		src=$$(node -p "require('./packages/$$pkg/package.json').version"); \
		dep=$$(node -p "require('$(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg/package.json').version" 2>/dev/null || echo missing); \
		[ "$$src" = "$$dep" ] || { echo "FAIL: pi-$$pkg version drift: source $$src vs deployed $$dep (run make deploy)" >&2; exit 1; }; \
		test -f "$(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg/dist/index.js" || { echo "FAIL: pi-$$pkg dist missing" >&2; exit 1; }; \
		cmp -s "packages/$$pkg/dist/index.js" "$(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg/dist/index.js" || { echo "FAIL: pi-$$pkg dist drift" >&2; exit 1; }; \
	done
	@echo "OK: $(RUNTIME_DIR) matches $$(git rev-parse --short HEAD) ($(CORE_PKGS))"

test-deploy-runtime:  ## Confirm a failed preflight leaves the live runtime untouched
	./scripts/test-deploy-runtime.sh

smoke-test:  ## Start a fresh pi process with the configured extensions
	@set -eu; \
	root="$(CURDIR)/tmp/predeploy-core-smoke-$$$$"; out="$$root/pi.jsonl"; \
	mkdir -p "$$root/sessions"; \
	if ! timeout "$(SMOKE_TIMEOUT)" "$(PI)" --session-dir "$$root/sessions" --no-session --mode json \
		-p 'List your available tools, report that startup succeeded, and stop.' >"$$out" 2>&1; then \
		echo "FAIL: pi startup smoke failed; inspect $$out" >&2; tail -80 "$$out" >&2; exit 1; \
	fi; \
	if grep -Eq 'Failed to load extension|registerToolPromptGuidelines is not a function|"errorMessage"|uncaught|Not logged in' "$$out"; then \
		echo "FAIL: pi startup smoke reported an extension or turn error; inspect $$out" >&2; exit 1; \
	fi; \
	grep -Eq '"type"[[:space:]]*:[[:space:]]*"agent_end"' "$$out" || { echo "FAIL: pi startup smoke did not reach agent_end; inspect $$out" >&2; exit 1; }; \
	echo "OK: fresh pi startup smoke passed; output: $$out"

deployed-commit:  ## Show what is deployed
	@cat $(RUNTIME_DIR)/.deployed-commit 2>/dev/null || echo "no .deployed-commit marker in $(RUNTIME_DIR)"

# The models.dev catalog cache. A unit test can prove the client reads and writes
# the file; only a real process can prove the refresh path reaches it, and only a
# second real process can prove the first one's file is what served it.
verify-models-dev-cache:  ## Real pi: the disk cache is written, then served without a refetch
	node scripts/verify-models-dev-cache.mjs --pi "$(RUNTIME_DIR)/dist/cli.js"

verify-production-cache-path:  ## Real agent dir: the default cache path is written, then reused
	node scripts/verify-production-cache-path.mjs --pi "$(RUNTIME_DIR)/dist/cli.js"

measure-models-dev-latency:  ## Network fetch vs disk seed vs in-memory hit
	node scripts/measure-models-dev-latency.ts

# A gate that is never seen failing is indistinguishable from a gate that does
# nothing, and this one was absent once: models.dev renamed a provider, the
# generator dropped it silently, the deleted shard left a TS2307 in the importing
# module, and the build's `|| true` discarded it -- so a pi-ai missing a provider
# deployed with OK printed. The check reverts that state and requires
# `make build-ai` to stop, then requires the healthy tree to still build.
mutcheck-deploy-gates:  ## Revert the build gates and require the build to stop
	bash scripts/mutcheck-deploy-gates.sh

# Fails loudly if a change to the ai package moves the suite's failure count: a
# broken instrument reads as "no effect", which is indistinguishable from a
# change that did not work. Pass test files to check a narrower set.
compare-ai-failures:  ## Is the ai suite's failure count caused by my uncommitted changes?
	./scripts/compare-ai-failures.sh $(ARGS)
