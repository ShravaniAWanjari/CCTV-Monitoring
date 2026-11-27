import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Icon } from '../../components/Icon';
import { ReadOnlyNote } from '../../components/Shell';
import { CameraView, Choice, Drawer, Modal, PRIORITY_NAME, Seg, useConfirm } from '../../components/ui';
import { describeRule } from '../../lib/assist';
import { isActiveRule } from '../../lib/usecases';
import { AREA_DEPARTMENT, AREAS, DEPARTMENTS } from '../../data/seed';
import { cameraStore, nextCameraId, ruleStore } from '../../state/store';

const PREFIX_OF: Record<string, string> = { quay: 'QUA', deck: 'DCK', yard: 'YRD', reefer: 'RFR', gate: 'GTE', workshop: 'WSH', hazmat: 'HAZ', perimeter: 'PER' };
import type { Camera, CameraSource, Rule, ZonePurpose } from '../../data/types';
import { SAMPLE_VIDEOS } from '../../data/samples';
import { backend, rememberPassword, type ProbeResult } from '../../lib/backend';
import { FIRE_PURPOSES, PURPOSE_LABEL, ZONE_COLORS } from '../../scenes/zones';
import { useService } from '../../state/bridge';
import { departmentOf, isAdmin, placementFor, removeCamera, saveCamera, saveRule, saveWall, setCameraOnRule, toast, useCameras, useMe, useRules, useWalls } from '../../state/store';
import { LAYOUT_SLOTS } from '../wall/WallBody';
import { NewRulePanel } from '../rules/NewRulePanel';
import { ZoneEditor } from './ZoneEditor';
import '../overview-gyt.css';
import './cameras.css';
import './cameras-gyt.css';

type Step = 'connect' | 'zones' | 'walls';

const MAKES = ['Axis Q1786-LE', 'Hanwha XNO-8082R', 'Bosch DINION 5100i', 'Hikvision DS-2CD5A46', 'Other ONVIF camera'];

export function CameraEditor() {
  const { cameraId } = useParams();
  const isNew = !cameraId;
  const cams = useCameras();
  const allRules = useRules();
  // Only the rules of the use cases offered; the others (sample data) are left alone when the camera is saved.
  const rules = useMemo(() => allRules.filter(isActiveRule), [allRules]);
  const walls = useWalls();
  const me = useMe();
  const nav = useNavigate();
  const confirm = useConfirm();
  const existing = cams.find((c) => c.id === cameraId);
  const canEdit = isAdmin(me);

  const [cam, setCam] = useState<Camera | undefined>(() => existing ?? blank(cams));
  const [step, setStep] = useState<Step>(isNew ? 'connect' : 'zones');
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | 'fail'>(isNew ? 'idle' : 'ok');
  const [user, setUser] = useState('svc-cctv');
  const [pass, setPass] = useState('');
  const [sel, setSel] = useState<string>();
  const service = useService();
  const [kind, setKind] = useState<'link' | 'upload'>(existing?.source?.kind ?? 'link');
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [sample, setSample] = useState<string>(() => SAMPLE_VIDEOS.find((v) => v.id === existing?.source?.uploadId)?.id ?? '');
  const [wallPlan, setWallPlan] = useState<Record<string, 'off' | 'rolls' | 'pinned'>>({});
  const [rulePlan, setRulePlan] = useState<Record<string, boolean>>({});
  // The zones of this camera each rule watches, once someone changed them here; until then zonesFor() works them out.
  const [ruleZones, setRuleZones] = useState<Record<string, string[]>>({});
  // The existing rule open in the side panel, and the zones ticked there before Apply.
  const [panelRule, setPanelRule] = useState<string>();
  const [panelZones, setPanelZones] = useState<string[]>([]);
  const [newRule, setNewRule] = useState(false);
  // A camera being added starts on the walls and rules that already cover its work area, until someone changes a choice.
  const [touched, setTouched] = useState(false);
  // A new camera counts as added (and is saved) once Add camera is clicked on Connect; the later steps open only then.
  const [added, setAdded] = useState(false);
  // Asked before leaving Draw zones (Next) or saving with no zone drawn; holds what was being done.
  const [noZoneAsk, setNoZoneAsk] = useState<false | 'next' | 'save'>(false);
  const [noZoneOk, setNoZoneOk] = useState(false);

  useEffect(() => {
    if (existing && existing.id !== cam?.id) setCam(existing);
    // Only when the route changes to another camera.
  }, [cameraId]);

  useEffect(() => {
    if (!cam) return;
    const plan: Record<string, 'off' | 'rolls' | 'pinned'> = {};
    for (const w of walls) plan[w.id] = w.pinned.includes(cam.id) ? 'pinned' : w.rotation.includes(cam.id) ? 'rolls' : 'off';
    setWallPlan(plan);
    setRulePlan(Object.fromEntries(rules.map((r) => [r.id, r.cameraIds.includes(cam.id)])));
  }, [cam?.id]);

  const place = cam ? placementFor(cam, walls) : { walls: [] as string[] };
  const suggested = cam && isNew && !touched ? place : undefined;
  const wallMode = (id: string): 'off' | 'rolls' | 'pinned' => (suggested ? (suggested.walls.includes(id) ? 'rolls' : 'off') : (wallPlan[id] ?? 'off'));
  // Rules are the admin's choice: nothing is ticked for a new camera.
  const ruleOn = (id: string) => rulePlan[id] ?? false;
  /** This camera's zones a rule can use: fire watch areas for a fire and smoke rule, the other zones for the rest. */
  const zonesForKind = (r: Rule) => (cam?.zones ?? []).filter((z) => (r.condition === 'smoke' ? z.purpose === 'fire-watch' : !z.purpose.startsWith('fire-')));
  /** The zones of this camera a rule watches: as changed here, else as the rule already has them, else every zone that fits
   *  the rule (a rule switched on here watches what was drawn for it, with no second visit to the Rules page). */
  const zonesFor = (r: Rule) => {
    const usable = zonesForKind(r).map((z) => z.id);
    if (ruleZones[r.id]) return ruleZones[r.id].filter((id) => usable.includes(id));
    const had = r.zoneIds.filter((id) => usable.includes(id));
    return r.cameraIds.includes(cam?.id ?? '') && had.length ? had : usable;
  };
  const openRule = (r: Rule) => {
    setPanelZones(zonesFor(r));
    setPanelRule(r.id);
  };
  /** Apply in the side panel: the rule watches this camera in the zones ticked there (saved with the camera). */
  const applyRule = (on: boolean) => {
    if (!panelRule) return;
    if (on) setRuleZones({ ...ruleZones, [panelRule]: panelZones });
    choose({ rule: [panelRule, on] });
    setPanelRule(undefined);
  };
  const zoneNamesOf = (ids: string[]) => (cam?.zones ?? []).filter((z) => ids.includes(z.id)).map((z) => z.name);
  // The first change turns what was suggested into explicit choices.
  const choose = (patch: { wall?: [string, 'off' | 'rolls' | 'pinned']; rule?: [string, boolean] }) => {
    const wp = Object.fromEntries(walls.map((w) => [w.id, wallMode(w.id)])) as Record<string, 'off' | 'rolls' | 'pinned'>;
    const rp = Object.fromEntries(rules.map((r) => [r.id, ruleOn(r.id)]));
    if (patch.wall) wp[patch.wall[0]] = patch.wall[1];
    if (patch.rule) rp[patch.rule[0]] = patch.rule[1];
    setWallPlan(wp);
    setRulePlan(rp);
    setTouched(true);
  };

  if (!cam) {
    return (
      <div className="page">
        <p>
          Camera {cameraId} not found. <Link to="/cameras">Back to cameras</Link>
        </p>
      </div>
    );
  }

  const set = (p: Partial<Camera>) => setCam({ ...cam, ...p });
  const setArea = (areaId: string) => {
    const area = AREAS.find((a) => a.id === areaId)!;
    setCam({ ...cam, areaId, scene: area.scene, id: isNew ? nextCameraId(PREFIX_OF[areaId], cams) : cam.id, zones: isNew ? [] : cam.zones });
    if (isNew) setTest('idle');
  };

  const isRtsp = /^rtsps?:\/\//i.test(cam.stream.trim());

  /** A source answered: keep its first frame for drawing zones, and what it told us about itself. */
  const applyProbe = (r: ProbeResult, source: CameraSource) => {
    const title = (r.title || (source.fileName ?? '').replace(/\.[^.]+$/, '')).replace(/\s*\(.*$/, '').slice(0, 60);
    setCam((c) => ({
      ...c!,
      name: c!.name || title,
      resolution: `${r.width} × ${r.height}`,
      fps: Math.round(r.fps ?? c!.fps),
      // A real camera is not an Axis or a Hanwha: say what it is instead of keeping the sample default.
      make: r.kind === 'upload' ? 'Uploaded video' : r.kind === 'youtube' ? 'YouTube live stream' : 'Live stream',
      stream: source.kind === 'link' ? (source.url ?? '') : `uploaded: ${source.fileName ?? 'video'}`,
      source: { ...source, frameUrl: r.frameUrl, width: r.width, height: r.height, live: r.live, title: r.title },
    }));
    setErr('');
    setTest('ok');
  };

  const runTest = async () => {
    if (!service.online) {
      // Without the detection service this is the sample flow: a shape check and a drawn scene.
      if (!/^rtsp:\/\/[\w.-]+(:\d+)?\/\S*/.test(cam.stream)) {
        setTest('fail');
        setErr('Use an RTSP address, for example rtsp://10.40.1.25:554/stream1');
        return;
      }
      setTest('testing');
      window.setTimeout(() => setTest('ok'), 1200);
      return;
    }
    const url = cam.stream.trim();
    setTest('testing');
    setErr('');
    try {
      const r = await backend.probeLink(url, isRtsp ? { user, password: pass } : undefined);
      applyProbe(r, { kind: 'link', url, user: isRtsp ? user : undefined });
    } catch (e) {
      setTest('fail');
      setErr((e as Error).message);
    }
  };

  const sendFile = async (file: File | undefined) => {
    if (!file) return;
    setTest('testing');
    setErr('');
    setProgress(0);
    try {
      const r = await backend.upload(file, setProgress);
      applyProbe(r, { kind: 'upload', uploadId: r.uploadId, fileName: file.name, everyFrame: true });
    } catch (e) {
      setTest('fail');
      setErr((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  /** A bundled sample video: the service already has the file, so only a frame is read. */
  const pickSample = async (id: string) => {
    setSample(id);
    const video = SAMPLE_VIDEOS.find((v) => v.id === id);
    if (!video) return;
    setTest('testing');
    setErr('');
    try {
      const r = await backend.probeUpload(video.id);
      applyProbe(r, { kind: 'upload', uploadId: video.id, fileName: video.fileName, everyFrame: true });
      // The location takes the name a port would give that camera unless the admin typed their own (a name left by another sample is replaced).
      setCam((c) => (c ? { ...c, make: MAKES[0], name: !c.name || SAMPLE_VIDEOS.some((v) => v.label === c.name || v.cameraName === c.name) ? video.cameraName : c.name } : c));
    } catch (e) {
      setTest('fail');
      setErr((e as Error).message);
    }
  };

  const usedBy = (zoneId: string) => rules.filter((r) => r.zoneIds.includes(zoneId)).map((r) => r.id);

  /** Store the camera and its zones (and send it to the detection service), without touching rules or walls. Done when the
   *  camera is added on Connect, so the rule editor lists it at once, and again on the way to Rules and walls, so a new rule
   *  made there can pick the zones just drawn. */
  const storeCamera = () => {
    if (isRtsp && pass) rememberPassword(cam.id, pass);
    const stored = cameraStore.get().find((c) => c.id === cam.id);
    // The choices made here are the ones that count, so the store does not add the camera to anything on its own.
    saveCamera({ ...cam, addedAt: stored?.addedAt ?? Date.now(), addedBy: stored?.addedBy ?? me.id, status: stored?.status ?? 'online' }, { place: false });
  };

  const save = () => {
    storeCamera();
    for (const w of walls) {
      const want = wallMode(w.id);
      let pinned = w.pinned.map((p) => (p === cam.id ? null : p));
      let rotation = w.rotation.filter((id) => id !== cam.id);
      if (want === 'rolls') rotation = [...rotation, cam.id];
      if (want === 'pinned') {
        const slots = LAYOUT_SLOTS[w.pinnedLayout];
        const free = pinned.slice(0, slots).findIndex((p) => !p);
        const i = free >= 0 ? free : Math.min(pinned.length, slots - 1);
        pinned = [...pinned];
        while (pinned.length <= i) pinned.push(null);
        pinned[i] = cam.id;
        rotation = [...rotation, cam.id];
      }
      if (want !== (w.pinned.includes(cam.id) ? 'pinned' : w.rotation.includes(cam.id) ? 'rolls' : 'off')) saveWall({ ...w, pinned, rotation });
    }
    // Rules: the camera joins the ones switched on, with the zones picked for each, and leaves the ones switched off.
    for (const r of ruleStore.get()) {
      if (!isActiveRule(r)) continue;
      const want = ruleOn(r.id);
      const has = r.cameraIds.includes(cam.id);
      if (!want && !has) continue;
      const zones = want ? zonesFor(r) : [];
      const before = r.zoneIds.filter((id) => cam.zones.some((z) => z.id === id));
      if (want === has && zones.length === before.length && zones.every((id) => before.includes(id))) continue;
      saveRule(setCameraOnRule(r, cam, want, zones));
    }
    const watching = ruleStore.get().filter((r) => r.cameraIds.includes(cam.id)).length;
    toast(`${cam.id} ${cam.name} saved · ${cam.zones.length} ${cam.zones.length === 1 ? 'zone' : 'zones'}, ${watching} ${watching === 1 ? 'rule' : 'rules'}`);
    nav('/cameras');                     // done: back to the list, never back into the editor
  };

  /** Add camera on Connect: the camera is saved now, with no zones yet, and the next step is drawing them. */
  const addCamera = () => {
    storeCamera();
    setAdded(true);
    setStep('zones');
    toast(`${cam.id} ${cam.name} added · draw its zones next`);
  };

  /** Move between the steps. Leaving Draw zones for Rules and walls stores the zones (rules made there need them), and asks
   *  first when no zone was drawn, because then detection would watch the whole picture. */
  const goTo = (to: Step) => {
    if (to === step) return;
    if (to === 'walls' && step !== 'walls') {
      if (cam.zones.length === 0 && !noZoneOk) {
        setNoZoneAsk('next');
        return;
      }
      storeCamera();
    }
    setStep(to);
  };

  // What is saved and what is not, so the bar at the bottom can say it plainly.
  const strip = (c?: Camera) => (c ? JSON.stringify({ ...c, status: undefined, statusSince: undefined, addedAt: undefined, addedBy: undefined }) : '');
  const stored = cams.find((c) => c.id === cam.id);
  const camDirty = !stored || strip(stored) !== strip(cam);
  const wallsDirty = walls.some((w) => wallMode(w.id) !== (w.pinned.includes(cam.id) ? 'pinned' : w.rotation.includes(cam.id) ? 'rolls' : 'off'));
  const rulesDirty = rules.some((r) => {
    const has = r.cameraIds.includes(cam.id);
    if (ruleOn(r.id) !== has) return true;
    if (!has || !ruleZones[r.id]) return false;
    const before = r.zoneIds.filter((id) => cam.zones.some((z) => z.id === id));
    const now = zonesFor(r);
    return now.length !== before.length || now.some((id) => !before.includes(id));
  });
  const notAdded = isNew && !added;
  const dirty = notAdded ? test === 'ok' || !!cam.name.trim() : camDirty || ((!isNew || added) && (wallsDirty || (touched && rulesDirty)));
  const rulesOnCam = rules.filter((r) => ruleOn(r.id)).length;
  const leave = () => (dirty ? confirm.ask({ title: notAdded ? 'Discard this camera?' : 'Discard your changes?', message: notAdded ? 'It has not been added yet.' : 'Changes since the last save are lost.', action: 'Discard' }, () => nav('/cameras')) : nav('/cameras'));

  const steps: { id: Step; label: string; detail: string; done: boolean }[] = [
    { id: 'connect', label: 'Connect', detail: test === 'ok' ? `Connected · ${cam.resolution}` : 'Where it is and its picture', done: test === 'ok' && !notAdded },
    { id: 'zones', label: 'Draw zones', detail: cam.zones.length ? `${cam.zones.length} ${cam.zones.length === 1 ? 'zone' : 'zones'} drawn` : 'Where detection looks', done: cam.zones.length > 0 },
    { id: 'walls', label: 'Rules and walls', detail: rulesOnCam ? `${rulesOnCam} ${rulesOnCam === 1 ? 'rule' : 'rules'} on it` : 'What it watches for, where it shows', done: rulesOnCam > 0 },
  ];
  const selZone = cam.zones.find((z) => z.id === sel);
  const open = (id: Step) => id === 'connect' || (test === 'ok' && (!isNew || added));

  return (
    <div className="page gyt gcs camsetup">
      <header className="gcs__head">
        <div className="gcs__title">
          <a href="#/cameras" className="gcs__back" onClick={(e) => { e.preventDefault(); leave(); }}>
            <Icon name="arrow-left" size={14} />
            Cameras
          </a>
          <h1>{isNew && !added ? 'Add a camera' : cam.name || cam.id}</h1>
          <p>
            <span className="mono">{cam.id}</span>
            {cam.name && ` · ${AREAS.find((a) => a.id === cam.areaId)?.name ?? ''}`}
          </p>
        </div>
        <div className="ovhead__actions">
          {!isNew && canEdit && (
            <button
              type="button"
              className="gbtn gbtn--danger"
              onClick={() =>
                confirm.ask({ title: `Remove ${cam.id}?`, message: 'Its zones go too, and it comes off every rule and wall.', action: 'Remove camera' }, () => {
                  removeCamera(cam.id);
                  toast(`${cam.id} removed`);
                  nav('/cameras');
                })
              }
            >
              <Icon name="trash" size={15} />
              Remove
            </button>
          )}
        </div>
      </header>

      {confirm.dialog}
      <ReadOnlyNote>Only the safety admin adds cameras and draws zones.</ReadOnlyNote>

      <div className="gsteps" role="tablist" aria-label="Set-up steps">
        {steps.map((st, i) => (
          <button key={st.id} type="button" role="tab" aria-selected={step === st.id} onClick={() => open(st.id) && goTo(st.id)} disabled={!open(st.id)} title={!open(st.id) ? (notAdded ? 'Add the camera first' : 'Connect the camera first') : undefined}>
            <span className={`gsteps__n${st.done && step !== st.id ? ' is-done' : ''}`}>{st.done && step !== st.id ? <Icon name="check" size={13} /> : i + 1}</span>
            <span className="gsteps__text">
              <strong>{st.label}</strong>
              <span>{st.detail}</span>
            </span>
          </button>
        ))}
      </div>

      <fieldset className="plain" disabled={!canEdit}>
        {step === 'connect' && (
          <div className="camedit">
            <div className="card card--pad stack">
              <section className="gform__section">
                <h3>Where it is</h3>
                <div className="grid-2">
                  <Choice id="c-area" label="Work area" value={cam.areaId} onChange={setArea} disabled={!isNew || added} options={AREAS.map((a) => ({ value: a.id, label: a.name }))} />
                  <Choice
                    id="c-dept"
                    label="Department"
                    value={departmentOf(cam)}
                    onChange={(d) => set({ department: d === AREA_DEPARTMENT[cam.areaId] ? undefined : d })}
                    options={[...new Set([...DEPARTMENTS, ...cams.map(departmentOf)])].map((d) => ({ value: d, label: d }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="c-name">Location name</label>
                  <input id="c-name" className="input" value={cam.name} onChange={(e) => set({ name: e.target.value })} placeholder="For example: Berth 2 · deck port side" />
                  <span className="field__hint">
                    What people call this spot; it shows on alerts and the wall. Camera ID <span className="mono">{cam.id}</span> is given from the work area{isNew && !added ? '' : ' and stays fixed'}.
                  </span>
                </div>
              </section>

              <section className="gform__section">
                <h3>Picture</h3>
                {service.online ? (
                  <Seg
                    label="Source"
                    value={kind}
                    onChange={(v) => {
                      setKind(v);
                      setErr('');
                      if (isNew) setTest('idle');
                    }}
                    options={[
                      { value: 'link', label: 'Camera or stream link' },
                      { value: 'upload', label: 'Video file' },
                    ]}
                  />
                ) : (
                  <span className="gcs__warn">The detection service is not running, so only a sample RTSP address can be checked. Start it with backend/run.sh to connect a real camera.</span>
                )}
                {kind === 'link' || !service.online ? (
                  <>
                    <div className="field">
                      <label htmlFor="c-url">Stream address</label>
                      <input
                        id="c-url"
                        className="input mono"
                        value={cam.stream}
                        onChange={(e) => {
                          set({ stream: e.target.value });
                          if (isNew) setTest('idle');
                        }}
                        placeholder={service.online ? 'rtsp://10.40.1.25:554/stream1 or a YouTube live link' : 'rtsp://10.40.1.25:554/stream1'}
                      />
                      <span className="field__hint">RTSP from a camera or recorder on the network, an HTTP / HLS stream, or a YouTube live link.</span>
                    </div>
                    {(isRtsp || !service.online) && (
                      <div className="grid-2">
                        <div className="field">
                          <label htmlFor="c-user">User name</label>
                          <input id="c-user" className="input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="field">
                          <label htmlFor="c-pass">Password</label>
                          <input id="c-pass" className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" placeholder={isNew ? '' : 'Saved · leave blank to keep'} />
                        </div>
                      </div>
                    )}
                    {!service.online && !cam.source && (
                      <Choice id="c-make" label="Make and model" value={cam.make} onChange={(make) => set({ make })} options={MAKES.map((m) => ({ value: m, label: m }))} />
                    )}
                    <div className="gconn">
                      <button type="button" className="gbtn" onClick={() => void runTest()} disabled={test === 'testing' || !cam.stream.trim()}>
                        <Icon name="wifi" size={15} />
                        {test === 'testing' ? 'Checking…' : test === 'ok' ? 'Check again' : 'Check connection'}
                      </button>
                      {test === 'ok' && (
                        <span className="gconn__ok">
                          <Icon name="check" size={14} />
                          Connected · {cam.resolution} · {cam.fps}fps{cam.source ? (cam.source.live ? ' · live' : ' · plays in a loop') : ''}
                        </span>
                      )}
                      {test === 'fail' && <span className="gconn__fail">{err || 'Could not connect'}</span>}
                    </div>
                  </>
                ) : (
                  <>
                    <Choice
                      id="c-sample"
                      label="Sample video"
                      value={sample}
                      onChange={(v) => void pickSample(v)}
                      options={[{ value: '', label: 'Choose a sample video' }, ...SAMPLE_VIDEOS.map((v) => ({ value: v.id as string, label: v.label }))]}
                    />
                    <div className="gconn">
                      <input ref={picker} type="file" accept="video/*,.mkv" hidden onChange={(e) => { void sendFile(e.target.files?.[0]); e.target.value = ''; }} />
                      <span className="meta">or</span>
                      <button type="button" className="gbtn" onClick={() => picker.current?.click()} disabled={test === 'testing'}>
                        <Icon name="upload" size={15} />
                        {cam.source?.kind === 'upload' && !sample ? 'Upload another video' : 'Upload your own video'}
                      </button>
                      {progress !== null && <span className="meta">Uploading {Math.round(progress * 100)}%</span>}
                      {test === 'testing' && progress === null && <span className="meta">Reading the video…</span>}
                      {test === 'ok' && (
                        <span className="gconn__ok">
                          <Icon name="check" size={14} />
                          Ready · {cam.resolution} · plays in a loop
                        </span>
                      )}
                      {test === 'fail' && <span className="gconn__fail">{err || 'Could not read the video'}</span>}
                    </div>
                    <span className="field__hint">mp4, mov, avi, mkv or webm. It loops like a camera that is always on.</span>
                    <details className="gadv">
                      <summary>Advanced</summary>
                      <div className="field">
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={!!cam.source?.everyFrame}
                            disabled={!cam.source || cam.source.kind !== 'upload'}
                            onChange={(e) => setCam((c) => (c && c.source ? { ...c, source: { ...c.source, everyFrame: e.target.checked } } : c))}
                          />
                          Analyse every frame
                        </label>
                        <span className="field__hint">The same result every run, but slower than real time on a slow computer. Off: real-time playback, frames skipped when the detector falls behind.</span>
                      </div>
                    </details>
                  </>
                )}
              </section>
            </div>
            <div className="stack">
              {test === 'ok' ? (
                <CameraView cam={cam} still={!!cam.source} frozen />
              ) : (
                <div className="camedit__placeholder">
                  <Icon name="camera" size={30} />
                  <span>{test === 'testing' ? 'Connecting…' : 'The picture appears here once the camera is connected'}</span>
                </div>
              )}
              {test === 'ok' && <p className="meta">Next: draw zones on this picture. Detection only looks inside them.</p>}
            </div>
          </div>
        )}

        {step === 'zones' && (
          <div className="camedit camedit--zones">
            <ZoneEditor cam={cam} zones={cam.zones} onChange={(zones) => set({ zones })} selectedId={sel} onSelect={setSel} readOnly={!canEdit} />
            <div className="card">
              <div className="card__head">
                <h2>Zones on this camera</h2>
              </div>
              <div className="card__body stack">
                {cam.zones.length === 0 && <p className="meta">No zones yet. Pick “Draw an area” or “Draw a line”, then click on the picture.</p>}
                {cam.zones.map((z) => (
                  <div key={z.id} className={`zonerow${z.id === sel ? ' is-sel' : ''}`} onClick={() => setSel(z.id)}>
                    <span className="zonerow__swatch" style={{ background: ZONE_COLORS[z.purpose] }} />
                    <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                      <input className="input input--sm" aria-label="Zone name" value={z.name} onChange={(e) => set({ zones: cam.zones.map((x) => (x.id === z.id ? { ...x, name: e.target.value } : x)) })} />
                      <Choice
                        small
                        label="What the zone is"
                        value={z.purpose}
                        onChange={(purpose) => set({ zones: cam.zones.map((x) => (x.id === z.id ? { ...x, purpose } : x)) })}
                        options={
                          z.kind === 'line'
                            ? (['line', 'deck-edge'] as ZonePurpose[]).map((p) => ({ value: p, label: PURPOSE_LABEL[p] }))
                            : [
                                ...(['restricted', 'exclusion', 'walkway', 'work-area', 'vehicle-lane'] as ZonePurpose[]).map((p) => ({ value: p, label: PURPOSE_LABEL[p], group: 'People and vehicles' })),
                                ...FIRE_PURPOSES.map((p) => ({ value: p, label: PURPOSE_LABEL[p], group: 'Fire and smoke' })),
                              ]
                        }
                      />
                      <span className="meta">
                        {z.kind === 'line' ? 'Line' : `Area · ${z.points.length} corners`}
                        {usedBy(z.id).length > 0 && ` · used by ${usedBy(z.id).join(', ')}`}
                      </span>
                    </div>
                  </div>
                ))}
                {selZone && <p className="meta">Selected: {selZone.name}. Drag its corners on the picture to adjust.</p>}
              </div>
            </div>
          </div>
        )}

        {step === 'walls' && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card__head">
              <h2>Apply rules</h2>
              <span className="meta">Tick the rules that should watch this camera, or make a new rule.</span>
              <span className="spacer" />
              {canEdit && (
                <button type="button" className="qact__btn" onClick={() => setNewRule(true)}>
                  <Icon name="add-circle" size={20} />
                  New rule
                </button>
              )}
            </div>
            <table className="table camsetup__table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Criticality</th>
                  <th>On this camera</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="meta">
                        <span className="mono">{r.id}</span> · {r.cameraIds.filter((id) => id !== cam.id).length} other cameras
                      </div>
                    </td>
                    <td>{r.priority}</td>
                    <td>
                      <div className="row-wrap">
                        {ruleOn(r.id) ? (
                          <span className="chip chip--good">
                            <Icon name="check" size={13} />
                            {zonesForKind(r).length === 0 || zonesFor(r).length === 0 ? 'Whole view' : zoneNamesOf(zonesFor(r)).join(', ')}
                          </span>
                        ) : (
                          <span className="meta">Not on this camera</span>
                        )}
                        {canEdit && (
                          <button type="button" className="btn btn--secondary btn--sm" onClick={() => openRule(r)}>
                            {ruleOn(r.id) ? 'Change zones' : 'Apply'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {panelRule && cam && (() => {
          const r = rules.find((x) => x.id === panelRule);
          if (!r) return null;
          const usable = zonesForKind(r);
          const fire = r.condition === 'smoke';
          const elsewhere = r.zoneIds.some((id) => !cam.zones.some((z) => z.id === id));
          return (
            <Drawer
              title={r.name}
              sub={`${r.id} · ${r.priority} ${PRIORITY_NAME[r.priority]} · ${r.mode === 'live' ? 'Live' : 'Test only'}`}
              onClose={() => setPanelRule(undefined)}
              footer={
                <>
                  <button type="button" className="btn btn--secondary" onClick={() => setPanelRule(undefined)}>
                    Cancel
                  </button>
                  {ruleOn(r.id) && (
                    <button type="button" className="btn btn--secondary" onClick={() => applyRule(false)}>
                      Remove from {cam.id}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => applyRule(true)}>
                    {ruleOn(r.id) ? 'Save zones' : `Apply to ${cam.id}`}
                  </button>
                </>
              }
            >
              <p style={{ marginTop: 0 }}>{describeRule(r, zoneNamesOf(panelZones))}.</p>
              <div className="field">
                <span className="field__label">{fire ? 'Watch areas' : 'Zones'} on {cam.id}</span>
                {usable.length === 0 ? (
                  <span className="meta">
                    {fire ? 'No fire and smoke watch area is drawn on this camera, so the rule watches the whole view.' : 'No zone is drawn on this camera, so the rule watches the whole view. Go back to Draw zones to add one.'}
                  </span>
                ) : (
                  <div className="row-wrap">
                    {usable.map((z) => {
                      const on = panelZones.includes(z.id);
                      return (
                        <button key={z.id} type="button" className="chip chip--outline" aria-pressed={on} onClick={() => setPanelZones(on ? panelZones.filter((id) => id !== z.id) : [...panelZones, z.id])}>
                          {on && <Icon name="check" size={13} />}
                          {z.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {usable.length > 0 && panelZones.length === 0 && (
                  <span className="field__hint">{elsewhere ? 'None picked: the rule has zones on other cameras, so it would not watch this one.' : 'None picked: the rule watches the whole view.'}</span>
                )}
                <span className="field__hint">To change anything else about the rule, open it on the Rules page.</span>
              </div>
            </Drawer>
          );
        })()}
        {newRule && cam && (
          <NewRulePanel
            forCamera={cam.id}
            onCreated={(r) => choose({ rule: [r.id, true] })}
            onClose={() => setNewRule(false)}
          />
        )}
        {step === 'walls' && (
          <div className="card">
            <div className="card__head">
              <h2>Where this camera shows</h2>
              <span className="meta">Pinned cameras stay on screen; the others take turns in the rolling section.</span>
            </div>
            <table className="table camsetup__table">
              <thead>
                <tr>
                  <th>Wall</th>
                  <th>Team</th>
                  <th>On this wall</th>
                </tr>
              </thead>
              <tbody>
                {walls.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <strong>{w.name}</strong>
                    </td>
                    <td className="muted">{w.teamId === 't-quay' ? 'Quay and marine' : w.teamId === 't-yard' ? 'Yard and gate' : 'HSE control room'}</td>
                    <td>
                      <div className="seg seg--sm" role="group" aria-label={`On ${w.name}`}>
                        {(['off', 'rolls', 'pinned'] as const).map((v) => (
                          <button key={v} type="button" aria-pressed={wallMode(w.id) === v} onClick={() => choose({ wall: [w.id, v] })} disabled={v === 'pinned' && w.pinnedShare === 0}>
                            {v === 'off' ? 'Not shown' : v === 'rolls' ? 'Rolls' : 'Pinned'}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>

      <div className="gcs__foot">
        <span className={`gcs__saved${notAdded ? '' : dirty ? ' is-dirty' : ' is-clean'}`} aria-live="polite">
          <i aria-hidden="true" />
          {notAdded ? 'Not added yet: nothing is saved until you click Add camera' : dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <span className="spacer" />
        {notAdded && test !== 'ok' && <span className="gcs__why">Connect the camera to continue</span>}
        {notAdded && test === 'ok' && !cam.name.trim() && <span className="gcs__why">Give it a location name</span>}
        <button type="button" className="gbtn" onClick={leave}>
          {dirty ? 'Cancel' : 'Close'}
        </button>
        {step !== 'connect' && (
          <button type="button" className="gbtn" onClick={() => goTo(step === 'walls' ? 'zones' : 'connect')}>
            Back
          </button>
        )}
        {step !== 'walls' && !notAdded && (
          <button type="button" className="gbtn" onClick={() => goTo(step === 'connect' ? 'zones' : 'walls')} disabled={test !== 'ok'}>
            Next: {step === 'connect' ? 'draw zones' : 'rules and walls'}
            <Icon name="arrow-right" size={15} />
          </button>
        )}
        {notAdded && canEdit && (
          // A new camera is first connected; Add camera saves it and goes on to drawing its zones.
          <button type="button" className="gbtn gbtn--primary" onClick={addCamera} disabled={test !== 'ok' || !cam.name.trim()}>
            Add camera
          </button>
        )}
        {!notAdded && canEdit && (
          <button type="button" className="gbtn gbtn--primary" onClick={() => (cam.zones.length === 0 && !noZoneOk ? setNoZoneAsk('save') : save())} disabled={test !== 'ok' || !cam.name.trim()} title="Save the camera, its zones, rules and walls">
            Save camera
          </button>
        )}
        {noZoneAsk && (
          <Modal
            title="No zones yet"
            onClose={() => setNoZoneAsk(false)}
            footer={
              <>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => {
                    const was = noZoneAsk;
                    setNoZoneAsk(false);
                    setNoZoneOk(true);
                    if (was === 'save') save();
                    else {
                      storeCamera();
                      setStep('walls');
                    }
                  }}
                >
                  {noZoneAsk === 'save' ? 'Save without zones' : 'Continue without zones'}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  autoFocus
                  onClick={() => {
                    setNoZoneAsk(false);
                    setStep('zones');
                  }}
                >
                  Draw a zone
                </button>
              </>
            }
          >
            <p style={{ margin: 0 }}>Without a zone, rules on {cam.name || cam.id} watch the whole picture and raise more false alarms.</p>
          </Modal>
        )}
      </div>
    </div>
  );
}

function blank(cams: Camera[]): Camera {
  const n = cams.filter((c) => c.areaId === 'deck').length + 1;
  return {
    id: nextCameraId('DCK', cams),
    name: '',
    areaId: 'deck',
    scene: 'deck',
    variant: (n * 3) % 8,
    status: 'online',
    stream: '',
    make: MAKES[0],
    resolution: '2560 × 1440',
    fps: 20,
    zones: [],
    addedAt: Date.now(),
    addedBy: '',
  };
}
