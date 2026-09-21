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
//
// Invariant du diff : UN jeton caractère = UN élément comparé. Le HTML est parcouru
// par POINT DE CODE (un emoji = 1 jeton, jamais coupé en deux moitiés UTF-16), et
// la STRUCTURE du texte fait partie des caractères comparés : <br> et fins de bloc
// valent "\n", une image-emoji vaut son emoji (cf. tokenize). Sans cela, ces
// balises restaient « en attente » et un « M » ajouté par l'IA en début de ligne
// sortait AVANT le saut (« …Evently. M⏎aintenant »), et l'emoji-image de Teams
// ressortait au milieu du mot suivant.
// ---------------------------------------------------------------------------
"use strict";

// Entités nommées : les 5 de base + celles que des clients mail écrivent encore
// en clair (accents, typographie). Une entité inconnue reste un jeton opaque.
const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
  "&eacute;": "é", "&egrave;": "è", "&ecirc;": "ê", "&euml;": "ë", "&agrave;": "à", "&acirc;": "â",
  "&ccedil;": "ç", "&ugrave;": "ù", "&ucirc;": "û", "&uuml;": "ü", "&icirc;": "î", "&iuml;": "ï",
  "&ocirc;": "ô", "&ouml;": "ö", "&oelig;": "œ", "&Eacute;": "É", "&Egrave;": "È", "&Agrave;": "À",
  "&Ccedil;": "Ç", "&OElig;": "Œ", "&euro;": "€", "&hellip;": "…", "&ndash;": "–", "&mdash;": "—",
  "&lsquo;": "‘", "&rsquo;": "’", "&ldquo;": "“", "&rdquo;": "”", "&laquo;": "«", "&raquo;": "»",
  "&bull;": "•", "&middot;": "·", "&copy;": "©", "&reg;": "®", "&trade;": "™", "&deg;": "°",
  "&shy;": "\u00AD", "&zwnj;": "\u200C", "&zwj;": "\u200D", "&thinsp;": "\u2009", "&ensp;": "\u2002", "&emsp;": "\u2003"
};

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

// Valeur d'un attribut d'une balise (guillemets doubles ou simples), entités décodées.
function attrOf(tag, name) {
  const m = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
  if (!m) return "";
  return (m[1] !== undefined ? m[1] : m[2]).replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, decodeEntity);
}

// « Est un emoji » : uniquement des pictogrammes (drapeaux, tons de peau,
// séquences ZWJ, sélecteur FE0F compris), court, sans lettre ni chiffre — un
// logo de signature (<img alt="Logo">) n'en est pas un.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}])+$/u;
const cleanEmoji = (s) => String(s || "").replace(/[\s\u200B\u2060\uFEFF]/g, ""); // blancs/invisibles de bordure
function isEmoji(s) {
  s = cleanEmoji(s);
  return !!s && s.length <= 24 && EMOJI_ONLY.test(s) && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(s);
}

// L'emoji que repr\u00E9sente une balise (image, ou l'enveloppe qui la porte), d'apr\u00E8s
// ce que chaque \u00E9diteur y met : N'IMPORTE QUEL attribut dont la valeur est l'emoji
// lui-m\u00EAme (alt, aria-label, data-*\u2026 et l'improbable itemscope="\uD83D\uDE04" de Teams, dont
// l'itemid est un simple nom : \u00AB grinningfacewithsmilingeyes \u00BB), sinon son point
// de code en hexa dans un identifiant ou l'URL (\u00AB 1f604_\u2026 \u00BB). "" si rien.
function emojiOfTag(tag) {
  const re = /\s[a-z][\w:.-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(tag))) {
    const v = (m[1] !== undefined ? m[1] : m[2]).replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, decodeEntity);
    if (isEmoji(v)) return cleanEmoji(v);
  }
  for (const name of ["itemid", "data-itemid", "src", "data-src"]) {
    const m = /(?:^|[\/_-])(1f[0-9a-f]{3}|[23][0-9a-f]{3})(?:[_\/.-]|$)/i.exec(attrOf(tag, name));
    if (m) { const e = String.fromCodePoint(parseInt(m[1], 16)); if (isEmoji(e)) return e; }
  }
  return "";
}

// Le NOM de l'emoji (ce que Teams recopie en texte brut \u00E0 la place de l'image) :
// title / aria-label / alt, le premier qui soit du texte et non l'emoji lui-m\u00EAme.
function labelOfTag(tag) {
  for (const name of ["title", "aria-label", "alt"]) {
    const v = attrOf(tag, name).trim();
    if (v && !isEmoji(v)) return v;
  }
  return "";
}

// Diff élément par élément par LCS (DP). `a` et `b` sont des tableaux, ou des
// chaînes alors découpées par POINT DE CODE (un emoji n'est jamais coupé en deux).
// Renvoie [{ type:'='|'-'|'+', str, n }] : str = éléments concaténés, n = leur nombre.
// Le texte corrigé étant proche de l'original (fautes corrigées), le diff reste
// petit ; un garde-fou de taille dans buildCorrectedHtml borne le coût O(n*m).
function diffChars(a, b) {
  if (typeof a === "string") a = Array.from(a);
  if (typeof b === "string") b = Array.from(b);
  const n = a.length, m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  const push = (type, el) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) { last.str += el; last.n++; } else ops.push({ type, str: el, n: 1 });
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

// Balises qui comptent comme des CARACTÈRES visibles (jetons `atomic`), pour que
// la structure du texte soit vue par le diff au lieu de rester « en attente » :
//   - <br>                          → "\n" ;
//   - fin de bloc (</p>, </div>, </li>, </h1>…) → "\n", avec `keep` : même si l'IA
//     a supprimé ce saut (paragraphes fusionnés), la balise est conservée pour
//     garder un HTML équilibré — le texte reste alors sur deux paragraphes ;
//   - <img alt="😄">                 → l'emoji : Teams, Outlook web… copient leurs
//     emojis en image dont l'alt EST l'emoji. Gardé → l'image reste à sa place ;
//     supprimé par l'IA → l'image disparaît. Un alt non-emoji reste opaque.
const BR_RE = /^<br\b/i;
const BLOCK_END_RE = /^<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)\b/i;

// Découpe en jetons : { tag:true, v } (balise opaque) ou { tag:false, v, plain }
// (caractère visible ; v = encodage HTML d'origine, plain = caractère décodé).
// Parcours par POINT DE CODE. `chars` = un élément par jeton caractère (l'entrée
// du diff : l'invariant « 1 jeton = 1 élément » tient quelle que soit la longueur
// de plain, entité inconnue comprise) ; `plain` = leur concaténation.
function tokenize(html) {
  const tokens = [];
  const chars = [];
  const len = html.length;
  let i = 0;
  const pushChar = (t) => { tokens.push(t); chars.push(t.plain); };
  while (i < len) {
    const c = String.fromCodePoint(html.codePointAt(i));
    if (c === "<") {
      let end = html.indexOf(">", i);
      if (end < 0) end = len - 1;
      const tag = html.slice(i, end + 1);
      i = end + 1;
      if (BR_RE.test(tag)) pushChar({ tag: false, v: tag, plain: "\n", atomic: true });
      else if (BLOCK_END_RE.test(tag)) pushChar({ tag: false, v: tag, plain: "\n", atomic: true, keep: true });
      else {
        const e = tag[1] === "/" ? "" : emojiOfTag(tag);
        if (!e) tokens.push({ tag: true, v: tag });
        else if (/^<img\b/i.test(tag)) pushChar({ tag: false, v: tag, plain: e, atomic: true });
        else {
          // Enveloppe porteuse de l'emoji (<readonly itemid=…> de Teams) : l'élément
          // ENTIER, jusqu'à sa fermeture, est un seul jeton emoji (l'image nue qu'il
          // contient n'a alors rien à dire).
          const name = /^<([a-z][a-z0-9]*)/i.exec(tag)[1];
          const m = new RegExp("</" + name + "\\s*>", "i").exec(html.slice(i));
          const inner = m ? html.slice(i, i + m.index + m[0].length) : "";
          i += inner.length;
          pushChar({ tag: false, v: tag + inner, plain: e, atomic: true });
        }
      }
    } else if (c === "&") {
      const end = html.indexOf(";", i);
      if (end > i && end - i <= 12) {
        const ent = html.slice(i, end + 1);
        pushChar({ tag: false, v: ent, plain: decodeEntity(ent) });
        i = end + 1;
      } else {
        pushChar({ tag: false, v: "&amp;", plain: "&" });
        i++;
      }
    } else {
      // Un saut de ligne LITTÉRAL du source HTML n'est qu'un blanc à l'écran (il
      // s'affiche comme une espace, ou rien en bordure de bloc) : comparé comme
      // une espace, pour que le "\n" du corrigé s'aligne sur le <br>/la fin de bloc
      // voisins et non sur cette indentation. Le jeton garde sa valeur d'origine.
      pushChar({ tag: false, v: escapeHtml(c), plain: (c === "\n" || c === "\r") ? " " : c });
      i += c.length;
    }
  }
  return { tokens, chars, plain: chars.join("") };
}

// Aligne le corrigé sur la REPRÉSENTATION du HTML avant le diff. Le texte brut que
// l'app source met dans le presse-papier (celui qu'a vu l'IA) ne rend pas les sauts
// de ligne comme le HTML : Teams écrit "\n\n" pour CHAQUE fin de ligne là où le
// HTML n'a qu'une fin de bloc → l'IA rend fidèlement "\n\n", et le second "\n"
// deviendrait un <br> (ligne vide en trop). Un diff entre le texte du HTML et le
// texte brut d'origine repère les blancs que ce dernier a EN PLUS (insertions
// pures ; un &nbsp; devenu espace est une substitution, pas concernée) ; on les
// retire du corrigé partout où l'IA les a gardés, et dans ce qu'elle a AJOUTÉ les
// sauts doublés sont ramenés à un seul. Sans texte d'origine : corrigé tel quel.
function alignCorrected(htmlPlain, sourceText, corrected) {
  if (!sourceText || typeof sourceText !== "string") return corrected;
  const src = Array.from(sourceText.replace(/\r\n?/g, "\n"));
  if (src.length > MAX_DIFF) return corrected;
  const ops1 = diffChars(Array.from(htmlPlain), src);
  const extra = new Uint8Array(src.length); // 1 = blanc du texte brut absent du HTML
  let j = 0, doubled = false;
  for (let k = 0; k < ops1.length; k++) {
    const op = ops1[k];
    if (op.type === "-") continue;
    if (op.type === "+") {
      const pure = /^\s+$/.test(op.str) && !(k > 0 && ops1[k - 1].type === "-") && !(k + 1 < ops1.length && ops1[k + 1].type === "-");
      if (pure) { for (let q = 0; q < op.n; q++) extra[j + q] = 1; if (op.str.includes("\n")) doubled = true; }
    }
    j += op.n;
  }
  if (!extra.some((x) => x)) return corrected;
  const cor = Array.from(corrected);
  const ops2 = diffChars(src, cor);
  let out = "";
  let a = 0, b = 0;
  for (const op of ops2) {
    if (op.type === "=") { for (let q = 0; q < op.n; q++) if (!extra[a + q]) out += cor[b + q]; a += op.n; b += op.n; }
    else if (op.type === "-") a += op.n;
    else { out += doubled ? op.str.replace(/\n\n/g, "\n") : op.str; b += op.n; }
  }
  return out;
}

// Garde perf du diff O(n*m) : au-delà on renonce → collage texte brut.
const MAX_DIFF = 8000;

// Construit le HTML corrigé à partir du HTML d'origine et du texte corrigé.
// `sourceText` (optionnel) = le texte brut d'origine tel qu'envoyé à l'IA, pour
// aligner sa représentation des sauts de ligne sur celle du HTML (cf. alignCorrected).
// Renvoie null si rien d'exploitable (source en texte brut, HTML vide, ou
// sélection trop grosse pour le diff) → l'appelant colle alors du texte brut.
function buildCorrectedHtml(originalHtml, correctedText, sourceText) {
  if (!originalHtml || typeof originalHtml !== "string" || typeof correctedText !== "string") return null;
  const frag = extractFragment(originalHtml).trim();
  if (!frag) return null;
  const { tokens, chars, plain } = tokenize(frag);
  if (!plain.trim()) return null;
  // Fins de ligne du corrigé → "\n", comme les jetons <br>/fin de bloc.
  const corrected = alignCorrected(plain, sourceText, correctedText.replace(/\r\n?/g, "\n"));
  if (plain.length > MAX_DIFF || corrected.length > MAX_DIFF) return null;

  const ops = diffChars(chars, Array.from(corrected));

  // Reconstruction. Les balises sont mises EN ATTENTE (pending) et émises seulement
  // juste avant un caractère GARDÉ — jamais pendant une suppression. Ainsi, quand on
  // supprime des blancs de fin (retours à la ligne du source HTML après </h1> p.ex.),
  // on n'« évacue » pas les balises de fermeture avant le texte inséré : le texte
  // ajouté reste DANS le bon run/bloc (le « es » de « matières » reste dans le <h1>).
  // Exception : juste après un jeton `atomic` gardé (fin de ligne, emoji-image), une
  // insertion s'écrit APRÈS les balises en attente — dans le paragraphe suivant, hors
  // de l'enveloppe de l'image — et non avant (« M⏎aintenant », virgule dans l'emoji).
  let out = "";
  let pending = "";
  let ti = 0;
  let started = false; // a-t-on déjà gardé/inséré un caractère ? (gère l'insertion en tête)
  let openFirst = false; // dernier caractère gardé = jeton atomic → ouvrir les balises avant d'insérer
  const eatTags = () => { while (ti < tokens.length && tokens[ti].tag) { pending += tokens[ti].v; ti++; } };
  const flushPending = () => { out += pending; pending = ""; };
  const nextCharToken = () => { eatTags(); return (ti < tokens.length && !tokens[ti].tag) ? tokens[ti++] : null; };

  for (const op of ops) {
    if (op.type === "=") {
      for (let k = 0; k < op.n; k++) {
        const t = nextCharToken();
        flushPending();                 // émet les balises précédant ce caractère gardé
        if (t) out += t.v;
        started = true;
        openFirst = !!(t && t.atomic);
      }
    } else if (op.type === "-") {
      for (let k = 0; k < op.n; k++) {
        const t = nextCharToken();      // saute le caractère ; balises -> pending
        if (t && t.keep) pending += t.v; // fin de bloc supprimée par l'IA : balise conservée (HTML équilibré)
      }
    } else { // '+'
      if (!started || openFirst) { eatTags(); flushPending(); } // en tête / après un atomic : ouvrir les balises d'abord
      out += escapeHtml(op.str).replace(/\n/g, "<br>"); // sinon : rester dans le contexte du caractère précédent ; saut ajouté → vrai <br>
      started = true;
      openFirst = false;
    }
  }
  eatTags();        // ramasse d'éventuelles balises de fin restantes
  flushPending();   // puis émet toutes les balises en attente (fermetures)
  while (ti < tokens.length) { out += tokens[ti].v; ti++; } // sécurité

  return out;
}

// ---------------------------------------------------------------------------
// Emojis copiés en IMAGE (Teams, entre autres) : <img alt="😄" title="Visage
// souriant avec yeux rieurs">. Dans la version TEXTE du presse-papier, Teams
// remplace l'image par ce TITRE, sur un paragraphe à part — et c'est ce texte qui
// partait à l'IA, qui prenait « Visage souriant avec yeux rieurs » pour une phrase
// à corriger : gardée telle quelle (le nom du smiley écrit dans le mail), réécrite
// en un autre emoji, ou supprimée, au hasard. On remet l'emoji (l'alt) à la place
// de son titre avant l'appel ; le texte redevient aussi cohérent avec les jetons
// emoji de buildCorrectedHtml (l'emoji est alors GARDÉ par le diff, image en place).
// Ne touche à rien si le HTML n'a pas d'image-emoji titrée : renvoie le texte tel quel.
// ---------------------------------------------------------------------------
// Balises de STRUCTURE (bloc, <br>) pour lire le contexte d'un objet ; tout autre
// balise (span, enveloppe <readonly>, img) est « en ligne » et transparente.
const BLOCK_NAMES = "p|div|li|h[1-6]|tr|td|th|blockquote|pre";
const INLINE_TAG = "<\\/?(?!(?:" + BLOCK_NAMES + "|br)\\b)[a-z][^>]*>";
const BLANK_OR_INLINE_BEFORE = new RegExp("(?:[\\s\\u200B\\u2060\\uFEFF]|" + INLINE_TAG + ")*$", "i");
const BLANK_OR_INLINE_AFTER = new RegExp("^(?:[\\s\\u200B\\u2060\\uFEFF]|" + INLINE_TAG + ")*", "i");
const ENDS_WITH_BLOCK = new RegExp("(?:<(?:\\/?(?:" + BLOCK_NAMES + ")|br)\\b[^>]*>|^)$", "i");
const STARTS_WITH_BLOCK = new RegExp("^(?:<(?:\\/?(?:" + BLOCK_NAMES + ")|br)\\b|$)", "i");

function restoreEmojiText(text, html) {
  if (!text || typeof text !== "string" || !html || typeof html !== "string") return text;
  let out = text;
  // Les objets du HTML et les titres du texte se suivent dans le MÊME ordre : on
  // remplace le 1er titre encore devant le curseur, objet après objet (deux emojis
  // identiques peuvent avoir des contextes différents).
  let pos = 0;
  // Emoji et nom peuvent être portés par la même balise (<img alt="😄" title="…">)
  // ou répartis entre l'enveloppe et l'image (<readonly itemscope="😄"><img alt="…">) :
  // on les accumule sur des balises CONSÉCUTIVES (sans texte entre elles) jusqu'à
  // avoir les deux ; une balise fermante ou du texte remet le compteur à zéro.
  const re = /<\/?[a-z][a-z0-9]*\b[^>]*>/gi;
  const fresh = () => ({ emoji: "", label: "", start: -1 });
  let carry = fresh();
  let lastEnd = 0;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/^[\s​⁠﻿]*$/.test(html.slice(lastEnd, m.index))) carry = fresh();
    lastEnd = m.index + tag.length;
    if (tag[1] === "/") { carry = fresh(); continue; }
    if (carry.start < 0) carry.start = m.index;
    carry.emoji = carry.emoji || emojiOfTag(tag);
    carry.label = carry.label || labelOfTag(tag);
    if (!carry.emoji || !carry.label) continue;
    const { emoji, label, start } = carry;
    carry = fresh();

    // Fin de l'objet : la balise elle-même, ou sa fermeture si c'est une enveloppe.
    let end = lastEnd;
    if (!/^<img\b/i.test(tag)) {
      const name = /^<([a-z][a-z0-9]*)/i.exec(tag)[1];
      const c = new RegExp("</" + name + "\\s*>", "i").exec(html.slice(end));
      if (c) end += c.index + c[0].length;
    }
    // L'objet commence-t-il / termine-t-il sa ligne dans le HTML ? Teams recopie
    // le titre entre deux « \n\n » quoi qu'il arrive, ce qui absorbe un vrai saut de
    // paragraphe voisin : on le remet d'après le HTML, seule source fiable.
    const lineStart = ENDS_WITH_BLOCK.test(html.slice(0, start).replace(BLANK_OR_INLINE_BEFORE, ""));
    const lineEnd = STARTS_WITH_BLOCK.test(html.slice(end).replace(BLANK_OR_INLINE_AFTER, ""));

    // Le titre SEUL, isolé par des sauts de paragraphe (ou en début/fin de texte).
    // On n'en mange jamais plus de deux de chaque côté. Le même titre au milieu
    // d'une phrase n'est pas touché.
    const t = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp("(?:^|(?:\\r?\\n){1,2})" + t + "(?:(?:\\r?\\n){1,2}|$)", "g");
    rx.lastIndex = pos;
    const hit = rx.exec(out);
    if (!hit) continue;
    const before = out.slice(0, hit.index), after = out.slice(hit.index + hit[0].length);
    const rep = (lineStart && before && !/\n$/.test(before) ? "\n" : "") + emoji +
                (lineEnd && after && !/^\r?\n/.test(after) ? "\n" : "");
    out = before + rep + after;
    pos = before.length + rep.length;
  }
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

module.exports = { buildCorrectedHtml, restoreEmojiText, diffChars, diffWordEdits, tokenize, extractFragment };
