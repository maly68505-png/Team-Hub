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
// inside Autocut.app (native window): folder / file pickers come from the app
const APP_BRIDGE = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.autocut;

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
  if (r.status === 401) throw new Error(L("انتهت الجلسة — أعد فتح Autocut", "Session expired — reopen Autocut"));
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
const camLabel = (c) => (c === "long" ? L("الواسعة", "wide") : c);
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
    b.textContent = m.ready ? L("النموذج جاهز ✓", "Model ready ✓") : L("النموذج غير مثبت", "Model not installed");
    $("mdlStatus").textContent = m.ready
      ? L(`مثبت (${m.size_mb} MB) — يعمل بدون إنترنت.`, `Installed (${m.size_mb} MB) — works offline.`)
      : L("غير مثبت على هذا الجهاز. استورده من زميل أو حمّله مرة واحدة.",
          "Not installed on this Mac. Import it from a colleague or download it once.");
    $("btnExport").disabled = !m.ready;
    return m.ready;
  } catch (e) {
    $("modelsBadge").textContent = L("غير متصل", "Not connected");
    return false;
  }
}

// ---------------------------------------------------------------- project
function renderRecent() {
  const box = $("recent");
  box.replaceChildren();
  const recent = recall("autocut-recent", []).slice(0, 6);
  if (recent.length) box.append(h("span", { class: "muted" }, L("آخر المجلدات:", "Recent:")));
  for (const p of recent) {
    box.append(h("span", { class: "chip" },
      h("button", { type: "button", dir: "ltr", title: p, onclick: () => loadProject(p) },
        p.split("/").filter(Boolean).pop()),
      h("button", { type: "button", class: "x", title: L("إزالة من القائمة", "Remove from list"), onclick: () => {
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
  if (!st.exists) return showScanError(L("المجلد أو الملف غير موجود", "Folder or file not found"));
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

const isXml = () => !!(S.project && S.project.mode === "xml");

function renderXmlScan() {
  const st = S.project, x = st.xml;
  const err = st.xml_error ? (EN() ? st.xml_error : st.xml_error_ar || st.xml_error)
    : st.config_error || (st.xml_missing ? L("ملفات الصوت غير موجودة (الهارد غير موصّل؟): ", "Audio files not found (drive not connected?): ")
      + st.xml_missing.join(", ") : null);
  $("scanError").textContent = err ? L("تنبيه: ", "Note: ") + err : "";
  show($("scanError"), !!err);
  const box = $("scanSummary");
  box.replaceChildren();
  ["secSettings", "secAnalyze", "secSpeakers", "secCut"].forEach((id) => show($(id), false));
  if (!x) return;
  show($("secSettings"), true);
  show($("secAnalyze"), true);
  box.append(h("div", { class: "cam" }, h("b", { class: "ltr" }, x.name),
    h("span", { class: "muted" }, L(`تسلسل متزامن · ${fmtDur(x.duration)}`, `Synced sequence · ${fmtDur(x.duration)}`)),
    h("div", { class: "muted" }, `${x.fps} fps`)));
  for (const c of x.cameras) {
    box.append(h("div", { class: "cam" + (c.name === st.config.long_camera ? " long" : "") },
      h("b", {}, c.name),
      h("span", { class: "muted" }, L(`V${c.track} · ${c.clips} مقطع · ${fmtDur(c.covered)}`, `V${c.track} · ${c.clips} clip(s) · ${fmtDur(c.covered)}`))));
  }
  box.append(h("div", { class: "cam" },
    h("b", {}, L("الصوت لتمييز المتحدثين", "Audio for speaker detection")),
    h("span", { class: "muted ltr" }, x.audio.slice(0, 3).join(", ") + (x.audio.length > 3 ? "…" : "")),
    x.audio_clean ? null : h("div", { class: "warn" }, L("⚠ صوت الكاميرات (لا يوجد صوت نظيف منفصل)", "⚠ camera audio (no separate clean audio)"))));
}

function renderScan() {
  const st = S.project;
  show($("scanBox"), true);
  show($("audioBlock"), !isXml());
  show($("xmlNote"), isXml());
  show($("btnSyncOnly"), !isXml());
  if (isXml()) return renderXmlScan();
  const err = st.audio_error ? null : (st.scan_error || st.config_error);
  $("scanError").textContent = err ? L("تنبيه: ", "Note: ") + err : "";
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
    if (cam.clips.some((c) => c.fps && Math.abs(c.fps - seqFps) > 0.01)) warns.push(L("fps مختلف", "different fps"));
    if (cam.clips.some((c) => !c.audio)) warns.push(L("ملف بدون صوت", "file without audio"));
    box.append(h("div", { class: "cam" + (cam.name === st.config.long_camera ? " long" : "") },
      h("b", {}, cam.name),
      h("span", { class: "muted" }, L(`${cam.clips.length} ملف · ${fmtDur(dur)}`, `${cam.clips.length} file(s) · ${fmtDur(dur)}`)),
      warns.length ? h("div", { class: "warn" }, "⚠ " + warns.join(L("، ", ", "))) : null));
  }
  const aud = st.scan.audio;
  const nt = st.scan.takes || 1;
  const audTotal = nt > 1 ? aud.reduce((x, a) => x + a.duration, 0) : Math.max(0, ...aud.map((a) => a.duration));
  box.append(h("div", { class: "cam" },
    h("b", {}, L("الصوت النظيف", "Clean audio")),
    h("span", { class: "muted" }, nt > 1 ? L(`${nt} تيك متتالية · ${fmtDur(audTotal)}`, `${nt} takes in a row · ${fmtDur(audTotal)}`)
      : L(`${aud.length} ملف · ${fmtDur(audTotal)}`, `${aud.length} file(s) · ${fmtDur(audTotal)}`)),
    h("div", { class: "muted" }, `${st.scan.fps} fps`)));
  // a promo or an extracted copy among the takes: duplicate / unrelated audio
  const odd = aud.filter((a) => /promo|extracted|copy|نسخة/i.test(a.name)).map((a) => a.name);
  if (odd.length && aud.length > 1) {
    $("scanError").textContent = L(`تنبيه: في مجلد الصوت النظيف ملفات لا تبدو تسجيلات التصوير: ${odd.join("، ")} — انقلها خارج المجلد (اترك ملفات التيكات فقط، مثل _FIXED)، وإلا تطول المزامنة ويتكرر الصوت.`,
      `Note: the clean audio folder has files that don't look like the shoot's recordings: ${odd.join(", ")} — move them out (keep only the takes, e.g. _FIXED), otherwise sync takes longer and the audio is doubled.`);
    show($("scanError"), true);
  }
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const st = S.project, cfg = st.config;
  $("cfgAudio").value = st.audio_dir || "";
  $("audioError").textContent = (EN() ? st.audio_error : st.audio_error_ar || st.audio_error) || "";
  show($("audioError"), !!st.audio_error);
  const af = st.audio_files || [];
  $("audioInfo").textContent = af.length
    ? L(`${af.length} ملف صوت: ${af.slice(0, 4).join("، ")}`, `${af.length} audio file(s): ${af.slice(0, 4).join(", ")}`)
      + (af.length > 4 ? "…" : "") : "";
  const cams = st.cameras || (st.scan ? st.scan.cameras.map((c) => c.name) : []);
  $("longHint").textContent = st.long_camera_reset
    ? L(`«${st.long_camera_reset}» ليس كاميرا — اختر الكاميرا الواسعة ثم احفظ`,
        `"${st.long_camera_reset}" is not a camera — pick the wide camera, then save`)
    : st.long_camera_guessed ? L("اختيار تلقائي — تأكد منه ثم احفظ", "Picked automatically — check it, then save") : "";
  const sel = $("cfgLong");
  sel.replaceChildren(...cams.map((c) => h("option", { value: c, selected: c === cfg.long_camera }, c)));
  $("cfgSpeakers").value = cfg.diarization.num_speakers ?? "";
  $("cfgMinShot").value = cfg.cut.min_shot;
  $("cfgOverlap").value = cfg.cut.overlap_min;
  $("cfgMinSeg").value = cfg.cut.min_segment;
  $("cfgLead").value = cfg.cut.cut_lead;
  $("cfgRotMin").value = cfg.cut.rotate_min_shot;
  $("cfgNoSilence").checked = !!cfg.cut.remove_silence;
  $("cfgLayered").checked = !!cfg.output.layered;
  $("cfgSilenceMax").value = cfg.cut.silence_max;
  show($("silenceOpts"), !!cfg.cut.remove_silence);
  $("cfgRotMax").value = cfg.cut.rotate_max_shot;
  renderAudioChoices();
  renderCheck();
}

function renderCheck() {
  const box = $("checkBox");
  box.replaceChildren();
  const ac = S.project.audio_check;
  if (!ac) return;
  const blk = ac.block || 300;
  const STATE = { talk: L("كلام", "talking"), quiet: L("هادئ", "quiet"), silent: L("بلا صوت", "no signal"),
    missing: L("لا يُقرأ", "not readable") };
  const hhmm = (s) => { const m = Math.round(s / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
  for (const f of ac.files) {
    const el = h("div", { class: "chk" },
      h("b", { class: "ltr" }, f.name),
      h("span", { class: "meta" }, f.duration != null ? ` · ${fmtDur(f.duration)} · ${f.size_gb} GB` : ""));
    for (const n of f.notes || [])
      el.append(h("div", { class: "alert " + (n.level === "error" ? "error" : "warn") }, EN() ? n.en : n.ar));
    for (const c of f.channels) {
      el.append(h("div", { class: "chk-row" },
        h("span", { class: "lab" }, `ch${c.channel}`),
        h("span", { class: "cells" }, c.blocks.map((b, i) => h("i", { class: b.s,
          title: `${hhmm(i * blk)}–${hhmm((i + 1) * blk)}: ${STATE[b.s]}` + (b.talk != null ? ` · ${b.talk}%` : "") })))));
    }
    box.append(el);
  }
  const ok = ac.files.every((f) => !(f.notes || []).length);
  box.append(h("div", { class: "chk-legend" },
    ...["talk", "quiet", "silent", "missing"].map((k) => h("span", {}, h("i", { class: k, style: `background:var(--${k === "talk" ? "ok" : k === "silent" ? "warn" : k === "missing" ? "bad" : "line"})` }), STATE[k])),
    h("span", {}, L("كل مربع = 5 دقائق", "each square = 5 minutes"))));
  if (ok) box.prepend(h("div", { class: "alert ok" }, L("✓ كل الملفات تُقرأ لآخرها وكل القنوات فيها صوت", "✓ every file reads to the end and every channel has sound")));
}

function renderAudioChoices() {
  const st = S.project, cfg = st.config;
  const nch = isXml() ? (st.xml && st.xml.channels) || 0
    : Math.max(0, ...((st.scan && st.scan.audio) || []).map((a) => a.channels || 0));
  const chan = $("cfgChannel");
  const opts = [h("option", { value: "", selected: !cfg.audio_channel }, L("كل القنوات (دمج)", "All channels (mixed)"))];
  for (let c = 1; c <= Math.max(nch, cfg.audio_channel || 0); c++)
    opts.push(h("option", { value: String(c), selected: cfg.audio_channel === c }, L(`القناة ${c} فقط`, `Channel ${c} only`)));
  chan.replaceChildren(...opts);
  show($("channelBox"), nch > 1 || !!cfg.audio_channel);
  show($("syncMethodBox"), !isXml());
  $("cfgSyncMethod").value = cfg.sync.method || "audio";
  $("cfgSpkMethod").value = cfg.diarization.method || "ai";
  if (st.scan && !isXml()) {
    const clips = st.scan.cameras.flatMap((c) => c.clips);
    const ctc = clips.filter((c) => c.has_tc).length, atc = st.scan.audio.filter((a) => a.has_tc).length;
    $("tcInfo").textContent = L(`تايم كود: الكاميرات ${ctc}/${clips.length} · الصوت ${atc}/${st.scan.audio.length}`,
      `Timecode: cameras ${ctc}/${clips.length} · audio ${atc}/${st.scan.audio.length}`);
  } else $("tcInfo").textContent = "";
  audioInfo();
}

function audioInfo() {
  const st = S.project;
  const nch = isXml() ? (st.xml && st.xml.channels) || 0
    : Math.max(0, ...((st.scan && st.scan.audio) || []).map((a) => a.channels || 0));
  const ch = parseInt($("cfgChannel").value, 10);
  $("spkMethodInfo").textContent = $("cfgSpkMethod").value === "mics"
    ? (nch > 1 ? L(`المايكات: القنوات ${[...Array(nch).keys()].map((i) => i + 1).filter((c) => c !== ch).join("، ")} — بلا نموذج وأسرع`,
        `Mics: channels ${[...Array(nch).keys()].map((i) => i + 1).filter((c) => c !== ch).join(", ")} — no model, faster`)
      : L("⚠ الصوت النظيف قناة واحدة — هذا الخيار يحتاج قناة لكل مايك", "⚠ the clean audio has one channel — this needs one channel per mic"))
    : "";
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
  cfg.cut.remove_silence = $("cfgNoSilence").checked;
  cfg.output.layered = $("cfgLayered").checked;
  cfg.cut.silence_max = Math.max(0.2, num("cfgSilenceMax", cfg.cut.silence_max));
  cfg.cut.rotate_max_shot = Math.max(num("cfgRotMax", cfg.cut.rotate_max_shot), cfg.cut.rotate_min_shot + 1);
  const ch = parseInt($("cfgChannel").value, 10);
  cfg.audio_channel = Number.isFinite(ch) && ch > 0 ? ch : null;
  if (!isXml()) cfg.sync.method = $("cfgSyncMethod").value || "audio";
  cfg.diarization.method = $("cfgSpkMethod").value || "ai";
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
    (EN() ? ["File", "Starts at", "Clock drift", "Confidence", "Status", "Manual fix (s)"]
      : ["الملف", "يبدأ عند", "انحراف الساعة", "الثقة", "الحالة", "تصحيح يدوي (ث)"]).map((x) => h("th", {}, x))));
  for (const r of rows) {
    const low = r.status === "LOW";
    const conf = Number(r.confidence);
    const color = conf >= 0.8 ? "var(--ok)" : conf >= 0.5 ? "var(--warn)" : "var(--bad)";
    const ov = h("input", { class: "override ltr", type: "number", step: "0.001",
      placeholder: low ? L("مطلوب", "needed") : "", value: overrides[r.clip] ?? "" });
    ov.dataset.clip = r.clip;
    const drift = r.drift_ppm_measured ? `${Math.round(r.drift_ppm_measured)} ppm` + (Number(r.drift_ppm_applied) ? L(" (صُحّح)", " (corrected)") : "") : "—";
    t.append(h("tr", { class: low ? "low" : "", title: r.notes || "" },
      h("td", { class: "ltr" }, r.clip),
      h("td", { class: "num-cell" }, r.method === "failed" ? "—" : fmtOffset(r.offset_s)),
      h("td", { class: "num-cell" }, drift),
      h("td", {}, h("span", { class: "conf" }, h("i", { style: `width:${Math.round(conf * 100)}%;background:${color}` }))),
      h("td", {}, r.method === "override" ? h("span", { class: "pill ok" }, L("يدوي", "manual"))
        : r.method === "timecode" && !low ? h("span", { class: "pill ok" }, L("تايم كود", "timecode"))
        : low ? h("span", { class: "pill bad" }, L("ضعيفة", "weak")) : h("span", { class: "pill ok" }, L("ممتازة", "good"))),
      h("td", {}, ov)));
  }
  const anyLow = rows.some((r) => r.status === "LOW");
  if (anyLow || Object.keys(overrides).length) {
    t.append(h("tr", {}, h("td", { colspan: 6 },
      h("div", { class: "row end" },
        h("span", { class: "muted" }, L("اكتب الثانية في الصوت النظيف التي يبدأ عندها أول إطار من الملف",
          "Type the second in the clean audio where the file's first frame lands")),
        h("button", { type: "button", onclick: saveOverrides }, L("حفظ التصحيحات", "Save fixes"))))));
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
  t.replaceChildren(h("tr", {}, (EN() ? ["Speaker", "Talk time", "Samples", "Cameras"] : ["المتحدث", "مدة الكلام", "عيّنات", "الكاميرات"]).map((x) => h("th", {}, x))));
  for (const [label, info] of Object.entries(sp.speakers)) {
    let chosen = mapping[label];
    chosen = chosen == null ? [] : Array.isArray(chosen) ? chosen : [chosen];
    chosen = chosen.map((c) => (c === "long" ? cfg.long_camera : c));
    const auto = !chosen.length && !!info.suggested && cams.includes(info.suggested);
    if (auto) chosen = [info.suggested];  // guessed from the pictures: the editor checks it
    else if (!chosen.length && needing === 1 && info.needs_mapping) chosen = cams.slice();  // one presenter: all angles
    const box = h("div", { class: "camchips" }, cams.map((c) =>
      h("label", { class: "chip-toggle" },
        h("input", { type: "checkbox", value: c, checked: chosen.includes(c) }),
        h("span", {}, c))));
    box.dataset.label = label;
    t.append(h("tr", {},
      h("td", { class: "ltr" }, label, auto ? h("div", {}, h("span", { class: "pill", title: L("اختارتها الأداة من حركة الصورة وقت كلامه — راجعها بالعيّنات", "Picked from picture motion while this speaker talks — check it with the samples") }, L("مقترح تلقائياً", "auto-suggested"))) : null),
      h("td", { class: "num-cell" }, fmtDur(info.total_seconds)),
      h("td", {}, info.samples.map((s, i) => s.wav
        ? h("button", { type: "button", class: "small", title: s.hhmmss,
            onclick: (e) => play(s.wav.split("/").pop(), e.currentTarget) }, "▶ " + (i + 1))
        : null)),
      h("td", {}, box)));
  }
  t.append(h("tr", {}, h("td", { colspan: 4, class: "muted" },
    L("كاميرا واحدة = القطع عليها كلما تكلّم. أكثر من كاميرا = تنويع بينها عند الوقفات بين الجمل (مناسب للمذيع الواحد).",
      "One camera = cut to it whenever this speaker talks. Several cameras = switch between them at pauses between sentences (good for a single presenter)."))));
}

async function saveSpeakers() {
  if (!S.project || !S.project.speakers) return;  // table not shown: keep the saved mapping
  const map = {};
  document.querySelectorAll("#spkTable .camchips").forEach((box) => {
    const picked = [...box.querySelectorAll("input:checked")].map((i) => i.value);
    if (picked.length) map[box.dataset.label] = picked.length === 1 ? picked[0] : picked;
  });
  await saveConfig((cfg) => { cfg.speakers = map; });
  flash($("spkSaved"), L("تم الحفظ ✓", "Saved ✓"));
}

// ---------------------------------------------------------------- outputs
const WHY_AR = {
  speaker: "على المتكلم", angle: "تنويع الزوايا عند الوقفات", hold: "إبقاء اللقطة أثناء الصمت",
  overlap: "أصوات متداخلة ← الواسعة", unmapped: "متحدث غير مربوط بكاميرا ← الواسعة",
  fallback: "الكاميرا المطلوبة بلا تصوير هنا ← بديل", gap: "لا توجد أي كاميرا (فراغ أسود)",
  opening: "قبل أول كلمة", other: "أخرى",
};
const WHY_EN = {
  speaker: "on the speaker", angle: "angle change at pauses", hold: "hold the shot during silence",
  overlap: "crosstalk → wide", unmapped: "speaker without a camera → wide",
  fallback: "chosen camera has no footage here → another", gap: "no camera at all (black gap)",
  opening: "before the first word", other: "other",
};

function renderSummary() {
  const box = $("summary");
  box.replaceChildren();
  const sm = S.project.summary;
  if (!sm) return;
  const bar = (label, pct) => h("div", { class: "sumrow" },
    h("span", { class: "sumlabel" }, label), h("span", { class: "sumbar" }, h("i", { style: `width:${pct}%` })),
    h("span", { class: "num-cell" }, pct.toFixed(0) + "%"));
  const WHY = EN() ? WHY_EN : WHY_AR;
  box.append(h("h3", {}, L(`ماذا حدث في آخر قطع (${sm.full ? "كامل" : "تجربة"}): ${sm.shots} لقطة · ${fmtDur(sm.length)}`,
    `What happened in the last cut (${sm.full ? "full" : "test"}): ${sm.shots} shots · ${fmtDur(sm.length)}`)
    + (sm.removed ? L(` · حُذف ${fmtDur(sm.removed)} سكتات`, ` · ${fmtDur(sm.removed)} of silence removed`) : "")));
  if (sm.sequence) box.append(h("p", { class: "muted" }, L("اسم التسلسل في بريمير: ", "Sequence name in Premiere: "), h("b", { class: "ltr" }, sm.sequence)));
  box.append(h("div", { class: "sumgrid" },
    h("div", {}, h("b", {}, L("نصيب كل كاميرا", "Share per camera")), Object.entries(sm.cameras).map(([c, p]) => bar(c === "(gap)" ? L("فراغ", "gap") : c, p))),
    h("div", {}, h("b", {}, L("السبب", "Why")), Object.entries(sm.reasons).map(([r, p]) => bar(WHY[r] || r, p)))));
  const tips = [];
  if ((sm.reasons.unmapped || 0) > 15) tips.push(L("جزء كبير لمتحدث غير مربوط: في الخطوة ٤ اختر كاميرات لكل متحدث (قد يكون المذيع ظهر كمتحدثَين).",
    "A lot went to a speaker without a camera: in step 4 pick cameras for every speaker (the presenter may show up as two speakers)."));
  if ((sm.reasons.fallback || 0) > 15) tips.push(L("كاميرات كثيرة بلا تصوير في أماكنها: راجع جدول المزامنة (الملفات الضعيفة لا تدخل القطع).",
    "Chosen cameras often have no footage: check the sync table (weak files are left out of the cut)."));
  if ((sm.reasons.gap || 0) > 5 && !sm.removed) tips.push(L("فيه فراغات بلا تصوير (غالباً بين التيكات): فعّل «إزالة السكتات» لحذفها.",
    "There are gaps with no footage (usually between takes): turn on \"Remove silences\" to drop them."));
  const top = Object.entries(sm.cameras)[0];
  if (top && top[1] > 60 && !(sm.reasons.angle > 20)) tips.push(L(`كاميرا ${top[0]} أخذت أغلب الوقت: لو فيه مذيع واحد اختر له أكثر من كاميرا في الخطوة ٤.`,
    `${top[0]} got most of the time: for a single presenter, tick several cameras in step 4.`));
  tips.forEach((t) => box.append(h("div", { class: "alert warn" }, t)));
}

function outputTag(name) {
  const tags = [/_\d{6}_\d+s/.test(name) ? L("تجربة", "test") : L("كامل", "full")];
  if (name.startsWith("synced")) tags.unshift(L("مزامنة فقط", "sync only"));
  if (name.includes("_tight")) tags.push(L("بدون سكتات", "no silences"));
  if (name.includes("_layers")) tags.push(L("طبقات", "layered"));
  return tags.join(" · ");
}

function renderOutputs() {
  renderSummary();
  const all = (S.project.outputs || []).filter((o) => o.name.endsWith(".xml") || o.name.startsWith("cuts"));
  fileList($("syncOutputs"), all.filter((o) => o.name.startsWith("synced")), L("ملفات المزامنة", "Synced timelines"));
  fileList($("outputs"), all.filter((o) => !o.name.startsWith("synced")), L("الملفات الناتجة", "Output files"));
}

function fileList(box, outs, title) {
  box.replaceChildren();
  if (!outs.length) return;
  box.append(h("h3", {}, title));
  for (const o of outs) {
    const isXml = o.name.endsWith(".xml");
    box.append(h("div", { class: "outfile" },
      h("span", { class: "name" }, h("span", { class: "pill" }, outputTag(o.name)), " ", h("span", { class: "ltr" }, o.name)),
      h("span", { class: "muted" }, new Date(o.mtime * 1000).toLocaleString(EN() ? "en" : "ar")),
      isXml && IN_PREMIERE ? h("button", { type: "button", class: "primary", onclick: () => importToPremiere(o.path) }, L("استيراد في بريمير", "Import into Premiere")) : null,
      h("button", { type: "button", onclick: () => api("/api/reveal", { path: o.path }) }, L("إظهار في Finder", "Show in Finder")),
      !isXml ? h("button", { type: "button", onclick: () => api("/api/reveal", { path: o.path, open: true }) }, L("فتح", "Open")) : null));
  }
  if (!IN_PREMIERE) {
    box.append(h("p", { class: "muted" }, L("في بريمير: File ← Import ثم اختر ملف XML. أو استخدم لوحة Autocut داخل بريمير للاستيراد بضغطة.",
      "In Premiere: File → Import, then pick the XML file. Or use the Autocut panel inside Premiere to import in one click.")));
  }
}

function importToPremiere(path) {
  window.parent.postMessage({ type: "autocut-import", path }, "*");
}

// folder/file dialogs: Premiere's own dialog inside the panel, macOS dialog in the app
let chooseSeq = 0;
const chooseWaiters = {};
function choose(kind, prompt) {
  if (!IN_PREMIERE && !APP_BRIDGE) return api("/api/choose", { kind, prompt }).then((r) => r.path);
  const id = ++chooseSeq;
  if (APP_BRIDGE) APP_BRIDGE.postMessage({ type: "choose", id, kind, prompt });
  else window.parent.postMessage({ type: "autocut-choose", id, kind, prompt }, "*");
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
  jobMessage(ev.data.ok ? "ok" : "error", ev.data.ok ? L("تم الاستيراد في بريمير ✓", "Imported into Premiere ✓") : L("تعذّر الاستيراد: ", "Import failed: ") + ev.data.message);
});

// ---------------------------------------------------------------- jobs
const TITLES_AR = {
  diarize: "التحليل (مزامنة + متحدثين)", run: "القطع", sync: "المزامنة فقط", check: "فحص الصوت", "models-download": "تحميل النموذج",
  "models-import": "استيراد النموذج", "models-export": "تصدير النموذج",
};
const TITLES_EN = {
  diarize: "Analysis (sync + speakers)", run: "Cut", sync: "Sync only", check: "Audio check", "models-download": "Downloading the model",
  "models-import": "Importing the model", "models-export": "Exporting the model",
};
const jobTitle = (kind) => (EN() ? TITLES_EN : TITLES_AR)[kind] || kind;

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

const DIA_AR = { segmentation: "تقطيع الصوت", "counting speakers": "عدّ المتحدثين",
  "speaker embeddings": "بصمات الأصوات", clustering: "تجميع المتحدثين" };

// the step a job is on, from its log: "[3/8] CAM 03/..." or "diarization: embeddings 40%"
function stepOf(line) {
  let m = line.match(/\[(\d+)\/(\d+)\]\s+(\S+)/);
  if (m && /samples ->/.test(line)) return L(`مزامنة: ملف ${m[1]} من ${m[2]}`, `Sync: file ${m[1]} of ${m[2]}`);
  if (m) return L(`قراءة الصوت: ${m[1]} من ${m[2]}`, `Reading audio: ${m[1]} of ${m[2]}`);
  m = line.match(/diarization: (.+?) (\d+)%/);
  if (m) return L(`تمييز المتحدثين: ${DIA_AR[m[1]] || m[1]} ${m[2]}%`, `Speakers: ${m[1]} ${m[2]}%`);
  m = line.match(/Splitting (\S+) into mono/);
  if (m) return L(`فصل قنوات الصوت: ${m[1]}`, `Splitting audio channels: ${m[1]}`);
  if (/Suggesting cameras/.test(line)) return L("اقتراح كاميرا لكل متحدث…", "Suggesting a camera per speaker…");
  m = line.match(/Checking (\S+)/);
  if (m) return L(`فحص الصوت: ${m[1]}`, `Checking audio: ${m[1]}`);
  m = line.match(/Mic levels: (\S+)/);
  if (m) return L(`قراءة المايكات: ${m[1]}`, `Reading the mics: ${m[1]}`);
  if (/Loading diarization model/.test(line)) return L("تحميل نموذج المتحدثين…", "Loading the speaker model…");
  if (/=== .*Sync/.test(line)) return L("مزامنة: قراءة عيّنات الكاميرات…", "Sync: reading camera samples…");
  if (/=== .*Cut/.test(line)) return L("القطع…", "Cutting…");
  if (/=== .*Output/.test(line)) return L("كتابة الملفات…", "Writing the files…");
  return null;
}

function appendLog(lines) {
  for (const line of lines) {
    const st = stepOf(line);
    if (st) $("jobStep").textContent = "· " + st;
  }
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
  $("jobStep").textContent = "";
  show($("jobMsg"), false);
  show($("jobBar"), true);
  show($("btnCancel"), true);
  show($("btnCloseJob"), false);
  $("jobSpin").classList.remove("stop");
  $("jobTitle").textContent = jobTitle(body.kind);
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
  $("jobStep").textContent = "";
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
    jobMessage(code === 0 ? "ok" : "error", code === 0 ? L("تم ✓", "Done ✓") : L("لم يكتمل — راجع السجل", "Did not finish — see the log"));
    if (code !== 0) show($("log"), true);
    return;
  }
  if (S.path) await loadProject(S.path);
  if (kind === "check" && code === 0) {
    const bad = ((S.project && S.project.audio_check && S.project.audio_check.files) || []).some((f) => (f.notes || []).length);
    jobMessage(bad ? "warn" : "ok", bad ? L("انتهى الفحص — فيه مشاكل، شوف التفاصيل في الإعدادات (الخطوة ٢).", "Check done — problems found, see the details in settings (step 2).")
      : L("انتهى الفحص ✓ — كل الملفات والقنوات سليمة.", "Check done ✓ — every file and channel is fine."));
    $("checkBox").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (kind === "sync" && (code === 0 || code === 3)) {
    jobMessage(code === 0 ? "ok" : "warn", code === 0
      ? L("تمت المزامنة ✓ — ملف «synced» جاهز في الخطوة ٣: كل كاميرا على مسار، والصوت النظيف تحتها.",
          "Synced ✓ — the \"synced\" file is ready in step 3: each camera on its own track, the clean audio below.")
      : L("تمت المزامنة، لكن بعض الملفات مزامنتها ضعيفة: موجودة في الملف بعلامة حمراء — راجعها في جدول المزامنة.",
          "Synced, but some files synced weakly: they are in the file with a red label — check them in the sync table."));
    $("syncOutputs").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const msgs = {
    0: ["ok", kind === "run" ? L("تم! الملفات جاهزة في الخطوة ٥.", "Done! The files are ready in step 5.")
      : L("تم التحليل ✓ — راجع المزامنة واختر كاميرا كل متحدث.", "Analysis done ✓ — check the sync and pick each speaker's camera.")],
    2: ["warn", L("اختر كاميرا لكل متحدث في الخطوة ٤ ثم احفظ، وبعدها اضغط تجربة.",
      "Pick a camera for each speaker in step 4, save, then press Test.")],
    3: ["warn", L("بعض الملفات مزامنتها ضعيفة (بالأحمر في الخطوة ٣). اكتب لها تصحيحاً يدوياً، أو فعّل «تابع رغم…» في الخطوة ٥.",
      "Some files synced weakly (red in step 3). Type a manual fix for them, or tick \"Continue despite…\" in step 5.")],
    130: ["warn", L("تم الإيقاف.", "Stopped.")],
    [-15]: ["warn", L("تم الإيقاف.", "Stopped.")],
  };
  let [k, text] = msgs[code] || ["error", L("حدث خطأ — افتح السجل لمعرفة السبب.", "Something went wrong — open the log to see why.")];
  const low = (S.project && S.project.sync || []).filter((r) => r.status === "LOW").map((r) => r.clip);
  if (code === 0 && kind === "run" && low.length) {
    k = "warn";
    text += L(`\n⚠ ${low.length} ملف مزامنته ضعيفة لم يدخل القطع (والقطع رجع للكاميرا الواسعة مكانه): `,
      `\n⚠ ${low.length} weakly synced file(s) left out of the cut (the wide camera was used there): `)
      + low.slice(0, 6).join(L("، ", ", ")) + (low.length > 6 ? "…" : "")
      + L(" — راجع جدول المزامنة في الخطوة ٣.", " — see the sync table in step 3.");
  }
  jobMessage(k, text);
  if (k === "error") show($("log"), true);
  if (code === 0 && kind === "run") $("outputs").scrollIntoView({ behavior: "smooth", block: "center" });
  if (code === 2 || (code === 0 && kind === "diarize")) $("secSpeakers").scrollIntoView({ behavior: "smooth" });
}

function setBusy(on) {
  ["btnAnalyze", "btnSyncOnly", "btnCheck", "btnTest", "btnFull", "btnImport", "btnDownload", "btnExport", "btnSaveCfg", "btnSaveSpk"]
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
    return jobMessage("error", L("الإعدادات: ", "Settings: ") + e.message);
  }
  // diarization needs the model unless this project was already analysed
  const needsModel = kind !== "sync" && kind !== "check" && S.project.config.diarization.method !== "mics";
  if (needsModel && !(await refreshModels()) && !S.project.speakers) {
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
    const p = await choose("folder", L("اختر مجلد التصوير", "Choose the shoot folder"));
    if (p) loadProject(p);
  } catch (e) {
    showScanError(e.message);
  }
};
$("btnLoad").onclick = () => loadProject($("projPath").value);
$("btnChooseXml").onclick = async () => {
  try {
    const p = await choose("xml", L("اختر ملف XML للتسلسل المتزامن", "Choose the synced sequence XML"));
    if (p) loadProject(p);
  } catch (e) {
    showScanError(e.message);
  }
};

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
    b.textContent = L("متأكد؟ اضغط مرة ثانية", "Sure? Click again");
    resetArmed = setTimeout(() => { b.textContent = L("إعادة الضبط", "Reset"); resetArmed = null; }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = null;
  b.textContent = L("إعادة الضبط", "Reset");
  try { await api("/api/config/reset", { path: S.project.path }); await loadProject(S.path); flash($("cfgSaved"), L("رجعت الإعدادات الافتراضية ✓", "Back to default settings ✓")); }
  catch (e) { flash($("cfgSaved"), L("خطأ: ", "Error: ") + e.message); }
};
$("projPath").addEventListener("keydown", (e) => { if (e.key === "Enter") loadProject(e.target.value); });
$("btnSaveCfg").onclick = async () => {
  try { await saveConfig(); flash($("cfgSaved"), L("تم الحفظ ✓", "Saved ✓")); await loadProject(S.path); }
  catch (e) { flash($("cfgSaved"), L("خطأ: ", "Error: ") + e.message); }
};
$("cfgNoSilence").onchange = () => show($("silenceOpts"), $("cfgNoSilence").checked);
$("cfgSpkMethod").onchange = audioInfo;
$("cfgChannel").onchange = audioInfo;
$("btnAudio").onclick = async () => {
  const p = await choose("folder", L("اختر مجلد الصوت النظيف", "Choose the clean audio folder"));
  if (!p) return;
  try { await saveConfig((cfg) => { cfg.audio_folder = p; }); await loadProject(S.path); }
  catch (e) { flash($("cfgSaved"), L("خطأ: ", "Error: ") + e.message); }
};
$("btnSaveSpk").onclick = () => saveSpeakers().catch((e) => flash($("spkSaved"), L("خطأ: ", "Error: ") + e.message));
$("btnAnalyze").onclick = () => runStage("diarize", { diarize_full: true });
$("btnSyncOnly").onclick = () => runStage("sync", {});
$("btnCheck").onclick = () => runStage("check", {});
$("btnTest").onclick = () => runStage("run", {
  start: $("testStart").value.trim(), duration: $("testDur").value.trim(), allow_low: $("allowLow").checked }, saveSpeakers);
$("btnFull").onclick = () => runStage("run", { allow_low: $("allowLow").checked }, saveSpeakers);
$("btnCancel").onclick = () => api("/api/job/cancel", {});
$("btnLog").onclick = () => show($("log"), $("log").classList.contains("hidden"));
$("btnCloseJob").onclick = () => show($("jobBar"), false);

$("btnLang").onclick = () => {
  setLang(EN() ? "ar" : "en");
  refreshModels();
  if (S.project) loadProject(S.path);
  if (S.jobKind) $("jobTitle").textContent = jobTitle(S.jobKind);
};
$("modelsBadge").onclick = () => { refreshModels(); $("modelsDlg").showModal(); };
$("btnImport").onclick = async () => {
  const p = await choose("file", L("اختر autocut-models.zip", "Choose autocut-models.zip"));
  if (p) { $("modelsDlg").close(); startJob({ kind: "models-import", zip: p }); }
};
$("btnExport").onclick = async () => {
  const p = await choose("folder", L("أين تحفظ autocut-models.zip؟", "Where to save autocut-models.zip?"));
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
      $("jobTitle").textContent = jobTitle(j.kind);
      setBusy(true);
      pollJob(0);
      if (j.project) loadProject(j.project);
    }
  } catch (e) { /* not running */ }
  const last = recall("autocut-recent", [])[0];
  if (last && !S.path && !recall("autocut-last-closed", false)) loadProject(last);
})();
