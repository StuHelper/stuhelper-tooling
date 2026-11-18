import { gitMaxBuffer } from './git-options.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkFile, privateMaterialErrors } from './repository.mjs';
import { checkContracts } from './contracts.mjs';
import { checkDocs } from './docs/check-docs.mjs';
import { lintMarkdown } from './docs/lint-markdown.mjs';
import { check as checkI18n } from './i18n/check-i18n.mjs';

const git = (root, args, env = process.env) => execFileSync('git', ['-C', root, ...args], { env, maxBuffer: gitMaxBuffer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function linkNodeModules(sourceRoot, targetRoot, relative = '') {
  const current = path.join(sourceRoot, relative);
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const relPath = path.join(relative, entry.name);
    const destination = path.join(targetRoot, relPath);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (entry.name === 'node_modules') {
      const source = path.join(sourceRoot, relPath);
      if (!existing && fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        fs.symlinkSync(source, destination, 'dir');
      }
    } else if (entry.isDirectory() && existing?.isDirectory()) {
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
  const files = git(root, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACDMT', '-z']).split('\0').filter(Boolean);
  if (!files.length) return;
  await withIndex(root, async (target, env) => {
    const errors = [];
    let base = 'HEAD';
    try { git(target, ['rev-parse', '--verify', 'HEAD'], env); } catch { base = '0'.repeat(40); }
    const records = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
    const modes = new Map(records.map(record => [record.slice(record.indexOf('\t') + 1), record.slice(0, 6)]));
    const scripts = [];
    for (const file of files) {
      const location = path.join(target, file);
      if (!modes.has(file)) continue; // A deleted path still triggers the document checks below.
      if (!fs.lstatSync(location).isFile()) {
        errors.push(...privateMaterialErrors(file));
        continue;
      }
      if (/\.(?:[cm]?js|ts|tsx|vue)$/.test(file)) scripts.push(file);
      const violations = checkFile(file, location, modes.get(file) === '100755');
      errors.push(...violations);
      if (violations.length) continue;
      if (file.endsWith('.go')) {
        const source = fs.readFileSync(location, 'utf8');
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
    if (!errors.length && files.some(file => /\.(?:md|markdown)$|^mkdocs\.yml$|^\.markdownlint-cli2\.yaml$/.test(file)) && (files.includes('.markdownlint-cli2.yaml') || fs.existsSync(path.join(target, '.markdownlint-cli2.yaml')))) {
      const resolvedGlossary = glossary
        ? (!path.isAbsolute(glossary) && fs.existsSync(path.join(target, glossary)) ? path.join(target, glossary) : path.resolve(root, glossary))
        : undefined;
      errors.push(...await lintMarkdown(target), ...checkDocs(target, { base, env, glossary: resolvedGlossary }).errors);
    }
    if (!errors.length && fs.existsSync(path.join(target, 'locale-policy.yaml')) && files.some(file => /^locale-policy\.(?:ya?ml|json)$|(?:^|\/)locales\/.*\.json$|\.(?:vue|ts|tsx)$/.test(file))) {
      try { checkI18n(target); } catch (error) { errors.push(error.message); }
    }
    if (!errors.length && files.some(file => /\.gen\.(?:[cm]?[jt]s|go)$|^contracts\//.test(file))) {
      errors.push(...checkContracts(target, { base, env }));
    }
    if (errors.length) throw new AggregateError(errors, errors.join('\n'));
    if (eslint && scripts.length) {
      const checked = spawnSync('pnpm', ['exec', 'eslint', '--max-warnings=0', '--no-warn-ignored', ...scripts], { cwd: target, env, stdio: 'inherit' });
      if (checked.error) throw checked.error;
      if (checked.status !== 0) throw new Error('Staged ESLint checks failed');
    }
  });
}
