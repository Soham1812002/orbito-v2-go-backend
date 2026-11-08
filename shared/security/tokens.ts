import { createHash, randomBytes } from 'node:crypto';

export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

export const randomToken = () => randomBytes(32).toString('hex');
