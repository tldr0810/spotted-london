import { Hono } from 'hono';
import type { AppEnv, PopupRow } from '../types';
import { requireUser } from '../middleware';
import { ApiError, bad } from '../lib/util';
import { jsonBody, text } from '../lib/validate';
import { DAY, trust, voteWeight } from '../lib/scoring';
import { toPublic } from '../db/popups';
import { parseTaste } from '../shared/taste';
import { checkTasteBody, TASTE_MAX_BYTES } from '../shared/taste-sync';

export const me = new Hono<AppEnv>();

me.get('/', c => {
  const u = requireUser(c);
  return c.json({
    id: u.id, email: u.email, name: u.display_name, role: u.role, karma: u.karma,
    trust: trust({ karma: u.karma, verifiedPosts: u.verified_posts, badPosts: u.bad_posts }),
    vote_weight: voteWeight({ karma: u.karma, createdAt: u.created_at, emailVerified: !!u.email_verified, status: u.status }, c.get('now')),
    verified_posts: u.verified_posts, created_at: u.created_at,
  });
});

/** The name shown next to your posts. Emails are never shown publicly. */
me.patch('/', async c => {
  const u = requireUser(c);
  const b = await jsonBody(c.req);
  const name = text(b, 'display_name', { min: 2, max: 40, required: true })!;
  if (/@|https?:\/\//i.test(name)) throw bad('display_name_invalid', 'Names cannot contain emails or links.');
  await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, u.id).run();
  return c.json({ display_name: name });
});

/** Saved pop-ups and your votes, for the pop-ups a list can still show. The public list carries none of this. */
me.get('/state', async c => {
  const u = requireUser(c);
  const since = c.get('now') - 7 * DAY;
  const [saves, votes] = await Promise.all([
    c.env.DB.prepare('SELECT s.popup_id FROM saves s JOIN popups p ON p.id = s.popup_id WHERE s.user_id = ? AND p.end_at > ?')
      .bind(u.id, since).all<{ popup_id: string }>(),
    c.env.DB.prepare('SELECT v.popup_id, v.kind, v.value FROM votes v JOIN popups p ON p.id = v.popup_id WHERE v.user_id = ? AND p.end_at > ?')
      .bind(u.id, since).all<{ popup_id: string; kind: string; value: number }>(),
  ]);
  const byPopup: Record<string, { existence: number; quality: number }> = {};
  for (const v of votes.results) (byPopup[v.popup_id] ??= { existence: 0, quality: 0 })[v.kind as 'existence' | 'quality'] = v.value;
  return c.json({ saved: saves.results.map(r => r.popup_id), votes: byPopup });
});

me.get('/saves', async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = p.id ORDER BY position LIMIT 1) AS cover_key
     FROM saves s JOIN popups p ON p.id = s.popup_id WHERE s.user_id = ? ORDER BY p.start_at`,
  ).bind(u.id).all<PopupRow & { cover_key: string | null }>();
  return c.json({ items: results.map(p => toPublic(p)) });
});

me.get('/popups', async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare(
    `SELECT *, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key
     FROM popups WHERE created_by = ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(u.id).all<PopupRow & { cover_key: string | null }>();
  return c.json({ items: results.map(p => toPublic(p)) });
});

me.get('/karma', async c => {
  const u = requireUser(c);
  const { results } = await c.env.DB.prepare(
    'SELECT delta, reason, ref_id, created_at FROM karma_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
  ).bind(u.id).all();
  return c.json({ karma: u.karma, items: results });
});

/* ---------- taste ("For you"): the account copy, see CLAUDE.md "For you (taste)" ---------- */

/** The table comes with migration 0019. Until it is applied, say so instead of failing with a server error. */
const noTable = (e: unknown) => e instanceof Error && /no such table/i.test(e.message);
const tasteOff = () => new ApiError(503, 'taste_unavailable', 'Saving your picks to your account is not ready yet. They stay on this device.');

/** Your taste on the account, or `{ taste: null }` when none was saved yet. `updated_at` is the version to send back as `base`. */
me.get('/taste', async c => {
  const u = requireUser(c);
  let row: { data: string; updated_at: number } | null;
  try {
    row = await c.env.DB.prepare('SELECT data, updated_at FROM user_taste WHERE user_id = ?').bind(u.id).first<{ data: string; updated_at: number }>();
  } catch (e) { throw noTable(e) ? tasteOff() : e; }
  return c.json(row ? { taste: parseTaste(row.data), updated_at: row.updated_at } : { taste: null, updated_at: null });
});

/**
 * Saves your taste. Body: `{ taste, base }`. `base` is the `updated_at` you last saw (0 when you saw none). If the
 * account has moved on since, nothing is written and the answer is 409 with the current copy, so the browser can
 * apply the merge rules (src/shared/taste-sync.ts) and try again. The taste is cleaned with parseTaste and its
 * size is capped. Signed-out people never reach this: the taste stays on their device.
 */
me.put('/taste', async c => {
  const u = requireUser(c);
  const raw = await c.req.text();
  if (raw.length > TASTE_MAX_BYTES + 200) throw new ApiError(413, 'taste_too_large', 'That taste is too large to save.');
  let b: { taste?: unknown; base?: unknown };
  try { b = JSON.parse(raw) as typeof b; } catch { throw bad('invalid_json', 'The request body must be JSON.'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('invalid_json', 'The request body must be a JSON object.');
  if (typeof b.base !== 'number' || !Number.isFinite(b.base) || b.base < 0) throw bad('base_invalid', 'Send base: the updated_at you last saw, or 0.');
  const checked = checkTasteBody(b.taste);
  if (!checked.ok) throw checked.code === 'taste_too_large' ? new ApiError(413, checked.code, checked.message) : bad(checked.code, checked.message);

  const now = c.get('now');
  const db = c.env.DB;
  try {
    // One statement decides: it writes only if the row is still at `base` (or absent when base is 0).
    const wrote = await db.prepare(
      `INSERT INTO user_taste (user_id, data, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE user_taste.updated_at = ?4`,
    ).bind(u.id, checked.json, Math.max(now, b.base + 1), b.base).run();
    if (wrote.meta.changes === 0) {
      const cur = await db.prepare('SELECT data, updated_at FROM user_taste WHERE user_id = ?').bind(u.id).first<{ data: string; updated_at: number }>();
      throw new ApiError(409, 'taste_changed', 'Your picks changed on another device.', cur ? { current: { taste: parseTaste(cur.data), updated_at: cur.updated_at } } : { current: null });
    }
  } catch (e) { throw noTable(e) ? tasteOff() : e; }
  const row = await db.prepare('SELECT updated_at FROM user_taste WHERE user_id = ?').bind(u.id).first<{ updated_at: number }>();
  return c.json({ taste: checked.taste, updated_at: row!.updated_at });
});

/** GDPR delete: personal data goes, posts stay but are anonymised (SPEC §3.4). */
me.delete('/', async c => {
  const u = requireUser(c);
  if (u.role === 'admin') throw new ApiError(409, 'admin_account', 'Hand over admin access before deleting this account.');
  const db = c.env.DB;
  // Your picks go first, in their own statement: an account can still be deleted before migration 0019 is applied,
  // and if this fails nothing else has been deleted yet, so trying again is safe.
  try { await db.prepare('DELETE FROM user_taste WHERE user_id = ?').bind(u.id).run(); } catch (e) { if (!noTable(e)) throw e; }
  await db.batch([
    db.prepare("UPDATE users SET email = ?, display_name = NULL, avatar_key = NULL, status = 'deleted' WHERE id = ?").bind(`deleted-${u.id}@invalid`, u.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    db.prepare('DELETE FROM saves WHERE user_id = ?').bind(u.id),
    db.prepare('UPDATE checkins SET lat = NULL, lng = NULL WHERE user_id = ?').bind(u.id),
  ]);
  return c.json({ deleted: true });
});
