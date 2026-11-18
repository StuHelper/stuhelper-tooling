import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkSource } from './repository.mjs';
import { checkContracts } from './contracts.mjs';
import { checkDocs } from './docs/check-docs.mjs';
import { lintMarkdown } from './docs/lint-markdown.mjs';
import { check as checkI18n } from './i18n/check-i18n.mjs';

const git = (root, args, env = process.env) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function linkNodeModules(sourceRoot, targetRoot, relative = '') {
  const current = path.join(sourceRoot, relative);
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.isSymbolicLink()) continue;
    const relPath = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.name === 'node_modules' && entry.isDirectory()) {
      const destination = path.join(targetRoot, relPath);
      let exists = false;
      try { fs.lstatSync(destination); exists = true; } catch { /* Absent in snapshot. */ }
      if (!exists && fs.existsSync(path.dirname(destination))) {
        fs.symlinkSync(path.join(sourceRoot, relPath), destination, 'dir');
      }
      continue;
    }
    if (entry.isDirectory() && fs.existsSync(path.join(targetRoot, relPath))) {
      linkNodeModules(sourceRoot, targetRoot, relPath);
    }
  }
}

export async function withIndex(root, action) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-index-'));
  const target = path.join(temporary, 'source');
  const env = { ...process.env };
  for (const key of git(root, ['rev-parse', '--local-env-vars']).trim().split('\n')) delete env[key];
  const cleanup = () => fs.rmSync(temporary, { recursive: true, force: true });
  const interrupted = signal => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const onInterrupt = () => interrupted('SIGINT');
  const onTerminate = () => interrupted('SIGTERM');
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  try {
    git(root, ['clone', '--shared', '--no-checkout', '--quiet', '--', root, target], env);
    // The snapshot contains the index, including partial staging; the user's worktree is never stashed or changed.
    git(root, ['checkout-index', '--all', `--prefix=${target}/`]);
    git(target, ['add', '--force', '--all'], env);
    linkNodeModules(root, target);
    return await action(target, env);
  } finally {
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    cleanup();
  }
}

export async function checkStaged(root, { eslint = false, glossary } = {}) {
  const files = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const allStaged = git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  if (!allStaged.length) return;
  await withIndex(root, async (target, env) => {
    const errors = [];
    let base = 'HEAD';
    try { git(target, ['rev-parse', '--verify', 'HEAD'], env); } catch { base = '0'.repeat(40); }
    for (const file of files) {
      const location = path.join(target, file);
      const stat = fs.lstatSync(location);
      if (!stat.isFile()) continue;
      const source = fs.readFileSync(location, 'utf8');
      errors.push(...checkSource(file, source, Boolean(stat.mode & 0o111)));
      if (file.endsWith('.go')) {
        const formatted = spawnSync('gofmt', [], { input: source, encoding: 'utf8', env });
        if (formatted.error) throw formatted.error;
        if (formatted.status !== 0) errors.push(`${file}: ${formatted.stderr.trim()}`);
        else if (formatted.stdout !== source) errors.push(`${file}: run gofmt before staging`);
      }
      if (file.endsWith('.mjs')) {
        const parsed = spawnSync(process.execPath, ['--check', location], { encoding: 'utf8', env });
        if (parsed.status !== 0) errors.push(`${file}: JavaScript syntax check failed\n${parsed.stderr}`);
      }
    }
    if (files.some(file => /\.md$|^mkdocs\.yml$|^\.markdownlint-cli2\.yaml$/.test(file)) && fs.existsSync(path.join(target, '.markdownlint-cli2.yaml'))) {
      const resolvedGlossary = glossary
        ? (!path.isAbsolute(glossary) && fs.existsSync(path.join(target, glossary)) ? path.join(target, glossary) : path.resolve(root, glossary))
        : undefined;
      errors.push(...await lintMarkdown(target), ...checkDocs(target, { base, glossary: resolvedGlossary }).errors);
    }
    if (fs.existsSync(path.join(target, 'locale-policy.yaml')) && allStaged.some(file => /^locale-policy\.(?:ya?ml|json)$|(?:^|\/)locales\/.*\.json$|\.(?:vue|ts|tsx)$/.test(file))) {
      try { checkI18n(target); } catch (error) { errors.push(error.message); }
    }
    if (allStaged.some(file => /\.gen\.(?:[cm]?[jt]s|go)$|^contracts\//.test(file))) {
      errors.push(...checkContracts(target, { base, env }));
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const scripts = files.filter(file => /\.(?:[cm]?js|ts|tsx|vue)$/.test(file));
    if (eslint && scripts.length) {
      const checked = spawnSync('pnpm', ['exec', 'eslint', '--max-warnings=0', '--no-warn-ignored', ...scripts], { cwd: target, env, stdio: 'inherit' });
      if (checked.error) throw checked.error;
      if (checked.status !== 0) throw new Error('Staged ESLint checks failed');
    }
  });
}
