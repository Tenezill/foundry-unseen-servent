.PHONY: setup setup-reset update

# Interactive first-run setup: starts an ephemeral web wizard on :8322 (see
# docs/HOSTING.md Part C) raced against terminal prompts; writes quickstart
# config/secrets and runs compose up. Flags: --no-wizard, --no-up, --reset.
setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset

# Data-safe update: git pull + refresh/rebuild images + recreate changed
# containers. NEVER removes volumes or bind mounts — your world, players,
# secrets and relay DB are preserved. Flags: --no-pull. (docs/HOSTING.md Part C)
update:
	node scripts/update-stack.mjs
