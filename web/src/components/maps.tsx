// MapLibre + OpenFreeMap tiles (free, no API key). Loaded lazily; only map screens pay for it.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { AttributionControl, LngLatBounds, Map as MLMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Popup } from '../lib/api';
import { catIcon, isLive } from '../lib/format';
import { isAway, pinSetKey } from '../lib/map-home';
import { isPhone, reducedMotion } from '../lib/motion';
import type { IconName } from './Icon';

// MapLibre finds its worker relative to its own file, which breaks once bundled. Point it at
// the worker Vite builds for us instead.
setWorkerUrl(workerUrl);

/** Pins live outside React, so their icon is plain sprite markup. */
const iconMarkup = (name: IconName) => `<svg class="i" aria-hidden="true"><use href="#${name}"/></svg>`;

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const LONDON: [number, number] = [-0.1276, 51.5072];
const LONDON_BOUNDS: [[number, number], [number, number]] = [[-0.52, 51.28], [0.34, 51.7]];

interface MapOptions { zoomButtons?: boolean; attribution?: 'bottom-right' | 'bottom-left' }

function newMap(el: HTMLElement, center = LONDON, zoom = 11.3, { zoomButtons = true, attribution = 'bottom-right' }: MapOptions = {}) {
  const map = new MLMap({ container: el, style: STYLE, center, zoom, maxBounds: [[-0.9, 51.1], [0.7, 51.9]], attributionControl: false });
  map.addControl(new AttributionControl({ compact: true }), attribution);
  // Start folded to its (i) button; opened it would run into the buttons on top of the map.
  const fold = () => {
    const credit = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    credit?.removeAttribute('open');
    credit?.classList.remove('maplibregl-compact-show');
  };
  fold();
  map.once('load', fold);
  if (zoomButtons) map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  return map;
}

export interface PopupMapHandle { recenter(): void }
type Padding = { top: number; right: number; bottom: number; left: number };

/**
 * All pop-ups as pins, and you as a blue dot once you share your position. Tapping a pin calls onPin;
 * the highlighted one grows. `padding` keeps the middle of the map clear of the sheet or panel on top
 * of it. `onAway` says whether you have panned away from the dot.
 */
export const PopupMap = forwardRef<PopupMapHandle, {
  items: Popup[]; highlight: string | null; onPin: (p: Popup) => void;
  me: [number, number] | null; padding: Padding; onAway: (away: boolean) => void;
}>(function PopupMap({ items, highlight, onPin, me, padding, onAway }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef(new Map<string, { m: Marker; el: HTMLButtonElement; look: string }>());
  const dot = useRef<Marker | null>(null);
  const onPinRef = useRef(onPin);
  onPinRef.current = onPin;
  const onAwayRef = useRef(onAway);
  onAwayRef.current = onAway;
  const meRef = useRef(me);
  meRef.current = me;
  const padRef = useRef(padding);
  padRef.current = padding;
  const fitted = useRef(false);
  const away = useRef(false);

  useEffect(() => {
    const phone = isPhone();
    const m = newMap(el.current!, LONDON, 11.3, { zoomButtons: !phone, attribution: phone ? 'bottom-left' : 'bottom-right' });
    map.current = m;
    // You are "away" when your dot is far from the middle of the part of the map you can see.
    const check = () => {
      const you = meRef.current;
      if (!you) return;
      const pt = m.project([you[1], you[0]]), pad = padRef.current, c = m.getCanvas();
      const cx = (pad.left + c.clientWidth - pad.right) / 2, cy = (pad.top + c.clientHeight - pad.bottom) / 2;
      const now = isAway(pt.x - cx, pt.y - cy);
      if (now !== away.current) { away.current = now; onAwayRef.current(now); }
    };
    m.on('move', check);
    m.on('moveend', check);
    const ms = markers.current;
    return () => { ms.clear(); dot.current = null; m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current!;
    const seen = new Set<string>();
    let added = 0;
    for (const p of items) {
      seen.add(p.id);
      let entry = markers.current.get(p.id);
      const fresh = !entry;
      if (!entry) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', p.title);
        b.addEventListener('click', e => { e.stopPropagation(); onPinRef.current(p); });
        const mk = new Marker({ element: b }).setLngLat([p.location.lng, p.location.lat]).addTo(m);
        entry = { m: mk, el: b, look: '' };
        markers.current.set(p.id, entry);
      }
      // The list is rebuilt on every vote, save and clock tick: only touch a pin whose look changed, because
      // rewriting 600+ pins each time stalls a phone.
      const checked = p.status === 'community' && p.source_checked ? 'checked' : '';
      const live = isLive(p) ? 'live' : '';
      const look = `${p.category} ${p.status} ${checked} ${live}`;
      if (entry.look !== look) {
        entry.look = look;
        // New pins drop in one after another, but only the first few: 600 animations at once is the jank.
        const drop = fresh && added < 16;
        // Keep MapLibre's own class: it carries the position:absolute the marker transform relies on.
        entry.el.className = `maplibregl-marker pinm cc-${p.category} ${p.status} ${checked} ${live} ${drop ? 'in' : ''}`;
        entry.el.style.animationDelay = drop ? `${added * 25}ms` : '';
        entry.el.innerHTML = iconMarkup(catIcon(p.category)) + '<i class="pb"><svg class="i" aria-hidden="true"><use href="#i-check"/></svg></i>';
      }
      if (fresh) added++;
    }
    for (const [id, x] of markers.current) if (!seen.has(id)) { x.m.remove(); markers.current.delete(id); }
  }, [items]);

  // Your dot.
  useEffect(() => {
    const m = map.current!;
    if (!me) { dot.current?.remove(); dot.current = null; away.current = false; return; }
    if (!dot.current) {
      const d = document.createElement('div');
      d.className = 'mp-you';
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', 'You are here');
      d.innerHTML = '<i></i>';
      dot.current = new Marker({ element: d }).setLngLat([me[1], me[0]]).addTo(m);
    } else dot.current.setLngLat([me[1], me[0]]);
  }, [me]);

  // Fit the pins (and you) whenever the list changes or you first appear. The first fit is instant;
  // later ones glide so you can see where things went.
  const hasMe = !!me;
  // The list is rebuilt every minute with the same pins: only refit when the set of pins changes.
  const pinSet = useMemo(() => pinSetKey(items), [items]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const m = map.current!;
    const duration = fitted.current && !reducedMotion() ? (meRef.current ? 900 : 700) : 0;
    const pad = padRef.current, you = meRef.current;
    if (items.length || you) {
      const b = new LngLatBounds();
      if (you) {
        // Fit the pins with you in the middle, so the map does not start out looking panned away from you.
        let dx = 0.004, dy = 0.003;
        for (const p of items) { dx = Math.max(dx, Math.abs(p.location.lng - you[1])); dy = Math.max(dy, Math.abs(p.location.lat - you[0])); }
        b.extend([you[1] - dx, you[0] - dy]);
        b.extend([you[1] + dx, you[0] + dy]);
      } else items.forEach(p => b.extend([p.location.lng, p.location.lat]));
      m.fitBounds(b, { padding: pad, maxZoom: you ? 15 : 14, duration });
      fitted.current = true;
    } else {
      m.fitBounds(LONDON_BOUNDS, { padding: pad, duration });
    }
  }, [pinSet, hasMe]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sheet or panel moved: keep the middle of the map clear of it.
  useEffect(() => {
    map.current?.easeTo({ padding, duration: reducedMotion() ? 0 : 300 });
  }, [padding.top, padding.right, padding.bottom, padding.left]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ring is put back whenever pins are rebuilt; the map only glides when the highlight itself changes.
  useEffect(() => {
    for (const [id, x] of markers.current) x.el.classList.toggle('hl', id === highlight);
  }, [highlight, items]);
  useEffect(() => {
    const h = highlight && itemsRef.current.find(p => p.id === highlight);
    if (h && map.current) map.current.easeTo({ center: [h.location.lng, h.location.lat], padding: padRef.current, duration: reducedMotion() ? 0 : 400 });
  }, [highlight]);

  useImperativeHandle(ref, () => ({
    recenter() {
      const m = map.current, you = meRef.current;
      if (!m || !you) return;
      m.easeTo({ center: [you[1], you[0]], zoom: Math.max(m.getZoom(), 14), padding: padRef.current, duration: reducedMotion() ? 0 : 700 });
    },
  }), []);

  return <div className="ml" ref={el} />;
});

/** One draggable pin for the Add form. */
export function PinPicker({ lat, lng, onMove }: { lat: number; lng: number; onMove: (lat: number, lng: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const marker = useRef<Marker | null>(null);
  const map = useRef<MLMap | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    const m = newMap(el.current!, [lng, lat], 15.5);
    const pin = document.createElement('div');
    pin.className = 'pinm verified_admin cc-other';
    pin.style.setProperty('--cc', 'var(--accent)');
    pin.innerHTML = iconMarkup('i-pin');
    marker.current = new Marker({ element: pin, draggable: true }).setLngLat([lng, lat]).addTo(m);
    marker.current.on('dragend', () => { const p = marker.current!.getLngLat(); onMoveRef.current(p.lat, p.lng); });
    m.on('click', e => { marker.current!.setLngLat(e.lngLat); onMoveRef.current(e.lngLat.lat, e.lngLat.lng); });
    map.current = m;
    return () => { m.remove(); };
    // the map is created once; later moves are applied below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cur = marker.current?.getLngLat();
    if (!cur || (Math.abs(cur.lat - lat) < 1e-7 && Math.abs(cur.lng - lng) < 1e-7)) return;
    marker.current!.setLngLat([lng, lat]);
    map.current?.easeTo({ center: [lng, lat], duration: 300 });
  }, [lat, lng]);

  return <div className="minimap" ref={el} />;
}
