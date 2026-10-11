// The public pop-up list as one row in D1 (table `snapshots`, key 'popups'), so a reader costs one row read
// however many pop-ups there are. Built by cron every 10 minutes and straight away when a pop-up enters or
// leaves the public set. The browser filters it with src/shared/filter-popups.ts.

import type { Context } from 'hono';
import type { AppEnv, PopupRow } from '../types';
import { DAY, hot, PUBLIC_STATUSES, type Status } from '../lib/scoring';
import { sha256 } from '../lib/util';
import { SOURCE_CHECKED_SQL, toPublic } from './popups';

/**
 * D1 allows about 2 MB in a row, so a list bigger than CHUNK_BYTES is stored as several rows: 'popups' holds the
 * first run of pop-ups and 'popups.01', 'popups.02' ... the next ones. A list that fits in one row is stored whole,
 * exactly as it always was. Readers get all the rows in one statement and put the pieces together as text, with no
 * JSON.parse (the Worker has about 10 ms of CPU).
 */
const CHUNK_BYTES = 900_000;
/** Past this the snapshot is not stored (the old one stays). The browser reads the whole list, so this is also about as far as a phone can go. */
export const MAX_SNAPSHOT_BYTES = 6_000_000;
/** The /admin/agent page warns from here: the download and the parse start to be felt on a phone (about 3,700 pop-ups). */
export const SNAPSHOT_WARN_BYTES = 3_000_000;
/** The list holds pop-ups that start within this long from now. How long one may run (MAX_DURATION) is a separate limit. */
const HORIZON = 90 * DAY;

/**
 * Every public pop-up that has not ended, as the list shows it: no `me`, no poster, no photos, no description.
 * `hot` is worked out here from the current time, so it does not depend on the stored column.
 */
export async function loadSnapshotItems(db: D1Database, now: number) {
  const { results } = await db.prepare(
    `SELECT *, (SELECT COALESCE(i.thumb_key, i.r2_key) FROM popup_images i WHERE i.popup_id = popups.id ORDER BY position LIMIT 1) AS cover_key,
       ${SOURCE_CHECKED_SQL}
     FROM popups WHERE status IN (${PUBLIC_STATUSES.map(() => '?').join(',')}) AND end_at > ? AND start_at < ? ORDER BY id`,
  ).bind(...PUBLIC_STATUSES, now, now + HORIZON).all<PopupRow & { cover_key: string | null; source_checked: number }>();
  return results.map(p => ({
    ...toPublic(p),
    description: null as string | null,
    hot: hot({ status: p.status, qualityPos: p.quality_pos, qualityNeg: p.quality_neg, startAt: p.start_at, endAt: p.end_at }, now),
  }));
}

export interface BuiltSnapshot { written: boolean; count: number; bytes: number; json: string; version: string }

const rowKey = (i: number) => (i === 0 ? 'popups' : `popups.${String(i).padStart(2, '0')}`);

/** The stored rows, as text: one row is the whole list, several are runs of pop-ups joined with commas. */
const joinRows = (rows: string[]) => (rows.length === 1 ? rows[0] : `{"items":[${rows.join(',')}]}`);

/** The pop-ups (each already JSON) in runs of at most CHUNK_BYTES, cut between two pop-ups. */
function chunkParts(parts: string[], chunkBytes: number): string[] {
  const enc = new TextEncoder();
  const runs: string[] = [];
  let cur: string[] = [], size = 0;
  for (const part of parts) {
    const n = enc.encode(part).length + 1;
    if (cur.length && size + n > chunkBytes) { runs.push(cur.join(',')); cur = []; size = 0; }
    cur.push(part); size += n;
  }
  if (cur.length) runs.push(cur.join(','));
  return runs;
}

/** Builds the snapshot and stores it. Too big to store: logs it, keeps the old rows and still returns the build. */
export async function buildPopupSnapshot(db: D1Database, now: number, maxBytes = MAX_SNAPSHOT_BYTES, chunkBytes = CHUNK_BYTES): Promise<BuiltSnapshot> {
  const items = await loadSnapshotItems(db, now);
  const parts = items.map(p => JSON.stringify(p));
  const json = `{"items":[${parts.join(',')}]}`; // the same text as JSON.stringify({ items })
  const bytes = new TextEncoder().encode(json).length;
  const version = (await sha256(json)).slice(0, 16);
  if (bytes > maxBytes) {
    console.error(`popup snapshot is ${bytes} bytes (limit ${maxBytes}) with ${items.length} pop-ups: not stored. Make each pop-up smaller or shorten the time window.`);
    return { written: false, count: items.length, bytes, json, version };
  }
  const rows = bytes <= chunkBytes ? [json] : chunkParts(parts, chunkBytes);
  // One batch is one transaction: a reader sees the old rows or the new ones, never a mix. Rows left over from a longer list go.
  await db.batch([
    ...rows.map((text, i) => db.prepare(
      `INSERT INTO snapshots (key, version, json, built_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET version = excluded.version, json = excluded.json, built_at = excluded.built_at`,
    ).bind(rowKey(i), version, text, now)),
    db.prepare("DELETE FROM snapshots WHERE key LIKE 'popups.%' AND key > ?").bind(rowKey(rows.length - 1)),
  ]);
  return { written: true, count: items.length, bytes, json, version };
}

/** The stored list as text, with its version: all the rows in one statement, so they always belong together. Null when nothing is stored. */
export async function readSnapshot(db: D1Database): Promise<{ version: string; json: string } | null> {
  const { results } = await db.prepare("SELECT key, version, json FROM snapshots WHERE key = 'popups' OR key LIKE 'popups.%' ORDER BY key")
    .all<{ key: string; version: string; json: string }>();
  const head = results[0];
  if (!head || head.key !== 'popups') return null;
  return { version: head.version, json: joinRows(results.filter(r => r.version === head.version).map(r => r.json)) };
}

/** How big the stored list is, for the admin page. */
export async function snapshotStats(db: D1Database): Promise<{ bytes: number; built_at: number | null; warn_bytes: number; max_bytes: number }> {
  const r = await db.prepare("SELECT SUM(LENGTH(CAST(json AS BLOB))) AS bytes, MAX(built_at) AS built_at FROM snapshots WHERE key = 'popups' OR key LIKE 'popups.%'")
    .first<{ bytes: number | null; built_at: number | null }>();
  return { bytes: r?.bytes ?? 0, built_at: r?.built_at ?? null, warn_bytes: SNAPSHOT_WARN_BYTES, max_bytes: MAX_SNAPSHOT_BYTES };
}

export type SnapshotItem = Awaited<ReturnType<typeof loadSnapshotItems>>[number];

let memo: { version: string; items: SnapshotItem[] } | null = null;

/**
 * The public list as objects, for server code that would otherwise scan the popups table (the MCP search tool).
 * It costs one small row read per call; the stored JSON is read and parsed (about 1 ms for 350 KB) only when the
 * snapshot changed since this isolate last looked. Up to 10 minutes behind the database, like the Explore page.
 */
export async function snapshotItems(db: D1Database, now: number): Promise<SnapshotItem[]> {
  const head = await db.prepare("SELECT version FROM snapshots WHERE key = 'popups'").first<{ version: string }>();
  if (head && memo?.version === head.version) return memo.items;
  // Nothing stored yet, or it was too big to store: build one now.
  const row = head ? await readSnapshot(db) : null;
  const built = row ?? await buildPopupSnapshot(db, now);
  memo = { version: built.version, items: (JSON.parse(built.json) as { items: SnapshotItem[] }).items };
  return memo.items;
}

const isPublic = (s: Status) => PUBLIC_STATUSES.includes(s);

/** True when a status change moves a pop-up into or out of the public list. */
export const entersOrLeavesPublic = (change: { from: Status; to: Status } | null | undefined) => !!change && isPublic(change.from) !== isPublic(change.to);

/** Rebuilds after the response has gone out, so the request that caused it does not wait. */
export function rebuildSnapshotSoon(c: Pick<Context<AppEnv>, 'env' | 'get' | 'executionCtx'>) {
  const run = buildPopupSnapshot(c.env.DB, c.get('now')).catch(e => console.error('snapshot rebuild failed', e));
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try { ctx = c.executionCtx; } catch { /* no execution context (some tests): the build still runs */ }
  ctx?.waitUntil(run);
}
