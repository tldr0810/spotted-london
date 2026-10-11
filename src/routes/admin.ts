import { Hono } from 'hono';
import type { AppEnv, PopupRow } from '../types';
import { requireAdmin } from '../middleware';
import { ApiError, bad, newId } from '../lib/util';
import { jsonBody, num, oneOf, text } from '../lib/validate';
import { KARMA, type Status } from '../lib/scoring';
import { onStatusChange, recompute, toPublic } from '../db/popups';
import { awardKarma } from '../db/karma';
import { FLAGGING_VERDICTS, isReady, publishReady } from '../db/publish';
import { entersOrLeavesPublic, rebuildSnapshotSoon } from '../db/snapshot';
import { cleanTags, formatTagColumn, MAX_TAGS, TAGS } from '../shared/tags';

export const admin = new Hono<AppEnv>();


/**
 * Pending posts, community-hidden posts, and public posts with open reports or a problem
 * flagged by an agent (SPEC §3.7, §13.4).
 */
admin.get('/queue', async c => {
  requireAdmin(c);
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, u.display_name AS poster_name, u.karma AS poster_karma, u.created_at AS poster_created_at,
       (SELECT COUNT(*) FROM reports r WHERE r.popup_id = p.id AND r.resolution IS NULL) AS open_reports
     FROM popups p JOIN users u ON u.id = p.created_by
     WHERE p.status IN ('pending', 'hidden')
        OR (p.status IN ('community', 'verified_community', 'verified_admin') AND p.report_weight >= 3)
        OR (p.status IN ('community', 'verified_community', 'verified_admin') AND EXISTS (
          SELECT 1 FROM agent_notes n WHERE n.popup_id = p.id AND n.resolved_at IS NULL AND n.verdict IN (${FLAGGING_VERDICTS.map(() => '?').join(',')})))
     ORDER BY CASE p.status WHEN 'hidden' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, p.created_at
     LIMIT 100`,
  ).bind(...FLAGGING_VERDICTS).all<PopupRow & { poster_name: string | null; poster_karma: number; poster_created_at: number; open_reports: number }>();
  const now = c.get('now');
  const notes = await openNotes(c.env.DB, results.map(p => p.id));
  return c.json({
    items: results.map(p => toPublic(p, {
      poster: { id: p.created_by, name: p.poster_name, karma: p.poster_karma, account_age_days: Math.floor((now - p.poster_created_at) / 86_400_000) },
      open_reports: p.open_reports,
      agent_notes: notes.filter(n => n.popup_id === p.id).map(({ popup_id: _, publish_ready, ...n }) => ({ ...n, publish_ready: !!publish_ready })),
      ready_to_publish: p.status === 'pending' && isReady(notes.filter(n => n.popup_id === p.id)),
      flags: [
        p.created_by.startsWith('agent_') && 'by_agent',
        !p.source_url && 'no_source_link',
        now - p.poster_created_at < 86_400_000 && !p.created_by.startsWith('agent_') && 'new_account',
        p.report_weight >= 3 && 'reported',
        p.status === 'hidden' && 'community_hidden',
      ].filter(Boolean),
    })),
  });
});

/**
 * Publishes the posts agents marked ready, as 'community' so votes and reports still apply, and writes an
 * audit row for each naming the agents behind it. The conditions are checked again here.
 */
admin.post('/queue/publish-ready', async c => {
  const a = requireAdmin(c);
  const now = c.get('now');
  const db = c.env.DB;
  const b = await jsonBody(c.req);
  const only = Array.isArray(b.ids) ? b.ids.filter((id): id is string => typeof id === 'string').slice(0, 100) : null;
  const { results } = await db.prepare("SELECT id FROM popups WHERE status = 'pending' AND end_at > ? ORDER BY created_at LIMIT 200").bind(now).all<{ id: string }>();
  let published = 0;
  for (const p of results) {
    if (only && !only.includes(p.id)) continue;
    if (await publishReady(db, p.id, a.id, 'batch', now)) published += 1;
  }
  if (published) rebuildSnapshotSoon(c);
  return c.json({ published });
});

const ACTIONS = ['approve', 'reject', 'hide', 'restore', 'merge'] as const;

admin.post('/popups/:id/decision', async c => {
  const a = requireAdmin(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const action = oneOf(b, 'action', ACTIONS, { required: true })!;
  const reason = text(b, 'reason', { max: 500 });
  const db = c.env.DB;
  const p = await db.prepare('SELECT * FROM popups WHERE id = ?').bind(c.req.param('id')).first<PopupRow>();
  if (!p) throw new ApiError(404, 'not_found', 'This pop-up does not exist.');

  let to: Status;
  let mergeInto: string | null = null;
  switch (action) {
    case 'approve': to = 'verified_admin'; break;
    case 'reject': to = 'removed'; break;
    case 'hide': to = 'hidden'; break;
    case 'restore': to = 'community'; break;
    case 'merge': {
      mergeInto = text(b, 'merge_into', { max: 40, required: true });
      if (mergeInto === p.id) throw bad('merge_invalid', 'A pop-up cannot be merged into itself.');
      const target = await db.prepare('SELECT id FROM popups WHERE id = ?').bind(mergeInto).first();
      if (!target) throw bad('merge_invalid', 'The pop-up to merge into does not exist.');
      to = 'removed';
      break;
    }
  }

  await db.prepare('UPDATE popups SET status = ?, merged_into = ?, updated_at = ? WHERE id = ?').bind(to, mergeInto, now, p.id).run();
  // A duplicate is not bad faith, so merging skips the removal penalty.
  if (action !== 'merge') await onStatusChange(db, p, to, now);
  if (action === 'merge') {
    await db.prepare('INSERT OR IGNORE INTO saves (user_id, popup_id, remind, created_at) SELECT user_id, ?, remind, created_at FROM saves WHERE popup_id = ?').bind(mergeInto, p.id).run();
  }
  if (action === 'approve' || action === 'reject') await resolveReports(db, p.id, action === 'reject' ? 'upheld' : 'rejected', now);
  if (action === 'restore') await recompute(db, p.id, now);
  // The admin has now looked at this pop-up, so agent notes on it are done.
  await db.prepare('UPDATE agent_notes SET resolved_at = ? WHERE popup_id = ? AND resolved_at IS NULL').bind(now, p.id).run();

  await audit(db, a.id, `popup.${action}`, 'popup', p.id, { reason, merge_into: mergeInto, from: p.status, to }, now);
  const after = await db.prepare('SELECT * FROM popups WHERE id = ?').bind(p.id).first<PopupRow>();
  rebuildSnapshotSoon(c); // hide, remove, approve, restore and merge all change what the public list holds
  return c.json(toPublic(after!));
});

type NoteRow = { id: string; popup_id: string; agent_id: string; agent_name: string | null; verdict: string; note: string; evidence_url: string | null; evidence: string | null; publish_ready: number; duplicate_of: string | null; created_at: number };

async function openNotes(db: D1Database, ids: string[]): Promise<NoteRow[]> {
  if (!ids.length) return [];
  const { results } = await db.prepare(
    `SELECT n.id, n.popup_id, n.agent_id, a.name AS agent_name, n.verdict, n.note, n.evidence_url, n.evidence, n.publish_ready, n.duplicate_of, n.created_at
     FROM agent_notes n LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.resolved_at IS NULL AND n.popup_id IN (${ids.map(() => '?').join(',')}) ORDER BY n.created_at DESC`,
  ).bind(...ids).all<NoteRow>();
  return results;
}

async function resolveReports(db: D1Database, popupId: string, resolution: 'upheld' | 'rejected', now: number) {
  const { results } = await db.prepare('SELECT id, user_id FROM reports WHERE popup_id = ? AND resolution IS NULL').bind(popupId).all<{ id: string; user_id: string }>();
  for (const r of results) {
    await db.prepare('UPDATE reports SET resolution = ? WHERE id = ?').bind(resolution, r.id).run();
    await awardKarma(db, r.user_id, resolution === 'upheld' ? KARMA.reportUpheld : KARMA.reportRejected, `report_${resolution}`, r.id, now);
  }
  if (results.length) await db.prepare('UPDATE popups SET report_weight = 0 WHERE id = ?').bind(popupId).run();
}

/**
 * Sets or clears a pop-up's tags (the one way a person overrides what an agent tagged). `tags: null` puts it back to
 * "nobody has looked yet", `[]` says none apply. Anything that is not on the list is refused, not skipped.
 */
/**
 * Photos that have no small copy yet, for the admin's browser to make (see PUT /popups/:id/images/:imageId/thumb).
 * `after` is the last id seen, so a photo that cannot be decoded is passed over, not asked for again.
 * `left` (how many are missing in all) comes with the first page only.
 */
admin.get('/images/needing-thumbs', async c => {
  requireAdmin(c);
  const after = c.req.query('after') ?? '';
  const limit = Math.min(10, Math.max(1, Number(c.req.query('limit')) || 4));
  const { results } = await c.env.DB.prepare('SELECT id, popup_id, r2_key FROM popup_images WHERE thumb_key IS NULL AND id > ? ORDER BY id LIMIT ?')
    .bind(after, limit).all<{ id: string; popup_id: string; r2_key: string }>();
  const left = after ? null : (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM popup_images WHERE thumb_key IS NULL').first<{ n: number }>())?.n ?? 0;
  return c.json({
    items: results.map(r => ({ id: r.id, popup_id: r.popup_id, url: `/api/v1/images/${r.r2_key}` })),
    next: results.length === limit ? results[results.length - 1].id : null,
    left,
  });
});

admin.put('/popups/:id/tags', async c => {
  const a = requireAdmin(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  if (!('tags' in b) || (b.tags !== null && !Array.isArray(b.tags))) throw bad('tags_invalid', 'Send tags as a list, or null to mark it as not looked at yet.');
  const next = b.tags === null ? null : cleanTags(b.tags);
  if (next && next.dropped.length) throw bad('tags_invalid', `Not a tag, or more than ${MAX_TAGS}: ${next.dropped.join(', ')}. Tags: ${TAGS.join(', ')}.`);
  const db = c.env.DB;
  const p = await db.prepare('SELECT id, status, tags FROM popups WHERE id = ?').bind(c.req.param('id')).first<Pick<PopupRow, 'id' | 'status' | 'tags'>>();
  if (!p) throw new ApiError(404, 'not_found', 'There is no pop-up with that id.');
  const value = next ? formatTagColumn(next.tags) : null;
  await db.prepare('UPDATE popups SET tags = ?, updated_at = ? WHERE id = ?').bind(value, now, p.id).run();
  await audit(db, a.id, 'popup.tags_set', 'popup', p.id, { from: p.tags ?? null, to: value }, now);
  if (['community', 'verified_community', 'verified_admin'].includes(p.status)) rebuildSnapshotSoon(c);
  return c.json({ id: p.id, tags: next ? next.tags : null });
});

admin.post('/reports/:id/resolve', async c => {
  const a = requireAdmin(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const resolution = oneOf(b, 'resolution', ['upheld', 'rejected'] as const, { required: true })!;
  const db = c.env.DB;
  const r = await db.prepare('SELECT * FROM reports WHERE id = ?').bind(c.req.param('id')).first<{ id: string; user_id: string; popup_id: string; resolution: string | null }>();
  if (!r) throw new ApiError(404, 'not_found', 'This report does not exist.');
  if (r.resolution) throw new ApiError(409, 'already_resolved', 'This report is already resolved.');
  await db.prepare('UPDATE reports SET resolution = ? WHERE id = ?').bind(resolution, r.id).run();
  await awardKarma(db, r.user_id, resolution === 'upheld' ? KARMA.reportUpheld : KARMA.reportRejected, `report_${resolution}`, r.id, now);
  if (entersOrLeavesPublic(await recompute(db, r.popup_id, now))) rebuildSnapshotSoon(c);
  await audit(db, a.id, `report.${resolution}`, 'report', r.id, null, now);
  return c.json({ ok: true });
});

admin.post('/users/:id/action', async c => {
  const a = requireAdmin(c);
  const now = c.get('now');
  const b = await jsonBody(c.req);
  const action = oneOf(b, 'action', ['shadowban', 'ban', 'unban', 'adjust_karma'] as const, { required: true })!;
  const db = c.env.DB;
  const id = c.req.param('id');
  if (id === a.id) throw bad('self_action', 'You cannot do this to your own account.');
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!target) throw new ApiError(404, 'not_found', 'This user does not exist.');
  if (action === 'adjust_karma') {
    const delta = num(b, 'delta', { required: true, min: -1000, max: 1000 })!;
    await db.batch([
      db.prepare('INSERT INTO karma_log (id, user_id, delta, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), id, Math.round(delta), 'admin_adjust', newId(), now),
      db.prepare('UPDATE users SET karma = karma + ? WHERE id = ?').bind(Math.round(delta), id),
    ]);
  } else {
    const status = action === 'unban' ? 'active' : action === 'ban' ? 'banned' : 'shadowbanned';
    await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, id).run();
    if (action === 'ban') await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  await audit(db, a.id, `user.${action}`, 'user', id, b, now);
  return c.json({ ok: true });
});

export async function audit(db: D1Database, adminId: string, action: string, type: string, target: string, detail: unknown, now: number) {
  await db.prepare('INSERT INTO audit_log (id, admin_id, action, target_type, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), adminId, action, type, target, detail ? JSON.stringify(detail) : null, now).run();
}
