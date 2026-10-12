import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Popup } from '../lib/api';
import { prefetchPopup } from '../lib/cache';
import { CATS, distance, fmtDay, isLive } from '../lib/format';
import { useFilters, useSheet, useToast } from '../lib/hooks';
import { openAsk, useAsk, useAskStatus } from '../lib/ask';
import { haptic, scrollBehavior, usePhone } from '../lib/motion';
import { nearChoiceMade, useNearMe } from '../lib/near-me';
import { useWelcome } from '../lib/onboarding';
import { nextStep } from '../../../src/shared/onboarding';
import { getTaste, updateTaste, useKeptNote, useTaste } from '../lib/taste';
import type { Snap } from '../lib/map-home';
import { Icon } from '../components/Icon';
import type { PopupMapHandle } from '../components/maps';
import { Filters, Newsletter, usePopups, VerifiedSwitch } from '../components/ListBits';
import { MapSheet } from '../components/MapSheet';
import { CardSkeletons, Cover, MAX_CROP_SMALL, PopupCard } from '../components/PopupBits';
import { useShell } from '../components/Shell';
import { TopBar } from '../components/TopBar';

// The map code is big. The page frame (bar, chips, sheet) paints first and the map fades in when it arrives.
const PopupMap = lazy(() => import('../components/maps').then(m => ({ default: m.PopupMap })));
const TasteDeck = lazy(() => import('../components/TasteDeck').then(m => ({ default: m.TasteDeck })));
const AskChat = lazy(() => import('../components/AskChat').then(m => ({ default: m.AskChat })));

type View = 'map' | 'list';

const CARDS_PER_PAGE = 24;

/**
 * The cards, a page at a time. With all of London in the list that is 600+ cards, each with a photo to decode
 * and an entrance animation, which makes scrolling on a phone stutter. The next page is added a little before
 * you reach the end, and it starts again from the top when a filter changes.
 */
function CardGrid({ items, stale, resetKey }: { items: Popup[]; stale: boolean; resetKey: string }) {
  const [n, setN] = useState(CARDS_PER_PAGE);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { setN(CARDS_PER_PAGE); }, [resetKey]);
  useEffect(() => {
    const el = end.current;
    if (!el || n >= items.length) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setN(c => c + CARDS_PER_PAGE); }, { rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [n, items.length]);
  return (
    <>
      <div className={`grid ${stale ? 'stale' : ''}`}>{items.slice(0, n).map((p, i) => <PopupCard key={p.id} p={p} i={i} />)}</div>
      <div ref={end} aria-hidden="true" />
    </>
  );
}

/**
 * The home page: a full-screen map with the list on top of it. Map view keeps the map in charge and shows
 * the list as a strip (phone) or a side panel (desktop); List view gives the screen to the cards.
 */
export default function HomePage() {
  const { menuOpen, openMenu } = useShell();
  const phone = usePhone();
  const [sp] = useSearchParams();
  const f = useFilters();
  const toast = useToast();
  const { open } = useSheet();
  const qc = useQueryClient();
  const near = useNearMe();
  const q = usePopups(near.filter ? near.pos : null);
  const items = q.data?.items ?? [];
  const taste = useTaste();
  const keptNote = useKeptNote();
  const [deck, setDeck] = useState<'first' | 'retake' | null>(null); // the swipe that sets up "For you"
  const openDeck = useCallback(() => setDeck(taste.swipes > 0 ? 'retake' : 'first'), [taste.swipes]);
  // Ask: a chat window (bubble when minimised). It is mounted the first time it opens and then kept, so the thread and what you typed stay.
  const asked = useAsk();
  const askAvailable = !!useAskStatus().data?.available;
  const [askMounted, setAskMounted] = useState(false);
  useEffect(() => { if (asked.open) setAskMounted(true); }, [asked.open]);
  const view: View = sp.get('view') === 'list' ? 'list' : 'map';
  // First-visit cards come one at a time: welcome, then location, then the swipe invite.
  const welcome = useWelcome(taste.seen || nearChoiceMade());
  const step = view === 'map' ? nextStep({ welcome: welcome.due, location: near.prompt, taste: !taste.seen && !deck && (q.all?.length ?? 0) >= 4 }) : null;

  const [snap, setSnap] = useState<Snap>(view === 'list' ? 'full' : 'peek');
  const [hl, setHl] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true); // desktop: the list panel can be tucked away
  const [visible, setVisible] = useState(0);
  const [top, setTop] = useState(130);
  const map = useRef<PopupMapHandle>(null);
  const chips = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);

  // The URL is the source of truth for Map or List; the sheet stops follow it.
  useEffect(() => { setSnap(s => (view === 'list' ? 'full' : s === 'full' ? 'peek' : s)); }, [view]);
  const goSnap = useCallback((s: Snap) => { setSnap(s); f.set({ view: s === 'full' ? 'list' : null }); }, [f]);
  const goView = useCallback((v: View) => { setSnap(v === 'list' ? 'full' : 'peek'); if (v === 'list') setPanelOpen(true); f.set({ view: v === 'list' ? 'list' : null }); }, [f]);

  // Buttons and toasts sit above the sheet: tell the stylesheet how much of it shows.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--mp-sheet', `${phone && snap !== 'full' ? visible : 0}px`);
    return () => { root.style.removeProperty('--mp-sheet'); };
  }, [phone, snap, visible]);

  // The map keeps its middle clear of the bar and chips (phone) or the panel (desktop).
  useLayoutEffect(() => {
    const el = chips.current;
    if (!phone || !el) return;
    const measure = () => setTop(el.offsetTop + el.offsetHeight + 6);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);
  const padding = useMemo(() => {
    if (view === 'list') return { top: 0, right: 0, bottom: 0, left: 0 };
    return phone ? { top, right: 0, bottom: visible, left: 0 } : { top: 76, right: 12, bottom: 12, left: panelOpen ? 396 : 12 };
  }, [phone, view, top, visible, panelOpen]);

  // Say what came of sharing your location, once the list has caught up.
  const told = useRef(false);
  useEffect(() => {
    if (near.state !== 'on') { told.current = false; return; }
    if (told.current || !q.data) return;
    told.current = true;
    toast(items.length ? `${items.length} pop-up${items.length === 1 ? '' : 's'} within 3 km, closest first` : 'Nothing within 3 km right now.', 'i-locate');
  }, [near.state, q.data, items.length, toast]);

  const onNear = () => {
    if (near.pos) near.setFilter(!near.filter);
    else void near.request();
  };
  const onLocate = async () => {
    if (near.state === 'denied') return void toast('Location is blocked. Allow it in your browser settings for this site.', 'i-info', true);
    if (near.state === 'unsupported') return void toast('This browser cannot share your location.', 'i-info', true);
    if (!near.pos) { await near.request(); return; }
    haptic(6);
    map.current?.recenter();
  };

  // On phones a pin tap brings its card into view; on desktop it opens the pop-up.
  const onPin = (p: Popup) => {
    setHl(p.id);
    if (!phone) return open(p.slug);
    haptic(6);
    if (snap !== 'peek') goSnap('peek');
    const row = strip.current, card = row?.querySelector<HTMLElement>(`[data-id="${p.id}"]`);
    if (!row || !card) return;
    requestAnimationFrame(() => {
      const r = card.getBoundingClientRect(), box = row.getBoundingClientRect();
      row.scrollBy({ left: r.left + r.width / 2 - (box.left + box.width / 2), behavior: scrollBehavior() });
    });
  };

  // And the other way round: when the strip stops on a card, its pin lights up and centres.
  useEffect(() => {
    const row = strip.current;
    if (!row || !phone || snap !== 'peek') return;
    let t = 0;
    const settle = () => {
      const box = row.getBoundingClientRect(), mid = box.left + box.width / 2;
      let best: HTMLElement | null = null, gap = Infinity;
      for (const c of row.querySelectorAll<HTMLElement>('[data-id]')) {
        const r = c.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid);
        if (d < gap) { gap = d; best = c; }
      }
      if (best?.dataset.id) setHl(best.dataset.id);
    };
    const onScroll = () => { clearTimeout(t); t = window.setTimeout(settle, 120); };
    row.addEventListener('scroll', onScroll, { passive: true });
    return () => { row.removeEventListener('scroll', onScroll); clearTimeout(t); };
  }, [phone, snap, items]);

  const nearOn = near.filter && !!near.pos;
  const grid = view === 'list';
  const modeSwitch = <ModeSwitch view={view} onView={goView} />;
  const count = q.isPending ? 'Loading' : f.saved ? `${items.length} saved` : nearOn ? `${items.length} near you` : `${items.length} pop-up${items.length === 1 ? '' : 's'}`;
  const sub = f.saved ? (nearOn ? 'your list, within 3 km' : 'your list, on the map') : q.forYou ? (nearOn ? 'picked for you, within 3 km' : 'picked for you') : nearOn ? 'within 3 km, closest first' : `London · ${fmtDay(Date.now())}`;
  const hidden = q.hidden.map(c => CATS[c as keyof typeof CATS]);
  const fy = q.forYou ? (
    <div className="mp-fy">
      <Icon name="i-sparkle" />
      <span className="t">{hidden.length ? `For you: leaving out ${hidden.join(', ')}` : 'For you: what you like comes first'}</span>
      <button type="button" className="btn sm subtle" onClick={() => updateTaste(t => ({ ...t, on: false }))}>Show all</button>
      <button type="button" className="btn sm" onClick={openDeck}>Retake</button>
    </div>
  ) : null;

  const header = phone ? (
    <><div className="mp-hrow">{modeSwitch}<span className="mp-count"><b>{count}</b><small>{sub}</small></span></div>{fy}</>
  ) : (
    <>
      <Filters near={nearOn} locating={near.state === 'asking'} onNear={onNear} onPick={openDeck} onAsk={openAsk} />
      {fy}
      <div className="mp-hrow">
        <span className="mp-count"><b>{count}</b><small>{sub}</small></span><span className="spacer" /><VerifiedSwitch />
        {view === 'map' ? <button type="button" className="mp-collapse" aria-label="Hide the list" title="Hide the list" onClick={() => setPanelOpen(false)}><Icon name="i-left" /></button> : null}
      </div>
    </>
  );

  let body;
  if (q.isPending) body = grid ? <CardSkeletons /> : <MiniSkeletons />;
  else if (q.isError) body = <div className="notice err"><Icon name="i-info" /><span>{q.error.message}</span><button className="btn sm" onClick={() => q.refetch()}>Try again</button></div>;
  else if (!items.length) {
    body = f.saved ? (
      <div className="empty"><Icon name="i-bookmark" className="i big" /><h2>No saved pop-ups here</h2><p>Tap the bookmark on any pop-up to keep it on your list, or try a wider date range or another category.</p><button className="btn sm" onClick={() => f.set({ saved: null })}>Show all pop-ups</button></div>
    ) : nearOn ? (
      <div className="empty"><Icon name="i-locate" className="i big" /><h2>Nothing within 3 km</h2><p>Try a wider date range, or look at all of London.</p><button className="btn sm" onClick={() => near.setFilter(false)}>Show all London</button></div>
    ) : f.q.trim() ? (
      <div className="empty"><Icon name="i-search" className="i big" /><h2>No pop-ups match &ldquo;{f.q.trim()}&rdquo;</h2><p>Check the spelling, or try a wider date range or another category.</p><button className="btn sm" onClick={() => f.set({ q: null })}>Clear search</button></div>
    ) : (
      <div className="empty"><Icon name="i-search" className="i big" /><h2>Nothing here yet</h2><p>Try a wider date range or another category, or be the first to add one.</p><Link className="btn sm" to="/add"><Icon name="i-plus" />Add a pop-up</Link></div>
    );
  } else if (grid) {
    body = (
      <>
        {items.some(p => p.example) ? <div className="notice small" style={{ marginBottom: 14 }}><Icon name="i-info" /><span>Pop-ups marked <b>Example</b> show how Spotted works. They are not real events.</span></div> : null}
        <CardGrid items={items} stale={q.isPlaceholderData} resetKey={`${f.when}|${f.category}|${f.verified}|${f.saved}|${f.q}|${nearOn}|${q.forYou}`} />
        <Newsletter />
      </>
    );
  } else {
    body = (
      <div className="mp-minis noscroll" ref={strip}>
        {items.map(p => (
          <Link key={p.id} data-id={p.id} to={`/p/${p.slug}`} className={`mini ${hl === p.id ? 'hl' : ''}`}
            onMouseEnter={() => setHl(p.id)} onPointerDown={() => prefetchPopup(qc, p.slug)} onClick={e => { e.preventDefault(); open(p.slug, e.currentTarget.querySelector('.sw')); }}>
            <Cover p={p} className="sw" fit={MAX_CROP_SMALL} />
            <span className="mp-mt"><b>{p.title}</b><span>{p.location.borough ?? 'London'} · {fmtDay(p.start_at)}{isLive(p) ? ' · on now' : ''}</span></span>
            {nearOn && p.distance_m !== undefined ? <span className="mp-dist">{distance(p.distance_m)}</span> : null}
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div className="mp-home" data-view={view} data-ask={asked.open ? 'open' : undefined} data-snap={snap} data-loc={near.state} data-away={away && !!near.pos} style={{ '--mp-chips': `${top}px` } as CSSProperties}>
      <div className="mp-statusbar" aria-hidden="true" />
      <h1 className="sr">London pop-ups</h1>
      <div className="mp-map">
        <Suspense fallback={<div className="mp-mapfill" aria-busy="true" aria-label="Loading the map" />}>
          <PopupMap ref={map} items={items} highlight={hl} onPin={onPin} me={near.pos} padding={padding} onAway={setAway} />
        </Suspense>
      </div>

      <TopBar floating menuOpen={menuOpen} onMenu={openMenu}>{phone ? null : modeSwitch}</TopBar>
      {phone ? (
        <div className="mp-chips" ref={chips}>
          <Filters inline near={nearOn} locating={near.state === 'asking'} onNear={onNear} onPick={openDeck} onAsk={openAsk} />
        </div>
      ) : null}

      {step === 'welcome' ? (
        <div className="mp-prompt mp-welcome" role="dialog" aria-label="Welcome to Spotted">
          <h2><Icon name="i-sparkle" />Welcome to Spotted</h2>
          <ul className="mp-welcome-list">
            <li><Icon name="i-map" /><span>Every pin is a pop-up in London, on now or coming soon.</span></li>
            <li><Icon name="i-check" /><span>Locals vote and check in, so you can see what is real.</span></li>
            <li><Icon name="i-plus" /><span>Know one we are missing? Add it.</span></li>
          </ul>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary sm" onClick={welcome.finish}>Explore the map</button>
            {askAvailable ? <button className="btn sm" onClick={() => { welcome.finish(); openAsk(); }}><Icon name="i-bolt" />Ask Spotted</button> : null}
            <button className="btn sm" onClick={() => { welcome.finish(); openDeck(); }}>Pick what you like</button>
          </div>
          <p className="fine"><Icon name="i-sparkle" /><span>Got ChatGPT or Claude? <Link to="/connect" onClick={welcome.finish}>Ask it about Spotted</Link></span></p>
        </div>
      ) : null}

      {step === 'location' ? (
        <div className="mp-prompt" role="dialog" aria-label="Share your location">
          <h2><Icon name="i-locate" />Pop-ups near you?</h2>
          <p>Share your location and we show what is on within 3 km, closest first.</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary sm" onClick={() => void near.request()}>Use my location</button>
            <button className="btn sm" onClick={near.dismissPrompt}>Not now</button>
          </div>
          <p className="fine"><Icon name="i-info" />Your location stays on this device.</p>
        </div>
      ) : null}

      {step === 'taste' ? (
        <div className="mp-prompt" role="dialog" aria-label="Pick what you like">
          <h2><Icon name="i-sparkle" />Pop-ups for you?</h2>
          <p>Swipe through 10 pop-ups. We put the ones you like first. You can always see everything.</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary sm" onClick={openDeck}>Start</button>
            <button className="btn sm" onClick={() => updateTaste(t => ({ ...t, seen: true }))}>Not now</button>
          </div>
          <p className="fine"><Icon name="i-info" />{keptNote}</p>
        </div>
      ) : null}

      <MapSheet phone={phone} snap={snap} onSnap={goSnap} onVisible={setVisible} header={header} collapsed={!panelOpen && view === 'map'}>{body}</MapSheet>
      {!phone && view === 'map' && !panelOpen ? (
        <button type="button" className="btn mp-reopen" onClick={() => setPanelOpen(true)}><Icon name="i-list" />Show list<span className="mp-reopen-n">{q.isPending ? '' : items.length}</span></button>
      ) : null}

      {deck ? <Suspense fallback={null}><TasteDeck items={q.all ?? []} fresh={deck === 'retake'} onClose={() => { setDeck(null); if (getTaste().swipes === 0) toast('Tap For you any time to pick what you like.', 'i-sparkle'); }} /></Suspense> : null}
      {askMounted ? (
        <Suspense fallback={null}>
          {/* Your position is used here only to put the nearest first. It is never sent. */}
          <AskChat items={q.all ?? []} nearPos={near.pos} onOpen={open} />
        </Suspense>
      ) : null}

      <div className="mp-fabs">
        {askAvailable ? (
          <button type="button" id="ask-fab" className="mp-fab ask" aria-label="Ask Spotted" aria-expanded={asked.open} onClick={openAsk}>
            <Icon name="i-bolt" />{asked.unseen ? <><span className="dot" aria-hidden="true" /><span className="sr">, new answer</span></> : null}
          </button>
        ) : null}
        <button type="button" className="mp-fab loc" aria-label={near.pos ? 'Back to my location' : 'Show my location'} onClick={onLocate}>
          {near.state === 'asking' ? <span className="spin" /> : <Icon name="i-locate" />}
          <span className="mp-tip">Back to you</span>
        </button>
        <Link to="/add" className="mp-fab add" aria-label="Add a pop-up"><Icon name="i-plus" /></Link>
      </div>
    </div>
  );
}

function ModeSwitch({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <div className="mp-mode" data-view={view} role="group" aria-label="Display mode">
      <span className="mp-thumb" aria-hidden="true" />
      <button type="button" aria-pressed={view === 'map'} onClick={() => onView('map')}><Icon name="i-map" />Map</button>
      <button type="button" aria-pressed={view === 'list'} onClick={() => onView('list')}><Icon name="i-list" />List</button>
    </div>
  );
}

function MiniSkeletons() {
  return (
    <div className="mp-minis" aria-busy="true" aria-label="Loading pop-ups">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="mini skc" aria-hidden="true"><div className="sw sk" /><span style={{ flex: 1 }} className="sk-block"><span className="sk skl" style={{ width: '80%' }} /><span className="sk skl" style={{ width: '50%' }} /></span></div>
      ))}
    </div>
  );
}
