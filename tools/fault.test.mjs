import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertBackend, composeArgs, root } from './docker.mjs';
import { parseFaultArgs } from './fault.mjs';

test('fault CLI accepts only the two backend services and known local projects', () => {
  assert.equal(parseFaultArgs(['crash', 'backend-a']).project, 'resilientcloud');
  for (const args of [['exec','backend-a'], ['crash','gateway'], ['unhealthy','other'],
    ['crash','backend-a','--project','foreign'], ['crash','backend-a','extra']]) {
    assert.throws(() => parseFaultArgs(args));
  }
});

test('target checks reject foreign labels, wrong directory, role, service and malformed IDs', () => {
  const valid = { Id: 'a'.repeat(64), Config: { Labels: {
    'com.docker.compose.project': 'resilientcloud',
    'com.docker.compose.service': 'backend-a',
    'com.docker.compose.project.working_dir': root,
    'io.resilientcloud.role': 'backend',
  } } };
  assert.equal(assertBackend(valid, 'resilientcloud', 'backend-a'), valid);
  for (const key of Object.keys(valid.Config.Labels)) {
    const copy = structuredClone(valid);
    copy.Config.Labels[key] = 'foreign';
    assert.throws(() => assertBackend(copy, 'resilientcloud', 'backend-a'));
  }
  assert.throws(() => assertBackend({ ...valid, Id: 'backend-a' }, 'resilientcloud', 'backend-a'));
  assert.throws(() => assertBackend(valid, 'resilientcloud', 'gateway'));
  assert.throws(() => composeArgs('foreign', 'two', ['up']));
});

test('Compose wrapper refuses attached and separate project/file overrides', () => {
  for (const args of [['-pforeign'], ['-p', 'foreign'], ['--project-name=foreign'],
    ['-f/foreign.yaml'], ['--file=/foreign.yaml'], ['--project-directory=/foreign']]) {
    const result = spawnSync(process.execPath, ['tools/compose.mjs', 'one', ...args, 'config'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /overrides are disabled/);
  }
});
