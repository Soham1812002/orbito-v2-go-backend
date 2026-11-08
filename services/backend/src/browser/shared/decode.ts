export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid server response');
  }

  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid server response');
  }

  return value;
}

export function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}

export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid server response');
  }

  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Invalid server response');
  }

  return value;
}

export function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid server response');
  }

  return value.map(parse);
}
