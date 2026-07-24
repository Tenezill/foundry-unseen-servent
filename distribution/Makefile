.PHONY: setup setup-reset update

# Interactive first-run setup: starts an ephemeral web wizard on :8322 raced
# against terminal prompts; writes config/secrets and runs compose up.
# Flags: --no-wizard, --no-up, --reset.
setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset

# Data-safe update: git pull + pull new pinned images + recreate changed
# containers. NEVER removes volumes or bind mounts — your world, players,
# secrets and relay DB are preserved. Flags: --no-pull.
update:
	node scripts/update-stack.mjs
