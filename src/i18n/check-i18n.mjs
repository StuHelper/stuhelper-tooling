import { extractMessageKeys } from './message-keys.mjs';
export { extractMessageKeys, stripSourceComments } from './message-keys.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';

export function flatten(value, prefix = '', output = Object.create(null)) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `Invalid catalogue: ${prefix}`);
  assert(Object.keys(value).length, prefix ? `Empty namespace: ${prefix}` : 'Missing or extra message: Empty catalogue');
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) flatten(item, name, output);
    else { assert(typeof item === 'string' && item.trim(), `Empty or non-text message: ${name}`); assert(!Object.hasOwn(output, name), `Duplicate message: ${name}`); output[name] = item; }
  }
  return output;
}
const pluralOrder = ['zero', 'one', 'two', 'few', 'many', 'other'];
const pluralForms = value => value.replace(/\{\s*(['"])\|\1\s*\}/g, '\0').split('|').map(form => form.replaceAll('\0', "{'|'}"));
const placeholders = value => [...new Set([...value.replace(/\{\s*(['"])\|\1\s*\}/g, '').matchAll(/\{\s*([\w]+)\s*\}/g)].map(match => match[1]))].sort();
export function validateCatalogues(catalogues, languages, exceptions = {}) {
  assert.deepEqual(Object.keys(catalogues).sort(), [...languages].sort(), 'Locale catalogues must cover every configured language');
  const pluralKeys = new Set(Object.values(catalogues).flatMap(catalogue => Object.entries(flatten(catalogue)).filter(([, value]) => pluralForms(value).length > 1).map(([key]) => key)));
  const baseline = flatten(catalogues['zh-CN']);
  const english = catalogues['en-US'] ? flatten(catalogues['en-US']) : {};
  for (const allowed of [exceptions.shared ?? {}, ...Object.values(exceptions.languages ?? {})]) for (const [key, rule] of Object.entries(allowed)) {
    assert(Object.hasOwn(english, key), `Unknown same-text exception: ${key}`);
    assert(typeof rule.value === 'string' && rule.reason?.trim(), `Same-text exception needs a value and reason: ${key}`);
  }
  for (const language of languages) {
    const entries = flatten(catalogues[language]);
    const missing = Object.keys(baseline).filter(key => !Object.hasOwn(entries, key)).sort();
    const extra = Object.keys(entries).filter(key => !Object.hasOwn(baseline, key)).sort();
    if (missing.length || extra.length) {
      const details = [missing.length ? `missing keys: [${missing.join(', ')}]` : '', extra.length ? `extra keys: [${extra.join(', ')}]` : ''].filter(Boolean).join('; ');
      throw new Error(`Missing or extra message in ${language} (${details})`);
    }
    for (const [key, value] of Object.entries(entries)) {
      if (language !== 'en-US' && value === english[key]) {
        const rule = exceptions.languages?.[language]?.[key] ?? exceptions.shared?.[key];
        assert(rule?.value === value, `Unreviewed English text: ${language}/${key}`);
      }
      if (!pluralKeys.has(key)) {
        assert.deepEqual(placeholders(value), placeholders(baseline[key]), `Interpolation mismatch: ${language}/${key}`);
      } else {
        const baseVars = placeholders(baseline[key]);
        const baseSet = new Set(baseVars);
        const categories = pluralOrder.filter(category => new Intl.PluralRules(language).resolvedOptions().pluralCategories.includes(category));
        const forms = pluralForms(value);
        assert.equal(forms.length, categories.length, `Plural categories incomplete: ${language}/${key}`);
        for (const [index, form] of forms.entries()) {
          assert(form.trim(), `Empty plural branch: ${language}/${key}`);
          const formVars = placeholders(form);
          for (const variable of formVars) assert(baseSet.has(variable), `Interpolation mismatch: ${language}/${key}`);
          if (categories[index] === 'many' || categories[index] === 'other') {
            assert.deepEqual(formVars, baseVars, `Missing plural interpolation: ${language}/${key}`);
          }
        }
      }
    }
  }
  return Object.keys(baseline).length;
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', 'coverage', '.turbo', '__tests__'].includes(entry.name)) return files(target);
    return entry.isFile() ? [target] : [];
  });
}
function mergeNamespace(target, messages, prefix) {
  for (const [key, value] of Object.entries(messages)) {
    const name = `${prefix}.${key}`;
    if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value, enumerable: true });
    else {
      assert(value && typeof value === 'object' && typeof target[key] === 'object', `Duplicate message: ${name}`);
      mergeNamespace(target[key], value, name);
    }
  }
}

export function check(directory) {
  const policy = parseYaml(fs.readFileSync(path.join(directory, 'locale-policy.yaml'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'locale-policy.json'), 'utf8')), policy, 'Generated locale-policy.json differs from locale-policy.yaml; regenerate it with stuhelper-check locale-policy --write');
  const languages = Object.keys(policy.languages);
  assert.equal(policy.default, 'zh-CN');
  assert(typeof policy.default_time_zone === 'string' && policy.default_time_zone.trim(), 'Missing default time zone');
  new Intl.DateTimeFormat('en', { timeZone: policy.default_time_zone });
  for (const [language, config] of Object.entries(policy.languages)) {
    assert(['ltr', 'rtl'].includes(config.direction) && (language !== 'ar-EG' || config.direction === 'rtl'), `Invalid direction: ${language}`);
  }
  let appMessages = 0;
  const admin = fs.existsSync(path.join(directory, 'apps/web-antd'));
  const catalogues = Object.fromEntries(languages.map(language => [language, Object.create(null)]));
  for (const language of languages) {
    if (admin) {
      for (const location of ['packages/locales/src/langs', 'apps/web-antd/src/locales/langs']) {
        const folder = path.join(directory, location, language);
        for (const file of files(folder).filter(file => file.endsWith('.json'))) {
          const namespace = path.basename(file, '.json');
          const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
          const entries = flatten(messages, namespace);
          if (language === policy.default && location.startsWith('apps/')) appMessages += Object.keys(entries).length;
          catalogues[language][namespace] ??= Object.create(null);
          mergeNamespace(catalogues[language][namespace], messages, namespace);
        }
      }
    } else catalogues[language] = JSON.parse(fs.readFileSync(path.join(directory, `src/locales/${language}.json`), 'utf8'));
  }
  const count = validateCatalogues(catalogues, languages, policy.same_text_exceptions?.[admin ? 'admin' : 'web']);
  const known = flatten(catalogues[policy.default]);
  const namespaces = new Set(Object.keys(catalogues[policy.default]));
  const roots = admin ? ['apps/web-antd/src', 'packages'] : ['src'];
  for (const file of roots.flatMap(root => files(path.join(directory, root)))) {
    if (!/\.(vue|ts)$/.test(file) || /\.(test|spec|d|gen)\.ts$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const sharedPackage = admin && path.relative(directory, file).startsWith('packages' + path.sep);
    if (sharedPackage
        && !/\bfrom\s*['"](?:@vben\/locales|vue-i18n)['"]/.test(text)) continue;
    const keys = extractMessageKeys(text, { isVue: file.endsWith('.vue'), admin: admin && !sharedPackage, namespaces });
    for (const key of keys) assert(Object.hasOwn(known, key), `${path.relative(directory, file)}: Unknown message key: ${key}`);
  }
  for (const locale of languages) {
    assert(Intl.NumberFormat.supportedLocalesOf([locale]).length, `Number locale unavailable: ${locale}`);
    assert(Intl.DateTimeFormat.supportedLocalesOf([locale]).length, `Date locale unavailable: ${locale}`);
    assert(Intl.PluralRules.supportedLocalesOf([locale]).length, `Plural locale unavailable: ${locale}`);
  }
  const applicationCount = admin ? appMessages : count;
  console.log(`PASS: ${languages.length} locales; application ${applicationCount} messages, shared components ${count - applicationCount}; keys, interpolation, plural forms and reviewed same-text exceptions`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { check(process.cwd()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
