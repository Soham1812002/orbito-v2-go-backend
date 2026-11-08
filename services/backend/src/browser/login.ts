import { query } from './shared/dom.js';
import { errorText } from './shared/messages.js';

query<HTMLFormElement>('#login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = query<HTMLFormElement>('#login');
  const button = query<HTMLButtonElement>('button', form);

  button.disabled = true;
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error);
    }

    location.assign('/vehicles');
  } catch (e) {
    query('#message').textContent = errorText(e);
  } finally {
    button.disabled = false;
  }
});
