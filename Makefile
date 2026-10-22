.DEFAULT_GOAL := help
.PHONY: help up down status smoke preflight deploy chat

help: ## List the targets
	@grep -E '^[a-z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "%-8s %s\n", $$1, $$2}'

up: ## Check tools and the key, create the kind cluster and registry, install Substrate, kagent, agentgateway
	platform/preflight.sh
	platform/cluster.sh up
	PREFLIGHT_DONE=1 platform/install.sh

down: ## Delete the kind cluster and the local registry
	platform/cluster.sh down

status: ## One ok or FAIL line per platform part; exits non-zero on any FAIL
	@failed=0; \
	platform/cluster.sh status || failed=1; \
	platform/status.sh || failed=1; \
	exit $$failed

smoke: ## Push an image and apply a Harness by its digest, then one message to the stock agent (spends model tokens)
	platform/smoke.sh

preflight: ## Check tools, versions, and OPENCODE_KEY without creating anything
	platform/preflight.sh

deploy: ## Build the agent image, push it, apply the Harness and Agent by digest (image named by the registry's kind-network address)
	platform/deploy.sh

chat: ## Send one message to the deployed agent through the kagent controller: make chat MSG="hello" [FILE=path/to/file]
	pnpm --dir agent run cli -- $(if $(FILE),--file "$(FILE)") "$(MSG)"
