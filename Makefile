# pi-mono deployment helpers.
#
# pi runs the deployed copy at $(RUNTIME_DIR) — a dist mirror with PINNED
# node_modules, not this checkout. Never edit files there directly; build and
# deploy from here with `make deploy`.
#
#   make deploy            # build agent + coding-agent, sync, stamp, verify
#   make deploy-full       # additionally rebuild+sync pi-ai and pi-tui
#   make verify            # deployed tree matches this build
#   make deployed-commit   # show what is deployed
#
# Traps encoded here (do not "simplify" them away):
#
# 1. tsgo exits non-zero on pre-existing type errors even though it EMITS the
#    dist. The npm build script chains chmod/copy-assets with &&, so those
#    post-steps are silently skipped on any type error. We run them
#    unconditionally.
# 2. coding-agent dist MUST be deployed together with pi-agent-core dist.
#    The runtime pins its own node_modules: a dist-only deploy leaves new
#    agent APIs unresolved — extra call args are silently dropped (a queueKey
#    vanishes) and new methods raise TypeError at runtime.
# 3. pi-ai and pi-tui only need syncing when this checkout changes those
#    packages; their builds may require network (generate-models). Use
#    `make deploy-full` for that case and confirm the build actually ran.
# 4. Verify the DEPLOYED tree (markers, versions, content), never the source
#    tree, before recording a deploy event.

RUNTIME_DIR ?= $(HOME)/.pi/local/pi-coding-agent
CORE_PKGS := agent coding-agent

.PHONY: deploy deploy-full verify deployed-commit build-agent build-coding-agent

build-agent:
	cd packages/agent && npm run build || true
	test -f packages/agent/dist/agent.js || { echo "FAIL: packages/agent dist not emitted" >&2; exit 1; }

build-coding-agent:
	cd packages/coding-agent && npm run build || true
	test -f packages/coding-agent/dist/cli.js || { echo "FAIL: packages/coding-agent dist not emitted" >&2; exit 1; }
	chmod +x packages/coding-agent/dist/cli.js packages/coding-agent/dist/rpc-entry.js
	cd packages/coding-agent && npm run copy-assets

deploy: build-agent build-coding-agent  ## Build core packages, sync runtime, stamp, verify
	rsync -a --delete packages/coding-agent/dist/ $(RUNTIME_DIR)/dist/
	rsync -a --delete packages/agent/dist/ \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/dist/
	cp packages/agent/package.json \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/package.json
	chmod +x $(RUNTIME_DIR)/dist/cli.js $(RUNTIME_DIR)/dist/rpc-entry.js
	@printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\npackages: %s\n\nThis is a deployed artifact. Do not edit files here.\nBuild and deploy from the source checkout (`make deploy`).\n' \
		"$(CURDIR)" "$$(git rev-parse --abbrev-ref HEAD)" "$$(git rev-parse HEAD)" "$$(date '+%Y-%m-%d %H:%M:%S %z')" "$(CORE_PKGS)" \
		> $(RUNTIME_DIR)/.deployed-commit
	@$(MAKE) --no-print-directory verify

deploy-full: deploy build-extra  ## Additionally rebuild and sync pi-ai and pi-tui
	@$(MAKE) --no-print-directory verify

build-extra:
	cd packages/ai && npm run build
	test -f packages/ai/dist/index.js || { echo "FAIL: packages/ai dist not emitted" >&2; exit 1; }
	rsync -a --delete packages/ai/dist/ \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-ai/dist/
	cp packages/ai/package.json \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-ai/package.json
	cd packages/tui && npm run build || true
	rsync -a --delete packages/tui/dist/ \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-tui/dist/
	cp packages/tui/package.json \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-tui/package.json

verify:  ## Verify deployed dist matches this build (versions + content + exec bits)
	@test -x $(RUNTIME_DIR)/dist/cli.js || { echo "FAIL: $(RUNTIME_DIR)/dist/cli.js missing or not executable" >&2; exit 1; }
	@test "$$(sed -n 's/^commit: //p' $(RUNTIME_DIR)/.deployed-commit 2>/dev/null)" = "$$(git rev-parse HEAD)" || { \
		echo "FAIL: deployed commit != checkout HEAD (run make deploy)" >&2; exit 1; }
	@src=$$(node -p "require('./packages/agent/package.json').version"); \
	dep=$$(node -p "require('$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/package.json').version"); \
	[ "$$src" = "$$dep" ] || { echo "FAIL: pi-agent-core version drift: source $$src vs deployed $$dep — dist-only deploy leaves new agent APIs unresolved" >&2; exit 1; }
	@cmp -s packages/agent/dist/agent.js \
		$(RUNTIME_DIR)/node_modules/@earendil-works/pi-agent-core/dist/agent.js || { \
		echo "FAIL: pi-agent-core dist drift (run make deploy)" >&2; exit 1; }
	@cmp -s packages/coding-agent/dist/cli.js $(RUNTIME_DIR)/dist/cli.js || { \
		echo "FAIL: coding-agent dist drift (run make deploy)" >&2; exit 1; }
	@for pkg in ai tui; do \
		src=$$(node -p "require('./packages/$$pkg/package.json').version"); \
		dep=$$(node -p "require('$(RUNTIME_DIR)/node_modules/@earendil-works/pi-$$pkg/package.json').version" 2>/dev/null || echo missing); \
		[ "$$src" = "$$dep" ] && continue; \
		echo "WARN: pi-$$pkg version drift (source $$src vs deployed $$dep); sync with 'make deploy-full' if this checkout changed pi-$$pkg"; \
	done
	@echo "OK: $(RUNTIME_DIR) matches $$(git rev-parse --short HEAD) ($(CORE_PKGS))"

deployed-commit:  ## Show what is deployed
	@cat $(RUNTIME_DIR)/.deployed-commit 2>/dev/null || echo "no .deployed-commit marker in $(RUNTIME_DIR)"
