import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint } from 'markdownlint/promise';
import { parse as parseYaml } from 'yaml';
import picomatch from 'picomatch';
import { filesIn } from './check-docs.mjs';

export async function lintMarkdown(root) {
  const settings = parseYaml(fs.readFileSync(path.join(root, '.markdownlint-cli2.yaml'), 'utf8'));
  const errors = [];
  for (const file of filesIn(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    let config = { ...settings.config };
    for (const override of settings.overrides ?? []) {
      if (override.combine !== 'merge') throw new Error('Only merged markdownlint overrides are supported');
      if (picomatch(override.filter, { dot: true })(relative)) {
        config = { ...config, ...override.config };
        break;
      }
    }
    const result = await lint({ files: [file], config });
    for (const violation of result[file] ?? []) {
      errors.push(`${relative}:${violation.lineNumber}: ${violation.ruleNames.join('/')} ${violation.ruleDescription}${violation.errorDetail ? ` (${violation.errorDetail})` : ''}`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await lintMarkdown(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: markdownlint formatting');
  }
}
