import { query } from './dom.js';

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

export function message(text: string) {
  query('#message').textContent = text;
}
