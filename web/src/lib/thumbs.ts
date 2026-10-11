// Small copies of photos for lists, made in the browser (the Worker has no CPU to resize on the free plan).
// A pop-up's poster makes one when they upload a photo. The admin's browser makes the rest: photos the Scouts
// copied from the web, and the ones from before this existed. Lists use the small copy once it is stored.

import { useEffect } from 'react';
import { api } from './api';
import { compressImage } from './image';

const THUMB_EDGE = 640; // a card shows a photo about 100 to 260 px wide, so this is sharp on a 2x or 3x screen
const THUMB_MAX_BYTES = 150_000; // what the server accepts
/** Photos the admin's browser makes by itself each time the app opens. A bigger backlog waits for the button on /admin/agent. */
const AUTO_MAX = 12;

/** Shrinks `source` and stores it as the small copy of one photo. */
export async function makeThumb(popupId: string, imageId: string, source: Blob) {
  const blob = await compressImage(source, { maxEdge: THUMB_EDGE, maxBytes: THUMB_MAX_BYTES });
  await api(`/popups/${popupId}/images/${imageId}/thumb`, { method: 'PUT', body: blob, headers: { 'content-type': blob.type } });
}

interface Needing { items: { id: string; popup_id: string; url: string }[]; next: string | null; left: number | null }
export const thumbsLeft = () => api<Needing>('/admin/images/needing-thumbs?limit=1').then(r => r.left ?? 0);

/**
 * Makes thumbnails one at a time, at most `max`. A photo that cannot be read is counted as failed and passed over.
 * `stop` is checked between photos.
 */
export async function runThumbs({ max = Infinity, stop, onProgress }: { max?: number; stop?: () => boolean; onProgress?: (made: number, failed: number) => void } = {}) {
  let after = '', made = 0, failed = 0;
  while (made + failed < max && !stop?.()) {
    const page = await api<Needing>(`/admin/images/needing-thumbs?limit=${Math.min(4, max - made - failed)}&after=${encodeURIComponent(after)}`);
    for (const it of page.items) {
      if (stop?.()) return { made, failed };
      try {
        const res = await fetch(it.url);
        if (!res.ok) throw new Error('not found');
        await makeThumb(it.popup_id, it.id, await res.blob());
        made++;
      } catch { failed++; }
      onProgress?.(made, failed);
    }
    if (!page.next) break;
    after = page.next;
  }
  return { made, failed };
}

/** For the admin: a few new photos get their small copy whenever the app is open, so nobody has to remember. */
export function useAutoThumbs(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    const t = setTimeout(async () => {
      try {
        const left = await thumbsLeft();
        if (left > 0 && left <= AUTO_MAX) await runThumbs({ max: AUTO_MAX, stop: () => stopped });
      } catch { /* optional: lists fall back to the full photo */ }
    }, 6000); // after the page has settled
    return () => { stopped = true; clearTimeout(t); };
  }, [on]);
}
