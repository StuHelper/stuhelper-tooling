import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';

export function flatten(value, prefix = '', output = {}) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) flatten(item, name, output);
    else { assert(typeof item === 'string' && item.trim(), `Empty or non-text message: ${name}`); output[name] = item; }
  }
  return output;
}
export function validateCatalogues(catalogues, languages, exceptions = {}) {
  assert.deepEqual(Object.keys(catalogues).sort(), [...languages].sort(), 'Locale catalogues must cover every configured language');
  const baseline = flatten(catalogues['zh-CN']);
  const english = catalogues['en-US'] ? flatten(catalogues['en-US']) : {};
  for (const allowed of [exceptions.shared ?? {}, ...Object.values(exceptions.languages ?? {})]) for (const [key, rule] of Object.entries(allowed)) {
    assert(Object.hasOwn(english, key), `Unknown same-text exception: ${key}`);
    assert(typeof rule.value === 'string' && rule.reason?.trim(), `Same-text exception needs a value and reason: ${key}`);
  }
  const pluralKeys = new Set(Object.values(catalogues).flatMap(catalogue => Object.entries(flatten(catalogue)).filter(([, value]) => value.includes('|')).map(([key]) => key)));
  const placeholders = value => [...new Set([...value.matchAll(/\{\s*([\w]+)\s*\}/g)].map(match => match[1]))].sort();
  for (const language of languages) {
    const entries = flatten(catalogues[language]);
    assert.deepEqual(Object.keys(entries).sort(), Object.keys(baseline).sort(), `Missing or extra message in ${language}`);
    for (const [key, value] of Object.entries(entries)) {
      if (language !== 'en-US' && value === english[key]) {
        const rule = exceptions.languages?.[language]?.[key] ?? exceptions.shared?.[key];
        assert(rule?.value === value, `Unreviewed English text: ${language}/${key}`);
      }
      assert.deepEqual(placeholders(value), placeholders(baseline[key]), `Interpolation mismatch: ${language}/${key}`);
      if (pluralKeys.has(key)) {
        const expected = new Intl.PluralRules(language).resolvedOptions().pluralCategories.length;
        assert.equal(value.split('|').length, expected, `Plural categories incomplete: ${language}/${key}`);
        for (const form of value.split('|')) assert.deepEqual(placeholders(form), placeholders(value), `Missing plural interpolation: ${language}/${key}`);
      }
    }
  }
  return Object.keys(baseline).length;
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
export function check(directory) {
  const policy = parseYaml(fs.readFileSync(path.join(directory, 'locale-policy.yaml'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'locale-policy.json'), 'utf8')), policy, 'Generated locale-policy.json differs from locale-policy.yaml; regenerate it with stuhelper-check locale-policy --write');
  const languages = Object.keys(policy.languages);
  const admin = fs.existsSync(path.join(directory, 'apps/web-antd'));
  const catalogues = Object.fromEntries(languages.map(language => [language, {}]));
  for (const language of languages) {
    if (admin) {
      for (const location of ['packages/locales/src/langs', 'apps/web-antd/src/locales/langs']) {
        const folder = path.join(directory, location, language);
        for (const file of files(folder).filter(file => file.endsWith('.json'))) catalogues[language][path.basename(file, '.json')] = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } else catalogues[language] = JSON.parse(fs.readFileSync(path.join(directory, `src/locales/${language}.json`), 'utf8'));
  }
  const count = validateCatalogues(catalogues, languages, policy.same_text_exceptions?.[admin ? 'admin' : 'web']);
  const known = flatten(catalogues[policy.default]);
  for (const file of files(path.join(directory, admin ? 'apps/web-antd/src' : 'src'))) {
    if (!/\.(vue|ts)$/.test(file) || /\.(test|gen)\.ts$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const calls = [...text.matchAll(/\b\$?t\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    const metadata = admin ? [...text.matchAll(/['"]((?:page|common|authentication|preferences|ui|profile)\.[\w.]+)['"]/g)].map(match => match[1]) : [];
    for (const key of [...calls, ...metadata]) assert(Object.hasOwn(known, key), `Unknown message key: ${path.relative(directory, file)} -> ${key}`);
  }
  assert.equal(policy.default, 'zh-CN');
  for (const locale of languages) {
    assert(Intl.NumberFormat.supportedLocalesOf([locale]).length, `Number locale unavailable: ${locale}`);
    assert(Intl.DateTimeFormat.supportedLocalesOf([locale]).length, `Date locale unavailable: ${locale}`);
    assert(Intl.PluralRules.supportedLocalesOf([locale]).length, `Plural locale unavailable: ${locale}`);
  }
  const applicationCount = admin ? Object.keys(flatten(catalogues[policy.default].page)).length : count;
  console.log(`PASS: ${languages.length} locales; application ${applicationCount} messages, shared components ${count - applicationCount}; keys, interpolation, plural forms and reviewed same-text exceptions`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.cwd()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
