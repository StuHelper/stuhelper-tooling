import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSource, privateMaterialErrors } from './repository.mjs';

test('runtime materials are rejected case-insensitively, examples remain valid', () => {
  for (const file of ['.ENV', '.env.production', 'STAGING.ENV', 'key.PEM', 'db.DUMP']) assert(privateMaterialErrors(file).length);
  for (const file of ['.env.example', 'production.env.example', 'candidate.yaml']) assert.deepEqual(privateMaterialErrors(file), []);
});
test('invalid YAML, duplicate keys and malformed JSON fail', () => {
  assert(checkSource('config.yaml', 'version: 1\nversion: 2\n').length);
  assert(checkSource('config.json', '{no}').length);
  assert.deepEqual(checkSource('config.yaml', 'version: 1\n'), []);
});
test('only direct script entry points carry shebang and execute permission together', () => {
  assert(checkSource('check.mjs', '#!/usr/bin/env node\n', false).length);
  assert(checkSource('check.mjs', 'export {}\n', true).length);
  assert.deepEqual(checkSource('check.mjs', '#!/usr/bin/env node\n', true), []);
  assert.deepEqual(checkSource('check.mjs', 'export {}\n', false), []);
});
