import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { randomToken, tokenHash } from './auth.js';
import { HttpError } from '../http.js';
export function ticketRoutes(pool: pg.Pool) {
  const r = Router();
  r.post('/realtime-ticket', async (_req, res) => {
    const ticket = randomToken();
    await pool.query(
      "INSERT INTO realtime_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,now()+interval '30 seconds')",
      [tokenHash(ticket), res.locals.user.session_hash],
    );
    res.json({ ticket });
  });
  return r;
}
export function realtimeAuthRoutes(pool: pg.Pool) {
  const r = Router();
  r.post('/realtime-tickets/consume', async (req, res) => {
    const { ticket } = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
    const { rows } = await pool.query(
      `WITH consumed AS (DELETE FROM realtime_tickets WHERE token_hash=$1 AND expires_at>now() RETURNING session_hash) SELECT u.id,u.organization_id,u.role,s.token_hash AS session_hash FROM consumed t JOIN sessions s ON s.token_hash=t.session_hash JOIN users u ON u.id=s.user_id WHERE s.expires_at>now() AND u.enabled`,
      [tokenHash(ticket)],
    );
    if (!rows[0]) throw new HttpError(401, 'Expired or used ticket');
    res.json(rows[0]);
  });
  r.post('/subscriptions/authorize', async (req, res) => {
    const input = z.object({ sessionHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
    const { rows } = await pool.query(
      `SELECT u.id,u.organization_id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled`,
      [input.sessionHash],
    );
    if (!rows[0]) throw new HttpError(401, 'Session revoked');
    res.json(rows[0]);
  });
  return r;
}
