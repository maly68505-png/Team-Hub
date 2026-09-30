/* Autocut UI language: English (default) or Arabic. The page is written in
   Arabic; STATIC translates its fixed text, L(ar, en) the text built in app.js. */
"use strict";

const LANG_KEY = "autocut-lang";
let LANG = (() => { try { return localStorage.getItem(LANG_KEY) || "en"; } catch (e) { return "en"; } })();
const EN = () => LANG === "en";
const L = (ar, en) => (EN() ? en : ar);

const STATIC = {
  "قطع مبدئي تلقائي متعدد الكاميرات لبريمير": "Automatic multicam rough cut for Premiere",
  "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5",
  "مجلد التصوير": "Shoot folder",
  "اختر المجلد…": "Choose folder…",
  "فتح": "Open",
  "إغلاق المشروع والرجوع للبداية": "Close the project and start over",
  "الإعدادات": "Settings",
  "مجلد الصوت النظيف": "Clean audio folder",
  "اختر…": "Choose…",
  "الكاميرا الواسعة": "Wide camera",
  "عدد المتحدثين": "Number of speakers",
  "(اختياري، يحسّن الدقة)": "(optional, improves accuracy)",
  "تلقائي": "auto",
  "قواعد القطع (متقدم)": "Cut rules (advanced)",
  "أقل مدة للّقطة (ث)": "Shortest shot (s)",
  "تداخل الأصوات ← الواسعة إذا زاد عن (ث)": "Crosstalk → wide camera if longer than (s)",
  "تجاهل الكلام الأقصر من (ث)": "Ignore speech shorter than (s)",
  "اقطع قبل بداية الكلام بـ (ث)": "Cut before speech starts by (s)",
  "تنويع الزوايا: أقصر لقطة (ث)": "Angle changes: shortest shot (s)",
  "تنويع الزوايا: أطول لقطة (ث)": "Angle changes: longest shot (s)",
  "يحذف config.yaml لهذا المشروع — نتائج التحليل تبقى": "Deletes this project's config.yaml — analysis results are kept",
  "إعادة الضبط": "Reset",
  "حفظ الإعدادات": "Save settings",
  "التحليل: مزامنة + تمييز المتحدثين": "Analysis: sync + speaker detection",
  "يُجرى مرة واحدة لكل مشروع وتُحفظ نتيجته. على جهاز ماك M قد يأخذ عدة دقائق لتسجيل ساعتين.":
    "Runs once per project and the result is saved. On an M-series Mac a two-hour shoot can take several minutes.",
  "ابدأ التحليل": "Start analysis",
  "المزامنة": "Sync",
  "من يتكلم؟": "Who is speaking?",
  "استمع للعيّنات واختر كاميرا كل متحدث.": "Listen to the samples and pick each speaker's camera.",
  "حفظ": "Save",
  "القطع": "Cut",
  "التجربة تبدأ من": "Test starts at",
  "مدة التجربة": "Test length",
  "إزالة السكتات بين الكلام (من كل المسارات معاً — تبقى متزامنة)":
    "Remove silences between speech (on all tracks together — stays in sync)",
  "أي سكتة أطول من (ث) تُقصَّر": "Shorten any pause longer than (s)",
  "تابع رغم وجود ملفات مزامنتها ضعيفة (تُعلَّم بالأحمر ولا تدخل في القطع)":
    "Continue despite weakly synced files (marked red, left out of the cut)",
  "تايم لاين طبقات: كل كاميرا في مسار خاص ومقطوعة في مكانها (تعديل القطع بالـ Rolling Edit)":
    "Layered timeline: each camera on its own track, cut in place (adjust cuts with a Rolling Edit)",
  "تجربة": "Test",
  "القطع الكامل": "Full cut",
  "السجل": "Log",
  "إيقاف": "Stop",
  "إغلاق": "Close",
  "نموذج تمييز المتحدثين": "Speaker detection model",
  "يعمل Autocut بدون إنترنت. يحتاج كل جهاز النموذج مرة واحدة فقط.":
    "Autocut works offline. Each Mac needs the model only once.",
  "من زميل (بدون إنترنت)": "From a colleague (offline)",
  "استيراد autocut-models.zip…": "Import autocut-models.zip…",
  "تحميل لأول مرة (إنترنت + حساب Hugging Face)": "First download (internet + Hugging Face account)",
  "اقبل الشروط في": "Accept the terms at",
  "ثم الصق المفتاح (Read token):": "then paste the key (Read token):",
  "تحميل": "Download",
  "مشاركة مع الفريق": "Share with the team",
  "تصدير النموذج إلى مجلد…": "Export the model to a folder…",
};

const ORIG = new WeakMap();  // node -> its Arabic text, so switching back works

function translateStatic(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!ORIG.has(n)) {
      const key = n.nodeValue.trim().replace(/\s+/g, " ");
      if (!(key in STATIC)) continue;
      ORIG.set(n, n.nodeValue);
    }
    const ar = ORIG.get(n);
    const key = ar.trim().replace(/\s+/g, " ");
    n.nodeValue = EN() ? ar.replace(ar.trim(), STATIC[key]) : ar;
  }
  root.querySelectorAll("[title],[placeholder]").forEach((el) => {
    for (const attr of ["title", "placeholder"]) {
      const k = "data-ar-" + attr;
      if (!el.hasAttribute(k)) {
        const v = el.getAttribute(attr);
        if (v == null || !(v in STATIC)) continue;
        el.setAttribute(k, v);
      }
      const ar = el.getAttribute(k);
      el.setAttribute(attr, EN() ? STATIC[ar] : ar);
    }
  });
}

function applyLang() {
  document.documentElement.lang = EN() ? "en" : "ar";
  document.documentElement.dir = EN() ? "ltr" : "rtl";
  translateStatic(document.body);
  const b = document.getElementById("btnLang");
  if (b) b.textContent = EN() ? "عربي" : "English";
}

function setLang(lang) {
  LANG = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode */ }
  applyLang();
}
