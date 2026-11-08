import type { Identity } from '../application/actor.js';

declare global {
  namespace Express {
    interface Locals {
      user?: Identity;
      requestId?: string;
    }
  }
}

export {};
