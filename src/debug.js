// ---------------------------------------------------------------------------
// Débogage — un seul interrupteur.
//
// À `true`, l'app journalise tout le flux de correction sur la CONSOLE : capture
// de la fenêtre/sélection, chaque tentative de copie (Ctrl+C) et son résultat,
// l'appel IA, puis l'application. Le host PowerShell journalise lui aussi (sur
// stderr, relayé vers la même console par win-helper.js).
//
// La console est visible quand l'app est lancée via `npm start`. Pratique pour
// comprendre un « Aucun texte sélectionné » (ex. Firefox/Gecko, où l'UIA ne voit
// rien et seul le Ctrl+C compte).
// ---------------------------------------------------------------------------
"use strict";

const DEBUG = false;
// Verbosité — `false` = on n'affiche QUE le résultat final (« SELECTION OK » /
// « SELECTION KO »). `true` = tout le détail (capture, chaque tentative de copie,
// IA, application, et les lignes [PS …] du helper).
const DEBUG_VERBOSE = false;

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

// Translittère en ASCII : la console Windows (CMD) n'est pas en UTF-8 par défaut →
// les accents et symboles ressortent en charabia (« é » → « ├® », « → » → « ÔåÆ »).
// On rend donc tous les logs lisibles en ASCII pur.
function sanitize(s) {
  return String(s)
    .replace(/→/g, "->").replace(/←/g, "<-")
    .replace(/[«»“”]/g, '"')                 // guillemets courbes/français → "
    .replace(/[‘’‛′]/g, "'")       // apostrophes courbes/prime → '
    .replace(/…/g, "...")
    .replace(/[═─]/g, "=").replace(/[—–]/g, "-").replace(/✗/g, "X").replace(/✓/g, "OK")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // retire les diacritiques (é→e…)
    .replace(/[^\x00-\x7F]/g, "?");                   // tout autre non-ASCII → '?'
}

// Journalise une ligne préfixée + horodatée. No-op si DEBUG est false. Réservé
// aux ÉVÉNEMENTS CLÉS (« SELECTION OK / KO »).
function dbg(...args) {
  if (!DEBUG) return;
  console.log("[CF " + ts() + "]", ...args.map((a) => (typeof a === "string" ? sanitize(a) : a)));
}

// Variante VERBEUSE : ne s'affiche qu'en mode DEBUG_VERBOSE. Pour le détail
// pas-à-pas (capture, chaque tentative de copie, IA, application).
function dbgv(...args) {
  if (!DEBUG || !DEBUG_VERBOSE) return;
  console.log("[CF " + ts() + "]", ...args.map((a) => (typeof a === "string" ? sanitize(a) : a)));
}

// Aperçu SÛR d'un texte pour les logs : longueur + court extrait sur une seule
// ligne (les \r \n \t sont rendus visibles), tronqué.
function preview(s, max = 60) {
  if (s == null) return "null";
  const str = String(s);
  const oneLine = str.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  const cut = oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
  return "len=" + str.length + " «" + cut + "»";
}

module.exports = { DEBUG, DEBUG_VERBOSE, dbg, dbgv, preview };
