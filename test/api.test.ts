import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { endExpired, settleKarma } from '../src/cron';
import { CATEGORIES } from '../src/shared/categories';

const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 30, 13); // Wed 30 Sep 2026, 14:00 London
const SOHO = { lat: 51.5135, lng: -0.134 };

type Opts = { user?: string; body?: unknown; now?: number; ip?: string };
async function api(method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { 'x-now': String(o.now ?? NOW) };
  if (o.user) headers['x-dev-user'] = o.user;
  if (o.ip) headers['x-dev-ip'] = o.ip;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await exports.default.fetch(new Request(`http://spotted.test/api/v1${path}`, {
    method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body),
  }));
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

let n = 0;
async function user(o: { karma?: number; ageDays?: number; role?: string; verifiedPosts?: number; emailVerified?: boolean } = {}) {
  const id = `u${++n}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare(
    'INSERT INTO users (id, email, display_name, role, karma, verified_posts, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, `${id}@test.dev`, id, o.role ?? 'user', o.karma ?? 58, o.verifiedPosts ?? 3, o.emailVerified === false ? 0 : 1, NOW - (o.ageDays ?? 60) * DAY).run();
  return id;
}
const karmaOf = async (id: string) => (await env.DB.prepare('SELECT karma FROM users WHERE id = ?').bind(id).first<{ karma: number }>())!.karma;

function popupBody(over: Record<string, unknown> = {}) {
  return {
    title: 'Night Market under the Arches', category: 'market', host: 'Arches Collective',
    lat: 51.4975, lng: -0.0735, address: 'Druid Street, SE1', borough: 'Bermondsey',
    start_at: NOW + 2 * DAY, end_at: NOW + 3 * DAY, source_url: 'instagram.com/archescollective', ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('creating pop-ups', () => {
  it('needs a signed-in user', async () => {
    expect((await api('POST', '/popups', { body: popupBody() })).status).toBe(401);
  });

  it('routes posts by trust: review, straight to community, or verified for admins', async () => {
    const newbie = await user({ karma: 0, verifiedPosts: 0, ageDays: 2 });
    const trusted = await user();
    const boss = await user({ role: 'admin' });
    const a = await api('POST', '/popups', { user: newbie, body: popupBody({ title: 'Plant swap', lat: 51.5485, lng: -0.0755 }) });
    const b = await api('POST', '/popups', { user: trusted, body: popupBody() });
    const c = await api('POST', '/popups', { user: boss, body: popupBody({ title: 'Indie perfume lab', lat: 51.5195, lng: -0.1515 }) });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(a.json.status).toBe('pending');
    expect(b.json.status).toBe('community');
    expect(c.json.status).toBe('verified_admin');
    expect(b.json.slug).toMatch(/^night-market-under-the-arches-/);
  });

  it('rejects bad input with clear codes', async () => {
    const u = await user();
    expect((await api('POST', '/popups', { user: u, body: popupBody({ lat: 48.85, lng: 2.35 }) })).json.error.code).toBe('outside_london');
    expect((await api('POST', '/popups', { user: u, body: popupBody({ end_at: NOW }) })).json.error.code).toBe('dates_invalid');
    expect((await api('POST', '/popups', { user: u, body: popupBody({ category: 'rave' }) })).json.error.code).toBe('category_invalid');
    expect((await api('POST', '/popups', { user: u, body: popupBody({ source_url: 'http://localhost/x' }) })).json.error.code).toBe('source_url_invalid');
  });

  it('lets a pop-up run for up to 180 days and says so when it is longer', async () => {
    const boss = await user({ role: 'admin' });
    // a big exhibition: 3 Oct 2026 to 31 Jan 2027 is 120 days
    const long = await api('POST', '/popups', { user: boss, body: popupBody({ title: 'Renoir and Love', category: 'exhibition', lat: 51.5089, lng: -0.1283, start_at: NOW, end_at: NOW + 120 * DAY }) });
    expect(long.status).toBe(201);
    const exact = await api('POST', '/popups', { user: boss, body: popupBody({ title: 'Half year installation', category: 'art', lat: 51.52, lng: -0.09, start_at: NOW, end_at: NOW + 180 * DAY }) });
    expect(exact.status).toBe(201);
    const tooLong = await api('POST', '/popups', { user: boss, body: popupBody({ title: 'Longer than half a year', category: 'art', lat: 51.53, lng: -0.1, start_at: NOW, end_at: NOW + 181 * DAY }) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.error.code).toBe('too_long');
    expect(tooLong.json.error.message).toContain('180 days');
  });

  it('accepts every category and names them all when one is wrong', async () => {
    const boss = await user({ role: 'admin' });
    for (const [i, category] of CATEGORIES.entries()) {
      const r = await api('POST', '/popups', { user: boss, body: popupBody({ title: `Category check ${category} ${i}`, category, lat: 51.45 + i * 0.02, lng: -0.2 + i * 0.02 }) });
      expect([category, r.status]).toEqual([category, 201]);
    }
    const bad = await api('POST', '/popups', { user: boss, body: popupBody({ category: 'rave' }) });
    expect(bad.json.error.code).toBe('category_invalid');
    for (const c of CATEGORIES) expect(bad.json.error.message).toContain(c);
  });

  it('flags likely duplicates unless forced', async () => {
    const u = await user(), v = await user();
    await api('POST', '/popups', { user: u, body: popupBody({ title: 'Matcha Lab Pop-up', ...SOHO }) });
    const dupe = await api('POST', '/popups', { user: v, body: popupBody({ title: 'Matcha Lab Soho', lat: 51.5134, lng: -0.1342 }) });
    expect(dupe.status).toBe(409);
    expect(dupe.json.error.code).toBe('possible_duplicate');
    expect(dupe.json.error.candidates[0].title).toBe('Matcha Lab Pop-up');
    const forced = await api('POST', '/popups', { user: v, body: popupBody({ title: 'Matcha Lab Soho', lat: 51.5134, lng: -0.1342, force: true }) });
    expect(forced.status).toBe(201);
  });

  it('limits new accounts to 3 posts a day', async () => {
    const u = await user({ ageDays: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await api('POST', '/popups', { user: u, body: popupBody({ title: `Stall number ${['one', 'two', 'three'][i]}`, lat: 51.5 + i * 0.01 }) })).status).toBe(201);
    }
    const r = await api('POST', '/popups', { user: u, body: popupBody({ title: 'Stall number four', lat: 51.55 }) });
    expect(r.status).toBe(429);
  });
});

describe('community verification', () => {
  it('verifies after enough weighted votes and rewards the poster', async () => {
    const poster = await user();
    const p = (await api('POST', '/popups', { user: poster, body: popupBody({ title: 'Supper club in a railway arch', lat: 51.49, lng: -0.08 }) })).json;
    expect(p.status).toBe('community');
    const before = await karmaOf(poster);
    const voters = await Promise.all([1, 2, 3, 4].map(() => user()));
    let last: any;
    for (const [i, v] of voters.entries()) {
      last = await api('PUT', `/popups/${p.id}/vote`, { user: v, ip: `10.0.0.${i}`, body: { kind: 'existence', value: 1 } });
      expect(last.status).toBe(200);
    }
    expect(last.json.popup.status).toBe('community'); // not started: needs 5 voters
    last = await api('PUT', `/popups/${p.id}/vote`, { user: await user(), ip: '10.0.0.9', body: { kind: 'existence', value: 1 } });
    expect(last.json.status_change).toEqual({ from: 'community', to: 'verified_community' });
    expect(await karmaOf(poster)).toBe(before + 10);
  });

  it('counts several accounts on one IP as one vote', async () => {
    const p = (await api('POST', '/popups', { user: await user(), body: popupBody({ title: 'Riso print open day', lat: 51.5455, lng: -0.0555 }) })).json;
    for (let i = 0; i < 3; i++) await api('PUT', `/popups/${p.id}/vote`, { user: await user(), ip: '192.0.2.1', body: { kind: 'existence', value: 1 } });
    const d = await api('GET', `/popups/${p.id}`);
    expect(d.json.verification.voters).toBe(1);
  });

  it('ignores votes from day-old accounts and blocks voting on your own post', async () => {
    const poster = await user();
    const p = (await api('POST', '/popups', { user: poster, body: popupBody({ title: 'Ceramics seconds sale', lat: 51.4735, lng: -0.069 }) })).json;
    await api('PUT', `/popups/${p.id}/vote`, { user: await user({ ageDays: 0.5 }), body: { kind: 'existence', value: 1 } });
    expect((await api('GET', `/popups/${p.id}`)).json.verification.weighted_votes).toBe(0);
    expect((await api('PUT', `/popups/${p.id}/vote`, { user: poster, body: { kind: 'existence', value: 1 } })).status).toBe(403);
  });

  it('hides a pop-up the community says is fake', async () => {
    const p = (await api('POST', '/popups', { user: await user(), body: popupBody({ title: 'Sneaker raffle store', lat: 51.5125, lng: -0.1235 }) })).json;
    let r: any;
    for (let i = 0; i < 3; i++) r = await api('PUT', `/popups/${p.id}/vote`, { user: await user({ karma: 200 }), ip: `10.1.0.${i}`, body: { kind: 'existence', value: -1 } });
    expect(r.json.popup.status).toBe('hidden');
    expect((await api('GET', `/popups/${p.id}`)).status).toBe(404); // hidden from the public
  });
});

describe('check-ins', () => {
  it('only counts check-ins within 200 m while the pop-up is open', async () => {
    const p = (await api('POST', '/popups', { user: await user(), body: popupBody({ title: 'Matcha tasting bar', ...SOHO, start_at: NOW - DAY, end_at: NOW + DAY }) })).json;
    const near = await user(), far = await user();
    const ok = await api('POST', `/popups/${p.id}/checkin`, { user: near, body: { lat: 51.5136, lng: -0.1342 } });
    expect(ok.status).toBe(200);
    expect(ok.json.valid).toBe(true);
    expect(ok.json.karma_awarded).toBe(2);
    // one check-in while live is enough evidence, and its 3x weight clears the bar on its own
    expect(ok.json.status_change).toEqual({ from: 'community', to: 'verified_community' });
    const bad = await api('POST', `/popups/${p.id}/checkin`, { user: far, body: { lat: 51.5262, lng: -0.078 } });
    // too far is a normal answer, not an error: the page shows its message
    expect(bad.status).toBe(200);
    expect(bad.json.valid).toBe(false);
    expect(bad.json.message).toMatch(/m away/);
    expect((await api('POST', `/popups/${p.id}/checkin`, { user: near, body: { lat: 51.5136, lng: -0.1342 } })).status).toBe(409);
  });

  it('refuses check-ins before the start', async () => {
    const p = (await api('POST', '/popups', { user: await user(), body: popupBody({ title: 'Board game takeover', lat: 51.5065, lng: -0.116 }) })).json;
    expect((await api('POST', `/popups/${p.id}/checkin`, { user: await user(), body: { lat: 51.5065, lng: -0.116 } })).json.error.code).toBe('not_live');
  });
});

describe('lists', () => {
  it('filters by window, category, verification and distance, and hides pending posts', async () => {
    const trusted = await user(), newbie = await user({ karma: 0, verifiedPosts: 0 });
    const boss = await user({ role: 'admin' });
    await api('POST', '/popups', { user: boss, body: popupBody({ title: 'Vintage kilo sale', category: 'fashion', lat: 51.4625, lng: -0.1145, start_at: NOW + 3 * DAY, end_at: NOW + 4 * DAY }) });
    await api('POST', '/popups', { user: trusted, body: popupBody({ title: 'Corn dog truck', category: 'food', lat: 51.5395, lng: -0.1435, start_at: NOW - HOUR, end_at: NOW + 7 * HOUR }) });
    await api('POST', '/popups', { user: newbie, body: popupBody({ title: 'Secret noodle bar', category: 'food', ...SOHO }) });

    const titles = async (q: string) => (await api('GET', `/popups?${q}`)).json.items.map((p: any) => p.title);
    expect(await titles('when=today')).toContain('Corn dog truck');
    expect(await titles('when=today')).not.toContain('Vintage kilo sale');
    expect(await titles('when=weekend')).toContain('Vintage kilo sale');
    expect(await titles('when=all&category=fashion')).toEqual(expect.arrayContaining(['Vintage kilo sale']));
    expect(await titles('when=all&category=fashion')).not.toContain('Corn dog truck');
    expect(await titles('when=all&verified=1')).not.toContain('Corn dog truck');
    expect(await titles('when=all')).not.toContain('Secret noodle bar');
    const near = (await api('GET', '/popups?when=all&near=51.4626,-0.1146&radius_km=1&sort=distance')).json.items;
    expect(near[0].title).toBe('Vintage kilo sale');
    expect(near[0].distance_m).toBeLessThan(50);
  });

  it('filters by several of the new categories at once', async () => {
    const boss = await user({ role: 'admin' });
    const make = (title: string, category: string, i: number) =>
      api('POST', '/popups', { user: boss, body: popupBody({ title, category, lat: 51.4 + i * 0.03, lng: -0.3 + i * 0.03 }) });
    await make('Zebra supper club', 'dining', 1);
    await make('Zebra gallery show', 'exhibition', 2);
    await make('Zebra street stall', 'food', 3);
    const titles = async (q: string) => (await api('GET', `/popups?${q}&q=Zebra`)).json.items.map((p: any) => p.title).sort();
    expect(await titles('when=all&category=dining,exhibition')).toEqual(['Zebra gallery show', 'Zebra supper club']);
    expect(await titles('when=all&category=food')).toEqual(['Zebra street stall']);
  });
});

describe('admin decisions', () => {
  it('removing a post costs the poster 20 karma and rewards reporters', async () => {
    const poster = await user(), reporter = await user(), boss = await user({ role: 'admin' });
    const p = (await api('POST', '/popups', { user: poster, body: popupBody({ title: 'Free iPhone giveaway', category: 'tech', lat: 51.51, lng: -0.12 }) })).json;
    expect((await api('POST', `/popups/${p.id}/report`, { user: reporter, body: { reason: 'spam' } })).status).toBe(201);
    const queue = (await api('GET', '/admin/queue', { user: boss })).json.items;
    expect(queue.find((q: any) => q.id === p.id)?.flags).toContain('reported'); // a 3.3x report reaches the queue
    expect((await api('GET', '/admin/queue', { user: reporter })).status).toBe(403);

    const kp = await karmaOf(poster), kr = await karmaOf(reporter);
    const r = await api('POST', `/admin/popups/${p.id}/decision`, { user: boss, body: { action: 'reject', reason: 'Scam' } });
    expect(r.json.status).toBe('removed');
    expect(await karmaOf(poster)).toBe(kp - 20);
    expect(await karmaOf(reporter)).toBe(kr + 3);
  });

  it('approving a pending post verifies it and pays the poster once', async () => {
    const poster = await user({ karma: 0, verifiedPosts: 0 }), boss = await user({ role: 'admin' });
    const p = (await api('POST', '/popups', { user: poster, body: popupBody({ title: 'Skate deck art show', category: 'art', lat: 51.5245, lng: -0.0765 }) })).json;
    expect(p.status).toBe('pending');
    expect((await api('GET', '/admin/queue', { user: boss })).json.items.some((q: any) => q.id === p.id)).toBe(true);
    await api('POST', `/admin/popups/${p.id}/decision`, { user: boss, body: { action: 'approve' } });
    await api('POST', `/admin/popups/${p.id}/decision`, { user: boss, body: { action: 'approve' } });
    expect(await karmaOf(poster)).toBe(10);
  });
});

describe('cron settlement', () => {
  it('ends past pop-ups and settles votes against the verdict', async () => {
    const poster = await user();
    const p = (await api('POST', '/popups', { user: poster, body: popupBody({ title: 'Mooncake bakery', category: 'food', lat: 51.5355, lng: -0.1245 }) })).json;
    const right = await Promise.all([1, 2, 3, 4, 5].map(() => user()));
    const wrong = await user({ karma: 5 });
    for (const [i, v] of right.entries()) await api('PUT', `/popups/${p.id}/vote`, { user: v, ip: `10.2.0.${i}`, body: { kind: 'existence', value: 1 } });
    await api('PUT', `/popups/${p.id}/vote`, { user: wrong, ip: '10.2.1.1', body: { kind: 'existence', value: -1 } });
    expect((await api('GET', `/popups/${p.id}`)).json.status).toBe('verified_community');

    const later = NOW + 4 * DAY;
    await endExpired(env.DB, later);
    expect((await api('GET', `/popups/${p.id}`, { now: later })).json.status).toBe('ended');
    const k1 = await karmaOf(right[0]), k2 = await karmaOf(wrong);
    await settleKarma(env.DB, later);
    await settleKarma(env.DB, later); // idempotent
    expect(await karmaOf(right[0])).toBe(k1 + 1);
    expect(await karmaOf(wrong)).toBe(k2 - 2);
  });
});

describe('AI autofill', () => {
  const answer = { title: 'Kimchi Club pop-up', host: 'Kimchi Club', category: 'food', address: '12 Rivington Street, EC2A 3DU',
    start_date: '2026-10-03', end_date: '2026-10-04', hours_text: 'Sat and Sun 12:00 to 18:00', price_text: 'Plates from £8', description: null, unsure: ['end_date'] };

  it('reads pasted post text with the text model', async () => {
    const run = vi.spyOn(env.AI, 'run').mockResolvedValue({ response: answer } as never);
    const r = await api('POST', '/extract', { user: await user(), body: { text: 'Kimchi Club takes over Rivington St this weekend! Sat+Sun 12-6' } });
    expect(r.status).toBe(200);
    expect(r.json.fields).toMatchObject({ title: 'Kimchi Club pop-up', category: 'food', start_date: '2026-10-03', end_date: '2026-10-04' });
    expect(r.json.fields.confidence).toMatchObject({ title: 'high', end_date: 'check' });
    expect(r.json.fields.source).toEqual(['llm_text']);
    expect(run.mock.calls[0][0]).toBe(env.AI_TEXT_MODEL);
  });

  it('reads a screenshot with the vision model', async () => {
    const run = vi.spyOn(env.AI, 'run').mockResolvedValue({ response: JSON.stringify(answer) } as never);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const res = await exports.default.fetch(new Request('http://spotted.test/api/v1/extract/image', {
      method: 'POST', headers: { 'x-now': String(NOW), 'x-dev-user': await user(), 'content-type': 'image/png' }, body: png,
    }));
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.fields).toMatchObject({ title: 'Kimchi Club pop-up', address: '12 Rivington Street, EC2A 3DU' });
    expect(json.fields.source).toEqual(['llm_vision']);
    const [model, input] = run.mock.calls[0] as unknown as [string, { messages: { content: unknown }[] }];
    expect(model).toBe(env.AI_VISION_MODEL);
    expect(JSON.stringify(input.messages[1].content)).toContain('data:image/png;base64,iVBORw0KGgoBAgM=');
  });

  it('refuses files that are not images and explains an empty result', async () => {
    const send = async (type: string, body: BodyInit) => {
      const res = await exports.default.fetch(new Request('http://spotted.test/api/v1/extract/image', {
        method: 'POST', headers: { 'x-now': String(NOW), 'x-dev-user': await user(), 'content-type': type }, body,
      }));
      return { status: res.status, json: (await res.json()) as any };
    };
    expect((await send('application/pdf', 'x')).status).toBe(415);
    vi.spyOn(env.AI, 'run').mockResolvedValue({ response: { title: null, unsure: [] } } as never);
    const r = await send('image/jpeg', new Uint8Array([255, 216, 255]));
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('unreadable_image');
  });

  it('says so when the daily AI allowance is used up', async () => {
    vi.spyOn(env.AI, 'run').mockRejectedValue(new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons'));
    const r = await api('POST', '/extract', { user: await user(), body: { text: 'Some pop-up this Saturday in Hackney' } });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('ai_quota');
  });
});

describe('link autofill', () => {
  it('fills fields from Event JSON-LD and caches the result', async () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Event","name":"Autumn Flower Market",
      "startDate":"2026-10-04T08:00:00+01:00","endDate":"2026-10-04T14:00:00+01:00",
      "location":{"name":"Columbia Road","address":{"addressLocality":"London"}},"offers":{"price":"0"}}</script></head></html>`;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    const u = await user();
    const r = await api('POST', '/extract', { user: u, body: { url: 'https://www.eventbrite.co.uk/e/autumn-flower-market' } });
    expect(r.status).toBe(200);
    expect(r.json.platform).toBe('eventbrite');
    expect(r.json.fields).toMatchObject({ title: 'Autumn Flower Market', start_date: '2026-10-04', category: 'market', price_text: 'Free' });
    expect(r.json.fields.confidence.title).toBe('high');
    const again = await api('POST', '/extract', { user: u, body: { url: 'https://www.eventbrite.co.uk/e/autumn-flower-market' } });
    expect(again.json.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('explains what to do when a site blocks us', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('login', { status: 403, headers: { 'content-type': 'text/html' } }));
    const r = await api('POST', '/extract', { user: await user(), body: { url: 'instagram.com/p/abc' } });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('unreadable_link');
  });

  it('refuses private addresses and rate-limits new accounts', async () => {
    const u = await user({ ageDays: 3 });
    expect((await api('POST', '/extract', { user: u, body: { url: 'http://127.0.0.1/' } })).json.error.code).toBe('url_invalid');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<title>x</title>', { headers: { 'content-type': 'text/html' } }));
    // the invalid link above did not use up quota
    for (let i = 0; i < 3; i++) expect((await api('POST', '/extract', { user: u, body: { url: `https://example.com/${i}` } })).status).toBe(200);
    expect((await api('POST', '/extract', { user: u, body: { url: 'https://example.com/9' } })).status).toBe(429);
  });
});
