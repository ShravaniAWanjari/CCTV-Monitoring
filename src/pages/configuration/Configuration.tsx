import { useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { Icon, type IconName } from '../../components/Icon';
import { ReadOnlyNote } from '../../components/Shell';
import { CHANNEL, Choice, MultiSelect, NumberField, PRIORITY_NAME, PriorityBadge, useConfirm } from '../../components/ui';
import type { Channel, Policy, Priority, Role, Wall } from '../../data/types';
import { duration } from '../../lib/time';
import { isActiveRule } from '../../lib/usecases';
import { isAdmin, savePolicies, TEAMS_BY_ID, toast, useCameras, useMe, usePolicies, useRules, useWalls } from '../../state/store';
import { CameraEditor } from '../cameras/CameraEditor';
import { Cameras, setupState } from '../cameras/Cameras';
import { RuleEditor } from '../rules/RuleEditor';
import { Rules } from '../rules/Rules';
import { EditPanel, newWall } from '../wall/VideoWall';
import '../overview-gyt.css';
import '../alerts/alerts-gyt.css';
import '../cameras/cameras-gyt.css';
import '../wall/wall-gyt.css';
import './configuration.css';

/** Everything that is set up rather than watched, as four tabs across the top: who is told about alerts, the rules, the
 *  cameras and the video walls. Each tab says how many there are and what still needs attention. */
export function Configuration() {
  const rules = useRules().filter(isActiveRule);
  const cams = useCameras();
  const walls = useWalls();
  const policies = usePolicies();
  const watched = new Set(rules.flatMap((r) => r.cameraIds));
  const notReady = cams.filter((c) => setupState(c, watched.has(c.id) ? 1 : 0).next).length;
  const live = rules.filter((r) => r.mode === 'live').length;
  const tabs: { to: string; label: string; icon: IconName; meta: string; todo?: string }[] = [
    { to: '/configuration/alerts', label: 'Alerts', icon: 'bell', meta: `Who is told · ${policies.length} levels` },
    { to: '/configuration/rules', label: 'Rules', icon: 'rule', meta: `${rules.length} rules · ${live} live`, todo: rules.length - live ? `${rules.length - live} in test` : undefined },
    { to: '/configuration/cameras', label: 'Cameras', icon: 'cctv', meta: `${cams.length} cameras`, todo: notReady ? `${notReady} not set up` : undefined },
    { to: '/configuration/walls', label: 'Video walls', icon: 'wall', meta: `${walls.length} ${walls.length === 1 ? 'wall' : 'walls'}` },
  ];
  return (
    <div className="page page--wide gyt gcfg">
      <header className="gcfg__head">
        <h1>Configuration</h1>
        <p>What Sentinel watches, who is told, and what the screens show.</p>
      </header>
      <nav className="gcfg__tabs" aria-label="Configuration">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => `gcfg__tab${isActive ? ' is-active' : ''}`}>
            <Icon name={t.icon} size={20} stroke={1.7} />
            <span className="gcfg__tabtext">
              <strong>{t.label}</strong>
              <span>
                {t.meta}
                {t.todo && <em> · {t.todo}</em>}
              </span>
            </span>
          </NavLink>
        ))}
      </nav>
      <div className="gcfg__panel">
        <Outlet />
      </div>
    </div>
  );
}

export function AlertsSection() {
  return <AlertSettings />;
}
export function RulesSection() {
  return <Rules embedded />;
}
export function CamerasSection() {
  return <Cameras embedded />;
}
export function NewRuleSection() {
  return <RuleEditor key="new" />;
}
export function RuleSection() {
  const { ruleId } = useParams();
  return <RuleEditor key={ruleId} />;
}
export function CameraSection() {
  const { cameraId } = useParams();
  return <CameraEditor key={cameraId ?? 'new'} />;
}

// ── Alerts: who is told for each criticality, and what happens when nobody responds ────────────────────────────────
const ROLES: Role[] = ['Control room operator', 'Shift supervisor', 'HSE manager', 'Terminal manager'];
const CHANNELS: Channel[] = ['wall', 'push', 'sms', 'whatsapp', 'email', 'call'];
const WALL_OPTIONS = [
  { value: 'takeover' as const, label: 'Takes over a tile' },
  { value: 'sound' as const, label: 'Alarm sound' },
];
const secs = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);

/** The four criticality levels side by side, each summed up in a few words; the one picked opens below, its nine settings
 *  in three groups. Changes to any level are saved together from the bar at the bottom. */
function AlertSettings() {
  const saved = usePolicies();
  const admin = isAdmin(useMe());
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Policy[]>(saved);
  const [level, setLevel] = useState<Priority>(saved[0]?.priority ?? 'P1');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const changed = new Set(draft.filter((x, i) => JSON.stringify(x) !== JSON.stringify(saved[i])).map((x) => x.priority));
  const p = draft.find((x) => x.priority === level) ?? draft[0];
  const set = (patch: Partial<Policy>) => setDraft(draft.map((x) => (x.priority === p.priority ? { ...x, ...patch } : x)));
  const id = (k: string) => `${k}-${p.priority}`;
  const maxRem = p.priority === 'P1' ? 3 : 5;

  return (
    <section className="gacfg">
      <ReadOnlyNote>Only the safety admin changes who is told about alerts.</ReadOnlyNote>
      <div className="gacfg__levels" role="tablist" aria-label="Criticality">
        {draft.map((x) => (
          <button key={x.priority} type="button" role="tab" aria-selected={x.priority === level} className="gacfg__level" onClick={() => setLevel(x.priority)}>
            <span className="gacfg__levelhead">
              <PriorityBadge p={x.priority} short />
              <strong>{PRIORITY_NAME[x.priority]}</strong>
              {changed.has(x.priority) && <i className="gacfg__dot" title="Changed, not saved" />}
            </span>
            <span className="gacfg__sum">
              <span>
                <Icon name="bell" size={13} />
                {x.channels.length ? x.channels.map((c) => CHANNEL[c].label).join(', ') : 'Nobody is told'}
              </span>
              <span>
                <Icon name="users" size={13} />
                {x.notify.length ? x.notify.join(', ') : 'No one'}
              </span>
              <span>
                <Icon name="clock" size={13} />
                Review in {secs(x.reviewWithinSec)}
                {x.escalateTo !== 'none' ? `, then ${x.escalateTo}` : ', no escalation'}
              </span>
            </span>
          </button>
        ))}
      </div>

      <fieldset className="plain gacfg__edit" disabled={!admin}>
        <div className="gacfg__edithead">
          <PriorityBadge p={p.priority} />
          <h2>{PRIORITY_NAME[p.priority]} alerts</h2>
          <span className="gacfg__story">
            {p.notify.length ? p.notify.join(' and ') : 'Nobody'} told by {p.channels.length ? p.channels.map((c) => CHANNEL[c].label).join(', ') : 'no channel'}; reviewed within {duration(p.reviewWithinSec * 1000)}
            {p.escalateTo !== 'none' ? `, or it goes to the ${p.escalateTo}` : ''}.
          </span>
        </div>
        <div className="gacfg__groups">
          <div className="gacfg__group">
            <h3>Who is told, and how</h3>
            <MultiSelect id={id('via')} label="Notify via" placeholder="No channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL[c].label, icon: CHANNEL[c].icon }))} value={p.channels} onChange={(channels) => set({ channels })} />
            <MultiSelect id={id('who')} label="Notify first" placeholder="No one" options={ROLES.map((r) => ({ value: r, label: r }))} value={p.notify} onChange={(notify) => set({ notify })} />
            <MultiSelect
              id={id('wall')}
              label="On the video wall"
              placeholder="Nothing on the wall"
              options={WALL_OPTIONS}
              value={WALL_OPTIONS.filter((o) => (o.value === 'takeover' ? p.wallTakeover : p.sound)).map((o) => o.value)}
              onChange={(v) => set({ wallTakeover: v.includes('takeover'), sound: v.includes('sound') })}
            />
          </div>
          <div className="gacfg__group">
            <h3>Deadlines and escalation</h3>
            <Choice id={id('rev')} label="Review within" value={p.reviewWithinSec} onChange={(reviewWithinSec) => set({ reviewWithinSec })} options={[30, 60, 120, 300, 600, 900].map((s) => ({ value: s, label: secs(s) }))} />
            <Choice id={id('rep')} label="Report within" value={p.reportWithinSec} onChange={(reportWithinSec) => set({ reportWithinSec })} options={[{ value: 0, label: 'Not reported' }, ...[60, 120, 300, 900, 1800, 3600].map((s) => ({ value: s, label: secs(s) }))]} />
            <Choice id={id('esc')} label="If not reviewed, escalate to" value={p.escalateTo} onChange={(escalateTo) => set({ escalateTo })} options={[{ value: 'none' as Role | 'none', label: 'No one' }, ...ROLES.map((r) => ({ value: r as Role | 'none', label: r }))]} />
          </div>
          <div className="gacfg__group">
            <h3>Reminders and the report</h3>
            <NumberField id={id('rem')} label="Remind every" min={0} max={60} value={p.remindEveryMin} onChange={(remindEveryMin) => set({ remindEveryMin })} unit={(n) => (n === 0 ? 'off' : 'min')} />
            <NumberField id={id('remmax')} label="At most" min={1} max={maxRem} value={Math.min(p.remindMax ?? 3, maxRem)} onChange={(remindMax) => set({ remindMax })} unit={(n) => (n === 1 ? 'reminder' : 'reminders')} disabled={p.remindEveryMin === 0} />
            <Choice
              id={id('qav')}
              label="Report"
              value={p.report}
              onChange={(report) => set({ report })}
              options={[
                { value: 'on-acknowledge' as Policy['report'], label: 'When reviewed' },
                { value: 'reviewer-decides' as Policy['report'], label: 'The reviewer decides' },
                { value: 'never' as Policy['report'], label: 'Never' },
              ]}
            />
          </div>
        </div>
      </fieldset>

      {admin && (
        <div className="gcs__foot">
          <span className={`gcs__saved${dirty ? ' is-dirty' : ' is-clean'}`} aria-live="polite">
            <i aria-hidden="true" />
            {dirty ? `Unsaved changes on ${[...changed].join(', ')}` : 'All changes saved'}
          </span>
          <span className="spacer" />
          {dirty && (
            <button type="button" className="gbtn" onClick={() => confirm.ask({ title: 'Discard your changes?', message: 'Every level goes back to how it was last saved.', action: 'Discard' }, () => setDraft(saved))}>
              Discard
            </button>
          )}
          <button
            type="button"
            className="gbtn gbtn--primary"
            disabled={!dirty}
            onClick={() => {
              savePolicies(draft);
              toast('Alert settings saved. New and open alerts follow them from now on.');
            }}
          >
            Save
          </button>
        </div>
      )}
      {confirm.dialog}
    </section>
  );
}

// ── Video walls: every wall in a list, the picked one (or a new one) edited beside it ────────────────────────────────
export function WallSection() {
  const walls = useWalls();
  const me = useMe();
  const nav = useNavigate();
  const admin = isAdmin(me);
  const [pick, setPick] = useState<string>(walls[0]?.id ?? 'new');
  const fresh = useMemo(() => newWall(admin ? '' : me.teamId), [admin, me.teamId]);
  const saved = walls.find((w) => w.id === pick) ?? fresh;
  const [draft, setDraft] = useState<Wall>(saved);
  const open = (target: string) => {
    setPick(target);
    setDraft(target === 'new' ? newWall(admin ? '' : me.teamId) : (walls.find((w) => w.id === target) ?? fresh));
  };
  const count = (w: Wall) => new Set([...w.rotation, ...w.pinned.filter(Boolean)]).size;
  const isNew = pick === 'new' || !walls.some((w) => w.id === pick);

  return (
    <section className="gwcfg">
      <aside className="gwcfg__list" aria-label="Video walls">
        <button type="button" className={`gwcfg__item gwcfg__new${isNew ? ' is-sel' : ''}`} onClick={() => open('new')}>
          <Icon name="plus" size={16} />
          New video wall
        </button>
        {walls.map((w) => (
          <button key={w.id} type="button" className={`gwcfg__item${pick === w.id ? ' is-sel' : ''}`} onClick={() => open(w.id)}>
            <strong>{w.name || 'Untitled wall'}</strong>
            <span>
              {TEAMS_BY_ID[w.teamId]?.name ?? 'No team'} · {count(w)} cameras
            </span>
          </button>
        ))}
      </aside>
      <div className="gwcfg__edit">
        <div className="gwcfg__edithead">
          <div>
            <h2>{isNew ? 'New video wall' : draft.name || 'Untitled wall'}</h2>
            <span>{isNew ? 'Name it, give it a team, and choose its cameras.' : 'Its name, team and cameras. How it rolls is set on the wall itself.'}</span>
          </div>
          {!isNew && (
            <Link className="gbtn gbtn--sm" to={`/wall/${pick}`}>
              <Icon name="wall" size={15} />
              Open the wall
            </Link>
          )}
        </div>
        <div className="cfgwall">
          <EditPanel key={pick} draft={draft} setDraft={setDraft} saved={saved} onDone={() => (isNew ? nav('/wall') : open(pick))} />
        </div>
      </div>
    </section>
  );
}
