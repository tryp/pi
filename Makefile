# pi-mono deployment helpers.
#
# pi runs the deployed copy at $(RUNTIME_DIR) — a dist mirror with PINNED
# node_modules, not this checkout. Never edit files there directly; build and
# deploy from here with `make deploy`.
#
#   make deploy            # build agent + coding-agent, sync, stamp, verify
#   make deploy-full       # additionally rebuild+sync pi-ai and pi-tui
#   make verify            # deployed tree matches this build
#   make smoke-test        # fresh-process startup test with configured extensions
#   make deployed-commit   # show what is deployed
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
# 4. Verify the DEPLOYED tree (markers, versions, content), never the source
#    tree, before recording a deploy event.

RUNTIME_DIR ?= $(HOME)/.pi/local/pi-coding-agent
CORE_PKGS := telemetry agent coding-agent ai client protocol tui
PI ?= pi
SMOKE_TIMEOUT ?= 90

.PHONY: deploy deploy-full verify smoke-test deployed-commit build-telemetry build-agent build-ai build-client build-protocol build-tui build-coding-agent install-runtime-dependencies build-extra

build-telemetry:
	cd packages/telemetry && npm run build || true
	test -f packages/telemetry/dist/index.js || { echo "FAIL: packages/telemetry dist not emitted" >&2; exit 1; }

build-agent:
	cd packages/agent && npm run build || true
	test -f packages/agent/dist/agent.js || { echo "FAIL: packages/agent dist not emitted" >&2; exit 1; }

build-ai:
	cd packages/ai && npm run build || true
	test -f packages/ai/dist/index.js || { echo "FAIL: packages/ai dist not emitted" >&2; exit 1; }

build-client:
	cd packages/client && npm run build || true
	test -f packages/client/dist/index.js || { echo "FAIL: packages/client dist not emitted" >&2; exit 1; }

build-protocol:
	cd packages/protocol && npm run build || true
	test -f packages/protocol/dist/index.js || { echo "FAIL: packages/protocol dist not emitted" >&2; exit 1; }

build-tui:
	cd packages/tui && npm run build || true
	test -f packages/tui/dist/index.js || { echo "FAIL: packages/tui dist not emitted" >&2; exit 1; }

build-coding-agent:
	test -f scripts/build-coding-agent-bundle.mjs || { echo "FAIL: coding-agent bundle script missing; hydrate it with 'git sparse-checkout add scripts'" >&2; exit 1; }
	cd packages/coding-agent && npm run build:unbundled || true
	test -f packages/coding-agent/dist/cli.js || { echo "FAIL: packages/coding-agent dist not emitted" >&2; exit 1; }
	chmod +x packages/coding-agent/dist/cli.js packages/coding-agent/dist/rpc-entry.js
	cd packages/coding-agent && npm run copy-assets
	node scripts/build-coding-agent-bundle.mjs
	test -x packages/coding-agent/dist/bundle/cli.js || { echo "FAIL: coding-agent bundle not emitted" >&2; exit 1; }

install-runtime-dependencies:
	npm install --prefix $(RUNTIME_DIR) --no-save --ignore-scripts grok-mermaid@0.2.2
	test -f $(RUNTIME_DIR)/node_modules/grok-mermaid/package.json || { echo "FAIL: grok-mermaid runtime dependency missing" >&2; exit 1; }

deploy: build-telemetry build-agent build-extra build-coding-agent install-runtime-dependencies  ## Build and sync all local runtime packages, stamp, verify, and smoke-test
	rsync -a --delete packages/coding-agent/dist/ $(RUNTIME_DIR)/dist/
	mkdir -p $(RUNTIME_DIR)/node_modules/@earendil-works/pi-telemetry
	rsync -a --delete packages/telemetry/dist/ \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-telemetry/dist/
	cp packages/telemetry/package.json \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-telemetry/package.json
	rsync -a --delete packages/agent/dist/ \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/dist/
	cp packages/agent/package.json \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/package.json
	@for pkg in ai client protocol tui; do \
		mkdir -p $(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg; \
		rsync -a --delete packages/$$pkg/dist/ $(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg/dist/; \
		cp packages/$$pkg/package.json $(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg/package.json; \
	done
	chmod +x $(RUNTIME_DIR)/dist/cli.js $(RUNTIME_DIR)/dist/rpc-entry.js
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\npackages: %s\n\nThis is a deployed artifact. Do not edit files here.\nBuild and deploy from the source checkout (`make deploy`).\n' \
		"$(CURDIR)" "$$(git rev-parse --abbrev-ref HEAD)" "$$(git rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" "$(CORE_PKGS)" \
		> $(RUNTIME_DIR)/.deployed-commit
	@$(MAKE) --no-print-directory verify
	@$(MAKE) --no-print-directory smoke-test

deploy-full: deploy  ## Compatibility alias for the complete local-package deployment

build-extra: build-ai build-client build-protocol build-tui

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
