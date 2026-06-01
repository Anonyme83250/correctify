const {
  app, Tray, Menu, globalShortcut, clipboard, BrowserWindow,
  ipcMain, Notification, nativeImage, systemPreferences, shell, dialog, screen
} = require("electron");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");
const { loadSettings, saveSettings, fileExists } = require("./settings-store");
const { generateCorrection, buildPrompt, parseCorrection, detectProvider, describeError } = require("./ai");
const winHelper = require("./win-helper"); // host PowerShell persistant (Windows) : UIA + clavier
const { buildCorrectedHtml, diffToEdits } = require("./rich-paste"); // transfert de mise en forme (HTML) + diff→éditions (COM Word)
const { t, STRINGS, LANGS } = require("./i18n");
const { getChangelog, getAllChangelogs } = require("./changelog"); // notes de version (fenêtre « Nouveautés »)
const { autoUpdater } = require("electron-updater"); // mise à jour automatique (Windows installé)
const { dbg, dbgv, preview, DEBUG_DRY_RUN } = require("./debug"); // journalisation + mode dry-run (cf. debug.js)

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const ICON = path.join(__dirname, "..", "assets", "icon.png");
// Windows préfère un .ico (multi-tailles) pour l'icône de fenêtre / barre des tâches.
const WIN_ICON = path.join(__dirname, "..", "assets", "icon.ico");
const WINDOW_ICON = isWin ? WIN_ICON : ICON;
const UPDATE_FEED = "https://correctify.fr/version.php";

// Lien de don ouvert par le bouton « Soutenir le projet » du menu (navigateur
// par défaut).
const PAYPAL_URL = "https://paypal.me/al83250";

// Tons proposés dans le sous-menu du tray (ordre d'affichage). "standard" =
// correction seule ; les autres reformulent (cf. ai.js TONE_INSTRUCTIONS).
const TONE_KEYS = ["standard", "professional", "courteous", "concise", "formal", "simplified", "joking"];

// API centrale du site (api.php) : l'app signe chaque requête en HMAC-SHA256
// avec la clé partagée, puis le site route sur le champ "action" :
//   - "mail"       : relais e-mail (contact / logs / retours) via son SMTP ;
//   - "correction" : statistique d'usage (date, nb de caractères, langue).
// La signature se fait UNIQUEMENT ici (process principal) — la clé n'est jamais
// exposée au renderer. Côté serveur : destinataire fixe + rate-limit + anti-rejeu
// (la clé embarquée n'autorise donc que l'envoi au propriétaire / l'ajout de stats).
const API_URL = "https://correctify.fr/api.php";
// Clé HMAC partagée avec le backend correctify.fr. Elle n'est PAS versionnée
// (cf. .gitignore) : lue depuis la variable d'environnement CORRECTIFY_API_KEY
// ou, à défaut, depuis src/secret.js (non commité — voir src/secret.example.js).
// Sans clé, seules les fonctions reliées à correctify.fr (contact / retours /
// stats d'usage) sont inopérantes ; la correction de texte fonctionne normalement.
const API_KEY = process.env.CORRECTIFY_API_KEY || (() => {
  try { return require("./secret").API_KEY || ""; } catch { return ""; }
})();

// Identité d'app Windows : sans ça, la barre des tâches affiche l'icône Electron
// par défaut (notamment en mode dev) au lieu de celle de l'app.
if (isWin) app.setAppUserModelId("com.anonyma.correctify");

 

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
let lastNotifiedVersion = null; // version déjà signalée en arrière-plan (anti-spam de la vérif horaire)
let updateTimer = null; // intervalle de vérification des mises à jour
let autoUpdaterManual = false; // la vérif en cours vient-elle du menu (feedback « à jour ») ?
let installingUpdate = false; // garde-fou : une seule install/redémarrage

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

// ---------------------------------------------------------------------------
// Mise à jour : compare la version locale au fichier version.php du site.
// (manual = true → déclenché par le menu : on signale aussi « à jour ».)
// ---------------------------------------------------------------------------
function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Mise à jour automatique (electron-updater) — Windows + app installée.
//   1) check latest.yml sur le serveur  2) téléchargement silencieux en fond
//   3) install NSIS silencieuse + relance dès que l'app est inactive.
// Le toast « Application mise à jour ✓ » s'affiche après le redémarrage
// (détection d'un changement de version, cf. app.whenReady).
// ---------------------------------------------------------------------------
function canAutoUpdate() {
  return isWin && app.isPackaged;
}

function installWhenIdle() {
  if (installingUpdate) return;
  // Ne jamais couper une correction / un report en cours : on attend l'inactivité.
  if (busy || pending || applying) { setTimeout(installWhenIdle, 5000); return; }
  installingUpdate = true;
  try { autoUpdater.quitAndInstall(true, true); } // (isSilent, isForceRunAfter)
  catch { installingUpdate = false; }
}

function setupAutoUpdater() {
  if (!canAutoUpdate()) return;
  autoUpdater.autoDownload = true;          // télécharge dès qu'une version sort
  autoUpdater.autoInstallOnAppQuit = true;  // filet : applique au prochain quit si pas déjà fait
  // Une version est dispo : sur une vérif MANUELLE (menu), on confirme que ça
  // bouge (le téléchargement + l'install se font ensuite tout seuls). En arrière-
  // plan, on reste silencieux (le toast « mis à jour » viendra après redémarrage).
  autoUpdater.on("update-available", (info) => {
    if (autoUpdaterManual) {
      notify(tr("update.downloading", { version: (info && info.version) || "" }));
      autoUpdaterManual = false;
    }
  });
  autoUpdater.on("update-downloaded", () => installWhenIdle());
  autoUpdater.on("update-not-available", () => {
    if (autoUpdaterManual) notify(tr("update.upToDate"));
    autoUpdaterManual = false;
  });
  autoUpdater.on("error", (err) => {
    if (autoUpdaterManual) notify(tr("update.checkFailed", { error: (err && err.message) || err }));
    autoUpdaterManual = false;
  });
}

async function checkForUpdates(manual = false) {
  // Windows installé : tout passe par electron-updater (silencieux, auto).
  if (canAutoUpdate()) {
    autoUpdaterManual = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      if (manual) notify(tr("update.checkFailed", { error: (e && e.message) || e }));
      autoUpdaterManual = false;
    }
    return;
  }
  // macOS / mode dev : ancienne vérif (téléchargement manuel via le site).
  try {
    const res = await fetch(UPDATE_FEED, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const latest = String((data && data.version) || "").trim();
    const current = app.getVersion();

    if (latest && compareVersions(latest, current) > 0) {
      // En arrière-plan (manual=false), on ne re-signale pas une version déjà
      // annoncée dans cette session : sinon la vérif horaire rouvrirait le
      // dialogue toutes les heures. Le menu (manual=true) signale toujours.
      if (!manual && latest === lastNotifiedVersion) return;
      lastNotifiedVersion = latest;
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: tr("update.title"),
        message: tr("update.available", { latest }),
        detail: (data.notes ? data.notes + "\n\n" : "") + tr("update.installed", { current }),
        buttons: [tr("update.download"), tr("update.later")],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) shell.openExternal(data.url || "https://correctify.fr/download.php");
    } else if (manual) {
      dialog.showMessageBox({
        type: "info",
        title: "Correctify",
        message: tr("update.upToDate"),
        detail: tr("update.version", { current }),
        buttons: [tr("common.ok")]
      });
    }
  } catch (e) {
    if (manual) {
      dialog.showErrorBox(tr("update.title"), tr("update.checkFailed", { error: (e.message || e) }));
    }
  }
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
  hudWin = new BrowserWindow({
    width: 400, height: 60,
    x: workArea.x + workArea.width - 420,
    y: workArea.y + workArea.height - 86,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") } // pour le bouton « Annuler »
  });
  // Cliquable (le bouton Annuler) mais focusable:false → ne vole jamais le focus
  // de la fenêtre cible : si on n'annule pas, le collage suivra normalement.
  hudWin.setIgnoreMouseEvents(false);
  const hash = encodeURIComponent(JSON.stringify({ theme: settings.theme, text: tr("hud.working"), pending: false, cancel: tr("hud.cancel") }));
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
  pendingWin = new BrowserWindow({
    width: 320, height: 60,
    x: workArea.x + workArea.width - 340,
    y: workArea.y + workArea.height - 86,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false
  });
  pendingWin.setIgnoreMouseEvents(true);
  const hash = encodeURIComponent(JSON.stringify({ theme: settings.theme, text: tr("hud.pending"), pending: true }));
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

// Panneau flottant affichant le résumé des corrections (comme les extensions
// navigateur). Non focusable / cliquable-au-travers, auto-fermeture.
let summaryWin = null;
function hideSummary() {
  if (summaryWin && !summaryWin.isDestroyed()) summaryWin.destroy();
  summaryWin = null;
}
function showSummary(points) {
  hideSummary();
  if (!points || !points.length) return;
  const list = points.slice(0, 8);
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.min(340, 78 + list.length * 30); // en-tête (logo+marque) + lignes
  const width = 340;
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
  const text = String(message || "Une erreur inconnue est survenue. Merci de réessayer.");
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
function writeCorrectedRich(corrected, originalHtml) {
  const html = buildCorrectedHtml(originalHtml, corrected);
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

// ---------------------------------------------------------------------------
// Cœur : récupère la sélection, corrige, puis l'applique — tout de suite si la
// fenêtre d'origine est encore au premier plan, sinon dès qu'elle y revient
// (report d'application). Voir applyOrDefer.
// ---------------------------------------------------------------------------
async function correctSelection() {
  if (busy) { dbgv("déclenchement ignoré : une correction est déjà en cours"); return; }
  busy = true;
  updateTrayMenu();
  dbgv("═══════ correction START — tone=" + settings.tone + ", lang=" + settings.lang + ", isWin=" + winHelper.isWin);
  hideSummary(); // efface immédiatement le résumé précédent (avant même le spinner)
  hideError();   // efface une erreur précédente
  cancelPending();
  cancelRequested = false;
  currentAbort = null;
  let handedOff = false; // true dès que la suite (apply/report) prend la main sur busy
  let previousClipboard = ""; // déclaré ici pour être restauré aussi dans le catch (annulation)
  let selected = "";          // hoisté ici pour journaliser aussi un ÉCHEC depuis le catch
  let aiStart = 0;            // horodatage du début de l'appel IA (pour mesurer la durée)
  try {
    if (!settings.apiKey || !settings.apiKey.trim()) {
      showError(tr("err.noKey"));
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
    const SENTINEL = "__CORRECTIFY_SENTINEL_" + Date.now() + "_" + Math.floor(Math.random() * 1e9) + "__";
    clipboard.writeText(SENTINEL);
    await sleep(60);
    let seqRef = null;
    try { const r0 = await winHelper.clipseq(); seqRef = r0 && r0.seq; } catch {}
    dbgv("clipboard prepare : prev=" + preview(previousClipboard) + " | sentinelle posee, seqRef=" + seqRef);

    // Copier, avec PLUSIEURS tentatives si la sentinelle reste intacte : certaines
    // apps ratent le Ctrl+C simulé (Thunderbird/Gecko, éditeurs de code…). On
    // tourne sur 4 méthodes — Ctrl+C / Ctrl+Insert × helper (keybd_event, scan
    // codes) / SendKeys — pour couvrir les apps qui n'honorent qu'un sous-ensemble.
    selected = "";
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
      // Mode dry-run : pas de popup d'erreur, on enchaîne les tests sans rien empiler à l'écran.
      if (DEBUG_DRY_RUN) return;
      // Cible en administrateur : l'UIPI Windows bloque toute injection clavier ET
      // l'UIA → la copie ne POUVAIT pas aboutir. Message d'action plutôt qu'opaque.
      if (captured && captured.elevated) showError(tr("err.elevatedTarget"));
      else if (sawBlank) showError(tr("err.blankSelection")); // on a bien copié, mais que des blancs
      else showError(tr("err.noSelection"));
      return;
    }
    dbg("SELECTION OK " + preview(selected));   // ligne unique visible en mode minimal

    // Mode dry-run : on s'arrête là — pas d'appel IA (pas de quota), pas d'application.
    // On restaure le presse-papier d'origine et on masque le HUD. Le `finally` rendra la
    // main (endBusy()) puisqu'on n'a pas mis handedOff=true.
    if (DEBUG_DRY_RUN) {
      clipboard.writeText(previousClipboard);
      hideHud();
      return;
    }

    showHud(); // indicateur persistant pendant l'appel IA (avec bouton Annuler)

    // Appel IA interruptible : « Annuler » déclenche currentAbort.abort().
    currentAbort = new AbortController();
    aiStart = Date.now();
    dbgv("appel IA (provider=" + detectProvider(settings.apiKey) + ") sur " + preview(selected) + "…");
    const aiResult = await generateCorrection(
      settings.apiKey, buildPrompt(selected, settings.tone), { signal: currentAbort.signal }
    );

    // Annulé pendant l'appel : on restaure le presse-papier et on s'arrête net.
    if (cancelRequested) {
      hideHud();
      clipboard.writeText(previousClipboard);
      return;
    }

    const { corrected, summary } = parseCorrection(aiResult);
    dbgv("IA répondu en " + (Date.now() - aiStart) + "ms — corrigé " + preview(corrected) + ", résumé " + summary.length + " pt(s)");

    if (!corrected) {
      hideHud();
      clipboard.writeText(previousClipboard);
      recordCorrectionStat(selected.length, false, { message: "Réponse vide du service", code: "empty" }, Date.now() - aiStart); // stat + log
      showError(tr("err.empty"));
      return;
    }

    // Stat d'usage : correction réussie (non annulée). Compte les caractères du
    // texte soumis. Best-effort, non bloquant (cf. recordCorrectionStat).
    recordCorrectionStat(selected.length, true, null, Date.now() - aiStart);

    const usedHtml = writeCorrectedRich(corrected, selectedHtml);
    dbgv("presse-papier corrigé écrit (mise en forme html=" + usedHtml + ")");
    await sleep(120);

    // À partir d'ici, c'est applyOrDefer (et le cas échéant le report) qui gère
    // la fin et la libération de busy. On garde `original` (le texte sélectionné)
    // pour pouvoir le re-sélectionner par FindText si le curseur a bougé, et
    // `originalHtml` pour ré-affirmer le collage riche en cas de report.
    handedOff = true;
    await applyOrDefer({ target, corrected, summary, previousClipboard, original: selected, originalHtml: selectedHtml });
  } catch (e) {
    hideHud();
    hidePendingHud();
    if (cancelRequested) {
      clipboard.writeText(previousClipboard); // annulation : pas d'erreur, on restaure le presse-papier
    } else {
      // Échec AVANT toute application (réseau / service). Le garde !handedOff
      // évite un double comptage si l'erreur survient APRÈS une correction déjà
      // comptée comme réussie (ex. souci au collage). On joint le détail brut de
      // l'erreur (message + code HTTP ou type) pour la table `logs`.
      if (!handedOff) {
        recordCorrectionStat(selected.length, false, {
          message: (e && e.message) || "Erreur inconnue",
          code: (e && (e.status || e.kind)) || ""
        }, aiStart ? Date.now() - aiStart : undefined);
      }
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
    writeCorrectedRich(ctx.corrected, ctx.originalHtml);
    await sleep(60);
    let ok = false;
    // Éditions minimales (diff) : le chemin COM Word ne remplace QUE les portions
    // changées → la mise en forme variée du paragraphe (gras, couleurs…) est gardée.
    const edits = diffToEdits(ctx.original || "", ctx.corrected || "");
    dbgv("applyNow: immediate=" + immediate + ", " + edits.length + " édition(s) diff");
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
// Fenêtres : ajuste la hauteur AU CONTENU réel (pas de blanc en bas), plafonnée
// à l'écran. Au-delà du plafond (petit écran), .wrap (overflow-y:auto) scrolle.
// On mesure « barre de titre + hauteur réelle du contenu de .wrap » : la fenêtre
// est créée petite (show:false) donc le contenu déborde et scrollHeight est exact.
// ---------------------------------------------------------------------------
function autoSizeWindow(win, maxHeight) {
  if (!win || win.isDestroyed()) return;
  const measure =
    "(function(){var t=document.querySelector('.titlebar');var w=document.querySelector('.wrap');" +
    "return Math.ceil((t?t.offsetHeight:0)+(w?w.scrollHeight:document.body.scrollHeight));})()";
  win.webContents.executeJavaScript(measure).then((h) => {
    if (!win || win.isDestroyed()) return;
    const target = Math.max(220, Math.min(Number(h) || 0, Math.floor(maxHeight)));
    const [w] = win.getContentSize();
    win.setContentSize(w, target);
    win.center(); // re-centre après redimensionnement
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
  const maxH = screen.getPrimaryDisplay().workArea.height - 60;
  settingsWin = new BrowserWindow({
    width: 460,
    height: 160,             // provisoire : ajustée au contenu après chargement
    show: false,
    center: true,
    title: "Correctify",
    resizable: false,
    frame: false,            // pas de cadre/barre de titre Windows
    backgroundColor: windowBg(),
    icon: WINDOW_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  // Repli : si le renderer ne demande pas le redimensionnement (~1,5 s), on mesure
  // et on affiche quand même pour ne jamais laisser la fenêtre invisible.
  setTimeout(() => {
    if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.isVisible()) autoSizeWindow(settingsWin, maxH);
  }, 1500);
  settingsWin.on("closed", () => { settingsWin = null; });
}

// ---------------------------------------------------------------------------
// Fenêtre « Contact & retours » (bug / fonctionnalité / avis)
// ---------------------------------------------------------------------------
let contactWin = null;
function openContact() {
  if (contactWin && !contactWin.isDestroyed()) {
    contactWin.show();
    contactWin.focus();
    return;
  }
  const maxH = screen.getPrimaryDisplay().workArea.height - 60;
  contactWin = new BrowserWindow({
    width: 460,
    height: 160,             // provisoire : ajustée au contenu après chargement
    show: false,
    center: true,
    title: "Correctify",
    resizable: false,
    frame: false,
    backgroundColor: windowBg(),
    icon: WINDOW_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  contactWin.loadFile(path.join(__dirname, "contact.html"));
  setTimeout(() => {
    if (contactWin && !contactWin.isDestroyed() && !contactWin.isVisible()) autoSizeWindow(contactWin, maxH);
  }, 1500);
  contactWin.on("closed", () => { contactWin = null; });
}

// ---------------------------------------------------------------------------
// Fenêtre « Nouveautés » : après une mise à jour, montre clairement CE QUI a
// changé et POURQUOI (notes de version localisées, cf. changelog.js). Aussi
// ouvrable à la demande depuis le menu du tray. Renvoie true si une entrée de
// changelog existe pour la version (fenêtre affichée), false sinon — l'appelant
// peut alors retomber sur un simple toast.
// ---------------------------------------------------------------------------
let whatsNewWin = null;
function showWhatsNew(version, opts = {}) {
  // opts.all (clic tray « Nouveautés ») → tout l'historique, de la plus récente
  // à la plus ancienne. Sinon (après auto-update) → uniquement la version
  // installée. Dans les deux cas : pas de notes documentées ⇒ false (toast).
  const sections = opts.all
    ? getAllChangelogs(settings.lang)
    : (() => {
        const e = getChangelog(version, settings.lang);
        return e ? [{ version, title: e.title, points: e.points }] : [];
      })();
  if (!sections.length) return false;

  if (whatsNewWin && !whatsNewWin.isDestroyed()) {
    whatsNewWin.show();
    whatsNewWin.focus();
    return true;
  }

  const maxH = screen.getPrimaryDisplay().workArea.height - 60;
  whatsNewWin = new BrowserWindow({
    width: 460,
    height: 180,             // provisoire : ajustée au contenu après chargement
    show: false,
    center: true,
    title: "Correctify",
    resizable: false,
    frame: false,
    backgroundColor: windowBg(),
    icon: WINDOW_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });

  const payload = {
    theme: settings.theme,
    eyebrow: tr("whatsnew.eyebrow"),
    intro: opts.updated ? tr("whatsnew.updatedNote") : "", // ligne « mis à jour » seulement après update
    sections: sections.map((s) => ({
      version: tr("whatsnew.version", { version: s.version }),
      title: s.title,
      points: s.points
    })),
    button: tr("whatsnew.button"),
    closeTitle: tr("opt.closeTitle")
  };
  const hash = encodeURIComponent(JSON.stringify(payload));
  whatsNewWin.loadFile(path.join(__dirname, "whatsnew.html"), { hash });
  // Repli : si le renderer ne demande pas le redimensionnement (~1,5 s), on
  // mesure et on affiche quand même (jamais de fenêtre invisible).
  setTimeout(() => {
    if (whatsNewWin && !whatsNewWin.isDestroyed() && !whatsNewWin.isVisible()) autoSizeWindow(whatsNewWin, maxH);
  }, 1500);
  whatsNewWin.on("closed", () => { whatsNewWin = null; });
  return true;
}

// POST signé vers l'API du site : signe (timestamp + corps) en HMAC-SHA256 avec
// la clé partagée, puis envoie le JSON. La clé ne quitte jamais le process
// principal. Renvoie { res, json } (json = null si la réponse n'est pas du JSON).
async function apiPost(payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", API_KEY).update(ts + "\n" + body).digest("hex");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Correctify-Timestamp": ts,
      "X-Correctify-Signature": sig
    },
    body
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

// Envoi du formulaire de contact (action "mail" de l'API).
// Renvoie { ok } ou { ok:false, status, message }.
async function sendFeedbackMail({ category, name, email, message }) {
  // Catégorie en français (destinataire = le propriétaire) + nom dans le corps.
  const catLabel = { bug: "Bug / problème", feature: "Nouvelle fonctionnalité", feedback: "Avis / retour" }[category] || "Avis / retour";
  const header = `Catégorie : ${catLabel}` + (name ? `\nNom : ${name}` : "");
  const fullMessage = `${header}\n\n${(message || "").trim()}`;

  const payload = {
    action: "mail",
    type: "feedback",
    message: fullMessage,
    email: (email || "").trim(),
    app_version: app.getVersion(),
    os: `${process.platform} ${os.release()}`,
    nonce: crypto.randomBytes(16).toString("hex")
  };

  try {
    const { res, json } = await apiPost(payload);
    if (res.ok && json && json.success) return { ok: true };
    return { ok: false, status: res.status, message: (json && json.message) || "" };
  } catch (e) {
    return { ok: false, status: 0, message: String((e && e.message) || e) };
  }
}

// Journalise une correction pour les statistiques d'usage (action "correction"
// de l'API) : date posée côté serveur, nombre de caractères du texte soumis,
// langue (1 = FR, 2 = EN) et statut (succès / échec).
//
// Le COMPTEUR est TOUJOURS envoyé (obligatoire, anonyme : ni texte, ni IP, ni
// identifiant). Le DÉTAIL d'un échec (`err` = { message, code }), qui alimente la
// table `logs`, n'est joint QUE si l'utilisateur a laissé les rapports d'erreur
// activés (settings.sendStats). Best-effort, NON bloquant : on n'attend pas la
// réponse et toute erreur est ignorée — les stats ne doivent jamais perturber l'app.
function recordCorrectionStat(charCount, success, err, durationMs) {
  const chars = Math.max(0, Math.floor(Number(charCount) || 0));
  if (!chars) return;
  const payload = {
    action: "correction",
    chars,
    lang: settings.lang === "en" ? 2 : 1,
    tone: settings.tone || "standard",          // ton de correction utilisé
    provider: detectProvider(settings.apiKey),  // google / openai / anthropic
    status: success ? 1 : 0,                     // 1 = succès, 0 = échec
    source: isMac ? "mac" : "windows",
    app_version: app.getVersion(),               // corréler les erreurs à une version
    nonce: crypto.randomBytes(16).toString("hex")
  };
  const ms = Math.floor(Number(durationMs));     // durée de l'appel IA (ms), si mesurée
  if (Number.isFinite(ms) && ms >= 0) payload.duration_ms = ms;
  // Détail d'erreur → table `logs`, uniquement si les rapports d'erreur sont activés.
  if (!success && err && settings.sendStats !== false) {
    payload.message = String(err.message || "").slice(0, 500);
    const code = err.code;
    if (code !== undefined && code !== null && code !== "") payload.code = String(code).slice(0, 20);
  }
  apiPost(payload).catch(() => { /* best-effort : ignoré en cas d'échec réseau */ });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function updateTrayMenu() {
  if (!tray) return;
  const provider = settings.apiKey ? detectProvider(settings.apiKey) : null;
  const providerLabel = { google: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic Claude" }[provider];

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

  const menu = Menu.buildFromTemplate([
    { label: `Correctify v${app.getVersion()}`, enabled: false }, // version de l'app
    { type: "separator" },
    {
      label: busy ? tr("tray.working") : tr("tray.correct", { hotkey: settings.hotkey }),
      enabled: !busy,
      click: () => correctSelection()
    },
    { label: tr("tray.tone"), submenu: toneSubmenu },
    { type: "separator" },
    {
      label: settings.apiKey ? tr("tray.provider", { provider: providerLabel }) : tr("tray.noKey"),
      enabled: false
    },
    { label: tr("tray.options"), click: () => openSettings() },
    { label: tr("tray.feedback"), click: () => openContact() },
    { label: tr("tray.whatsNew"), click: () => { if (!showWhatsNew(app.getVersion(), { all: true })) notify(tr("whatsnew.none")); } },
    { label: tr("tray.checkUpdates"), click: () => checkForUpdates(true) },
    { type: "separator" },
    { label: tr("tray.support"), click: () => shell.openExternal(PAYPAL_URL) },
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
  // Thème changé : ré-aligne le fond NATIF des fenêtres ouvertes (le CSS suit déjà
  // via data-theme) pour qu'un redimensionnement ne laisse pas un bord clair.
  const bg = windowBg();
  for (const w of [settingsWin, contactWin, whatsNewWin]) {
    if (w && !w.isDestroyed()) w.setBackgroundColor(bg);
  }
  updateTrayMenu();
  return settings;
});

ipcMain.handle("open-external", (_evt, url) => shell.openExternal(url));

ipcMain.handle("close-settings", () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

ipcMain.handle("close-contact", () => {
  if (contactWin && !contactWin.isDestroyed()) contactWin.close();
});

ipcMain.handle("close-whatsnew", () => {
  if (whatsNewWin && !whatsNewWin.isDestroyed()) whatsNewWin.close();
});

// Envoi du formulaire de contact (signature HMAC côté main, clé jamais exposée).
ipcMain.handle("send-feedback", (_evt, payload) => sendFeedbackMail(payload || {}));



// Bouton « Annuler » du toast de correction.
ipcMain.handle("cancel-correction", () => cancelCorrection());

// Le renderer (options / contact) demande l'ajustement de SA fenêtre à la hauteur
// réelle de son contenu, une fois l'i18n appliquée → aucun blanc en bas.
ipcMain.handle("resize-to-content", (evt, h) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win || win.isDestroyed()) return;
  const maxH = screen.getPrimaryDisplay().workArea.height - 60;
  const target = Math.max(220, Math.min(Math.ceil(Number(h) || 0), Math.floor(maxH)));
  const [w] = win.getContentSize();
  win.setContentSize(w, target);
  win.center();
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

  const currentVersion = app.getVersion();
  if (!fileExists()) {
    // Tout premier lancement : langue d'interface d'après l'OS (fr si OS en
    // français, en sinon) + on mémorise la version (pas de toast « mis à jour »).
    const sys = (app.getLocale() || "").toLowerCase();
    settings = saveSettings({ ...settings, lang: sys.startsWith("fr") ? "fr" : "en", lastVersion: currentVersion });
  } else {
    // Mise à jour appliquée depuis le dernier lancement → on montre clairement
    // ce qui a changé via la fenêtre « Nouveautés ». Si la version n'a pas de
    // notes documentées (changelog.js), on retombe sur le toast de confirmation.
    if (settings.lastVersion && compareVersions(currentVersion, settings.lastVersion) > 0) {
      setTimeout(() => {
        if (!showWhatsNew(currentVersion, { updated: true })) {
          notify(tr("update.updated", { version: currentVersion }));
        }
      }, 1500);
    }
    if (settings.lastVersion !== currentVersion) settings = saveSettings({ ...settings, lastVersion: currentVersion });
  }

  createTray();
  registerHotkey();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });

  // Démarre le host PowerShell persistant (Windows) : il charge UI Automation
  // une fois pour toutes → la 1ʳᵉ correction n'attend pas ce chargement.
  winHelper.start();
  setupAutoUpdater(); // branche les évènements de mise à jour automatique

  if (!settings.apiKey) openSettings(); // première utilisation

  setTimeout(() => checkForUpdates(false), 4000); // vérif silencieuse au démarrage
  // Puis vérification en arrière-plan toutes les heures (silencieuse : ne notifie
  // que si une nouvelle version sort, une seule fois par version cf. lastNotifiedVersion).
  updateTimer = setInterval(() => checkForUpdates(false), 60 * 60 * 1000);
});

// On garde l'app vivante même sans fenêtre (c'est une app de tray).
app.on("window-all-closed", () => { /* ne pas quitter */ });
app.on("will-quit", () => {
  // Garde-fou : si l'app se ferme avant d'être prête (ex. 2ᵉ instance qui
  // quitte aussitôt), globalShortcut n'est pas encore utilisable.
  if (app.isReady()) globalShortcut.unregisterAll();
  if (updateTimer) clearInterval(updateTimer);
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
