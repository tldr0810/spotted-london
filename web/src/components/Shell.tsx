import { useCallback, useEffect, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation, useOutletContext, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Popup } from '../lib/api';
import { useExit } from '../lib/motion';
import { useMe, useToast } from '../lib/hooks';
import { useTasteSync } from '../lib/taste';
import { useAfterSignIn } from '../lib/after-sign-in';
import { useLocalSaves } from '../lib/local-saves';
import { useAutoThumbs } from '../lib/thumbs';
import { GateProvider } from './SignInSheet';
import { NavMenu } from './NavMenu';
import { PopupSheet } from './PopupSheet';
import { TopBar } from './TopBar';

export { Logo } from './Logo';

const LOGIN_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign in was cancelled.',
  state_mismatch: 'Sign in timed out. Try again.',
  state_expired: 'Sign in timed out. Try again.',
  banned: 'This account is suspended.',
};

/** What pages get from the shell: the menu, so the home page can put its own bar over the map. */
export interface ShellContext { menuOpen: boolean; openMenu: () => void }
export const useShell = () => useOutletContext<ShellContext>();

export function Shell() {
  const { data: me } = useMe();
  useTasteSync();
  useAfterSignIn();
  useAutoThumbs(me?.role === 'admin');
  const localSaves = useLocalSaves();
  const loc = useLocation();
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const sheet = sp.get('p') ?? (loc.pathname.startsWith('/p/') ? decodeURIComponent(loc.pathname.slice(3)) : null);
  const [shownSheet, sheetLeaving] = useExit(sheet, 220);
  const home = loc.pathname === '/' || loc.pathname.startsWith('/p/');
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => { setMenuOpen(false); document.getElementById('mp-menubtn')?.focus({ preventScroll: true }); }, []);

  const saves = useQuery({ queryKey: ['saves'], queryFn: () => api<{ items: Popup[] }>('/me/saves'), enabled: !!me });
  const queue = useQuery({ queryKey: ['queue'], queryFn: () => api<{ items: Popup[] }>('/admin/queue'), enabled: me?.role === 'admin' });

  // Google sign in comes back with ?login_error=... when it fails.
  useEffect(() => {
    const err = sp.get('login_error');
    if (!err) return;
    toast(LOGIN_ERRORS[err] ?? 'Sign in did not finish. Try again.', 'i-info', true);
    const next = new URLSearchParams(sp); next.delete('login_error'); setSp(next, { replace: true });
  }, [sp, setSp, toast]);

  return (
    <GateProvider>
      <div className="shell" data-home={home}>
        {home ? null : <TopBar menuOpen={menuOpen} onMenu={openMenu} />}
        <main className={home ? 'mp-main' : 'page'}><Outlet context={{ menuOpen, openMenu } satisfies ShellContext} /></main>
        <NavMenu open={menuOpen} onClose={closeMenu} savedCount={me ? saves.data?.items.length ?? 0 : localSaves.length} queueCount={queue.data?.items.length ?? 0} isAdmin={me?.role === 'admin'} />

        {/* Each page keeps its own scroll position, so switching pages and back lands where you were. */}
        <ScrollRestoration getKey={l => l.pathname} />
        {shownSheet ? <PopupSheet key={shownSheet} slug={shownSheet} leaving={sheetLeaving} /> : null}
      </div>
    </GateProvider>
  );
}
