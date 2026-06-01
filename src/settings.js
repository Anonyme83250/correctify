// Renderer de la fenêtre d'options. Communique avec le main via window.correctify (preload).
const $ = (id) => document.getElementById(id);
const IS_MAC = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

// --- i18n : les tables FR/EN sont récupérées du main (get-i18n). -------------
let I18N = {};
let LANG = "fr";
let THEME = "light";

// Applique le thème (clair / sombre) en posant data-theme sur <html> : le CSS de
// la page bascule alors toutes ses couleurs (cf. bloc :root[data-theme="dark"]).
function applyTheme(theme) {
  THEME = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", THEME);
}
function tr(key) {
  const dict = I18N[LANG] || I18N.fr || {};
  return (dict[key] != null) ? dict[key] : key;
}
// Bascule segmentée FR/EN : met en surbrillance la langue active.
function setLangActive(lang) {
  document.querySelectorAll(".lang-opt").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-lang") === lang);
  });
}
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.getAttribute("data-i18n")); });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = tr(el.getAttribute("data-i18n-html")); }); // chaînes internes de confiance (ex. <code>)
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.setAttribute("placeholder", tr(el.getAttribute("data-i18n-placeholder"))); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.setAttribute("title", tr(el.getAttribute("data-i18n-title"))); });
  setLangActive(LANG);   // surbrillance de la langue courante
  refreshProviderPill(); // le libellé « non détecté » suit la langue
}
async function initI18n() {
  try {
    const i = await window.correctify.getI18n();
    I18N = i.strings || {};
    LANG = i.lang || "fr";
    applyTheme(i.theme); // dès le 1ᵉʳ await → la fenêtre s'affiche déjà dans le bon thème
  } catch { /* défaut FR */ }
  applyI18n();
}

function detectProviderLabel(key) {
  const k = (key || "").trim();
  if (k.startsWith("sk-ant-")) return { label: "Anthropic Claude", on: true };
  if (k.startsWith("sk-")) return { label: "OpenAI", on: true };
  if (k.startsWith("AIza")) return { label: "Google Gemini", on: true };
  if (k) return { label: tr("opt.providerDefault"), on: true };
  return { label: tr("opt.notDetected"), on: false };
}

function refreshProviderPill() {
  const { label, on } = detectProviderLabel($("apiKey").value);
  const pill = $("provider");
  pill.textContent = label;
  pill.classList.toggle("on", on);
}

// --- Enregistreur de raccourci : convertit un évènement clavier en accélérateur
// --- Electron (ex. "Control+Alt+C"). Renvoie null sur une touche purement
// --- modificatrice (Ctrl/Alt/Shift/Meta seule).
function keyEventToAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(IS_MAC ? "Command" : "Super");

  const code = e.code || "";
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);            // KeyC -> C
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);     // Digit1 -> 1
  else if (/^Numpad[0-9]$/.test(code)) key = "num" + code.slice(6);
  else if (/^F\d{1,2}$/.test(code)) key = code;                // F1..F24
  else {
    const map = {
      Space: "Space", Enter: "Return", NumpadEnter: "Return", Tab: "Tab",
      Backspace: "Backspace", Escape: "Escape", Delete: "Delete", Insert: "Insert",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
      Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`"
    };
    key = map[code] || null;
  }
  if (!key) return null;
  return [...mods, key].join("+");
}

function setupHotkeyRecorder() {
  const input = $("hotkey");
  input.addEventListener("focus", () => {
    input.classList.add("recording");
    window.correctify.pauseHotkey(); // libère le raccourci global le temps d'enregistrer
  });
  input.addEventListener("blur", () => {
    input.classList.remove("recording");
    window.correctify.resumeHotkey(); // réactive le raccourci (l'ancien tant qu'on n'a pas sauvegardé)
  });
  input.addEventListener("keydown", (e) => {
    e.preventDefault();
    const acc = keyEventToAccelerator(e);
    if (acc) input.value = acc; // ignore les modificateurs seuls
  });
}

async function load() {
  const s = await window.correctify.getSettings();
  $("apiKey").value = s.apiKey || "";
  $("hotkey").value = s.hotkey || "";
  $("darkMode").checked = (s.theme === "dark");
  $("restoreClipboard").checked = !!s.restoreClipboard;
  $("launchAtLogin").checked = !!s.launchAtLogin;
  $("sendStats").checked = s.sendStats !== false; // opt-out : activé par défaut
  refreshProviderPill();
}

// Changer la langue (clic sur FR/EN) : application immédiate + persistance.
document.querySelectorAll(".lang-opt").forEach((b) => {
  b.addEventListener("click", async () => {
    const lang = b.getAttribute("data-lang");
    if (lang === LANG) return;
    LANG = lang;
    applyI18n();
    requestAnimationFrame(fitWindow); // le contenu traduit change de hauteur → réajuste
    await window.correctify.saveSettings({ lang: LANG });
  });
});

// Mode sombre : application visuelle immédiate + persistance directe (le réglage
// reste mémorisé entre deux lancements, et s'applique aux autres affichages).
$("darkMode").addEventListener("change", async () => {
  applyTheme($("darkMode").checked ? "dark" : "light");
  await window.correctify.saveSettings({ theme: THEME });
});

$("apiKey").addEventListener("input", refreshProviderPill);

$("reveal").addEventListener("click", () => {
  const el = $("apiKey");
  el.type = el.type === "password" ? "text" : "password";
});

$("close").addEventListener("click", () => window.correctify.closeWindow());

$("save").addEventListener("click", async () => {
  const next = {
    apiKey: $("apiKey").value.trim(),
    hotkey: $("hotkey").value.trim() || "Control+Alt+C",
    restoreClipboard: $("restoreClipboard").checked,
    launchAtLogin: $("launchAtLogin").checked,
    sendStats: $("sendStats").checked,
    lang: LANG,
    theme: THEME
  };
  await window.correctify.saveSettings(next);
  // Confirmation directement sur le bouton (toujours visible).
  const btn = $("save");
  if (btn._t) clearTimeout(btn._t);
  btn.textContent = tr("opt.saved");
  btn.classList.add("ok");
  btn._t = setTimeout(() => {
    btn.textContent = tr("opt.save");
    btn.classList.remove("ok");
  }, 1700);
});

// Liens externes ouverts dans le navigateur par défaut.
document.querySelectorAll("a[data-url]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    window.correctify.openExternal(a.getAttribute("data-url"));
  });
});

// Demande au main d'ajuster la fenêtre à la hauteur réelle du contenu (zéro blanc
// en bas). Mesure le SPAN réel des enfants (1er haut → dernier bas) : fiable que
// la fenêtre soit trop petite (contenu qui déborde) OU trop grande (qui rétrécit),
// contrairement à scrollHeight qui reste collé à la hauteur étirée du conteneur.
function measureContentHeight() {
  const titlebar = document.querySelector(".titlebar");
  const wrap = document.querySelector(".wrap");
  if (!wrap) return 0;
  wrap.scrollTop = 0; // mesure depuis le haut
  const cs = getComputedStyle(wrap);
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const kids = wrap.children;
  let span = 0;
  if (kids.length) {
    span = kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top;
  }
  return (titlebar ? titlebar.offsetHeight : 0) + pad + span;
}
function fitWindow() {
  if (window.correctify.resizeToContent) window.correctify.resizeToContent(Math.ceil(measureContentHeight()));
}

setupHotkeyRecorder();
// i18n d'abord (libellés), puis valeurs des champs, puis ajustement de la fenêtre.
initI18n().then(load).then(() => requestAnimationFrame(fitWindow));
