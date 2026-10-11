// Typed client for /api/v1. Errors keep the server's stable `code` and readable `message`.

import type { Category } from '../../../src/shared/categories';
import type { Tag } from '../../../src/shared/tags';
export type { Category, Tag };
export type Status = 'pending' | 'community' | 'verified_community' | 'verified_admin' | 'hidden' | 'removed' | 'ended';
export type When = 'today' | 'weekend' | 'week' | 'all';

export interface MyState { saved: boolean; existence_vote: number; quality_vote: number; vote_weight?: number }
export type { MyStateMap } from '../../../src/shared/my-state';

export interface Popup {
  id: string; slug: string; title: string; host: string | null; description: string | null; category: Category;
  /** What the page states (interactive, late night...). Null: nobody has tagged it yet. */
  tags?: Tag[] | null;
  price: { type: string | null; text: string | null };
  location: { address: string | null; borough: string | null; lat: number; lng: number };
  start_at: number; end_at: number; hours_text: string | null; source_url: string | null; status: Status;
  verification: { confidence: number; weighted_votes: number; voters: number; checkins: number };
  score: number; hot: number; cover_url: string | null; created_at: number; example?: boolean;
  /** An agent confirmed the post against its source. Shown as "Source checked"; status still comes from votes. */
  source_checked?: boolean;
  distance_m?: number;
  me?: MyState | null;
  images?: { id: string; url: string; credit?: string | null; credit_url?: string | null }[];
  posted_by?: { id: string; name: string | null; karma: number } | null;
}

export interface Me {
  id: string; email: string; name: string | null; role: 'user' | 'organizer' | 'admin';
  karma: number; trust: number; vote_weight: number; verified_posts: number; created_at: number;
}

export interface Extracted {
  title: string | null; host: string | null; category: Category | null; address: string | null;
  start_date: string | null; end_date: string | null; hours_text: string | null; price_text: string | null;
  description: string | null; image_url: string | null;
  confidence: Partial<Record<string, 'high' | 'check'>>;
  source: string[];
}

export interface Place { label: string; name: string | null; address: string; area: string | null; lat: number; lng: number }

export type Schedule = 'hourly' | 'every_6h' | 'daily' | 'weekly' | 'manual';
export interface AgentRun { id: string; via?: string | null; trigger: 'schedule' | 'manual'; status: 'running' | 'done' | 'failed'; summary: string | null; error: string | null; items: number; started_at: number; finished_at: number | null }
export interface Agent {
  id: string; role: 'scout' | 'triage' | 'checker' | 'concierge'; name: string; job: string; unit: string;
  enabled: boolean; manyfold_scheduled: boolean; schedule: Schedule; run_hour: number; instructions: string | null; max_items: number;
  rpc_url: string | null; token_hint: string | null; key_hint: string | null; connected: boolean; next_run_at: number | null;
  open_notes: number; runs: AgentRun[]; published: { published: number; undone: number; hidden_after: number };
}
export interface AskStats { today: number; cap: number; per_visitor: number; failed_today: number; last_error: string | null }
export interface TagReport {
  coverage: { live: number; tagged: number; none_apply: number; not_looked_at: number };
  uses: { tag: Tag; n: number; share: number }[];
  changes: { agent: string; role: string; edits: number; added: number; removed: number }[];
  samples: { id: string; slug: string; title: string; tags: Tag[]; source_url: string | null }[];
}
export interface AgentsView { mcp_url: string; skill_url: string; agents_key_set: boolean; auto_publish: 'suggest' | 'auto'; ask: AskStats | null; public_list: { bytes: number; built_at: number | null; warn_bytes: number; max_bytes: number }; roles: { role: Agent['role']; name: string }[]; agents: Agent[] }
export type SourceKind = 'listing' | 'venue' | 'brand' | 'social' | 'search';
export type SourceStatus = 'active' | 'suggested' | 'paused' | 'rejected';
export interface SocialFetch {
  mode: string | null; fetchable: boolean; new_posts: number;
  last_run: { status: 'running' | 'done' | 'failed' | 'skipped_budget'; at: number; items: number; kept: number; cost_usd: number; error: string | null } | null;
}
export interface ApifySummary { configured: boolean; spent_usd: number; cap_usd: number }
export interface ScoutSource {
  id: string; kind: SourceKind; target: string; label: string; status: SourceStatus; every_days: number; note: string | null;
  suggested_by_run: string | null; last_checked_at: number | null; due_at: number | null; created_at: number;
  track_record: { drafts: number; published: number; rejected: number; waiting: number };
  fetch?: SocialFetch;
}
export interface AgentNote { id: string; agent_id: string; agent_name?: string | null; evidence?: string | null; publish_ready?: boolean; verdict: string; note: string; evidence_url: string | null; duplicate_of: string | null; created_at: number }

/** Ask for recommendations (src/routes/ask.ts). */
export interface AskStatus { available: boolean; resting: boolean; per_visitor: number; left: number; max_chars: number; needs_bot_check: boolean; turnstile_site_key: string | null }
export interface AskPick { id: string; slug: string; title: string; reason: string }
export type AskView =
  | { id: string; status: 'pending'; left?: number; elapsed_ms: number; poll_ms: number }
  | { id: string; status: 'failed'; left?: number; message: string }
  | { id: string; status: 'done'; left?: number; picks: AskPick[]; note: string; near: boolean };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: Record<string, unknown>) { super(message); }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(`/api/v1${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body, credentials: 'same-origin' });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const e = (body as { error?: { code: string; message: string } & Record<string, unknown> } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'network', e?.message ?? 'Something went wrong. Check your connection and try again.', e);
  }
  return body as T;
}

export interface ListParams { when: When; category?: Category | ''; verified?: boolean; q?: string; near?: [number, number]; radius_km?: number; sort?: 'distance' }

/** The filters as GET /popups spells them, which is also what filterPopups reads. */
export function listParams(p: ListParams): Record<string, string> {
  const q: Record<string, string> = { when: p.when, limit: '50' };
  if (p.category) q.category = p.category;
  if (p.verified) q.verified = '1';
  if (p.q) q.q = p.q;
  if (p.near) q.near = p.near.join(',');
  if (p.radius_km) q.radius_km = String(p.radius_km);
  if (p.sort) q.sort = p.sort;
  return q;
}
