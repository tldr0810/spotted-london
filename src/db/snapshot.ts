// The public pop-up list as one row in D1 (table `snapshots`, key 'popups'), so a reader costs one row read
// however many pop-ups there are. Built by cron every 10 minutes and straight away when a pop-up enters or
// leaves the public set. The browser filters it with src/shared/filter-popups.ts.

import type { Context } from 'hono';
import type { AppEnv, PopupRow } from '../types';
import { DAY, hot, PUBLIC_STATUSES, type Status } from '../lib/scoring';
import { sha256 } from '../lib/util';
import { SOURCE_CHECKED_SQL, toPublic } from './popups';

/** D1 allows about 2 MB in a row. Past this the snapshot is not stored and readers get a fresh build. */
export const MAX_SNAPSHOT_BYTES = 1_500_000;
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

/** Builds the snapshot and stores it. Too big to store: logs it, keeps the old row and still returns the build. */
export async function buildPopupSnapshot(db: D1Database, now: number, maxBytes = MAX_SNAPSHOT_BYTES): Promise<BuiltSnapshot> {
  const items = await loadSnapshotItems(db, now);
  const json = JSON.stringify({ items });
  const bytes = new TextEncoder().encode(json).length;
  const version = (await sha256(json)).slice(0, 16);
  if (bytes > maxBytes) {
    console.error(`popup snapshot is ${bytes} bytes (limit ${maxBytes}) with ${items.length} pop-ups: not stored. Split it by window or borough.`);
    return { written: false, count: items.length, bytes, json, version };
  }
  await db.prepare(
    `INSERT INTO snapshots (key, version, json, built_at) VALUES ('popups', ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET version = excluded.version, json = excluded.json, built_at = excluded.built_at`,
  ).bind(version, json, now).run();
  return { written: true, count: items.length, bytes, json, version };
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
  const row = head ? await db.prepare("SELECT version, json FROM snapshots WHERE key = 'popups'").first<{ version: string; json: string }>() : null;
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
