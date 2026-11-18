import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { check } from './check-i18n.mjs';

test('check() validates both standalone web and monorepo admin directory layouts', t => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-i18n-web-'));
  const adminRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-i18n-admin-'));
  t.after(() => {
    fs.rmSync(webRoot, { recursive: true, force: true });
    fs.rmSync(adminRoot, { recursive: true, force: true });
  });

  const policy = {
    default: 'zh-CN',
    default_time_zone: 'Asia/Shanghai',
    languages: {
      'zh-CN': { name: '简体中文', direction: 'ltr' },
      'en-US': { name: 'English', direction: 'ltr' },
      'ar-EG': { name: 'العربية', direction: 'rtl' },
    },
    same_text_exceptions: {
      web: { shared: { 'brand.name': { value: 'StuHelper', reason: 'Brand name.' } } },
      admin: { shared: { 'common.brand': { value: 'StuHelper', reason: 'Brand name.' } } },
    },
  };

  fs.writeFileSync(path.join(webRoot, 'locale-policy.yaml'), stringifyYaml(policy));
  fs.writeFileSync(path.join(webRoot, 'locale-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  fs.mkdirSync(path.join(webRoot, 'src/locales'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'src/locales/zh-CN.json'), JSON.stringify({ brand: { name: 'StuHelper' }, course: { title: '课程列表' } }));
  fs.writeFileSync(path.join(webRoot, 'src/locales/en-US.json'), JSON.stringify({ brand: { name: 'StuHelper' }, course: { title: 'Courses' } }));
  fs.writeFileSync(path.join(webRoot, 'src/locales/ar-EG.json'), JSON.stringify({ brand: { name: 'StuHelper' }, course: { title: 'المقررات' } }));
  fs.writeFileSync(path.join(webRoot, 'src/View.vue'), `<template><h1>{{ t('course.title') }}</h1></template>\n`);
  fs.writeFileSync(path.join(webRoot, 'src/View.test.ts'), `t('ignored.in.test');\n`);
  fs.writeFileSync(path.join(webRoot, 'src/api.gen.ts'), `t('ignored.in.generated');\n`);
  check(webRoot);

  fs.writeFileSync(path.join(adminRoot, 'locale-policy.yaml'), stringifyYaml(policy));
  fs.writeFileSync(path.join(adminRoot, 'locale-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  for (const [locale, pageTitle] of [['zh-CN', '审核台'], ['en-US', 'Moderation'], ['ar-EG', 'الإشراف']]) {
    const sharedDir = path.join(adminRoot, 'packages/locales/src/langs', locale);
    const appDir = path.join(adminRoot, 'apps/web-antd/src/locales/langs', locale);
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'common.json'), JSON.stringify({ brand: 'StuHelper' }));
    fs.writeFileSync(path.join(appDir, 'page.json'), JSON.stringify({ moderation: { title: pageTitle } }));
  }
  fs.mkdirSync(path.join(adminRoot, 'apps/web-antd/src/router'), { recursive: true });
  fs.writeFileSync(path.join(adminRoot, 'apps/web-antd/src/router/routes.ts'), `export const route = { meta: { title: 'page.moderation.title' }, label: $t('common.brand') };\n`);
  check(adminRoot);

  fs.writeFileSync(path.join(adminRoot, 'apps/web-antd/src/router/routes.ts'), `export const route = { meta: { title: 'page.moderation.missing' } };\n`);
  assert.throws(() => check(adminRoot), /Unknown message key.*page\.moderation\.missing/);

  fs.writeFileSync(path.join(webRoot, 'locale-policy.json'), '{"default":"en-US"}\n');
  assert.throws(() => check(webRoot), /locale-policy\.json differs/);
});
