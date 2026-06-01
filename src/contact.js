// Renderer de la fenêtre « Contact & retours ». L'envoi réel (signature HMAC +
// appel au proxy mail du site) est fait dans le process principal via
// window.correctify.sendFeedback — la clé n'est jamais ici.
const $ = (id) => document.getElementById(id);

// --- i18n (mêmes tables que les options, récupérées du main). ----------------
let I18N = {};
let LANG = "fr";

// Applique le thème (clair / sombre) via data-theme sur <html> — cf. le bloc
// :root[data-theme="dark"] de contact.html.
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
}
function tr(key) {
  const dict = I18N[LANG] || I18N.fr || {};
  return (dict[key] != null) ? dict[key] : key;
}
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.getAttribute("data-i18n")); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.setAttribute("placeholder", tr(el.getAttribute("data-i18n-placeholder"))); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.setAttribute("title", tr(el.getAttribute("data-i18n-title"))); });
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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function setStatus(text) {
  $("status").textContent = text || "";
}

$("close").addEventListener("click", () => window.correctify.closeContact());

$("send").addEventListener("click", async () => {
  setStatus("");
  const message = $("message").value.trim();
  const email = $("email").value.trim();
  if (!message) { setStatus(tr("contact.errEmpty")); $("message").focus(); return; }
  if (email && !EMAIL_RE.test(email)) { setStatus(tr("contact.errEmail")); $("email").focus(); return; }

  const btn = $("send");
  btn.disabled = true;
  btn.textContent = tr("contact.sending");
  btn.classList.remove("ok");

  const res = await window.correctify.sendFeedback({
    category: $("category").value,
    name: $("name").value.trim(),
    email,
    message
  });

  if (res && res.ok) {
    btn.textContent = tr("contact.sent");
    btn.classList.add("ok");
    setTimeout(() => window.correctify.closeContact(), 1600);
    return;
  }

  // Échec : on réactive le bouton et on explique.
  btn.disabled = false;
  btn.textContent = tr("contact.send");
  setStatus((res && res.status === 429) ? tr("contact.errRate") : tr("contact.errSend"));
});

// Ajuste la fenêtre à la hauteur réelle du contenu (après i18n) → pas de blanc en
// bas. Mesure le span réel des enfants (fiable en agrandissement ET rétrécissement).
function measureContentHeight() {
  const titlebar = document.querySelector(".titlebar");
  const wrap = document.querySelector(".wrap");
  if (!wrap) return 0;
  wrap.scrollTop = 0;
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

initI18n().then(() => requestAnimationFrame(fitWindow));
