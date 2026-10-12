import { Hono } from 'hono';
import type { AppEnv, PopupRow, UserRow } from '../types';
import { ipHash, requireUser, verifyTurnstile, withinPublicLimit } from '../middleware';
import { ApiError, bad, newId, slugify, titleSimilarity } from '../lib/util';
import { jsonBody, num, oneOf, text } from '../lib/validate';
import { CATEGORIES, safeUrl } from '../lib/extract';
import { boxAround, CHECKIN_RADIUS_M, geohash, haversine, inLondon } from '../lib/geo';
import { DAY, hot, initialStatus, KARMA, PUBLIC_STATUSES, voteWeight } from '../lib/scoring';
import { MAX_DURATION, windowFor, type When } from '../lib/time';
import { recompute, SOURCE_CHECKED_SQL, toPublic } from '../db/popups';
import { tagFilter } from '../shared/tags';
import { buildPopupSnapshot, entersOrLeavesPublic, readSnapshot, rebuildSnapshotSoon } from '../db/snapshot';
import { awardKarma } from '../db/karma';
import { addPhotoFromUrl, resolveImageUrl, sniffPhoto } from '../lib/photo';
import { audit } from './admin';

export const popups = new Hono<AppEnv>();

const voter = (u: UserRow) => ({ karma: u.karma, createdAt: u.created_at, emailVerified: !!u.email_verified, status: u.status });

async function load(db: D1Database, idOrSlug: string): Promise<PopupRow> {
  const p = await db.prepare('SELECT * FROM popups WHERE id = ?1 OR slug = ?1').bind(idOrSlug).first<PopupRow>();
  if (!p) throw new ApiError(404, 'not_found', 'This pop-up does not exist.');
  return p;
}

function canSee(p: PopupRow, u: UserRow | null): boolean {
  if (PUBLIC_STATUSES.includes(p.status) || p.status === 'ended') return true;
  if (!u) return false;
  return u.role === 'admin' || (p.created_by === u.id && p.status !== 'removed');
}

/* ---------- GET /popups ---------- */
// The app reads the snapshot instead; this one is for scripts and AI assistants that browse (see /llms.txt), so it is limited per visitor.
popups.get('/', async c => {
  if (!(await withinPublicLimit(c, 'list'))) throw new ApiError(429, 'rate_limited', 'Too many requests. Wait a minute and try again, or read /api/v1/popups/snapshot once and filter it yourself.');
  return c.json(await listPopups(c.env.DB, c.req.query(), c.get('now')));
});

/** The public list with its filters. Same for everyone: your own votes and saves come from GET /me/state. Also used by the MCP search tool. */
export async function listPopups(db: D1Database, q: Record<string, string>, now: number) {
  const when = (['today', 'weekend', 'week', 'all'].includes(q.when) ? q.when : 'week') as When;
  const { from, to } = windowFor(when, now);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  const offset = q.cursor ? parseInt(q.cursor, 36) || 0 : 0;

  const where: string[] = ['end_at > ?', 'start_at < ?'];
  const args: unknown[] = [from, to];
  const statuses = q.verified === '1' ? ['verified_community', 'verified_admin'] : PUBLIC_STATUSES;
  where.push(`status IN (${statuses.map(() => '?').join(',')})`);
  args.push(...statuses);

  if (q.category) {
    const cats = q.category.split(',').filter(x => (CATEGORIES as readonly string[]).includes(x));
    if (!cats.length) throw bad('category_invalid', `Category must be one of: ${CATEGORIES.join(', ')}.`);
    where.push(`category IN (${cats.map(() => '?').join(',')})`);
    args.push(...cats);
  }
  const want = tagFilter(q.tag), avoid = tagFilter(q.avoid);
  if ('error' in want) throw bad('tag_invalid', want.error);
  if ('error' in avoid) throw bad('tag_invalid', avoid.error);
  // instr, not LIKE: "_" in a tag name is a wildcard in LIKE. Untagged (NULL) fails `tag` and passes `avoid`.
  for (const t of want.tags) { where.push('instr(COALESCE(tags, \'\'), ?) > 0'); args.push(`,${t},`); }
  for (const t of avoid.tags) { where.push('instr(COALESCE(tags, \'\'), ?) = 0'); args.push(`,${t},`); }
  if (q.borough) { where.push('borough = ? COLLATE NOCASE'); args.push(q.borough); }
  if (q.free === '1') { where.push("price_type = 'free'"); }
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, m => '\\' + m).slice(0, 80)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR host LIKE ? ESCAPE '\\' OR borough LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }

  let near: { lat: number; lng: number; radius: number } | null = null;
  if (q.near) {
    const [lat, lng] = q.near.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('near_invalid', 'near must be "lat,lng".');
    const radius = Math.min(20_000, Math.max(100, (Number(q.radius_km) || 2) * 1000));
    near = { lat, lng, radius };
    const b = boxAround(lat, lng, radius);
    where.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
    args.push(b.south, b.north, b.west, b.east);
  } else if (q.bbox) {
    const [w, s, e, n] = q.bbox.split(',').map(Number);
    if (![w, s, e, n].every(Number.isFinite)) throw bad('bbox_invalid', 'bbox must be "west,south,east,north".');
    where.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
    args.push(s, n, w, e);
  }

  const sql = `SELECT *, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key,
      ${SOURCE_CHECKED_SQL}
    FROM popups WHERE ${where.join(' AND ')} ORDER BY hot DESC, id LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(sql).bind(...args, near ? 500 : limit + 1, near ? 0 : offset).all<PopupRow & { source_checked: number }>();

  let rows = results.map(p => ({ p, d: near ? haversine(near.lat, near.lng, p.lat, p.lng) : null }));
  if (near) {
    rows = rows.filter(r => (r.d ?? 0) <= near!.radius);
    if (q.sort === 'distance') rows.sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
    rows = rows.slice(offset, offset + limit + 1);
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map(r => toPublic(r.p, r.d !== null ? { distance_m: Math.round(r.d) } : {})),
    next_cursor: more ? (offset + limit).toString(36) : null,
    window: { when, from, to: to === Number.MAX_SAFE_INTEGER ? null : to },
  };
}

/* ---------- GET /popups/snapshot ---------- */
// The whole public list as one stored string, forwarded as it is (the Worker has about 10 ms of CPU, so no
// JSON.parse). The browser filters it. Registered before /:id so "snapshot" is not read as a pop-up id.
popups.get('/snapshot', async c => {
  const row = await readSnapshot(c.env.DB);
  // Nothing stored yet (first deploy) or it was too big to store: build one now and send that.
  const { version, json } = row ?? await buildPopupSnapshot(c.env.DB, c.get('now'));
  const etag = `"${version}"`;
  const sent = (c.req.header('if-none-match') ?? '').split(',').map(t => t.trim().replace(/^W\//, ''));
  const headers = { etag, 'cache-control': 'public, max-age=60' };
  if (sent.includes(etag) || sent.includes('*')) return c.body(null, 304, headers);
  return c.body(json, 200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
});

/* ---------- GET /popups/:idOrSlug ---------- */
popups.get('/:id', async c => {
  const p = await load(c.env.DB, c.req.param('id'));
  const u = c.get('user');
  if (!canSee(p, u)) throw new ApiError(404, 'not_found', 'This pop-up does not exist.');
  const db = c.env.DB;
  const [{ results: images }, mine, saved, poster, checked] = await Promise.all([
    db.prepare('SELECT id, r2_key, position, source_url, credit FROM popup_images WHERE popup_id = ? ORDER BY position').bind(p.id).all<{ id: string; r2_key: string; position: number; source_url: string | null; credit: string | null }>(),
    u ? db.prepare('SELECT kind, value FROM votes WHERE popup_id = ? AND user_id = ?').bind(p.id, u.id).all<{ kind: string; value: number }>() : null,
    u ? db.prepare('SELECT 1 AS s FROM saves WHERE popup_id = ? AND user_id = ?').bind(p.id, u.id).first() : null,
    db.prepare('SELECT id, display_name, karma FROM users WHERE id = ?').bind(p.created_by).first<{ id: string; display_name: string | null; karma: number }>(),
    db.prepare(`SELECT ${SOURCE_CHECKED_SQL} FROM popups WHERE id = ?`).bind(p.id).first<{ source_checked: number }>(),
  ]);
  return c.json(toPublic({ ...p, source_checked: checked?.source_checked }, {
    cover_url: images[0] ? `/api/v1/images/${images[0].r2_key}` : null,
    images: images.map(i => ({ id: i.id, url: `/api/v1/images/${i.r2_key}`, credit: i.credit, credit_url: i.source_url })),
    posted_by: poster ? { id: poster.id, name: poster.display_name, karma: poster.karma } : null,
    me: u ? {
      existence_vote: mine?.results.find(v => v.kind === 'existence')?.value ?? 0,
      quality_vote: mine?.results.find(v => v.kind === 'quality')?.value ?? 0,
      saved: !!saved,
      vote_weight: voteWeight(voter(u), c.get('now')),
    } : null,
  }));
});

/* ---------- POST /popups ---------- */
popups.post('/', async c => {
  const u = requireUser(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  await verifyTurnstile(c, typeof b.turnstile_token === 'string' ? b.turnstile_token : undefined);

  const input = parsePopupInput(b, now, true);
  const db = c.env.DB;

  if (u.role !== 'admin') {
    const cap = now - u.created_at < 7 * DAY ? 3 : 10;
    const n = await db.prepare('SELECT COUNT(*) AS n FROM popups WHERE created_by = ? AND created_at > ?').bind(u.id, now - DAY).first<{ n: number }>();
    if ((n?.n ?? 0) >= cap) throw new ApiError(429, 'daily_limit', `You can add ${cap} pop-ups a day. Try again tomorrow.`);
  }

  // Duplicate check: same few hundred metres, overlapping dates, similar title (SPEC §3.2).
  if (b.force !== true) {
    const dupes = await findDuplicates(db, input as DupeInput);
    if (dupes.length) {
      throw new ApiError(409, 'possible_duplicate', 'This looks like a pop-up that is already listed. Vote on it instead, or send again with "force": true.', {
        candidates: dupes.map(p => ({ id: p.id, slug: p.slug, title: p.title, start_at: p.start_at, end_at: p.end_at })),
      });
    }
  }

  const status = initialStatus({ role: u.role, karma: u.karma, verifiedPosts: u.verified_posts, badPosts: u.bad_posts }, !!input.source_url);
  const id = newId();
  const row = {
    id, slug: slugify(input.title!), ...input, geohash: geohash(input.lat!, input.lng!), status,
    created_by: u.id, quality_pos: 1, quality_neg: 0, created_at: now, updated_at: now,
    hot: hot({ status, qualityPos: 1, qualityNeg: 0, startAt: input.start_at!, endAt: input.end_at! }, now),
    final_verdict: status === 'verified_admin' ? 'real' : null,
  };
  const cols = Object.keys(row);
  await db.batch([
    db.prepare(`INSERT INTO popups (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(k => (row as Record<string, unknown>)[k] ?? null)),
    // the poster's own upvote
    db.prepare("INSERT INTO votes (user_id, popup_id, kind, value, weight, created_at) VALUES (?, ?, 'quality', 1, 1, ?)").bind(u.id, id, now),
  ]);
  const created = await load(db, id);
  if (PUBLIC_STATUSES.includes(status)) rebuildSnapshotSoon(c);
  return c.json(toPublic(created), 201);
});

type DupeInput = { title: string; lat: number; lng: number; start_at: number; end_at: number };

/**
 * Same few hundred metres, overlapping dates, similar title (SPEC §3.2). A removed post does not count, so a person can
 * add something again. Agents pass `removedSince` to also see what was turned down since then, so the Scout does not send
 * a post the admin already rejected (on 5 Oct 2026 it sent a rejected one again from a new link).
 */
export async function findDuplicates(db: D1Database, x: DupeInput, opts: { removedSince?: number } = {}): Promise<PopupRow[]> {
  const box = boxAround(x.lat, x.lng, 300);
  const { results } = await db.prepare(
    `SELECT * FROM popups WHERE lat BETWEEN ?1 AND ?2 AND lng BETWEEN ?3 AND ?4 AND start_at < ?5 AND end_at > ?6
       AND (status != 'removed' OR updated_at >= ?7) LIMIT 50`,
  ).bind(box.south, box.north, box.west, box.east, x.end_at, x.start_at, opts.removedSince ?? Number.MAX_SAFE_INTEGER).all<PopupRow>();
  return results.filter(p => titleSimilarity(p.title, x.title) >= 0.8);
}

/* ---------- PATCH /popups/:id ---------- */
popups.patch('/:id', async c => {
  const u = requireUser(c);
  const now = c.get('now');
  const p = await load(c.env.DB, c.req.param('id'));
  const isAdmin = u.role === 'admin';
  if (!isAdmin && (p.created_by !== u.id || !['pending', 'community'].includes(p.status))) {
    throw new ApiError(403, 'not_editable', 'Only the poster can edit this, and only before it is verified.');
  }
  const b = await jsonBody(c.req);
  const input = parsePopupInput({ ...fromRow(p), ...b }, now, false);
  const moved = input.lat !== p.lat || input.lng !== p.lng || input.start_at !== p.start_at || input.end_at !== p.end_at;
  const set = { ...input, geohash: geohash(input.lat!, input.lng!), updated_at: now };
  const cols = Object.keys(set);
  const stmts = [
    c.env.DB.prepare(`UPDATE popups SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map(k => (set as Record<string, unknown>)[k] ?? null), p.id),
  ];
  // Changing where or when a pop-up is invalidates what people confirmed (SPEC §3.2).
  if (moved) stmts.push(c.env.DB.prepare("DELETE FROM votes WHERE popup_id = ? AND kind = 'existence'").bind(p.id));
  await c.env.DB.batch(stmts);
  const change = await recompute(c.env.DB, p.id, now);
  if (PUBLIC_STATUSES.includes(p.status) || entersOrLeavesPublic(change)) rebuildSnapshotSoon(c); // a public pop-up changed
  return c.json(toPublic(await load(c.env.DB, p.id), { votes_reset: moved }));
});

/* ---------- PUT /popups/:id/vote ---------- */
popups.put('/:id/vote', async c => {
  const u = requireUser(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const kind = oneOf(b, 'kind', ['existence', 'quality'] as const, { required: true })!;
  const value = num(b, 'value', { required: true, min: -1, max: 1 })!;
  if (![1, 0, -1].includes(value)) throw bad('value_invalid', 'Value must be 1, 0 or -1.');

  const db = c.env.DB;
  const p = await load(db, c.req.param('id'));
  if (![...PUBLIC_STATUSES, 'hidden'].includes(p.status)) throw new ApiError(409, 'voting_closed', 'Voting is closed on this pop-up.');
  if (p.created_by === u.id) throw new ApiError(403, 'own_post', 'You cannot vote on your own pop-up.');

  if (value === 0) {
    await db.prepare('DELETE FROM votes WHERE user_id = ? AND popup_id = ? AND kind = ?').bind(u.id, p.id, kind).run();
  } else {
    let weight = 1;
    if (kind === 'existence') {
      const ci = await db.prepare('SELECT valid, photo_key FROM checkins WHERE user_id = ? AND popup_id = ?').bind(u.id, p.id).first<{ valid: number; photo_key: string | null }>();
      // A check-in only strengthens a "real" vote.
      weight = voteWeight(voter(u), now, value === 1 && ci?.valid ? { checkedIn: true, photo: !!ci.photo_key } : {});
    }
    await db.prepare(
      `INSERT INTO votes (user_id, popup_id, kind, value, weight, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, popup_id, kind) DO UPDATE SET value = excluded.value, weight = excluded.weight,
         ip_hash = excluded.ip_hash, created_at = excluded.created_at, settled = 0`,
    ).bind(u.id, p.id, kind, value, weight, await ipHash(c), now).run();
  }
  const change = await recompute(db, p.id, now);
  if (entersOrLeavesPublic(change)) rebuildSnapshotSoon(c);
  return c.json({ popup: toPublic(await load(db, p.id)), status_change: change });
});

/* ---------- POST /popups/:id/checkin ---------- */
popups.post('/:id/checkin', async c => {
  const u = requireUser(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const lat = num(b, 'lat', { required: true, min: -90, max: 90 })!;
  const lng = num(b, 'lng', { required: true, min: -180, max: 180 })!;
  const db = c.env.DB;
  const p = await load(db, c.req.param('id'));
  if (!PUBLIC_STATUSES.includes(p.status)) throw new ApiError(409, 'checkin_closed', 'Check-ins are closed on this pop-up.');
  if (p.start_at > now || p.end_at < now) throw new ApiError(409, 'not_live', 'You can check in only while the pop-up is open.');
  if (p.created_by === u.id) throw new ApiError(403, 'own_post', 'You cannot check in to your own pop-up.');

  const distance = haversine(lat, lng, p.lat, p.lng);
  const valid = distance <= CHECKIN_RADIUS_M ? 1 : 0;
  const ins = await db.prepare(
    'INSERT OR IGNORE INTO checkins (user_id, popup_id, lat, lng, distance_m, valid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(u.id, p.id, lat, lng, Math.round(distance), valid, now).run();
  if (!ins.meta.changes) throw new ApiError(409, 'already_checked_in', 'You already checked in here.');

  let karma = 0;
  if (valid) {
    karma = await awardKarma(db, u.id, KARMA.checkin, 'checkin', p.id, now);
    const weight = voteWeight(voter(u), now, { checkedIn: true });
    await db.prepare(
      `INSERT INTO votes (user_id, popup_id, kind, value, weight, ip_hash, created_at) VALUES (?, ?, 'existence', 1, ?, ?, ?)
       ON CONFLICT (user_id, popup_id, kind) DO UPDATE SET value = 1, weight = excluded.weight, created_at = excluded.created_at, settled = 0`,
    ).bind(u.id, p.id, weight, await ipHash(c), now).run();
  }
  const change = await recompute(db, p.id, now);
  if (entersOrLeavesPublic(change)) rebuildSnapshotSoon(c);
  return c.json({
    valid: !!valid,
    distance_m: Math.round(distance),
    message: valid ? 'Checked in. Your vote now counts three times.' : `You look ${Math.round(distance)} m away. Check-ins need to be within ${CHECKIN_RADIUS_M} m.`,
    karma_awarded: karma,
    status_change: change,
  });
});

/* ---------- POST /popups/:id/report ---------- */
const REASONS = ['not_exist', 'cancelled', 'wrong_details', 'duplicate', 'spam', 'inappropriate'] as const;
popups.post('/:id/report', async c => {
  const u = requireUser(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  await verifyTurnstile(c, typeof b.turnstile_token === 'string' ? b.turnstile_token : undefined);
  const reason = oneOf(b, 'reason', REASONS, { required: true })!;
  const note = text(b, 'note', { max: 500 });
  const db = c.env.DB;
  const p = await load(db, c.req.param('id'));
  if (!canSee(p, u)) throw new ApiError(404, 'not_found', 'This pop-up does not exist.');
  const ins = await db.prepare(
    'INSERT OR IGNORE INTO reports (id, user_id, popup_id, reason, note, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(newId(), u.id, p.id, reason, note, voteWeight(voter(u), now), now).run();
  if (!ins.meta.changes) throw new ApiError(409, 'already_reported', 'You already reported this pop-up.');
  const change = await recompute(db, p.id, now);
  if (entersOrLeavesPublic(change)) rebuildSnapshotSoon(c);
  return c.json({ ok: true, status_change: change }, 201);
});

/* ---------- saves ---------- */
popups.put('/:id/save', async c => {
  const u = requireUser(c);
  const p = await load(c.env.DB, c.req.param('id'));
  if (!canSee(p, u)) throw new ApiError(404, 'not_found', 'This pop-up does not exist.');
  const b = await c.req.json().catch(() => ({})) as { remind?: boolean };
  await c.env.DB.prepare(
    'INSERT INTO saves (user_id, popup_id, remind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, popup_id) DO UPDATE SET remind = excluded.remind',
  ).bind(u.id, p.id, b.remind === false ? 0 : 1, c.get('now')).run();
  return c.json({ saved: true });
});
popups.delete('/:id/save', async c => {
  const u = requireUser(c);
  const p = await load(c.env.DB, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM saves WHERE user_id = ? AND popup_id = ?').bind(u.id, p.id).run();
  return c.json({ saved: false });
});

/* ---------- POST /popups/:id/images (raw body, the client compresses first) ---------- */
const IMAGE_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
popups.post('/:id/images', async c => {
  const u = requireUser(c);
  if (!c.env.IMAGES) throw new ApiError(501, 'photos_not_enabled', 'Photo uploads are not switched on yet. Your pop-up was saved without photos.');
  const db = c.env.DB;
  const p = await load(db, c.req.param('id'));
  if (p.created_by !== u.id && u.role !== 'admin') throw new ApiError(403, 'not_yours', 'Only the poster can add photos for now.');
  const type = (c.req.header('content-type') ?? '').split(';')[0].trim();
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new ApiError(415, 'image_type', 'Photos must be WebP, JPEG or PNG.');
  const size = Number(c.req.header('content-length') ?? 0);
  if (size > 5 * 1024 * 1024) throw new ApiError(413, 'image_too_large', 'Photos can be at most 5 MB.');
  const count = await db.prepare('SELECT COUNT(*) AS n FROM popup_images WHERE popup_id = ?').bind(p.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 5) throw new ApiError(409, 'too_many_images', 'A pop-up can have up to 5 photos.');
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 5 * 1024 * 1024) throw new ApiError(413, 'image_too_large', 'Photos can be at most 5 MB.');
  if (!body.byteLength) throw bad('image_empty', 'The photo is empty.');
  const id = newId();
  const key = `popups/${p.id}/${id}.${ext}`;
  await c.env.IMAGES.put(key, body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await db.prepare('INSERT INTO popup_images (id, popup_id, r2_key, position, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, p.id, key, count?.n ?? 0, u.id, c.get('now')).run();
  return c.json({ id, url: `/api/v1/images/${key}` }, 201);
});

/* ---------- PUT /popups/:id/images/:imageId/thumb (the poster's browser, or an admin's) ----------
   A small copy of a photo for lists, made in the browser (the Worker has no CPU to resize on the free plan).
   Lists show it instead of the full photo, which can be 2 MB for a card that is 100 px wide. A new copy gets a
   new key, because a key is cached for good (see the image route). */
export const MAX_THUMB_BYTES = 150 * 1024;
popups.put('/:id/images/:imageId/thumb', async c => {
  const u = requireUser(c);
  const db = c.env.DB;
  const p = await load(db, c.req.param('id'));
  if (p.created_by !== u.id && u.role !== 'admin') throw new ApiError(403, 'not_yours', 'Only the poster or an admin can add a thumbnail.');
  const img = await db.prepare('SELECT id, thumb_key FROM popup_images WHERE id = ? AND popup_id = ?').bind(c.req.param('imageId'), p.id).first<{ id: string; thumb_key: string | null }>();
  if (!img) throw new ApiError(404, 'not_found', 'That photo is not on this pop-up.');
  if (Number(c.req.header('content-length') ?? 0) > MAX_THUMB_BYTES) throw new ApiError(413, 'thumb_too_large', 'A thumbnail can be at most 150 KB.');
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) throw bad('image_empty', 'The thumbnail is empty.');
  if (body.byteLength > MAX_THUMB_BYTES) throw new ApiError(413, 'thumb_too_large', 'A thumbnail can be at most 150 KB.');
  const kind = sniffPhoto(new Uint8Array(body)); // what the bytes are, not what the header says
  if (!kind || kind.type === 'image/png') throw new ApiError(415, 'image_type', 'Thumbnails must be WebP or JPEG.');
  const key = `thumbs/${p.id}/${newId()}.${kind.ext}`;
  await c.env.IMAGES.put(key, body, { httpMetadata: { contentType: kind.type, cacheControl: 'public, max-age=31536000, immutable' } });
  await db.prepare('UPDATE popup_images SET thumb_key = ? WHERE id = ?').bind(key, img.id).run();
  if (img.thumb_key) await c.env.IMAGES.delete(img.thumb_key);
  // No snapshot rebuild here: the 10 minute cron picks it up, and a backfill would otherwise rebuild it once per photo.
  return c.json({ id: img.id, url: `/api/v1/images/${key}` });
});

/* ---------- POST /popups/:id/images/from-url { image_url, page_url } ----------
   The poster pasted a link and the page has a main picture (og:image). We copy it, never hotlink, and credit the page. */
popups.post('/:id/images/from-url', async c => {
  const u = requireUser(c);
  if (!c.env.IMAGES) throw new ApiError(501, 'photos_not_enabled', 'Photo uploads are not switched on yet. Your pop-up was saved without photos.');
  const p = await load(c.env.DB, c.req.param('id'));
  if (p.created_by !== u.id && u.role !== 'admin') throw new ApiError(403, 'not_yours', 'Only the poster can add photos for now.');
  const b = await jsonBody(c.req);
  const page = safeUrl(text(b, 'page_url', { max: 1000 }) ?? '');
  const image = resolveImageUrl(text(b, 'image_url', { max: 2000 }), page?.toString() ?? 'https://invalid.example/');
  if (!image) throw bad('image_url_invalid', 'That photo address is not a public web link.');
  const r = await addPhotoFromUrl(c.env, p.id, u.id, { imageUrl: image, pageUrl: page?.toString() ?? null }, c.get('now'));
  if (!r.saved) throw new ApiError(422, 'photo_not_saved', `${r.reason} Your pop-up was saved without it.`);
  return c.json({ id: r.id, url: r.url }, 201);
});

/* ---------- DELETE /popups/:id/images/:imageId (the poster, or an admin who takes a photo down) ---------- */
popups.delete('/:id/images/:imageId', async c => {
  const u = requireUser(c);
  const db = c.env.DB;
  const p = await load(db, c.req.param('id'));
  if (p.created_by !== u.id && u.role !== 'admin') throw new ApiError(403, 'not_yours', 'Only the poster or an admin can remove a photo.');
  const img = await db.prepare('SELECT id, r2_key, thumb_key, source_url, position FROM popup_images WHERE id = ? AND popup_id = ?').bind(c.req.param('imageId'), p.id).first<{ id: string; r2_key: string; thumb_key: string | null; source_url: string | null; position: number }>();
  if (!img) throw new ApiError(404, 'not_found', 'That photo is not on this pop-up.');
  await db.prepare('DELETE FROM popup_images WHERE id = ?').bind(img.id).run();
  // Positions stay in order so the first photo is still the cover.
  await db.prepare('UPDATE popup_images SET position = position - 1 WHERE popup_id = ? AND position > ?').bind(p.id, img.position).run();
  await c.env.IMAGES?.delete(img.r2_key);
  if (img.thumb_key) await c.env.IMAGES?.delete(img.thumb_key);
  if (u.role === 'admin') await audit(db, u.id, 'popup.image_remove', 'popup', p.id, { image: img.id, source_url: img.source_url }, c.get('now'));
  if (PUBLIC_STATUSES.includes(p.status)) rebuildSnapshotSoon(c); // the cover may have changed
  return c.json({ removed: true });
});

/* ---------- input parsing shared by create and edit ---------- */
function fromRow(p: PopupRow) {
  return {
    title: p.title, host: p.host, description: p.description, category: p.category, price_type: p.price_type,
    price_text: p.price_text, address: p.address, borough: p.borough, lat: p.lat, lng: p.lng,
    start_at: p.start_at, end_at: p.end_at, hours_text: p.hours_text, source_url: p.source_url,
  };
}

/** `ongoing`: agents may send a pop-up that started long ago and is still running, with its real start date. */
export function parsePopupInput(b: Record<string, unknown>, now: number, creating: boolean, opts: { ongoing?: boolean } = {}) {
  const title = text(b, 'title', { min: 3, max: 100, required: true });
  const category = oneOf(b, 'category', CATEGORIES, { required: true });
  const lat = num(b, 'lat', { required: true }), lng = num(b, 'lng', { required: true });
  if (!inLondon(lat!, lng!)) throw bad('outside_london', 'The location must be in London.');
  const start_at = num(b, 'start_at', { required: true }), end_at = num(b, 'end_at', { required: true });
  if (end_at! <= start_at!) throw bad('dates_invalid', 'The end must be after the start.');
  if (end_at! - start_at! > MAX_DURATION) throw bad('too_long', `A pop-up can run for at most ${MAX_DURATION / DAY} days.`);
  if (creating && !opts.ongoing && start_at! < now - 7 * DAY) throw bad('too_old', 'The start date cannot be more than 7 days ago.');
  if (creating && end_at! < now) throw bad('already_ended', 'This pop-up has already ended.');
  let source_url: string | null = text(b, 'source_url', { max: 500 });
  if (source_url) {
    const u = safeUrl(source_url);
    if (!u) throw bad('source_url_invalid', 'The source link must be a public web address.');
    source_url = u.toString();
  }
  return {
    title, category, lat, lng, start_at, end_at, source_url,
    host: text(b, 'host', { max: 100 }),
    description: text(b, 'description', { max: 2000 }),
    address: text(b, 'address', { max: 200 }),
    borough: text(b, 'borough', { max: 60 }),
    hours_text: text(b, 'hours_text', { max: 120 }),
    price_type: oneOf(b, 'price_type', ['free', 'paid', 'unknown'] as const) ?? 'unknown',
    price_text: text(b, 'price_text', { max: 80 }),
  };
}

