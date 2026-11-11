import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { auditDurability, type DurableIdentity } from './audit.js';

const execute = promisify(execFile);

async function docker(args: string[]) {
  try {
    return (
      await execute('docker', args, {
        maxBuffer: 16 * 1024 * 1024,
        timeout: args[0] === 'build' ? 600000 : 60000,
      })
    ).stdout.trim();
  } catch (error) {
    const value = error as { stderr?: string };

    throw new Error(`Docker ${args[0]} failed: ${value.stderr?.slice(-1500) ?? 'command failed'}`, {
      cause: error,
    });
  }
}

export async function runDockerLoad(devices: number, rounds: number) {
  assert(Number.isInteger(devices) && devices >= 1 && devices <= 256, 'Devices must be 1..256');
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, 'Rounds must be 1..100');
  const id = `fleet-load-${randomBytes(5).toString('hex')}`;
  const directory = resolve('.tmp', 'gateway-load', id);

  await mkdir(directory, { recursive: true });
  const label = 'fleet.test=gateway-load';
  const network = `${id}-network`;
  const spool = `${id}-spool`;
  const database = `${id}-database`;
  const backend = `${id}-backend`;
  const realtime = `${id}-realtime`;
  const gateway = `${id}-gateway`;
  const worker = `${id}-worker`;
  const names = [worker, gateway, realtime, backend, database];
  const secret = randomBytes(32).toString('hex');
  const realtimeSecret = randomBytes(32).toString('hex');
  const dbPassword = randomBytes(24).toString('hex');
  const databaseUrl = `postgres://fleet:${dbPassword}@database:5432/fleet_load`;
  const images = {
    backend: 'fleet-load-backend:local',
    gateway: 'fleet-load-gateway:local',
    realtime: 'fleet-load-realtime:local',
  };
  const limits = {
    gateway: { cpus: '0.50', memory: '256m' },
    backend: { cpus: '0.50', memory: '384m' },
    database: { cpus: '0.50', memory: '384m' },
    realtime: { cpus: '0.25', memory: '128m' },
    worker: { cpus: '0.25', memory: '192m' },
  };

  console.log(`Isolated load test: ${directory}`);
  console.log(
    'Runtime budget: 2 CPU cores and 1344 MiB RAM total; no published ports; separate disposable database/spool.',
  );

  async function launch(
    name: string,
    role: keyof typeof limits,
    image: string,
    args: string[],
    command: string[] = [],
  ) {
    const limit = limits[role];

    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      label,
      '--network',
      network,
      '--network-alias',
      role,
      '--cpus',
      limit.cpus,
      '--memory',
      limit.memory,
      '--memory-swap',
      limit.memory,
      '--pids-limit',
      '128',
      '--ulimit',
      'nofile=2048:2048',
      '--log-opt',
      'max-size=2m',
      '--log-opt',
      'max-file=2',
      ...args,
      image,
      ...command,
    ]);
  }

  async function waitHealthy(name: string, probe: string[]) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await docker(['exec', name, ...probe]);

        return;
      } catch {
        await delay(500);
      }
    }

    throw new Error(`Container did not become ready: ${name}`);
  }

  const stats: { timestamp: string; values: string }[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  let sampling: Promise<void> | undefined;
  let auditFailure: Error | undefined;
  let failure: unknown;

  try {
    // Serialize builds; cap Go compiler parallelism in Dockerfiles independently of runtime quotas.
    for (const role of ['gateway', 'backend', 'realtime'] as const) {
      console.log(`Building ${role} test image`);
      await docker([
        'build',
        '-f',
        `services/${role}/Dockerfile`,
        ...(role === 'backend' ? ['--target', 'load-test'] : []),
        '-t',
        images[role],
        '.',
      ]);
    }

    await docker(['network', 'create', '--internal', '--label', label, network]);
    await docker(['volume', 'create', '--label', label, spool]);
    await launch(database, 'database', 'postgis/postgis:16-3.5', [
      '--shm-size',
      '64m',
      '-e',
      'POSTGRES_DB=fleet_load',
      '-e',
      'POSTGRES_USER=fleet',
      '-e',
      `POSTGRES_PASSWORD=${dbPassword}`,
    ]);
    await waitHealthy(database, [
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'fleet',
      '-d',
      'fleet_load',
    ]);
    const common = [
      '-e',
      'NODE_ENV=development',
      '-e',
      'FLEET_LOAD_TEST=isolated',
      '-e',
      'LOG_LEVEL=trace',
      '-e',
      'LOG_MAX_BYTES=2097152',
      '-e',
      'LOG_MAX_FILES=2',
      '-e',
      `DATABASE_URL=${databaseUrl}`,
      '-e',
      `GATEWAY_SECRET=${secret}`,
      '-e',
      `REALTIME_SECRET=${realtimeSecret}`,
      '-e',
      'PUBLIC_ORIGIN=http://backend:3000',
      '-e',
      'REALTIME_URL=http://realtime:3001',
    ];

    await docker([
      'run',
      '--rm',
      '--label',
      label,
      '--network',
      network,
      '--cpus',
      '0.5',
      '--memory',
      '256m',
      '--memory-swap',
      '256m',
      '--pids-limit',
      '128',
      ...common,
      images.backend,
      'node',
      'utils/scripts/migrate.js',
    ]);
    await launch(backend, 'backend', images.backend, [
      '--tmpfs',
      '/logs:uid=1000,gid=1000,size=16m',
      '-e',
      'SERVICE_NAME=backend',
      '-e',
      'NODE_OPTIONS=--max-old-space-size=256',
      ...common,
    ]);
    await waitHealthy(backend, [
      'node',
      '-e',
      "fetch('http://localhost:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ]);
    await launch(realtime, 'realtime', images.realtime, [
      '--tmpfs',
      '/logs:uid=1000,gid=1000,size=8m',
      '-e',
      'SERVICE_NAME=realtime',
      '-e',
      'API_URL=http://backend:3000',
      '-e',
      'NODE_OPTIONS=--max-old-space-size=64',
      ...common,
    ]);
    await waitHealthy(realtime, [
      'node',
      '-e',
      "fetch('http://localhost:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ]);
    await launch(gateway, 'gateway', images.gateway, [
      '--tmpfs',
      '/logs:uid=10001,gid=10001,size=16m',
      '-v',
      `${spool}:/spool`,
      '-e',
      'SERVICE_NAME=gateway',
      '-e',
      'GOMAXPROCS=1',
      '-e',
      'GOMEMLIMIT=160MiB',
      '-e',
      'SPOOL_MAX_BYTES=67108864',
      '-e',
      'MAX_CONNECTIONS=256',
      '-e',
      'API_URL=http://backend:3000',
      '-e',
      `GATEWAY_SECRET=${secret}`,
      '-e',
      'LOG_LEVEL=trace',
      '-e',
      'LOG_MAX_BYTES=2097152',
      '-e',
      'LOG_MAX_FILES=2',
    ]);
    await launch(
      worker,
      'worker',
      images.backend,
      [
        '--mount',
        `type=bind,source=${directory},target=/results`,
        '--user',
        typeof process.getuid === 'function'
          ? `${process.getuid()}:${process.getgid!()}`
          : '1000:1000',
        '-e',
        'FLEET_LOAD_TEST=isolated',
        '-e',
        `LOAD_DEVICES=${devices}`,
        '-e',
        `LOAD_ROUNDS=${rounds}`,
        '-e',
        `DATABASE_URL=${databaseUrl}`,
        '-e',
        'NODE_OPTIONS=--max-old-space-size=128',
        '--entrypoint',
        'node',
      ],
      ['utils/scripts/stress-gateway.js', '--worker'],
    );
    let handled = '';
    const workerOutput = spawn('docker', ['logs', '-f', worker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    workerOutput.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    workerOutput.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    sampler = setInterval(() => {
      if (sampling) {
        return;
      }

      sampling = docker([
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        gateway,
        backend,
        database,
        realtime,
        worker,
      ])
        .then((values) => {
          stats.push({ timestamp: new Date().toISOString(), values });
        })
        .catch(() => {})
        .finally(() => {
          sampling = undefined;
        });
    }, 5000);
    const deadline = Date.now() + 15 * 60000;

    while (Date.now() < deadline) {
      let control: { id: string; action: string } | undefined;

      try {
        control = JSON.parse(
          await readFile(resolve(directory, 'control.json'), 'utf8'),
        ) as typeof control;
      } catch {
        /* Not yet requested. */
      }

      if (control && control.id !== handled) {
        handled = control.id;
        let error: string | undefined;

        try {
          if (control.action === 'pause-backend') {
            await docker(['pause', backend]);
          } else if (control.action === 'restart-gateway') {
            await docker(['kill', '--signal=KILL', gateway]);
            await docker(['start', gateway]);
            await delay(1000);
          } else if (control.action === 'resume-backend') {
            await docker(['unpause', backend]);
          } else {
            throw new Error('Unknown fault request');
          }
        } catch (err) {
          error = err instanceof Error ? err.message : 'Fault failed';
        }

        await writeFile(
          resolve(directory, 'control-done.json'),
          JSON.stringify({ id: control.id, error }),
        );
      }

      const state = JSON.parse(
        await docker(['inspect', '--format', '{{json .State}}', worker]),
      ) as { Running: boolean; ExitCode: number };

      if (!state.Running) {
        assert.equal(state.ExitCode, 0, 'Load worker failed; see report and worker logs');
        break;
      }

      await delay(500);
    }

    workerOutput.kill();
    const result = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8')) as {
      passed: boolean;
    };

    assert.equal(result.passed, true, 'Load test did not pass');
    await writeFile(resolve(directory, 'limits.json'), JSON.stringify(limits, null, 2));
    console.log(`PASS: report saved to ${resolve(directory, 'report.json')}`);
  } catch (error) {
    failure = error;
  } finally {
    if (sampler) {
      clearInterval(sampler);
    }

    await sampling;
    try {
      await writeFile(resolve(directory, 'stats.json'), JSON.stringify(stats, null, 2));
    } catch (error) {
      auditFailure = new Error('Could not save load statistics', { cause: error });
    }

    const states: unknown[] = [];

    for (const name of names) {
      try {
        const entry = JSON.parse(await docker(['inspect', name])) as {
          Config: { Labels: Record<string, string> };
          State: unknown;
          Image: string;
          HostConfig: { NanoCpus: number; Memory: number };
        }[];

        if (entry[0]?.Config.Labels['fleet.test'] !== 'gateway-load') {
          continue;
        }

        states.push({
          name,
          image: entry[0].Image,
          state: entry[0].State,
          limits: {
            nanoCpus: entry[0].HostConfig.NanoCpus,
            memoryBytes: entry[0].HostConfig.Memory,
          },
        });
        try {
          await writeFile(
            resolve(directory, `${name.split('-').at(-1)}.log`),
            await docker(['logs', '--tail', '300', name]),
          );
        } catch (error) {
          auditFailure = new Error('Could not save container logs', { cause: error });
        }

        if (name === gateway) {
          try {
            await docker(['stop', '--time', '5', name]);
            await docker(['cp', `${name}:/spool`, resolve(directory, 'spool-snapshot')]);
            const data = await docker([
              'exec',
              backend,
              'node',
              'utils/scripts/stress-gateway.js',
              '--audit-db',
            ]);
            const audit = await auditDurability(directory, JSON.parse(data) as DurableIdentity[]);

            assert.equal(
              audit.confirmedMissing,
              0,
              'Durability audit found missing confirmed packets',
            );
            assert.equal(
              audit.conflictingEventIds,
              0,
              'Durability audit found conflicting identities',
            );
            console.log(
              `Durability audit: ${audit.confirmedAdmissions} confirmed admissions; ${audit.confirmedMissing} missing; ${audit.pendingSpoolEvents} pending.`,
            );
          } catch (error) {
            auditFailure = new Error('Durability audit failed; inspect the retained reports', {
              cause: error,
            });
          }
        }

        await docker(['rm', '-fv', name]);
      } catch {
        /* Continue cleaning other owned resources. */
      }
    }

    try {
      await writeFile(resolve(directory, 'containers.json'), JSON.stringify(states, null, 2));
    } catch (error) {
      auditFailure = new Error('Could not save container limits', { cause: error });
    }

    try {
      const value = JSON.parse(await docker(['volume', 'inspect', spool])) as {
        Labels: Record<string, string>;
      }[];

      if (value[0]?.Labels['fleet.test'] === 'gateway-load') {
        await docker(['volume', 'rm', spool]);
      }
    } catch {
      /* Not created or still in use. */
    }

    try {
      await docker(['network', 'rm', network]);
    } catch {
      /* Not created or still in use. */
    }
  }

  if (failure) {
    throw failure;
  }

  if (auditFailure) {
    throw auditFailure;
  }
}
