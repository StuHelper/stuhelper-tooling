import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCatalogues } from './check-i18n.mjs';

test('catalogue key mismatches report explicit missing keys and extra keys sets', () => {
  const catalogues = {
    'zh-CN': { course: { title: '课程', teacher: '任课教师', credits: '学分' } },
    'en-US': { course: { title: 'Course', legacy: 'Legacy', obsolete: 'Obsolete' } },
  };
  assert.throws(
    () => validateCatalogues(catalogues, ['zh-CN', 'en-US']),
    /Missing or extra message in en-US \(missing keys: \[course\.credits, course\.teacher\]; extra keys: \[course\.legacy, course\.obsolete\]\)/,
  );
});
