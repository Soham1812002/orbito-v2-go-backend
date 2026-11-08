import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    trace: { type: 'string' },
    level: { type: 'string' },
    service: { type: 'string' },
    event: { type: 'string' },
  },
});
const root = path.resolve(process.env.LOG_HOST_DIR ?? './logs');
const services = ['backend', 'realtime', 'gateway', 'proxy', 'database', 'migrate', 'smoke'];

if (values.service && !services.includes(values.service)) {
  throw new Error('Unknown log service');
}

for (const service of values.service ? [values.service] : services) {
  const directory = path.join(root, service);
  const files = await readdir(directory, { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        return [];
      }

      throw err;
    },
  );

  for (const file of files) {
    if (!file.isFile() || !/^(current|archive-\d+)\.jsonl$/.test(file.name)) {
      continue;
    }

    const lines = createInterface({
      input: createReadStream(path.join(directory, file.name)),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      let record: Record<string, unknown>;

      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (values.trace && record.traceId !== values.trace) {
        continue;
      }

      if (values.level && record.level !== values.level) {
        continue;
      }

      if (values.event && record.event !== values.event) {
        continue;
      }

      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }
}
