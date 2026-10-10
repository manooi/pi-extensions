import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDeletion } from './deletion-guard.ts';
import extension from './index.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-deletion-test-'));
fs.mkdirSync(path.join(root, 'sub'));
fs.symlinkSync('/etc', path.join(root, 'system-link'));
const check = command => checkDeletion(command, root, command.split(/&&|;/).map(s => s.trim()).filter(Boolean));

for (const command of ['rm -rf .beads .agents', 'rm -fr sub', 'rm --recursive sub', 'rm -r -f -- sub', 'cd sub && rm -rf cache', `cd ${root} && rm -rf .beads`, 'rm -rf "space name"']) {
  test(`local: ${command}`, () => {
    const results = check(command);
    assert.ok(results.length);
    assert.ok(results.every(r => r.policy === 'ask' && !r.requireConfirmation));
  });
}
for (const command of ['rm -rf /', 'rm -rf /etc', 'rm -rf /usr/lib', `rm -rf ${os.homedir()}`, 'rm -rf .', 'rm -rf ..', 'rm -rf system-link', 'rm -rf /tmp']) {
  test(`protected: ${command}`, () => assert.ok(check(command).some(r => r.policy === 'deny')));
}
for (const command of ['rm -rf /tmp/some-other-project', 'rm -rf "$TARGET"', 'rm -rf *', 'rm -rf $(pwd)', 'sudo rm -rf sub', 'cd sub || rm -rf cache', 'ln -s /etc link; rm -rf link', 'rmdir -p sub', 'rm -rf sub &']) {
  test(`confirmation: ${command}`, () => assert.ok(check(command).some(r => r.requireConfirmation)));
}

test('sensitive bare target', () => {
  assert.ok(checkDeletion('rm -f .env', root, ['rm -f .env'], p => path.basename(p) === '.env').some(r => r.policy === 'deny'));
});

test('YOLO integration: local allowed, external prompts, system/sensitive denied', async () => {
  const events = new Map();
  const commands = new Map();
  extension({ on: (name, fn) => events.set(name, fn), registerCommand: (name, spec) => commands.set(name, spec) });
  let prompts = 0;
  const ctx = { cwd: root, hasUI: true, ui: { notify() {}, setStatus() {}, select: async (_title, options) => { prompts++; assert.deepEqual(options, ['Allow once', 'Deny once']); return 'Deny once'; } } };
  await commands.get('yolo').handler('on', ctx);
  const run = command => events.get('tool_call')({ toolName: 'bash', input: { command } }, ctx);
  assert.equal(await run('rm -rf .beads .agents'), undefined);
  assert.equal(prompts, 0);
  assert.equal((await run('rm -rf /etc')).block, true);
  assert.equal((await run('rm -f .env')).block, true);
  assert.equal((await run('rm -rf /tmp/unrelated')).block, true);
  assert.equal(prompts, 1);
  assert.equal((await run('rm -rf "$TARGET"')).block, true);
  assert.equal(prompts, 2);
  ctx.hasUI = false;
  assert.equal((await run('rm -rf /tmp/unrelated')).block, true);
  assert.equal(await events.get('user_bash')({ command: 'rm -rf .agents' }, ctx), undefined);
  assert.equal((await events.get('user_bash')({ command: 'rm -rf /' }, ctx)).result.exitCode, 1);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
