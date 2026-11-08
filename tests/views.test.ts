import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

test('formatted templates preserve dynamic titles, escaped session data and role controls', async () => {
  for (const role of ['admin', 'operator', 'viewer']) {
    for (const page of ['vehicles', 'device-logs']) {
      const email = '<script>alert("unsafe")</script>';
      const html = await ejs.renderFile(
        fileURLToPath(new URL(`../services/backend/src/views/${page}.ejs`, import.meta.url)),
        { user: { role, email }, page, csrfToken: 'test-csrf' },
      );

      assert.match(
        html,
        page === 'vehicles'
          ? /<title>Vehicles · Fleet<\/title>/
          : /<title>Device logs · Fleet<\/title>/,
      );
      assert.equal(html.includes(email), false, 'User text must not become HTML');
      assert.match(html, /&lt;script&gt;/);
      assert.doesNotMatch(
        html,
        /<%|<![=-](?!-)/,
        'EJS syntax must render rather than leak into HTML',
      );

      if (page === 'vehicles') {
        assert.equal(html.includes('id="add-vehicle"'), role !== 'viewer');
      }
    }
  }
});
