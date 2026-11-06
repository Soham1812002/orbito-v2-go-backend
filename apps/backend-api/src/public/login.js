document.querySelector('#login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    location.assign('/vehicles');
  } catch (e) {
    document.querySelector('#message').textContent = e.message;
  } finally {
    button.disabled = false;
  }
});
