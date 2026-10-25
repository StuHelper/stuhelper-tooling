.PHONY: setup check test build hooks
setup:
	LEFTHOOK=0 pnpm install --frozen-lockfile
check:
	pnpm run check
	node bin/stuhelper-check.mjs workflows
test:
	pnpm test
build:
	node --check bin/stuhelper-check.mjs
hooks:
	pnpm exec lefthook install
