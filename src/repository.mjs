import { gitMaxBuffer } from './git-options.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';

export function privateMaterialErrors(file) {
  const name = path.basename(file).toLowerCase();
  const extension = path.extname(file).toLowerCase();
  const errors = [];
  if ((name.startsWith('.env') || extension === '.env') && !name.endsWith('.example')) errors.push(`${file}: runtime environment file`);
  if (/(?:^|\/)(?:secrets|private)\//i.test(file)) errors.push(`${file}: private material directory`);
  if (/\.(?:dump|backup)\.|\.sqlite/i.test(name)) errors.push(`${file}: database or backup file`);
  if (['.pem', '.key', '.p12', '.pfx', '.dump', '.backup'].includes(extension)) errors.push(`${file}: private material extension`);
  return errors;
}

const privateKeyHeader = /^-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[ \t]*\r?$/m;

export function checkSource(file, source, executable = false) {
  const errors = privateMaterialErrors(file);
  if (errors.length) return errors;
  if (privateKeyHeader.test(source)) return [`${file}: private key material`];
  try {
    if (file.endsWith('.json')) JSON.parse(source);
    if (/\.ya?ml$/.test(file)) {
      const doc = parseDocument(source, { merge: true, logLevel: 'silent' });
      if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
    }
  } catch (error) { errors.push(`${file}: ${error.message}`); }
  const entry = /(?:^|\/)bin\/[^/.]+$/.test(file);
  const script = entry || /\.(?:mjs|js|py|sh)$/.test(file);
  const shebang = source.startsWith('#!');
  if (script && shebang && !executable) errors.push(`${file}: a direct script entry needs the executable bit in Git`);
  if ((entry || (script && executable)) && !shebang) errors.push(`${file}: executable script needs a shebang`);
  if (executable && /\.(?:go|ts|json|md|markdown|ya?ml)$/.test(file)) errors.push(`${file}: ordinary source must not be executable`);
  return errors;
}

// Inspect complete text lines without allocating a file-sized buffer for opaque assets.
// The retained tail is longer than any supported PEM or OpenPGP armor header.
export function checkFile(file, location, executable) {
  const named = privateMaterialErrors(file);
  if (named.length) return named;
  const binaryErrors = () => executable && /\.(?:go|ts|json|md|markdown|ya?ml|mjs|js|py|sh)$/.test(file)
    ? [`${file}: ordinary source must not be executable`] : [];
  if (/\.(?:json|ya?ml)$/.test(file)) {
    const data = fs.readFileSync(location);
    return data.includes(0) ? binaryErrors() : checkSource(file, data.toString('utf8'), executable);
  }
  const fd = fs.openSync(location, 'r');
  const buffer = Buffer.allocUnsafe(65536);
  let prefix = '';
  let tail = '';
  let first = true;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer);
      if (!count) break;
      const bytes = buffer.subarray(0, count);
      if (bytes.includes(0)) return binaryErrors();
      if (first) {
        prefix = bytes.subarray(0, 2).toString('latin1');
        first = false;
      }
      const text = tail + bytes.toString('latin1');
      const end = text.lastIndexOf('\n') + 1;
      if (end && privateKeyHeader.test(text.slice(0, end))) return [`${file}: private key material`];
      tail = text.length - end > 256 ? 'x' + text.slice(-256) : text.slice(end);
    }
    if (privateKeyHeader.test(tail)) return [`${file}: private key material`];
    return checkSource(file, prefix, executable);
  } finally {
    fs.closeSync(fd);
  }
}

export function checkRepository(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: gitMaxBuffer });
  const files = [...new Set(output.split('\0').filter(Boolean))];
  const indexed = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: gitMaxBuffer });
  const modes = new Map(indexed.split('\0').filter(Boolean).map(record => [record.slice(record.indexOf('\t') + 1), record.slice(0, 6)]));
  const errors = [];
  for (const file of files) {
    const location = path.join(root, file);
    const stat = fs.lstatSync(location, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile()) {
      errors.push(...privateMaterialErrors(file));
      continue;
    }
    const executable = modes.has(file) ? modes.get(file) === '100755' : Boolean(stat.mode & 0o111);
    errors.push(...checkFile(file, location, executable));
  }
  if (errors.length) throw new AggregateError(errors, errors.join('\n'));
  return files.length;
}
