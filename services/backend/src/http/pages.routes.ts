import { Router } from 'express';

export function pageRoutes() {
  const r = Router();

  r.get('/', (_req, res) => res.redirect('/vehicles'));
  for (const page of ['vehicles', 'device-logs']) {
    r.get(`/${page}`, (_req, res) => {
      if (!res.locals.user) {
        res.redirect('/login');

        return;
      }

      res.render(page, { user: res.locals.user, page, csrfToken: res.locals.user.csrf_token });
    });
  }

  return r;
}
