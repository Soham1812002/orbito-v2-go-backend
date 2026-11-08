import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { AuthRepository } from './auth.ports.js';

export function createAuthService(deps: {
  repository: AuthRepository;
  verifyPassword: (password: string, stored: string) => Promise<boolean>;
  newToken: () => string;
  tokenHash: (token: string) => string;
  sessionHours: number;
}) {
  return {
    async login(input: { email: string; password: string }) {
      const user = await deps.repository.findUser(input.email);
      const valid = await deps.verifyPassword(
        input.password,
        user?.password_hash ??
          `scrypt-32768-8-3$00000000000000000000000000000000$${'00'.repeat(64)}`,
      );

      if (!user || !valid) {
        throw new ApplicationError('unauthorized', 'Invalid email or password');
      }

      const token = deps.newToken();
      const csrf = deps.newToken();

      await deps.repository.createSession(deps.tokenHash(token), user.id, csrf, deps.sessionHours);

      return { token };
    },
    lookupSession(token: string) {
      return deps.repository.activeSession(deps.tokenHash(token));
    },
    logout(hash: string) {
      return deps.repository.deleteSession(hash);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
