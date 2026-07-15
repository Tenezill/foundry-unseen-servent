.PHONY: setup setup-reset

setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset
