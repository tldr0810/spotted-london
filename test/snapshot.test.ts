import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runCron } from '../src/cron';
import { listPopups } from '../src/routes/popups';
import { buildPopupSnapshot, entersOrLeavesPublic, loadSnapshotItems, readSnapshot, snapshotItems, snapshotStats } from '../src/db/snapshot';
import { filterPopups } from '../src/shared/filter-popups';
import { hot } from '../src/lib/scoring';

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London (BST)

async function call(method: string, path: string, o: { user?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-now': String(NOW), ...o.headers };
  if (o.user) headers['x-dev-user'] = o.user;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const json = (r: { text: string }) => JSON.parse(r.text);

const BOROUGHS = ['Soho', 'Hackney', 'Camden', 'Peckham', null];
const CATS = ['food', 'fashion', 'art', 'market', 'tech', 'dining', 'exhibition', 'event'];
const TITLES = ['Matcha Lab', '100% Vintage_Sale', 'CAFE Takeover', 'Night Market', 'Riso Print Day', 'Kilo sale', 'Pottery seconds', 'Sneaker drop'];
// null: not looked at; '': none apply. Keys with an underscore make sure `_` is not read as a wildcard.
const TAGSETS: (string | null)[] = [',family,late_night,', null, ',outdoors,', '', ',interactive,late_night,', ',family,', null];
const STATUSES = ['community', 'community', 'verified_community', 'verified_admin', 'pending', 'hidden', 'removed', 'ended'];

/** 48 deterministic pop-ups: every status, window, category, price and place the filters care about. */
async function seed() {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('sn_user', 'sn_user@test.dev', 'Poster', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY).run();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 48; i++) {
    const status = STATUSES[i % STATUSES.length];
    const startAt = NOW + ((i * 37) % 200 - 60) * HOUR;           // from 2.5 days ago to 6 days ahead
    const endAt = startAt + (6 + (i % 5) * 20) * HOUR;
    const lat = 51.45 + (i % 8) * 0.012, lng = -0.2 + Math.floor(i / 8) * 0.03;
    const quality = { pos: i % 7, neg: i % 3 };
    const h = hot({ status: status as never, qualityPos: quality.pos, qualityNeg: quality.neg, startAt, endAt }, NOW);
    stmts.push(env.DB.prepare(`INSERT INTO popups (id, slug, title, host, category, price_type, borough, lat, lng, geohash, address, start_at, end_at, status, created_by, created_at, updated_at, quality_pos, quality_neg, hot, is_example, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'gcpvj', 'A', ?, ?, ?, 'sn_user', ?, ?, ?, ?, ?, 0, ?)`)
      .bind(`sn_${String(i).padStart(2, '0')}`, `sn-${i}`, `${TITLES[i % TITLES.length]} ${i}`, i % 4 === 0 ? null : `Host ${['Alpha', 'Beta', 'Gamma'][i % 3]}`, CATS[i % CATS.length],
        i % 3 === 0 ? 'free' : 'paid', BOROUGHS[i % BOROUGHS.length], lat, lng, startAt, endAt, status, NOW, NOW, quality.pos, quality.neg, h, TAGSETS[i % TAGSETS.length]));
  }
  // three pop-ups with identical inputs, so identical hot: the tie is settled by id
  const tieStart = NOW + 5 * HOUR, tieEnd = NOW + 30 * HOUR;
  const tieHot = hot({ status: 'community', qualityPos: 2, qualityNeg: 0, startAt: tieStart, endAt: tieEnd }, NOW);
  stmts.push(env.DB.prepare(`UPDATE popups SET status = 'community', start_at = ?, end_at = ?, quality_pos = 2, quality_neg = 0, hot = ? WHERE id IN ('sn_08', 'sn_16', 'sn_24')`).bind(tieStart, tieEnd, tieHot));
  await env.DB.batch(stmts);
}

await seed();

describe('old SQL list and new browser filter agree', () => {
  const params: Record<string, string>[] = [];
  for (const when of ['today', 'weekend', 'week', 'all'])
    for (const category of ['', 'food', 'art,tech', 'dining,exhibition'])
      for (const verified of ['', '1'])
        for (const free of ['', '1']) params.push({ when, category, verified, free });
  params.push(
    { when: 'all', q: 'matcha' }, { when: 'all', q: 'MATCHA' }, { when: 'all', q: 'alpha' }, { when: 'all', q: 'soho' }, { when: 'all', q: '100%' },
    { when: 'all', q: '_Sale' }, { when: 'all', q: 'zzz-none' }, { when: 'week', q: 'night', category: 'market' },
    { when: 'all', borough: 'hackney' }, { when: 'all', borough: 'CAMDEN', free: '1' },
    { when: 'all', near: '51.49,-0.17', radius_km: '2' }, { when: 'all', near: '51.49,-0.17', radius_km: '2', sort: 'distance' },
    { when: 'week', near: '51.5,-0.11', radius_km: '1', sort: 'distance', verified: '1' }, { when: 'all', near: '51.5,-0.11' },
    { when: 'all', bbox: '-0.2,51.45,-0.1,51.52' }, { when: 'all', bbox: '-0.12,51.5,-0.05,51.55', category: 'food' },
    { when: 'all', limit: '5' }, { when: 'all', limit: '5', cursor: '5' }, { when: 'all', limit: '5', cursor: 'a' },
    { when: 'all', near: '51.49,-0.17', radius_km: '3', sort: 'distance', limit: '4', cursor: '4' },
    { when: 'all', tag: 'family' }, { when: 'all', tag: 'late_night' }, { when: 'all', tag: 'family,late_night' }, { when: 'all', tag: 'outdoors,family' },
    { when: 'all', avoid: 'late_night' }, { when: 'all', avoid: 'family,outdoors' }, { when: 'all', tag: 'family', avoid: 'late_night' },
    { when: 'week', tag: 'interactive', free: '1' }, { when: 'all', tag: 'family', category: 'food,art', verified: '1' },
    { when: 'all', tag: 'family', limit: '3' }, { when: 'all', tag: 'family', limit: '3', cursor: '3' },
    { when: 'all', limit: '50' }, { when: 'all', limit: '0' }, { when: 'bogus' }, {},
  );

  it('runs at least 30 combinations', () => expect(params.length).toBeGreaterThanOrEqual(30));

  it.each(params.map((p, i) => [i, JSON.stringify(p), p] as const))('%i %s', async (_i, _label, p) => {
    const old = await listPopups(env.DB, p as Record<string, string>, NOW);
    const snapshot = await loadSnapshotItems(env.DB, NOW);
    const fresh = filterPopups(snapshot, p as Record<string, string>, NOW);
    expect(fresh.items.map(x => x.id)).toEqual(old.items.map(x => x.id));
    expect(fresh.next_cursor).toBe(old.next_cursor);
    expect(fresh.items.map(x => x.distance_m)).toEqual(old.items.map(x => (x as { distance_m?: number }).distance_m));
  });

  it("limit 'all' returns every match in one go, in the same order as paging through them", async () => {
    const snapshot = await loadSnapshotItems(env.DB, NOW);
    const everything = filterPopups(snapshot, { when: 'all', limit: 'all' }, NOW);
    expect(everything.next_cursor).toBeNull();
    const paged: string[] = [];
    for (let cursor: string | undefined, i = 0; i < 20; i++) {
      const page = filterPopups(snapshot, { when: 'all', limit: '5', ...(cursor ? { cursor } : {}) }, NOW);
      paged.push(...page.items.map(x => x.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(everything.items.map(x => x.id)).toEqual(paged);
    expect(everything.items.length).toBeGreaterThan(5);
    // a plain limit still stops at 50
    const many = Array.from({ length: 120 }, (_, i) => ({ ...snapshot[0], id: `x${i}`, hot: i }));
    expect(filterPopups(many, { when: 'all', limit: '50' }, NOW).items).toHaveLength(50);
    expect(filterPopups(many, { when: 'all', limit: '999' }, NOW).items).toHaveLength(50);
    expect(filterPopups(many, { when: 'all', limit: 'all' }, NOW).items).toHaveLength(120);
  });

  it('actually compares something: the filters leave different, non-empty lists', async () => {
    const snapshot = await loadSnapshotItems(env.DB, NOW);
    const sizes = new Set(params.map(p => filterPopups(snapshot, p, NOW).items.length));
    expect(sizes.size).toBeGreaterThan(5);
    expect(filterPopups(snapshot, { when: 'all' }, NOW).items.length).toBeGreaterThan(10);
  });
});

describe('buildPopupSnapshot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('holds only public, not-yet-over pop-ups, with trimmed fields and hot computed in JS', async () => {
    const items = await loadSnapshotItems(env.DB, NOW);
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(['community', 'verified_community', 'verified_admin']).toContain(p.status);
      expect(p.end_at).toBeGreaterThan(NOW);
      expect(p).not.toHaveProperty('me');
      expect(p).not.toHaveProperty('posted_by');
      expect(p).not.toHaveProperty('images');
      expect(p.description).toBeNull();
    }
    const row = await env.DB.prepare("SELECT hot, quality_pos, quality_neg, start_at, end_at, status FROM popups WHERE id = 'sn_00'").first<any>();
    await env.DB.prepare("UPDATE popups SET hot = 99 WHERE id = 'sn_00'").run();
    const again = (await loadSnapshotItems(env.DB, NOW)).find(p => p.id === 'sn_00');
    if (again) expect(again.hot).toBe(hot({ status: row.status, qualityPos: row.quality_pos, qualityNeg: row.quality_neg, startAt: row.start_at, endAt: row.end_at }, NOW));
  });

  it('stores one row, and does not write when the JSON is too big', async () => {
    const ok = await buildPopupSnapshot(env.DB, NOW);
    expect(ok.written).toBe(true);
    const before = await env.DB.prepare("SELECT version, json, built_at FROM snapshots WHERE key = 'popups'").first<{ version: string; json: string; built_at: number }>();
    expect(before!.built_at).toBe(NOW);
    expect(JSON.parse(before!.json).items.length).toBe(ok.count);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const big = await buildPopupSnapshot(env.DB, NOW + HOUR, 100);
    expect(big.written).toBe(false);
    expect(err).toHaveBeenCalled();
    const after = await env.DB.prepare("SELECT version, json FROM snapshots WHERE key = 'popups'").first<{ version: string; json: string }>();
    expect(after).toEqual({ version: before!.version, json: before!.json });
  });

  it('is rebuilt by the ten-minute cron', async () => {
    await runCron('*/10 * * * *', env, NOW + 2 * HOUR);
    expect((await env.DB.prepare("SELECT built_at FROM snapshots WHERE key = 'popups'").first<{ built_at: number }>())!.built_at).toBe(NOW + 2 * HOUR);
  });

  it('knows which status changes matter', () => {
    expect(entersOrLeavesPublic(null)).toBe(false);
    expect(entersOrLeavesPublic({ from: 'community', to: 'verified_community' })).toBe(false);
    expect(entersOrLeavesPublic({ from: 'community', to: 'hidden' })).toBe(true);
    expect(entersOrLeavesPublic({ from: 'hidden', to: 'community' })).toBe(true);
    expect(entersOrLeavesPublic({ from: 'pending', to: 'hidden' })).toBe(false);
  });
});

describe('GET /popups/snapshot', () => {

  it('sends the stored text as it is, with an ETag, and answers 304 to a repeat', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    const stored = await env.DB.prepare("SELECT version, json FROM snapshots WHERE key = 'popups'").first<{ version: string; json: string }>();
    const first = await call('GET', '/popups/snapshot');
    expect(first.status).toBe(200);
    expect(first.text).toBe(stored!.json);
    expect(first.headers.get('etag')).toBe(`"${stored!.version}"`);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    expect(first.headers.get('content-type')).toContain('application/json');

    const again = await call('GET', '/popups/snapshot', { headers: { 'if-none-match': first.headers.get('etag')! } });
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    const stale = await call('GET', '/popups/snapshot', { headers: { 'if-none-match': '"old"' } });
    expect(stale.status).toBe(200);
  });

  it('is the same for a signed-in user and a visitor', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    expect((await call('GET', '/popups/snapshot', { user: 'sn_user' })).text).toBe((await call('GET', '/popups/snapshot')).text);
  });

  it('is not mistaken for a pop-up id', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    const r = await call('GET', '/popups/snapshot');
    expect(Array.isArray(json(r).items)).toBe(true);
  });

  it('builds the list from SQL when there is no stored snapshot', async () => {
    await env.DB.prepare("DELETE FROM snapshots WHERE key = 'popups'").run();
    const r = await call('GET', '/popups/snapshot');
    expect(r.status).toBe(200);
    expect(json(r).items.length).toBeGreaterThan(0);
  });
});

describe('snapshotItems (what the MCP search reads instead of scanning the table)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the stored list as objects and reads only the small version row when nothing changed', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    const first = await snapshotItems(env.DB, NOW);
    expect(first.map(p => p.id)).toEqual((await loadSnapshotItems(env.DB, NOW)).map(p => p.id));

    const sql: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation(q => { sql.push(q); return real(q); });
    const again = await snapshotItems(env.DB, NOW);
    expect(again).toBe(first); // the same parsed list, not a new parse
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/SELECT version FROM snapshots/);
    expect(sql[0]).not.toMatch(/json/);
  });

  it('reads the new list once the stored snapshot changes, and builds one when none is stored', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    const before = await snapshotItems(env.DB, NOW);
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('sn_user', 'sn_user@test.dev', 'Poster', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY).run();
    await env.DB.prepare(
      `INSERT INTO popups (id, slug, title, category, lat, lng, start_at, end_at, status, created_by, quality_pos, quality_neg, created_at, updated_at, hot, geohash)
       VALUES ('sn_fresh', 'sn-fresh', 'Snapshot Items Fresh', 'market', 51.5, -0.12, ?, ?, 'community', 'sn_user', 1, 0, ?, ?, 1, 'gcpvj0f')`,
    ).bind(NOW + HOUR, NOW + 2 * DAY, NOW, NOW).run();
    expect((await snapshotItems(env.DB, NOW)).map(p => p.id)).not.toContain('sn_fresh'); // not rebuilt yet
    await buildPopupSnapshot(env.DB, NOW);
    const after = await snapshotItems(env.DB, NOW);
    expect(after.map(p => p.id)).toContain('sn_fresh');
    expect(after.length).toBe(before.length + 1);

    await env.DB.prepare("DELETE FROM snapshots WHERE key = 'popups'").run();
    expect((await snapshotItems(env.DB, NOW)).map(p => p.id)).toContain('sn_fresh');
    await env.DB.prepare("DELETE FROM popups WHERE id = 'sn_fresh'").run();
    await buildPopupSnapshot(env.DB, NOW);
  });
});

describe('a list too big for one row', () => {
  const keys = async () => (await env.DB.prepare("SELECT key FROM snapshots WHERE key = 'popups' OR key LIKE 'popups.%' ORDER BY key").all<{ key: string }>()).results.map(r => r.key);

  it('is stored in several rows, and read back as exactly the same text', async () => {
    const whole = await buildPopupSnapshot(env.DB, NOW);
    expect(await keys()).toEqual(['popups']); // it fits in one row: stored whole, as before
    expect((await readSnapshot(env.DB))!.json).toBe(whole.json);

    const small = 4000; // a few pop-ups per row
    const split = await buildPopupSnapshot(env.DB, NOW, undefined, small);
    expect(split.json).toBe(whole.json);
    expect(split.version).toBe(whole.version);
    const rows = await keys();
    expect(rows.length).toBeGreaterThan(2);
    expect(rows).toEqual(['popups', ...rows.slice(1).map((_, i) => `popups.${String(i + 1).padStart(2, '0')}`)]);
    const read = (await readSnapshot(env.DB))!;
    expect(read.json).toBe(whole.json);
    expect(read.version).toBe(whole.version);
    expect(JSON.parse(read.json).items).toHaveLength(whole.count);

    // The endpoint sends the same text, with the same ETag, and the MCP reader sees every pop-up.
    const res = await call('GET', '/popups/snapshot');
    expect(res.text).toBe(whole.json);
    expect(res.headers.get('etag')).toBe(`"${whole.version}"`);
    expect((await snapshotItems(env.DB, NOW)).length).toBe(whole.count);
  });

  it('drops the rows it no longer needs when the list gets shorter', async () => {
    await buildPopupSnapshot(env.DB, NOW, undefined, 3000);
    const many = (await keys()).length;
    expect(many).toBeGreaterThan(2);
    await buildPopupSnapshot(env.DB, NOW, undefined, 12000);
    const fewer = (await keys()).length;
    expect(fewer).toBeLessThan(many);
    await buildPopupSnapshot(env.DB, NOW);
    expect(await keys()).toEqual(['popups']);
    expect(JSON.parse((await readSnapshot(env.DB))!.json).items.length).toBeGreaterThan(10);
  });

  it('reports its size for the admin page', async () => {
    const built = await buildPopupSnapshot(env.DB, NOW, undefined, 5000);
    const stats = await snapshotStats(env.DB);
    expect(stats.bytes).toBeGreaterThan(built.bytes - 200); // the rows add up to the list (minus the wrapper)
    expect(stats.bytes).toBeLessThanOrEqual(built.bytes);
    expect(stats.built_at).toBe(NOW);
    await buildPopupSnapshot(env.DB, NOW);
  });
});

describe('rebuilding right away', () => {
  const stored = async () => (await env.DB.prepare("SELECT json FROM snapshots WHERE key = 'popups'").first<{ json: string }>())?.json ?? '';
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 50; i++) { if (await check()) return true; await new Promise(r => setTimeout(r, 20)); }
    return false;
  }
  beforeAll(async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('sn_admin', 'sn_admin@test.dev', 'Boss', 'admin', 58, 3, 1, ?)").bind(NOW - 60 * DAY).run();
  });

  it('drops a pop-up the moment an admin hides it', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    const id = JSON.parse(await stored()).items[0].id as string;
    const r = await call('POST', `/admin/popups/${id}/decision`, { user: 'sn_admin', body: { action: 'hide', reason: 'test' } });
    expect(r.status).toBe(200);
    expect(await until(async () => !(await stored()).includes(`"id":"${id}"`))).toBe(true);
  });

  it('shows a new public pop-up at once', async () => {
    await buildPopupSnapshot(env.DB, NOW);
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES ('sn_new', 'sn_new@test.dev', 'New poster', 'user', 58, 3, 1, ?)").bind(NOW - 60 * DAY).run();
    const r = await call('POST', '/popups', { user: 'sn_new', body: {
      title: 'Snapshot Pop-up Brand New', category: 'market', host: 'Arches', lat: 51.4975, lng: -0.0735, address: 'Druid Street, SE1', borough: 'Bermondsey',
      start_at: NOW + 2 * DAY, end_at: NOW + 3 * DAY, source_url: 'instagram.com/arches',
    } });
    expect(r.status).toBe(201);
    expect(json(r).status).toBe('community');
    expect(await until(async () => (await stored()).includes('Snapshot Pop-up Brand New'))).toBe(true);
  });
});
