import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const posix = value => value.split(path.sep).join('/');
const sha256Hex = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeRelativePath(root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim() || path.isAbsolute(candidate) || candidate.split('/').includes('..')) return false;
  const resolved = path.resolve(root, candidate);
  if (!inside(root, resolved)) return false;
  return !fs.existsSync(resolved) || inside(root, fs.realpathSync(resolved));
}

function listFiles(root, env = process.env) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    return [...new Set(out.split('\0').filter(Boolean))].sort();
  } catch {
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) return [];
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(target) : [posix(path.relative(root, target))];
    });
    return walk(root).sort();
  }
}

export function checkGeneratedHeader(file, head) {
  if (/\.gen\.go$/.test(file)) {
    return /Code generated .* DO NOT EDIT\./i.test(head)
      ? []
      : [`${file}: generated Go file must preserve the "Code generated ... DO NOT EDIT." header; regenerate from contract instead of editing manually`];
  }
  if (/\.gen\.[cm]?[jt]s$/.test(file)) {
    return /(?:auto-generated|Code generated)[\s\S]{0,240}(?:Do not make direct changes|DO NOT EDIT)/i.test(head)
      ? []
      : [`${file}: generated SDK file must preserve its generator header; regenerate from OpenAPI instead of editing manually`];
  }
  return [];
}

function findCompanionContract(root, sourceFile) {
  const dir = path.dirname(sourceFile);
  const stem = path.basename(sourceFile, '.source.json');
  for (const ext of ['.openapi.yaml', '.openapi.yml', '.openapi.json']) {
    const candidate = posix(path.join(dir, `${stem}${ext}`));
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

function verifySourceManifest(root, sourceFile) {
  const errors = [];
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(root, sourceFile), 'utf8'));
  } catch (error) {
    return [`${sourceFile}: invalid JSON (${error.message})`];
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [`${sourceFile}: contract source manifest must be a JSON object`];
  }

  const commitKeys = ['revision', 'source_commit', 'reference_revision'].filter(key => key in record);
  if (!commitKeys.length) {
    errors.push(`${sourceFile}: missing provider commit field (revision, source_commit, or reference_revision)`);
  }
  for (const key of commitKeys) {
    if (typeof record[key] !== 'string' || !/^[0-9a-f]{40}$/.test(record[key])) {
      errors.push(`${sourceFile}: ${key} must be a 40-character lowercase SHA-1 hex string`);
    }
  }

  if ('files' in record) {
    if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files) || !Object.keys(record.files).length) {
      errors.push(`${sourceFile}: files must be a non-empty object mapping provider paths to local paths`);
    } else {
      for (const [providerPath, localPath] of Object.entries(record.files)) {
        if (typeof providerPath !== 'string' || !providerPath.trim() || path.isAbsolute(providerPath) || providerPath.split('/').includes('..')) {
          errors.push(`${sourceFile}: invalid provider path "${providerPath}"`);
        }
        if (!safeRelativePath(root, localPath)) {
          errors.push(`${sourceFile}: invalid local path "${localPath}"`);
        } else if (!fs.existsSync(path.join(root, localPath))) {
          errors.push(`${sourceFile}: missing snapshot file "${localPath}"`);
        }
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (!key.endsWith('_sha256')) continue;
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      errors.push(`${sourceFile}: ${key} must be a 64-character lowercase SHA-256 hex string`);
    }
  }

  const companion = findCompanionContract(root, sourceFile);
  if (typeof record.sha256 === 'object' && record.sha256 !== null && !Array.isArray(record.sha256)) {
    const entries = Object.entries(record.sha256);
    if (!entries.length) errors.push(`${sourceFile}: sha256 map must not be empty`);
    for (const [localPath, expected] of entries) {
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
        errors.push(`${sourceFile}: sha256["${localPath}"] must be a 64-character SHA-256 hex string`);
        continue;
      }
      if (!safeRelativePath(root, localPath) || !fs.existsSync(path.join(root, localPath))) {
        errors.push(`${sourceFile}: missing file for sha256["${localPath}"]`);
        continue;
      }
      const actual = sha256Hex(fs.readFileSync(path.join(root, localPath)));
      if (actual !== expected) {
        errors.push(`${sourceFile}: ${localPath} SHA-256 mismatch (expected ${expected}, got ${actual}); regenerate instead of editing manually`);
      }
    }
  } else if (typeof record.sha256 === 'string') {
    if (!/^[0-9a-f]{64}$/.test(record.sha256)) {
      errors.push(`${sourceFile}: sha256 must be a 64-character lowercase SHA-256 hex string`);
    } else {
      const target = typeof record.path === 'string' && safeRelativePath(root, record.path) ? record.path : companion;
      if (typeof record.path === 'string' && (!safeRelativePath(root, record.path) || !fs.existsSync(path.join(root, record.path)))) {
        errors.push(`${sourceFile}: missing contract file "${record.path}"`);
      } else if (target && fs.existsSync(path.join(root, target))) {
        const actual = sha256Hex(fs.readFileSync(path.join(root, target)));
        if (actual !== record.sha256) {
          errors.push(`${sourceFile}: ${target} SHA-256 mismatch (expected ${record.sha256}, got ${actual})`);
        }
      }
    }
  } else if (typeof record.contract_sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.contract_sha256) && companion) {
    const actual = sha256Hex(fs.readFileSync(path.join(root, companion)));
    if (actual !== record.contract_sha256) {
      errors.push(`${sourceFile}: ${companion} SHA-256 mismatch (expected ${record.contract_sha256}, got ${actual})`);
    }
  } else if (!('contract_sha256' in record)) {
    errors.push(`${sourceFile}: missing sha256 digest`);
  }

  if (typeof record.browser_sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.browser_sha256) && typeof record.files?.['sdk/browser.ts'] === 'string') {
    const browserFile = record.files['sdk/browser.ts'];
    if (safeRelativePath(root, browserFile) && fs.existsSync(path.join(root, browserFile))) {
      const actual = sha256Hex(fs.readFileSync(path.join(root, browserFile)));
      if (actual !== record.browser_sha256) {
        errors.push(`${sourceFile}: ${browserFile} SHA-256 mismatch (expected ${record.browser_sha256}, got ${actual})`);
      }
    }
  }

  const declaredVersion = typeof record.version === 'string' ? record.version : (typeof record.contract_version === 'string' ? record.contract_version : null);
  if (declaredVersion && companion) {
    try {
      const spec = parseYaml(fs.readFileSync(path.join(root, companion), 'utf8'));
      if (spec?.info?.version && spec.info.version !== declaredVersion) {
        errors.push(`${sourceFile}: ${companion} info.version "${spec.info.version}" differs from snapshot version "${declaredVersion}"`);
      }
    } catch (error) {
      errors.push(`${companion}: invalid OpenAPI document (${error.message})`);
    }
  }
  return errors;
}

const isContractOrGeneratorDriver = file => (
  /^contracts\//.test(file)
  || /(?:^|\/)openapi/i.test(file)
  || /\.(?:openapi|schema)\.(?:json|ya?ml)$/.test(file)
  || /\.source\.json$/.test(file)
  || /^scripts\//.test(file)
  || /^(?:package\.json|pnpm-lock\.yaml|go\.mod|go\.sum|tools\/go\.mod|tools\/go\.sum|Makefile)$/.test(file)
);

function checkIsolatedGenEdits(root, files, requestedBase, env = process.env) {
  let base = requestedBase || 'HEAD';
  if (/^0+$/.test(base)) return [];
  try {
    const top = fs.realpathSync(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (top !== root) return [];
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${base}^{commit}`], { env, stdio: 'ignore' });
  } catch {
    return [];
  }

  const diffOut = execFileSync('git', ['-C', root, 'diff', '--name-only', base, '-z'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  const untrackedOut = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  const changed = [...new Set([...diffOut.split('\0'), ...untrackedOut.split('\0')].filter(Boolean))];
  const modifiedGen = changed.filter(file => /\.gen\.(?:[cm]?[jt]s|go)$/.test(file) && files.includes(file));
  if (!modifiedGen.length) return [];
  if (changed.some(isContractOrGeneratorDriver)) return [];
  return modifiedGen.map(file => `${file}: generated file modified without corresponding contract or generator update; update OpenAPI/schema and regenerate instead of editing directly`);
}

export function checkContracts(directory, { base = process.env.CONTRACT_BASE_REF, env = process.env } = {}) {
  const root = fs.realpathSync(directory);
  const files = listFiles(root, env);
  const errors = [];
  for (const file of files) {
    const location = path.join(root, file);
    if (!fs.existsSync(location) || !fs.lstatSync(location).isFile()) continue;
    if (/\.gen\.(?:[cm]?[jt]s|go)$/.test(file)) {
      const fd = fs.openSync(location, 'r');
      const buffer = Buffer.alloc(1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      errors.push(...checkGeneratedHeader(file, buffer.subarray(0, bytes).toString('utf8')));
    }
    if (/^contracts\/.*\.source\.json$/.test(file)) {
      errors.push(...verifySourceManifest(root, file));
    }
  }
  errors.push(...checkIsolatedGenEdits(root, files, base, env));
  return errors;
}
