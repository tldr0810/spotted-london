import { useEffect, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { MY_STATE_KEY, patchMe, patchPopup, prefetchPopup } from '../lib/cache';
import { CATS, catIcon, dateRange, distance, isLive, meterClass, startsTomorrow } from '../lib/format';
import { useErrorToast, useMe, useRequireAuth, useSheet, useToast } from '../lib/hooks';
import { hasLocalSave, localSaveIds, setLocalSave } from '../lib/local-saves';
import { bump, haptic } from '../lib/motion';
import { Icon } from './Icon';

export function StatusTag({ status, sourceChecked, className = '' }: { status: Popup['status']; sourceChecked?: boolean; className?: string }) {
  if (status === 'community' && sourceChecked) return <span className={`tag t-src ${className}`}><Icon name="i-check" />Source checked</span>;
  switch (status) {
    case 'verified_admin': return <span className={`tag t-ink ${className}`}><Icon name="i-shield" />Verified</span>;
    case 'verified_community': return <span className={`tag t-eng ${className}`}><Icon name="i-checkc" />Community verified</span>;
    case 'community': return <span className={`tag t-watch ${className}`}>Being checked</span>;
    case 'pending': return <span className={`tag t-mute ${className}`}>Waiting for review</span>;
    case 'hidden': return <span className={`tag t-err ${className}`}>Hidden</span>;
    case 'removed': return <span className={`tag t-err ${className}`}>Removed</span>;
    case 'ended': return <span className={`tag t-mute ${className}`}>Ended</span>;
  }
}

export function Meter({ value, big }: { value: number; big?: boolean }) {
  return (
    <div className={`meter ${meterClass(value)} ${big ? 'big' : ''}`} role="img" aria-label={`Confidence ${Math.round(value * 100)}%`}>
      <i style={{ width: `${Math.max(4, value * 100)}%` }} />
    </div>
  );
}

/** Cover photo, or the category's pattern and icon when there is no photo yet. */
export function Cover({ p, className }: { p: Pick<Popup, 'category' | 'cover_url'>; className: string }) {
  return (
    <div className={`${className} pat-${p.category}`} style={p.cover_url ? { '--cover': `url("${p.cover_url}")` } as CSSProperties : undefined}>
      {p.cover_url ? <Img src={p.cover_url} /> : <Icon name={catIcon(p.category)} className="i big" />}
    </div>
  );
}

/** A photo that fades in once it has loaded, over the category pattern. */
export function Img({ src }: { src: string }) {
  return <img src={src} alt="" loading="lazy" decoding="async" className="fade" onLoad={shown} onError={hideBroken}
    ref={el => { if (el?.complete && el.naturalWidth) el.classList.add('in'); }} />;
}
const shown = (e: { currentTarget: HTMLImageElement }) => e.currentTarget.classList.add('in');

/** A photo that fails to load is hidden, so the category pattern shows instead of a broken image. */
export const hideBroken = (e: { currentTarget: HTMLImageElement }) => { e.currentTarget.style.display = 'none'; };

/** True once `value` differs from what it was when the component mounted. */
export function useChanged<T>(value: T) {
  const first = useRef(value);
  return value !== first.current;
}

/** A number that rolls up or down when it changes. */
export function Ticker({ value }: { value: number }) {
  const prev = useRef(value);
  const dir = value > prev.current ? 'up' : value < prev.current ? 'down' : '';
  useEffect(() => { prev.current = value; }, [value]);
  return <span className="tick num"><span key={value} className={dir}>{value}</span></span>;
}

/**
 * Save and quality votes. Both show the new state at once in every list and sheet, then undo
 * it if the server says no. Signed out, a save is kept on this device (no sheet, no account needed) and moves
 * to the account at sign in; a vote asks for sign in on the spot and is finished when they are back.
 */
export function usePopupActions(p: Popup) {
  const qc = useQueryClient();
  const toast = useToast();
  const onError = useErrorToast();
  const requireAuth = useRequireAuth();
  const { data: me } = useMe();
  const save = useMutation({
    scope: { id: `save-${p.id}` },
    mutationFn: (on: boolean) => api(`/popups/${p.id}/save`, { method: on ? 'PUT' : 'DELETE', json: on ? {} : undefined }),
    onMutate: on => { haptic(); return patchMe(qc, p.id, { saved: on }); },
    onSuccess: (_d, on) => toast(on ? "Saved. We'll remind you the day before." : 'Removed from saved', 'i-bookmark'),
    onError: (e, _on, undo) => { undo?.(); onError(e); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ['saves'] }); qc.invalidateQueries({ queryKey: MY_STATE_KEY, refetchType: 'none' }); },
  });
  const quality = useMutation({
    scope: { id: `quality-${p.id}` },
    mutationFn: (value: number) => api<{ popup: Popup }>(`/popups/${p.id}/vote`, { method: 'PUT', json: { kind: 'quality', value } }),
    onMutate: value => {
      haptic();
      const prev = p.me?.quality_vote ?? 0;
      const undoScore = patchPopup(qc, p.id, x => ({ ...x, score: x.score + value - prev }));
      const undoMe = patchMe(qc, p.id, { quality_vote: value });
      return () => { undoMe(); undoScore(); };
    },
    onSuccess: d => { patchPopup(qc, p.id, x => ({ ...x, score: d.popup.score })); },
    onError: (e, _v, undo) => { undo?.(); onError(e); },
  });
  return {
    toggleSave: (e?: { currentTarget: Element }) => {
      bump(e?.currentTarget);
      if (me) return save.mutate(!p.me?.saved);
      // Not signed in (or the account is still loading, in which case Shell moves it over a moment later)
      const on = !hasLocalSave(p.id);
      const first = on && localSaveIds().length === 0; // the first one says where it went
      haptic();
      setLocalSave(p.id, on);
      toast(on ? (first ? 'Saved on this device. Sign in to keep it and get a reminder.' : 'Saved on this device') : 'Removed from saved', 'i-bookmark');
    },
    voteQuality: requireAuth((v: number, el?: Element) => { bump(el); quality.mutate(p.me?.quality_vote === v ? 0 : v); }, 'Sign in to vote', { then: 'vote', intent: (v: number, _el?: Element) => ({ type: 'quality', id: p.id, value: v }) }),
  };
}

export function ScoreVotes({ p }: { p: Popup }) {
  const { voteQuality } = usePopupActions(p);
  const mine = p.me?.quality_vote ?? 0;
  return (
    <div className="score">
      <button className="vote" aria-pressed={mine === 1} aria-label="Upvote" onClick={e => { e.stopPropagation(); voteQuality(1, e.currentTarget); }}><Icon name="i-up" /></button>
      <Ticker value={p.score} />
      <button className="vote" aria-pressed={mine === -1} aria-label="Downvote" onClick={e => { e.stopPropagation(); voteQuality(-1, e.currentTarget); }}><Icon name="i-down" /></button>
    </div>
  );
}

export function PopupCard({ p, i = 0 }: { p: Popup; i?: number }) {
  const { open } = useSheet();
  const qc = useQueryClient();
  const { toggleSave } = usePopupActions(p);
  const live = isLive(p);
  const warm = () => prefetchPopup(qc, p.slug);
  return (
    <article className="card" style={{ '--i': Math.min(i, 8) } as CSSProperties}>
      <div className={`thumb pat-${p.category}`}>
        {p.cover_url ? <Img src={p.cover_url} /> : <Icon name={catIcon(p.category)} className="i big" />}
        <span className="tag cattag">{CATS[p.category]}</span>
        {live ? <span className="tag t-new live">On now</span> : startsTomorrow(p) ? <span className="tag t-out live">Tomorrow</span> : null}
        <button className="save" aria-pressed={!!p.me?.saved} aria-label={p.me?.saved ? 'Remove from saved' : 'Save'} onClick={toggleSave}><Icon name="i-bookmark" /></button>
      </div>
      <div className="cbody">
        <div className="row" style={{ gap: 6 }}><StatusTag status={p.status} sourceChecked={p.source_checked} />{p.example ? <span className="tag t-sim">Example</span> : null}</div>
        <h3><Link className="stretch" to={`/p/${p.slug}`} onPointerEnter={warm} onPointerDown={warm} onClick={e => { e.preventDefault(); open(p.slug, e.currentTarget.closest('.card')?.querySelector('.thumb')); }}>{p.title}</Link></h3>
        <div className="meta"><Icon name="i-pin" /><span className="t">{[p.location.borough, p.host].filter(Boolean).join(' · ')}{p.distance_m !== undefined ? ` · ${distance(p.distance_m)}` : ''}</span></div>
        <div className="meta"><Icon name="i-clock" /><span className="t num">{dateRange(p)}</span></div>
      </div>
      <div className="cfoot">
        <span className="small muted num">{Math.round(p.verification.confidence * 100)}% real</span>
        <Meter value={p.verification.confidence} />
        <ScoreVotes p={p} />
      </div>
    </article>
  );
}

/** Placeholder cards with the same layout as the real ones, so nothing jumps when they land. */
export function CardSkeletons({ n = 6 }: { n?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="Loading pop-ups">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card skc" aria-hidden="true">
          <div className="thumb sk" />
          <div className="cbody"><div className="sk skl pill" /><div className="sk skl h" style={{ width: '78%' }} /><div className="sk skl" style={{ width: '60%' }} /><div className="sk skl" style={{ width: '45%' }} /></div>
          <div className="cfoot"><div className="sk skl" style={{ flex: 1 }} /></div>
        </div>
      ))}
    </div>
  );
}
