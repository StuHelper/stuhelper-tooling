import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';

export function privateMaterialErrors(file) {
  const name = path.basename(file).toLowerCase();
  const extension = path.extname(file).toLowerCase();
  const errors = [];
  if ((name.startsWith('.env') || extension === '.env') && !name.endsWith('.example')) errors.push(`${file}: runtime environment file`);
  if (['.pem', '.key', '.p12', '.pfx', '.dump', '.backup'].includes(extension)) errors.push(`${file}: private material extension`);
  return errors;
}

export function checkSource(file, source, executable = false) {
  const errors = privateMaterialErrors(file);
  try {
    if (file.endsWith('.json')) JSON.parse(source);
    if (/\.ya?ml$/.test(file)) {
      const doc = parseDocument(source, { merge: true, logLevel: 'silent' });
      if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
    }
  } catch (error) { errors.push(`${file}: ${error.message}`); }
  if (/\.(?:mjs|js|py|sh)$/.test(file)) {
    if (source.startsWith('#!') && !executable) errors.push(`${file}: a direct script entry needs the executable bit in Git`);
    if (executable && !source.startsWith('#!')) errors.push(`${file}: executable script needs a shebang`);
  }
  return errors;
}

export function checkRepository(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  const files = [...new Set(output.split('\0').filter(Boolean))];
  const indexed = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' });
  const modes = new Map(indexed.split('\0').filter(Boolean).map(record => [record.slice(record.indexOf('\t') + 1), record.slice(0, 6)]));
  const errors = [];
  for (const file of files) {
    const location = path.join(root, file);
    if (!fs.existsSync(location) || !fs.lstatSync(location).isFile()) continue;
    const source = fs.readFileSync(location);
    if (source.includes(0)) { errors.push(...privateMaterialErrors(file)); continue; }
    const executable = modes.has(file) ? modes.get(file) === '100755' : Boolean(fs.statSync(location).mode & 0o111);
    errors.push(...checkSource(file, source.toString('utf8'), executable));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return files.length;
}
