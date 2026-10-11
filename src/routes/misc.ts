import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ApiError, bad, newId } from '../lib/util';
import { jsonBody, text } from '../lib/validate';

/* ---------- newsletter (double opt-in; sending goes through Beehiiv later) ---------- */
export const newsletter = new Hono<AppEnv>();

newsletter.post('/subscribe', async c => {
  const b = await jsonBody(c.req);
  const email = text(b, 'email', { max: 254, required: true })!.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('email_invalid', 'Enter a valid email address.');
  const token = newId() + newId();
  await c.env.DB.prepare(
    `INSERT INTO subscribers (email, token, created_at) VALUES (?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL, token = CASE WHEN confirmed = 1 THEN token ELSE excluded.token END`,
  ).bind(email, token, c.get('now')).run();
  // TODO(newsletter): send the confirmation email. Until then, dev returns the link so it can be tested.
  const dev = c.env.ENVIRONMENT === 'development';
  return c.json({ ok: true, message: 'Check your inbox to confirm.', ...(dev ? { confirm_token: token } : {}) });
});

newsletter.get('/confirm', async c => {
  const token = c.req.query('token') ?? '';
  const r = await c.env.DB.prepare('UPDATE subscribers SET confirmed = 1 WHERE token = ? AND unsubscribed_at IS NULL').bind(token).run();
  if (!r.meta.changes) throw new ApiError(404, 'token_invalid', 'This confirmation link is invalid or expired.');
  return c.json({ confirmed: true });
});

newsletter.get('/unsubscribe', async c => {
  const token = c.req.query('token') ?? '';
  const r = await c.env.DB.prepare('UPDATE subscribers SET unsubscribed_at = ? WHERE token = ?').bind(c.get('now'), token).run();
  if (!r.meta.changes) throw new ApiError(404, 'token_invalid', 'This unsubscribe link is invalid.');
  return c.json({ unsubscribed: true });
});

/* ---------- images served from R2 ---------- */
export const images = new Hono<AppEnv>();

images.get('/*', async c => {
  const key = c.req.path.replace(/^\/api\/v1\/images\//, '');
  if (!/^popups\/[\w]+\/[\w]+\.(webp|jpg|png)$/.test(key)) throw new ApiError(404, 'not_found', 'Image not found.');
  const obj = c.env.IMAGES ? await c.env.IMAGES.get(key) : null;
  if (!obj) throw new ApiError(404, 'not_found', 'Image not found.');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // Every upload gets a new key (newId), so a key's bytes never change: the browser can keep it for good
  // instead of asking the Worker and R2 again for each photo each time the list scrolls into view.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

/* ---------- public profiles ---------- */
export const users = new Hono<AppEnv>();

users.get('/:id', async c => {
  const u = await c.env.DB.prepare(
    "SELECT id, display_name, karma, verified_posts, created_at FROM users WHERE id = ? AND status IN ('active', 'shadowbanned')",
  ).bind(c.req.param('id')).first();
  if (!u) throw new ApiError(404, 'not_found', 'This user does not exist.');
  return c.json(u);
});
