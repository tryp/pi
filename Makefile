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
# Deployment is staged: every package build, dependency install, and verification
# runs before scripts/deploy-runtime.sh replaces RUNTIME_DIR. This keeps a failed
# preflight from leaving a mixed live runtime. Do not replace the staged deploy
# with direct rsync/cp operations in this file.
#
# Traps encoded here (do not "simplify" them away):
#
# 1. tsgo exits non-zero on pre-existing type errors even though it EMITS the
#    dist. The npm build script chains chmod/copy-assets with &&, so those
#    post-steps are silently skipped on any type error. We run them
#    unconditionally.
# 2. coding-agent dist MUST be deployed together with every local package it
#    imports: agent, telemetry, ai, client, protocol, and tui. The runtime
#    pins its own node_modules: a dist-only deploy leaves new agent APIs or
#    runtime imports unresolved — extra call args are silently dropped, new
#    methods raise TypeError, or startup fails on a missing export.
# 3. The coding-agent bundle build is a required step. Missing sparse-checkout
#    build scripts or bundle failures must stop deployment rather than leave a
#    partially refreshed runtime.
# 4. Verify the staged tree before the live runtime is replaced, then verify
#    again through the public deployed interface.

RUNTIME_DIR ?= $(HOME)/.pi/local/pi-coding-agent
CORE_PKGS := telemetry agent coding-agent ai client protocol tui
PI ?= pi
SMOKE_TIMEOUT ?= 90

# A dist that EXISTS is not a dist that was REBUILT. tsgo exits non-zero on
# pre-existing type errors even though it emits (trap 1), so a failed compile is
# tolerated by the `|| true` below; a missing or stale emit is not, and
# `test -f` cannot tell the two apart. Compare mtimes against the sources
# instead, so a build that silently stopped emitting cannot pass as success.
# $1 = package directory, $2 = dist entry point relative to the package.
define assert-dist-fresh
	@if [ ! -e packages/$(1)/$(2) ]; then \
		echo "FAIL: packages/$(1)/$(2) not emitted" >&2; exit 1; \
	fi; \
	if [ -n "$$(find packages/$(1)/src -name '*.ts' -newer packages/$(1)/$(2) -print -quit 2>/dev/null)" ]; then \
		echo "FAIL: packages/$(1)/$(2) is older than its sources (compile did not emit)" >&2; exit 1; \
	fi
endef

.PHONY: deploy deploy-full verify smoke-test test-deploy-runtime deployed-commit build-telemetry build-agent build-ai build-client build-protocol build-tui build-coding-agent build-extra

build-telemetry:
	cd packages/telemetry && npm run build || true
	$(call assert-dist-fresh,telemetry,dist/index.js)

build-agent:
	cd packages/agent && npm run build || true
	$(call assert-dist-fresh,agent,dist/agent.js)

# The generated catalog is an INPUT, not an artifact to shrug off. This target
# used to be `npm run build || true` (i.e. `generate-models && build:offline`),
# which hid a regeneration failure behind the same `|| true` that exists for
# tsgo's emit-with-error behavior (trap 1); the follow-up check only asserted
# that dist/index.js existed, so an older dist passed and the deploy shipped a
# pi-ai whose catalog was missing a provider. Regeneration and data validation
# are now hard gates, tsgo keeps its emit tolerance, and the post-steps run
# unconditionally (same reasoning as build-coding-agent below).
#
# Keep the emit/copy steps in sync with `build:offline` in packages/ai/package.json.
build-ai:
	cd packages/ai && npm run generate-models
	cd packages/ai && npm run check:model-data
	cd packages/ai && npx tsgo -p tsconfig.build.json || true
	rm -rf packages/ai/dist/providers/data
	cp -r packages/ai/src/providers/data packages/ai/dist/providers/data
	$(call assert-dist-fresh,ai,dist/index.js)
	@cmp -s packages/ai/src/providers/data/.manifest.json packages/ai/dist/providers/data/.manifest.json || { \
		echo "FAIL: packages/ai/dist model data is stale (it does not match src/providers/data)" >&2; exit 1; }

build-client:
	cd packages/client && npm run build || true
	$(call assert-dist-fresh,client,dist/index.js)

build-protocol:
	cd packages/protocol && npm run build || true
	$(call assert-dist-fresh,protocol,dist/index.js)

build-tui:
	cd packages/tui && npm run build || true
	$(call assert-dist-fresh,tui,dist/index.js)

build-coding-agent:
	test -f scripts/build-coding-agent-bundle.mjs || { echo "FAIL: coding-agent bundle script missing; hydrate it with 'git sparse-checkout add scripts'" >&2; exit 1; }
	cd packages/coding-agent && npm run build:unbundled || true
	$(call assert-dist-fresh,coding-agent,dist/cli.js)
	test -f packages/coding-agent/dist/index.js || { echo "FAIL: packages/coding-agent index dist not emitted" >&2; exit 1; }
	chmod +x packages/coding-agent/dist/cli.js packages/coding-agent/dist/rpc-entry.js
	cd packages/coding-agent && npm run copy-assets
	node scripts/build-coding-agent-bundle.mjs
	test -x packages/coding-agent/dist/bundle/cli.js || { echo "FAIL: coding-agent bundle not emitted" >&2; exit 1; }

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
# emitted types, so building client first fails on a clean tree. Every step here
# is `|| true`-tolerant (tsgo emits on type errors), which is exactly why the
# order has to be right: the failure is swallowed and only a stale dist saves it.
build-extra: build-ai build-protocol build-client build-tui

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
