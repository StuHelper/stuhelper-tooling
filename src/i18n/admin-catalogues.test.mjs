import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { check } from './check-i18n.mjs';

test('admin validates shared sources, custom namespaces, collisions and locale settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-locales-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const write = (file, data) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const policy = { default: 'zh-CN', default_time_zone: 'Asia/Shanghai', languages: { 'zh-CN': { direction: 'ltr' }, 'ar-EG': { direction: 'rtl' } } };
  const writePolicy = () => { write('locale-policy.yaml', policy); write('locale-policy.json', policy); };
  writePolicy();
  for (const lang of Object.keys(policy.languages)) {
    write('packages/locales/src/langs/' + lang + '/custom.json', { shared: { title: lang } });
    write('apps/web-antd/src/locales/langs/' + lang + '/custom.json', { app: { title: lang } });
  }
  write('packages/effects/request/src/view.ts', "import { $t } from '@vben/locales'; export const title = $t('custom.shared.title');");
  write('apps/web-antd/src/view.ts', "const meta = 'custom.app.title';");
  write('packages/shared/src/form.vue', "const { $t } = useSimpleLocale(); $t('reset')");
  write('packages/wired/src/form.vue', `import { $t } from '@vben/locales';
<template><div :value="custom.form.value" /></template>`);
  check(root);
  write('packages/effects/request/src/view.ts', "import { $t } from '@vben/locales'; export const title = $t('custom.shared.typo');");
  assert.throws(() => check(root), /custom.shared.typo/);
  write('packages/effects/request/src/view.ts', '');
  write('apps/web-antd/src/view.ts', "const meta = 'custom.app.missing';");
  assert.throws(() => check(root), /custom.app.missing/);
  write('apps/web-antd/src/view.ts', '');
  policy.languages['ar-EG'].direction = 'ltr'; writePolicy();
  assert.throws(() => check(root), /direction/);
  policy.languages['ar-EG'].direction = 'rtl'; policy.default_time_zone = 'Unknown/Zone'; writePolicy();
  assert.throws(() => check(root), /time.zone/i);
  policy.default_time_zone = 'Asia/Shanghai'; writePolicy();
  write('apps/web-antd/src/locales/langs/zh-CN/custom.json', { shared: { title: '冲突' } });
  assert.throws(() => check(root), /Duplicate|conflict/);
});
