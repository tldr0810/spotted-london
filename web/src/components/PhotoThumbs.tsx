import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runThumbs, thumbsLeft } from '../lib/thumbs';
import { useErrorToast } from '../lib/hooks';

/**
 * Photos without a small copy make lists load the full photo (up to 5 MB each) for a card 100 px wide.
 * This makes the missing ones in this browser: each photo is downloaded once, shrunk and stored again. Best on Wi-Fi.
 */
export function PhotoThumbs() {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const left = useQuery({ queryKey: ['thumbs-left'], queryFn: thumbsLeft, staleTime: 30_000 });
  const [run, setRun] = useState<{ made: number; failed: number } | null>(null);
  const stopped = useRef(false);
  const busy = run !== null;

  const start = async () => {
    stopped.current = false;
    setRun({ made: 0, failed: 0 });
    try { await runThumbs({ stop: () => stopped.current, onProgress: (made, failed) => setRun({ made, failed }) }); }
    catch (e) { onError(e); }
    finally { setRun(null); qc.invalidateQueries({ queryKey: ['thumbs-left'] }); }
  };
  const n = left.data ?? 0;
  return (
    <section className="panel" style={{ marginTop: 22 }} aria-labelledby="th-h">
      <div className="row"><h2 id="th-h">Photo thumbnails</h2><span className="spacer" />
        {busy
          ? <button className="btn sm" onClick={() => { stopped.current = true; }}>Stop</button>
          : <button className="btn sm" disabled={!n} onClick={start}>Make thumbnails</button>}
      </div>
      <p className="muted" style={{ marginTop: 6 }} aria-live="polite">
        {busy ? `Made ${run.made}${run.failed ? `, ${run.failed} could not be read` : ''}. Keep this page open.`
          : left.isPending ? 'Counting.'
          : left.isError ? 'Could not count the photos. Reload the page to try again.'
          : n ? `${n} photo${n === 1 ? ' still loads' : 's still load'} at full size in lists. Run this on Wi-Fi: it downloads each one once, then stores a small copy. Lists pick the copies up within 10 minutes.`
          : 'Every photo has a small copy. New photos get one when they are posted, and the app makes the rest when you open it.'}
      </p>
    </section>
  );
}
