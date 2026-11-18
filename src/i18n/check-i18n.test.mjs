import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { check, extractMessageKeys, stripSourceComments, validateCatalogues } from './check-i18n.mjs';

test('missing translations, blank text and changed interpolation fail', () => {
  const messages = { 'zh-CN': { welcome: '你好，{name}' }, 'en-US': { welcome: 'Hello, {name}' } };
  assert.equal(validateCatalogues(messages, ['zh-CN', 'en-US']), 1);
  assert.throws(() => validateCatalogues({ ...messages, 'en-US': {} }, ['zh-CN', 'en-US']), /Missing or extra/);
  assert.throws(() => validateCatalogues({ ...messages, 'en-US': { welcome: '' } }, ['zh-CN', 'en-US']), /Empty/);
  assert.throws(() => validateCatalogues({ ...messages, 'en-US': { welcome: '{other}' } }, ['zh-CN', 'en-US']), /Interpolation/);
  assert.throws(() => validateCatalogues(messages, ['zh-CN', 'en-US', 'fr-FR']), /every configured language/);
});

test('Arabic translations include all six plural forms and allow natural zero/one/two without {count}', () => {
  const incomplete = { 'zh-CN': { count: '{count} 项' }, 'ar-EG': { count: '{count} عنصر | {count} عناصر' } };
  assert.throws(() => validateCatalogues(incomplete, ['zh-CN', 'ar-EG']), /Plural categories/);

  const natural = {
    'zh-CN': { reviews: '{count} 条评价', sep: "课程评价 {'|'} 学习资料" },
    'en-US': { reviews: 'One review | {count} reviews', sep: "Course reviews {'|'} Study resources" },
    'fr-FR': { reviews: 'Aucun ou un avis | {count} d’avis | {count} avis', sep: "Avis {'|'} Ressources" },
    'es-ES': { reviews: 'Una reseña | {count} de reseñas | {count} reseñas', sep: "Reseñas {'|'} Recursos" },
    'ru-RU': { reviews: '{count} отзыв | {count} отзыва | {count} отзывов | {count} отзыва', sep: "Отзывы {'|'} Материалы" },
    'ja-JP': { reviews: '{count} 件の評価', sep: "授業評価 {'|'} 学習資料" },
    'ko-KR': { reviews: '평가 {count}개', sep: "강의평가 {'|'} 학습자료" },
    'ar-EG': { reviews: 'لا توجد تقييمات | تقييم واحد | تقييمان | {count} تقييمات | {count} تقييمًا | {count} تقييم', sep: "التقييمات {'|'} المواد" },
  };
  assert.equal(validateCatalogues(natural, Object.keys(natural)), 2);

  assert.throws(
    () => validateCatalogues({ 'zh-CN': { reviews: '{count} 条评价' }, 'en-US': { reviews: '{typo} review | {count} reviews' } }, ['zh-CN', 'en-US']),
    /Interpolation mismatch: en-US\/reviews/,
  );
  assert.throws(
    () => validateCatalogues({ 'zh-CN': { reviews: '{count} 条评价' }, 'en-US': { reviews: 'One review | Many reviews' } }, ['zh-CN', 'en-US']),
    /Missing plural interpolation: en-US\/reviews/,
  );
  assert.throws(
    () => validateCatalogues(
      { 'zh-CN': { reviews: '{count} 条评价' }, 'ar-EG': { reviews: 'لا توجد | واحد | اثنان | {count} قليل | كثير | {count} آخر' } },
      ['zh-CN', 'ar-EG'],
    ),
    /Missing plural interpolation: ar-EG\/reviews/,
  );
});

test('untranslated English requires an exact reviewed value, including after source text changes', () => {
  const catalogues = { 'zh-CN': { label: '模式' }, 'en-US': { label: 'Mode' }, 'fr-FR': { label: 'Mode' } };
  assert.throws(() => validateCatalogues(catalogues, Object.keys(catalogues)), /Unreviewed English text/);
  const exceptions = { languages: { 'fr-FR': { label: { value: 'Mode', reason: 'Correct French spelling.' } } } };
  assert.equal(validateCatalogues(catalogues, Object.keys(catalogues), exceptions), 1);
  catalogues['en-US'].label = catalogues['fr-FR'].label = 'Changed untranslated sentence';
  assert.throws(() => validateCatalogues(catalogues, Object.keys(catalogues), exceptions), /Unreviewed English text/);
});

test('source scanner extracts <i18n-t>, v-t and static template literals while ignoring comments and URLs', t => {
  const vueSource = `<template>
  <!-- <i18n-t keypath="comment.html" /> {{ t('comment.mustache') }} -->
  <p>{{ t('plain.single') }} {{ $t("plain.double") }} {{ /* t('comment.inline') */ t(\`plain.template\`) }}</p>
  <i18n-t keypath="rich.static" tag="p" />
  <I18nT :keypath="'rich.bound'" />
  <span v-t="'directive.string'" />
  <span v-t="{ path: 'directive.object', args: { count: 1 } }" />
</template>
<script setup lang="ts">
// Example: t('comment.line')
/* Multi-line
   $t('comment.block') */
const api = 'https://stuhelper.example/api'; // t('comment.afterUrl')
const dynamic = (kind: string) => \`\${t(\`dynamic.\${kind}\`)} · \${t(\`script.staticTemplate\`)}\`;
</script>
`;
  assert.ok(!stripSourceComments(vueSource, true).includes('comment.'));
  assert.deepEqual(
    extractMessageKeys(vueSource, { isVue: true }),
    ['plain.single', 'plain.double', 'plain.template', 'script.staticTemplate', 'rich.static', 'rich.bound', 'directive.string', 'directive.object'],
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-i18n-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = { default: 'zh-CN', languages: { 'zh-CN': { name: '简体中文', direction: 'ltr' }, 'en-US': { name: 'English', direction: 'ltr' } } };
  fs.writeFileSync(path.join(root, 'locale-policy.yaml'), stringifyYaml(policy));
  fs.writeFileSync(path.join(root, 'locale-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'src/locales'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/locales/zh-CN.json'), JSON.stringify({ rich: { static: '正文' }, directive: { string: '标签' }, plain: { template: '模板' } }));
  fs.writeFileSync(path.join(root, 'src/locales/en-US.json'), JSON.stringify({ rich: { static: 'Body' }, directive: { string: 'Label' }, plain: { template: 'Template' } }));
  fs.writeFileSync(path.join(root, 'src/App.vue'), `<template><!-- t('ignored.comment') --><i18n-t keypath="rich.static" /><span v-t="'directive.string'" />{{ t(\`plain.template\`) }}</template>\n`);
  check(root);

  fs.writeFileSync(path.join(root, 'src/App.vue'), `<template><i18n-t keypath="rich.missing" /></template>\n`);
  assert.throws(() => check(root), /Unknown message key: src\/App\.vue -> rich\.missing/);
});
