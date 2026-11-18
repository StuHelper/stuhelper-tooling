.PHONY: setup check test build hooks
setup:
	LEFTHOOK=0 pnpm install --frozen-lockfile
check:
	pnpm run check
	node bin/stuhelper-check.mjs workflows
test:
	pnpm test
build:
	git ls-files '*.mjs' | xargs -r -n 1 node --check
	git ls-files '*.sh' | xargs -r -n 1 bash -n
	node --input-type=module -e 'import fs from "node:fs"; import { execFileSync } from "node:child_process"; const out = execFileSync("pnpm", ["pack", "--dry-run"], { encoding: "utf8" }); const packed = new Set(out.split("\n").map(line => line.trim()).filter(Boolean)); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); const tracked = execFileSync("git", ["ls-files", "bin", "src", "presets"], { encoding: "utf8" }).split("\n").filter(Boolean); const required = [...new Set([...tracked, ...Object.values(pkg.bin ?? {}), ...Object.values(pkg.exports ?? {})].map(item => item.replace(/^\.\//, "")))]; for (const file of required) if (!packed.has(file)) throw new Error(`Missing from pnpm pack files whitelist: $${file}`); console.log(`PASS: build syntax and pack whitelist ($${required.length} files)`);'
hooks:
	pnpm exec lefthook install
