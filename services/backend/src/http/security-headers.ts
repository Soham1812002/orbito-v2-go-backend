import type { RequestHandler } from 'express';

export function securityHeaders(production: boolean): RequestHandler {
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    if (production) {
      res.set('Strict-Transport-Security', 'max-age=31536000');
    }

    next();
  };
}
