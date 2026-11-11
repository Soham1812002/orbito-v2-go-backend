import { dumpTestDatabase } from '../stress/audit.js';
import { runDockerLoad } from '../stress/docker.js';
import { runWorkload } from '../stress/workload.js';

try {
  if (process.argv.includes('--audit-db')) {
    await dumpTestDatabase();
  } else if (process.argv.includes('--worker')) {
    await runWorkload();
  } else {
    await runDockerLoad(
      Number(process.env.LOAD_DEVICES ?? 50),
      Number(process.env.LOAD_ROUNDS ?? 3),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Gateway stress test failed');
  process.exitCode = 1;
}
