import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { toPlace } from '../src/routes/geocode';

const NOW = Date.UTC(2026, 8, 30, 13);
const DAY = 86_400_000;

async function call(path: string, user?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('x-now', String(NOW));
  if (user) headers.set('x-dev-user', user);
  return exports.default.fetch(new Request(`http://spotted.test${path}`, { ...init, headers }));
}

let n = 0;
async function user() {
  const id = `w${++n}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare('INSERT INTO users (id, email, karma, verified_posts, email_verified, created_at) VALUES (?, ?, 58, 3, 1, ?)')
    .bind(id, `${id}@test.dev`, NOW - 60 * DAY).run();
  return id;
}
async function popup(u: string, over: Record<string, unknown> = {}) {
  const res = await call('/api/v1/popups', u, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `Test stall ${Math.random().toString(36).slice(2, 8)}`, category: 'market', lat: 51.53 + Math.random() / 50, lng: -0.07,
      start_at: NOW + DAY, end_at: NOW + 2 * DAY, source_url: 'https://example.com/x', description: 'Pumpkins <b>and</b> "cider"', ...over,
    }),
  });
  return (await res.json()) as { id: string; slug: string };
}

afterEach(() => vi.restoreAllMocks());

describe('lists for the app', () => {
  it('include the cover photo, and your state comes from /me/state', async () => {
    const poster = await user(), viewer = await user();
    const p = await popup(poster);
    const img = await call(`/api/v1/popups/${p.id}/images`, poster, { method: 'POST', headers: { 'content-type': 'image/webp' }, body: new Uint8Array([1, 2, 3]) });
    expect(img.status).toBe(201);
    await call(`/api/v1/popups/${p.id}/save`, viewer, { method: 'PUT' });

    const anon = (await (await call('/api/v1/popups?when=all&limit=50')).json()) as { items: any[] };
    const row = anon.items.find(i => i.id === p.id);
    expect(row.cover_url).toMatch(new RegExp(`^/api/v1/images/popups/${p.id}/`));
    expect(row.me).toBeUndefined();

    const mine = (await (await call('/api/v1/popups?when=all&limit=50', viewer)).json()) as { items: any[] };
    expect(mine.items.find(i => i.id === p.id).me).toBeUndefined();
    const state = (await (await call('/api/v1/me/state', viewer)).json()) as { saved: string[] };
    expect(state.saved).toContain(p.id);

    const served = await call(new URL(row.cover_url, 'http://x').pathname);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable'); // keys are never reused
  });
});

describe('share previews and SEO', () => {
  it('injects title, Open Graph and escaped Event JSON-LD into the app shell', async () => {
    const p = await popup(await user(), { title: 'Pumpkin </script> patch' });
    const res = await call(`/p/${p.slug}`);
    const html = await res.text();
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(html).toContain('<title>Pumpkin &lt;/script&gt; patch · Spotted London</title>');
    expect(html).toContain('<meta property="og:title" content="Pumpkin &lt;/script&gt; patch">');
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1];
    expect(ld).not.toContain('</script>');
    expect(JSON.parse(ld)).toMatchObject({ '@type': 'Event', name: 'Pumpkin </script> patch', location: { geo: { latitude: expect.any(Number) } } });
  });

  it('serves the plain shell for unknown or unreviewed pop-ups', async () => {
    const html = await (await call('/p/nope')).text();
    expect(html).not.toContain('og:title');
    const pending = await popup(await user(), { source_url: null });
    await env.DB.prepare("UPDATE popups SET status = 'pending' WHERE id = ?").bind(pending.id).run();
    expect(await (await call(`/p/${pending.slug}`)).text()).not.toContain('og:title');
  });
});

describe('address search', () => {
  const feature = (props: Record<string, string>, lng = -0.0712, lat = 51.5296) => ({ geometry: { coordinates: [lng, lat] }, properties: props });

  it('turns Photon results into short labels', () => {
    expect(toPlace(feature({ name: 'Columbia Road Flower Market', street: 'Elwin Street', district: 'Whitechapel', postcode: 'E2 7BU' } as never) as never))
      .toMatchObject({ label: 'Columbia Road Flower Market, Elwin Street, Whitechapel, E2 7BU', area: 'Whitechapel' });
    expect(toPlace(feature({ name: 'Old Compton Street', street: 'Old Compton Street', district: 'Soho', postcode: 'W1D 4JF' } as never) as never).name).toBeNull();
  });

  it('needs sign in, searches inside London only and drops results outside it', async () => {
    expect((await call('/api/v1/geocode?q=columbia')).status).toBe(401);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      features: [feature({ name: 'In London', district: 'Hackney' }), feature({ name: 'Paris' }, 2.35, 48.85)],
    }));
    const r = (await (await call('/api/v1/geocode?q=columbia%20road', await user())).json()) as { items: { name: string }[] };
    expect(r.items.map(i => i.name)).toEqual(['In London']);
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.host).toBe('photon.komoot.io');
    expect(url.searchParams.get('bbox')).toBe('-0.52,51.28,0.34,51.7');
  });
});

describe('sign-in options', () => {
  it('reports which providers are set up', async () => {
    expect(await (await call('/api/v1/auth/providers')).json()).toEqual({ email: true, google: true, photos: true, turnstile_site_key: null });
  });
});
