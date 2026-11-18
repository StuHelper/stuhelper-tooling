import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCatalogues } from './check-i18n.mjs';
test('missing translations, blank text and changed interpolation fail', () => {
  const messages = { 'zh-CN': { welcome: '你好，{name}' }, 'en-US': { welcome: 'Hello, {name}' } };
  assert.equal(validateCatalogues(messages, ['zh-CN', 'en-US']), 1);
  assert.throws(() => validateCatalogues({ ...messages, 'en-US': {} }, ['zh-CN', 'en-US']), /Missing or extra/);
  assert.throws(() => validateCatalogues({ ...messages, 'en-US': { welcome: '' } }, ['zh-CN', 'en-US']), /Empty/);
  assert.throws(() => validateCatalogues({ ...messages, 'en-US': { welcome: '{other}' } }, ['zh-CN', 'en-US']), /Interpolation/);
  assert.throws(() => validateCatalogues(messages, ['zh-CN', 'en-US', 'fr-FR']), /every configured language/);
});
test('Arabic translations include all six plural forms', () => {
  const messages = { 'zh-CN': { count: '{count} 项' }, 'ar-EG': { count: '{count} عنصر | {count} عناصر' } };
  assert.throws(() => validateCatalogues(messages, ['zh-CN', 'ar-EG']), /Plural categories/);
});


test('untranslated English requires an exact reviewed value, including after source text changes', () => {
  const catalogues = { 'zh-CN': { label: '模式' }, 'en-US': { label: 'Mode' }, 'fr-FR': { label: 'Mode' } };
  assert.throws(() => validateCatalogues(catalogues, Object.keys(catalogues)), /Unreviewed English text/);
  const exceptions = { languages: { 'fr-FR': { label: { value: 'Mode', reason: 'Correct French spelling.' } } } };
  assert.equal(validateCatalogues(catalogues, Object.keys(catalogues), exceptions), 1);
  catalogues['en-US'].label = catalogues['fr-FR'].label = 'Changed untranslated sentence';
  assert.throws(() => validateCatalogues(catalogues, Object.keys(catalogues), exceptions), /Unreviewed English text/);
});

test('plural forms contain text and a quoted pipe is literal', () => {
  const validate = (zh, en) => validateCatalogues({ 'zh-CN': { tip: zh }, 'en-US': { tip: en } }, ['zh-CN', 'en-US']);
  assert.throws(() => validate('无', 'None |   '), /Empty plural/);
  assert.equal(validate("课程 {'|'} 资料", "Course {'|'} resources"), 1);
  assert.throws(() => validateCatalogues({ 'zh-CN': { tip: '无', unused: {} } }, ['zh-CN']), /Empty/);
  assert.throws(() => validateCatalogues({ 'zh-CN': { 'a.b': '值', a: { b: '值' } } }, ['zh-CN']), /Duplicate/);
});
