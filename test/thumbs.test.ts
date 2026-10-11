import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { buildPopupSnapshot } from '../src/db/snapshot';
import { MAX_THUMB_BYTES } from '../src/routes/popups';

const NOW = Date.UTC(2026, 8, 30, 13);
const DAY = 86_400_000;

async function call(path: string, user?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-now', String(NOW));
  if (user) headers.set('x-dev-user', user);
  return exports.default.fetch(new Request(`http://spotted.test${path}`, { ...init, headers }));
}

let n = 0;
async function user(role = 'user') {
  const id = `t${++n}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare('INSERT INTO users (id, email, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, 58, 3, 1, ?)')
    .bind(id, `${id}@test.dev`, role, NOW - 60 * DAY).run();
  return id;
}

/** A pop-up with one full-size photo. */
async function withPhoto(poster: string) {
  const res = await call('/api/v1/popups', poster, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `Thumb stall ${Math.random().toString(36).slice(2, 8)}`, category: 'market', lat: 51.5 + Math.random() / 50, lng: -0.07, start_at: NOW + DAY, end_at: NOW + 2 * DAY, source_url: 'https://example.com/x' }),
  });
  const p = (await res.json()) as { id: string };
  const img = await call(`/api/v1/popups/${p.id}/images`, poster, { method: 'POST', headers: { 'content-type': 'image/webp' }, body: new Uint8Array([1, 2, 3]) });
  return { popup: p.id, image: ((await img.json()) as { id: string }).id };
}

/** Enough of a WebP header for the server's type check. */
const webp = (extra = 20) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array(extra).fill(7)]);
const put = (path: string, who: string, body: BodyInit, type = 'image/webp') => call(path, who, { method: 'PUT', headers: { 'content-type': type }, body });

describe('thumbnails', () => {
  it('are stored for the poster, served from the image route, and used as the list cover', async () => {
    const poster = await user();
    const { popup, image } = await withPhoto(poster);
    const res = await put(`/api/v1/popups/${popup}/images/${image}/thumb`, poster, webp());
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^/api/v1/images/thumbs/${popup}/`));

    const served = await call(url);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toContain('immutable');

    // The list (snapshot) points at the small copy, the pop-up itself at the full photo.
    const snap = JSON.parse((await buildPopupSnapshot(env.DB, NOW)).json) as { items: { id: string; cover_url: string }[] };
    expect(snap.items.find(i => i.id === popup)!.cover_url).toBe(url);
    const full = (await (await call(`/api/v1/popups/${popup}`)).json()) as { cover_url: string; images: { url: string }[] };
    expect(full.cover_url).toMatch(/\/images\/popups\//);
    expect(full.images[0].url).toMatch(/\/images\/popups\//);
  });

  it('are refused for other people, odd types and big files', async () => {
    const poster = await user(), other = await user();
    const { popup, image } = await withPhoto(poster);
    const path = `/api/v1/popups/${popup}/images/${image}/thumb`;
    expect((await put(path, other, webp())).status).toBe(403);
    expect((await put(path, poster, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).status).toBe(415); // not an image, whatever the header says
    expect((await put(path, poster, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 'image/png')).status).toBe(415);
    expect((await put(path, poster, webp(MAX_THUMB_BYTES))).status).toBe(413);
    expect((await put(path, poster, new Uint8Array())).status).toBe(400);
    expect((await put(`/api/v1/popups/${popup}/images/nope/thumb`, poster, webp())).status).toBe(404);
    expect((await call(path, undefined, { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: webp() })).status).toBe(401);
    expect((await env.DB.prepare('SELECT thumb_key FROM popup_images WHERE id = ?').bind(image).first<{ thumb_key: string | null }>())!.thumb_key).toBeNull();
  });

  it('a new copy gets a new key and the old one is deleted; deleting the photo deletes its copy', async () => {
    const poster = await user();
    const { popup, image } = await withPhoto(poster);
    const path = `/api/v1/popups/${popup}/images/${image}/thumb`;
    const first = ((await (await put(path, poster, webp())).json()) as { url: string }).url;
    const second = ((await (await put(path, poster, webp(30))).json()) as { url: string }).url;
    expect(second).not.toBe(first);
    expect((await call(first)).status).toBe(404);
    expect((await call(second)).status).toBe(200);
    expect((await call(`/api/v1/popups/${popup}/images/${image}`, poster, { method: 'DELETE' })).status).toBe(200);
    expect((await call(second)).status).toBe(404);
  });

  it('are listed for the admin until made, a page at a time', async () => {
    const boss = await user('admin'), poster = await user();
    expect((await call('/api/v1/admin/images/needing-thumbs', poster)).status).toBe(403);
    const a = await withPhoto(poster), b = await withPhoto(poster), c = await withPhoto(poster);
    const ids = [a.image, b.image, c.image];

    const first = (await (await call('/api/v1/admin/images/needing-thumbs?limit=2', boss)).json()) as { items: { id: string; popup_id: string; url: string }[]; next: string | null; left: number };
    expect(first.left).toBeGreaterThanOrEqual(3);
    expect(first.items).toHaveLength(2);
    expect(first.items[0].url).toMatch(/^\/api\/v1\/images\/popups\//);
    expect(first.next).toBe(first.items[1].id);
    const more = (await (await call(`/api/v1/admin/images/needing-thumbs?limit=2&after=${first.next}`, boss)).json()) as { items: { id: string }[]; left: number | null };
    expect(more.left).toBeNull(); // the count comes with the first page only
    expect(more.items.every(i => i.id > first.next!)).toBe(true);

    // Once a photo has its copy it is no longer listed.
    for (const x of [a, b, c]) expect((await put(`/api/v1/popups/${x.popup}/images/${x.image}/thumb`, boss, webp())).status).toBe(200);
    const all = (await (await call('/api/v1/admin/images/needing-thumbs?limit=10', boss)).json()) as { items: { id: string }[] };
    expect(all.items.map(i => i.id).filter(id => ids.includes(id))).toEqual([]);
  });

  it('are found through the partial index, not by reading the whole photo table', async () => {
    const plan = async (sql: string, ...args: unknown[]) =>
      (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map(r => r.detail).join(' | ');
    expect(await plan('SELECT id, popup_id, r2_key FROM popup_images WHERE thumb_key IS NULL AND id > ? ORDER BY id LIMIT ?', '', 4)).toContain('idx_images_nothumb');
    expect(await plan('SELECT COUNT(*) AS n FROM popup_images WHERE thumb_key IS NULL')).toContain('idx_images_nothumb');
  });
});
