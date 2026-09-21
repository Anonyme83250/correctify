const {
  app, Tray, Menu, globalShortcut, clipboard, BrowserWindow,
  ipcMain, Notification, nativeImage, systemPreferences, shell, screen
} = require("electron");
const path = require("path");
const { exec } = require("child_process");
const { loadSettings, saveSettings, fileExists } = require("./settings-store");
const { generateCorrection, buildPrompt, detectLanguage, parseCorrection, describeError } = require("./ai");
const winHelper = require("./win-helper"); // host PowerShell persistant (Windows) : UIA + clavier
const { buildCorrectedHtml, restoreEmojiText, diffWordEdits } = require("./rich-paste"); // transfert de mise en forme (HTML) + emojis-image + éditions diff sur plage Word (COM)
const { t, STRINGS, LANGS } = require("./i18n");
const { dbg, dbgv, preview } = require("./debug"); // journalisation (cf. debug.js)

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const ICON = path.join(__dirname, "..", "assets", "icon.png");
// Windows préfère un .ico (multi-tailles) pour l'icône de fenêtre / barre des tâches.
const WIN_ICON = path.join(__dirname, "..", "assets", "icon.ico");
const WINDOW_ICON = isWin ? WIN_ICON : ICON;

// Tons proposés dans le sous-menu du tray (ordre d'affichage). "standard" =
// correction seule ; les autres reformulent (cf. ai.js TONE_INSTRUCTIONS).
const TONE_KEYS = ["standard", "professional", "courteous", "concise", "formal", "simplified", "joking"];

// Langue du TEXTE corrigé, proposée dans le tray et dans les options : "auto" =
// déduite du texte sélectionné, sinon imposée (cf. ai.js, buildPrompt).
const FORCE_LANG_KEYS = ["auto", "fr", "en"];

// Identité d'app Windows : sans ça, la barre des tâches affiche l'icône Electron
// par défaut (notamment en mode dev) au lieu de celle de l'app.
if (isWin) app.setAppUserModelId("com.correctify.desktop");

let tray = null;
let settingsWin = null;
let settings = loadSettings();
// Raccourci de traduction : lit toujours la langue courante (settings.lang).
const tr = (key, vars) => t(settings.lang, key, vars);

// Couleur de fond NATIVE de la fenêtre selon le thème : évite un flash blanc le
// temps que le HTML charge / pendant un redimensionnement (le CSS, lui, applique
// le dark via l'attribut data-theme). Doit rester aligné sur --bg des affichages.
function windowBg() {
  return settings.theme === "dark" ? "#0e1620" : "#ffffff";
}
let busy = false; // évite les déclenchements concurrents
let pending = null; // correction prête mais en attente du retour de la fenêtre d'origine
let applying = false; // garde-fou anti double-application (clic + polling simultanés)
let cancelRequested = false; // l'utilisateur a cliqué « Annuler » pendant la correction
let currentAbort = null; // AbortController de l'appel IA en cours (pour l'annulation)

// ---------------------------------------------------------------------------
// Simulation clavier sans module natif :
//   macOS   -> osascript (System Events)
//   Windows -> PowerShell SendKeys
// Le raccourci global ne vole pas le focus, donc Copier/Coller s'appliquent
// bien à l'application de premier plan (Outlook, Word, navigateur…).
// ---------------------------------------------------------------------------
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Exécute un script PowerShell via -EncodedCommand : robuste (aucun souci
// d'échappement de guillemets, scripts multi-lignes OK).
function runPS(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return run(`powershell -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`);
}

// Capture la fenêtre active au déclenchement (Windows), pour pouvoir y recoller
// le texte même si l'utilisateur clique ailleurs pendant la correction.
async function captureForeground() {
  if (!isWin) return null;
  try {
    const out = await runPS(
`$c=@'
using System;using System.Runtime.InteropServices;
public static class Fg{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}
'@
Add-Type -TypeDefinition $c
[Console]::Out.Write([Fg]::GetForegroundWindow().ToInt64())`);
    const h = (out || "").trim();
    return /^-?\d+$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

// Copier la sélection : l'app cible est déjà au premier plan (le raccourci
// global ne vole pas le focus).
function copySelection() {
  if (isMac) return run(`osascript -e 'tell application "System Events" to keystroke "c" using command down'`);
  return runPS(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^c')`);
}

// Variante Ctrl+Insert (Windows uniquement) — combinaison historique de copie
// honorée par la plupart des apps Win32 et par Gecko. Utile quand Ctrl+C est
// intercepté (raccourci interne) ou ne déclenche pas la copie.
function copySelectionIns() {
  if (isMac) return Promise.resolve();
  return runPS(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^{INSERT}')`);
}

// Réactive la fenêtre d'origine (best-effort, try/catch) puis colle. Si la
// restauration échoue, on colle quand même dans la fenêtre courante.
function pasteSelection(target) {
  if (isMac) {
    return run(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
  }
  const restore = target ? `try{
$c=@'
using System;using System.Runtime.InteropServices;
public static class FgR{
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
Add-Type -TypeDefinition $c
$t=[IntPtr]::new([int64]${target})
$fg=[FgR]::GetForegroundWindow()
$ta=[FgR]::GetWindowThreadProcessId($fg,[IntPtr]::Zero)
$me=[FgR]::GetCurrentThreadId()
[FgR]::AttachThreadInput($me,$ta,$true)|Out-Null
if([FgR]::IsIconic($t)){[FgR]::ShowWindow($t,9)|Out-Null} # restaure seulement si minimisée (ne dé-maximise pas le plein écran)
[FgR]::BringWindowToTop($t)|Out-Null
[FgR]::SetForegroundWindow($t)|Out-Null
[FgR]::AttachThreadInput($me,$ta,$false)|Out-Null
Start-Sleep -Milliseconds 90
}catch{}
` : "";
  return runPS(`${restore}Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Titre fixe « Correctify » + logo → la marque apparaît en haut de chaque toast.
// onClick (optionnel) : permet à l'utilisateur d'appliquer une correction en
// attente directement depuis la notification.
function notify(message, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: "Correctify", body: message, icon: ICON, silent: true });
  if (onClick) n.on("click", onClick);
  n.show();
}

// macOS exige l'autorisation « Accessibilité » pour simuler des touches.
function ensureMacAccessibility() {
  if (!isMac) return true;
  if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
  systemPreferences.isTrustedAccessibilityClient(true); // déclenche la demande système
  notify(tr("notify.macAccess"));
  return false;
}

// ---------------------------------------------------------------------------
// Indicateur flottant (HUD) : reste affiché pendant toute la correction et ne
// vole pas le focus (showInactive + focusable:false), donc il ne perturbe pas
// la fenêtre cible du copier/coller.
// ---------------------------------------------------------------------------
let hudWin = null;
function showHud() {
  hideSummary(); // un résumé précédent ne doit pas rester pendant une nouvelle correction
  if (hudWin && !hudWin.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const w = 400;
  const h = 60;
  hudWin = new BrowserWindow({
    width: w, height: h,
    x: workArea.x + workArea.width - (w + 20),
    y: workArea.y + workArea.height - (h + 26),
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") } // pour le bouton « Annuler »
  });
  // Cliquable (le bouton Annuler) mais focusable:false → ne vole jamais le focus
  // de la fenêtre cible : si on n'annule pas, le collage suivra normalement.
  hudWin.setIgnoreMouseEvents(false);
  const hash = encodeURIComponent(JSON.stringify({
    theme: settings.theme,
    text: tr("hud.working"),
    pending: false,
    cancel: tr("hud.cancel")
  }));
  hudWin.loadFile(path.join(__dirname, "hud.html"), { hash }).catch(() => hideHud());
  hudWin.webContents.on("did-fail-load", () => hideHud()); // pas de fenêtre fantôme si le fichier manque
  hudWin.once("ready-to-show", () => {
    if (hudWin && !hudWin.isDestroyed()) hudWin.showInactive(); // affiche sans prendre le focus
  });
}
function hideHud() {
  if (hudWin && !hudWin.isDestroyed()) hudWin.destroy();
  hudWin = null;
}

// Indicateur « correction prête, en attente » : reste affiché pendant le report
// d'application (l'utilisateur est sur une autre fenêtre). Même fichier que le
// HUD, en mode #pending (texte différent, pas de spinner). Non focusable et
// cliquable-au-travers : il n'interfère jamais avec la fenêtre cible.
let pendingWin = null;
function showPendingHud() {
  hidePendingHud();
  const { workArea } = screen.getPrimaryDisplay();
  const w = 320;
  const h = 60;
  pendingWin = new BrowserWindow({
    width: w, height: h,
    x: workArea.x + workArea.width - (w + 20),
    y: workArea.y + workArea.height - (h + 26),
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false
  });
  pendingWin.setIgnoreMouseEvents(true);
  const hash = encodeURIComponent(JSON.stringify({
    theme: settings.theme,
    text: tr("hud.pending"),
    pending: true
  }));
  pendingWin.loadFile(path.join(__dirname, "hud.html"), { hash }).catch(() => hidePendingHud());
  pendingWin.webContents.on("did-fail-load", () => hidePendingHud());
  pendingWin.once("ready-to-show", () => {
    if (pendingWin && !pendingWin.isDestroyed()) pendingWin.showInactive();
  });
}
function hidePendingHud() {
  if (pendingWin && !pendingWin.isDestroyed()) pendingWin.destroy();
  pendingWin = null;
}

// Panneau flottant affichant le résumé des corrections. Non focusable /
// cliquable-au-travers, auto-fermeture.
let summaryWin = null;
function hideSummary() {
  if (summaryWin && !summaryWin.isDestroyed()) summaryWin.destroy();
  summaryWin = null;
}
function showSummary(points) {
  hideSummary();
  if (!points || !points.length) return;
  const list = points.slice(0, 8);
  const height = Math.min(340, 78 + list.length * 30); // en-tête (logo+marque) + lignes
  const width = 340;
  const { workArea } = screen.getPrimaryDisplay();
  summaryWin = new BrowserWindow({
    width, height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false
  });
  summaryWin.setIgnoreMouseEvents(true);
  const hash = encodeURIComponent(JSON.stringify({ theme: settings.theme, badge: tr("summary.badge"), points: list }));
  summaryWin.loadFile(path.join(__dirname, "summary.html"), { hash }).catch(() => hideSummary());
  summaryWin.webContents.on("did-fail-load", () => hideSummary());
  summaryWin.once("ready-to-show", () => {
    if (summaryWin && !summaryWin.isDestroyed()) summaryWin.showInactive();
  });
  // Auto-fermeture proportionnelle au contenu (entre 5 et 12 s).
  const ms = Math.min(12000, Math.max(5000, list.length * 2000));
  setTimeout(hideSummary, ms);
}

// Panneau d'erreur : même identité visuelle que le résumé (logo + marque), mais
// badge rouge « Erreur » et message clair. Toutes les erreurs passent par ici.
let errorWin = null;
function hideError() {
  if (errorWin && !errorWin.isDestroyed()) errorWin.destroy();
  errorWin = null;
}
function showError(message) {
  hideHud();
  hidePendingHud();
  hideSummary();
  hideError();
  const text = String(message || tr("err.unknown"));
  const { workArea } = screen.getPrimaryDisplay();
  const width = 340;
  const lines = Math.max(1, Math.ceil(text.length / 40)); // ~40 caractères par ligne
  const height = Math.min(220, 64 + lines * 19); // en-tête + lignes de message
  errorWin = new BrowserWindow({
    width, height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false
  });
  errorWin.setIgnoreMouseEvents(true);
  const hash = encodeURIComponent(JSON.stringify({ theme: settings.theme, badge: tr("error.badge"), msg: text }));
  errorWin.loadFile(path.join(__dirname, "error.html"), { hash }).catch(() => hideError());
  errorWin.webContents.on("did-fail-load", () => hideError());
  errorWin.once("ready-to-show", () => {
    if (errorWin && !errorWin.isDestroyed()) errorWin.showInactive();
  });
  setTimeout(hideError, 7000);
}

// Copier la sélection : helper persistant (Windows) sinon repli SendKeys/osascript.
async function doCopy() {
  if (winHelper.isWin) {
    try { await winHelper.copy(); return; } catch { /* repli ci-dessous */ }
  }
  await copySelection();
}

// Apps « texte brut » (éditeurs de code) : elles collent du texte brut, et la
// présence d'un flavor HTML dans le presse-papier EMPÊCHE le collage de remplacer
// la sélection (Monaco/VS Code : « rien ne se passe » sur un fichier coloré, alors
// qu'un fichier texte brut fonctionne). Pour ces process, on force donc le texte
// brut. Détection par nom de process (renvoyé par la capture UIA). Liste extensible.
const PLAIN_TEXT_APPS = new Set([
  "code", "code - insiders", "vscodium", "codium", "cursor", "windsurf"
]);
function isPlainTextApp(proc) {
  return !!proc && PLAIN_TEXT_APPS.has(String(proc).trim().toLowerCase());
}

// Place le texte corrigé dans le presse-papier. Si on a le HTML d'origine de la
// sélection (copié par l'app source au Ctrl+C), on y transfère les corrections en
// gardant la mise en forme (cf. rich-paste.js) et on écrit un flavor HTML + texte ;
// Word/Outlook/Thunderbird/navigateurs collent alors la version riche. Sinon
// (source en texte brut), on écrit du texte brut. Renvoie true si HTML utilisé.
// `sourceText` = le texte brut envoyé à l'IA : sert à aligner sa représentation des
// sauts de ligne (Teams les double) sur celle du HTML avant le diff.
function writeCorrectedRich(corrected, originalHtml, sourceText) {
  const html = buildCorrectedHtml(originalHtml, corrected, sourceText);
  if (html) {
    try { clipboard.write({ text: corrected, html }); return true; } catch { /* repli texte brut */ }
  }
  clipboard.writeText(corrected);
  return false;
}

function endBusy() {
  if (!busy) return;
  busy = false;
  updateTrayMenu();
}

// Abandonne une correction en attente (timers + indicateur).
function cancelPending() {
  if (pending) {
    if (pending.pollTimer) clearInterval(pending.pollTimer);
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer);
    pending = null;
  }
  hidePendingHud();
}

/**
 * true si l'app peut corriger : une URL d'API et un nom de modèle. La clé, elle,
 * reste facultative — un serveur local (Ollama, LM Studio) n'en demande pas.
 */
function isConfigured() {
  return !!String(settings.baseUrl || "").trim() && !!String(settings.model || "").trim();
}

// ---------------------------------------------------------------------------
// Cœur : récupère la sélection, corrige, puis l'applique — tout de suite si la
// fenêtre d'origine est encore au premier plan, sinon dès qu'elle y revient
// (report d'application). Voir applyOrDefer.
// ---------------------------------------------------------------------------
async function correctSelection() {
  if (busy) { dbgv("déclenchement ignoré : une correction est déjà en cours"); return; }
  busy = true;
  updateTrayMenu();
  dbgv("═══════ correction START — tone=" + settings.tone + ", lang=" + settings.lang +
      ", forceLang=" + (settings.forceLang || "auto") + ", isWin=" + winHelper.isWin);
  hideSummary(); // efface immédiatement le résumé précédent (avant même le spinner)
  hideError();   // efface une erreur précédente
  cancelPending();
  cancelRequested = false;
  currentAbort = null;
  let handedOff = false; // true dès que la suite (apply/report) prend la main sur busy
  let previousClipboard = ""; // déclaré ici pour être restauré aussi dans le catch (annulation)
  try {
    // Pas d'URL d'API ou pas de modèle : la correction n'a pas de cible, on
    // ouvre les options.
    if (!isConfigured()) {
      showError(tr("err.provider"));
      openSettings();
      return;
    }
    if (!ensureMacAccessibility()) return;

    // Affiche TOUT DE SUITE l'indicateur « correction en cours » (avec Annuler) :
    // la phase de copie/sélection peut prendre quelques secondes (plusieurs
    // tentatives), et sans retour visuel immédiat on pourrait croire qu'il ne se
    // passe rien. Le HUD ne vole pas le focus (showInactive + focusable:false),
    // donc le Ctrl+C simulé s'applique toujours à l'app cible.
    showHud();

    // Attendre le relâchement PHYSIQUE du raccourci avant toute copie simulée : un
    // Ctrl/Alt encore enfoncé transforme Ctrl+C en Ctrl+Alt+C → « Aucun texte
    // sélectionné » (cause n°1 des ratés). Le helper sonde l'état clavier (plafonné) ;
    // repli temporisé fixe sur macOS ou si le helper est indisponible.
    if (winHelper.isWin) {
      try { await winHelper.waitKeysUp(); } catch { await sleep(220); }
    } else {
      await sleep(220);
    }

    // Mémorise la fenêtre active ET la sélection exacte (UI Automation) : on
    // pourra recoller/re-sélectionner même après un changement de fenêtre.
    let captured = null;
    if (winHelper.isWin) {
      try { captured = await winHelper.capture(); } catch { captured = null; }
    }
    let target;
    if (captured && typeof captured.hwnd === "number") {
      target = captured.hwnd;
    } else {
      const h = await captureForeground(); // repli (et chemin macOS → null)
      target = h != null ? Number(h) : null; // normalise en nombre (cf. comparaison du polling)
    }
    dbgv("cible résolue: target=" + target + " (proc=" + (captured ? captured.proc : "?") +
        ", elevated=" + (captured ? captured.elevated : "?") + ", capture.text=" + preview(captured && captured.text) + ")");

    previousClipboard = clipboard.readText();
    // SENTINELLE : on dépose une marque UNIQUE dans le presse-papier juste avant
    // le Ctrl+C. Ainsi, MÊME si la sélection de l'utilisateur est IDENTIQUE au
    // contenu précédent (typique d'une re-correction de la même phrase), le copier
    // de l'app remplace la sentinelle par le texte sélectionné → on détecte la
    // nouvelle valeur par « != sentinelle ». Sans ça, Thunderbird/Firefox & co
    // peuvent zapper l'écriture quand le nouveau == ancien (dédup interne) → on
    // conclurait à tort « aucun copier ». Petit délai après l'écriture pour laisser
    // le service Historique du presse-papier (Win+V) finir d'indexer (sinon il
    // peut tenir brièvement le clipboard et faire échouer le Ctrl+C qui suit).
    const SENTINEL = "__CORRECTIFY_SENTINEL_" + Date.now() + "_" + Math.floor(Math.random() * 1e9) + "__";
    clipboard.writeText(SENTINEL);
    await sleep(60);
    let seqRef = null;
    try { const r0 = await winHelper.clipseq(); seqRef = r0 && r0.seq; } catch {}
    dbgv("clipboard prepare : prev=" + preview(previousClipboard) + " | sentinelle posee, seqRef=" + seqRef);

    // Copier, avec PLUSIEURS tentatives si la sentinelle reste intacte : certaines
    // apps ratent le Ctrl+C simulé (Thunderbird/Gecko, éditeurs de code…). On
    // tourne sur 4 méthodes — Ctrl+C / Ctrl+Insert × helper (keybd_event, scan
    // codes) / SendKeys — pour couvrir les apps qui n'honorent qu'un sous-ensemble.
    let selected = "";
    let sawBlank = false;        // un copier a eu lieu, mais ne contient que des blancs
    const copyMethods = [
      ["helper Ctrl+C",        () => doCopy()],
      ["sendkeys Ctrl+C",      () => copySelection()],
      ["helper Ctrl+Insert",   () => winHelper.copyIns()],
      ["sendkeys Ctrl+Insert", () => copySelectionIns()],
    ];
    for (let attempt = 0; attempt < 6 && !selected && !cancelRequested; attempt++) {
      if (attempt > 0) await sleep(120); // laisse l'app cible digérer avant un nouvel essai
      const [mname, mfn] = copyMethods[attempt % copyMethods.length];
      try { await mfn(); } catch (e) { dbgv("  copie#" + attempt + " " + mname + " : ERREUR " + (e && e.message)); }
      let last = SENTINEL;
      for (let i = 0; i < 16; i++) { // ~0,8 s d'attente par tentative
        await sleep(50);
        const cur = clipboard.readText() || "";
        last = cur;
        // Un copier a EU LIEU dès que la sentinelle a été remplacée.
        if (cur !== SENTINEL) {
          if (cur.trim()) { selected = cur; break; }
          else { sawBlank = true; }  // remplacé mais blanc → on continue à attendre du non-vide
        }
      }
      let seqNow = null;
      try { const r = await winHelper.clipseq(); seqNow = r && r.seq; } catch {}
      const seqChanged = (seqNow != null && seqRef != null && seqNow !== seqRef);
      dbgv("  copie#" + attempt + " " + mname + " -> " +
          (selected ? "OK " + preview(selected)
            : (last === SENTINEL ? "sentinelle INTACTE (aucun copier declenche)"
                                 : "remplace mais vide " + preview(last))) +
          " | seq=" + seqNow + (seqChanged ? " (CHANGE)" : " (inchange)"));
    }
    // Annulé pendant la phase de sélection (clic « Annuler ») : arrêt propre, sans
    // erreur — on masque le HUD et on rend le presse-papier d'origine.
    if (cancelRequested) {
      hideHud();
      clipboard.writeText(previousClipboard);
      return;
    }
    // Version HTML de la sélection (placée par l'app source au Ctrl+C) : sert à
    // recoller en conservant la mise en forme. Vide si la source est en texte brut.
    let selectedHtml = "";
    try { selectedHtml = clipboard.readHTML() || ""; } catch { selectedHtml = ""; }
    // Éditeur de code (VS Code, Cursor…) : un flavor HTML dans le presse-papier
    // empêche Monaco de remplacer la sélection au collage → on force le texte brut.
    if (captured && isPlainTextApp(captured.proc)) selectedHtml = "";

    dbgv("HTML sélection: " + preview(selectedHtml));
    // Diagnostic : les OBJETS de la sélection (emojis-image de Teams…), non-ASCII
    // échappé en \uXXXX pour lire leurs attributs exacts dans le log.
    if (selectedHtml) {
      const objs = selectedHtml.match(/<readonly\b[^>]*>[\s\S]*?<\/readonly>|<img\b[^>]*>/gi);
      if (objs) dbgv("objets sélection (" + objs.length + ") : " + objs.slice(0, 4).map((t) =>
        t.slice(0, 600).replace(/[^\x20-\x7E]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))).join(" || "));
    }

    // Repli ultime : le texte lu DIRECTEMENT à la capture (Word COM, champ natif via
    // WM_GETTEXT, ou UIA) — sauve la mise quand le Ctrl+C simulé n'a rien donné.
    if ((!selected || !selected.trim()) && captured && captured.text && captured.text.trim()) {
      selected = captured.text;
      dbgv("sélection récupérée via REPLI capture-directe (Ctrl+C n'avait rien donné)");
    }
    if (!selected || !selected.trim()) {
      dbg("SELECTION KO");   // ligne unique visible en mode minimal — détails ci-dessous en verbeux
      clipboard.writeText(previousClipboard);
      dbgv("  détails: elevated=" + (captured && captured.elevated) + ", sawBlank=" + sawBlank +
          ", proc=" + (captured && captured.proc) + " | (Gecko/Chromium : l'UIA ne voit rien, le Ctrl+C n'a pas abouti)");
      hideHud();
      // Cible en administrateur : l'UIPI Windows bloque toute injection clavier ET
      // l'UIA → la copie ne POUVAIT pas aboutir. Message d'action plutôt qu'opaque.
      if (captured && captured.elevated) showError(tr("err.elevatedTarget"));
      else if (sawBlank) showError(tr("err.blankSelection")); // on a bien copié, mais que des blancs
      else showError(tr("err.noSelection"));
      return;
    }
    dbg("SELECTION OK " + preview(selected));   // ligne unique visible en mode minimal

    // Emojis copiés en IMAGE (Teams…) : le texte brut du presse-papier porte leur
    // TITRE (« Visage souriant avec yeux rieurs ») à la place de l'emoji → on remet
    // l'emoji avant l'appel IA (cf. rich-paste.js). `selected` reste le texte copié
    // tel quel : c'est lui que le helper compare/recherche pour re-sélectionner.
    const aiText = restoreEmojiText(selected, selectedHtml);
    if (aiText !== selected) dbgv("emojis-image remis dans le texte envoyé à l'IA : " + preview(aiText));

    showHud(); // indicateur persistant pendant l'appel IA (avec bouton Annuler)

    // Appel IA interruptible : « Annuler » déclenche currentAbort.abort().
    currentAbort = new AbortController();
    // Langue de la correction : imposée par le réglage, sinon devinée du texte
    // ("?" = indécise → le modèle tranche). Tracée ici parce que c'est la
    // première chose à vérifier quand une correction revient mal traduite.
    const forced = FORCE_LANG_KEYS.includes(settings.forceLang) ? settings.forceLang : "auto";
    dbgv("langue de correction : " + (forced === "auto" ? (detectLanguage(aiText) || "?") + " (détectée)" : forced + " (imposée)"));
    dbgv("appel IA (" + settings.apiKind + " @ " + settings.baseUrl + " / " + settings.model + ") sur " + preview(aiText) + "…");
    const aiStart = Date.now();
    const aiResult = await generateCorrection(
      {
        baseUrl: settings.baseUrl,
        apiKind: settings.apiKind,
        apiKey: settings.apiKey,
        model: settings.model
      },
      buildPrompt(aiText, settings.tone, { forceLang: settings.forceLang, uiLang: settings.lang }),
      { signal: currentAbort.signal }
    );
    // Annulé pendant l'appel : on restaure le presse-papier et on s'arrête net.
    if (cancelRequested) { hideHud(); clipboard.writeText(previousClipboard); return; }
    const { corrected, summary } = parseCorrection(aiResult.text);
    dbgv("IA répondu en " + (Date.now() - aiStart) + "ms — corrigé " + preview(corrected) + ", résumé " + summary.length + " pt(s)");

    if (!corrected) {
      hideHud();
      clipboard.writeText(previousClipboard);
      showError(tr("err.empty"));
      return;
    }

    const usedHtml = writeCorrectedRich(corrected, selectedHtml, aiText);
    dbgv("presse-papier corrigé écrit (mise en forme html=" + usedHtml + ")");
    await sleep(120);

    // À partir d'ici, c'est applyOrDefer (et le cas échéant le report) qui gère
    // la fin et la libération de busy. On garde `original` (le texte sélectionné)
    // pour pouvoir le re-sélectionner par FindText si le curseur a bougé, et
    // `originalHtml` pour ré-affirmer le collage riche en cas de report.
    handedOff = true;
    await applyOrDefer({
      target, corrected, summary, previousClipboard, original: selected, originalHtml: selectedHtml, aiText,
      // Texte BRUT de la plage Word/Outlook figée (renvoyé par la capture) : les
      // éditions diff du chemin COM sont calculées sur CE texte-là (cf. applyNow),
      // pas sur le presse-papier → offsets valides par construction.
      wordText: (captured && typeof captured.wtext === "string") ? captured.wtext : ""
    });
  } catch (e) {
    hideHud();
    hidePendingHud();
    if (cancelRequested) {
      clipboard.writeText(previousClipboard); // annulation : pas d'erreur, on restaure le presse-papier
    } else {
      showError(describeError(e, settings.lang)); // message clair dans le HUD (jamais le code brut)
    }
    endBusy();
  } finally {
    currentAbort = null;
    if (!handedOff) endBusy();
  }
}

// Annule la correction en cours (clic sur « Annuler » dans le HUD) : interrompt
// l'appel IA et masque le toast. La restauration du presse-papier + la libération
// de busy se font dans correctSelection quand l'appel se dénoue (quasi instantané).
function cancelCorrection() {
  if (!busy || cancelRequested) return;
  cancelRequested = true;
  if (currentAbort) { try { currentAbort.abort(); } catch { /* ignore */ } }
  hideHud(); // retour visuel immédiat
}

// Applique la correction maintenant si la fenêtre d'origine est au premier plan,
// sinon la met en attente (report). Sur macOS / sans helper : collage immédiat.
async function applyOrDefer(ctx) {
  if (!winHelper.isWin) {
    await pasteSelection(ctx.target); // comportement historique (macOS)
    await sleep(250);
    await finishApply(ctx);
    return;
  }

  let fg = null;
  let helperOk = false;
  try {
    const r = await winHelper.foreground();
    helperOk = !!(r && r.ok);
    fg = r ? r.hwnd : null;
  } catch { helperOk = false; }
  dbgv("applyOrDefer: helperOk=" + helperOk + ", fg=" + fg + ", target=" + ctx.target);

  if (!helperOk) {
    // Helper indisponible : repli historique (collage immédiat best-effort).
    dbgv("helper indisponible → collage immédiat (repli SendKeys)");
    await pasteSelection(ctx.target);
    await sleep(250);
    await finishApply(ctx);
    return;
  }

  if (ctx.target != null && fg === ctx.target) {
    dbgv("fenêtre inchangée → application IMMÉDIATE");
    await applyNow(ctx, true);   // la fenêtre n'a jamais bougé → sélection vivante, collage direct
  } else {
    dbgv("fenêtre différente → REPORT d'application (on attend le retour)");
    startDeferred(ctx);    // l'utilisateur est ailleurs → on attend son retour
  }
}

// Restaure la fenêtre, re-sélectionne exactement (UIA) et colle. Garde-fou
// anti double-application (clic notif + polling peuvent déclencher ensemble).
async function applyNow(ctx, immediate = false) {
  if (applying) return;
  applying = true;
  try {
    hideHud();
    hidePendingHud();
    // Ré-affirme le texte corrigé : en report, l'utilisateur a pu copier autre
    // chose pendant l'attente → on garantit que c'est bien la correction collée
    // (avec la mise en forme si on a le HTML d'origine).
    writeCorrectedRich(ctx.corrected, ctx.originalHtml, ctx.aiText);
    await sleep(60);
    let ok = false;
    // Éditions minimales (diff) : le chemin COM Word/Outlook ne remplace QUE les
    // portions changées → la mise en forme variée (gras, couleurs, police…) est gardée.
    // Les éditions sont calculées sur LE TEXTE MÊME de la plage Word figée (wtext,
    // renvoyé par la capture) : les offsets tombent juste PAR CONSTRUCTION, quelle
    // que soit la représentation du presse-papier (\r\n vs \r, sauts doux \v,
    // insécables, puces de liste…) — cf. rich-paste.js diffWordEdits. Hors
    // Word/Outlook il n'y a pas de plage COM : aucun diff à calculer (le collage
    // riche HTML fait le travail), ce qui évite un gros diff inutile à chaque fois.
    const edits = ctx.wordText ? (diffWordEdits(ctx.wordText, ctx.corrected) || []) : [];
    dbgv("applyNow: immediate=" + immediate + ", " + edits.length + " édition(s) diff" +
        (ctx.wordText ? " (calculées sur la plage Word)" : " (pas de plage Word)"));
    try { const res = await winHelper.apply(ctx.original, immediate, ctx.corrected, edits); ok = !!(res && res.ok); dbgv("helper apply -> ok=" + ok + ", method=" + (res && res.method)); } catch (e) { ok = false; dbgv("helper apply ERREUR: " + (e && e.message)); }
    if (!ok) { dbgv("apply KO → collage de repli (SendKeys)"); try { await pasteSelection(ctx.target); } catch { /* best-effort */ } }
    await sleep(250);
    await finishApply(ctx);
  } finally {
    applying = false;
  }
}

// Affiche le résumé, restaure éventuellement le presse-papier, libère l'app.
async function finishApply(ctx) {
  showSummary(ctx.summary); // panneau « ce qui a été corrigé »
  if (settings.restoreClipboard) {
    await sleep(450);
    // Seulement si le presse-papier contient encore NOTRE texte corrigé : sinon
    // l'utilisateur a copié autre chose entre-temps, on n'y touche pas.
    if (clipboard.readText() === ctx.corrected) clipboard.writeText(ctx.previousClipboard);
  }
  cancelPending();
  endBusy();
}

// Report d'application : la fenêtre d'origine n'est plus au premier plan. On
// notifie, on affiche un indicateur d'attente, et on applique automatiquement
// dès que cette fenêtre revient au premier plan (polling) — ou au clic sur la
// notification. Le texte corrigé reste dans le presse-papier en attendant.
function startDeferred(ctx) {
  cancelPending();
  hideHud();
  showPendingHud();
  notify(
    tr("defer.ready"),
    () => { if (pending && pending.ctx === ctx) { cancelPending(); applyNow(ctx); } }
  );

  const pollTimer = setInterval(async () => {
    try {
      const r = await winHelper.foreground();
      if (r && r.ok && r.hwnd === ctx.target) {
        cancelPending();      // stoppe polling + timeout avant d'appliquer
        await applyNow(ctx);
      }
    } catch { /* helper momentanément indispo : on retentera au prochain tick */ }
  }, 450);

  const timeoutTimer = setTimeout(() => {
    // Jamais revenu (~2 min) : on laisse le texte corrigé dans le presse-papier
    // pour un collage manuel, et on libère l'app.
    cancelPending();
    notify(tr("defer.timeout"));
    endBusy();
  }, 120000);

  pending = { ctx, pollTimer, timeoutTimer };
}

// ---------------------------------------------------------------------------
// Raccourci global
// ---------------------------------------------------------------------------
function registerHotkey() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(settings.hotkey, correctSelection);
  if (!ok) {
    notify(tr("notify.hotkeyFail", { hotkey: settings.hotkey }));
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Dimensionnement de la fenêtre d'options
// ---------------------------------------------------------------------------
// Elle s'ajuste à son contenu, mais jamais au-delà de l'écran : sur un portable,
// la liste des options dépasse la hauteur utile et ses derniers réglages
// deviennent inatteignables. Elle est donc :
//   - redimensionnable EN HAUTEUR par l'utilisateur (la largeur reste figée,
//     la mise en page est pensée pour elle) ;
//   - plafonnée à l'écran où elle se trouve VRAIMENT, recalculé quand on la
//     déplace d'un écran à l'autre ;
//   - défilante à l'intérieur (.wrap { overflow-y:auto }).

const MIN_WINDOW_HEIGHT = 220;
const WINDOW_MARGIN = 60; // air laissé autour de la fenêtre sur l'écran

/**
 * Hauteur maximale utilisable sur l'écran où se trouve réellement la fenêtre.
 * Indispensable en multi-écran : l'écran principal peut être un grand moniteur
 * et celui où l'utilisateur a déplacé la fenêtre un portable bien plus court.
 */
function maxHeightFor(win) {
  const display = (win && !win.isDestroyed())
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  return Math.max(MIN_WINDOW_HEIGHT, display.workArea.height - WINDOW_MARGIN);
}

/** Applique le plafond de l'écran courant, et rogne la fenêtre s'il a rétréci. */
function clampToDisplay(win) {
  if (!win || win.isDestroyed() || !win.__lockedWidth) return;
  const maxH = maxHeightFor(win);
  win.setMaximumSize(win.__lockedWidth, maxH);
  const [w, h] = win.getSize();
  if (h > maxH) win.setSize(w, maxH); // setMaximumSize ne rétrécit pas tout seul
}

/** Rend une fenêtre redimensionnable en hauteur seulement, bornée par son écran. */
function makeVerticallyResizable(win, width) {
  win.__lockedWidth = width;
  // Min et max de LARGEUR identiques : seule la hauteur bouge.
  win.setMinimumSize(width, MIN_WINDOW_HEIGHT);
  win.setMaximumSize(width, maxHeightFor(win));
  // Dès que l'utilisateur prend la main, on cesse de redimensionner et de
  // recentrer dans son dos. `will-resize` et `will-move` ne sont émis que pour
  // SES gestes, jamais pour nos propres appels : la distinction est fiable.
  win.on("will-resize", () => { win.__userSized = true; });
  win.on("will-move", () => { win.__userMoved = true; });
  // Déplacement (y compris d'un écran à l'autre) : le plafond suit.
  win.on("moved", () => clampToDisplay(win));
}

/**
 * Ajuste la hauteur au contenu, sans jamais dépasser l'écran courant. Ne fait
 * rien si l'utilisateur a lui-même redimensionné : sa hauteur est un choix, et
 * un changement de langue ne doit pas la lui reprendre.
 */
function applyContentHeight(win, h) {
  if (!win || win.isDestroyed() || win.__userSized) return;
  const maxH = maxHeightFor(win);
  const target = Math.max(MIN_WINDOW_HEIGHT, Math.min(Math.ceil(Number(h) || 0), Math.floor(maxH)));
  const [w] = win.getContentSize();
  win.setContentSize(w, target);
  if (!win.__userMoved) win.center(); // re-centre, sauf si l'utilisateur l'a placée
}

function autoSizeWindow(win) {
  if (!win || win.isDestroyed()) return;
  const measure =
    "(function(){var t=document.querySelector('.titlebar');var w=document.querySelector('.wrap');" +
    "return Math.ceil((t?t.offsetHeight:0)+(w?w.scrollHeight:document.body.scrollHeight));})()";
  win.webContents.executeJavaScript(measure).then((h) => {
    if (!win || win.isDestroyed()) return;
    applyContentHeight(win, h);
    win.show();
  }).catch(() => { if (win && !win.isDestroyed()) win.show(); });
}

// ---------------------------------------------------------------------------
// Fenêtre d'options
// ---------------------------------------------------------------------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 160,             // provisoire : ajustée au contenu après chargement
    show: false,
    center: true,
    title: "Correctify",
    resizable: true,         // en hauteur seulement (cf. makeVerticallyResizable)
    maximizable: false,
    frame: false,            // pas de cadre/barre de titre Windows
    backgroundColor: windowBg(),
    icon: WINDOW_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  makeVerticallyResizable(settingsWin, 460);
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  // Repli : si le renderer ne demande pas le redimensionnement (~1,5 s), on mesure
  // et on affiche quand même pour ne jamais laisser la fenêtre invisible.
  setTimeout(() => {
    if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.isVisible()) autoSizeWindow(settingsWin);
  }, 1500);
  settingsWin.on("closed", () => { settingsWin = null; });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function updateTrayMenu() {
  if (!tray) return;
  const configured = isConfigured();

  // Sous-menu « Ton » : cases radio, le ton coché est mémorisé et appliqué à la
  // prochaine correction (raccourci global compris). On reconstruit le menu après
  // chaque choix pour rafraîchir la coche.
  const toneSubmenu = TONE_KEYS.map((key) => ({
    label: tr("tone." + key),
    type: "radio",
    checked: (settings.tone || "standard") === key,
    click: () => {
      settings = saveSettings({ ...settings, tone: key });
      updateTrayMenu();
    }
  }));

  // Sous-menu « Langue de la correction » : même principe que le ton. Sous la
  // main quand on passe d'un mail français à un mail anglais, sans ouvrir les
  // options.
  const langSubmenu = FORCE_LANG_KEYS.map((key) => ({
    label: tr("opt.forceLang." + key),
    type: "radio",
    checked: (settings.forceLang || "auto") === key,
    click: () => {
      settings = saveSettings({ ...settings, forceLang: key });
      updateTrayMenu();
    }
  }));

  const menu = Menu.buildFromTemplate([
    { label: `Correctify v${app.getVersion()}`, enabled: false }, // version de l'app
    { type: "separator" },
    {
      label: busy ? tr("tray.working") : tr("tray.correct", { hotkey: settings.hotkey }),
      enabled: !busy,
      click: () => correctSelection()
    },
    { label: tr("tray.tone"), submenu: toneSubmenu },
    { label: tr("tray.forceLang"), submenu: langSubmenu },
    { type: "separator" },
    // Ce qui sera appelé : le modèle configuré, ou l'avertissement s'il manque
    // l'essentiel. On voit d'un coup d'œil si l'app est prête.
    {
      label: configured ? tr("tray.model", { model: settings.model }) : tr("tray.notConfigured"),
      enabled: false
    },
    { label: tr("tray.options"), click: () => openSettings() },
    { type: "separator" },
    { label: tr("tray.quit"), click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  // Icône de barre de menus mac : 16–18px, en mode template (monochrome auto).
  if (isMac) {
    img = img.resize({ width: 18, height: 18 });
    img.setTemplateImage(true);
  } else {
    img = img.resize({ width: 16, height: 16 });
  }
  tray = new Tray(img);
  tray.setToolTip("Correctify");
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// IPC depuis la fenêtre d'options
// ---------------------------------------------------------------------------
ipcMain.handle("get-settings", () => settings);

// Renvoie les traductions + la langue ET le thème courants à la fenêtre d'options
// (le renderer applique data-theme dès le premier await → pas de flash clair).
ipcMain.handle("get-i18n", () => ({ lang: settings.lang, theme: settings.theme, langs: LANGS, strings: STRINGS }));

ipcMain.handle("save-settings", (_evt, next) => {
  settings = saveSettings({ ...settings, ...next });
  registerHotkey();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
  // Thème changé : ré-aligne le fond NATIF de la fenêtre ouverte (le CSS suit déjà
  // via data-theme) pour qu'un redimensionnement ne laisse pas un bord clair.
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setBackgroundColor(windowBg());
  updateTrayMenu();
  return settings;
});

ipcMain.handle("open-external", (_evt, url) => shell.openExternal(url));

ipcMain.handle("close-settings", () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

// Bouton « Annuler » du toast de correction.
ipcMain.handle("cancel-correction", () => cancelCorrection());

// Le renderer demande l'ajustement de SA fenêtre à la hauteur réelle de son
// contenu, une fois l'i18n appliquée → aucun blanc en bas.
ipcMain.handle("resize-to-content", (evt, h) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win || win.isDestroyed()) return;
  applyContentHeight(win, h); // borné par l'écran courant, ignoré si l'utilisateur a choisi sa hauteur
  if (!win.isVisible()) win.show();
});

// Pendant l'enregistrement d'un raccourci dans les options, on libère le
// raccourci global : sinon il serait intercepté au niveau système et
// déclencherait la correction au lieu d'arriver dans le champ.
ipcMain.handle("pause-hotkey", () => globalShortcut.unregisterAll());
ipcMain.handle("resume-hotkey", () => registerHotkey());

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Pas d'icône dans le Dock macOS : app de barre de menus uniquement.
  if (isMac && app.dock) app.dock.hide();

  // Tout premier lancement : langue d'interface d'après l'OS (fr si OS en
  // français, en sinon).
  if (!fileExists()) {
    const sys = (app.getLocale() || "").toLowerCase();
    settings = saveSettings({ ...settings, lang: sys.startsWith("fr") ? "fr" : "en" });
  }

  createTray();
  registerHotkey();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });

  // Résolution modifiée, écran branché ou débranché : la fenêtre ouverte est
  // ramenée dans les limites de son écran. Sans ça, débrancher un grand moniteur
  // laisserait une fenêtre plus haute que l'écran du portable, dont le bas — le
  // bouton « Enregistrer » — deviendrait inatteignable.
  const onDisplaysChanged = () => clampToDisplay(settingsWin);
  screen.on("display-metrics-changed", onDisplaysChanged);
  screen.on("display-added", onDisplaysChanged);
  screen.on("display-removed", onDisplaysChanged);

  // Démarre le host PowerShell persistant (Windows) : il charge UI Automation
  // une fois pour toutes → la 1ʳᵉ correction n'attend pas ce chargement.
  winHelper.start();

  if (!isConfigured()) openSettings(); // première utilisation, ou réglages incomplets
});

// On garde l'app vivante même sans fenêtre (c'est une app de tray).
app.on("window-all-closed", () => { /* ne pas quitter */ });
app.on("will-quit", () => {
  // Garde-fou : si l'app se ferme avant d'être prête (ex. 2ᵉ instance qui
  // quitte aussitôt), globalShortcut n'est pas encore utilisable.
  if (app.isReady()) globalShortcut.unregisterAll();
  cancelPending();
  winHelper.stop(); // tue le process PowerShell persistant
});

// Instance unique : un second lancement ouvre les options au lieu de dupliquer.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
}
