// ---------------------------------------------------------------------------
// Débogage — UN SEUL interrupteur global.
//
// À `true`, l'app journalise TOUT le flux de correction sur la CONSOLE : capture
// de la fenêtre/sélection, chaque tentative de copie (Ctrl+C) et son résultat,
// l'appel IA, puis l'application. Le host PowerShell journalise lui aussi (sur
// stderr, relayé vers la même console par win-helper.js).
//
// La console est visible quand l'app est lancée via `npm start` / simul.bat
// (fenêtre CMD). Pratique pour comprendre un « Aucun texte sélectionné » (ex.
// Firefox/Gecko, où l'UIA ne voit rien et seul le Ctrl+C compte).
//
// ⚠️  REMETTRE À false AVANT DE PUBLIER (dist.bat) : inutile en production.
// ---------------------------------------------------------------------------
"use strict";

const DEBUG = false;
// Verbosité — `false` = on n'affiche QUE le résultat final (« SELECTION OK » /
// « SELECTION KO »). `true` = on affiche tout le détail (capture, chaque tentative
// de copie, IA, application, et les lignes [PS …] du helper). À mettre à `true`
// quand on chasse un bug précis, sinon laisser à `false` pour des tests à la chaîne.
const DEBUG_VERBOSE = false;
// Mode dry-run : `true` = on s'ARRÊTE juste après la décision SELECTION OK/KO,
// SANS appeler l'IA (pas de quota consommé) et SANS popup d'erreur (pas d'écrans
// qui s'empilent pendant des tests à la chaîne). Le presse-papier est restauré.
// Pratique pour tester la capture sur plein d'apps sans rien dépenser.
// ⚠️  REMETTRE À false POUR UN USAGE RÉEL (sinon plus aucune correction n'est appliquée).
const DEBUG_DRY_RUN = false;

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

// Journalise une ligne préfixée + horodatée. No-op si DEBUG est false. Tous les
// arguments chaîne sont rendus ASCII (cf. sanitize) avant l'affichage. Toujours
// affiché en mode debug — réservé aux ÉVÉNEMENTS CLÉS (« SELECTION OK / KO »).
function dbg(...args) {
  if (!DEBUG) return;
  console.log("[CF " + ts() + "]", ...args.map((a) => (typeof a === "string" ? sanitize(a) : a)));
}

// Variante VERBEUSE : ne s'affiche qu'en mode DEBUG_VERBOSE. Pour le détail
// pas-à-pas (capture, chaque tentative de copie, IA, application). Permet de
// laisser DEBUG=true pour voir le résultat de chaque test, sans noyer la console.
function dbgv(...args) {
  if (!DEBUG || !DEBUG_VERBOSE) return;
  console.log("[CF " + ts() + "]", ...args.map((a) => (typeof a === "string" ? sanitize(a) : a)));
}

// Aperçu SÛR d'un texte pour les logs : longueur + court extrait sur une seule
// ligne (les \r \n \t sont rendus visibles), tronqué. Évite de déverser un texte
// long et garde les logs lisibles.
function preview(s, max = 60) {
  if (s == null) return "null";
  const str = String(s);
  const oneLine = str.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  const cut = oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
  return "len=" + str.length + " «" + cut + "»";
}

module.exports = { DEBUG, DEBUG_VERBOSE, DEBUG_DRY_RUN, dbg, dbgv, preview };
