export async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers);

  headers.set('content-type', 'application/json');
  headers.set(
    'x-csrf-token',
    document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '',
  );
  const response = await fetch(path, { ...options, headers });
  const data: unknown = await response.json();

  if (!response.ok) {
    if (response.status === 401) {
      location.assign('/login');
    }

    throw new Error(
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : 'Request failed',
    );
  }

  return data;
}
