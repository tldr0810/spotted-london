import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Popup } from '../lib/api';
import { CATS, catIcon, dateRange, isLive } from '../lib/format';
import { haptic, reducedMotion } from '../lib/motion';
import { getTaste, updateTaste, useKeptNote } from '../lib/taste';
import { DECK_SIZE, forgetSwipes, learn, likedCategories, pickDeck, type Taste } from '../../../src/shared/taste';
import { Icon } from './Icon';
import { Img } from './PopupBits';

type Dir = 'yes' | 'no' | 'skip';
const THROW = 90; // px of drag that counts as an answer
const FLY_MS = 220;

/**
 * The first-run swipe: ten real pop-ups, one at a time. Right (or the tick) means "I'd go", left (or the cross)
 * means "not for me", Skip means "no opinion". Each answer goes straight into the taste kept on this device, and on the account when someone is signed in.
 * `fresh` (Retake) forgets the old swipes (not what saves and votes are worth) when the first new one comes in, so closing early changes nothing.
 */
export function TasteDeck({ items, fresh, onClose }: { items: Popup[]; fresh: boolean; onClose: () => void }) {
  const deck = useMemo(() => pickDeck(items, Date.now(), DECK_SIZE), []); // eslint-disable-line react-hooks/exhaustive-deps -- one deck per opening
  const [i, setI] = useState(0);
  const [drag, setDrag] = useState(0);
  const [fly, setFly] = useState<Dir | null>(null);
  const [result, setResult] = useState<Taste | null>(null);
  const kept = useKeptNote();
  const start = useRef<{ x: number; t: number } | null>(null);
  const cleared = useRef(!fresh);
  const answered = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const done = i >= deck.length;

  const finish = (answers: number) => {
    // Nothing answered: leave the taste as it was, and do not offer the intro again.
    updateTaste(t => ({ ...t, seen: true, on: answers > 0 ? true : t.on }));
    setResult(answers > 0 ? getTaste() : null);
  };
  const answer = (dir: Dir) => {
    const p = deck[i];
    if (!p || fly) return;
    haptic(dir === 'skip' ? 4 : 8);
    if (dir !== 'skip') {
      answered.current++;
      updateTaste(t => {
        const base = cleared.current ? t : forgetSwipes(t); // Retake: old swipes go, saves and votes still count
        cleared.current = true;
        return learn(base, p, dir === 'yes');
      });
    }
    const next = () => { setFly(null); setDrag(0); setI(n => n + 1); if (i + 1 >= deck.length) finish(answered.current); };
    if (reducedMotion()) return next();
    setFly(dir);
    setTimeout(next, FLY_MS);
  };

  const close = () => {
    if (!done && !result) updateTaste(t => ({ ...t, seen: true }));
    onClose();
  };

  // Keyboard: arrows answer, Escape closes, Tab stays inside.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-first]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close();
      if (e.key === 'Tab') {
        const f = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
        if (!f.length) return;
        const at = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
        return;
      }
      if (done) return;
      if (e.key === 'ArrowRight') answer('yes');
      else if (e.key === 'ArrowLeft') answer('no');
      else if (e.key === 'ArrowDown') answer('skip');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // every render: the handlers read the current card

  const down = (e: PointerEvent) => {
    if (fly) return;
    start.current = { x: e.clientX, t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => { if (start.current) setDrag(e.clientX - start.current.x); };
  const up = () => {
    const s = start.current;
    if (!s) return;
    start.current = null;
    const v = drag / Math.max(1, performance.now() - s.t); // px per ms
    if (Math.abs(drag) > THROW || Math.abs(v) > 0.6 && Math.abs(drag) > 30) answer(drag > 0 ? 'yes' : 'no');
    else setDrag(0);
  };

  const p = deck[i], after = deck[i + 1];
  const x = fly === 'yes' ? 520 : fly === 'no' ? -520 : drag;
  const lean = Math.max(-1, Math.min(1, x / 160));
  const liked = result ? likedCategories(result) : [];

  return (
    <div className="td-wrap" role="dialog" aria-modal="true" aria-label="Pick what you like" ref={box}>
      <div className="td-head">
        <div>
          <b>{done ? (deck.length ? 'All done' : 'Pick what you like') : 'Pick what you like'}</b>
          {!done ? <small>Swipe right if you would go, left if not</small> : null}
        </div>
        <button type="button" className="mp-x" aria-label="Close" onClick={close} data-first={done ? '' : undefined}><Icon name="i-x" /></button>
      </div>

      {!deck.length ? (
        <div className="td-end"><Icon name="i-sparkle" className="i big" /><h2>Not enough pop-ups yet</h2><p>Come back when more are on. You can still use the filters.</p><button type="button" className="btn primary" onClick={onClose} data-first>Close</button></div>
      ) : done ? (
        <div className="td-end">
          <Icon name="i-sparkle" className="i big" />
          {liked.length ? (
            <>
              <h2>Here is what you like</h2>
              <div className="chips td-liked">{liked.map(c => <span key={c} className="tag t-out"><Icon name={catIcon(c as Popup['category'])} />{CATS[c as Popup['category']]}</span>)}</div>
              <p>Your list now starts with these. Everything else is still one tap away.</p>
            </>
          ) : (
            <>
              <h2>No favourites yet</h2>
              <p>That is fine. We will keep showing everything, and learn from what you save. Tap For you any time to pick again.</p>
            </>
          )}
          <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
            <button type="button" className="btn primary" onClick={onClose} data-first>{liked.length ? 'Show my picks' : 'Show everything'}</button>
          </div>
          <p className="td-kept">{kept}</p>
        </div>
      ) : (
        <>
          <div className="td-prog" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={deck.length} aria-valuenow={i}><i style={{ width: `${(i / deck.length) * 100}%` }} /></div>
          <div className="td-stage">
            {after ? <TasteCard key={after.id} p={after} behind /> : null}
            <TasteCard key={p.id} p={p}
              style={{ transform: `translateX(${x}px) rotate(${lean * 9}deg)`, transition: start.current ? 'none' : `transform ${fly ? FLY_MS : 180}ms var(--ease-out)` }}
              lean={lean} onDown={down} onMove={move} onUp={up} />
          </div>
          <div className="td-btns">
            <button type="button" className="td-b no" aria-label="Not for me" onClick={() => answer('no')} data-first><Icon name="i-x" /><span>Not for me</span></button>
            <button type="button" className="btn sm subtle" onClick={() => answer('skip')}>Skip</button>
            <button type="button" className="td-b yes" aria-label="I would go" onClick={() => answer('yes')}><Icon name="i-check" /><span>I would go</span></button>
          </div>
          <p className="td-count" aria-live="polite">{i + 1} of {deck.length}</p>
        </>
      )}
    </div>
  );
}

function TasteCard({ p, behind, style, lean = 0, onDown, onMove, onUp }: {
  p: Popup; behind?: boolean; style?: CSSProperties; lean?: number;
  onDown?: (e: PointerEvent) => void; onMove?: (e: PointerEvent) => void; onUp?: () => void;
}) {
  const price = p.price.type === 'free' ? 'Free' : p.price.text || null;
  return (
    <article className={`td-card ${behind ? 'behind' : ''}`} style={style} aria-hidden={behind} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className={`td-pic pat-${p.category}`} style={p.cover_url ? { '--cover': `url("${p.cover_url}")` } as CSSProperties : undefined}>
        {p.cover_url ? <Img src={p.cover_url} fit /> : <Icon name={catIcon(p.category)} className="i big" />}
        <span className="tag cattag">{CATS[p.category]}</span>
        {isLive(p) ? <span className="tag t-new live">On now</span> : null}
        <span className="td-stamp yes" style={{ opacity: Math.max(0, lean) }}>I would go</span>
        <span className="td-stamp no" style={{ opacity: Math.max(0, -lean) }}>Not for me</span>
      </div>
      <div className="td-body">
        <h3>{p.title}</h3>
        <div className="meta"><Icon name="i-pin" /><span className="t">{[p.location.borough, p.host].filter(Boolean).join(' · ') || 'London'}</span></div>
        <div className="meta"><Icon name="i-clock" /><span className="t num">{dateRange(p)}</span></div>
        {price ? <div className="meta"><Icon name="i-pound" /><span className="t">{price}</span></div> : null}
      </div>
    </article>
  );
}
