import { useEffect, useRef, useState, type ReactNode } from 'react';
import { resyncService, useService } from '../state/bridge';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { SITE, USERS } from '../data/seed';
import { resetAll } from '../lib/persist';
import { AlertPopups } from './AlertPopups';
import { canConfigure, isAdmin, isOpen, sessionStore, toast, useAlerts, useCameras, useMe, useRules, useSession } from '../state/store';
import { isActiveRule } from '../lib/usecases';
import { Icon, Logo, type IconName } from './Icon';
import { useConfirm } from './ui';
import './Shell.css';

const notInDemo = (_what: string) => toast('Not part of this demo');

/** The screens of the app, in the order the tab bar shows them. `short` is the bottom bar's label on a phone. */
type Tab = { to: string; label: string; short?: string; icon: IconName; end?: boolean; admin?: boolean; phone?: boolean };
const TABS: Tab[] = [
  { to: '/', label: 'Overview', icon: 'dash', end: true, phone: true },
  { to: '/wall', label: 'Video Wall', short: 'Wall', icon: 'wall', phone: true },
  { to: '/alerts', label: 'Alerts', icon: 'bell', phone: true },
  { to: '/cameras', label: 'Cameras', icon: 'cctv', phone: true },
  { to: '/rules', label: 'Rules', icon: 'rule' },
  { to: '/configuration', label: 'Configuration', short: 'Set-up', icon: 'wrench', admin: true },
];

const isOn = (t: Tab, pathname: string) => (t.end ? pathname === t.to : pathname === t.to || pathname.startsWith(`${t.to}/`));

export function Shell() {
  const me = useMe();
  const [profile, setProfile] = useState(false);
  const [bell, setBell] = useState(false);
  const [palette, setPalette] = useState(false);
  // ⌘K / Ctrl+K anywhere opens the command palette, as in most modern apps; "/" too, when not typing in a field.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.closest('input, textarea, select, [contenteditable="true"]') !== null);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <div className="app">
      <TopNav onBell={() => setBell(true)} onProfile={() => setProfile((v) => !v)} onSearch={() => setPalette(true)} />
      <div className="main">
        <main className="content">
          <Outlet />
        </main>
      </div>
      <BottomNav onMore={() => setPalette(true)} />

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {profile && <ProfileMenu onClose={() => setProfile(false)} />}
      {bell && <NotificationsDrawer onClose={() => setBell(false)} />}
      <AlertPopups />
      <span className="sr-only">Signed in as {me.name}, {me.role}</span>
    </div>
  );
}

/** The bar at the top: name, the screens as tabs (the open one underlined), search, alerts and the signed-in person. */
function TopNav({ onBell, onProfile, onSearch }: { onBell: () => void; onProfile: () => void; onSearch: () => void }) {
  const me = useMe();
  const alerts = useAlerts();
  const { pathname } = useLocation();
  const mine = alerts.filter((a) => isOpen(a) && a.deliveries.some((d) => d.to === me.id)).length;
  const open = alerts.filter(isOpen).length;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header className="nav">
      <Link to="/" className="nav__brand" aria-label="GYTWorkz, Overview" title="Overview">
        <Logo size={30} />
      </Link>
      <nav className="nav__tabs" aria-label="Screens">
        {TABS.filter((t) => !t.admin || canConfigure(me)).map((t) => {
          const on = isOn(t, pathname);
          return (
            <Link key={t.to} to={t.to} title={t.label} className={`nav__tab${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
              {t.to === '/alerts' && open > 0 && <span className="nav__count">{open > 99 ? '99+' : open}</span>}
            </Link>
          );
        })}
      </nav>
      <span className="spacer" />
      <button type="button" className="nav__search" onClick={onSearch} aria-label="Search cameras, rules, alerts and screens" aria-keyshortcuts="Meta+K Control+K">
        <Icon name="search" size={17} />
        <span className="nav__search-text">Search</span>
        <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <button type="button" className="nav__icon" onClick={onBell} aria-label={`Notifications${mine ? `, ${mine} open alerts sent to you` : ''}`} title="Notifications">
        <Icon name="bell" size={20} />
        {mine > 0 && <span className="nav__badge">{mine > 99 ? '99+' : mine}</span>}
      </button>
      <button type="button" className="nav__user" onClick={onProfile} aria-label={`Signed in as ${me.name}, ${me.role}`}>
        <span className="nav__who">
          <strong>{me.name}</strong>
          <span>{me.role}</span>
        </span>
        <span className="nav__avatar">
          {me.name
            .split(' ')
            .map((p) => p[0])
            .join('')}
        </span>
      </button>
    </header>
  );
}

/** On a phone the tabs move to the bottom, in thumb reach; the rest of the screens are one tap away in the palette. */
function BottomNav({ onMore }: { onMore: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav className="bnav" aria-label="Screens">
      {TABS.filter((t) => t.phone).map((t) => {
        const on = isOn(t, pathname);
        return (
          <Link key={t.to} to={t.to} className={`bnav__tab${on ? ' is-on' : ''}`} aria-current={on ? 'page' : undefined}>
            <Icon name={t.icon} size={22} />
            <span>{t.short ?? t.label}</span>
          </Link>
        );
      })}
      <button type="button" className="bnav__tab" onClick={onMore}>
        <Icon name="more" size={22} />
        <span>More</span>
      </button>
    </nav>
  );
}

type Hit = { key: string; group: string; label: string; detail?: string; icon: IconName; run: () => void };

/** ⌘K: one box to jump anywhere. Screens, cameras, rules and recent alerts, filtered as you type; arrows and Enter to pick. */
function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const me = useMe();
  const cams = useCameras();
  const rules = useRules();
  const alerts = useAlerts();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const admin = canConfigure(me);
  const go = (to: string) => () => {
    nav(to);
    onClose();
  };
  useEffect(() => input.current?.focus(), []);

  const all: Hit[] = [
    ...TABS.filter((t) => !t.admin || admin).map((t) => ({ key: `tab${t.to}`, group: 'Screens', label: t.label, icon: t.icon, run: go(t.to) })),
    { key: 'tab/m', group: 'Screens', label: 'Phone view', icon: 'mobile', run: go('/m') },
    ...(admin
      ? [
          { key: 'new-camera', group: 'Actions', label: 'Add a camera', icon: 'camera-plus' as IconName, run: go('/cameras/new') },
          { key: 'new-rule', group: 'Actions', label: 'New rule', icon: 'add-circle' as IconName, run: go('/rules/new') },
          { key: 'new-wall', group: 'Actions', label: 'New video wall', icon: 'wall' as IconName, run: go('/configuration/walls') },
        ]
      : []),
    ...cams.map((c) => ({ key: `cam${c.id}`, group: 'Cameras', label: `${c.id} · ${c.name}`, detail: c.source ? 'Live' : undefined, icon: 'cctv' as IconName, run: go(admin ? `/cameras/${c.id}` : '/cameras') })),
    ...rules.filter(isActiveRule).map((r) => ({ key: `rule${r.id}`, group: 'Rules', label: `${r.id} · ${r.name}`, icon: 'rule' as IconName, run: go(admin ? `/rules/${r.id}` : '/rules') })),
    ...alerts
      .filter(isOpen)
      .slice(0, 40)
      .map((a) => ({ key: `alert${a.id}`, group: 'Open alerts', label: `${a.id} · ${a.title}`, detail: `${a.cameraId} · ${a.priority}`, icon: 'warning' as IconName, run: go(`/alerts/${a.id}`) })),
  ];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (words.length ? all.filter((h) => words.every((w) => `${h.label} ${h.detail ?? ''} ${h.group}`.toLowerCase().includes(w))) : all.filter((h) => h.group !== 'Cameras' && h.group !== 'Rules')).slice(0, 60);
  const at = Math.min(sel, Math.max(0, hits.length - 1));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  return (
    <>
      <div className="cmdk-scrim" onClick={onClose} />
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search">
        <div className="cmdk__box">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            placeholder="Jump to a screen, camera, rule or alert…"
            aria-label="Search"
            aria-controls="cmdk-list"
            aria-activedescendant={hits[at] ? `cmdk-${hits[at].key}` : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel(Math.min(at + 1, hits.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel(Math.max(at - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                hits[at]?.run();
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk__list" id="cmdk-list" role="listbox" ref={list}>
          {hits.length === 0 && <div className="cmdk__empty">Nothing matches “{q}”</div>}
          {hits.map((h, i) => (
            <div key={h.key}>
              {(i === 0 || hits[i - 1].group !== h.group) && <div className="cmdk__group">{h.group}</div>}
              <button
                type="button"
                id={`cmdk-${h.key}`}
                data-i={i}
                role="option"
                aria-selected={i === at}
                className={`cmdk__item${i === at ? ' is-on' : ''}`}
                onMouseMove={() => setSel(i)}
                onClick={h.run}
              >
                <Icon name={h.icon} size={17} />
                <span className="cmdk__label">{h.label}</span>
                {h.detail && <span className="cmdk__detail">{h.detail}</span>}
              </button>
            </div>
          ))}
        </div>
        <div className="cmdk__foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
          <span><kbd>Enter</kbd> to open</span>
          <span className="cmdk__tip">Press <kbd>/</kbd> anywhere to search</span>
        </div>
      </div>
    </>
  );
}

function ProfileMenu({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const service = useService();
  const { live } = useSession();
  const nav = useNavigate();
  const confirm = useConfirm();
  return (
    <>
      <div className="click-away" onClick={onClose} />
      <div className="profile" role="menu">
        <div className="profile__head">
          <strong>{me.name}</strong>
          <span>{me.role}</span>
          <span className="meta">{SITE.name}</span>
          <span className={`bar__service${service.online ? ' is-on' : ''}`} title={service.online ? 'Connected to the detection service: real cameras and rules run for real.' : 'The detection service is not running. Sample data only. Start it with ./start.sh or backend/run.sh.'}>
            <span className="bar__live-dot" />
            {service.online ? 'Detection on' : 'Detection offline'}
          </span>
        </div>
        <div className="profile__label">Try another role</div>
        {USERS.map((u) => (
          <button
            key={u.id}
            type="button"
            role="menuitemradio"
            aria-checked={u.id === me.id}
            className="profile__item"
            onClick={() => {
              sessionStore.set((s) => ({ ...s, userId: u.id }));
              onClose();
            }}
          >
            <span className={`profile__radio${u.id === me.id ? ' is-on' : ''}`} />
            <span className="stack" style={{ gap: 0 }}>
              <span>{u.name}</span>
              <span className="meta">{u.role}</span>
            </span>
          </button>
        ))}
        <div className="profile__sep" />
        <button type="button" className="profile__item" role="menuitem" onClick={() => sessionStore.set((s) => ({ ...s, live: !s.live }))}>
          <Icon name={live ? 'pause' : 'play'} size={18} />
          {live ? 'Pause live events' : 'Resume live events'}
        </button>
        <button
          type="button"
          className="profile__item"
          role="menuitem"
          onClick={() =>
            confirm.ask(
              { title: 'Reset the prototype?', message: 'Cameras, zones, rules, walls and alerts go back to the sample data.', action: 'Reset sample data' },
              () => {
                const keepUser = me.id;
                resetAll();
                resyncService();
                sessionStore.set((s) => ({ ...s, userId: keepUser }));
                onClose();
                nav('/');
              },
            )
          }
        >
          <Icon name="refresh" size={18} />
          Reset sample data
        </button>
        {confirm.dialog}
      </div>
    </>
  );
}

// The alerts panel the bell opens: action reviews and closures, repeated as you scroll.
type QNote = { title: string; id?: string; owner: string; source: string; closure?: boolean };
const NOTES: QNote[] = [
  { title: 'Action Review ACT/1026/7480', id: 'ACT/1026/7480', owner: 'Martin Debeloz', source: '' },
  { title: 'Action Review ACT/1026/7392', id: 'ACT/1026/7392', owner: 'Karthik M', source: 'OBR/1026/4429' },
  { title: 'Action Review ACT/1026/7457', id: 'ACT/1026/7457', owner: 'Karthik M', source: 'OBR/1026/4440' },
  { title: 'Action Close ACT/1026/7472', owner: 'Martin Debeloz', source: 'OBR/1026/4442', closure: true },
  { title: 'Action Review ACT/1026/7408', id: 'ACT/1026/7408', owner: 'Karthik M', source: '' },
];

function NotificationsDrawer({ onClose }: { onClose: () => void }) {
  const [rounds, setRounds] = useState(3);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <>
      <div className="qn-scrim" onClick={onClose} />
      <aside className="qn" role="dialog" aria-modal="true" aria-label="Alerts">
        <div className="qn__head">
          <span>2444 New Alert(s)</span>
          <button type="button" className="qn__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={24} stroke={1.8} />
          </button>
        </div>
        <label className="qn__all">
          <span>Select All</span>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        </label>
        <div
          className="qn__list"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) setRounds((n) => n + 2);
          }}
        >
          {Array.from({ length: rounds }, (_, r) =>
            NOTES.map((n, i) => (
              <article key={`${r}-${i}`} className={`qn__item${all ? ' is-picked' : ''}`}>
                <button type="button" className="qn__more" aria-label="More" onClick={() => notInDemo('Alert actions')}>
                  <span className="qn__dots" />
                </button>
                <h3>{n.title}</h3>
                <p>
                  {n.closure ? (
                    <>
                      This is a notification regarding an <strong>assigned action closure</strong> for below action details.
                    </>
                  ) : (
                    'Please find the below details of the Action.'
                  )}
                </p>
                <p className="qn__facts">
                  Action ID: {n.id ? <a href={`#/${n.id}`} onClick={(e) => e.preventDefault()}>{n.id}</a> : '<>'}
                  <br />
                  Action Owner: {n.owner}
                  <br />
                  Source Event ID: {n.source}
                </p>
                {n.closure && <p>If there are any issues or delays, kindly escalate the matter to the reporting manager,</p>}
              </article>
            )),
          )}
        </div>
      </aside>
    </>
  );
}

/** Banner for set-up screens when the signed-in role can only look. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  const me = useMe();
  if (isAdmin(me)) return null;
  return (
    <div className="readonly">
      <Icon name="info" size={18} />
      <span>
        {children} You are signed in as <strong>{me.role}</strong>. Switch to <strong>Safety admin</strong> in the profile menu to make changes.
      </span>
    </div>
  );
}
