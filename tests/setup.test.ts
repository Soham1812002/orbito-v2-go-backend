import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'dotenv';

const execute = promisify(execFile);

test('local setup creates private independent secrets and preserves existing settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-setup-'));
  // A setup command is a normal subprocess, not another node:test worker.
  // Inheriting this private runner variable can leave the child waiting on IPC.
  const childEnvironment = { ...process.env };

  delete childEnvironment.NODE_TEST_CONTEXT;
  const childOptions = { env: childEnvironment, timeout: 10000 };

  try {
    await mkdir(join(directory, 'utils', 'scripts'), { recursive: true });
    const script = join(directory, 'utils', 'scripts', 'setup-local.ts');

    await copyFile(new URL('../utils/scripts/setup-local.ts', import.meta.url), script);
    const first = await execute(process.execPath, [script], childOptions);
    const original = await readFile(join(directory, '.env'), 'utf8');
    const values = parse(original);

    assert.equal(values.PUBLIC_ORIGIN, 'http://localhost');
    const secrets = [
      values.GATEWAY_SECRET,
      values.REALTIME_SECRET,
      values.POSTGRES_PASSWORD,
      values.DEMO_PASSWORD,
    ];

    for (const secret of secrets) {
      assert.match(secret!, /^[a-f0-9]{64}$/);
      assert.equal(first.stdout.includes(secret!), false, 'Setup printed a secret');
    }

    assert.equal(new Set(secrets).size, 4);
    // Windows does not implement POSIX permission bits; enforce this on Unix hosts.
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, '.env'))).mode & 0o777, 0o600);
    }

    await execute(process.execPath, [script], childOptions);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
