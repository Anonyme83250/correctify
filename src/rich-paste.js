// ---------------------------------------------------------------------------
// Transfert de mise en forme (Windows & macOS, tout éditeur riche).
//
// Quand on copie (Ctrl+C), l'app source (Word, Outlook, Thunderbird, navigateur,
// Teams…) place AUSSI une version HTML de la sélection dans le presse-papier.
// Plutôt que de relire le format via UI Automation (qui échoue dans Thunderbird),
// on part de ce HTML d'origine et on n'y applique QUE les corrections de texte :
//
//   1) on découpe le HTML en jetons « balise » (opaques) et « caractère visible »
//   2) on calcule un diff caractère-à-caractère entre le texte d'origine du HTML
//      et le texte corrigé
//   3) on reconstruit le HTML : balises conservées telles quelles, caractères
//      égaux gardés, supprimés retirés, ajoutés insérés DANS le contexte de
//      formatage courant (donc gras/couleur/police hérités du mot voisin).
//
// Résultat : « tabl » → « table » reste gras, « votre » reste violet, un titre
// garde sa police/taille/couleur — sans uniformiser ni casser la mise en forme.
// ---------------------------------------------------------------------------
"use strict";

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };

function decodeEntity(ent) {
  if (Object.prototype.hasOwnProperty.call(ENTITIES, ent)) return ENTITIES[ent];
  let m = /^&#(\d+);$/.exec(ent);
  if (m) { try { return String.fromCodePoint(parseInt(m[1], 10)); } catch { return ent; } }
  m = /^&#x([0-9a-fA-F]+);$/.exec(ent);
  if (m) { try { return String.fromCodePoint(parseInt(m[1], 16)); } catch { return ent; } }
  return ent; // entité inconnue : on la garde telle quelle (1 « caractère » opaque)
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Diff caractère-à-caractère par LCS (DP). Renvoie [{ type:'='|'-'|'+', str }].
// Le texte corrigé étant proche de l'original (fautes corrigées), le diff reste
// petit ; un garde-fou de taille dans buildCorrectedHtml borne le coût O(n*m).
function diffChars(a, b) {
  const n = a.length, m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  const push = (type, ch) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.str += ch; else ops.push({ type, str: ch });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("=", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("-", a[i]); i++; }
    else { push("+", b[j]); j++; }
  }
  while (i < n) { push("-", a[i]); i++; }
  while (j < m) { push("+", b[j]); j++; }
  return ops;
}

// Isole le contenu utile : corps du document si HTML complet, sans les blocs
// <style>/<script> (leur contenu n'est pas du texte visible) ni les commentaires
// (les marqueurs CF_HTML « StartFragment » notamment).
function extractFragment(html) {
  let h = html;
  const bodyStart = h.search(/<body\b[^>]*>/i);
  if (bodyStart >= 0) {
    const after = h.slice(bodyStart).replace(/^<body\b[^>]*>/i, "");
    const bodyEnd = after.search(/<\/body>/i);
    h = bodyEnd >= 0 ? after.slice(0, bodyEnd) : after;
  }
  h = h.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  return h;
}

// Découpe en jetons : { tag:true, v } (balise opaque) ou { tag:false, v, plain }
// (caractère visible ; v = encodage HTML d'origine, plain = caractère décodé).
function tokenize(html) {
  const tokens = [];
  const plain = [];
  const len = html.length;
  let i = 0;
  while (i < len) {
    const c = html[i];
    if (c === "<") {
      let end = html.indexOf(">", i);
      if (end < 0) end = len - 1;
      tokens.push({ tag: true, v: html.slice(i, end + 1) });
      i = end + 1;
    } else if (c === "&") {
      const end = html.indexOf(";", i);
      if (end > i && end - i <= 12) {
        const ent = html.slice(i, end + 1);
        const dec = decodeEntity(ent);
        tokens.push({ tag: false, v: ent, plain: dec });
        plain.push(dec);
        i = end + 1;
      } else {
        tokens.push({ tag: false, v: "&amp;", plain: "&" });
        plain.push("&");
        i++;
      }
    } else {
      tokens.push({ tag: false, v: escapeHtml(c), plain: c });
      plain.push(c);
      i++;
    }
  }
  return { tokens, plain: plain.join("") };
}

// Construit le HTML corrigé à partir du HTML d'origine et du texte corrigé.
// Renvoie null si rien d'exploitable (source en texte brut, HTML vide, ou
// sélection trop grosse pour le diff) → l'appelant colle alors du texte brut.
function buildCorrectedHtml(originalHtml, correctedText) {
  if (!originalHtml || typeof originalHtml !== "string" || typeof correctedText !== "string") return null;
  const frag = extractFragment(originalHtml).trim();
  if (!frag) return null;
  const { tokens, plain } = tokenize(frag);
  if (!plain.trim()) return null;
  // Garde-fou perf (diff O(n*m)) : au-delà on renonce → collage texte brut.
  if (plain.length > 8000 || correctedText.length > 8000) return null;

  const ops = diffChars(plain, correctedText);

  // Reconstruction. Les balises sont mises EN ATTENTE (pending) et émises seulement
  // juste avant un caractère GARDÉ — jamais pendant une suppression. Ainsi, quand on
  // supprime des blancs de fin (retours à la ligne du source HTML après </h1> p.ex.),
  // on n'« évacue » pas les balises de fermeture avant le texte inséré : le texte
  // ajouté reste DANS le bon run/bloc (le « es » de « matières » reste dans le <h1>).
  let out = "";
  let pending = "";
  let ti = 0;
  let started = false; // a-t-on déjà gardé/inséré un caractère ? (gère l'insertion en tête)
  const eatTags = () => { while (ti < tokens.length && tokens[ti].tag) { pending += tokens[ti].v; ti++; } };
  const flushPending = () => { out += pending; pending = ""; };
  const nextCharToken = () => { eatTags(); return (ti < tokens.length && !tokens[ti].tag) ? tokens[ti++] : null; };

  for (const op of ops) {
    if (op.type === "=") {
      for (let k = 0; k < op.str.length; k++) {
        const t = nextCharToken();
        flushPending();                 // émet les balises précédant ce caractère gardé
        if (t) out += t.v;
        started = true;
      }
    } else if (op.type === "-") {
      for (let k = 0; k < op.str.length; k++) nextCharToken(); // saute le caractère ; balises -> pending
    } else { // '+'
      if (!started) { eatTags(); flushPending(); } // insertion en tête : ouvrir les balises d'abord
      out += escapeHtml(op.str);        // sinon : rester dans le contexte du caractère précédent
      started = true;
    }
  }
  eatTags();        // ramasse d'éventuelles balises de fin restantes
  flushPending();   // puis émet toutes les balises en attente (fermetures)
  while (ti < tokens.length) { out += tokens[ti].v; ti++; } // sécurité

  return out;
}

// Convertit le diff (orig → corrigé) en une liste d'ÉDITIONS minimales
// { s, e, t } : « remplacer orig[s..e) par t ». Les régions inchangées ne
// produisent pas d'édition (donc leur mise en forme n'est jamais touchée).
// On ignore les sauts de ligne de FIN (¶) des deux côtés : ainsi aucune édition
// ne référence la marque de paragraphe finale → pas de fusion de paragraphes.
// Les offsets restent valides dans `orig` (on ne rogne que la fin).
function diffToEdits(orig, corrected) {
  if (typeof orig !== "string" || typeof corrected !== "string") return [];
  const a = orig.replace(/[\r\n]+$/, "");
  const b = corrected.replace(/[\r\n]+$/, "");
  const ops = diffChars(a, b);
  const edits = [];
  let pos = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "=") { pos += ops[i].str.length; i++; continue; }
    const start = pos;
    let del = "", ins = "";
    while (i < ops.length && ops[i].type !== "=") {
      if (ops[i].type === "-") del += ops[i].str; else ins += ops[i].str;
      i++;
    }
    pos += del.length;
    edits.push({ s: start, e: start + del.length, t: ins });
  }
  return edits;
}

module.exports = { buildCorrectedHtml, diffChars, diffToEdits, tokenize, extractFragment };
