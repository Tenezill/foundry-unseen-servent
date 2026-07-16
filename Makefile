.PHONY: setup setup-reset

# Interactive first-run setup: starts an ephemeral web wizard on :8322 (see
# docs/HOSTING.md Part C) raced against terminal prompts; writes quickstart
# config/secrets and runs compose up. Flags: --no-wizard, --no-up, --reset.
setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset
