/* Autocut UI — talks to the local autocut server (127.0.0.1). */
"use strict";

const qs = new URLSearchParams(location.search);
function tokStore(v) { try { if (v) localStorage.setItem("autocut-token", v); return localStorage.getItem("autocut-token"); } catch (e) { return null; } }
let TOKEN = qs.get("t") || sessionStorage.getItem("autocut-token") || tokStore() || "";
if (qs.get("t")) {
  sessionStorage.setItem("autocut-token", TOKEN);
  tokStore(TOKEN);  // the token is stable: a Dock web app / bookmark without it keeps working
  qs.delete("t");
  history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : ""));
}
const IN_PREMIERE = qs.get("host") === "premiere" && window.parent !== window;

const $ = (id) => document.getElementById(id);
const S = { project: null, path: "", jobKind: null, running: false };

// ---------------------------------------------------------------- helpers
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, body) {
  const opt = { headers: { "X-Autocut-Token": TOKEN } };
  if (body !== undefined) {
    opt.method = "POST";
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("انتهت الجلسة — أعد فتح Autocut");
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60;
  return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
}
function fmtOffset(s) {
  const v = Number(s), sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return sign + fmtDur(Math.floor(a)) + "." + String(Math.round((a % 1) * 1000)).padStart(3, "0");
}
const camLabel = (c) => (c === "long" ? "الواسعة" : c);
function flash(el, text) { el.textContent = text; setTimeout(() => (el.textContent = ""), 2500); }
function show(el, on) { el.classList.toggle("hidden", !on); }

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
function recall(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) ?? dflt; } catch (e) { return dflt; } }

// ---------------------------------------------------------------- models
async function refreshModels() {
  try {
    const p = await api("/api/ping");
    const m = p.models;
    const b = $("modelsBadge");
    b.className = "badge " + (m.ready ? "ok" : "warn");
    b.textContent = m.ready ? "النموذج جاهز ✓" : "النموذج غير مثبت";
    $("mdlStatus").textContent = m.ready
      ? `مثبت (${m.size_mb} MB) — يعمل بدون إنترنت.`
      : "غير مثبت على هذا الجهاز. استورده من زميل أو حمّله مرة واحدة.";
    $("btnExport").disabled = !m.ready;
    return m.ready;
  } catch (e) {
    $("modelsBadge").textContent = "غير متصل";
    return false;
  }
}

// ---------------------------------------------------------------- project
function renderRecent() {
  const box = $("recent");
  box.replaceChildren();
  const recent = recall("autocut-recent", []).slice(0, 6);
  if (recent.length) box.append(h("span", { class: "muted" }, "آخر المجلدات:"));
  for (const p of recent) {
    box.append(h("span", { class: "chip" },
      h("button", { type: "button", dir: "ltr", title: p, onclick: () => loadProject(p) },
        p.split("/").filter(Boolean).pop()),
      h("button", { type: "button", class: "x", title: "إزالة من القائمة", onclick: () => {
        store("autocut-recent", recall("autocut-recent", []).filter((x) => x !== p));
        renderRecent();
      } }, "×")));
  }
}

async function loadProject(path) {
  path = (path || "").trim();
  if (!path) return;
  $("projPath").value = path;
  S.path = path;
  let st;
  try {
    st = await api("/api/project?path=" + encodeURIComponent(path));
  } catch (e) {
    return showScanError(e.message);
  }
  if (!st.exists) return showScanError("المجلد غير موجود");
  S.project = st;
  show($("btnClose"), true);
  store("autocut-last-closed", false);
  const rec = [st.path, ...recall("autocut-recent", []).filter((p) => p !== st.path)];
  store("autocut-recent", rec.slice(0, 8));
  renderRecent();
  renderScan();
  renderSettings();
  renderSync();
  renderSpeakers();
  renderOutputs();
}

function showScanError(msg) {
  show($("scanBox"), true);
  $("scanSummary").replaceChildren();
  $("scanError").textContent = msg;
  show($("scanError"), true);
}

function renderScan() {
  const st = S.project;
  show($("scanBox"), true);
  const err = st.audio_error ? null : (st.scan_error || st.config_error);
  $("scanError").textContent = err ? "تنبيه: " + err : "";
  show($("scanError"), !!err);
  const box = $("scanSummary");
  box.replaceChildren();
  const ok = !!st.scan;
  ["secSettings", "secAnalyze", "secSpeakers", "secCut"].forEach((id) => show($(id), false));
  show($("secSettings"), (st.folders || []).length > 0);
  if (!ok) return;
  show($("secAnalyze"), true);
  const seqFps = Number(st.scan.fps);
  for (const cam of st.scan.cameras) {
    const dur = cam.clips.reduce((a, c) => a + c.duration, 0);
    const warns = [];
    if (cam.clips.some((c) => c.fps && Math.abs(c.fps - seqFps) > 0.01)) warns.push("fps مختلف");
    if (cam.clips.some((c) => !c.audio)) warns.push("ملف بدون صوت");
    box.append(h("div", { class: "cam" + (cam.name === st.config.long_camera ? " long" : "") },
      h("b", {}, cam.name),
      h("span", { class: "muted" }, `${cam.clips.length} ملف · ${fmtDur(dur)}`),
      warns.length ? h("div", { class: "warn" }, "⚠ " + warns.join("، ")) : null));
  }
  const aud = st.scan.audio;
  const nt = st.scan.takes || 1;
  const audTotal = nt > 1 ? aud.reduce((x, a) => x + a.duration, 0) : Math.max(0, ...aud.map((a) => a.duration));
  box.append(h("div", { class: "cam" },
    h("b", {}, "الصوت النظيف"),
    h("span", { class: "muted" }, nt > 1 ? `${nt} تيك متتالية · ${fmtDur(audTotal)}` : `${aud.length} ملف · ${fmtDur(audTotal)}`),
    h("div", { class: "muted" }, `${st.scan.fps} fps`)));
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const st = S.project, cfg = st.config;
  $("cfgAudio").value = st.audio_dir || "";
  $("audioError").textContent = st.audio_error_ar || "";
  show($("audioError"), !!st.audio_error);
  const af = st.audio_files || [];
  $("audioInfo").textContent = af.length
    ? `${af.length} ملف صوت: ${af.slice(0, 4).join("، ")}${af.length > 4 ? "…" : ""}` : "";
  const cams = st.cameras || (st.scan ? st.scan.cameras.map((c) => c.name) : []);
  $("longHint").textContent = st.long_camera_reset
    ? `«${st.long_camera_reset}» ليس كاميرا — اختر الكاميرا الواسعة ثم احفظ`
    : st.long_camera_guessed ? "اختيار تلقائي — تأكد منه ثم احفظ" : "";
  const sel = $("cfgLong");
  sel.replaceChildren(...cams.map((c) => h("option", { value: c, selected: c === cfg.long_camera }, c)));
  $("cfgSpeakers").value = cfg.diarization.num_speakers ?? "";
  $("cfgMinShot").value = cfg.cut.min_shot;
  $("cfgOverlap").value = cfg.cut.overlap_min;
  $("cfgMinSeg").value = cfg.cut.min_segment;
  $("cfgLead").value = cfg.cut.cut_lead;
  $("cfgRotMin").value = cfg.cut.rotate_min_shot;
  $("cfgRotMax").value = cfg.cut.rotate_max_shot;
}

function readSettings(cfg) {
  cfg.long_camera = $("cfgLong").value || cfg.long_camera;
  const n = parseInt($("cfgSpeakers").value, 10);
  cfg.diarization.num_speakers = Number.isFinite(n) && n > 0 ? n : null;
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
  cfg.cut.min_shot = num("cfgMinShot", cfg.cut.min_shot);
  cfg.cut.overlap_min = num("cfgOverlap", cfg.cut.overlap_min);
  cfg.cut.min_segment = num("cfgMinSeg", cfg.cut.min_segment);
  cfg.cut.cut_lead = num("cfgLead", cfg.cut.cut_lead);
  cfg.cut.rotate_min_shot = num("cfgRotMin", cfg.cut.rotate_min_shot);
  cfg.cut.rotate_max_shot = Math.max(num("cfgRotMax", cfg.cut.rotate_max_shot), cfg.cut.rotate_min_shot + 1);
  return cfg;
}

async function saveConfig(mutate) {
  const cfg = JSON.parse(JSON.stringify(S.project.config));
  readSettings(cfg);
  if (mutate) mutate(cfg);
  await api("/api/config", { path: S.project.path, config: cfg });
  S.project.config = cfg;
}

// ---------------------------------------------------------------- sync
function renderSync() {
  const rows = S.project.sync;
  show($("syncBox"), !!rows);
  if (!rows) return;
  const overrides = S.project.config.sync.overrides || {};
  const t = $("syncTable");
  t.replaceChildren(h("tr", {},
    ["الملف", "يبدأ عند", "انحراف الساعة", "الثقة", "الحالة", "تصحيح يدوي (ث)"].map((x) => h("th", {}, x))));
  for (const r of rows) {
    const low = r.status === "LOW";
    const conf = Number(r.confidence);
    const color = conf >= 0.8 ? "var(--ok)" : conf >= 0.5 ? "var(--warn)" : "var(--bad)";
    const ov = h("input", { class: "override ltr", type: "number", step: "0.001",
      placeholder: low ? "مطلوب" : "", value: overrides[r.clip] ?? "" });
    ov.dataset.clip = r.clip;
    const drift = r.drift_ppm_measured ? `${Math.round(r.drift_ppm_measured)} ppm` + (Number(r.drift_ppm_applied) ? " (صُحّح)" : "") : "—";
    t.append(h("tr", { class: low ? "low" : "", title: r.notes || "" },
      h("td", { class: "ltr" }, r.clip),
      h("td", { class: "num-cell" }, r.method === "failed" ? "—" : fmtOffset(r.offset_s)),
      h("td", { class: "num-cell" }, drift),
      h("td", {}, h("span", { class: "conf" }, h("i", { style: `width:${Math.round(conf * 100)}%;background:${color}` }))),
      h("td", {}, r.method === "override" ? h("span", { class: "pill ok" }, "يدوي")
        : low ? h("span", { class: "pill bad" }, "ضعيفة") : h("span", { class: "pill ok" }, "ممتازة")),
      h("td", {}, ov)));
  }
  const anyLow = rows.some((r) => r.status === "LOW");
  if (anyLow || Object.keys(overrides).length) {
    t.append(h("tr", {}, h("td", { colspan: 6 },
      h("div", { class: "row end" },
        h("span", { class: "muted" }, "اكتب الثانية في الصوت النظيف التي يبدأ عندها أول إطار من الملف"),
        h("button", { type: "button", onclick: saveOverrides }, "حفظ التصحيحات")))));
  }
}

async function saveOverrides() {
  const ov = {};
  document.querySelectorAll("input.override").forEach((i) => {
    const v = parseFloat(i.value);
    if (Number.isFinite(v)) ov[i.dataset.clip] = v;
  });
  await saveConfig((cfg) => { cfg.sync.overrides = ov; });
  await loadProject(S.path);
}

// ---------------------------------------------------------------- speakers
let player = null, playingBtn = null;
function play(file, btn) {
  const same = playingBtn === btn;
  if (player) { player.pause(); player = null; }
  if (playingBtn) { playingBtn.classList.remove("playing"); playingBtn = null; }
  if (same) return;  // second click stops
  player = new Audio(`/api/sample?path=${encodeURIComponent(S.project.path)}&file=${encodeURIComponent(file)}&t=${encodeURIComponent(TOKEN)}`);
  playingBtn = btn;
  btn.classList.add("playing");
  player.onended = () => { btn.classList.remove("playing"); if (playingBtn === btn) playingBtn = null; };
  player.play();
}

function renderSpeakers() {
  const sp = S.project.speakers;
  show($("secSpeakers"), !!sp);
  show($("secCut"), !!sp);
  if (!sp) return;
  const cfg = S.project.config;
  const mapping = cfg.speakers || {};
  const cams = (S.project.cameras || sp.cameras.filter((c) => c !== "long"));
  const needing = Object.values(sp.speakers).filter((i) => i.needs_mapping).length;
  const t = $("spkTable");
  t.replaceChildren(h("tr", {}, ["المتحدث", "مدة الكلام", "عيّنات", "الكاميرات"].map((x) => h("th", {}, x))));
  for (const [label, info] of Object.entries(sp.speakers)) {
    let chosen = mapping[label];
    chosen = chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
    chosen = chosen.map((c) => (c === "long" ? cfg.long_camera : c));
    if (!chosen.length && needing === 1 && info.needs_mapping) chosen = cams.slice();  // one presenter: all angles
    const box = h("div", { class: "camchips" }, cams.map((c) =>
      h("label", { class: "chip-toggle" },
        h("input", { type: "checkbox", value: c, checked: chosen.includes(c) }),
        h("span", {}, c))));
    box.dataset.label = label;
    t.append(h("tr", {},
      h("td", { class: "ltr" }, label),
      h("td", { class: "num-cell" }, fmtDur(info.total_seconds)),
      h("td", {}, info.samples.map((s, i) => s.wav
        ? h("button", { type: "button", class: "small", title: s.hhmmss,
            onclick: (e) => play(s.wav.split("/").pop(), e.currentTarget) }, "▶ " + (i + 1))
        : null)),
      h("td", {}, box)));
  }
  t.append(h("tr", {}, h("td", { colspan: 4, class: "muted" },
    "كاميرا واحدة = القطع عليها كلما تكلّم. أكثر من كاميرا = تنويع بينها عند الوقفات بين الجمل (مناسب للمذيع الواحد).")));
}

async function saveSpeakers() {
  if (!S.project || !S.project.speakers) return;  // table not shown: keep the saved mapping
  const map = {};
  document.querySelectorAll("#spkTable .camchips").forEach((box) => {
    const picked = [...box.querySelectorAll("input:checked")].map((i) => i.value);
    if (picked.length) map[box.dataset.label] = picked.length === 1 ? picked[0] : picked;
  });
  await saveConfig((cfg) => { cfg.speakers = map; });
  flash($("spkSaved"), "تم الحفظ ✓");
}

// ---------------------------------------------------------------- outputs
function renderOutputs() {
  const box = $("outputs");
  box.replaceChildren();
  const outs = (S.project.outputs || []).filter((o) => o.name.endsWith(".xml") || o.name.startsWith("cuts"));
  if (!outs.length) return;
  box.append(h("h3", {}, "الملفات الناتجة"));
  for (const o of outs) {
    const isXml = o.name.endsWith(".xml");
    box.append(h("div", { class: "outfile" },
      h("span", { class: "name ltr" }, o.name),
      h("span", { class: "muted" }, new Date(o.mtime * 1000).toLocaleString("ar")),
      isXml && IN_PREMIERE ? h("button", { type: "button", class: "primary", onclick: () => importToPremiere(o.path) }, "استيراد في بريمير") : null,
      h("button", { type: "button", onclick: () => api("/api/reveal", { path: o.path }) }, "إظهار في Finder"),
      !isXml ? h("button", { type: "button", onclick: () => api("/api/reveal", { path: o.path, open: true }) }, "فتح") : null));
  }
  if (!IN_PREMIERE) {
    box.append(h("p", { class: "muted" }, "في بريمير: File ← Import ثم اختر ملف XML. أو استخدم لوحة Autocut داخل بريمير للاستيراد بضغطة."));
  }
}

function importToPremiere(path) {
  window.parent.postMessage({ type: "autocut-import", path }, "*");
}

// folder/file dialogs: Premiere's own dialog inside the panel, macOS dialog in the app
let chooseSeq = 0;
const chooseWaiters = {};
function choose(kind, prompt) {
  if (!IN_PREMIERE) return api("/api/choose", { kind, prompt }).then((r) => r.path);
  const id = ++chooseSeq;
  window.parent.postMessage({ type: "autocut-choose", id, kind, prompt }, "*");
  return new Promise((resolve) => { chooseWaiters[id] = resolve; });
}
window.addEventListener("message", (ev) => {
  if (ev.source !== window.parent || !ev.data || ev.data.type !== "autocut-choose-result") return;
  const w = chooseWaiters[ev.data.id];
  delete chooseWaiters[ev.data.id];
  if (w) w(ev.data.path || null);
});
window.addEventListener("message", (ev) => {
  if (ev.source !== window.parent || !ev.data || ev.data.type !== "autocut-import-result") return;
  jobMessage(ev.data.ok ? "ok" : "error", ev.data.ok ? "تم الاستيراد في بريمير ✓" : "تعذّر الاستيراد: " + ev.data.message);
});

// ---------------------------------------------------------------- jobs
const TITLES = {
  diarize: "التحليل (مزامنة + متحدثين)", run: "القطع", "models-download": "تحميل النموذج",
  "models-import": "استيراد النموذج", "models-export": "تصدير النموذج",
};

function jobMessage(kind, text) {
  const m = $("jobMsg");
  m.className = "alert " + kind;
  m.textContent = text;
  if (!S.running) {  // a message outside a job: no spinner, no cancel
    $("jobSpin").classList.add("stop");
    show($("btnCancel"), false);
    show($("btnCloseJob"), true);
  }
  show($("jobBar"), true);
}

function appendLog(lines) {
  const log = $("log");
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  for (const line of lines) {
    const lvl = (line.match(/^(DEBUG|INFO|WARNING|ERROR)\b/) || [])[1] || "";
    log.append(h("div", { class: lvl }, line));
  }
  if (atEnd) log.scrollTop = log.scrollHeight;
}

async function startJob(body) {
  try {
    await api("/api/run", body);
  } catch (e) {
    jobMessage("error", e.message);
    return false;
  }
  S.jobKind = body.kind;
  $("log").replaceChildren();
  show($("jobMsg"), false);
  show($("jobBar"), true);
  show($("btnCancel"), true);
  show($("btnCloseJob"), false);
  $("jobSpin").classList.remove("stop");
  $("jobTitle").textContent = TITLES[body.kind] || body.kind;
  S.running = true;
  setBusy(true);
  pollJob(0);
  return true;
}

async function pollJob(since) {
  let j;
  try {
    j = await api("/api/job?since=" + since);
  } catch (e) {
    return setTimeout(() => pollJob(since), 2000);
  }
  appendLog(j.lines || []);
  $("jobTime").textContent = fmtDur(j.elapsed);
  if (j.running) return setTimeout(() => pollJob(j.total), 700);
  finishJob(j.exit_code);
}

async function finishJob(code) {
  S.running = false;
  $("jobSpin").classList.add("stop");
  show($("btnCancel"), false);
  try {
    await reportJob(code);
  } finally {
    setBusy(false);
    show($("btnCloseJob"), true);
  }
}

async function reportJob(code) {
  const kind = S.jobKind;
  if (kind && kind.startsWith("models")) {
    await refreshModels();
    jobMessage(code === 0 ? "ok" : "error", code === 0 ? "تم ✓" : "لم يكتمل — راجع السجل");
    if (code !== 0) show($("log"), true);
    return;
  }
  if (S.path) await loadProject(S.path);
  const msgs = {
    0: ["ok", kind === "run" ? "تم! الملفات جاهزة في الخطوة ٥." : "تم التحليل ✓ — راجع المزامنة واختر كاميرا كل متحدث."],
    2: ["warn", "اختر كاميرا لكل متحدث في الخطوة ٤ ثم احفظ، وبعدها اضغط تجربة."],
    3: ["warn", "بعض الملفات مزامنتها ضعيفة (بالأحمر في الخطوة ٣). اكتب لها تصحيحاً يدوياً، أو فعّل «تابع رغم…» في الخطوة ٥."],
    130: ["warn", "تم الإيقاف."],
    [-15]: ["warn", "تم الإيقاف."],
  };
  let [k, text] = msgs[code] || ["error", "حدث خطأ — افتح السجل لمعرفة السبب."];
  const low = (S.project && S.project.sync || []).filter((r) => r.status === "LOW").map((r) => r.clip);
  if (code === 0 && kind === "run" && low.length) {
    k = "warn";
    text += `\n⚠ ${low.length} ملف مزامنته ضعيفة لم يدخل القطع (والقطع رجع للكاميرا الواسعة مكانه): `
      + low.slice(0, 6).join("، ") + (low.length > 6 ? "…" : "") + " — راجع جدول المزامنة في الخطوة ٣.";
  }
  jobMessage(k, text);
  if (k === "error") show($("log"), true);
  if (code === 0 && kind === "run") $("outputs").scrollIntoView({ behavior: "smooth", block: "center" });
  if (code === 2 || (code === 0 && kind === "diarize")) $("secSpeakers").scrollIntoView({ behavior: "smooth" });
}

function setBusy(on) {
  ["btnAnalyze", "btnTest", "btnFull", "btnImport", "btnDownload", "btnExport", "btnSaveCfg", "btnSaveSpk"]
    .forEach((id) => ($(id).disabled = on));
}

async function runStage(kind, extra, before) {
  if (!S.project) return;
  setBusy(true);  // lock the buttons at once: no second job while this one is being prepared
  try {
    if (before) await before();
    await saveConfig();
  } catch (e) {
    setBusy(false);
    return jobMessage("error", "الإعدادات: " + e.message);
  }
  // diarization needs the model unless this project was already analysed
  if (!(await refreshModels()) && !S.project.speakers) {
    setBusy(false);
    $("modelsDlg").showModal();
    return;
  }
  const ok = await startJob({ kind, path: S.project.path, ...extra });
  if (!ok) setBusy(false);
}

// ---------------------------------------------------------------- wiring
$("btnChoose").onclick = async () => {
  try {
    const p = await choose("folder", "اختر مجلد التصوير");
    if (p) loadProject(p);
  } catch (e) {
    showScanError(e.message);
  }
};
$("btnLoad").onclick = () => loadProject($("projPath").value);

function closeProject() {
  S.project = null;
  S.path = "";
  $("projPath").value = "";
  show($("scanBox"), false);
  show($("btnClose"), false);
  ["secSettings", "secAnalyze", "secSpeakers", "secCut"].forEach((id) => show($(id), false));
  store("autocut-last-closed", true);
}
$("btnClose").onclick = closeProject;

let resetArmed = null;
$("btnResetCfg").onclick = async () => {
  const b = $("btnResetCfg");
  if (!resetArmed) {  // first click arms, second click (within 4 s) resets
    b.textContent = "متأكد؟ اضغط مرة ثانية";
    resetArmed = setTimeout(() => { b.textContent = "إعادة الضبط"; resetArmed = null; }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  b.textContent = "إعادة الضبط";
  try { await api("/api/config/reset", { path: S.project.path }); await loadProject(S.path); flash($("cfgSaved"), "رجعت الإعدادات الافتراضية ✓"); }
  catch (e) { flash($("cfgSaved"), "خطأ: " + e.message); }
};
$("projPath").addEventListener("keydown", (e) => { if (e.key === "Enter") loadProject(e.target.value); });
$("btnSaveCfg").onclick = async () => {
  try { await saveConfig(); flash($("cfgSaved"), "تم الحفظ ✓"); await loadProject(S.path); }
  catch (e) { flash($("cfgSaved"), "خطأ: " + e.message); }
};
$("btnAudio").onclick = async () => {
  const p = await choose("folder", "اختر مجلد الصوت النظيف");
  if (!p) return;
  try { await saveConfig((cfg) => { cfg.audio_folder = p; }); await loadProject(S.path); }
  catch (e) { flash($("cfgSaved"), "خطأ: " + e.message); }
};
$("btnSaveSpk").onclick = () => saveSpeakers().catch((e) => flash($("spkSaved"), "خطأ: " + e.message));
$("btnAnalyze").onclick = () => runStage("diarize", { diarize_full: true });
$("btnTest").onclick = () => runStage("run", {
  start: $("testStart").value.trim(), duration: $("testDur").value.trim(), allow_low: $("allowLow").checked }, saveSpeakers);
$("btnFull").onclick = () => runStage("run", { allow_low: $("allowLow").checked }, saveSpeakers);
$("btnCancel").onclick = () => api("/api/job/cancel", {});
$("btnLog").onclick = () => show($("log"), $("log").classList.contains("hidden"));
$("btnCloseJob").onclick = () => show($("jobBar"), false);

$("modelsBadge").onclick = () => { refreshModels(); $("modelsDlg").showModal(); };
$("btnImport").onclick = async () => {
  const p = await choose("file", "اختر autocut-models.zip");
  if (p) { $("modelsDlg").close(); startJob({ kind: "models-import", zip: p }); }
};
$("btnExport").onclick = async () => {
  const p = await choose("folder", "أين تحفظ autocut-models.zip؟");
  if (p) { $("modelsDlg").close(); startJob({ kind: "models-export", dest: p }); }
};
$("btnDownload").onclick = () => {
  const token = $("hfToken").value.trim();
  if (!token.startsWith("hf_")) { $("hfToken").focus(); return; }
  $("hfToken").value = "";
  $("modelsDlg").close();
  startJob({ kind: "models-download", token });
};

// keep the app alive while this page is open
setInterval(() => api("/api/heartbeat", {}).catch(() => {}), 60000);

(async function init() {
  renderRecent();
  await refreshModels();
  // resume a running job after a reload
  try {
    const j = await api("/api/job?since=0");
    if (j.running) {
      S.jobKind = j.kind;
      S.running = true;
      show($("jobBar"), true);
      $("jobTitle").textContent = TITLES[j.kind] || j.kind;
      setBusy(true);
      pollJob(0);
      if (j.project) loadProject(j.project);
    }
  } catch (e) { /* not running */ }
  const last = recall("autocut-recent", [])[0];
  if (last && !S.path && !recall("autocut-last-closed", false)) loadProject(last);
})();
