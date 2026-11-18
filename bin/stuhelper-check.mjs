#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { reported } from '../src/report.mjs';
import { checkRepository } from '../src/repository.mjs';
import { checkDocs } from '../src/docs/check-docs.mjs';
import { lintMarkdown } from '../src/docs/lint-markdown.mjs';
import { check as checkI18n } from '../src/i18n/check-i18n.mjs';
import { checkStaged } from '../src/staged.mjs';

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: {
    glossary: { type: 'string' }, eslint: { type: 'boolean' }, write: { type: 'boolean' },
  } });
} catch (error) {
  await reported('check', () => { throw error; });
}

if (parsed) await reported(parsed.positionals[0] || 'check', async () => {
  const { positionals: [command, ...extra], values } = parsed;
  if (extra.length) throw new Error('Unexpected positional argument');
  const owners = { glossary: 'docs', eslint: 'staged', write: 'locale-policy' };
  for (const name of Object.keys(values)) {
    if (owners[name] !== command) throw new Error(`--${name} is only supported by ${owners[name]}`);
  }
  if (command === 'repository') checkRepository(process.cwd());
  else if (command === 'docs') {
    const errors = [...await lintMarkdown(process.cwd()), ...checkDocs(process.cwd(), { glossary: values.glossary }).errors];
    if (errors.length) throw new AggregateError(errors, errors.join('\n'));
  } else if (command === 'i18n') checkI18n(process.cwd());
  else if (command === 'locale-policy') {
    const source = parseYaml(fs.readFileSync('locale-policy.yaml', 'utf8'));
    if (values.write) fs.writeFileSync('locale-policy.json', `${JSON.stringify(source, null, 2)}\n`);
    else assert.deepEqual(JSON.parse(fs.readFileSync('locale-policy.json', 'utf8')), source, 'Generated locale-policy.json differs; run stuhelper-check locale-policy --write');
  }
  else if (command === 'staged') await checkStaged(process.cwd(), { eslint: values.eslint });
  else if (command === 'workflows') {
    const result = spawnSync('actionlint', [...(process.stdout.isTTY || process.env.GITHUB_ACTIONS === 'true' ? ['-color'] : []), '-format', '{{json .}}', '-shellcheck=', '-pyflakes='], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (!result.stdout.trim()) throw new Error(result.stderr.trim() || 'actionlint failed');
      const messages = JSON.parse(result.stdout).map(item => `${item.filepath}:${item.line}: ${item.message}`);
      if (!messages.length) throw new Error(result.stderr.trim() || 'actionlint failed');
      throw new AggregateError(messages, messages.join('\n'));
    }
  }
  else throw new Error('Use repository, docs [--glossary FILE], i18n, locale-policy [--write], staged [--eslint], or workflows.');
});
