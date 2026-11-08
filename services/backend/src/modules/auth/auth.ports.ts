import type { Identity } from '../../application/actor.js';

export interface AuthUser {
  id: string;
  password_hash: string;
}

export interface AuthRepository {
  activeSession(hash: string): Promise<Identity | undefined>;
  findUser(email: string): Promise<AuthUser | undefined>;
  createSession(hash: string, userId: string, csrf: string, hours: number): Promise<void>;
  deleteSession(hash: string): Promise<void>;
}
