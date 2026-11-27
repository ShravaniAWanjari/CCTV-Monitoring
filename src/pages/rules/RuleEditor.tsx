import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { ReadOnlyNote } from '../../components/Shell';
import { CameraView, CHANNEL, Choice, looseMatch, Modal, PRIORITY_NAME, PriorityBadge, Seg, useConfirm } from '../../components/ui';
import { AREAS } from '../../data/seed';
import type { Camera, Classification, Condition, Ppe, Priority, ReportType, Rule, Schedule } from '../../data/types';
import { CONDITION_LABEL, defaultRuleName, describeRule, draftRuleFromText, SCHEDULE_LABEL, type RuleDraft } from '../../lib/assist';
import { countField, doesWhatOptions, gatherField, nearFields, speedFields, LOOKS_FOR, looksOf, switchLooks, type Looks } from '../../lib/usecases';
import { apiUrl } from '../../lib/backend';
import { duration, hm } from '../../lib/time';
import { useMatches } from '../../state/bridge';
import { previewFor } from '../../state/engine';
import { deleteRule, isAdmin, nextRuleId, roleText, saveRule, toast, useCameras, useMe, usePolicies, useRules, userName } from '../../state/store';
import type { Alert } from '../../data/types';
import './rules.css';
import '../overview-gyt.css';
import '../alerts/alerts-gyt.css';
import '../cameras/cameras-gyt.css';
import './rules-gyt.css';

export const EXAMPLES = [
  'More than 10 people in the restricted area for 30 seconds',
  'Someone using a phone in the restricted area for 3 seconds',
  'A person enters the restricted area, urgent',
  'Fire or smoke on the deck',
];

type AiField = 'name' | 'cameras' | 'zones' | 'subject' | 'condition' | 'duration' | 'schedule' | 'priority' | 'report';

export function RuleEditor() {
  const { ruleId } = useParams();
  const rules = useRules();
  const cams = useCameras();
  const policies = usePolicies();
  const me = useMe();
  const nav = useNavigate();
  const confirm = useConfirm();
  const admin = isAdmin(me);
  const existing = rules.find((r) => r.id === ruleId);
  const [preview, setPreview] = useState<Alert>();
  const [rule, setRule] = useState<Rule>(
    () =>
      existing ?? {
        id: nextRuleId(rules),
        name: '',
        cameraIds: [],
        zoneIds: [],
        subject: 'person',
        condition: 'enters',
        durationSec: 3,
        minFrames: 3,
        minConfidence: 0.25,
        repeatSec: 120,
        minMovePx: 10,
        ppe: [],
        crowdOver: 6,
        schedule: 'always',
        priority: 'P2',
        mode: 'test',
        report: 'Observation',
        classification: 'Unsafe act',
        updatedAt: Date.now(),
        updatedBy: me.id,
      },
  );
  // What was last saved (or the blank rule), to tell whether anything has changed.
  const [initial] = useState(() => JSON.stringify(rule));
  const [text, setText] = useState(existing?.plainText ?? '');
  const [draft, setDraft] = useState<RuleDraft>();
  const [picking, setPicking] = useState(false);
  // The camera whose zones are shown. A rule can watch many cameras; each has its own zones, so the list follows this one.
  const [activeId, setActiveId] = useState<string>();
  const [allCams, setAllCams] = useState(false);
  const [backtest, setBacktest] = useState<{ total: number; hits: { cam: Camera; at: number }[] }>();

  const chosen = cams.filter((c) => rule.cameraIds.includes(c.id));
  const isFire = rule.condition === 'smoke';
  const runsForReal = isFire || REAL_CONDITIONS.includes(rule.condition);
  const steadyKind = REAL_CONDITIONS.includes(rule.condition);
  const active = chosen.find((c) => c.id === activeId) ?? chosen[0];
  const activeList = useMemo(() => (active ? [active] : []), [active]);
  const zoneOptions = useZoneOptions(activeList, isFire);
  const ignoreAreas = chosen.flatMap((c) => c.zones.filter((z) => z.purpose === 'fire-ignore').map((z) => z.name));
  const selectedZoneNames = zoneOptions.filter((o) => o.ids.some((id) => rule.zoneIds.includes(id))).map((o) => o.name);
  const policy = policies.find((p) => p.priority === rule.priority);
  const realCams = chosen.filter((c) => c.source);
  const matches = useMatches().filter((m) => m.ruleId === rule.id);
  const steady = { frames: rule.minFrames ?? (isFire ? 4 : 3), sure: Math.round((rule.minConfidence ?? 0.25) * 100), repeat: rule.repeatSec ?? 120, move: rule.minMovePx ?? 10 };

  if (ruleId && !existing) {
    return (
      <div className="page">
        Rule {ruleId} not found. <Link to="/rules">Back to rules</Link>
      </div>
    );
  }

  // The second argument names the part of the form a change belongs to; callers pass it, nothing reads it now.
  const set = (p: Partial<Rule>, _f?: AiField) => {
    setRule({ ...rule, ...p });
    setBacktest(undefined);
  };

  const runDraft = (t = text) => {
    if (!t.trim()) return;
    const d = draftRuleFromText(t, cams, AREAS);
    setDraft(d);
    setRule({ ...rule, ...d.rule, plainText: t });
    setBacktest(undefined);
  };

  const runBacktest = () => {
    const base: Record<Condition, number> = { enters: 0.5, outside: 0.45, dwells: 0.35, crosses: 0.15, 'no-ppe': 0.7, crowd: 0.25, gathering: 0.25, smoke: 0.02, stopped: 0.35, near: 0.3, fewer: 0.3, absent: 0.2, wrongway: 0.1, tailgate: 0.1, speeding: 0.2, running: 0.3, abandoned: 0.1, phone: 0.3, down: 0.1 };
    const seed = rule.cameraIds.join('').length + rule.durationSec * 7 + rule.zoneIds.length * 3;
    const factor = 1 / (1 + rule.durationSec / 12);
    const total = Math.round(base[rule.condition] * Math.max(1, chosen.length) * factor * (0.8 + (seed % 7) / 10));
    const now = Date.now();
    const hits = Array.from({ length: Math.min(total, 6) }, (_, i) => ({ cam: chosen[(seed + i * 3) % Math.max(1, chosen.length)], at: now - ((seed * (i + 3) * 997) % 86400000) })).filter((h) => h.cam);
    setBacktest({ total, hits: hits.sort((a, b) => b.at - a.at) });
  };

  const valid = rule.cameraIds.length > 0;
  const save = () => {
    saveRule({ ...rule, name: rule.name.trim() || defaultRuleName(rule), updatedAt: Date.now(), updatedBy: me.id });
    toast(`${rule.id} saved · ${rule.mode === 'live' ? 'live now' : 'in test: matches are logged, no one is told'}`);
    nav('/rules');
  };

  const sentence = describeRule(rule, selectedZoneNames);
  const dirty = JSON.stringify(rule) !== initial;
  // A rule on many cameras shows the first few (and the one whose zones are shown); the rest open on request.
  const chipCams = allCams || chosen.length <= CHIP_LIMIT ? chosen : [...chosen.slice(0, CHIP_LIMIT - 1), ...(active && chosen.indexOf(active) >= CHIP_LIMIT - 1 ? [active] : [])];
  const leave = () =>
    dirty ? confirm.ask({ title: existing ? 'Discard your changes?' : 'Discard this rule?', message: existing ? 'Changes since the last save are lost.' : 'It has not been created yet.', action: 'Discard' }, () => nav('/rules')) : nav('/rules');
  const author = existing ? userName(existing.updatedBy) : '';

  return (
    <div className="page gyt gcs grule">
      <header className="gcs__head">
        <div className="gcs__title">
          <a href="#/rules" className="gcs__back" onClick={(e) => { e.preventDefault(); leave(); }}>
            <Icon name="arrow-left" size={14} />
            Rules
          </a>
          <h1>{existing ? existing.name : 'New rule'}</h1>
          <p>
            <span className="mono">{rule.id}</span>
            {existing && (
              <>
                {' · '}
                <span className={`grules__mode${existing.mode === 'live' ? ' is-live' : ''}`}>{existing.mode === 'live' ? 'Live' : 'In test'}</span>
                {author && ` · changed by ${author}, ${ago(existing.updatedAt)}`}
              </>
            )}
          </p>
        </div>
        <div className="ovhead__actions">
          {existing && admin && (
            <button
              type="button"
              className="gbtn gbtn--danger"
              onClick={() =>
                confirm.ask({ title: `Delete ${rule.id}?`, message: `“${rule.name}” stops watching and its alerts are no longer raised.`, action: 'Delete rule' }, () => {
                  deleteRule(rule.id);
                  toast(`${rule.id} deleted`);
                  nav('/rules');
                })
              }
            >
              <Icon name="trash" size={15} />
              Delete
            </button>
          )}
        </div>
      </header>
      {confirm.dialog}
      <ReadOnlyNote>Only the safety admin creates and changes rules.</ReadOnlyNote>

      <fieldset className="plain" disabled={!admin}>
        <div className="ruleedit">
          <div className="card card--pad stack ruleform">
            <details className="gform__section gdescribe" open={!existing}>
              <summary>
                <h3>Describe it in your own words</h3>
                <span className="gdescribe__opt">{existing ? 'Rewrite the rule from a sentence' : 'Optional: fills in the fields below'}</span>
              </summary>
              <textarea className="textarea gdescribe__text" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: a person in the restricted area for 5 seconds, urgent" aria-label="Describe the rule" />
              <div className="gdescribe__actions">
                <button type="button" className="gbtn gbtn--primary gbtn--sm" onClick={() => runDraft()} disabled={!text.trim()}>
                  <Icon name="spark" size={15} />
                  Fill in
                </button>
                {!draft && (
                  <>
                    <span className="gdescribe__or">or try</span>
                    {EXAMPLES.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="gchip"
                        onClick={() => {
                          setText(e);
                          runDraft(e);
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </>
                )}
              </div>
              {draft && draft.assumed.length > 0 && (
                <div className="gdescribe__assumed">
                  <strong>Assumed, please check:</strong> {draft.assumed.join('; ')}.
                </div>
              )}
            </details>

            <section className="gform__section">
              <h3>What it looks for</h3>
              <div className="field">
                <label htmlFor="r-name">Rule name</label>
                <input id="r-name" className="input" value={rule.name} onChange={(e) => set({ name: e.target.value }, 'name')} placeholder={`Left empty: ${defaultRuleName(rule)}`} />
              </div>
              <div className="grid-2">
                <Choice
                  id="r-subj"
                  label="Looks for"
                  value={looksOf(rule)}
                  options={(Object.keys(LOOKS_FOR) as Looks[]).map((l) => ({ value: l, label: LOOKS_FOR[l] }))}
                  onChange={(looks) => {
                    // On real cameras the rule starts with the areas drawn for its kind, as when the camera is chosen.
                    const drawnFor = (fire: boolean) => realCams.flatMap((c) => c.zones.filter((z) => (fire ? z.purpose === 'fire-watch' : !z.purpose.startsWith('fire-'))).map((z) => z.id));
                    set(switchLooks(rule, looks, drawnFor), 'condition');
                  }}
                />
                <Choice
                  id="r-cond"
                  label="Does what"
                  value={rule.condition}
                  options={doesWhatOptions(looksOf(rule), rule.condition, (c) => CONDITION_LABEL[c]).map((d) => ({ value: d.condition, label: d.label }))}
                  onChange={(condition) => {
                    const { subject: _keep, ...defaults } = CONDITION_DEFAULTS[condition] ?? {};
                    set({ condition, ...defaults }, 'condition');
                  }}
                />
              </div>
            {rule.condition === 'no-ppe' && (
              <div className="field">
                <span className="field__label">Missing PPE</span>
                <div className="row-wrap">
                  {(['helmet', 'vest', 'life jacket'] as Ppe[]).map((p) => (
                    <label key={p} className="check">
                      <input type="checkbox" checked={rule.ppe.includes(p)} onChange={(e) => set({ ppe: e.target.checked ? [...rule.ppe, p] : rule.ppe.filter((x) => x !== p) }, 'condition')} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {rule.condition === 'crowd' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-crowd">{countField(rule.subject).label}</label>
                <input id="r-crowd" className="input" type="number" min={1} value={rule.crowdOver} onChange={(e) => set({ crowdOver: Math.max(1, Math.round(Number(e.target.value)) || 1) })} />
                <span className="field__hint">{countField(rule.subject).hint}</span>
              </div>
            )}

            {rule.condition === 'gathering' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-gather">{gatherField.label}</label>
                <input id="r-gather" className="input" type="number" min={3} value={rule.minPeople ?? 5} onChange={(e) => set({ minPeople: Math.max(3, Math.round(Number(e.target.value)) || 3) })} />
                <span className="field__hint">{gatherField.hint}</span>
              </div>
            )}
            {rule.condition === 'fewer' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-minp">Fewer than how many people</label>
                <input id="r-minp" className="input" type="number" min={2} value={rule.minPeople ?? 2} onChange={(e) => set({ minPeople: Math.max(2, Number(e.target.value)) })} />
                <span className="field__hint">At least one person must be there: someone working alone where a team is needed.</span>
              </div>
            )}
            {rule.condition === 'near' && (
              <>
                <div className="field" style={{ maxWidth: 260 }}>
                  <label htmlFor="r-near">{nearFields.label}</label>
                  <input id="r-near" className="input" type="number" min={0.1} step={0.1} value={rule.nearHeights ?? 1} onChange={(e) => set({ nearHeights: Math.max(0.1, Number(e.target.value) || 1) })} />
                  <span className="field__hint">{nearFields.hint}</span>
                </div>
                <div className="field">
                  <label htmlFor="r-near-moving" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input id="r-near-moving" type="checkbox" checked={rule.nearMovingOnly !== false} onChange={(e) => set({ nearMovingOnly: e.target.checked })} />
                    {nearFields.movingOnly}
                  </label>
                  <span className="field__hint">{nearFields.movingHint}</span>
                </div>
              </>
            )}
            {rule.condition === 'phone' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-phone">Phone at least this sure (%)</label>
                <input id="r-phone" className="input" type="number" min={25} max={100} value={Math.round((rule.phoneConfidence ?? 0.35) * 100)} onChange={(e) => set({ phoneConfidence: Math.min(1, Math.max(0.25, Number(e.target.value) / 100)) })} />
                <span className="field__hint">Higher means fewer false alarms from radios, binoculars and cups, but a phone held far from the camera may be missed.</span>
              </div>
            )}
            {rule.condition === 'wrongway' && (
              <Choice id="r-dir" label="Allowed direction" value={String(rule.allowedDir ?? 1)} onChange={(v) => set({ allowedDir: Number(v) as 1 | -1 })}
                options={[{ value: '1', label: 'To the right of the line as drawn (first point to last)' }, { value: '-1', label: 'To the left of the line as drawn' }]} />
            )}
            {rule.condition === 'tailgate' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-gap">Second person within (seconds)</label>
                <input id="r-gap" className="input" type="number" min={1} value={rule.gapSec ?? 3} onChange={(e) => set({ gapSec: Math.max(1, Number(e.target.value)) })} />
              </div>
            )}
            {rule.condition === 'speeding' && (
              <div className="grid-2" style={{ gap: 12 }}>
                <div className="field">
                  <label htmlFor="r-kmh">{speedFields.limit}</label>
                  <input id="r-kmh" className="input" type="number" min={1} value={rule.speedKmh ?? 30} onChange={(e) => set({ speedKmh: Math.max(1, Number(e.target.value)) })} />
                </div>
                <div className="field">
                  <label htmlFor="r-across">Metres across the picture</label>
                  <input id="r-across" className="input" type="number" min={1} value={rule.metersAcross ?? 60} onChange={(e) => set({ metersAcross: Math.max(1, Number(e.target.value)) })} />
                  <span className="field__hint">About how wide the road is in the picture, left edge to right. It is the scale for the speed, so it is a rough reading, best for vehicles in the middle of the view.</span>
                </div>
              </div>
            )}
            {rule.condition === 'running' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-run">Pace (body heights a second)</label>
                <input id="r-run" className="input" type="number" min={0.5} step={0.1} value={rule.runSpeed ?? 1.6} onChange={(e) => set({ runSpeed: Math.max(0.5, Number(e.target.value)) })} />
                <span className="field__hint">Walking is about 0.8, jogging 1.5 and more.</span>
              </div>
            )}
            {rule.condition === 'abandoned' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="r-owner">Someone within (pixels) is with it</label>
                <input id="r-owner" className="input" type="number" min={1} value={rule.ownerPx ?? 150} onChange={(e) => set({ ownerPx: Math.max(1, Number(e.target.value)) })} />
                <span className="field__hint">Bags and cases that were with a person and then stayed alone for the time below.</span>
              </div>
            )}
              <div className="grid-2">
                {!isFire && (
                  <div className="field gunit">
                    <label htmlFor="r-dur">For at least</label>
                    <input id="r-dur" className="input" type="number" min={0} value={rule.durationSec >= 120 && rule.durationSec % 60 === 0 ? rule.durationSec / 60 : rule.durationSec} onChange={(e) => set({ durationSec: Math.max(0, Number(e.target.value)) * (rule.durationSec >= 120 && rule.durationSec % 60 === 0 ? 60 : 1) }, 'duration')} />
                    <span className="gunit__u">{rule.durationSec >= 120 && rule.durationSec % 60 === 0 ? 'minutes' : 'seconds'}</span>
                  </div>
                )}
                <Choice id="r-when" label="When" value={rule.schedule} onChange={(schedule) => set({ schedule }, 'schedule')} options={(Object.keys(SCHEDULE_LABEL) as Schedule[]).map((s) => ({ value: s, label: SCHEDULE_LABEL[s] }))} />
              </div>
            </section>

            <section className="gform__section">
              <h3>Where</h3>
              <div className="gwhere">
                <span className="field__label">Cameras{chosen.length > 1 ? ` · ${chosen.length}` : ''}</span>
                <div className="gwhere__row">
                  {chosen.length === 0 && <span className="gwhere__empty">No camera yet</span>}
                  {chipCams.map((c) => (
                    <button key={c.id} type="button" className="gchip" aria-pressed={chosen.length > 1 && c.id === active?.id} title={chosen.length > 1 ? `Show the zones of ${c.id}` : c.name} onClick={() => setActiveId(c.id)}>
                      <span className="mono">{c.id}</span>
                    </button>
                  ))}
                  {chosen.length > CHIP_LIMIT && (
                    <button type="button" className="gchip gwhere__more" onClick={() => setAllCams(!allCams)}>
                      {allCams ? 'Show fewer' : `+${chosen.length - chipCams.length} more`}
                    </button>
                  )}
                  <button type="button" className="gbtn gbtn--sm" onClick={() => setPicking(true)}>
                    <Icon name="camera" size={15} />
                    {chosen.length ? 'Change cameras' : 'Choose cameras'}
                  </button>
                </div>
              </div>
              {chosen.length > 0 && (
                <div className="gwhere">
                  <span className="field__label">
                    {isFire ? 'Watch areas' : 'Zones'}
                    {chosen.length > 1 && active ? ` on ${active.id}` : ''}
                  </span>
                  {zoneOptions.length === 0 ? (
                    <span className="field__hint">
                      {isFire
                        ? 'No fire and smoke watch areas on this camera, so the whole view is watched. To limit it, draw an area on the camera and set it to "Fire and smoke watch area".'
                        : 'No zones on this camera yet, so the whole view is watched. Draw zones in the camera set-up.'}
                    </span>
                  ) : (
                    <div className="gwhere__row">
                      {zoneOptions.map((o) => {
                        const on = o.ids.some((id) => rule.zoneIds.includes(id));
                        return (
                          <button
                            key={o.ids.join()}
                            type="button"
                            className="gchip"
                            aria-pressed={on}
                            onClick={() => set({ zoneIds: on ? rule.zoneIds.filter((id) => !o.ids.includes(id)) : [...rule.zoneIds, ...o.ids] }, 'zones')}
                          >
                            {on && <Icon name="check" size={13} />}
                            {o.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {zoneOptions.length > 0 && (
                    <span className="field__hint">
                      {rule.zoneIds.length && active && !zoneOptions.some((o) => o.ids.some((id) => rule.zoneIds.includes(id))) ? `Nothing picked on ${active.id}: while zones are picked on other cameras, this camera is not watched by the rule.` : rule.zoneIds.length ? '' : isFire ? 'None picked: the whole view' : realCams.length ? NO_ZONE_HINT[rule.condition] ?? 'None picked: the whole view' : 'None picked: the whole view'}
                    </span>
                  )}
                  {isFire && ignoreAreas.length > 0 && <span className="field__hint">Always left out (ignore areas): {ignoreAreas.join(', ')}.</span>}
                </div>
              )}
              {realCams.length > 0 && (
                <span className={`greal${runsForReal ? '' : ' is-warn'}`}>
                  {runsForReal
                    ? `Runs for real on ${realCams.length} camera${realCams.length === 1 ? '' : 's'} with a live link or uploaded video`
                    : 'Protective equipment checks do not run on real cameras yet; this rule will not alert on them'}
                </span>
              )}
            </section>

            <section className="gform__section">
              <h3>The alert</h3>
              <div className="field">
                <span className="field__label">Criticality</span>
                <Seg label="Alert criticality" value={rule.priority} onChange={(v) => set({ priority: v }, 'priority')} options={(['P1', 'P2', 'P3', 'P4'] as Priority[]).map((p) => ({ value: p, label: `${p} ${PRIORITY_NAME[p]}` }))} />
                {policy && (
                  <span className="field__hint">
                    {policy.channels.map((c) => CHANNEL[c].label).join(', ')} to the {policy.notify.map(roleText).join(' and ')}
                    {policy.escalateTo !== 'none' ? `; escalates to the ${roleText(policy.escalateTo)} if not reviewed in ${duration(policy.reviewWithinSec * 1000)}` : ''}.{' '}
                    <Link to="/configuration/alerts">Change who is told</Link>
                  </span>
                )}
              </div>
              <div className="grid-2">
                <Choice
                  id="r-q"
                  label="Report"
                  value={rule.report}
                  onChange={(report) => set({ report }, 'report')}
                  options={[...(['Incident', 'Observation', 'Near miss'] as ReportType[]).map((v) => ({ value: v as ReportType | 'none', label: v })), { value: 'none' as ReportType | 'none', label: "Don't create one" }]}
                />
                <Choice id="r-class" label="Classification" value={rule.classification} onChange={(v) => set({ classification: v as Classification }, 'report')} options={(['Unsafe act', 'Unsafe condition'] as Classification[]).map((v) => ({ value: v, label: v }))} />
              </div>
            </section>

            {(steadyKind || isFire) && (
              <details className="gform__section gadv">
                <summary>Fine-tuning: how steady and how sure before it alerts</summary>
            {steadyKind && (
              <div className="field steady">
                <div className="grid-3" style={{ gap: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                  <div className="field">
                    <label htmlFor="r-frames">Frames in a row</label>
                    <input id="r-frames" className="input" type="number" min={1} max={300} value={steady.frames} onChange={(e) => set({ minFrames: Math.max(1, Math.round(Number(e.target.value)) || 1) })} />
                    <span className="field__hint">Seen in the zone this many analysed frames in a row. Ignores one-frame blips.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="r-sure">Detector at least (%) sure</label>
                    <input id="r-sure" className="input" type="number" min={0} max={100} value={steady.sure} onChange={(e) => set({ minConfidence: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })} />
                    <span className="field__hint">A person it is less sure of never alerts, however long they stay.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="r-repeat">Don't repeat for (seconds)</label>
                    <input id="r-repeat" className="input" type="number" min={0} value={steady.repeat} onChange={(e) => set({ repeatSec: Math.max(0, Number(e.target.value) || 0) })} />
                    <span className="field__hint">{REPEAT_HINT[rule.condition] ?? 'After an alert, the same person raises no new one for this long.'}</span>
                  </div>
                  {MOVE_HINT[rule.condition] && (
                    <div className="field">
                      <label htmlFor="r-move">{rule.condition === 'stopped' ? 'Counts as moving after (pixels)' : 'Must have moved (pixels)'}</label>
                      <input id="r-move" className="input" type="number" min={0} value={rule.minMovePx ?? MOVE_DEFAULT[rule.condition] ?? steady.move} onChange={(e) => set({ minMovePx: Math.max(0, Number(e.target.value) || 0) })} />
                      <span className="field__hint">{MOVE_HINT[rule.condition]}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {isFire && (
              <div className="field steady">
                <div className="grid-3" style={{ gap: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                  <div className="field">
                    <label htmlFor="r-hits">Frames seen, of the last 8</label>
                    <input id="r-hits" className="input" type="number" min={1} max={8} value={steady.frames} onChange={(e) => set({ minFrames: Math.min(8, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} />
                    <span className="field__hint">Ignores a one-frame glint. They need not be in a row.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="r-sure">Detector at least (%) sure</label>
                    <input id="r-sure" className="input" type="number" min={0} max={100} value={steady.sure} onChange={(e) => set({ minConfidence: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })} />
                    <span className="field__hint">Lower to catch small or thin smoke; raise if steam, fog or glare alerts.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="r-repeat">Don't repeat for (seconds)</label>
                    <input id="r-repeat" className="input" type="number" min={0} value={steady.repeat} onChange={(e) => set({ repeatSec: Math.max(0, Number(e.target.value) || 0) })} />
                    <span className="field__hint">After an alert, fire or smoke raises no new one for this long.</span>
                  </div>
                </div>
              </div>
            )}
              </details>
            )}
          </div>

          <aside className="stack ruleside">
            <div className="card gsum">
              <div className="gsum__sentence">
                <PriorityBadge p={rule.priority} short />
                <p>
                  {sentence}
                  {rule.schedule !== 'always' ? `, ${SCHEDULE_LABEL[rule.schedule].toLowerCase()}` : ''}
                  {chosen.length ? ` on ${chosen.length === 1 ? chosen[0].id : `${chosen.length} cameras`}` : ''}
                  {rule.report !== 'none' ? `. Reported as ${rule.report === 'Incident' ? 'an incident' : `a ${rule.report.toLowerCase()}`}` : ''}.
                </p>
              </div>
              {active ? (
                <CameraView cam={active} still zones={active.zones} highlightZones={rule.zoneIds} showZoneLabels caption={false} />
              ) : (
                <div className="gsum__nocam">Choose a camera to see what the rule watches</div>
              )}
              <div className="gsum__mode">
                <span className="field__label">Status</span>
                <Seg label="Status" value={rule.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'test', label: 'In test · logs only' }, { value: 'live', label: 'Live · alerts people' }]} />
                <span className="field__hint">{rule.mode === 'test' ? 'Matches are logged here; no one is told. Make it live once the matches look right.' : 'Matches raise alerts and tell the people above.'}</span>
              </div>
            </div>

            <div className="card gsum">
              <h3 className="gsum__h">Check it</h3>
              {realCams.length > 0 && (
                <div className="gsum__list">
                  <strong>
                    Test matches <span className="mono">{matches.length}</span>
                  </strong>
                  {rule.mode !== 'test' && <span className="field__hint">Put the rule in test to log matches here without telling anyone.</span>}
                  {rule.mode === 'test' && matches.length === 0 && <span className="field__hint">None yet. Matches from the camera appear here as they happen.</span>}
                  {matches.slice(0, 6).map((m) => (
                    <a key={m.id} className="gsum__item" href={apiUrl(m.snapshot)} target="_blank" rel="noreferrer">
                      <span className="mono">{hm(m.at)}</span> {m.cameraId} · {m.hazard ? `${m.hazard === 'fire' ? 'Fire' : 'Smoke'} · ` : ''}{m.zoneName || 'whole view'} · {Math.round(m.confidence * 100)}%{m.hazard ? '' : ` · ${m.dwell.toFixed(1)}s`}
                    </a>
                  ))}
                </div>
              )}
              <div className="gsum__btns">
                {!(realCams.length > 0 && realCams.length === chosen.length) && (
                  <button type="button" className="gbtn gbtn--sm" onClick={runBacktest} disabled={!chosen.length}>
                    <Icon name="clock" size={15} />
                    Try on the last 24 h
                  </button>
                )}
                {existing && (
                  <button type="button" className="gbtn gbtn--sm" disabled={!chosen.some((c) => c.status !== 'offline')} onClick={() => setPreview(previewFor(existing, chosen.find((c) => c.status !== 'offline')!))}>
                    <Icon name="eye" size={15} />
                    Preview the alert
                  </button>
                )}
              </div>
              {backtest && (
                <div className="gsum__list">
                  <strong>
                    Would have alerted <span className="mono">{backtest.total}</span> time{backtest.total === 1 ? '' : 's'}
                  </strong>
                  {backtest.hits.map((h, i) => (
                    <span key={i} className="gsum__item">
                      <span className="mono">{hm(h.at)}</span> {h.cam.id} {h.cam.name}
                    </span>
                  ))}
                  {backtest.total === 0 && <span className="field__hint">No matches. Check the zones and the time.</span>}
                </div>
              )}
            </div>
          </aside>
        </div>
        {preview && <AlertPreview alert={preview} onClose={() => setPreview(undefined)} />}
      </fieldset>

      <div className="gcs__foot">
        <span className={`gcs__saved${!existing ? '' : dirty ? ' is-dirty' : ' is-clean'}`} aria-live="polite">
          <i aria-hidden="true" />
          {!existing ? 'Not created yet: nothing is saved until you click Create rule' : dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <span className="spacer" />
        {!valid && admin && <span className="gcs__why">Choose at least one camera</span>}
        <button type="button" className="gbtn" onClick={leave}>
          {dirty ? 'Cancel' : 'Close'}
        </button>
        {admin && (
          <button type="button" className="gbtn gbtn--primary" onClick={save} disabled={!valid || (!!existing && !dirty)}>
            {existing ? 'Save rule' : 'Create rule'}
          </button>
        )}
      </div>

      {picking && (
        <CameraPicker
          selected={rule.cameraIds}
          onClose={() => setPicking(false)}
          onDone={(ids) => {
            const keepZones = rule.zoneIds.filter((z) => ids.some((id) => z.startsWith(`${id}-`)));
            // On a real camera the zones drawn on it are what the rule is for: start with all of them picked, so a person
            // outside them does not alert. Un-pick them all to watch the whole view.
            // Cameras added now bring their drawn zones along; cameras already on the rule keep what was picked.
            const drawn = cams.filter((c) => ids.includes(c.id) && !rule.cameraIds.includes(c.id) && c.source).flatMap((c) => c.zones.filter((z) => (isFire ? z.purpose === 'fire-watch' : !z.purpose.startsWith('fire-'))).map((z) => z.id));
            set({ cameraIds: ids, zoneIds: [...keepZones, ...drawn] }, 'cameras');
            setActiveId((cur) => (cur && ids.includes(cur) ? cur : ids[0]));
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

const CHIP_LIMIT = 8;
const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** Conditions the detection service runs for real. The others (protective equipment) are still simulated. */
const REAL_CONDITIONS: Condition[] = ['enters', 'dwells', 'outside', 'crosses', 'crowd', 'gathering', 'stopped', 'near', 'fewer', 'absent', 'wrongway', 'tailgate', 'speeding', 'running', 'abandoned', 'phone', 'down'];

/** What the rule starts with when the condition is changed to one of these, so the form shows what the service will use. */
export const CONDITION_DEFAULTS: Partial<Record<Condition, Partial<Rule>>> = {
  dwells: { subject: 'vehicle', durationSec: 300, minConfidence: 0.3, minMovePx: 0, minFrames: 3 },
  outside: { durationSec: 3, minConfidence: 0.25, minMovePx: 10, minFrames: 3 },
  crosses: { durationSec: 0, minConfidence: 0.3, minFrames: 2 },
  crowd: { durationSec: 5, minConfidence: 0.3, minFrames: 2 },
  gathering: { subject: 'person', durationSec: 10, minConfidence: 0.3, minFrames: 2, minPeople: 5 },
  stopped: { subject: 'vehicle', durationSec: 30, minConfidence: 0.3, minMovePx: 12, minFrames: 3 },
  near: { durationSec: 0.5, minConfidence: 0.45, minFrames: 2, repeatSec: 10, nearHeights: 1, nearMovingOnly: true },
  fewer: { subject: 'person', durationSec: 10, minConfidence: 0.3, minFrames: 2, minPeople: 2 },
  absent: { subject: 'person', durationSec: 10, minConfidence: 0.3, minFrames: 2 },
  wrongway: { durationSec: 0, minConfidence: 0.3, minFrames: 2, allowedDir: 1 },
  tailgate: { subject: 'person', durationSec: 0, minConfidence: 0.3, minFrames: 2, gapSec: 3 },
  speeding: { subject: 'vehicle', durationSec: 0.5, minConfidence: 0.3, minFrames: 3, speedKmh: 30, metersAcross: 60 },
  running: { subject: 'person', durationSec: 1, minConfidence: 0.3, minFrames: 3, runSpeed: 1.6 },
  abandoned: { subject: 'any', durationSec: 60, minConfidence: 0.3, minFrames: 3, ownerPx: 150 },
  phone: { subject: 'any', durationSec: 2, minConfidence: 0.3, minFrames: 2, phoneConfidence: 0.35 },
  down: { subject: 'person', durationSec: 5, minConfidence: 0.3, minFrames: 3, repeatSec: 60 },
};
const NO_ZONE_HINT: Partial<Record<Condition, string>> = {
  enters: 'None picked: people anywhere in the view count, outside the drawn zones too',
  dwells: 'None picked: a vehicle staying anywhere in the view counts',
  outside: 'Pick the allowed areas. With none picked this rule has nothing to watch',
  crosses: 'Pick a line drawn on the camera. With none picked this rule has nothing to watch',
  crowd: 'None picked: everyone in the view is counted together',
  gathering: 'None picked: a group packed together anywhere in the view counts',
  stopped: 'None picked: a vehicle stopping anywhere in the view counts',
  near: 'None picked: a person near a moving vehicle anywhere in the view counts',
  fewer: 'None picked: everyone in the view is counted together',
  absent: 'None picked: the whole view must be empty',
  wrongway: 'Pick a line drawn on the camera. With none picked this rule has nothing to watch',
  tailgate: 'Pick a line drawn on the camera (the door or gate). With none picked this rule has nothing to watch',
  speeding: 'None picked: a vehicle over the limit anywhere in the view counts',
  running: 'None picked: anyone running anywhere in the view counts',
  abandoned: 'None picked: an object left anywhere in the view counts. Pick a walkway to flag obstructions there',
  phone: 'None picked: a phone in use anywhere in the view counts',
  down: 'None picked: a person down anywhere in the view counts',
};
const REPEAT_HINT: Partial<Record<Condition, string>> = {
  crosses: 'After an alert, the same person crossing the same line raises no new one for this long.',
  crowd: 'While the crowd stays, it alerts again after this long.',
  gathering: 'While the group stays together, it alerts again after this long.',
  stopped: 'While the vehicle stays stopped, it alerts again after this long.',
};
const MOVE_DEFAULT: Partial<Record<Condition, number>> = { stopped: 12 };
const MOVE_HINT: Partial<Record<Condition, string>> = {
  enters: 'Ignores a pole or flag the detector sometimes calls a person: it never moves. Someone who walks in and then stops still counts. 0 turns it off.',
  outside: 'Ignores a pole or flag the detector sometimes calls a person: it never moves. 0 turns it off.',
  dwells: 'Standing still is what this rule looks for, so 0 turns the check off. Set it to ignore a pole the detector calls a person.',
  stopped: 'A vehicle that creeps less than this is still stopped. A vehicle that was never seen moving is not reported.',
};

/** The zones a rule can pick. Fire and smoke picks watch areas; every other condition leaves the fire areas out, because
 *  a fire and smoke area is not a restricted area and a restricted area is not a place to watch for fire. */
export function useZoneOptions(chosen: Camera[], fire: boolean) {
  return useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of chosen) for (const z of c.zones) if (fire ? z.purpose === 'fire-watch' : !z.purpose.startsWith('fire-')) m.set(z.name, [...(m.get(z.name) ?? []), z.id]);
    return [...m.entries()].map(([name, ids]) => ({ name, ids }));
  }, [chosen, fire]);
}

function CameraPicker({ selected, onClose, onDone }: { selected: string[]; onClose: () => void; onDone: (ids: string[]) => void }) {
  const cams = useCameras();
  const [sel, setSel] = useState(new Set(selected));
  const [q, setQ] = useState('');
  const toggle = (id: string, on: boolean) => {
    const s = new Set(sel);
    if (on)s.add(id);
    else s.delete(id);
    setSel(s);
  };
  return (
    <Modal
      title="Choose Cameras"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="meta" style={{ marginRight: 'auto' }}>
            {sel.size} selected
          </span>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => onDone([...sel])}>
            Use {sel.size} cameras
          </button>
        </>
      }
    >
      <input className="input" placeholder="Filter cameras" aria-label="Filter cameras" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
      {AREAS.map((a) => {
        const items = cams.filter((c) => c.areaId === a.id && looseMatch(`${c.id} ${c.name}`, q));
        if (!items.length) return null;
        const all = items.every((c) => sel.has(c.id));
        return (
          <div key={a.id} className="picker__area">
            <label className="check picker__areahead">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => {
                  const s = new Set(sel);
                  items.forEach((c) => (e.target.checked ? s.add(c.id) : s.delete(c.id)));
                  setSel(s);
                }}
              />
              <strong>{a.name}</strong>
              <span className="meta">{items.length}</span>
            </label>
            <div className="picker__grid">
              {items.map((c) => (
                <label key={c.id} className={`picker__cam${sel.has(c.id) ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={sel.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                  <span className="mono">{c.id}</span>
                  <span className="ellipsis">{c.name}</span>
                  {c.zones.length === 0 && <span className="chip chip--warn">no zones</span>}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </Modal>
  );
}

/** What an alert from this rule would look like, and who would be told. Built on the spot: nothing is stored and no one
 *  is notified, so a check leaves no trace in the alert list. */
function AlertPreview({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const cams = useCameras();
  const policy = usePolicies().find((p) => p.priority === alert.priority);
  const cam = cams.find((c) => c.id === alert.cameraId);
  const people = [...new Set(alert.deliveries.map((d) => d.to))].map((to) => ({ to, channels: alert.deliveries.filter((d) => d.to === to).map((d) => CHANNEL[d.channel].label) }));
  return (
    <Modal
      title="Alert preview"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="apreview">
        <p className="apreview__note">
          <Icon name="info" size={16} />
          Preview only. Nothing is saved to the alert list and no one is told.
        </p>
        <div className="apreview__card">
          <div className="row" style={{ gap: 10 }}>
            <PriorityBadge p={alert.priority} />
            <strong>{alert.title}</strong>
          </div>
          <span className="meta">{alert.detail}</span>
          <span className="meta">
            {cam?.id} · {cam?.name}
          </span>
        </div>
        <div className="apreview__who">
          <span className="apreview__label">Who would be told</span>
          {people.length === 0 && <span className="meta">No one: this criticality has no one to notify.</span>}
          {people.map((p) => (
            <span key={p.to} className="apreview__person">
              <strong>{userName(p.to)}</strong>
              <span className="meta">{p.channels.join(', ')}</span>
            </span>
          ))}
        </div>
        {policy && (
          <span className="meta">
            Review within {duration(policy.reviewWithinSec * 1000)}{policy.reportWithinSec ? `, report within ${duration(policy.reportWithinSec * 1000)}` : ''}{policy.escalateTo !== 'none' ? `, then it escalates to the ${roleText(policy.escalateTo)}` : ''}.
          </span>
        )}
      </div>
    </Modal>
  );
}
