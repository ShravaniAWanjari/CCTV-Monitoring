import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Icon, type IconName } from '../../components/Icon';
import { CameraView, looseMatch, MultiSelect } from '../../components/ui';
import { AREAS, DEPARTMENTS } from '../../data/seed';
import type { Camera } from '../../data/types';
import { download, writeXlsx } from '../../lib/sheet';
import { setupFile } from '../../lib/setup';
import { alertStore, AREAS_BY_ID, cameraStore, departmentOf, isAdmin, policyStore, ruleStore, useCameras, useMe, useRules, wallStore } from '../../state/store';
import { ASSET_COLUMNS, assetRow, CameraImport } from './CameraImport';
import './cameras.css';
import '../overview-gyt.css';
import '../alerts/alerts-gyt.css';
import './cameras-gyt.css';

// The camera directory: every camera asset with what it is, where it is, which work area it covers and which
// department owns it. Browse it as thumbnails, a list or Finder-style columns with a preview.

type View = 'grid' | 'list' | 'columns';
const VIEWS: { value: View; label: string; icon: IconName }[] = [
  { value: 'grid', label: 'Thumbnails', icon: 'grid' },
  { value: 'list', label: 'List', icon: 'list' },
  { value: 'columns', label: 'Columns', icon: 'columns' },
];
const VIEW_KEY = 'gyt.v1.cameraView';
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    // The column view (departments, work areas, cameras, then the picture and details) is the default; a choice made on this
    // computer is remembered.
    return v === 'grid' || v === 'list' || v === 'columns' ? v : 'columns';
  } catch {
    return 'columns';
  }
};

type Show = 'all' | 'nozones' | 'norules' | 'issues';
const STATUS_TEXT: Record<Camera['status'], string> = { online: 'Online', degraded: 'Degraded', offline: 'Offline' };

/** Departments in their usual order, then any others the register uses. */
const departmentsIn = (cams: Camera[]) => {
  const used = new Set(cams.map(departmentOf));
  return [...DEPARTMENTS.filter((d) => used.has(d)), ...[...used].filter((d) => !DEPARTMENTS.includes(d)).sort()];
};

/** Where a camera is in its set-up: connected, zones drawn, watched by a rule. The first thing missing is what to do next. */
export function setupState(c: Camera, rulesOn: number): { done: number; next: string | null } {
  const steps = [true, c.zones.length > 0, rulesOn > 0];
  const done = steps.filter(Boolean).length;
  return { done, next: !steps[1] ? 'Draw zones' : !steps[2] ? 'Add a rule' : null };
}

/** `embedded`: shown as a tab of Configuration, which has its own title; only the actions stay at the top. */
export function Cameras({ embedded = false }: { embedded?: boolean } = {}) {
  const cams = useCameras();
  const rules = useRules();
  const me = useMe();
  const admin = isAdmin(me);
  const [depts, setDepts] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [q, setQ] = useState('');
  // The Overview's coverage gaps open this list already narrowed: ?coverage=no-zones or no-rules.
  const [coverage] = useSearchParams();
  const [show, setShow] = useState<Show>(coverage.get('coverage') === 'no-zones' ? 'nozones' : coverage.get('coverage') === 'no-rules' ? 'norules' : 'all');
  const [view, setViewState] = useState<View>(savedView);
  const [importing, setImporting] = useState(false);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the view just isn't remembered */
    }
  };

  const allDepts = departmentsIn(cams);
  const areaChoices = AREAS.filter((a) => !depts.length || cams.some((c) => c.areaId === a.id && depts.includes(departmentOf(c))));
  const watched = useMemo(() => new Set(rules.flatMap((r) => r.cameraIds)), [rules]);
  const ruleCount = (camId: string) => rules.filter((r) => r.cameraIds.includes(camId)).length;
  const scoped = cams.filter((c) => (!depts.length || depts.includes(departmentOf(c))) && (!areas.length || areas.includes(c.areaId)) && looseMatch(`${c.id} ${c.name}`, q));
  const counts: Record<Show, number> = {
    all: scoped.length,
    nozones: scoped.filter((c) => c.zones.length === 0).length,
    norules: scoped.filter((c) => !watched.has(c.id)).length,
    issues: scoped.filter((c) => c.status !== 'online').length,
  };
  const list = scoped.filter((c) => show === 'all' || (show === 'nozones' ? c.zones.length === 0 : show === 'norules' ? !watched.has(c.id) : c.status !== 'online'));
  const online = cams.filter((c) => c.status === 'online').length;
  const narrowed = depts.length > 0 || areas.length > 0 || q.trim() !== '';
  const SHOWS: { value: Show; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'nozones', label: 'Need zones' },
    { value: 'norules', label: 'No rule' },
    { value: 'issues', label: 'Offline or degraded' },
  ];

  return (
    <div className={`${embedded ? '' : 'page page--wide '}gyt gcams`}>
      <header className={`gcams__head${embedded ? ' is-embedded' : ''}`}>
        <div className="ovhead__title">
          {!embedded && <h1>Cameras</h1>}
          <p className="ovhead__sub">
            <span>
              <span className="mono">{cams.length}</span> cameras
            </span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span>
              <span className="mono">{online}</span> online
            </span>
            <span className="ovhead__sep" aria-hidden="true" />
            <span>
              <span className="mono">{cams.length - cams.filter((c) => c.zones.length && watched.has(c.id)).length}</span> not fully set up
            </span>
          </p>
        </div>
        <div className="ovhead__actions">
          <button type="button" className="gbtn" onClick={() => download(writeXlsx([[...ASSET_COLUMNS, 'Status', 'Zones', 'Rules'], ...list.map((c) => [...assetRow(c), STATUS_TEXT[c.status], c.zones.length, ruleCount(c.id)])], 'Cameras'), 'camera-asset-list.xlsx')} title="Download the cameras shown as a spreadsheet">
            <Icon name="download" size={16} />
            Export
          </button>
          {admin && (
            <button type="button" className="gbtn" onClick={() => setImporting(true)} title="Add many cameras at once from a spreadsheet">
              <Icon name="upload" size={16} />
              Import
            </button>
          )}
          {admin && (
            <button
              type="button"
              className="gbtn gbtn--icon"
              title="Save the cameras, rules, walls and alerts as they are now, as the sample set-up file"
              aria-label="Save set-up file"
              onClick={() => download(setupFile({ cameras: cameraStore.get(), rules: ruleStore.get(), walls: wallStore.get(), alerts: alertStore.get(), policies: policyStore.get() }), 'report-setup.json')}
            >
              <Icon name="doc" size={16} />
            </button>
          )}
          {admin && (
            <Link to="/cameras/new" className="gbtn gbtn--primary">
              <Icon name="plus" size={16} />
              Add camera
            </Link>
          )}
        </div>
      </header>

      <div className="gcams__tools">
        <div className="gcams__tabs" role="tablist" aria-label="Show">
          {SHOWS.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={show === t.value} onClick={() => setShow(t.value)}>
              {t.label}
              <span className={`gal__n mono${t.value !== 'all' && counts[t.value] > 0 ? ' is-dark' : ''}`}>{counts[t.value]}</span>
            </button>
          ))}
        </div>
        <div className="gcams__filters">
          <div className="gal__search gcams__search">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Camera ID or location" aria-label="Search cameras" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear the search">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
          <MultiSelect
            id="cam-dept"
            label="Department"
            clearable
            placeholder="All departments"
            options={allDepts.map((d) => ({ value: d, label: d }))}
            value={depts}
            onChange={(v) => {
              setDepts(v);
              setAreas((a) => a.filter((x) => !v.length || cams.some((c) => c.areaId === x && v.includes(departmentOf(c)))));
            }}
          />
          <MultiSelect id="cam-area" label="Work area" clearable placeholder="All work areas" options={areaChoices.map((a) => ({ value: a.id, label: a.name }))} value={areas} onChange={setAreas} />
          {narrowed && (
            <button
              type="button"
              className="gal__clear"
              onClick={() => {
                setDepts([]);
                setAreas([]);
                setQ('');
              }}
            >
              Clear
            </button>
          )}
          <span className="spacer" />
          <span className="gcams__count">
            <span className="mono">{list.length}</span> shown
          </span>
          <div className="gcams__views" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.value} type="button" aria-pressed={view === v.value} title={v.label} aria-label={v.label} onClick={() => setView(v.value)}>
                <Icon name={v.icon} size={17} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="gcams__empty">
          <strong>No cameras here</strong>
          <span>{show !== 'all' && !narrowed ? 'Every camera is set up for this.' : 'Change the search or clear the filters.'}</span>
        </div>
      ) : view === 'grid' ? (
        <ThumbView list={list} ruleCount={ruleCount} />
      ) : view === 'list' ? (
        <ListView list={list} ruleCount={ruleCount} />
      ) : (
        <ColumnView list={list} ruleCount={ruleCount} />
      )}

      {importing && <CameraImport onClose={() => setImporting(false)} />}
    </div>
  );
}

type ViewProps = { list: Camera[]; ruleCount: (id: string) => number };

/** What a camera still needs: "Ready", or the next step to finish its set-up. */
function SetupTag({ c, ruleCount }: { c: Camera; ruleCount: (id: string) => number }) {
  const st = setupState(c, ruleCount(c.id));
  return st.next ? (
    <span className="gsetup is-todo" title={`Set-up ${st.done} of 3 done`}>
      <i aria-hidden="true">
        {[0, 1, 2].map((n) => (
          <b key={n} className={n < st.done ? 'is-on' : ''} />
        ))}
      </i>
      {st.next}
    </span>
  ) : (
    <span className="gsetup" title="Connected, zones drawn and watched by a rule">
      <Icon name="check" size={13} />
      Ready
    </span>
  );
}

function Chips({ c, ruleCount }: { c: Camera; ruleCount: (id: string) => number }) {
  return (
    <div className="gcard__tags">
      <SetupTag c={c} ruleCount={ruleCount} />
      {c.status !== 'online' && <span className={`gstatus gstatus--${c.status}`}>{STATUS_TEXT[c.status]}</span>}
    </div>
  );
}

/** Thumbnails, grouped by work area like folders. */
function ThumbView({ list, ruleCount }: ViewProps) {
  const admin = isAdmin(useMe());
  return (
    <>
      {AREAS.map((a) => {
        const items = list.filter((c) => c.areaId === a.id);
        if (!items.length) return null;
        return (
          <section key={a.id} className="camarea">
            <h2>
              {a.name}
              <span className="meta">
                {departmentsIn(items).join(', ')} · {items.length} {items.length === 1 ? 'camera' : 'cameras'}
                {a.highOps ? ' · high-operational area' : ''}
              </span>
            </h2>
            <div className="camgrid">
              {items.map((c) => (
                <Link key={c.id} to={admin ? `/cameras/${c.id}` : `/alerts?camera=${encodeURIComponent(c.id)}`} className="camcard">
                  <CameraView cam={c} still zones={c.zones} caption={false} />
                  <div className="camcard__body">
                    <div className="row">
                      <span className={`dot dot--${c.status}`} title={c.status} />
                      <span className="mono">{c.id}</span>
                      <span className="ellipsis">{c.name}</span>
                    </div>
                    <Chips c={c} ruleCount={ruleCount} />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

type SortKey = 'id' | 'name' | 'area' | 'dept' | 'status' | 'zones' | 'rules';

/** One row per camera, every column sortable. */
function ListView({ list, ruleCount }: ViewProps) {
  const admin = isAdmin(useMe());
  const nav = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: 'id', up: true });
  const value = (c: Camera): string | number =>
    sort.key === 'name' ? c.name : sort.key === 'area' ? (AREAS_BY_ID[c.areaId]?.name ?? '') : sort.key === 'dept' ? departmentOf(c) : sort.key === 'status' ? STATUS_TEXT[c.status] : sort.key === 'zones' ? c.zones.length : sort.key === 'rules' ? ruleCount(c.id) : c.id;
  const rows = [...list].sort((x, y) => {
    const a = value(x);
    const b = value(y);
    const d = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
    return (sort.up ? d : -d) || x.id.localeCompare(y.id, undefined, { numeric: true });
  });
  const head = (k: SortKey, text: string) => (
    <th aria-sort={sort.key === k ? (sort.up ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="sorthead" onClick={() => setSort((s) => ({ key: k, up: s.key === k ? !s.up : true }))}>
        {text}
        <Icon name="chevron-down" size={14} stroke={2.2} className={`sorthead__arrow${sort.key === k ? ' is-on' : ''}${sort.key === k && sort.up ? ' is-up' : ''}`} />
      </button>
    </th>
  );
  return (
    <div className="gcams__table">
      <table className="table">
        <thead>
          <tr>
            {head('id', 'Camera ID')}
            {head('name', 'Location')}
            {head('area', 'Work area')}
            {head('dept', 'Department')}
            {head('status', 'Status')}
            {head('zones', 'Zones')}
            {head('rules', 'Rules')}
            <th>Set-up</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="is-clickable" onClick={() => nav(admin ? `/cameras/${c.id}` : `/alerts?camera=${encodeURIComponent(c.id)}`)}>
              <td className="mono">{c.id}</td>
              <td>
                <strong>{c.name}</strong>
              </td>
              <td>{AREAS_BY_ID[c.areaId]?.name}</td>
              <td>{departmentOf(c)}</td>
              <td>
                <span className="row" style={{ gap: 6 }}>
                  <span className={`dot dot--${c.status}`} />
                  {STATUS_TEXT[c.status]}
                </span>
              </td>
              <td className="mono">{c.zones.length}</td>
              <td className="mono">{ruleCount(c.id)}</td>
              <td>
                <SetupTag c={c} ruleCount={ruleCount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Finder-style columns: department, then work area, then camera, with a preview of the chosen camera. */
function ColumnView({ list, ruleCount }: ViewProps) {
  const admin = isAdmin(useMe());
  const nav = useNavigate();
  const depts = departmentsIn(list);
  const [deptSel, setDept] = useState<string>();
  const dept = deptSel && depts.includes(deptSel) ? deptSel : depts[0];
  const inDept = list.filter((c) => departmentOf(c) === dept);
  const areaIds = AREAS.filter((a) => inDept.some((c) => c.areaId === a.id)).map((a) => a.id);
  const [areaSel, setArea] = useState<string>();
  const area = areaSel && areaIds.includes(areaSel) ? areaSel : areaIds[0];
  const inArea = inDept.filter((c) => c.areaId === area);
  const [camSel, setCam] = useState<string>();
  const cam = inArea.find((c) => c.id === camSel) ?? inArea[0];
  const rulesOn = cam ? ruleCount(cam.id) : 0;

  return (
    <div className="colview gcams__cols">
      <div className="colview__col">
        <div className="colview__head">Departments</div>
        <div className="colview__items">
          {depts.map((d) => (
            <button key={d} type="button" className={`colview__item${d === dept ? ' is-sel' : ''}`} onClick={() => setDept(d)}>
              <span className="ellipsis">{d}</span>
              <span className="colview__n">{list.filter((c) => departmentOf(c) === d).length}</span>
              <Icon name="chevron-right" size={16} stroke={2.2} />
            </button>
          ))}
        </div>
      </div>
      <div className="colview__col">
        <div className="colview__head">Work areas</div>
        <div className="colview__items">
          {areaIds.map((a) => (
            <button key={a} type="button" className={`colview__item${a === area ? ' is-sel' : ''}`} onClick={() => setArea(a)}>
              <span className="ellipsis">{AREAS_BY_ID[a]?.name}</span>
              <span className="colview__n">{inDept.filter((c) => c.areaId === a).length}</span>
              <Icon name="chevron-right" size={16} stroke={2.2} />
            </button>
          ))}
        </div>
      </div>
      <div className="colview__col">
        <div className="colview__head">Cameras</div>
        <div className="colview__items">
          {inArea.map((c) => (
            <button key={c.id} type="button" className={`colview__item${c.id === cam?.id ? ' is-sel' : ''}`} onClick={() => setCam(c.id)} onDoubleClick={() => nav(`/cameras/${c.id}`)} title="Double-click To Open The Camera Set-up">
              <span className={`dot dot--${c.status}`} />
              <span className="mono">{c.id}</span>
              <span className="ellipsis">{c.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="colview__preview">
        {cam && (
          <>
            <CameraView cam={cam} still zones={cam.zones} caption={false} />
            <div className="colview__title">
              <span className="mono">{cam.id}</span>
              <strong>{cam.name}</strong>
            </div>
            <dl className="kv colview__kv">
              <dt>Work area</dt>
              <dd>{AREAS_BY_ID[cam.areaId]?.name}</dd>
              <dt>Department</dt>
              <dd>{departmentOf(cam)}</dd>
              <dt>Status</dt>
              <dd className="row" style={{ gap: 6 }}>
                <span className={`dot dot--${cam.status}`} />
                {STATUS_TEXT[cam.status]}
              </dd>
              <dt>Stream</dt>
              <dd className="mono ellipsis">{cam.source ? (cam.source.title ?? cam.source.fileName ?? 'Connected source') : cam.stream || '–'}</dd>
              <dt>Make and model</dt>
              <dd>{cam.make}</dd>
              <dt>Resolution</dt>
              <dd>
                {cam.resolution} · {cam.fps}fps
              </dd>
              <dt>Zones</dt>
              <dd>{cam.zones.length ? cam.zones.map((z) => z.name).join(', ') : 'None yet'}</dd>
              <dt>Rules</dt>
              <dd>{rulesOn ? `${rulesOn} ${rulesOn === 1 ? 'rule watches it' : 'rules watch it'}` : 'None'}</dd>
            </dl>
            <SetupTag c={cam} ruleCount={ruleCount} />
            {admin ? (
              <button type="button" className="gbtn gbtn--primary" onClick={() => nav(`/cameras/${cam.id}`)}>
                {setupState(cam, rulesOn).next ? `Continue set-up: ${setupState(cam, rulesOn).next!.toLowerCase()}` : 'Open set-up'}
              </button>
            ) : (
              <button type="button" className="gbtn" onClick={() => nav(`/alerts?camera=${encodeURIComponent(cam.id)}`)}>
                See alerts on this camera
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
