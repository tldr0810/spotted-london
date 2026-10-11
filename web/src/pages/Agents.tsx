import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Agent, type AgentRun, type AgentsView, type AskStats, type Schedule, type TagReport } from '../lib/api';
import { TAG_LABELS } from '../../../src/shared/tags';
import { useErrorToast, useMe, useToast } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { ScoutSources } from './ScoutSources';
import { PhotoThumbs } from '../components/PhotoThumbs';

// Admin settings for the AI agents that run on Manyfold (SPEC §13.4).

const SCHEDULES: [Schedule, string][] = [
  ['hourly', 'Every hour'], ['every_6h', 'Every 6 hours'], ['daily', 'Daily'], ['weekly', 'Mondays'], ['manual', 'Only when I run it'],
];

const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

function scheduleText(a: Agent): string {
  if (!a.enabled) return 'Off. It does not run until you switch it on.';
  if (a.schedule === 'manual') return 'Runs only when you press Run now.';
  if (a.manyfold_scheduled) return a.next_run_at ? `Next slot ${stamp.format(a.next_run_at)}. A Manyfold automation starts it; Spotted starts it 30 minutes late if it did not.` : 'Next slot is being scheduled.';
  return a.next_run_at ? `Next run ${stamp.format(a.next_run_at)}.` : 'Next run is being scheduled.';
}

function hoursText(a: Agent): string {
  if (a.schedule === 'every_6h') return [0, 6, 12, 18].map(h => (h + a.run_hour) % 24).sort((x, y) => x - y).map(hh).join(', ');
  return hh(a.run_hour);
}

export default function AgentsPage() {
  const { data: me, isPending } = useMe();
  const q = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentsView>('/admin/agents'), enabled: me?.role === 'admin', refetchInterval: 120_000 });
  if (isPending) return <Skeleton />;
  if (me?.role !== 'admin') return <div className="empty"><Icon name="i-shield" className="i big" /><h2>Admins only</h2><p>This page controls the AI agents that help run Spotted.</p><Link className="btn sm" to="/">Back to Explore</Link></div>;
  return (
    <>
      <Link className="btn sm subtle m-only" to="/me" style={{ margin: '-6px 0 8px -10px' }}><Icon name="i-down" className="i" />Back to Me</Link>
      <div className="eyebrow">Admin</div><h1>Agents</h1>
      <p className="intro">AI agents on Manyfold help run Spotted. You can add as many Scouts, Triage and Checker agents as you like, each with its own schedule and instructions. They send drafts and leave notes, and everything they send waits in the <Link to="/admin">review queue</Link> for you. A Concierge is different: it answers the questions visitors type into Ask, using only the public list.</p>
      {q.data && !q.data.agents_key_set ? (
        <div className="notice err" style={{ marginTop: 18 }}><Icon name="i-info" /><span>The <code>AGENTS_KEY</code> secret is not set, so agent tokens cannot be saved. Run <code>npx wrangler secret put AGENTS_KEY</code> with 32 or more random characters, then reload this page.</span></div>
      ) : null}
      {q.isPending ? <Skeleton list /> : q.data ? (
        <>
          <PublishMode mode={q.data.auto_publish} />
          <div className="stack agents" style={{ marginTop: 22 }}>{q.data.agents.map(a => <AgentCard key={a.id} a={a} ask={q.data.ask} />)}</div>
          <AddAgent roles={q.data.roles} />
          <ScoutSources />
          <TagsReport />
          <PhotoThumbs />
          <PublicList list={q.data.public_list} />
          <Setup view={q.data} />
        </>
      ) : <div className="empty" style={{ marginTop: 22 }}><p>{q.error?.message ?? 'Could not load the agents.'}</p><button className="btn sm" onClick={() => q.refetch()}>Try again</button></div>}
    </>
  );
}

function AddAgent({ roles }: { roles: AgentsView['roles'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const add = useMutation({
    mutationFn: (role: string) => api<Agent>('/admin/agents', { method: 'POST', json: { role } }),
    onSuccess: a => { qc.setQueryData<AgentsView>(['agents'], v => v && { ...v, agents: [...v.agents, a] }); toast(a.role === 'concierge' ? `${a.name} added. Connect it to Manyfold, then switch it on.` : `${a.name} added. Connect it to Manyfold and give it a key before it can run.`, 'i-sparkle'); },
    onError,
  });
  return (
    <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
      <span className="muted">Add another</span>
      {roles.map(r => <button key={r.role} className="btn sm" disabled={add.isPending} onClick={() => add.mutate(r.role)}><Icon name="i-plus" />{r.name}</button>)}
    </div>
  );
}

/** How far tagging has got, which tags are used, what Triage and Checker changed, and ten pop-ups to check by eye. */
function TagsReport() {
  const q = useQuery({ queryKey: ['tag-report'], queryFn: () => api<TagReport>('/admin/agents/tag-report'), staleTime: 60_000 });
  const r = q.data;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%');
  return (
    <section className="panel" style={{ marginTop: 22 }} aria-labelledby="tg-h">
      <h2 id="tg-h">Tags</h2>
      {q.isPending ? <p className="muted" style={{ marginTop: 6 }}>Loading.</p> : q.isError || !r ? <p className="muted" style={{ marginTop: 6 }}>The tag report could not be loaded. Reload the page to try again.</p> : (
        <>
          <p className="muted" style={{ marginTop: 6 }}>
            {r.coverage.tagged} of {r.coverage.live} live pop-ups have tags ({pct(r.coverage.tagged, r.coverage.live)}). {r.coverage.none_apply} were looked at and none apply, {r.coverage.not_looked_at} have not been looked at yet. The list is up to 10 minutes behind.
          </p>
          <ul className="tag-row" style={{ marginTop: 10 }} aria-label="Pop-ups per tag">
            {r.uses.map(u => <li key={u.tag} className="tag t-line" title={u.share < 0.01 && r.coverage.live >= 100 ? 'Under 1% of live pop-ups: a candidate to drop or merge' : undefined}>{TAG_LABELS[u.tag]} {u.n}</li>)}
          </ul>
          {r.changes.length ? (
            <p className="muted" style={{ marginTop: 10 }}>Last 30 days: {r.changes.map(c => `${c.agent} (${c.role}) changed ${c.edits}, added ${c.added}, removed ${c.removed}`).join('; ')}.</p>
          ) : <p className="muted" style={{ marginTop: 10 }}>No tag changes by Triage or Checker yet.</p>}
          {r.samples.length ? (
            <>
              <h3 style={{ marginTop: 14 }}>Check these by eye</h3>
              <ul className="stack" style={{ marginTop: 6, listStyle: 'none', padding: 0 }}>
                {r.samples.map(s => (
                  <li key={s.id}><a href={`/p/${s.slug}`} target="_blank" rel="noopener">{s.title}</a>: {s.tags.map(t => TAG_LABELS[t]).join(', ')}{s.source_url ? <> (<a href={s.source_url} target="_blank" rel="noopener nofollow">source</a>)</> : null}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The public list is one file every visitor downloads and filters in the browser, so its size is the thing to watch as pop-ups pile up. */
function PublicList({ list }: { list: AgentsView['public_list'] }) {
  const size = (b: number) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1000)} KB`);
  const about = Math.round(list.bytes / 800 / 10) * 10; // a pop-up is about 800 bytes in it
  const big = list.bytes >= list.warn_bytes;
  return (
    <section className="panel" style={{ marginTop: 22 }} aria-labelledby="pl-h">
      <h2 id="pl-h">Public list</h2>
      {list.bytes ? (
        <p className="muted" style={{ marginTop: 6 }}>
          About {about.toLocaleString('en-GB')} pop-ups, {size(list.bytes)}. Every visitor downloads it when the app opens and filters it on their phone, which stays quick up to about {size(list.warn_bytes)}. It is rebuilt every 10 minutes.
        </p>
      ) : <p className="muted" style={{ marginTop: 6 }}>No list has been built yet.</p>}
      {big ? <div className="notice err" style={{ marginTop: 10 }}><Icon name="i-info" /><span>The list is getting big for phones. Ask Claude to make it smaller, for example shorter fields or a shorter time window.</span></div> : null}
    </section>
  );
}

function PublishMode({ mode }: { mode: AgentsView['auto_publish'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const save = useMutation({
    mutationFn: (next: AgentsView['auto_publish']) => api<{ auto_publish: AgentsView['auto_publish'] }>('/admin/agents/settings', { method: 'PUT', json: { auto_publish: next } }),
    onSuccess: r => { qc.setQueryData<AgentsView>(['agents'], v => v && { ...v, auto_publish: r.auto_publish }); toast(r.auto_publish === 'auto' ? 'Posts a second agent verified now go live at once.' : 'Verified posts now wait for your Publish click.', 'i-sparkle'); },
    onError,
  });
  return (
    <section className="panel" style={{ marginTop: 22 }} aria-labelledby="pm-h">
      <div className="row"><h2 id="pm-h">Publishing</h2><span className="spacer" />
        <button className="switch" role="switch" aria-checked={mode === 'auto'} disabled={save.isPending} onClick={() => save.mutate(mode === 'auto' ? 'suggest' : 'auto')}>
          <span className="track" /><span>{mode === 'auto' ? 'Automatic' : 'I click Publish'}</span>
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        {mode === 'auto'
          ? 'A post goes live as a community post as soon as a Triage agent has checked it against its source with its own quote and the Scout was sure. Use Undo on an agent card to take back what it published.'
          : 'A post a Triage agent checked against its source waits in the review queue with a Publish button. Switch to automatic once the posts you publish rarely need changing.'}
      </p>
    </section>
  );
}

function Undo({ a }: { a: Agent }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [hours, setHours] = useState<number | null>(null);
  const undo = useMutation({
    mutationFn: (h: number) => api<{ reverted: number; skipped: { id: string; title: string; reason: string }[] }>(`/admin/agents/${a.id}/undo`, { method: 'POST', json: { hours: h } }),
    onSuccess: r => {
      setHours(null);
      toast(`${r.reverted} back in the review queue${r.skipped.length ? `, ${r.skipped.length} left alone (${r.skipped.map(s => s.reason).filter((x, i, all) => all.indexOf(x) === i).join('; ')})` : ''}.`, 'i-check');
      qc.invalidateQueries({ queryKey: ['agents'] }); qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['popups'] });
    },
    onError,
  });
  const p = a.published;
  return (
    <div className="field" style={{ marginTop: 16 }}>
      <span className="lbl">Published by this agent</span>
      <span className="hint">{p.published} published{p.hidden_after ? `, ${p.hidden_after} hidden or removed since` : ''}{p.undone ? `, ${p.undone} taken back` : ''}.</span>
      <div className="chips">{[[1, 'Last hour'], [24, 'Last 24 hours'], [168, 'Last 7 days']].map(([h, label]) => (
        <button key={h} className="chip" aria-pressed={hours === h} onClick={() => setHours(hours === h ? null : (h as number))}>{label}</button>
      ))}</div>
      {hours ? (
        <div className="row">
          <button className="btn sm danger" disabled={undo.isPending} onClick={() => undo.mutate(hours)}>Take back what it published</button>
          <span className="hint">They return to the review queue. Posts people already voted on stay.</span>
        </div>
      ) : null}
    </div>
  );
}

function useSave(id: string) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (patch: Partial<Record<keyof Agent | 'token', unknown>>) => api<Agent>(`/admin/agents/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: a => qc.setQueryData<AgentsView>(['agents'], v => v && { ...v, agents: v.agents.map(x => (x.id === a.id ? a : x)) }),
    onError,
  });
}

function AgentCard({ a, ask }: { a: Agent; ask: AskStats | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const save = useSave(a.id);
  const [notes, setNotes] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const concierge = a.role === 'concierge';
  // The Concierge only reads the public list, so it never needs a Spotted key.
  const needsKey = !concierge && !a.key_hint;
  const [open, setOpen] = useState(!a.connected || needsKey);
  const running = a.runs.find(r => r.status === 'running');
  const put = (x: Agent) => qc.setQueryData<AgentsView>(['agents'], v => v && { ...v, agents: v.agents.map(y => (y.id === x.id ? x : y)) });
  const run = useMutation({
    mutationFn: () => api<Agent>(`/admin/agents/${a.id}/run`, { method: 'POST' }),
    onSuccess: x => { put(x); toast(`${a.name} started. Its drafts and notes show up in the review queue.`, 'i-sparkle'); },
    onError,
  });
  const state = running ? <span className="tag t-ai"><span className="spin" />Working</span>
    : !a.connected ? <span className="tag t-watch">Not connected</span>
    : needsKey ? <span className="tag t-watch">Needs a key</span>
    : a.enabled ? <span className="tag t-eng">On</span> : <span className="tag t-mute">Off</span>;

  return (
    <section className="panel agent" aria-labelledby={`ag-${a.id}`}>
      <div className="row">
        <h2 id={`ag-${a.id}`}>{a.name}</h2>{state}
        <span className="spacer" />
        <button className="switch" role="switch" aria-checked={a.enabled} disabled={save.isPending} onClick={() => save.mutate({ enabled: !a.enabled })}>
          <span className="track" /><span>{a.enabled ? 'On' : 'Off'}</span>
        </button>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>{a.job}</p>

      <form className="row" style={{ marginTop: 10 }} noValidate onSubmit={e => { e.preventDefault(); if (name !== null && name.trim() && name.trim() !== a.name) save.mutate({ name: name.trim() }, { onSuccess: () => { setName(null); toast('Name saved'); } }); }}>
        <label className="lbl" htmlFor={`nm-${a.id}`}>Name</label>
        <input id={`nm-${a.id}`} className="input" style={{ maxWidth: 240 }} maxLength={40} value={name ?? a.name} onChange={e => setName(e.target.value)} />
        {name !== null && name.trim() && name.trim() !== a.name ? <button className="btn sm primary" disabled={save.isPending}>Save name</button> : null}
      </form>

      {concierge ? <AskToday ask={ask} /> : (
      <div className="agrid">
        <div className="field">
          <span className="lbl">When it runs</span>
          <div className="chips">{SCHEDULES.map(([s, label]) => (
            <button key={s} className="chip" aria-pressed={a.schedule === s} disabled={save.isPending} onClick={() => save.mutate({ schedule: s })}>{label}</button>
          ))}</div>
          <span className="hint">{scheduleText(a)}</span>
          <button className="switch" role="switch" aria-checked={a.manyfold_scheduled} disabled={save.isPending} onClick={() => save.mutate({ manyfold_scheduled: !a.manyfold_scheduled })}>
            <span className="track" /><span>Started by a Manyfold automation</span>
          </button>
        </div>
        <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
          {a.schedule === 'daily' || a.schedule === 'weekly' || a.schedule === 'every_6h' ? (
            <Stepper label="Time (London)" value={hoursText(a)} busy={save.isPending}
              onDown={() => save.mutate({ run_hour: (a.run_hour + 23) % 24 })} onUp={() => save.mutate({ run_hour: (a.run_hour + 1) % 24 })} />
          ) : null}
          <Stepper label={`Most ${a.unit} per run`} value={String(a.max_items)} busy={save.isPending}
            onDown={() => a.max_items > 1 && save.mutate({ max_items: a.max_items - (a.max_items > 10 ? 5 : 1) })}
            onUp={() => a.max_items < 50 && save.mutate({ max_items: Math.min(50, a.max_items + (a.max_items >= 10 ? 5 : 1)) })} />
        </div>
      </div>
      )}

      <form className="field" style={{ marginTop: 16 }} noValidate onSubmit={e => { e.preventDefault(); save.mutate({ instructions: notes }, { onSuccess: () => { setNotes(null); toast('Instructions saved'); } }); }}>
        <label className="lbl" htmlFor={`ins-${a.id}`}>Instructions</label>
        <textarea id={`ins-${a.id}`} className="input" maxLength={2000} value={notes ?? a.instructions ?? ''} onChange={e => setNotes(e.target.value)}
          placeholder={concierge ? 'For example: Prefer pop-ups with a photo, or: Keep every reason under 100 characters.' : a.role === 'scout' ? 'For example: Only check the venue sources, or: Focus on food and sample sales in East London. Skip anything that needs a ticket over £20.' : a.role === 'triage' ? 'For example: Be strict with posts that only link to an Instagram profile.' : 'For example: Check verified pop-ups first.'} />
        <span className="hint">{concierge ? 'Added to every question. Write it like a note to a helper.' : 'Added to every run. Write it like a note to a helper.'}</span>
        {notes !== null && notes !== (a.instructions ?? '') ? (
          <div className="row"><button className="btn sm primary" disabled={save.isPending}>Save instructions</button><button type="button" className="btn sm subtle" onClick={() => setNotes(null)}>Cancel</button></div>
        ) : null}
      </form>

      {a.role === 'scout' || a.role === 'triage' ? <Undo a={a} /> : null}

      <div className="row" style={{ marginTop: 16 }}>
        {concierge ? null : (
          <button className="btn sm primary" disabled={run.isPending || !!running || !a.connected || !a.key_hint} onClick={() => run.mutate()}>
            {run.isPending ? <span className="spin" /> : <Icon name="i-bolt" />}Run now
          </button>
        )}
        <button className="btn sm" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="i-link" />Connection</button>
        {a.open_notes ? <Link className="btn sm subtle" to="/admin"><Icon name="i-flag" />{a.open_notes} open {a.open_notes === 1 ? 'note' : 'notes'}</Link> : null}
      </div>
      {concierge && !a.connected ? <p className="small muted" style={{ marginTop: 8 }}>Connect it to Manyfold, then switch it on. Ask appears for visitors once a Concierge is on.</p> : null}
      {!concierge && (!a.connected || !a.key_hint) ? <p className="small muted" style={{ marginTop: 8 }}>Connect it to Manyfold and create a Spotted key before it can run.</p> : null}

      {open ? <Connection a={a} /> : null}
      <Runs runs={a.runs} unit={a.unit} />
    </section>
  );
}

/** What the Concierge is doing today: how many questions came in against the daily cap. */
function AskToday({ ask }: { ask: AskStats | null }) {
  if (!ask) return <p className="small muted" style={{ marginTop: 14 }}>Ask is not set up yet: apply migration 0018 first (see the pull request).</p>;
  return (
    <div className="field" style={{ marginTop: 14 }}>
      <span className="lbl">Today</span>
      <span className="hint">{ask.today} of {ask.cap} questions used. Each visitor gets {ask.per_visitor} a day. {ask.failed_today ? `${ask.failed_today} could not be answered${ask.last_error ? `, the last because: ${ask.last_error}` : ''}.` : 'None have failed.'}</span>
    </div>
  );
}

function Stepper({ label, value, onDown, onUp, busy }: { label: string; value: string; onDown: () => void; onUp: () => void; busy: boolean }) {
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      <div className="stepper">
        <button className="btn sm" aria-label={`Less: ${label}`} disabled={busy} onClick={onDown}>−</button>
        <b className="num">{value}</b>
        <button className="btn sm" aria-label={`More: ${label}`} disabled={busy} onClick={onUp}>+</button>
      </div>
    </div>
  );
}

function Connection({ a }: { a: Agent }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const save = useSave(a.id);
  const [url, setUrl] = useState(a.rpc_url ?? '');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const put = (x: Agent) => qc.setQueryData<AgentsView>(['agents'], v => v && { ...v, agents: v.agents.map(y => (y.id === x.id ? x : y)) });
  const newKey = useMutation({
    mutationFn: () => api<{ key: string; key_hint: string }>(`/admin/agents/${a.id}/key`, { method: 'POST' }),
    onSuccess: r => { setKey(r.key); qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError,
  });
  const revoke = useMutation({
    mutationFn: () => api<Agent>(`/admin/agents/${a.id}/key`, { method: 'DELETE' }),
    onSuccess: x => { put(x); setKey(null); toast('Key revoked. The agent is off until you create a new one.'); },
    onError,
  });
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast('Copied'), () => toast('Could not copy. Select the text and copy it yourself.', 'i-info', true));

  const submit = () => {
    if (url.trim() && !/^https?:\/\/\S+$/i.test(url.trim())) return setErr('Enter the full A2A address from Manyfold, starting with https://.');
    const patch: Record<string, unknown> = {};
    if (url.trim() !== (a.rpc_url ?? '')) patch.rpc_url = url.trim() || null;
    if (token.trim()) patch.token = token.trim();
    if (!Object.keys(patch).length) return setErr('Nothing changed. Paste a new address or token first.');
    save.mutate(patch, { onSuccess: () => { setToken(''); toast('Connection saved'); } });
  };

  return (
    <div className="conn">
      <ConnectManyfold a={a} />
      {manual ? (
      <form className="fields" style={{ marginTop: 16 }} noValidate onSubmit={e => { e.preventDefault(); submit(); }}>
        <label className="field"><span className="lbl">A2A address</span>
          <input className={`input ${err ? 'bad' : ''}`} inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={e => { setUrl(e.target.value); setErr(null); }}
            placeholder="https://…/a2a/…" aria-invalid={!!err} aria-describedby={err ? `cerr-${a.id}` : undefined} />
          <span className="hint">In Manyfold: the agent, then A2A, then the RPC URL.</span>
        </label>
        <label className="field"><span className="lbl">Caller token</span>
          <input className="input" type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => { setToken(e.target.value); setErr(null); }}
            placeholder={a.token_hint ? `Saved (${a.token_hint}). Paste a new one to replace it.` : 'Paste the caller token Manyfold showed you'} />
          <span className="hint">Stored encrypted and never shown again. Manyfold caller tokens last 90 days.</span>
        </label>
        {err ? <span className="ferr" id={`cerr-${a.id}`} role="alert">{err}</span> : null}
        <div className="row">
          <button className="btn sm primary" disabled={save.isPending}>Save connection</button>
        </div>
      </form>
      ) : (
        <button className="btn sm subtle" style={{ marginTop: 8, marginLeft: -10 }} onClick={() => setManual(true)}>Paste an address and token instead</button>
      )}

      {a.role === 'concierge' ? null : (
      <div className="field" style={{ marginTop: 18 }}>
        <span className="lbl">Spotted key</span>
        {key ? (
          <div className="notice good" style={{ flexDirection: 'column', gap: 8 }}>
            <span>Copy it now. It is shown only once. Give it to this agent with the <code>mf mcp add</code> command under Set up an agent, and to no other agent.</span>
            <div className="row" style={{ width: '100%' }}><code className="secret">{key}</code><button className="btn sm" onClick={() => copy(key)}>Copy</button></div>
          </div>
        ) : <span className="hint">{a.key_hint ? `Active key ends in ${a.key_hint}.` : 'No key yet. The agent needs one to read and write on Spotted.'}</span>}
        <div className="row">
          <button className="btn sm" disabled={newKey.isPending} onClick={() => newKey.mutate()}>{a.key_hint ? 'Replace key' : 'Create key'}</button>
          {a.key_hint ? <button className="btn sm danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</button> : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ConnectSession = { auth_url: string; user_code: string; expires_at: number };
type ConnectResult = { status: 'pending' | 'approved' | 'denied' | 'expired'; manyfold_agent?: string; ignored?: number; agent?: Agent };

/** Device-code sign-in: Manyfold shows a code, the admin approves one agent, we poll for the result. */
function ConnectManyfold({ a }: { a: Agent }) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const [session, setSession] = useState<ConnectSession | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api<ConnectSession>(`/admin/agents/${a.id}/connect`, { method: 'POST' }),
    onMutate: () => {
      setEnded(null);
      // Open the tab inside the click, or the browser blocks it as a pop-up.
      const w = window.open('about:blank', '_blank');
      return { w };
    },
    onSuccess: (s, _v, ctx) => {
      setSession(s);
      if (ctx?.w) { ctx.w.opener = null; ctx.w.location.href = s.auth_url; }
    },
    onError: (e, _v, ctx) => { ctx?.w?.close(); onError(e); },
  });
  const poll = useQuery({
    queryKey: ['connect', a.id, session?.user_code],
    queryFn: () => api<ConnectResult>(`/admin/agents/${a.id}/connect/poll`, { method: 'POST' }),
    enabled: !!session,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    gcTime: 0,
  });
  useEffect(() => {
    const r = poll.data;
    if (!session || !r || r.status === 'pending') return;
    setSession(null);
    if (r.status === 'approved' && r.agent) {
      qc.setQueryData<AgentsView>(['agents'], v => v && { ...v, agents: v.agents.map(y => (y.id === a.id ? r.agent! : y)) });
      toast(`Connected to ${r.manyfold_agent ?? 'your Manyfold agent'}`, 'i-checkc');
      if (r.ignored) setEnded(`You approved ${r.ignored + 1} agents. Only ${r.manyfold_agent} is used for ${a.name}; connect the others from their own cards.`);
    } else {
      setEnded(r.status === 'denied' ? 'The request was denied in Manyfold. Press Connect with Manyfold to try again.' : 'The request expired before it was approved. Press Connect with Manyfold to start again.');
    }
  }, [poll.data, session, a.id, a.name, qc, toast]);
  useEffect(() => { if (poll.error && session) { setSession(null); onError(poll.error); } }, [poll.error, session, onError]);

  if (session) {
    return (
      <div className="notice ai" style={{ flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ gap: 8 }}><span className="spin" /><b>Waiting for you to approve in Manyfold</b></div>
        <span>Check that Manyfold shows this code, pick the agent for {a.name}, tick <b>Enable A2A exposure</b> if it asks, then press Approve.</span>
        <b className="usercode num">{session.user_code}</b>
        <div className="row">
          <a className="btn sm primary" href={session.auth_url} target="_blank" rel="noopener noreferrer"><Icon name="i-ext" className="i" />Open Manyfold</a>
          <button className="btn sm subtle" onClick={() => setSession(null)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="field">
      <span className="lbl">Manyfold agent</span>
      <span className="hint">{a.connected ? `Connected. Token ends in ${a.token_hint}. Connect again to switch agents or renew the token.` : 'Sign in to Manyfold and pick the agent that does this job. No copying and pasting.'}</span>
      {ended ? <span className="ferr" role="alert">{ended}</span> : null}
      <div className="row">
        <button className="btn sm primary" disabled={start.isPending} onClick={() => start.mutate()}>{start.isPending ? <span className="spin" /> : <Icon name="i-link" />}{a.connected ? 'Connect again' : 'Connect with Manyfold'}</button>
        {a.connected ? <TestButton id={a.id} /> : null}
      </div>
    </div>
  );
}

function TestButton({ id }: { id: string }) {
  const toast = useToast();
  const onError = useErrorToast();
  const test = useMutation({ mutationFn: () => api<{ message: string }>(`/admin/agents/${id}/test`, { method: 'POST' }), onSuccess: r => toast(r.message, 'i-checkc'), onError });
  return <button className="btn sm" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <span className="spin" /> : <Icon name="i-check" />}Test</button>;
}

function Runs({ runs, unit }: { runs: AgentRun[]; unit: string }) {
  const [all, setAll] = useState(false);
  if (!runs.length) return <p className="small muted" style={{ marginTop: 16 }}>No runs in the last 30 days.</p>;
  const shown = all ? runs : runs.slice(0, 3);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="eyebrow">Recent runs</div>
      <ul className="runs">{shown.map(r => (
        <li key={r.id}>
          <div className="row" style={{ gap: 8 }}>
            {r.status === 'running' ? <span className="tag t-ai"><span className="spin" />Working</span> : r.status === 'done' ? <span className="tag t-eng"><Icon name="i-check" />Done</span> : <span className="tag t-err"><Icon name="i-x" />Failed</span>}
            <span className="small">{stamp.format(r.started_at)}</span>
            <span className="small muted">{r.trigger === 'manual' ? 'Run by you' : r.via === 'fallback' ? 'Started by Spotted (Manyfold did not)' : r.via === 'manyfold' ? 'Scheduled on Manyfold' : 'Scheduled'} · {r.items} {r.items === 1 ? unit.replace(/s$/, '') : unit}</span>
          </div>
          {r.error ? <p className="small" style={{ color: 'var(--err)' }}>{r.error}</p> : null}
          {r.summary ? <p className="small summary">{r.summary}</p> : null}
        </li>
      ))}</ul>
      {runs.length > 3 ? <button className="btn sm subtle" onClick={() => setAll(x => !x)}>{all ? 'Show fewer' : `Show all ${runs.length}`}</button> : null}
    </div>
  );
}

function Setup({ view }: { view: AgentsView }) {
  const toast = useToast();
  const copy = (s: string) => navigator.clipboard.writeText(s).then(() => toast('Copied'), () => toast('Could not copy. Select the text and copy it yourself.', 'i-info', true));
  return (
    <>
      <div className="lh"><h2>Set up an agent on Manyfold</h2></div>
      <div className="panel">
        <ol className="steps">
          <li>In Manyfold, create an agent (Claude Code works well) and name it after its job, like <b>Spotted Scout</b>. Note its id (<code>agt_…</code>) from <code>mf agent list</code>.</li>
          <li>Install the Manyfold CLI once on your computer, and sign in.
            <Cmd copy={copy} text="curl -fsSL https://manyfold.ai/cli/install.sh | sh && mf login" /></li>
          <li>Add the Spotted skill to your library once, then install it on the agent (replace <code>agt_…</code>).
            <Cmd copy={copy} text={`mf skills library import --url ${view.skill_url}`} />
            <Cmd copy={copy} text="mf skills install spotted-london --agent-id agt_…" /></li>
          <li>Give the agent its Spotted key. Paste this command in the Terminal without pressing Enter, press Create key (or Replace key) and Copy on the agent's card here, then press Enter. The key goes straight from the clipboard into the agent's MCP settings.
            <Cmd copy={copy} text={`mf mcp add spotted ${view.mcp_url} --scope project --header "Authorization: Bearer $(pbpaste)" --agent-id agt_…`} />
            Keep <code>--scope project</code>: it puts the key in this agent's own workspace. Without it the key goes to a file that every agent on the same Manyfold sandbox shares, and the last key added wins. If the agent already has a server named spotted, run <code>mf mcp remove spotted --agent-id agt_…</code> first.</li>
          <li>Press <b>Connect with Manyfold</b>. In the Manyfold tab, check the code matches, pick the agent, tick Enable A2A exposure, and approve. This page picks it up by itself.</li>
          <li>Press Run now once and read the result below the agent. When it looks right, switch the agent on.</li>
        </ol>
        <p className="small" style={{ marginTop: 12 }}><b>A Concierge is simpler.</b> Create the agent in Manyfold, give it the public tools with no key and no skill, then press Connect with Manyfold and switch it on. Keep it on its own sandbox, because it reads text typed by anonymous visitors.
          <Cmd copy={copy} text={`mf mcp add spotted ${view.mcp_url} --scope project --agent-id agt_…`} /></p>
        <p className="small muted" style={{ marginTop: 12 }}>The same MCP address works without a key for anyone's AI assistant. It can then search and read public pop-ups, but not write.</p>
      </div>
    </>
  );
}

function Cmd({ text, copy }: { text: string; copy: (s: string) => void }) {
  return <div className="row copyrow"><code className="secret">{text}</code><button className="btn sm" onClick={() => copy(text)}>Copy</button></div>;
}

function Skeleton({ list }: { list?: boolean }) {
  const rows = <div className="stack" style={{ marginTop: 22 }}>{Array.from({ length: 3 }, (_, i) => (
    <div key={i} className="sk-panel"><div className="sk skl h" style={{ width: 140 }} /><div className="sk skl" style={{ width: '80%' }} /><div className="sk" style={{ height: 34, width: '60%' }} /></div>
  ))}</div>;
  if (list) return rows;
  return <div aria-busy="true" aria-label="Loading the agents"><div className="sk skl" style={{ width: 80 }} /><div className="sk" style={{ height: 40, width: 200, margin: '10px 0 0' }} />{rows}</div>;
}
