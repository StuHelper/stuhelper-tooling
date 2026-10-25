#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { reported } from '../src/report.mjs';
import { checkRepository } from '../src/repository.mjs';
import { checkDocs } from '../src/docs/check-docs.mjs';
import { lintMarkdown } from '../src/docs/lint-markdown.mjs';
import { check as checkI18n } from '../src/i18n/check-i18n.mjs';
import { checkStaged } from '../src/staged.mjs';

await reported(process.argv[2] || 'check', async () => {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { glossary: { type: 'string' }, eslint: { type: 'boolean', default: false }, write: { type: 'boolean', default: false } } });
  const [command] = positionals;
  if (values.write && command !== 'locale-policy') throw new Error('--write is only supported by locale-policy');
  if (command === 'repository') checkRepository(process.cwd());
  else if (command === 'docs') {
    const errors = [...await lintMarkdown(process.cwd()), ...checkDocs(process.cwd(), { glossary: values.glossary }).errors];
    if (errors.length) throw new Error(errors.join('\n'));
  } else if (command === 'i18n') checkI18n(process.cwd());
  else if (command === 'locale-policy') {
    const source = parseYaml(fs.readFileSync('locale-policy.yaml', 'utf8'));
    if (values.write) fs.writeFileSync('locale-policy.json', `${JSON.stringify(source, null, 2)}\n`);
    else assert.deepEqual(JSON.parse(fs.readFileSync('locale-policy.json', 'utf8')), source, 'Generated locale-policy.json differs; run stuhelper-check locale-policy --write');
  }
  else if (command === 'staged') await checkStaged(process.cwd(), { eslint: values.eslint });
  else if (command === 'workflows') execFileSync('actionlint', ['-color', '-shellcheck=', '-pyflakes='], { stdio: 'inherit' });
  else throw new Error('Use repository, docs [--glossary FILE], i18n, locale-policy [--write], staged [--eslint], or workflows.');
});
