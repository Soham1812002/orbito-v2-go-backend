import { api } from './http.js';
import { message, errorText } from './messages.js';

export const role = document.querySelector<HTMLMetaElement>('meta[name="user-role"]')?.content;

export function initializeSession() {
  document.querySelector('#logout')?.addEventListener('click', async () => {
    try {
      await api('/logout', { method: 'POST', body: '{}' });
      location.assign('/login');
    } catch (error) {
      message(errorText(error));
    }
  });
}
