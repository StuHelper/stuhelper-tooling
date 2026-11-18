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
    assert.deepEqual(Object.keys(entries).sort(), Object.keys(baseline).sort(), `Missing or extra message in ${language}`);
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
          assert(form.trim(), `Empty or non-text message: ${language}/${key}`);
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
function stripScriptComments(code) {
  const output = [];
  const templateBraces = [];
  let mode = 'code';
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const next = code[i + 1];
    if (mode === 'line-comment') {
      if (ch === '\n' || ch === '\r') { mode = 'code'; output.push(ch); }
      else output.push(' ');
    } else if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { mode = 'code'; output.push('  '); i += 1; }
      else output.push(ch === '\n' || ch === '\r' ? ch : ' ');
    } else if (mode === "'" || mode === '"') {
      output.push(ch);
      if (ch === '\\' && i + 1 < code.length) { output.push(next); i += 1; }
      else if (ch === mode) mode = 'code';
    } else if (mode === '`') {
      output.push(ch);
      if (ch === '\\' && i + 1 < code.length) { output.push(next); i += 1; }
      else if (ch === '$' && next === '{') { output.push(next); i += 1; templateBraces.push(0); mode = 'code'; }
      else if (ch === '`') mode = 'code';
    } else if (ch === '/' && next === '/') {
      mode = 'line-comment'; output.push('  '); i += 1;
    } else if (ch === '/' && next === '*') {
      mode = 'block-comment'; output.push('  '); i += 1;
    } else {
      output.push(ch);
      if (ch === "'" || ch === '"' || ch === '`') mode = ch;
      else if (templateBraces.length) {
        if (ch === '{') templateBraces[templateBraces.length - 1] += 1;
        else if (ch === '}') {
          if (templateBraces[templateBraces.length - 1] === 0) { templateBraces.pop(); mode = '`'; }
          else templateBraces[templateBraces.length - 1] -= 1;
        }
      }
    }
  }
  return output.join('');
}
export function stripSourceComments(source, isVue = false) {
  if (!isVue) return stripScriptComments(source);
  const withoutHtmlComments = source.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\r\n]/g, ' '));
  return withoutHtmlComments
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, open, body, close) => `${open}${stripScriptComments(body)}${close}`)
    .replace(/\{\{[\s\S]*?\}\}/g, block => stripScriptComments(block));
}
export function extractMessageKeys(source, { isVue = false, admin = false } = {}) {
  const cleaned = stripSourceComments(source, isVue);
  const calls = [
    ...[...cleaned.matchAll(/\b\$?t\(\s*(['"])([^'"\r\n]+)\1/g)].map(match => match[2]),
    ...[...cleaned.matchAll(/\b\$?t\(\s*`([\w.-]+)`\s*[,)]/g)].map(match => match[1]),
  ];
  const components = isVue ? [
    ...[...cleaned.matchAll(/<(?:i18n-t|I18nT)\b[^>]*?\s(?<!:|v-bind:)keypath\s*=\s*(['"])([^'"\r\n]+)\1/g)].map(match => match[2]),
    ...[...cleaned.matchAll(/<(?:i18n-t|I18nT)\b[^>]*?\s(?::|v-bind:)keypath\s*=\s*(?:"'([^'"\r\n]+)'"|'"([^'"\r\n]+)"'|["']`([\w.-]+)`["'])/g)].map(match => match[1] ?? match[2] ?? match[3]),
    ...[...cleaned.matchAll(/\bv-t\s*=\s*(?:"'([^'"\r\n]+)'"|'"([^'"\r\n]+)"'|["']`([\w.-]+)`["'])/g)].map(match => match[1] ?? match[2] ?? match[3]),
    ...[...cleaned.matchAll(/\bv-t\s*=\s*(['"])(\{[\s\S]*?\})\1/g)].flatMap(match => [...match[2].matchAll(/\bpath\s*:\s*(['"`])([\w.-]+)\1/g)].map(inner => inner[2])),
  ] : [];
  const metadata = admin ? [...cleaned.matchAll(/['"]((?:page|common|authentication|preferences|ui|profile)\.[\w.]+)['"]/g)].map(match => match[1]) : [];
  return [...calls, ...components, ...metadata];
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
    for (const key of extractMessageKeys(text, { isVue: file.endsWith('.vue'), admin })) {
      assert(Object.hasOwn(known, key), `Unknown message key: ${path.relative(directory, file)} -> ${key}`);
    }
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
