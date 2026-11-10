import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildSshAuthorizeCommand } from '../src/lib/ssh';

test('SSH authorize command installs only the public key for the chosen user', () => {
  const command = buildSshAuthorizeCommand('ubuntu', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest dsh-wireguard@host');
  assert.match(command, /u='ubuntu'/);
  assert.match(command, /grep -qxF/);
  assert.match(command, /ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest/);
  assert.match(command, /authorized_keys/);
  assert.doesNotMatch(command, /PRIVATE KEY/);
  assert.doesNotMatch(command, /dsh-wireguard@host/);

  const syntax = spawnSync('sh', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('rejects a malformed SSH public key', () => {
  assert.throws(() => buildSshAuthorizeCommand('root', 'not-a-key'), /public key/);
});
