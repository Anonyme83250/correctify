// Appel IA : construit la requête, réessaie sur les erreurs transitoires
// (backoff exponentiel + jitter), et traduit les échecs en messages clairs.
//
// Aucun fournisseur n'est codé en dur : l'utilisateur saisit lui-même l'URL de
// base, le modèle et sa clé dans les options. Ce module ne connaît que trois
// FORMES de dialogue HTTP — `kind` :
//   - "openai"    : tout ce qui est compatible OpenAI ({base}/chat/completions).
//                   Couvre OpenAI, Mistral, OpenRouter, Groq, Ollama, LM Studio,
//                   LiteLLM, vLLM et les serveurs maison.
//   - "google"    : Gemini ({base}/models/{modèle}:generateContent?key=…)
//   - "anthropic" : Claude ({base}/messages)

const { t } = require("./i18n");

// Erreurs transitoires (surcharge serveur / quota court) : on réessaie.
// 529 = « overloaded » d'Anthropic ; 502/504 = passerelles/timeout amont.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;

// Codes HTTP pour lesquels on a un message dédié (clé i18n "err.http.<code>"),
// communs aux trois formes d'API.
const KNOWN_STATUS = new Set([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504, 529]);

// URL de base habituelle de chaque forme d'API : proposée dans les options quand
// le champ est encore vide, jamais imposée.
const DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1",
  anthropic: "https://api.anthropic.com/v1"
};

// Traduit une erreur (HTTP, réseau, timeout…) en message clair, dans la langue
// de l'interface. On n'affiche jamais le code brut.
function describeError(err, lang) {
  const status = err && err.status;
  // 404 sur un modèle nommé : on le nomme. « Modèle introuvable » tout court
  // n'aide personne à comprendre QUEL réglage revoir.
  if (status === 404 && err.model) return t(lang, "err.modelUnknown", { model: err.model });
  if (status) {
    if (KNOWN_STATUS.has(status)) return t(lang, "err.http." + status);
    if (status >= 500) return t(lang, "err.serverDown");
    if (status >= 400) return t(lang, "err.refused");
  }
  const kind = err && err.kind;
  const msg = (err && err.message) || "";
  // URL ou modèle absent des réglages : on renvoie vers les options plutôt
  // qu'un message technique.
  if (kind === "config") return t(lang, "err.provider");
  if (kind === "timeout" || /délai|timeout/i.test(msg)) return t(lang, "err.timeout");
  if (kind === "network" || /network|fetch|failed|ENOTFOUND|ECONN|getaddrinfo/i.test(msg)) {
    return t(lang, "err.network");
  }
  return t(lang, "err.unknown");
}

// Une entrée par FORME de dialogue HTTP (cf. l'en-tête du fichier). L'URL de
// base vient des réglages : c'est elle qui distingue OpenAI de Mistral,
// d'OpenRouter ou du serveur Ollama de l'utilisateur, tous « compatibles OpenAI ».
const KINDS = {
  openai: {
    buildRequest(base, apiKey, model, prompt) {
      const headers = { "Content-Type": "application/json" };
      // Serveur local sans authentification (Ollama, LM Studio) : pas d'en-tête
      // Authorization du tout — certains refusent un Bearer vide.
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      return {
        url: `${base}/chat/completions`,
        options: {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] })
        }
      };
    },
    extractText: (json) => json.choices[0].message.content
  },
  google: {
    buildRequest(base, apiKey, model, prompt) {
      return {
        url: `${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      };
    },
    extractText: (json) => json.candidates[0].content.parts[0].text
  },
  anthropic: {
    buildRequest(base, apiKey, model, prompt) {
      return {
        url: `${base}/messages`,
        options: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] })
        }
      };
    },
    // Lecture robuste : la réponse Anthropic est un TABLEAU de blocs et le
    // premier n'est pas forcément du texte. On cherche donc le premier bloc
    // { type:"text" } au lieu de supposer content[0].
    extractText: (json) => {
      const blocks = Array.isArray(json && json.content) ? json.content : [];
      const block = blocks.find((b) => b && b.type === "text" && typeof b.text === "string");
      return block ? block.text : "";
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch avec délai maximal : sans ça, derrière un proxy d'entreprise l'appel
// peut rester bloqué indéfiniment (« correction en cours » figé).
async function fetchWithTimeout(url, options, ms = 20000, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Lien avec un éventuel signal externe (annulation par l'utilisateur).
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

function abortError() {
  const e = new Error("Annulé");
  e.kind = "abort";
  return e;
}

// Détail d'erreur renvoyé par le fournisseur : Anthropic, OpenAI et Google
// partagent la forme { error: { type, message } }. On le remonte pour un
// diagnostic clair ; le message MONTRÉ à l'utilisateur reste, lui, dérivé du
// code HTTP via describeError (jamais le détail brut). Repli sur le code HTTP
// si le corps est vide / non-JSON.
async function readApiErrorMessage(response, status) {
  try {
    const data = await response.clone().json();
    const e = data && data.error;
    const msg = e && (e.message || e.type);
    if (msg) return String(msg);
  } catch { /* corps vide ou non-JSON */ }
  return `Erreur HTTP ${status}`;
}

/**
 * Corrige `prompt` auprès de l'API configurée par l'utilisateur.
 *
 * @param {object} config  { baseUrl, apiKind, apiKey, model } — tels que saisis
 *   dans la fenêtre d'options.
 * @returns {Promise<{text: string, model: string}>} le texte brut du modèle.
 */
async function generateCorrection(config, prompt, options = {}) {
  const { signal, onRetry } = options;
  const { baseUrl = "", apiKind = "openai", apiKey = "", model = "" } = config || {};

  const base = String(baseUrl).trim().replace(/\/+$/, "");
  const wanted = String(model).trim();
  if (!base || !wanted) {
    const e = new Error("API non configurée");
    e.kind = "config";
    throw e;
  }

  const kind = KINDS[apiKind] || KINDS.openai;
  const { url, options: reqOptions } = kind.buildRequest(base, apiKey, wanted, prompt);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) throw abortError(); // annulation : on n'insiste pas
    let response = null;
    try {
      response = await fetchWithTimeout(url, reqOptions, 20000, signal);
    } catch (networkError) {
      // Annulation utilisateur : remonte sans réessayer.
      if (signal && signal.aborted) throw abortError();
      // Coupure réseau / proxy / timeout : traitée comme transitoire.
      if (networkError.name === "AbortError") {
        lastError = new Error("Délai dépassé (réseau ou proxy)");
        lastError.kind = "timeout";
      } else {
        networkError.kind = "network";
        lastError = networkError;
      }
    }

    if (response && response.ok) {
      const json = await response.json();
      return { text: kind.extractText(json), model: wanted };
    }

    const status = response ? response.status : 0;

    // Modèle inconnu du fournisseur (404) : réessayer est inutile, il n'existe
    // pas — ou pas pour cette clé. On le NOMME dans l'erreur pour que le message
    // dise quel réglage revoir.
    if (status === 404) {
      const err404 = new Error(await readApiErrorMessage(response, 404));
      err404.status = 404;
      err404.model = wanted;
      throw err404;
    }

    // Erreur définitive (clé invalide, requête malformée…) : inutile de réessayer.
    if (response && !RETRYABLE_STATUS.has(status)) {
      const err = new Error(await readApiErrorMessage(response, status));
      err.status = status;
      throw err;
    }

    lastError = new Error(`Service indisponible (${status || "réseau"})`);
    if (status) lastError.status = status; // garde le code pour un message clair
    if (attempt === MAX_ATTEMPTS) break;

    // Backoff exponentiel + jitter : ~1s, 2s, 4s.
    const delay = Math.pow(2, attempt - 1) * 1000 + Math.floor(Math.random() * 500);
    if (onRetry) onRetry();
    await sleep(delay);
  }

  throw lastError || new Error("Échec de la correction");
}

// ---------------------------------------------------------------------------
// Langue du texte corrigé
// ---------------------------------------------------------------------------
// Tant qu'on CORRIGE, le modèle recopie le texte en le retouchant : la langue
// suit toute seule. Dès qu'un TON est choisi, en revanche, le texte est réécrit
// de zéro — et un modèle rapide écrit alors dans la langue de ses CONSIGNES, pas
// dans celle du texte. D'où le bug : un texte anglais revenait traduit en
// français dès qu'on choisissait « Professionnel ».
//
// Deux parades, cumulées :
//   1. la langue est décidée ICI (réglage « Langue de correction », sinon
//      détection locale) puis NOMMÉE dans le prompt : « ce texte est en anglais,
//      réponds en anglais » est autrement mieux suivi que « détecte la langue » ;
//   2. quand elle est connue, TOUT le prompt (consignes, description du ton,
//      rappel final) est écrit dans cette langue : plus rien ne tire vers le
//      français.
// Langue indécise (texte trop court, ou 3ᵉ langue) : prompt français, avec une
// consigne de détection renforcée.

// Mots-outils très fréquents, choisis NON ambigus entre les deux langues ("a",
// "on", "no", "son", "en", "or", "pour"… sont volontairement absents : ils
// existent des deux côtés ou risquent de se croiser).
const LANG_MARKERS = {
  fr: /\b(?:le|la|les|des|du|une|et|est|sont|été|être|vous|nous|je|tu|qui|que|quoi|dans|avec|pas|ne|sur|aux|ce|cet|cette|ces|mais|donc|par|très|tout|tous|toute|aussi|comme|alors|fait|faire|avez|avons|suis|votre|notre|leur|bonjour|merci|cordialement|veuillez|cela|ici|où|déjà|encore)\b/gi,
  en: /\b(?:the|and|is|are|was|were|to|of|you|your|we|our|they|their|this|that|these|those|with|for|from|have|has|had|will|would|can|could|should|about|there|here|what|when|which|who|not|it|its|be|been|being|hello|hi|thanks|thank|regards|please|dear|best|any|all|because|however|also|just|more|than|then|them|his|her|him|she|he)\b/gi
};

// Les accents ne prouvent pas le français à eux seuls (une citation, un nom
// propre) — ils pèsent donc comme deux mots-outils, pas davantage.
const ACCENTS = /[àâäçéèêëîïôöùûüÿœæ]/i;

// Nom de la langue, écrit dans la langue du prompt : LANG_LABEL[prompt][cible].
const LANG_LABEL = {
  fr: { fr: "français", en: "anglais" },
  en: { fr: "French", en: "English" }
};

/** "fr" / "en" si la valeur en est une, "" sinon (y compris "auto"). */
function normalizeLang(value) {
  const v = String(value || "").trim().toLowerCase();
  return (v === "fr" || v === "en") ? v : "";
}

/**
 * Devine la langue d'un texte : "fr", "en", ou "" quand c'est indécis — texte
 * trop court, mélange, ou troisième langue. Volontairement simple : on ne
 * cherche pas à trancher entre vingt langues, seulement à savoir quand on peut
 * NOMMER la langue au modèle plutôt que de la lui faire deviner.
 */
function detectLanguage(text) {
  const s = String(text || "");
  if (!s.trim()) return "";
  const fr = (s.match(LANG_MARKERS.fr) || []).length + (ACCENTS.test(s) ? 2 : 0);
  const en = (s.match(LANG_MARKERS.en) || []).length;
  if (fr > en) return "fr";
  if (en > fr) return "en";
  return ""; // égalité (0-0 compris) : on laisse le modèle décider
}

// Tons de reformulation (clés alignées sur settings.tone et les clés i18n
// "tone.*"), dans les deux langues de prompt : une description française au
// milieu d'un prompt anglais suffirait à ramener la réponse en français.
const TONE_INSTRUCTIONS = {
  fr: {
    professional: "un ton professionnel : clair, direct et structuré, adapté à un échange formel en entreprise",
    courteous: "un ton courtois et chaleureux : aimable, poli et bienveillant",
    concise: "un style concis : droit au but, sans superflu, avec des phrases courtes",
    formal: "un registre soutenu et formel : vocabulaire précis et tournures élégantes, adapté à un courrier officiel ou administratif",
    simplified: "un style simple et accessible : phrases claires, vocabulaire courant, facile à lire",
    joking: "un ton blagueur et léger : décontracté et plein d'humour, avec des touches drôles, des clins d'œil ou des jeux de mots bien placés, tout en gardant le message clair et compréhensible"
  },
  en: {
    professional: "a professional tone: clear, direct and well structured, suited to a formal business exchange",
    courteous: "a courteous, warm tone: friendly, polite and considerate",
    concise: "a concise style: straight to the point, no filler, short sentences",
    formal: "a formal, elevated register: precise vocabulary and elegant turns of phrase, suited to an official or administrative letter",
    simplified: "a simple, accessible style: clear sentences, everyday words, easy to read",
    joking: "a light, joking tone: relaxed and full of humour, with funny touches, winks or well-placed puns, while keeping the message clear and easy to understand"
  }
};

/** Prompt français. `lang` vaut "fr", ou "" quand la langue reste à détecter. */
function promptFr({ text, toneDesc, lang, imposed, summaryLang }) {
  const name = lang ? LANG_LABEL.fr[lang] : "";
  // Langue IMPOSÉE par l'utilisateur : on ne prétend pas que le texte est déjà
  // dans cette langue — s'il ne l'est pas, c'est bien une traduction qui est
  // demandée. Langue DÉDUITE du texte : on la nomme, et on interdit de traduire.
  const langRule = !name
    ? "- Repère la langue du texte ci-dessous et écris ta correction dans CETTE langue, quelle qu'elle soit. Ne traduis JAMAIS le texte : la langue de ces consignes n'a aucune influence sur celle de ta réponse."
    : imposed
      ? `- Écris ta correction en ${name} : c'est la langue demandée par l'utilisateur, n'en emploie aucune autre.`
      : `- Le texte ci-dessous est en ${name} : écris ta correction en ${name}. Ne le traduis JAMAIS dans une autre langue.`;
  const summaryRule = summaryLang === "en" ? "EN ANGLAIS" : "EN FRANÇAIS";
  const reminder = name
    ? `\n\nRappel : la partie ###CORRECTION### doit être écrite en ${name}, comme le texte ci-dessus.`
    : "\n\nRappel : la partie ###CORRECTION### doit être écrite dans la langue du texte ci-dessus, pas dans celle de ces consignes.";

  if (!toneDesc) {
    return `Tu es un correcteur professionnel.
Corrige l'orthographe, la grammaire, la syntaxe et la fluidité du texte ci-dessous.

RÈGLES :
${langRule}
- Conserve le ton (tutoiement/vouvoiement), le sens exact et la mise en forme simple (sauts de ligne, listes).
- N'ajoute, ne supprime et ne reformule rien inutilement.

FORMAT DE SORTIE — réponds EXACTEMENT ainsi, sans markdown, sans bloc de code, sans rien avant ni après :
###CORRECTION###
(ici uniquement le texte corrigé, en texte brut)
###RESUME###
(ici la liste des corrections, ${summaryRule}, UNE PAR LIGNE, chacune préfixée par "- ", courte et concrète — ex. « - Orthographe : "sa" → "ça" », « - Accord du participe passé ». Si aucune correction n'est nécessaire, écris une seule ligne : "- Aucune erreur détectée.")

Texte :
"${text}"${reminder}`;
  }

  return `Tu es un assistant de rédaction professionnel.
Corrige et reformule le texte ci-dessous pour qu'il adopte ${toneDesc}.

RÈGLES :
${langRule}
- Corrige toutes les fautes d'orthographe, de grammaire et de syntaxe.
- Tu peux restructurer et réécrire librement les phrases pour adopter pleinement le ton demandé.
- Conserve le sens, les informations et les faits du texte d'origine ; n'invente rien et n'ajoute aucune information.
- Conserve le tutoiement/vouvoiement d'origine et la mise en forme simple (sauts de ligne, listes).

FORMAT DE SORTIE — réponds EXACTEMENT ainsi, sans markdown, sans bloc de code, sans rien avant ni après :
###CORRECTION###
(ici uniquement le texte reformulé, en texte brut)
###RESUME###
(ici un court résumé des changements apportés, ${summaryRule}, UNE PUCE PAR LIGNE préfixée par "- ", brève et concrète — ex. « - Reformulé dans un ton professionnel », « - Phrases raccourcies ». Maximum 3 puces.)

Texte :
"${text}"${reminder}`;
}

/** Prompt anglais, employé dès que le texte à corriger est en anglais. */
function promptEn({ text, toneDesc, imposed, summaryLang }) {
  const langRule = imposed
    ? "- Write your answer in English: that is the language the user asked for, use no other."
    : "- The text below is in English: write your answer in English. NEVER translate it into another language.";
  const summaryRule = summaryLang === "en" ? "IN ENGLISH" : "IN FRENCH";
  const reminder = "\n\nReminder: the ###CORRECTION### part must be written in English, like the text above.";

  if (!toneDesc) {
    return `You are a professional proofreader.
Correct the spelling, grammar, syntax and flow of the text below.

RULES:
${langRule}
- Keep the original tone, the exact meaning and the simple formatting (line breaks, lists).
- Do not add, remove or rephrase anything unnecessarily.

OUTPUT FORMAT — answer EXACTLY like this, no markdown, no code block, nothing before or after:
###CORRECTION###
(here only the corrected text, as plain text)
###RESUME###
(here the list of corrections, ${summaryRule}, ONE PER LINE, each prefixed with "- ", short and concrete — e.g. « - Spelling: "recieve" → "receive" », « - Subject-verb agreement ». If no correction is needed, write a single line: "- No error found.")

Text:
"${text}"${reminder}`;
  }

  return `You are a professional writing assistant.
Correct and rewrite the text below so that it adopts ${toneDesc}.

RULES:
${langRule}
- Fix every spelling, grammar and syntax mistake.
- You may restructure and rewrite the sentences freely to fully adopt the requested tone.
- Keep the meaning, the information and the facts of the original text; invent nothing and add no information.
- Keep the original level of formality and the simple formatting (line breaks, lists).

OUTPUT FORMAT — answer EXACTLY like this, no markdown, no code block, nothing before or after:
###CORRECTION###
(here only the rewritten text, as plain text)
###RESUME###
(here a short summary of the changes, ${summaryRule}, ONE BULLET PER LINE prefixed with "- ", brief and concrete — e.g. « - Rewritten in a professional tone », « - Shorter sentences ». Three bullets maximum.)

Text:
"${text}"${reminder}`;
}

/**
 * Construit le prompt : texte (corrigé ou reformulé) + résumé, séparés par des
 * marqueurs faciles à parser. Le ton "standard" (ou inconnu) corrige sans
 * reformuler ; les autres tons réécrivent librement le texte dans le ton voulu,
 * en corrigeant.
 *
 * @param {string} text   texte sélectionné par l'utilisateur.
 * @param {string} tone   clé de TONE_INSTRUCTIONS, ou "standard".
 * @param {object} options
 *   - forceLang : "fr" / "en" pour imposer la langue de la correction,
 *     "auto" (ou vide) pour la détecter à partir du texte ;
 *   - uiLang : langue de l'INTERFACE, dans laquelle le résumé est rédigé — c'est
 *     un retour d'information pour l'utilisateur, pas une partie du texte.
 */
function buildPrompt(text, tone = "standard", options = {}) {
  const imposed = normalizeLang(options.forceLang);
  const lang = imposed || detectLanguage(text);
  const promptLang = lang || "fr"; // indécis → prompt français + règle générique
  const toneDesc = TONE_INSTRUCTIONS[promptLang][tone];
  const summaryLang = normalizeLang(options.uiLang) || "fr";
  const build = promptLang === "en" ? promptEn : promptFr;
  return build({ text, toneDesc, lang, imposed: !!imposed, summaryLang });
}

// Sépare le texte corrigé et la liste des corrections à partir des marqueurs.
// Renvoie { corrected: string, summary: string[] }.
function parseCorrection(raw) {
  let t = (raw || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
  const C = "###CORRECTION###";
  const R = "###RESUME###";
  const ci = t.indexOf(C);
  const ri = t.indexOf(R);
  if (ci !== -1 && ri !== -1 && ri > ci) {
    const corrected = cleanOutput(t.slice(ci + C.length, ri));
    const summary = t.slice(ri + R.length)
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
      .filter(Boolean);
    return { corrected, summary };
  }
  // Repli : pas de marqueurs → tout est la correction, pas de résumé.
  return { corrected: cleanOutput(t), summary: [] };
}

// Nettoie la réponse du modèle : retire d'éventuels blocs de code ou guillemets
// enveloppants.
function cleanOutput(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("«") && t.endsWith("»"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

module.exports = {
  DEFAULT_BASE_URLS,
  generateCorrection,
  buildPrompt,
  detectLanguage,
  cleanOutput,
  parseCorrection,
  describeError
};
