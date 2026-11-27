import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AckDialog } from '../../components/AlertDialogs';
import { Icon, Logo } from '../../components/Icon';
import { CameraView, Choice, Empty, looseMatch, Modal, PriorityBadge, Seg, StateChip, Switch, useConfirm } from '../../components/ui';
import { AREAS, TEAMS } from '../../data/seed';
import '../overview-gyt.css';
import './wall-gyt.css';
import type { Alert, Camera, PinnedLayout, Wall } from '../../data/types';
import { uid } from '../../lib/persist';
import { ago, hms, useNow } from '../../lib/time';
import { AREAS_BY_ID, canConfigure, deleteWall, isAdmin, isOpen, saveWall, TEAMS_BY_ID, toast, useActivity, useAlerts, useCameras, useMe, useWalls } from '../../state/store';
import { CastDialog } from './CastDialog';
import { LAYOUT_SLOTS, useWallModel, WallBody } from './WallBody';

export const NEW_WALL = '__new_wall__';

/** A new wall starts empty: no name, no cameras, equal-sized thumbnails. Nothing is saved until Save wall. */
export const newWall = (teamId: string): Wall => ({
  id: uid('w'),
  name: '',
  teamId,
  pinnedShare: 0,
  pinnedLayout: '2x2',
  pinned: [],
  rollingTiles: 9,
  rotation: [],
  rotateSec: 10,
  autoPinBusy: false,
  alertTakeover: true,
});

const LAYOUTS: { value: PinnedLayout; label: string }[] = [
  { value: '1', label: '1' },
  { value: '2x2', label: '2 × 2' },
  { value: '1+5', label: '1 + 5' },
  { value: '2x3', label: '2 × 3' },
  { value: '3x3', label: '3 × 3' },
];

export function useVisibleWalls() {
  const walls = useWalls();
  const me = useMe();
  return me.teamId === 't-hse' || isAdmin(me) ? walls : walls.filter((w) => w.teamId === me.teamId);
}

/** What the wall area shows: the wall itself, or a quick look at a set of cameras (an area, the alerting ones, the ones that are
 *  down, or a search). A quick look is paged by hand and can be saved as a wall of its own. */
type View = { kind: 'wall' } | { kind: 'area'; areaId: string } | { kind: 'alerting' } | { kind: 'offline' } | { kind: 'search'; q: string };

const RAIL_KEY = 'gyt-wall-rail';
function readRail() {
  if (typeof window !== 'undefined' && window.innerWidth < 900) return false;
  try {
    return localStorage.getItem(RAIL_KEY) !== 'closed';
  } catch {
    return true;
  }
}
const PRIO_RANK = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
const TILE_OPTIONS: Wall['rollingTiles'][] = [4, 9, 16, 25];

export function VideoWall() {
  const { wallId } = useParams();
  const nav = useNavigate();
  const me = useMe();
  const visible = useVisibleWalls();
  const cams = useCameras();
  const saved = visible.find((w) => w.id === wallId) ?? visible.find((w) => w.teamId === me.teamId) ?? visible[0];
  const alerts = useAlerts();
  const [ack, setAck] = useState<Alert>();
  const [focus, setFocus] = useState<Camera>();
  const [settings, setSettings] = useState(false);
  // Setting up works on a copy of the wall; nothing changes until Save wall.
  const [draft, setDraft] = useState<Wall | null>(null);
  const [view, setView] = useState<View>({ kind: 'wall' });
  const [rail, setRailOpen] = useState(readRail);
  const [held, setHeld] = useState(false);
  const [lookTiles, setLookTiles] = useState<Wall['rollingTiles']>(16);
  const confirm = useConfirm();
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDraft(null);
    setView({ kind: 'wall' });
    setHeld(false);
    // With many walls the tabs scroll: keep the open one in sight.
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [saved?.id]);
  const wall = draft ?? saved;

  const setRail = (open: boolean) => {
    setRailOpen(open);
    try {
      localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed');
    } catch {
      /* the choice just isn't remembered */
    }
  };

  // The cameras this person can look at: their team's areas (the HSE control room and admins see every camera).
  const seeAll = me.teamId === 't-hse' || isAdmin(me);
  const myAreas = TEAMS_BY_ID[me.teamId]?.areaIds;
  const scopeCams = useMemo(() => (seeAll ? cams : cams.filter((c) => myAreas?.includes(c.areaId))), [cams, seeAll, myAreas]);
  const openByCam = useMemo(() => {
    const m = new Map<string, Alert>();
    for (const a of alerts) {
      if (!isOpen(a)) continue;
      const had = m.get(a.cameraId);
      if (!had || PRIO_RANK[a.priority] < PRIO_RANK[had.priority]) m.set(a.cameraId, a);
    }
    return m;
  }, [alerts]);

  const look = useMemo(() => {
    switch (view.kind) {
      case 'wall':
        return null;
      case 'area':
        return { key: `area-${view.areaId}`, label: AREAS_BY_ID[view.areaId]?.name ?? view.areaId, ids: scopeCams.filter((c) => c.areaId === view.areaId).map((c) => c.id) };
      case 'alerting':
        return {
          key: 'alerting',
          label: 'Cameras with open alerts',
          ids: scopeCams
            .filter((c) => openByCam.has(c.id))
            .sort((x, y) => PRIO_RANK[openByCam.get(x.id)!.priority] - PRIO_RANK[openByCam.get(y.id)!.priority])
            .map((c) => c.id),
        };
      case 'offline':
        return { key: 'offline', label: 'Offline or degraded', ids: scopeCams.filter((c) => c.status !== 'online').map((c) => c.id) };
      case 'search':
        return { key: `search-${view.q}`, label: `Search “${view.q}”`, ids: scopeCams.filter((c) => looseMatch(`${c.id} ${c.name} ${AREAS_BY_ID[c.areaId]?.name ?? ''}`, view.q)).map((c) => c.id) };
    }
  }, [view, scopeCams, openByCam]);

  const lookWall = useMemo<Wall | null>(
    () => (look && wall ? { ...EMPTY_WALL, id: `look-${look.key}`, teamId: wall.teamId, rollingTiles: lookTiles, rotation: look.ids, rotateSec: wall.rotateSec } : null),
    [look, wall, lookTiles],
  );
  const modelWall = useMemo(() => (wall && draft ? { ...wall, alertTakeover: false, autoPinBusy: false } : wall), [wall, draft]);
  const shown = lookWall ?? modelWall ?? EMPTY_WALL;
  const model = useWallModel(shown, !!draft || held);

  const show = (v: View) => {
    setDraft(null);
    setSettings(false);
    setView(v);
    // A quick look waits for you to page through it; the wall itself rolls on its own.
    setHeld(v.kind !== 'wall');
    if (v.kind !== 'wall' && window.innerWidth < 900) setRail(false);
  };

  // Keyboard: arrows step through the sets, space pauses, Esc goes back to the wall, [ shows or hides the camera list.
  const keys = useRef({ go: model.go, back: () => undefined as void, rail: () => undefined as void });
  keys.current = { go: model.go, back: () => view.kind !== 'wall' && show({ kind: 'wall' }), rail: () => setRail(!rail) };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.scrim, .cmdk')) return;
      if (e.key === 'ArrowRight') keys.current.go(1);
      else if (e.key === 'ArrowLeft') keys.current.go(-1);
      else if (e.key === ' ' && !t?.closest('button')) setHeld((v) => !v);
      else if (e.key === 'Escape') keys.current.back();
      else if (e.key === '[') keys.current.rail();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!saved || !wall) {
    return (
      <div className="page">
        <Empty icon="wall" title="No Video Wall For Your Team Yet">
          Ask the safety admin to set one up.
        </Empty>
      </div>
    );
  }

  const update = (patch: Partial<Wall>) => {
    if (draft) setDraft({ ...draft, ...patch });
    else saveWall({ ...saved, ...patch });
  };

  const pinToggle = (cam: Camera, isPinned: boolean) => {
    const slots = LAYOUT_SLOTS[wall.pinnedLayout];
    const pinned = [...wall.pinned];
    if (isPinned) {
      const i = pinned.indexOf(cam.id);
      if (i >= 0) pinned[i] = null;
      update({ pinned, rotation: wall.rotation.includes(cam.id) ? wall.rotation : [cam.id, ...wall.rotation] });
      toast(`${cam.id} ${cam.name} unpinned; it rolls with the others now`);
      return;
    }
    // From the all-rolling layout, the first pin switches the wall to the pinned layout.
    const fromSolo = wall.pinnedShare === 0;
    let i = pinned.slice(0, slots).findIndex((p) => !p);
    if (i < 0 && pinned.length < slots) i = pinned.length;
    let replaced: string | null = null;
    if (i < 0) {
      i = slots - 1;
      replaced = pinned[i];
    }
    while (pinned.length <= i) pinned.push(null);
    pinned[i] = cam.id;
    const rotation = wall.rotation.filter((x) => x !== cam.id);
    update(fromSolo ? { pinned, rotation, pinnedShare: 70, rollingTiles: wall.rollingTiles > 6 ? 6 : wall.rollingTiles } : { pinned, rotation });
    toast(replaced ? `${cam.id} pinned in place of ${replaced}` : `${cam.id} ${cam.name} pinned to ${wall.name}`);
  };

  const teamFor = (ids: string[]) => {
    if (!isAdmin(me)) return me.teamId;
    const areas = new Set(ids.map((id) => cams.find((c) => c.id === id)?.areaId));
    return TEAMS.find((t) => [...areas].every((a) => a && t.areaIds.includes(a)))?.id ?? me.teamId;
  };
  const startWall = (fromLook: boolean) => {
    setSettings(false);
    if (fromLook && look) {
      setView({ kind: 'wall' });
      setHeld(false);
      setDraft({ ...newWall(teamFor(look.ids)), name: view.kind === 'area' ? look.label : '', rotation: look.ids, rollingTiles: lookTiles });
    } else {
      setView({ kind: 'wall' });
      setDraft(newWall(isAdmin(me) ? '' : me.teamId));
    }
  };

  const solo = shown.pinnedShare === 0;
  const tileChoices = look ? TILE_OPTIONS : solo ? TILE_OPTIONS : ([3, 4, 6] as Wall['rollingTiles'][]);
  const onWall = new Set([...wall.rotation, ...wall.pinned.filter(Boolean)] as string[]).size;
  const wallAlerts = model.alertsByCam.size;
  const pinnedCount = wall.pinned.slice(0, solo ? 0 : LAYOUT_SLOTS[wall.pinnedLayout]).filter(Boolean).length;

  return (
    <div className="page page--wide gyt gwall">
      <header className="gwall__head">
        <div className="ovhead__title">
          <h1>Video wall</h1>
          <p className="ovhead__sub">
            <span>{TEAMS_BY_ID[saved.teamId]?.name}</span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span className="mono">{scopeCams.length}</span> cameras you can see
            <span className="ovhead__sep" aria-hidden="true" />
            {openByCam.size > 0 ? (
              <button type="button" className="gwall__alerting" onClick={() => show({ kind: 'alerting' })}>
                <i aria-hidden="true" />
                <span className="mono">{scopeCams.filter((c) => openByCam.has(c.id)).length}</span> with open alerts
              </button>
            ) : (
              <span>No open alerts</span>
            )}
          </p>
        </div>
        <div className="gwall__tabs" role="tablist" aria-label="Walls" ref={tabsRef}>
          {visible.map((w) => (
            <button key={w.id} type="button" role="tab" aria-selected={w.id === saved.id && !draft} onClick={() => (w.id === saved.id ? show({ kind: 'wall' }) : nav(`/wall/${w.id}`))} title={TEAMS_BY_ID[w.teamId]?.name}>
              {w.name}
              {w.teamId === me.teamId && <span className="gwall__mine">Your team</span>}
            </button>
          ))}
          {canConfigure(me) && (
            <button type="button" className="gwall__new" onClick={() => startWall(false)} aria-selected={!!draft && !visible.some((w) => w.id === draft.id)} role="tab">
              <Icon name="plus" size={15} />
              New wall
            </button>
          )}
        </div>
        <div className="ovhead__actions">
          {canConfigure(me) && (
            <button type="button" className={`gbtn${draft && !look ? ' is-on' : ''}`} onClick={() => (draft ? setDraft(null) : (setSettings(false), setView({ kind: 'wall' }), setHeld(false), setDraft(saved)))} aria-pressed={!!draft}>
              <Icon name="camera-plus" size={17} />
              {draft ? 'Close set-up' : 'Set up wall'}
            </button>
          )}
          <button type="button" className={`gbtn gbtn--icon${settings && !draft ? ' is-on' : ''}`} onClick={() => (draft ? (setDraft(null), setSettings(true)) : setSettings((v) => !v))} title="Wall settings" aria-label="Wall settings" aria-pressed={settings && !draft}>
            <Icon name="settings" size={18} />
          </button>
          <CastMenu wallId={saved.id} />
          <button type="button" className="gbtn gbtn--icon" onClick={() => window.open(`#/screen/${saved.id}`, `gyt-wall-${saved.id}`, 'popup,width=1600,height=900')} title="Open this wall in its own window, for a second monitor" aria-label="Pop out">
            <Icon name="external" size={18} />
          </button>
        </div>
      </header>

      <div className="gwall__body">
        {draft ? (
          <EditPanel draft={draft} setDraft={setDraft} saved={saved} onDone={() => setDraft(null)} />
        ) : (
          rail && <CameraNav cams={scopeCams} openByCam={openByCam} view={view} wallName={saved.name} onWall={onWall} onView={show} onOpen={setFocus} onClose={() => setRail(false)} />
        )}
        <div className="gwall__stage">
          <div className="gwall__bar">
            {!draft && (
              <button type="button" className={`gbtn gbtn--icon gbtn--sm${rail ? ' is-on' : ''}`} onClick={() => setRail(!rail)} title={rail ? 'Hide the camera list  [' : 'Show the camera list  ['} aria-label={rail ? 'Hide the camera list' : 'Show the camera list'} aria-pressed={rail}>
                <Icon name="list" size={17} />
              </button>
            )}
            <div className="gwall__crumb">
              {look ? (
                <>
                  <button type="button" className="gwall__back" onClick={() => show({ kind: 'wall' })} title="Back to the wall  Esc">
                    <Icon name="arrow-left" size={15} />
                    {saved.name}
                  </button>
                  <Icon name="chevron-right" size={14} className="faint" />
                  <strong className="ellipsis">{look.label}</strong>
                  <span className="meta">
                    <span className="mono">{look.ids.length}</span> cameras
                  </span>
                </>
              ) : (
                <>
                  <strong className="ellipsis">{draft ? draft.name || 'New wall' : saved.name}</strong>
                  <span className="meta">
                    <span className="mono">{onWall}</span> cameras{pinnedCount > 0 && <> · {pinnedCount} pinned</>}
                    {wallAlerts > 0 && !draft && (
                      <>
                        {' '}
                        · <span className="gwall__red">{wallAlerts} alerting</span>
                      </>
                    )}
                  </span>
                </>
              )}
            </div>
            <span className="spacer" />
            {shown.pinnedShare !== 100 && (
              <div className="gpager" role="group" aria-label="Camera sets">
                <button type="button" onClick={() => model.go(-1)} aria-label="Previous set" title="Previous set  ←" disabled={model.pages < 2}>
                  <Icon name="chevron-left" size={16} />
                </button>
                <span className="gpager__n" aria-live="polite">
                  Set <span className="mono">{model.page + 1}</span> of <span className="mono">{model.pages}</span>
                </span>
                <button type="button" onClick={() => model.go(1)} aria-label="Next set" title="Next set  →" disabled={model.pages < 2}>
                  <Icon name="chevron-right" size={16} />
                </button>
                <span className="gpager__sep" aria-hidden="true" />
                <button type="button" onClick={() => setHeld((v) => !v)} aria-label={held ? 'Play: move on by itself' : 'Pause on this set'} title={held ? 'Play  Space' : 'Pause  Space'} disabled={!!draft || model.pages < 2}>
                  <Icon name={held || draft ? 'play' : 'pause'} size={15} />
                </button>
                <span className="gpager__t mono">{held || draft || model.pages < 2 ? '—' : `${model.secsLeft}s`}</span>
              </div>
            )}
            {shown.pinnedShare !== 100 && (
              <Seg
                label="Tiles on screen"
                small
                value={look ? lookTiles : shown.rollingTiles}
                onChange={(v) => (look ? setLookTiles(v) : update({ rollingTiles: v }))}
                options={tileChoices.map((n) => ({ value: n, label: <span className="mono">{n}</span>, title: `${n} tiles` }))}
              />
            )}
            {look && canConfigure(me) && look.ids.length > 0 && (
              <button type="button" className="gbtn gbtn--sm gbtn--primary" onClick={() => startWall(true)}>
                <Icon name="plus" size={15} />
                Save as wall
              </button>
            )}
          </div>
          <div className="gwall__screen">
            {look && look.ids.length === 0 ? (
              <div className="gwall__none">
                <strong>No cameras here</strong>
                <span>{view.kind === 'alerting' ? 'Nothing is alerting right now.' : view.kind === 'offline' ? 'Every camera is online.' : 'Nothing matches that search.'}</span>
                <button type="button" className="gbtn gbtn--sm" onClick={() => show({ kind: 'wall' })}>
                  Back to {saved.name}
                </button>
              </div>
            ) : (
              <WallBody
                wall={shown}
                model={model}
                editing={!!draft}
                onAlert={(a) => nav(cameraAlerts(alerts, a.cameraId))}
                onOpen={setFocus}
                onPinToggle={look ? undefined : pinToggle}
                onDropCam={(slot, id) => {
                  const pinned = [...wall.pinned];
                  const prev = pinned.indexOf(id);
                  if (prev >= 0) pinned[prev] = null;
                  while (pinned.length <= slot) pinned.push(null);
                  pinned[slot] = id;
                  update({ pinned, rotation: wall.rotation.filter((x) => x !== id) });
                }}
                onClearSlot={(slot) => {
                  const pinned = [...wall.pinned];
                  const id = pinned[slot];
                  pinned[slot] = null;
                  update({ pinned, rotation: id && !wall.rotation.includes(id) ? [...wall.rotation, id] : wall.rotation });
                }}
                height="100%"
              />
            )}
          </div>
        </div>
        {settings && !draft && (
          <SettingsPanel
            wall={wall}
            update={update}
            model={look ? undefined : model}
            onClose={() => setSettings(false)}
            onDelete={
              visible.length > 1
                ? () =>
                    confirm.ask({ title: 'Delete this wall?', message: `“${saved.name}” is removed for everyone on its team.`, action: 'Delete wall' }, () => {
                      const next = visible.find((w) => w.id !== saved.id);
                      deleteWall(saved.id);
                      setSettings(false);
                      toast(`${saved.name} deleted`);
                      nav(next ? `/wall/${next.id}` : '/wall');
                    })
                : undefined
            }
          />
        )}
      </div>

      {confirm.dialog}
      {ack && <AckDialog alert={ack} via="wall" onClose={() => setAck(undefined)} />}
      {focus && <FocusModal cam={focus} wall={wall} onPinToggle={look ? undefined : pinToggle} onClose={() => setFocus(undefined)} onAck={(a) => setAck(a)} />}
    </div>
  );
}

/** The camera list beside the wall: find any camera by ID, place or area, jump to the cameras that are alerting or down, or
 *  open a whole area on the wall. Built for a thousand cameras: areas stay folded, searches show the first 200 matches here
 *  and page through all of them on the wall. */
function CameraNav({
  cams,
  openByCam,
  view,
  wallName,
  onWall,
  onView,
  onOpen,
  onClose,
}: {
  cams: Camera[];
  openByCam: Map<string, Alert>;
  view: View;
  wallName: string;
  onWall: number;
  onView: (v: View) => void;
  onOpen: (c: Camera) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const box = useRef<HTMLInputElement>(null);
  const byArea = useMemo(() => {
    const m = new Map<string, Camera[]>();
    for (const c of cams) m.set(c.areaId, [...(m.get(c.areaId) ?? []), c]);
    return m;
  }, [cams]);
  const hits = useMemo(() => (q.trim() ? cams.filter((c) => looseMatch(`${c.id} ${c.name} ${AREAS_BY_ID[c.areaId]?.name ?? ''}`, q)) : null), [cams, q]);
  const alerting = cams.filter((c) => openByCam.has(c.id)).length;
  const down = cams.filter((c) => c.status !== 'online').length;
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const row = (c: Camera) => {
    const a = openByCam.get(c.id);
    return (
      <button key={c.id} type="button" className="gnav__cam" onClick={() => onOpen(c)} title={`${c.id} · ${c.name}`}>
        <span className={`dot dot--${c.status}`} />
        <span className="gnav__id mono">{c.id}</span>
        <span className="ellipsis">{c.name}</span>
        {a && <PriorityBadge p={a.priority} short />}
      </button>
    );
  };

  const viewRow = (v: View, label: string, n: number, red?: boolean, icon: 'wall' | 'warning' | 'power' = 'wall') => (
    <button type="button" className={`gnav__view${view.kind === v.kind ? ' is-on' : ''}`} onClick={() => onView(v)} aria-current={view.kind === v.kind}>
      <Icon name={icon} size={16} />
      <span className="ellipsis">{label}</span>
      <span className={`gnav__n mono${red && n > 0 ? ' is-red' : ''}`}>{n}</span>
    </button>
  );

  return (
    <aside className="gnav" aria-label="Cameras">
      <div className="gnav__head">
        <strong>Cameras</strong>
        <span className="gnav__total mono">{cams.length}</span>
        <span className="spacer" />
        <button type="button" className="gnav__x" onClick={onClose} aria-label="Hide the camera list" title="Hide  [">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="gnav__search">
        <Icon name="search" size={16} />
        <input
          ref={box}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q.trim()) onView({ kind: 'search', q: q.trim() });
            if (e.key === 'Escape') (q ? setQ('') : box.current?.blur());
          }}
          placeholder="Camera ID, place or area"
          aria-label="Find a camera"
        />
        {q && (
          <button type="button" onClick={() => setQ('')} aria-label="Clear the search">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      {hits ? (
        <>
          <div className="gnav__hits">
            <span>
              <span className="mono">{hits.length}</span> {hits.length === 1 ? 'match' : 'matches'}
            </span>
            <span className="spacer" />
            {hits.length > 0 && (
              <button type="button" className="gnav__link" onClick={() => onView({ kind: 'search', q: q.trim() })}>
                Show on the wall <kbd>↵</kbd>
              </button>
            )}
          </div>
          <div className="gnav__list">
            {hits.slice(0, 200).map(row)}
            {hits.length > 200 && <p className="gnav__more">First 200 shown. Show on the wall to page through all {hits.length}.</p>}
          </div>
        </>
      ) : (
        <div className="gnav__list">
          <div className="gnav__group">Views</div>
          {viewRow({ kind: 'wall' }, wallName, onWall)}
          {viewRow({ kind: 'alerting' }, 'Open alerts', alerting, true, 'warning')}
          {viewRow({ kind: 'offline' }, 'Offline or degraded', down, false, 'power')}
          <div className="gnav__group">Areas</div>
          {AREAS.filter((a) => byArea.has(a.id)).map((a) => {
            const list = byArea.get(a.id)!;
            const al = list.filter((c) => openByCam.has(c.id)).length;
            const off = list.filter((c) => c.status === 'offline').length;
            const isOpenArea = open.has(a.id);
            const on = view.kind === 'area' && view.areaId === a.id;
            return (
              <div key={a.id} className="gnav__areawrap">
                <div className={`gnav__area${on ? ' is-on' : ''}`}>
                  <button type="button" className="gnav__twisty" aria-expanded={isOpenArea} aria-label={`${isOpenArea ? 'Fold' : 'List'} the cameras in ${a.name}`} onClick={() => toggle(a.id)}>
                    <Icon name="chevron-right" size={14} />
                  </button>
                  <button type="button" className="gnav__areaname" onClick={() => onView({ kind: 'area', areaId: a.id })} title={`Show ${a.name} on the wall`}>
                    <span className="ellipsis">{a.name}</span>
                  </button>
                  {al > 0 && (
                    <span className="gnav__alert mono" title={`${al} with open alerts`}>
                      {al}
                    </span>
                  )}
                  {off > 0 && (
                    <span className="gnav__off mono" title={`${off} offline`}>
                      {off} off
                    </span>
                  )}
                  <span className="gnav__n mono">{list.length}</span>
                </div>
                {isOpenArea && <div className="gnav__cams">{list.map(row)}</div>}
              </div>
            );
          })}
        </div>
      )}
      <div className="gnav__keys">
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> sets
        </span>
        <span>
          <kbd>Space</kbd> pause
        </span>
        <span>
          <kbd>Esc</kbd> back
        </span>
      </div>
    </aside>
  );
}

/** The Alerts page filtered to one camera, with that camera's latest alert open. */
function cameraAlerts(alerts: Alert[], cameraId: string) {
  const latest = alerts.filter((a) => a.cameraId === cameraId).sort((x, y) => y.at - x.at)[0];
  return `/alerts${latest ? `/${latest.id}` : ''}?camera=${encodeURIComponent(cameraId)}`;
}

const EMPTY_WALL: Wall = { id: '-', name: '', teamId: 't-hse', pinnedShare: 0, pinnedLayout: '2x2', pinned: [], rollingTiles: 9, rotation: [], rotateSec: 10, autoPinBusy: false, alertTakeover: false };

export function SettingsPanel({ wall, update, model, onClose, onDelete }: { wall: Wall; update: (patch: Partial<Wall>) => void; model?: ReturnType<typeof useWallModel>; onClose?: () => void; onDelete?: () => void }) {
  const solo = wall.pinnedShare === 0;
  return (
    <aside className="wedit wset" aria-label="Wall settings">
      <div className="wedit__head wset__head">
        <h2>Wall settings</h2>
        <span className="spacer" />
        {onClose && (
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <div className="wset__body">
        <div className="wset__group">
          <span className="walltools__label">Pinned vs rolling</span>
          <Seg
            label="Pinned versus rolling share"
            small
            value={wall.pinnedShare}
            onChange={(v) => update({ pinnedShare: v, rollingTiles: v === 0 ? 9 : v === 100 ? wall.rollingTiles : wall.rollingTiles > 6 ? 3 : wall.rollingTiles })}
            options={[
              { value: 100, label: 'All pinned' },
              { value: 80, label: '80 / 20' },
              { value: 70, label: '70 / 30' },
              { value: 60, label: '60 / 40' },
              { value: 0, label: 'All rolling' },
            ]}
          />
        </div>
        {!solo && (
          <div className="wset__group">
            <span className="walltools__label">Pinned grid</span>
            <Seg label="Pinned grid" small value={wall.pinnedLayout} onChange={(v) => update({ pinnedLayout: v })} options={LAYOUTS} />
          </div>
        )}
        {wall.pinnedShare !== 100 && (
          <>
            <div className="wset__group">
              <span className="walltools__label">Rolling tiles</span>
              <Seg
                label="Rolling tiles"
                small
                value={wall.rollingTiles}
                onChange={(v) => update({ rollingTiles: v })}
                options={(solo ? [4, 9, 16, 25] : [3, 4, 6]).map((n) => ({ value: n as Wall['rollingTiles'], label: String(n) }))}
              />
            </div>
            <div className="wset__group">
              <span className="walltools__label">Next set every</span>
              <Seg label="Rotation interval" small value={wall.rotateSec} onChange={(v) => update({ rotateSec: v })} options={[10, 15, 30, 60].map((n) => ({ value: n as Wall['rotateSec'], label: `${n}s` }))} />
            </div>
          </>
        )}
        <div className="wset__group">
          <Switch checked={wall.alertTakeover} onChange={(v) => update({ alertTakeover: v })} label="Alerts take over a tile" />
          {!solo && <Switch checked={wall.autoPinBusy} onChange={(v) => update({ autoPinBusy: v })} label="Auto-pin the busiest camera" />}
        </div>
        {onDelete && (
          <div className="wset__group">
            <button type="button" className="btn btn--ghost btn--sm wset__delete" onClick={onDelete}>
              <Icon name="trash" size={15} />
              Delete wall
            </button>
          </div>
        )}
        {model && wall.pinnedShare !== 100 && (
          <span className="meta">
            Rolling set {model.page + 1} of {model.pages} · {model.pool.length} cameras
            {` · next in ${model.secsLeft}s`}
          </span>
        )}
      </div>
    </aside>
  );
}

/** Setting up a wall: its name, its team and its cameras. Built for large sites: tick an area to put all of its cameras on the
 *  wall at once, search to add or remove every match, and open an area only to pick single cameras or pin one. */
export function EditPanel({ draft, setDraft, saved, onDone }: { draft: Wall; setDraft: (w: Wall) => void; saved: Wall; onDone: () => void }) {
  const cams = useCameras();
  const walls = useWalls();
  const me = useMe();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const team = TEAMS_BY_ID[draft.teamId];
  const isNew = !walls.some((w) => w.id === draft.id);
  const slots = draft.pinnedShare === 0 ? 0 : LAYOUT_SLOTS[draft.pinnedLayout];
  const inScope = cams.filter((c) => (team?.areaIds ?? []).includes(c.areaId));
  const hits = q.trim() ? inScope.filter((c) => looseMatch(`${c.id} ${c.name} ${AREAS_BY_ID[c.areaId]?.name ?? ''}`, q)) : null;
  const pinnedSet = new Set(draft.pinned.slice(0, slots).filter(Boolean));
  const rot = new Set(draft.rotation);
  const isOn = (id: string) => rot.has(id) || pinnedSet.has(id);
  const total = inScope.filter((c) => isOn(c.id)).length;

  /** Puts these cameras on the wall (rolling) or takes them off it (pinned or rolling). */
  const setMany = (ids: string[], on: boolean) => {
    const set = new Set(ids);
    setDraft({
      ...draft,
      rotation: on ? [...draft.rotation, ...ids.filter((id) => !rot.has(id) && !pinnedSet.has(id))] : draft.rotation.filter((id) => !set.has(id)),
      pinned: on ? draft.pinned : draft.pinned.map((p) => (p && set.has(p) ? null : p)),
    });
  };
  const pin = (id: string) => {
    // On an all-rolling wall the first pin switches it to the pinned layout.
    const fromSolo = draft.pinnedShare === 0;
    const have = fromSolo ? LAYOUT_SLOTS[draft.pinnedLayout] : slots;
    const pinned = [...draft.pinned];
    let i = pinned.slice(0, have).findIndex((p) => !p);
    if (i < 0 && pinned.length < have) i = pinned.length;
    if (i < 0) {
      toast('All pinned slots are in use. Remove one, or pick a bigger grid in the wall settings.');
      return;
    }
    while (pinned.length <= i) pinned.push(null);
    pinned[i] = id;
    // A camera is pinned or it rolls, not both.
    setDraft({ ...draft, pinned, rotation: draft.rotation.filter((x) => x !== id), ...(fromSolo ? { pinnedShare: 70, rollingTiles: draft.rollingTiles > 6 ? (6 as Wall['rollingTiles']) : draft.rollingTiles } : {}) });
  };
  // Unpinning keeps the camera on the wall, rolling with the others.
  const unpin = (id: string) => setDraft({ ...draft, pinned: draft.pinned.map((p) => (p === id ? null : p)), rotation: draft.rotation.includes(id) ? draft.rotation : [...draft.rotation, id] });
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <aside className="wedit gedit" aria-label="Set up the wall">
      <div className="wedit__head">
        <h2 className="wedit__title">{isNew ? 'New wall' : 'Set up wall'}</h2>
        <div className="gedit__fields">
          <div className="field">
            <label htmlFor="wall-name">Name</label>
            <input id="wall-name" className="input input--sm" value={draft.name} placeholder="Name this wall" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="wall-team">Team</label>
            <Choice
              id="wall-team"
              small
              label="Team"
              value={draft.teamId}
              disabled={!isAdmin(me)}
              onChange={(teamId) => {
                const tm = TEAMS_BY_ID[teamId];
                // Cameras outside the new team's areas leave the wall; the rest stay.
                const keep = (id: string | null) => !!id && tm.areaIds.includes(cams.find((c) => c.id === id)?.areaId ?? '');
                setDraft({ ...draft, teamId: tm.id, pinned: draft.pinned.map((p) => (keep(p) ? p : null)), rotation: draft.rotation.filter(keep) });
              }}
              options={TEAMS.map((tm) => ({ value: tm.id, label: tm.name }))}
            />
          </div>
        </div>
        <div className="gedit__sum">
          <span>
            <strong className="mono">{total}</strong> of <span className="mono">{inScope.length}</span> cameras on this wall
          </span>
          {slots > 0 && (
            <span className="meta">
              <span className="mono">{pinnedSet.size}</span>/<span className="mono">{slots}</span> pinned
            </span>
          )}
        </div>
        <div className="gnav__search gedit__search">
          <Icon name="search" size={16} />
          <input placeholder="Find cameras to add or remove" aria-label="Find cameras" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear the search">
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        {hits && hits.length > 0 && (
          <div className="gedit__bulk">
            <span className="meta">
              <span className="mono">{hits.length}</span> matches
            </span>
            <span className="spacer" />
            <button type="button" className="gbtn gbtn--sm" onClick={() => setMany(hits.map((c) => c.id), true)}>
              Add all
            </button>
            <button type="button" className="gbtn gbtn--sm" onClick={() => setMany(hits.map((c) => c.id), false)}>
              Remove all
            </button>
          </div>
        )}
      </div>
      <div className="wedit__list">
        {!team && <p className="meta wedit__hint">Choose a team to list its cameras.</p>}
        {team && !hits && <p className="gedit__hint">Tick an area to add all its cameras. Open it to pick single cameras, or pin one so it never rolls away. Drag a camera onto a pinned tile to choose its place.</p>}
        {AREAS.filter((a) => team?.areaIds.includes(a.id)).map((a) => {
          const items = (hits ?? inScope).filter((c) => c.areaId === a.id);
          if (!items.length) return null;
          const on = items.filter((c) => isOn(c.id)).length;
          const expanded = !!hits || open.has(a.id);
          return (
            <div key={a.id} className="gedit__group">
              <div className="gedit__area">
                <button type="button" className="gnav__twisty" aria-expanded={expanded} aria-label={`${expanded ? 'Fold' : 'List'} the cameras in ${a.name}`} onClick={() => toggle(a.id)} disabled={!!hits}>
                  <Icon name="chevron-right" size={14} />
                </button>
                <input
                  type="checkbox"
                  checked={on === items.length}
                  ref={(el) => {
                    if (el) el.indeterminate = on > 0 && on < items.length;
                  }}
                  onChange={(e) => setMany(items.map((c) => c.id), e.target.checked)}
                  aria-label={`All ${items.length} cameras in ${a.name}`}
                />
                <button type="button" className="gedit__areaname ellipsis" onClick={() => toggle(a.id)} disabled={!!hits}>
                  {a.name}
                </button>
                <span className="gnav__n mono">
                  {on}/{items.length}
                </span>
              </div>
              {expanded &&
                items.map((c) => (
                  <div key={c.id} className="gedit__cam" draggable onDragStart={(e) => e.dataTransfer.setData('text/camera', c.id)}>
                    <input type="checkbox" checked={isOn(c.id)} onChange={(e) => setMany([c.id], e.target.checked)} aria-label={`${c.id} on this wall`} />
                    <span className={`dot dot--${c.status}`} />
                    <span className="gnav__id mono">{c.id}</span>
                    <span className="ellipsis">{c.name}</span>
                    <button
                      type="button"
                      className={`gedit__pin${pinnedSet.has(c.id) ? ' is-on' : ''}`}
                      aria-pressed={pinnedSet.has(c.id)}
                      title={pinnedSet.has(c.id) ? 'Pinned: click to let it roll' : 'Pin: keep it on screen'}
                      aria-label={pinnedSet.has(c.id) ? `Unpin ${c.id}` : `Pin ${c.id}`}
                      onClick={() => (pinnedSet.has(c.id) ? unpin(c.id) : pin(c.id))}
                    >
                      <Icon name="pin" size={14} />
                    </button>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
      {confirm.dialog}
      <div className="wedit__foot">
        {!isNew && walls.length > 1 && (
          <button
            type="button"
            className="gbtn gbtn--sm gbtn--danger"
            onClick={() =>
              confirm.ask({ title: 'Delete this wall?', message: `“${saved.name}” is removed for everyone on its team.`, action: 'Delete wall' }, () => {
                deleteWall(saved.id);
                onDone();
                nav('/wall');
              })
            }
          >
            <Icon name="trash" size={15} />
            Delete
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="gbtn gbtn--sm" onClick={onDone}>
          Cancel
        </button>
        <button
          type="button"
          className="gbtn gbtn--sm gbtn--primary"
          disabled={!draft.name.trim() || !team || total === 0}
          title={!draft.name.trim() ? 'Name the wall first' : total === 0 ? 'Add at least one camera' : undefined}
          onClick={() => {
            saveWall({ ...draft, name: draft.name.trim() });
            toast(`${draft.name.trim()} saved. Everyone on ${team?.name} sees the new layout.`);
            onDone();
            if (isNew) nav(`/wall/${draft.id}`);
          }}
        >
          Save wall
        </button>
      </div>
    </aside>
  );
}

/** The camera picture with a full screen button in its top right corner (shown on hover). In full screen the same corner has the
 *  exit button, which returns to the camera window on the wall. Where the browser does not allow full screen (for example a page
 *  embedded in another site) the picture fills the browser window instead. */
function FullScreenBox({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(false);
  const [filled, setFilled] = useState(false);
  const full = native || filled;
  useEffect(() => {
    const change = () => setNative(document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  useEffect(() => {
    if (!filled) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setFilled(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [filled]);
  const toggle = async () => {
    if (full) {
      if (native) await document.exitFullscreen().catch(() => undefined);
      setFilled(false);
      return;
    }
    try {
      if (!box.current?.requestFullscreen) throw new Error('no full screen');
      await box.current.requestFullscreen();
    } catch {
      setFilled(true);
    }
  };
  return (
    <div ref={box} className={`fsbox${filled ? ' fsbox--filled' : ''}`}>
      {children}
      <button type="button" className="fsbox__btn" onClick={() => void toggle()} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'}>
        <Icon name={full ? 'shrink' : 'expand'} size={20} stroke={2} />
      </button>
    </div>
  );
}

function FocusModal({ cam, wall, onClose, onPinToggle, onAck }: { cam: Camera; wall: Wall; onClose: () => void; onPinToggle?: (c: Camera, pinned: boolean) => void; onAck: (a: Alert) => void }) {
  const me = useMe();
  const alerts = useAlerts().filter((a) => a.cameraId === cam.id);
  const activity = useActivity();
  const now = useNow(1000);
  const [zones, setZones] = useState(true);
  const open = alerts.find(isOpen);
  const pinned = wall.pinned.includes(cam.id);
  return (
    <Modal title={`${cam.id} · ${cam.name}`} wide onClose={onClose}>
      <div className="focus">
        <div className="stack">
          <FullScreenBox>
            <CameraView cam={cam} alert={open} zones={zones ? cam.zones : undefined} showZoneLabels={zones} now={now} />
          </FullScreenBox>
          <div className="row-wrap">
            <Switch checked={zones} onChange={setZones} label={`Show zones (${cam.zones.length})`} />
            <span className="spacer" />
            {onPinToggle && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => onPinToggle(cam, pinned)}>
                <Icon name={pinned ? 'unpin' : 'pin'} size={15} />
                {pinned ? 'Unpin from this wall' : 'Pin to this wall'}
              </button>
            )}
            {canConfigure(me) && (
              <Link to={`/cameras/${cam.id}`} className="btn btn--secondary btn--sm">
              <Icon name="camera" size={15} />
              Camera set-up
            </Link>
            )}
            {open && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  onClose();
                  onAck(open);
                }}
              >
                Review {open.id}
              </button>
            )}
          </div>
        </div>
        <div className="stack">
          <dl className="kv">
            <dt>Area</dt>
            <dd>{AREAS_BY_ID[cam.areaId]?.name}</dd>
            <dt>Status</dt>
            <dd className="row">
              <span className={`dot dot--${cam.status}`} />
              {cam.status}
            </dd>
            <dt>In view now</dt>
            <dd>{activity[cam.id] ?? 0} people and vehicles</dd>
            <dt>Clock</dt>
            <dd className="mono">{hms(now)}</dd>
          </dl>
          <h3>Alerts on this camera</h3>
          {alerts.length === 0 && <span className="meta">None yet.</span>}
          {alerts.slice(0, 6).map((a) => (
            <Link key={a.id} to={`/alerts/${a.id}`} className="focus__alert" onClick={onClose}>
              <PriorityBadge p={a.priority} short />
              <span className="ellipsis" style={{ flex: 1 }}>
                {a.title}
              </span>
              <StateChip state={a.state} />
              <span className="meta">{ago(a.at, now)}</span>
            </Link>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** The wall on its own, for a second monitor. Stays in step with the console. */
export function WallScreen() {
  const { wallId } = useParams();
  const walls = useWalls();
  const wall = walls.find((w) => w.id === wallId) ?? walls[0];
  const model = useWallModel(wall ?? EMPTY_WALL, false);
  const now = useNow(1000);
  const alerts = useAlerts();
  useEffect(() => {
    document.title = `${wall?.name ?? 'Wall'} · Safety Intelligence`;
  }, [wall?.name]);
  if (!wall) return null;
  // The pop-out sits on a second monitor: pages open in the console window that opened it, or here when there is none.
  const consoleWindow = window.opener && !window.opener.closed ? window.opener : null;
  const openInConsole = (hash: string) => {
    if (consoleWindow) {
      consoleWindow.location.hash = hash;
      consoleWindow.focus();
    } else window.location.hash = hash;
  };
  // Exit goes back to the video wall page: close this window when it is a pop-out, otherwise navigate there.
  const exit = () => {
    if (consoleWindow) {
      consoleWindow.location.hash = `#/wall/${wall.id}`;
      consoleWindow.focus();
      window.close();
    } else window.location.hash = `#/wall/${wall.id}`;
  };
  return (
    <div className="wallscreen">
      <div className="wallscreen__bar">
        <Logo size={24} />
        <strong>{wall.name}</strong>
        <span className="muted">{TEAMS_BY_ID[wall.teamId]?.name}</span>
        <span className="spacer" />
        {model.scopeAlerts.length > 0 ? (
          <button type="button" className="chip chip--danger wallscreen__alerts" onClick={() => openInConsole('#/alerts')} title="Open The Alerts Page">
            {model.scopeAlerts.length} open alerts
          </button>
        ) : (
          <span className="chip chip--good">No open alerts</span>
        )}
        <span className="mono">{hms(now)}</span>
        <button type="button" className="wallscreen__exit" onClick={exit} title="Back To The Video Wall Page" aria-label="Exit to the video wall page">
          <Icon name="close" size={16} stroke={2.2} />
          Exit
        </button>
      </div>
      <WallBody
        wall={wall}
        model={model}
        onAlert={(a) => {
          openInConsole(`#${cameraAlerts(alerts, a.cameraId)}`);
        }}
        height="calc(100vh - 44px)"
      />
    </div>
  );
}

/** The Cast to display button: its menu lists what can be done with it; for now one option, Cast to display. */
function CastMenu({ wallId }: { wallId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`gbtn gbtn--icon${open ? ' is-on' : ''}`} onClick={() => setOpen(true)} title="Cast to a display" aria-label="Cast to display">
        <Icon name="cast" size={18} />
      </button>
      {open && <CastDialog currentWallId={wallId} onClose={() => setOpen(false)} />}
    </>
  );
}
