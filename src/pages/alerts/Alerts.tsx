import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AckDialog, EscalateDialog, NoteDialog, RaiseDialog } from '../../components/AlertDialogs';
import { Icon } from '../../components/Icon';
import { CameraView, CHANNEL, Choice, Modal, PRIORITY_NAME, PriorityBadge, Seg } from '../../components/ui';
import { AREAS } from '../../data/seed';
import type { Alert, Camera, Priority } from '../../data/types';
import { apiUrl } from '../../lib/backend';
import { activityText, describeRule } from '../../lib/assist';
import { ago, dayTime, duration, hms, useNow } from '../../lib/time';
import { useService } from '../../state/bridge';
import { alertAreasFor, AREAS_BY_ID, canConfigure, mayReport, isOpen, roleText, TEAMS_BY_ID, useAlerts, useCameras, useMe, usePolicies, useRules, userName, USERS_BY_ID } from '../../state/store';
import './alerts.css';
import '../overview-gyt.css';
import './alerts-gyt.css';
import { assetUrl } from '../../lib/assets';

type Tab = 'open' | 'acknowledged' | 'closed' | 'all';

const inTab = (a: Alert, t: Tab) =>
  t === 'all' ? true : t === 'open' ? isOpen(a) : t === 'acknowledged' ? a.state === 'acknowledged' : a.state === 'resolved' || a.state === 'false-alarm';

type Sort = 'newest' | 'critical';
const TABS: { value: Tab; label: string }[] = [
  { value: 'open', label: 'Needs action' },
  { value: 'acknowledged', label: 'Reviewed' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];
const STATE_WORD: Record<Alert['state'], string> = { new: 'New', escalated: 'Escalated', acknowledged: 'Reviewed', resolved: 'Closed', 'false-alarm': 'False alarm' };

export function Alerts() {
  const { alertId } = useParams();
  const nav = useNavigate();
  const me = useMe();
  const everyAlert = useAlerts();
  const cams = useCameras();
  const policies = usePolicies();
  // The list follows who is signed in: managers and the safety admin see every alert, a supervisor or operator sees the alerts of their team's work areas.
  const areas = alertAreasFor(me);
  const alerts = useMemo(() => {
    if (areas === 'all') return everyAlert;
    const areaOf = new Map(cams.map((c) => [c.id, c.areaId]));
    return everyAlert.filter((a) => areas.includes(areaOf.get(a.cameraId) ?? ''));
  }, [everyAlert, cams, areas]);
  const now = useNow(1000);
  // Links from the Overview can open the list already narrowed: ?level=P1&tab=open. Without one, the list opens on what needs action.
  const [params] = useSearchParams();
  const startTab = params.get('tab');
  const startLevel = params.get('level');
  const [tab, setTab] = useState<Tab>(startTab === 'all' || startTab === 'acknowledged' || startTab === 'closed' ? startTab : 'open');
  const [prio, setPrio] = useState<Priority | 'all'>(startLevel === 'P1' || startLevel === 'P2' || startLevel === 'P3' || startLevel === 'P4' ? startLevel : 'all');
  const [area, setArea] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  // Opened from a camera (its badge on the video wall): only that camera's alerts, kept while you click through them.
  const onlyCam = params.get('camera') ?? '';
  // Opened from a rule (its alert count on the Rules page): only that rule's alerts.
  const onlyRule = params.get('rule') ?? '';
  const keep = onlyCam ? `?camera=${encodeURIComponent(onlyCam)}` : onlyRule ? `?rule=${encodeURIComponent(onlyRule)}` : '';
  const camById = useMemo(() => new Map(cams.map((c) => [c.id, c])), [cams]);
  const allRules = useRules();
  const ruleById = useMemo(() => new Map(allRules.map((r) => [r.id, r])), [allRules]);
  const dueBy = useMemo(() => new Map(policies.map((p) => [p.priority, p])), [policies]);

  const scoped = alerts.filter((a) => {
    if (onlyCam && a.cameraId !== onlyCam) return false;
    if (onlyRule && a.ruleId !== onlyRule) return false;
    if (prio !== 'all' && a.priority !== prio) return false;
    const cam = camById.get(a.cameraId);
    if (area !== 'all' && cam?.areaId !== area) return false;
    const t = q.trim().toLowerCase();
    return !t || `${a.id} ${a.title} ${cam?.id} ${cam?.name} ${a.report?.ref ?? ''}`.toLowerCase().includes(t);
  });
  const counts = Object.fromEntries(TABS.map((t) => [t.value, scoped.filter((a) => inTab(a, t.value)).length])) as Record<Tab, number>;
  const filtered = scoped.filter((a) => inTab(a, tab));
  // Most critical: P1 first, and escalated before new within a level. Ties fall back to newest first.
  filtered.sort((a, b) => (sort === 'critical' ? Number(a.priority.slice(1)) - Number(b.priority.slice(1)) || (b.state === 'escalated' ? 1 : 0) - (a.state === 'escalated' ? 1 : 0) : 0) || b.at - a.at);
  const selected = alerts.find((a) => a.id === alertId);
  const openAll = alerts.filter(isOpen);
  const escalated = openAll.filter((a) => a.state === 'escalated').length;
  const narrowed = prio !== 'all' || area !== 'all' || q.trim() !== '';

  // Up and down arrows step through the list; the open alert follows.
  const listRef = useRef<HTMLDivElement>(null);
  const step = useRef<(d: number) => void>(() => undefined);
  step.current = (d: number) => {
    if (!filtered.length) return;
    const i = filtered.findIndex((a) => a.id === alertId);
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, i < 0 ? 0 : i + d))];
    nav(`/alerts/${next.id}${keep}`, { replace: true });
    window.requestAnimationFrame(() => listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.scrim, .cmdk')) return;
      if (e.key === 'ArrowDown' || e.key === 'j') step.current(1);
      else if (e.key === 'ArrowUp' || e.key === 'k') step.current(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const rowStatus = (a: Alert) => {
    if (a.state === 'escalated') return <span className="alrow__state is-red">Escalated</span>;
    if (a.state === 'new') {
      const p = dueBy.get(a.priority);
      if (!p || p.escalateTo === 'none') return <span className="alrow__state">New</span>;
      const left = a.at + p.reviewWithinSec * 1000 - now;
      return left > 0 ? <span className="alrow__state">Review in {duration(left)}</span> : <span className="alrow__state is-red">Overdue</span>;
    }
    return <span className="alrow__state is-quiet">{STATE_WORD[a.state]}</span>;
  };

  return (
    <div className="page page--wide gyt gal">
      <header className="gal__head">
        <div className="ovhead__title">
          <h1>Alerts</h1>
          <p className="ovhead__sub">
            <span>{areas === 'all' ? 'All areas' : TEAMS_BY_ID[me.teamId]?.name}</span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span>
              <span className="mono">{openAll.length}</span> need action
            </span>
            {escalated > 0 && (
              <>
                <span className="ovhead__sep" aria-hidden="true" />
                <span className="gal__red">
                  <span className="mono">{escalated}</span> escalated
                </span>
              </>
            )}
          </p>
        </div>
        <div className="ovhead__actions">
          {canConfigure(me) && (
            <button type="button" className="gbtn gbtn--icon" onClick={() => nav('/configuration/alerts')} aria-label="Alert settings" title="Alert settings: who is told, how, and when alerts escalate">
              <Icon name="settings" size={18} />
            </button>
          )}
        </div>
      </header>

      <div className={`gal__body${selected ? ' has-detail' : ''}`}>
        <section className="gal__list" aria-label="Alert list">
          <div className="gal__tools">
            <div className="gal__tabs" role="tablist" aria-label="Alert status">
              {TABS.map((t) => (
                <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}>
                  {t.label}
                  <span className={`gal__n mono${t.value === 'open' && counts.open > 0 ? ' is-red' : ''}`}>{counts[t.value]}</span>
                </button>
              ))}
            </div>
            <div className="gal__search">
              <Icon name="search" size={16} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by what happened, camera or alert ID" aria-label="Search alerts" />
              {q && (
                <button type="button" onClick={() => setQ('')} aria-label="Clear the search">
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
            <div className="gal__filters">
              <div className="gal__prio" role="group" aria-label="Criticality">
                {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
                  <button key={p} type="button" aria-pressed={prio === p} className={`gal__p gal__p--${p}`} onClick={() => setPrio(prio === p ? 'all' : p)} title={`Only ${p} ${PRIORITY_NAME[p]}`}>
                    {p}
                  </button>
                ))}
              </div>
              <Choice id="al-area" small label="Area" clearTo="all" value={area} onChange={setArea} options={[{ value: 'all', label: 'All areas' }, ...AREAS.map((a) => ({ value: a.id, label: a.name }))]} />
              <span className="spacer" />
              <button type="button" className="gal__sort" onClick={() => setSort(sort === 'newest' ? 'critical' : 'newest')} title="Change the order">
                <Icon name="list" size={15} />
                {sort === 'newest' ? 'Newest first' : 'Most critical first'}
              </button>
            </div>
            {(onlyCam || onlyRule || narrowed) && (
              <div className="gal__active">
                {onlyCam && (
                  <span className="gal__chip">
                    <Icon name="camera" size={14} />
                    {onlyCam}
                    {camById.get(onlyCam) && <span className="gal__chipname"> · {camById.get(onlyCam)!.name}</span>}
                    <button type="button" onClick={() => nav(`/alerts${alertId ? `/${alertId}` : ''}`)} aria-label="Show every camera">
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                )}
                {onlyRule && (
                  <span className="gal__chip">
                    <Icon name="rule" size={14} />
                    {onlyRule}
                    {ruleById.get(onlyRule) && <span className="gal__chipname"> · {ruleById.get(onlyRule)!.name}</span>}
                    <button type="button" onClick={() => nav(`/alerts${alertId ? `/${alertId}` : ''}`)} aria-label="Show every rule">
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                )}
                {narrowed && (
                  <button
                    type="button"
                    className="gal__clear"
                    onClick={() => {
                      setPrio('all');
                      setArea('all');
                      setQ('');
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="gal__rows" ref={listRef}>
            {filtered.length === 0 ? (
              <div className="gal__empty">
                <strong>{tab === 'open' && !narrowed && !onlyCam && !onlyRule ? 'Nothing needs action' : 'No alerts here'}</strong>
                <span>{tab === 'open' && !narrowed && !onlyCam && !onlyRule ? 'Every alert has been reviewed.' : 'Try another status or clear the filters.'}</span>
              </div>
            ) : (
              filtered.map((a) => {
                const cam = camById.get(a.cameraId);
                const go = () => nav(`/alerts/${a.id}${keep}`);
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-id={a.id}
                    className={`alrow${a.id === alertId ? ' is-selected' : ''}${a.state === 'new' ? ' is-new' : ''}`}
                    onClick={go}
                    aria-current={a.id === alertId}
                  >
                    <PriorityBadge p={a.priority} short />
                    <span className="alrow__main">
                      <span className="alrow__title">{a.title}</span>
                      <span className="alrow__where">{cam ? `${cam.id} · ${cam.name}` : a.cameraId}</span>
                    </span>
                    <span className="alrow__side">
                      <span className="alrow__time mono" title={dayTime(a.at)}>
                        {ago(a.at, now)}
                      </span>
                      {rowStatus(a)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="gal__foot">
            <span>
              <span className="mono">{filtered.length}</span> shown
            </span>
            <span className="gal__keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move through alerts
            </span>
          </div>
        </section>
        {selected ? (
          <AlertDetail key={selected.id} alert={selected} onClose={() => nav(`/alerts${keep}`)} />
        ) : (
          <section className="gal__hint">
            <Icon name="bell" size={22} />
            <strong>Select an alert</strong>
            <span>The picture, what to do and who has been told appear here.</span>
          </section>
        )}
      </div>
    </div>
  );
}

/** A link to the rule for someone who can configure; plain text for everyone else. */
function Wrapper({ to, children }: { to?: string; children: React.ReactNode }) {
  return to ? (
    <Link to={to} className="rulecard">
      {children}
    </Link>
  ) : (
    <div className="rulecard">{children}</div>
  );
}

/** The short clip saved with the alert, in a window. It plays from the detection service; with the service not running, the copy
 *  shipped for the sample alerts plays instead. */
function ClipDialog({ alert, cam, onClose }: { alert: Alert; cam: Camera; onClose: () => void }) {
  const service = useService();
  const file = alert.clip!.split('/').pop()!;
  const src = service.online ? apiUrl(alert.clip!) : assetUrl(`fallback/clips/${file}`);
  return (
    <Modal
      title="Incident clip"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="aclip__what">
        <PriorityBadge p={alert.priority} short />
        <strong>{alert.title}</strong>
        <span className="mono aclip__id">{alert.id}</span>
      </div>
      <div className="aclip__frame">
        <video className="aclip__video" src={src} controls autoPlay loop muted playsInline />
      </div>
      <dl className="aclip__meta">
        <div>
          <dt>Camera</dt>
          <dd>
            {cam.id} · {cam.name}
          </dd>
        </div>
        <div>
          <dt>Area</dt>
          <dd>{AREAS_BY_ID[cam.areaId]?.name}</dd>
        </div>
        <div>
          <dt>Raised</dt>
          <dd>{dayTime(alert.at)}</dd>
        </div>
      </dl>
    </Modal>
  );
}

function AlertDetail({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const me = useMe();
  const cams = useCameras();
  const rules = useRules();
  const policies = usePolicies();
  const now = useNow(1000);
  const [dialog, setDialog] = useState<'ack' | 'raise' | 'resolve' | 'false' | 'escalate'>();
  const [live, setLive] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  // One section open at a time, so the three headings always fit beside the picture.
  const [section, setSection] = useState<'what' | 'who' | 'rule' | null>('what');
  const fold = (k: 'what' | 'who' | 'rule') => ({
    open: section === k,
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('summary')) {
        e.preventDefault();
        setSection(section === k ? null : k);
      }
    },
  });
  const cam = cams.find((c) => c.id === alert.cameraId);
  const rule = rules.find((r) => r.id === alert.ruleId);
  const policy = policies.find((p) => p.priority === alert.priority);
  if (!cam)
    return (
      <section className="gal__detail">
        <div className="gald__body">
          <strong>{alert.title}</strong>
          <p className="meta">Camera {alert.cameraId} has been removed, so there is no picture to show. The alert is kept as history.</p>
        </div>
      </section>
    );
  const zoneNames = cam.zones.filter((z) => rule?.zoneIds.includes(z.id)).map((z) => z.name);
  const zoneName = cam.zones.find((z) => z.id === alert.zoneId)?.name ?? (zoneNames.length === 1 ? zoneNames[0] : undefined);
  const open = isOpen(alert);
  const dueAt = policy ? alert.at + policy.reviewWithinSec * 1000 : 0;
  const canReport = !alert.report && alert.state !== 'false-alarm' && mayReport(me);
  const read = alert.deliveries.filter((d) => d.status === 'read').length;

  return (
    <section className="gal__detail" aria-label={`Alert ${alert.id}`}>
      <div className="gald__head">
        <button type="button" className="gald__back" onClick={onClose}>
          <Icon name="arrow-left" size={15} />
          All alerts
        </button>
        <PriorityBadge p={alert.priority} />
        <span className={`gald__state gald__state--${alert.state}`}>{STATE_WORD[alert.state]}</span>
        <span className="spacer" />
        <span className="gald__id mono">{alert.id}</span>
        <Link to={`/m/${alert.id}`} className="gbtn gbtn--icon gbtn--sm" title="What the supervisor sees on the phone" aria-label="Phone view">
          <Icon name="mobile" size={16} />
        </Link>
        <button type="button" className="gbtn gbtn--icon gbtn--sm gald__x" onClick={onClose} aria-label="Close">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="gald__body">
        <div>
          <h2 className="gald__title">{alert.title}</h2>
          <p className="gald__where">
            {cam.id} · {cam.name}
            <span className="ovhead__sep" aria-hidden="true" />
            {AREAS_BY_ID[cam.areaId]?.name}
            <span className="ovhead__sep" aria-hidden="true" />
            <span title={dayTime(alert.at)}>
              {hms(alert.at)} · {ago(alert.at, now)}
            </span>
          </p>
        </div>

        {open && policy && (
          <div className={`gald__due${alert.state === 'escalated' || (policy.escalateTo !== 'none' && dueAt <= now) ? ' is-late' : ''}`}>
            <Icon name="clock" size={16} />
            {alert.state === 'escalated' ? (
              <span>
                Not reviewed in time. Escalated to <strong>{userName(alert.escalatedTo)}</strong>.
              </span>
            ) : policy.escalateTo === 'none' ? (
              <span>Open for {duration(now - alert.at)}. {policy.priority} alerts are not escalated.</span>
            ) : dueAt > now ? (
              <span>
                Review in <strong className="mono">{duration(dueAt - now)}</strong>, or it goes to the {roleText(policy.escalateTo)}.
              </span>
            ) : (
              <span>Review time is up. It is going to the {roleText(policy.escalateTo)}.</span>
            )}
          </div>
        )}

        <div className="gald__split">
        <div className="gald__media">
          <CameraView cam={cam} still={!live} alert={live ? undefined : alert} zones={cam.zones} highlightZones={alert.zoneId ? [alert.zoneId] : undefined} showZoneLabels now={live ? now : undefined} />
          <div className="gald__mediabar">
            <Seg
              label="Picture"
              small
              value={live ? 'live' : 'snap'}
              onChange={(v) => setLive(v === 'live')}
              options={[
                { value: 'snap', label: <>At the alert · <span className="mono">{hms(alert.at)}</span></> },
                { value: 'live', label: 'Live now' },
              ]}
            />
            {alert.clip && (
              <button type="button" className="gbtn gbtn--sm" onClick={() => setClipOpen(true)} title="Play the clip saved with this alert" aria-label="Play clip">
                <Icon name="replay" size={16} />
                <span className="gald__cliplabel">Play clip</span>
              </button>
            )}
          </div>
        </div>

        {alert.report && (
          <div className="gald__qrec">
            <Icon name="shield" size={16} />
            <span>
              Reported as a {alert.report.type.toLowerCase()} <span className="mono">{alert.report.ref}</span> by {userName(alert.report.createdBy)}, {ago(alert.report.at, now)}
            </span>
          </div>
        )}

        <div className="gald__more" aria-label="About this incident">
          <details {...fold('what')}>
            <summary>
              <span>What happened</span>
              <span className="gald__sum">
                {alert.activity.length} {alert.activity.length === 1 ? 'step' : 'steps'}
              </span>
            </summary>
            <ol className="timeline">
              {[...alert.activity].reverse().map((e, i) => (
                <li key={i}>
                  <span className="timeline__text">{activityText(e.text, rule, zoneName)}</span>
                  <span className="timeline__meta">
                    <span className="mono">{hms(e.at)}</span>
                    {e.actor !== 'system' && ` · ${userName(e.actor)}`}
                  </span>
                </li>
              ))}
            </ol>
          </details>
          <details {...fold('who')}>
            <summary>
              <span>Who was told</span>
              <span className="gald__sum">
                {alert.deliveries.length} people · {read} read
              </span>
            </summary>
            <ul className="gald__people">
              {alert.deliveries.map((d, i) => (
                <li key={i}>
                  <Icon name={CHANNEL[d.channel].icon} size={15} />
                  <span className="gald__who">
                    {userName(d.to)}
                    <span className="meta">
                      {USERS_BY_ID[d.to]?.role} · {CHANNEL[d.channel].label}
                      {d.reason !== 'alert' && ` · ${d.reason}`}
                    </span>
                  </span>
                  <span className="mono meta">{hms(d.at)}</span>
                  <span className={`gald__dstate${d.status === 'failed' ? ' is-red' : d.status === 'read' ? ' is-read' : ''}`}>{d.status}</span>
                </li>
              ))}
            </ul>
          </details>
          <details {...fold('rule')}>
            <summary>
              <span>Rule</span>
              <span className="gald__sum">{rule ? rule.name : 'deleted'}</span>
            </summary>
            {rule ? (
              <Wrapper to={canConfigure(me) ? `/rules/${rule.id}` : undefined}>
                <strong>{rule.name}</strong>
                <span className="meta">{describeRule(rule, zoneNames)}</span>
                <span className="meta">
                  <span className="mono">{rule.id}</span> · {rule.cameraIds.length} cameras · {rule.mode === 'live' ? 'Live' : 'Test'}
                </span>
              </Wrapper>
            ) : (
              <span className="meta">The rule has been deleted.</span>
            )}
          </details>
        </div>
        </div>
        {clipOpen && alert.clip && <ClipDialog alert={alert} cam={cam} onClose={() => setClipOpen(false)} />}
      </div>
      {/* One clear next step, the others beside it. */}
      {(open || alert.state === 'acknowledged' || canReport) && (
        <div className="gald__actions" role="group" aria-label="What to do">
          {open && (
            <button type="button" className="gbtn gbtn--primary gald__main" onClick={() => setDialog('ack')}>
              <Icon name="check" size={16} />
              Review
            </button>
          )}
          {alert.state === 'acknowledged' && (
            <button type="button" className="gbtn gbtn--primary gald__main" onClick={() => setDialog('resolve')}>
              <Icon name="check" size={16} />
              Close alert
            </button>
          )}
          {canReport && (
            <button type="button" className="gbtn gald__report" onClick={() => setDialog('raise')}>
              <Icon name="send" size={15} />
              Report
            </button>
          )}
          {open && (
            <button type="button" className="gbtn" onClick={() => setDialog('escalate')}>
              <Icon name="arrow-up" size={15} />
              Escalate
            </button>
          )}
          {alert.state !== 'resolved' && alert.state !== 'false-alarm' && (
            <button type="button" className="gbtn gbtn--quiet" onClick={() => setDialog('false')}>
              False alarm
            </button>
          )}
        </div>
      )}

      {dialog === 'ack' && <AckDialog alert={alert} via="console" onClose={() => setDialog(undefined)} />}
      {dialog === 'raise' && <RaiseDialog alert={alert} onClose={() => setDialog(undefined)} />}
      {dialog === 'escalate' && <EscalateDialog alert={alert} onClose={() => setDialog(undefined)} />}
      {(dialog === 'resolve' || dialog === 'false') && <NoteDialog alert={alert} kind={dialog} onClose={() => setDialog(undefined)} />}
    </section>
  );
}
