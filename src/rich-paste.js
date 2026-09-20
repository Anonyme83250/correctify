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

// ---------------------------------------------------------------------------
// Éditions minimales pour le chemin COM Word/Outlook (win-helper.ps1, 'apply').
//
// Les éditions { s, e, t } (« remplacer plage[s..e) par t ») sont calculées SUR LE
// TEXTE MÊME de la plage Word figée à la capture (Range.Text, renvoyé par le host
// dans `wtext`) : les offsets indexent directement le document (base + s) et sont
// donc valides PAR CONSTRUCTION — aucune dépendance à la représentation du
// presse-papier (\r\n vs \r, sauts doux \v, marques de cellule, insécables, puces).
//
// Le corrigé de l'IA, lui, dérive du texte PRESSE-PAPIER : les deux textes ne
// diffèrent que par ces représentations. On diffe donc des VUES normalisées
// 1 caractère pour 1 (même longueur que les originaux) où ces équivalences sont
// neutralisées → elles ne génèrent AUCUNE édition, et le document GARDE ses vrais
// caractères (apostrophes courbes, insécables, sauts doux) là où rien n'a changé.
// ---------------------------------------------------------------------------

// Fins de ligne → CR seul (la convention de Word : 1 caractère par marque de ¶).
function toCR(s) {
  return (s || "").replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

// Vue de COMPARAISON, strictement 1 pour 1 (les offsets restent valides) :
// neutralise les différences de représentation Word ↔ presse-papier/IA.
function alignView(s) {
  return s
    .replace(/\u0007/g, "\t")                // marque de cellule Word → tabulation
    .replace(/\v/g, "\r")                    // saut de ligne doux (Maj+Entrée) → fin de ligne
    .replace(/[\u00A0\u202F]/g, " ")         // espaces insécables → espace
    .replace(/[\u2018\u2019\u201B]/g, "'")   // apostrophes courbes → droite
    .replace(/[\u201C\u201D\u201E]/g, '"');  // guillemets doubles courbes → droits
}

// Garde perf du diff O(n*m) — même ordre de grandeur que buildCorrectedHtml.
const MAX_WORD_DIFF = 8000;

// Renvoie les éditions à appliquer sur la plage Word, ou null si le diff n'est
// pas exploitable (texte trop grand, corrigé sans rapport avec la plage…) →
// l'appelant n'envoie alors rien et le host retombe sur word-affix / collage.
function diffWordEdits(wordRaw, correctedText) {
  if (typeof wordRaw !== "string" || !wordRaw || typeof correctedText !== "string") return null;
  if (wordRaw.length > MAX_WORD_DIFF || correctedText.length > MAX_WORD_DIFF) return null;
  const corrCR = toCR(correctedText);
  // Sauts de ligne de FIN ignorés des deux côtés : aucune édition ne référence la
  // marque de paragraphe finale → pas de fusion de paragraphes. (On ne rogne que
  // la fin : les offsets restent valides dans wordRaw.)
  const a = alignView(wordRaw).replace(/[\r\n]+$/, "");
  const b = alignView(corrCR).replace(/[\r\n]+$/, "");
  if (!a.length) return null;

  const ops = diffChars(a, b);

  // Garde de pertinence : au moins la MOITIÉ de la plage doit se retrouver dans le
  // corrigé en runs CONTIGUS (≥ 3 caractères). Le simple cumul de caractères commun
  // ne prouve rien : le LCS caractère par caractère matche « par confetti » ~40 %
  // entre deux phrases sans AUCUN rapport (mauvaise cible, réécriture massive) →
  // seuls les runs continus témoignent d'un vrai texte corrigé. En dessous : pas
  // d'édition COM, le host retombe sur word-affix / collage (jamais de corruption).
  let solid = 0;
  for (const op of ops) if (op.type === "=" && op.str.length >= 3) solid += op.str.length;
  if (solid * 2 < a.length) return null;

  // Reconstruit les éditions en positions RAW : s/e indexent wordRaw tel quel, et
  // t est découpé dans corrCR réel (les vues étant 1:1, les indices se
  // correspondent) → le texte inséré garde les caractères de l'IA (insécables compris).
  const edits = [];
  let pa = 0, pb = 0, i = 0;
  while (i < ops.length) {
    if (ops[i].type === "=") { pa += ops[i].str.length; pb += ops[i].str.length; i++; continue; }
    const s = pa, bs = pb;
    while (i < ops.length && ops[i].type !== "=") {
      if (ops[i].type === "-") pa += ops[i].str.length; else pb += ops[i].str.length;
      i++;
    }
    edits.push({ s, e: pa, t: corrCR.slice(bs, pb) });
  }

  const atLineStart = (ed) => ed.s === 0 || wordRaw[ed.s - 1] === "\r" || wordRaw[ed.s - 1] === "\v";
  return edits.filter((ed) => {
    // Numérotation/puces AUTOMATIQUES : présentes dans le presse-papier (donc dans
    // le corrigé) mais PAS dans Range.Text → le diff les voit comme des insertions
    // en début de ligne. Les insérer écrirait la numérotation EN DOUBLE : écartées.
    if (ed.s === ed.e && atLineStart(ed) && /^(?:[0-9a-z]{1,3}[.)]|[•·◦▪‣o§*-])\t/i.test(ed.t)) return false;
    // Marqueurs spéciaux de Word (notes de bas de page, annotations, cellules) :
    // une édition qui les recouvre supprimerait l'objet → on n'y touche jamais.
    if (/[\u0001\u0002\u0005\u0007]/.test(wordRaw.slice(ed.s, ed.e))) return false;
    return true;
  });
}

module.exports = { buildCorrectedHtml, diffChars, diffWordEdits, tokenize, extractFragment };
