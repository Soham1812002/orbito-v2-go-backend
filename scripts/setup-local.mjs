import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const secret = () => randomBytes(32).toString('hex');
const password = secret();
const content = `# Local Docker development only. Keep this file private.
NODE_ENV=development
PUBLIC_ORIGIN=http://localhost:8080
HTTP_PORT=8080
PORT=3000
REALTIME_PORT=3001
POSTGRES_PASSWORD=${password}
DATABASE_URL=postgres://fleet:${password}@localhost:5432/fleet
GATEWAY_SECRET=${secret()}
REALTIME_SECRET=${secret()}
API_URL=http://localhost:3000
REALTIME_URL=http://localhost:3001
ALLOW_UNVERIFIED_MARKON=false
TRUST_PROXY=false
SPOOL_DIR=./data/spool
SPOOL_MAX_BYTES=1073741824
DEMO_EMAIL=demo@fleet.local
DEMO_PASSWORD=${secret()}
`;

try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random local secrets. No existing settings were changed.');
  console.log('Docker will use http://localhost:8080. Demo credentials are in .env.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.log('.env already exists; left it unchanged. Check its values against .env.example.');
  } else {
    throw error;
  }
}
