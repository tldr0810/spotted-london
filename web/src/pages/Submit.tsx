import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Category, type Extracted, type Place, type Popup } from '../lib/api';
import { CAT_LIST, CATS, catIcon, dateRange, londonDate, londonTs } from '../lib/format';
import { SignInPrompt } from './Account';
import { useDebounced, useErrorToast, useMe, useSheet, useToast } from '../lib/hooks';
import { haptic } from '../lib/motion';
import { compressImage } from '../lib/image';
import { makeThumb } from '../lib/thumbs';
import { Icon } from '../components/Icon';
import { Cover } from '../components/PopupBits';
import { Turnstile, useNeedsTurnstile, useProviders } from '../components/Turnstile';
import { DatePicker } from '../components/DatePicker';

const PinPicker = lazy(() => import('../components/maps').then(m => ({ default: m.PinPicker })));

type Flag = 'ai' | 'check' | undefined;
type FieldKey = 'title' | 'host' | 'category' | 'where' | 'start' | 'end' | 'hours' | 'price' | 'desc';
interface Photo { id: string; file: File; url: string }

const today = () => londonDate(Date.now());
const looksLikeUrl = (s: string) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s.trim());

export function Submit() {
  const [done, setDone] = useState<Popup | null>(null);
  const [round, setRound] = useState(0);
  if (done) return <Submitted p={done} onAnother={() => { setDone(null); setRound(n => n + 1); window.scrollTo(0, 0); }} />;
  return <SubmitForm key={round} onDone={p => { setDone(p); window.scrollTo(0, 0); }} />;
}

/** Shown after posting: what happens next, and a way to see, share or add another. */
function Submitted({ p, onAnother }: { p: Popup; onAnother: () => void }) {
  const { open } = useSheet();
  const toast = useToast();
  const qc = useQueryClient();
  const live = p.status !== 'pending';
  useEffect(() => {
    haptic([12, 60, 12]);
    // Seed the sheet so "See your pop-up" opens straight away.
    if (!qc.getQueryData(['popup', p.slug])) qc.setQueryData(['popup', p.slug], p, { updatedAt: 0 });
  }, [qc, p]);
  const share = async () => {
    const url = `${location.origin}/p/${p.slug}`;
    try {
      if (navigator.share) await navigator.share({ title: p.title, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', 'i-link'); }
    } catch { /* cancelled */ }
  };
  const i = (n: number) => ({ '--i': n }) as CSSProperties;
  return (
    <div className="done">
      <div className={`seal ${live ? '' : 'wait'}`} aria-hidden="true"><Icon name={live ? 'i-bolt' : 'i-clock'} /></div>
      <div style={i(0)}><div className="eyebrow">{live ? 'Posted' : 'Submitted'}</div><h1>{live ? "It's live" : 'Sent for review'}</h1></div>
      <p className="intro" style={{ ...i(1), marginTop: 0 }}>
        {live ? 'People can see it now, and the community starts checking it.' : 'An admin usually looks at new posts within 12 hours.'} You earn 10 karma when it is verified.
      </p>
      <Link to={`/p/${p.slug}`} className="mini" style={i(2)} onClick={e => { e.preventDefault(); open(p.slug, e.currentTarget.querySelector('.sw')); }}>
        <Cover p={p} className="sw" />
        <span style={{ minWidth: 0, flex: 1 }}><b>{p.title}</b><span>{p.location.borough ?? 'London'} · {dateRange(p)}</span></span>
      </Link>
      <div className="acts" style={i(3)}>
        <button className="btn primary" onClick={() => open(p.slug)}><Icon name="i-list" />See your pop-up</button>
        {live ? <button className="btn" onClick={share}><Icon name="i-link" />Share</button> : null}
        <button className="btn subtle" onClick={onAnother}><Icon name="i-plus" />Add another</button>
      </div>
    </div>
  );
}

function SubmitForm({ onDone }: { onDone: (p: Popup) => void }) {
  const { data: me, isPending: meLoading } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();

  const [src, setSrc] = useState('');
  const [title, setTitle] = useState('');
  const [host, setHost] = useState('');
  const [category, setCategory] = useState<Category>('food');
  const [whereText, setWhereText] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [hours, setHours] = useState('');
  const [priceType, setPriceType] = useState<'free' | 'paid' | 'unknown'>('unknown');
  const [price, setPrice] = useState('');
  const [desc, setDesc] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  // The main picture of the pasted link. We copy it when the pop-up is posted, and credit the page.
  const [linkPhoto, setLinkPhoto] = useState<{ image: string; page: string } | null>(null);
  const [flags, setFlags] = useState<Partial<Record<FieldKey, Flag>>>({});
  const [ai, setAi] = useState<{ state: 'idle' | 'busy' | 'done' | 'error'; msg?: string }>({ state: 'idle' });
  const [shot, setShot] = useState<string | null>(null); // preview of the screenshot being read
  const [drag, setDrag] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [dupes, setDupes] = useState<{ id: string; slug: string; title: string }[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const needsBot = useNeedsTurnstile();
  const photosOn = useProviders().data?.photos ?? false;

  const clearFlag = (k: FieldKey) => { setFlags(f => ({ ...f, [k]: undefined })); setErrors(e => ({ ...e, [k]: undefined })); };

  /* ----- address search ----- */
  const [suggestOpen, setSuggestOpen] = useState(false);
  const dq = useDebounced(whereText, 350);
  const suggest = useQuery({
    queryKey: ['geocode', dq],
    queryFn: () => api<{ items: Place[] }>(`/geocode?q=${encodeURIComponent(dq)}`),
    enabled: !!me && dq.trim().length >= 3 && (!place || place.label !== dq),
    staleTime: 86_400_000,
  });
  const pickPlace = (p: Place) => { setPlace(p); setWhereText(p.label); setSuggestOpen(false); clearFlag('where'); };
  const movePin = async (lat: number, lng: number) => {
    setPlace(p => (p ? { ...p, lat, lng } : p));
    try {
      const r = await api<Place>(`/geocode/reverse?lat=${lat}&lng=${lng}`);
      setPlace(r); setWhereText(r.label);
    } catch { /* keep the moved pin even if the address lookup fails */ }
  };

  /* ----- AI autofill: a link, the post text, or a screenshot ----- */
  type Input = { kind: 'link' | 'text'; value: string } | { kind: 'image'; file: File };
  const fill = async (input: Input) => {
    setLinkPhoto(null);
    setAi({ state: 'busy', msg: input.kind === 'link' ? 'Reading the page. Looking for dates, place and price.' : input.kind === 'text' ? 'Reading the text.' : 'Reading your screenshot. This takes a few seconds.' });
    try {
      let r: { fields: Extracted; platform: string | null };
      if (input.kind === 'image') {
        const blob = await compressImage(input.file, { maxEdge: 1600, maxBytes: 1_000_000, jpeg: true });
        r = await api('/extract/image', { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
      } else {
        r = await api('/extract', { method: 'POST', json: input.kind === 'link' ? { url: input.value } : { text: input.value } });
      }
      const f = r.fields, c = f.confidence;
      const mark = (k: string): Flag => (c[k] === 'check' ? 'check' : c[k] ? 'ai' : undefined);
      const next: Partial<Record<FieldKey, Flag>> = {};
      let n = 0;
      if (f.title) { setTitle(f.title); next.title = mark('title'); n++; }
      if (f.host) { setHost(f.host); next.host = mark('host'); n++; }
      if (f.category) { setCategory(f.category); next.category = mark('category'); n++; }
      if (f.start_date) { setStart(f.start_date); next.start = mark('start_date'); n++; }
      if (f.end_date) { setEnd(f.end_date); next.end = mark('end_date'); n++; }
      if (f.hours_text) { setHours(f.hours_text); next.hours = mark('hours_text'); n++; }
      if (f.price_text) { setPrice(f.price_text); setPriceType(/free/i.test(f.price_text) ? 'free' : 'paid'); next.price = mark('price_text'); n++; }
      if (f.description) { setDesc(f.description); next.desc = mark('description'); n++; }
      if (f.address) {
        setWhereText(f.address); setPlace(null); n++;
        // Resolve the address to a pin; the person confirms it on the map.
        const places = await api<{ items: Place[] }>(`/geocode?q=${encodeURIComponent(f.address)}`).catch(() => ({ items: [] }));
        if (places.items[0]) { setPlace(places.items[0]); setWhereText(places.items[0].label); }
        next.where = 'check';
      }
      if (input.kind === 'link' && f.image_url) setLinkPhoto({ image: f.image_url, page: input.value });
      setFlags(next);
      const checks = Object.values(next).filter(v => v === 'check').length;
      setAi({ state: 'done', msg: `Filled ${n} field${n === 1 ? '' : 's'}. Blue fields came from AI${checks ? `, and ${checks} need a closer look` : ''}. Check them before you submit.` });
    } catch (e) {
      setAi({ state: 'error', msg: e instanceof Error ? e.message : 'Autofill did not work. Fill in the form yourself.' });
    } finally { setShot(null); }
  };
  const onAutofill = () => {
    const v = src.trim();
    if (!v) return toast('Paste a link or the post text first', 'i-link');
    fill({ kind: looksLikeUrl(v) ? 'link' : 'text', value: v });
  };
  const readShot = (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('That is not an image. Use a screenshot of the post.', 'i-image', true);
    setShot(URL.createObjectURL(file));
    fill({ kind: 'image', file });
  };
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot); }, [shot]);

  /* ----- photos ----- */
  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const room = 5 - photos.length - (linkPhoto ? 1 : 0);
    const list = [...files].filter(f => f.type.startsWith('image/')).slice(0, room);
    if (files.length > room) toast('You can add up to 5 photos', 'i-image');
    setPhotos(ps => [...ps, ...list.map(file => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }))]);
  };
  useEffect(() => () => photos.forEach(p => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----- trust preview ----- */
  const hasSource = looksLikeUrl(src);
  const trust = (me?.trust ?? 0) + (hasSource ? 10 : 0);
  const auto = me?.role === 'admin' || me?.role === 'organizer' || trust >= 50;

  /* ----- submit ----- */
  const validate = () => {
    const e: Partial<Record<FieldKey, string>> = {};
    if (title.trim().length < 3) e.title = 'Give it a name of at least 3 characters.';
    if (!place) e.where = 'Choose an address from the list, or drop the pin on the map.';
    if (!start) e.start = 'Pick a start date.';
    if (!end || end < start) e.end = 'The end date must be on or after the start.';
    if (end && end < today()) e.end = 'This pop-up has already ended.';
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = async (force = false) => {
    if (!validate()) { toast('A few fields need attention', 'i-info', true); return; }
    setSaving('Posting');
    try {
      const created = await api<Popup>('/popups', {
        method: 'POST',
        json: {
          title: title.trim(), host: host.trim() || null, category, description: desc.trim() || null,
          address: place!.address, borough: place!.area, lat: place!.lat, lng: place!.lng,
          start_at: londonTs(start, 0), end_at: londonTs(end, 23, 59), hours_text: hours.trim() || null,
          price_type: priceType, price_text: price.trim() || null, source_url: hasSource ? src.trim() : null, force, turnstile_token: botToken,
        },
      });
      for (const [i, ph] of (photosOn ? photos : []).entries()) {
        setSaving(`Uploading photo ${i + 1} of ${photos.length}`);
        try {
          const blob = await compressImage(ph.file);
          const photo = await api<{ id: string }>(`/popups/${created.id}/images`, { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
          await makeThumb(created.id, photo.id, blob).catch(() => {}); // optional: lists fall back to the full photo
        } catch (e) { onError(e); }
      }
      if (photosOn && linkPhoto) {
        setSaving('Copying the photo from the link');
        try { await api(`/popups/${created.id}/images/from-url`, { method: 'POST', json: { image_url: linkPhoto.image, page_url: linkPhoto.page } }); }
        catch { toast('Posted, but we could not copy the photo from the link. You can add one yourself.', 'i-image'); }
      }
      qc.invalidateQueries({ queryKey: ['popups'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      onDone(created);
    } catch (e) {
      setBotReset(n => n + 1); // tokens work once
      if (e instanceof ApiError && e.code === 'possible_duplicate') setDupes((e.data?.candidates as { id: string; slug: string; title: string }[]) ?? []);
      else onError(e);
    } finally { setSaving(null); }
  };

  if (meLoading) return <div className="sk" style={{ height: 400 }} />;
  if (!me) return <SignInPrompt title="Add a pop-up" text="Sign in first, so the community knows who spotted it. You earn 10 karma when it gets verified." to="/add" />;

  const lbl = (k: FieldKey, text: string, extra?: string, id?: string) => (
    <span className="lbl" id={id}>{text}{extra ? <span className="muted small">{extra}</span> : null}
      {flags[k] === 'check' ? <span className="tag t-watch">Check this</span> : flags[k] === 'ai' ? <span className="tag t-ai">AI</span> : null}</span>
  );
  const state = (k: FieldKey) => `${flags[k] ? 'ai' : ''} ${errors[k] ? 'bad' : ''}`;
  const cls = (k: FieldKey) => `input ${state(k)}`;
  const err = (k: FieldKey) => (errors[k] ? <span className="ferr" role="alert">{errors[k]}</span> : null);

  return (
    <>
      <div className="eyebrow">Contribute</div><h1>Add a pop-up</h1>
      <p className="intro">Seen something worth sharing? You earn 10 karma when it gets verified.</p>
      <div className="form">
        <form className={`fields panel ${ai.state === 'busy' ? 'filling' : ''}`} noValidate onSubmit={e => { e.preventDefault(); submit(); }}>
          <section className={`aibox ${drag ? 'drag' : ''}`} aria-labelledby="aih"
            onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false); }}
            onDrop={e => { e.preventDefault(); setDrag(false); readShot(e.dataTransfer.files[0]); }}>
            <div className="row" style={{ gap: 8 }}><span className="tag t-ai"><Icon name="i-sparkle" />AI</span><h2 id="aih">Paste it, we fill it in</h2></div>
            <label htmlFor="src" className="sr">Link or post text</label>
            <textarea id="src" className="input src" rows={1} value={src} onChange={e => setSrc(e.target.value)} enterKeyHint="go" autoComplete="off" spellCheck={false}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAutofill(); } }}
              onPaste={e => { const f = [...e.clipboardData.files].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); readShot(f); } }}
              placeholder="A link, or the post text" />
            <div className="aiacts">
              <span className="btn sm filebtn"><Icon name="i-image" />Screenshot
                <input type="file" accept="image/*" aria-label="Upload a screenshot of the post" disabled={ai.state === 'busy'} onChange={e => { readShot(e.target.files?.[0]); e.target.value = ''; }} /></span>
              <span className="small muted d-only">or drop one here</span>
              <span className="spacer" />
              <button type="button" className="btn primary sm" onClick={onAutofill} disabled={ai.state === 'busy' || !src.trim()}>{ai.state === 'busy' && !shot ? <span className="spin" /> : <Icon name="i-sparkle" />}Autofill</button>
            </div>
            {shot ? <div className="shotprev"><img src={shot} alt="Your screenshot" /><span className="scan" /></div> : null}
            {ai.state !== 'idle' ? (
              <div className={`notice small ${ai.state === 'error' ? 'err' : 'ai'}`} aria-live="polite">
                {ai.state === 'busy' ? <span className="spin" /> : <Icon name={ai.state === 'error' ? 'i-info' : 'i-sparkle'} />}<span>{ai.msg}</span>
              </div>
            ) : <p className="small muted">Works with Instagram, TikTok, Eventbrite and venue sites. Instagram often blocks links, so a screenshot of the post works best.</p>}
          </section>

          <label className="field">{lbl('title', 'Name of the pop-up')}
            <input className={cls('title')} value={title} onChange={e => { setTitle(e.target.value); clearFlag('title'); setDupes(null); }} placeholder="e.g. Matcha Lab Pop-up" autoComplete="off" />{err('title')}</label>
          {dupes ? (
            <div className="notice watch small" style={{ flexDirection: 'column' }}>
              <span><b>This looks like it is already listed.</b> If it is the same pop-up, vote on it instead of adding a copy.</span>
              <span className="row">{dupes.map(d => <Link key={d.id} to={`/?p=${d.slug}`}>{d.title}</Link>)}</span>
              <button type="button" className="btn sm" onClick={() => submit(true)}>It is a different pop-up, post it</button>
            </div>
          ) : null}
          <label className="field">{lbl('host', 'Host or brand', ' (optional)')}
            <input className={cls('host')} value={host} onChange={e => { setHost(e.target.value); clearFlag('host'); }} placeholder="Who is running it" autoComplete="off" /></label>
          <div className="field"><span id="catlbl">{lbl('category', 'Category')}</span>
            <div className="chips" role="radiogroup" aria-labelledby="catlbl">
              {CAT_LIST.map(c => <button key={c} type="button" className="chip" role="radio" aria-checked={category === c} aria-pressed={category === c} onClick={() => { setCategory(c); clearFlag('category'); }}><Icon name={catIcon(c)} />{CATS[c]}</button>)}
            </div></div>

          <div className="field">
            <label htmlFor="where">{lbl('where', 'Where')}</label>
            <input id="where" className={cls('where')} value={whereText} autoComplete="off" placeholder="Start typing an address or venue"
              onChange={e => { setWhereText(e.target.value); setPlace(null); setSuggestOpen(true); clearFlag('where'); }}
              onFocus={() => setSuggestOpen(true)} onBlur={() => setTimeout(() => setSuggestOpen(false), 150)} />
            {suggestOpen && suggest.data?.items.length && !place ? (
              <ul className="suggest">{suggest.data.items.map(p => (
                <li key={`${p.lat},${p.lng}`}><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => pickPlace(p)}>{p.name ?? p.address}<small>{p.name ? p.address : p.area}</small></button></li>
              ))}</ul>
            ) : null}
            {suggest.isFetching ? <span className="hint"><span className="spin" style={{ width: 11, height: 11 }} /> Searching</span> : null}
            {err('where')}
            {place ? (
              <Suspense fallback={<div className="minimap sk" />}>
                <PinPicker lat={place.lat} lng={place.lng} onMove={movePin} />
                <span className="hint">Drag the pin or tap the map if it is not quite right.</span>
              </Suspense>
            ) : null}
          </div>

          <div className="two">
            <div className="field">{lbl('start', 'Starts', undefined, 'startlbl')}
              <DatePicker title="Starts" labelledBy="startlbl" value={start} today={today()} min={londonDate(Date.now() - 7 * 86_400_000)} range={[start, end]} className={state('start')}
                onChange={v => { setStart(v); if (end < v) setEnd(v); clearFlag('start'); }} />{err('start')}</div>
            <div className="field">{lbl('end', 'Ends', undefined, 'endlbl')}
              <DatePicker title="Ends" labelledBy="endlbl" value={end} today={today()} min={start} range={[start, end]} className={state('end')}
                onChange={v => { setEnd(v); clearFlag('end'); }} />{err('end')}</div>
          </div>
          <label className="field">{lbl('hours', 'Opening hours', ' (optional)')}
            <input className={cls('hours')} value={hours} onChange={e => { setHours(e.target.value); clearFlag('hours'); }} placeholder="e.g. Sat 10:00 to 16:00" /></label>
          <div className="field"><span className="lbl" id="pricelbl">Price</span>
            <div className="chips" role="radiogroup" aria-labelledby="pricelbl">
              {([['free', 'Free'], ['paid', 'Paid'], ['unknown', 'Not sure']] as const).map(([k, l]) => <button key={k} type="button" className="chip" role="radio" aria-checked={priceType === k} aria-pressed={priceType === k} onClick={() => setPriceType(k)}>{l}</button>)}
            </div>
            <input className={cls('price')} value={price} onChange={e => { setPrice(e.target.value); clearFlag('price'); }} placeholder="Details, e.g. £5 entry, bowls from £9" aria-label="Price details" />
          </div>
          <label className="field">{lbl('desc', 'What to expect', ' (optional)')}
            <textarea className={cls('desc')} value={desc} onChange={e => { setDesc(e.target.value); clearFlag('desc'); }} maxLength={2000} placeholder="Queues, what to bring, anything useful" /></label>

          {photosOn ? <div className="field"><span className="lbl">Photos <span className="muted small">(up to 5)</span></span>
            {photos.length || linkPhoto ? <div className="thumbs">{linkPhoto ? (
              <figure key="link"><img src={linkPhoto.image} alt="" referrerPolicy="no-referrer" onError={() => setLinkPhoto(null)} /><button type="button" aria-label="Remove the photo from the link" onClick={() => setLinkPhoto(null)}><Icon name="i-x" /></button></figure>
            ) : null}{photos.map(p => (
              <figure key={p.id}><img src={p.url} alt="" /><button type="button" aria-label="Remove photo" onClick={() => { URL.revokeObjectURL(p.url); setPhotos(ps => ps.filter(x => x.id !== p.id)); }}><Icon name="i-x" /></button></figure>
            ))}</div> : null}
            {photos.length + (linkPhoto ? 1 : 0) < 5 ? <span className="btn sm filebtn" style={{ alignSelf: 'flex-start' }}><Icon name="i-image" />Add photos<input type="file" accept="image/*" multiple onChange={e => { addPhotos(e.target.files); e.target.value = ''; }} aria-label="Add photos" /></span> : null}
            <span className="hint">{linkPhoto ? `The first photo is from ${linkPhoto.page.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0]}. We credit the page. Remove it if it does not show the pop-up. ` : ''}We shrink photos before uploading them.</span>
          </div> : <div className="notice small"><Icon name="i-image" /><span>Photo uploads are coming soon. Add a source link so people can see what it looks like.</span></div>}

          <Turnstile onToken={setBotToken} resetKey={botReset} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={!!saving || (needsBot && !botToken)} style={{ flex: '1 1 auto', maxWidth: 320 }}>{saving ? <><span className="spin" />{saving}</> : <><Icon name="i-plus" />Submit pop-up</>}</button>
          </div>
        </form>

        <aside className="sticky">
          <TrustBox trust={trust} auto={auto} hasSource={hasSource} karma={me.karma} verified={me.verified_posts} />
        </aside>
      </div>
    </>
  );
}

function TrustBox({ trust, auto, hasSource, karma, verified }: { trust: number; auto: boolean; hasSource: boolean; karma: number; verified: number }) {
  const width = `${Math.min(100, (trust / 50) * 100)}%`;
  return (
    <div className="panel">
      <div className="eyebrow">Your trust score</div>
      <div className="confrow"><b className="num">{trust}</b><span className="muted">/ 50 to skip review</span></div>
      <div className={`meter big ${auto ? '' : 'mid'}`} style={{ margin: '10px 0 12px' }}><i style={{ width }} /></div>
      {auto
        ? <div className="notice good small"><Icon name="i-bolt" /><span>This goes live straight away and the community starts checking it.</span></div>
        : <div className="notice watch small"><Icon name="i-clock" /><span>An admin reviews this first, usually within 12 hours.{hasSource ? '' : ' A source link adds 10.'}</span></div>}
      <table className="log small" style={{ marginTop: 12 }}><tbody>
        <tr><td>Karma {karma} × 0.5</td><td className="d num">{Math.round(karma * 0.5)}</td></tr>
        <tr><td>{verified} verified posts × 5</td><td className="d num">{verified * 5}</td></tr>
        <tr><td>Source link</td><td className={`d num ${hasSource ? 'pos' : ''}`}>+{hasSource ? 10 : 0}</td></tr>
      </tbody></table>
    </div>
  );
}
