export const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
export const role = document.querySelector('meta[name="user-role"]')?.content;
export function message(text) {
  document.querySelector('#message').textContent = text;
}
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) location.assign('/login');
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function utc(time) {
  return time
    ? new Date(time).toISOString().replace('T', ' ').replace(/Z$/, ' UTC')
    : 'Not provided';
}
document.querySelector('#logout')?.addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST', body: '{}' });
    location.assign('/login');
  } catch (e) {
    message(e.message);
  }
});
