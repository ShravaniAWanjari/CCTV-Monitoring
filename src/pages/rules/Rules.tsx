import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { ReadOnlyNote } from '../../components/Shell';
import { MultiSelect, PRIORITY_NAME, PriorityBadge, Switch } from '../../components/ui';
import type { Classification, Condition, Priority, ReportType, Rule, Schedule } from '../../data/types';
import { describeRule, SCHEDULE_LABEL } from '../../lib/assist';
import { ACTIVE_CONDITIONS, conditionLabel, isActiveRule, LOOKS_FOR, looksOf, type Looks } from '../../lib/usecases';
import { AREAS_BY_ID, isAdmin, saveRule, toast, useAlerts, useCameras, useMe, useRules } from '../../state/store';
import './rules.css';
import '../overview-gyt.css';
import '../alerts/alerts-gyt.css';
import '../cameras/cameras-gyt.css';
import './rules-gyt.css';

// The rule list: what every rule watches for, where, how critical it is and whether it is live. One click opens a rule;
// the switch makes it live or puts it back in test without opening it.

const LEVELS: Priority[] = ['P1', 'P2', 'P3', 'P4'];
const RECORDS: (ReportType | 'none')[] = ['Incident', 'Near miss', 'Observation', 'none'];

type Tab = 'all' | 'live' | 'test' | 'idle';
type SortKey = 'id' | 'name' | 'cams' | 'alerts' | 'priority' | 'mode';

/** The less used ways to narrow the list, in the "More filters" panel. Each group keeps rules matching any ticked option. */
type FilterKey = 'record' | 'classification' | 'condition' | 'subject' | 'schedule';
type Filters = Record<FilterKey, string[]>;
const NO_FILTERS: Filters = { record: [], classification: [], condition: [], subject: [], schedule: [] };

/** `embedded`: shown as a tab of Configuration, which has its own title; only the actions stay at the top. */
export function Rules({ embedded = false }: { embedded?: boolean } = {}) {
  const allRules = useRules();
  // Rules of the use cases set aside (sample data) stay in the store for their alerts, but are not listed.
  const rules = useMemo(() => allRules.filter(isActiveRule), [allRules]);
  const cams = useCameras();
  const alerts = useAlerts();
  const me = useMe();
  const nav = useNavigate();
  const admin = isAdmin(me);
  // The Overview's "rules still in test" opens this list on the In test tab: ?tab=test.
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'test' ? 'test' : 'all');
  const [q, setQ] = useState('');
  const [prio, setPrio] = useState<Priority | 'all'>('all');
  const [areas, setAreas] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [panel, setPanel] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: 'id', up: true });
  const more = Object.values(filters).reduce((n, v) => n + v.length, 0);

  const dayAgo = Date.now() - 86400000;
  const camsOf = (r: Rule) => cams.filter((c) => r.cameraIds.includes(c.id));
  const zonesOf = (r: Rule) => [...new Set(camsOf(r).flatMap((c) => c.zones.filter((z) => r.zoneIds.includes(z.id)).map((z) => z.name)))];
  const alertsToday = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of alerts) if (a.at > dayAgo) m.set(a.ruleId, (m.get(a.ruleId) ?? 0) + 1);
    return m;
  }, [alerts, dayAgo]);
  const facets = (r: Rule): Filters => ({
    record: [r.report],
    classification: r.report === 'none' ? [] : [r.classification],
    condition: [r.condition],
    subject: [looksOf(r)],
    schedule: [r.schedule],
  });

  const t = q.trim().toLowerCase();
  const scoped = rules.filter((r) => {
    if (prio !== 'all' && r.priority !== prio) return false;
    if (areas.length && !camsOf(r).some((c) => areas.includes(c.areaId))) return false;
    const f = facets(r);
    if ((Object.keys(filters) as FilterKey[]).some((k) => filters[k].length && !filters[k].some((v) => f[k].includes(v)))) return false;
    if (!t) return true;
    const text = [r.id, r.name, r.plainText ?? '', describeRule(r, zonesOf(r)), SCHEDULE_LABEL[r.schedule], PRIORITY_NAME[r.priority], r.report, ...camsOf(r).map((c) => `${c.id} ${c.name} ${AREAS_BY_ID[c.areaId]?.name ?? ''}`)].join(' ').toLowerCase();
    return text.includes(t);
  });
  const isIdle = (r: Rule) => r.cameraIds.length === 0;
  const counts: Record<Tab, number> = {
    all: scoped.length,
    live: scoped.filter((r) => r.mode === 'live').length,
    test: scoped.filter((r) => r.mode === 'test').length,
    idle: scoped.filter(isIdle).length,
  };
  const value = (r: Rule): string | number =>
    sort.key === 'name' ? r.name : sort.key === 'cams' ? r.cameraIds.length : sort.key === 'alerts' ? (alertsToday.get(r.id) ?? 0) : sort.key === 'priority' ? r.priority : sort.key === 'mode' ? r.mode : r.id;
  const list = scoped
    .filter((r) => (tab === 'all' ? true : tab === 'idle' ? isIdle(r) : r.mode === tab))
    .sort((x, y) => {
      const a = value(x);
      const b = value(y);
      const d = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
      return (sort.up ? d : -d) || x.id.localeCompare(y.id, undefined, { numeric: true });
    });

  const live = rules.filter((r) => r.mode === 'live').length;
  const today = rules.reduce((n, r) => n + (alertsToday.get(r.id) ?? 0), 0);
  const narrowed = prio !== 'all' || areas.length > 0 || more > 0 || t !== '';
  const clear = () => {
    setQ('');
    setPrio('all');
    setAreas([]);
    setFilters(NO_FILTERS);
  };
  const areaIds = [...new Set(rules.flatMap((r) => camsOf(r).map((c) => c.areaId)))];
  const groups: { key: FilterKey; title: string; options: { value: string; label: string }[] }[] = [
    { key: 'subject', title: 'Looks for', options: (Object.keys(LOOKS_FOR) as Looks[]).map((l) => ({ value: l, label: LOOKS_FOR[l] })) },
    { key: 'condition', title: 'Does what', options: ACTIVE_CONDITIONS.map((c: Condition) => ({ value: c, label: conditionLabel(c) })) },
    { key: 'schedule', title: 'When', options: (Object.keys(SCHEDULE_LABEL) as Schedule[]).map((s) => ({ value: s, label: SCHEDULE_LABEL[s] })) },
    { key: 'record', title: 'Reported', options: RECORDS.map((v) => ({ value: v, label: v === 'none' ? 'None' : v })) },
    { key: 'classification', title: 'Classification', options: (['Unsafe act', 'Unsafe condition'] as Classification[]).map((v) => ({ value: v, label: v })) },
  ];
  const toggle = (k: FilterKey, v: string) => setFilters((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));
  const TABS: { value: Tab; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'live', label: 'Live' },
    { value: 'test', label: 'In test' },
    { value: 'idle', label: 'No cameras' },
  ];
  const head = (k: SortKey, text: string, className?: string) => (
    <th className={className} aria-sort={sort.key === k ? (sort.up ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="sorthead" onClick={() => setSort((s) => ({ key: k, up: s.key === k ? !s.up : k !== 'alerts' && k !== 'cams' }))}>
        {text}
        <Icon name="chevron-down" size={14} stroke={2.2} className={`sorthead__arrow${sort.key === k ? ' is-on' : ''}${sort.key === k && sort.up ? ' is-up' : ''}`} />
      </button>
    </th>
  );

  return (
    <div className={`${embedded ? '' : 'page page--wide '}gyt gcams grules`}>
      <header className={`gcams__head${embedded ? ' is-embedded' : ''}`}>
        <div className="ovhead__title">
          {!embedded && <h1>Rules</h1>}
          <p className="ovhead__sub">
            <span>
              <span className="mono">{rules.length}</span> rules
            </span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span>
              <span className="mono">{live}</span> live
            </span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span>
              <span className="mono">{rules.length - live}</span> in test
            </span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span>
              <span className="mono">{today}</span> alerts in the last 24 h
            </span>
          </p>
        </div>
        {admin && (
          <div className="ovhead__actions">
            <Link to="/rules/new" className="gbtn gbtn--primary">
              <Icon name="plus" size={16} />
              New rule
            </Link>
          </div>
        )}
      </header>

      <ReadOnlyNote>Only the safety admin creates and changes rules.</ReadOnlyNote>

      <div className="gcams__tools">
        <div className="gcams__tabs" role="tablist" aria-label="Show">
          {TABS.map((x) => (
            <button key={x.value} type="button" role="tab" aria-selected={tab === x.value} onClick={() => setTab(x.value)}>
              {x.label}
              <span className={`gal__n mono${x.value === 'idle' && counts.idle > 0 ? ' is-red' : ''}`}>{counts[x.value]}</span>
            </button>
          ))}
        </div>
        <div className="gcams__filters">
          <div className="gal__search gcams__search">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rule, camera or area" aria-label="Search rules" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear the search">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
          <div className="gal__prio" role="group" aria-label="Criticality">
            {LEVELS.map((p) => (
              <button key={p} type="button" aria-pressed={prio === p} className={`gal__p gal__p--${p}`} onClick={() => setPrio(prio === p ? 'all' : p)} title={`Only ${p} ${PRIORITY_NAME[p]}`}>
                {p}
              </button>
            ))}
          </div>
          <MultiSelect id="rule-area" label="Area" clearable placeholder="All areas" options={areaIds.map((a) => ({ value: a, label: AREAS_BY_ID[a]?.name ?? a }))} value={areas} onChange={setAreas} />
          <button type="button" className={`gbtn gbtn--sm${more ? ' is-on' : ''}`} onClick={() => setPanel(true)}>
            <Icon name="filter" size={15} />
            More filters
            {more > 0 && <span className="mono">{more}</span>}
          </button>
          {narrowed && (
            <button type="button" className="gal__clear" onClick={clear}>
              Clear
            </button>
          )}
          <span className="spacer" />
          <span className="gcams__count">
            <span className="mono">{list.length}</span> shown
          </span>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="gcams__empty">
          <strong>No rules here</strong>
          {narrowed ? (
            <span>
              Change the search or{' '}
              <button type="button" className="linkbtn" onClick={clear}>
                clear the filters
              </button>
              .
            </span>
          ) : (
            <span>{tab === 'idle' ? 'Every rule watches at least one camera.' : tab === 'test' ? 'Every rule is live.' : 'No rule is live yet.'}</span>
          )}
        </div>
      ) : (
        <div className="gcams__table grules__table">
          <table className="table">
            <thead>
              <tr>
                {head('name', 'Rule')}
                {head('cams', 'Cameras', 'grules__num')}
                {head('alerts', 'Alerts 24 h', 'grules__num')}
                {head('priority', 'Criticality')}
                {head('mode', 'Status')}
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const rc = camsOf(r);
                const areaNames = [...new Set(rc.map((c) => AREAS_BY_ID[c.areaId]?.name.split(' ·')[0]))];
                const n = alertsToday.get(r.id) ?? 0;
                const open = admin ? () => nav(`/rules/${r.id}`) : undefined;
                return (
                  <tr key={r.id} className={open ? 'is-clickable' : undefined} onClick={open}>
                    <td className="grules__rule">
                      <span className="grules__name">
                        <span className="mono grules__id">{r.id}</span>
                        {admin ? (
                          <Link to={`/rules/${r.id}`} onClick={(e) => e.stopPropagation()}>
                            {r.name}
                          </Link>
                        ) : (
                          <strong>{r.name}</strong>
                        )}
                      </span>
                      <span className="grules__what">
                        {describeRule(r, zonesOf(r))}
                        {r.schedule !== 'always' && ` · ${SCHEDULE_LABEL[r.schedule]}`}
                      </span>
                    </td>
                    <td className="grules__num">
                      {rc.length ? (
                        <>
                          <span className="mono">{rc.length}</span>
                          <span className="grules__areas" title={areaNames.join(', ')}>
                            {areaNames.length > 1 ? `${areaNames[0]} +${areaNames.length - 1}` : areaNames[0]}
                          </span>
                        </>
                      ) : (
                        <span className="grules__none">None</span>
                      )}
                    </td>
                    <td className="grules__num">
                      {n > 0 ? (
                        <Link className="mono" to={`/alerts?rule=${encodeURIComponent(r.id)}`} onClick={(e) => e.stopPropagation()} title={`Alerts from ${r.id}`}>
                          {n}
                        </Link>
                      ) : (
                        <span className="mono grules__zero">0</span>
                      )}
                    </td>
                    <td>
                      <span title={`${r.priority} ${PRIORITY_NAME[r.priority]}`}>
                        <PriorityBadge p={r.priority} short />
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={r.mode === 'live'}
                        disabled={!admin}
                        onChange={(v) => {
                          saveRule({ ...r, mode: v ? 'live' : 'test', updatedAt: Date.now(), updatedBy: me.id });
                          toast(v ? `${r.id} is live: matches now raise alerts` : `${r.id} is in test: matches are logged, no one is told`);
                        }}
                        label={<span className={`grules__mode${r.mode === 'live' ? ' is-live' : ''}`}>{r.mode === 'live' ? 'Live' : 'In test'}</span>}
                      />
                    </td>
                    <td className="grules__go" aria-hidden="true">
                      {admin && <Icon name="chevron-right" size={16} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {panel && (
        <>
          <div className="qset-scrim" onClick={() => setPanel(false)} />
          <aside className="qset grules__panel" role="dialog" aria-modal="true" aria-label="More filters">
            <strong className="qset__title">More filters</strong>
            <div className="qset__body">
              {groups.map((g) => (
                <div key={g.key} className="qset__group">
                  <div className="qset__sub">{g.title}</div>
                  {g.options.map((o) => (
                    <label key={o.value} className="qset__check">
                      <input type="checkbox" checked={filters[g.key].includes(o.value)} onChange={() => toggle(g.key, o.value)} />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="qset__foot">
              <button type="button" className="gbtn" onClick={() => setFilters(NO_FILTERS)} disabled={!more}>
                Clear these
              </button>
              <button type="button" className="gbtn gbtn--primary" onClick={() => setPanel(false)}>
                Show {list.length} {list.length === 1 ? 'rule' : 'rules'}
              </button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
