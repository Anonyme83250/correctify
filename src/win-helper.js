// ---------------------------------------------------------------------------
// Pilote du host PowerShell persistant (Windows uniquement) — voir win-helper.ps1.
//
// Un seul process powershell.exe reste vivant toute la session : il charge UI
// Automation une fois et garde en mémoire la fenêtre + la sélection capturées,
// ce qui permet le report d'application (re-sélectionner et coller plus tard,
// même après un changement de fenêtre).
//
// Protocole : on écrit une requête JSON par ligne sur stdin, on lit les réponses
// préfixées « __CF__ » sur stdout. Chaque requête porte un id, résolu à la
// réponse correspondante. Tout échec (process absent, timeout) rejette la
// promesse → main.js retombe sur l'ancienne méthode (SendKeys inline).
// ---------------------------------------------------------------------------
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEBUG, DEBUG_VERBOSE, dbgv, preview } = require("./debug");

const isWin = process.platform === "win32";
const PREFIX = "__CF__";

let proc = null;
let stdoutBuffer = "";
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

// La source .ps1 est embarquée dans l'app (éventuellement dans app.asar) : on
// l'extrait vers un fichier temporaire pour que powershell -File puisse la lire.
function extractScript() {
  const src = fs.readFileSync(path.join(__dirname, "win-helper.ps1"), "utf8");
  const dest = path.join(os.tmpdir(), "correctify-win-helper.ps1");
  fs.writeFileSync(dest, src, "utf8");
  return dest;
}

function start() {
  if (!isWin || proc) return;
  try {
    const scriptPath = extractScript();
    proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", scriptPath],
      // CF_DEBUG : pris en compte côté .ps1 pour journaliser sur stderr (cf. debug.js).
      { windowsHide: true, env: Object.assign({}, process.env, { CF_DEBUG: DEBUG ? "1" : "0" }) }
    );
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", onStdout);
    // On DOIT drainer stderr (sinon blocage si le helper est bavard). En debug, on
    // relaie ses lignes « [PS …] » vers notre console pour suivre ce que voit le host.
    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      // Relai des lignes « [PS …] » uniquement en mode VERBEUX — sinon, silence
      // total côté helper pour ne pas polluer la console des tests à la chaîne.
      proc.stderr.on("data", (d) => { if (DEBUG && DEBUG_VERBOSE) process.stderr.write(d); });
    }
    dbgv("helper PowerShell démarré (pid=" + proc.pid + ")");
    proc.on("exit", onExit);
    proc.on("error", onExit);
  } catch {
    proc = null;
  }
}

function onStdout(chunk) {
  stdoutBuffer += chunk;
  let nl;
  while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, nl).trim();
    stdoutBuffer = stdoutBuffer.slice(nl + 1);
    const at = line.indexOf(PREFIX);
    if (at < 0) continue; // ligne parasite éventuelle
    let obj;
    try { obj = JSON.parse(line.slice(at + PREFIX.length)); } catch { continue; }
    const entry = pending.get(obj.id);
    if (entry) {
      pending.delete(obj.id);
      clearTimeout(entry.timer);
      if (DEBUG && DEBUG_VERBOSE) {
        const o = Object.assign({}, obj);
        if (typeof o.text === "string") o.text = preview(o.text); // pas de déversement de texte long
        dbgv("← ps #" + obj.id, JSON.stringify(o));
      }
      entry.resolve(obj);
    }
  }
}

function onExit() {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("helper terminé"));
  }
  pending.clear();
  stdoutBuffer = "";
  proc = null;
}

function request(action, params = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error("non-Windows"));
    if (!proc) start();
    if (!proc) return reject(new Error("helper indisponible"));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("helper: délai dépassé (" + action + ")"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    dbgv("→ ps." + action + " #" + id);
    // JSON.stringify échappe les sauts de ligne (\n) → la requête reste sur une
    // seule ligne, on peut donc transmettre du texte multi-ligne sans risque.
    const payload = Object.assign({ id, action }, params || {});
    try {
      proc.stdin.write(JSON.stringify(payload) + "\n");
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function stop() {
  if (!proc) return;
  try { proc.stdin.end(); } catch {}
  try { proc.kill(); } catch {}
  proc = null;
}

module.exports = {
  isWin,
  start,
  stop,
  available: () => isWin && !!proc,
  capture: () => request("capture", null, 6000),
  // Attend (côté helper) le relâchement physique des modificateurs du raccourci avant
  // la copie simulée → évite que Ctrl+C devienne Ctrl+Alt+C (« Aucun texte sélectionné »).
  waitKeysUp: () => request("waitkeysup", null, 2000),
  copy: () => request("copy", null, 4000),
  // Ctrl+Insert : combinaison de copie alternative honorée par la plupart des apps
  // Win32 et par Gecko (Firefox/Thunderbird). Utile quand Ctrl+C est intercepté.
  copyIns: () => request("copyins", null, 4000),
  paste: () => request("paste", null, 4000),
  // Numéro de séquence du presse-papier (debug) : dit si un copier a eu lieu.
  clipseq: () => request("clipseq", null, 3000),
  foreground: () => request("foreground", null, 4000),
  // originalText : le texte exact qui était sélectionné, pour le repli FindText.
  // immediate : true si la fenêtre n'a jamais perdu le premier plan (sélection
  // d'origine encore vivante) → le helper colle direct sans re-sélectionner.
  // corrected : texte corrigé, utilisé par le chemin COM Word (repli global).
  // edits : éditions minimales [{s,e,t}] (diff) pour le chemin COM Word par portions.
  // Les textes sont transmis en base64 (UTF-8) : le canal stdin de PowerShell n'est
  // pas en UTF-8 par défaut, ce qui corromprait les accents (é, è…).
  apply: (originalText, immediate, corrected, edits) =>
    request("apply", {
      text_b64: Buffer.from(originalText || "", "utf8").toString("base64"),
      immediate: !!immediate,
      corrected_b64: Buffer.from(corrected || "", "utf8").toString("base64"),
      edits_b64: Buffer.from(JSON.stringify(edits || []), "utf8").toString("base64")
    }, 12000)
};
