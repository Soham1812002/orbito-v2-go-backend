export async function internalPost(url: string, secret: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Internal request failed: ${response.status}`);
  }

  return (await response.json()) as unknown;
}
