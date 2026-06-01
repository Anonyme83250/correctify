// Appel IA robuste : détecte le fournisseur (Gemini / OpenAI / Anthropic) d'après
// la clé, réessaie (backoff exponentiel + jitter) et bascule sur le modèle de
// secours si le service reste surchargé.
// Porté depuis l'extension Correctify, adapté pour une sortie en TEXTE BRUT
// (l'app colle dans n'importe quel champ, pas seulement un éditeur HTML).

const { t } = require("./i18n");

// Erreurs transitoires (surcharge serveur / quota court) : on réessaie.
// 529 = « overloaded » d'Anthropic ; 502/504 = passerelles/timeout amont.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;

// Codes HTTP pour lesquels on a un message dédié (clé i18n "err.http.<code>"),
// communs aux 3 fournisseurs (Google Gemini, OpenAI, Anthropic).
const KNOWN_STATUS = new Set([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504, 529]);

// Traduit une erreur (HTTP, réseau, timeout…) en message clair, dans la langue
// de l'interface. On n'affiche jamais le code brut.
function describeError(err, lang) {
  const status = err && err.status;
  if (status) {
    if (KNOWN_STATUS.has(status)) return t(lang, "err.http." + status);
    if (status >= 500) return t(lang, "err.serverDown");
    if (status >= 400) return t(lang, "err.refused");
  }
  const kind = err && err.kind;
  const msg = (err && err.message) || "";
  if (kind === "timeout" || /délai|timeout/i.test(msg)) return t(lang, "err.timeout");
  if (kind === "network" || /network|fetch|failed|ENOTFOUND|ECONN|getaddrinfo/i.test(msg)) {
    return t(lang, "err.network");
  }
  return t(lang, "err.unknown");
}

// Configuration par fournisseur : URL, en-têtes, corps, et extraction du texte.
const PROVIDERS = {
  google: {
    // flash-lite EN PREMIER = le modèle Gemini le MOINS CHER (choix par défaut,
    // pour minimiser le coût si l'utilisateur est en facturation payante) ;
    // flash sert de secours si flash-lite échoue (surcharge / indisponible).
    models: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    buildRequest(apiKey, model, prompt) {
      return {
        url: `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      };
    },
    extractText: (json) => json.candidates[0].content.parts[0].text
  },
  openai: {
    models: ["gpt-4o-mini"],
    buildRequest(apiKey, model, prompt) {
      return {
        url: "https://api.openai.com/v1/chat/completions",
        options: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] })
        }
      };
    },
    extractText: (json) => json.choices[0].message.content
  },
  anthropic: {
    models: ["claude-haiku-4-5-20251001"],
    buildRequest(apiKey, model, prompt) {
      return {
        url: "https://api.anthropic.com/v1/messages",
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
    // Lecture robuste : la réponse Anthropic est un TABLEAU de blocs et le premier
    // n'est pas forcément du texte (un autre type peut précéder). On cherche donc
    // le premier bloc { type:"text" } au lieu de supposer content[0] — évite une
    // exception (ou une correction vide) quand Claude répond en plusieurs blocs.
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

// Détecte le fournisseur d'après le préfixe de la clé API.
function detectProvider(apiKey) {
  const key = (apiKey || "").trim();
  if (key.startsWith("sk-ant-")) return "anthropic"; // Claude
  if (key.startsWith("sk-")) return "openai";          // ChatGPT (OpenAI)
  return "google";                                      // Gemini (AIza…) par défaut
}

function abortError() {
  const e = new Error("Annulé");
  e.kind = "abort";
  return e;
}

// Détail d'erreur renvoyé par le fournisseur : Anthropic, OpenAI et Google
// partagent la forme { error: { type, message } }. On le remonte pour un
// diagnostic clair (utile aux logs) ; le message MONTRÉ à l'utilisateur reste,
// lui, dérivé du code HTTP via describeError (jamais le détail brut). Repli sur
// le code HTTP si le corps est vide / non-JSON.
async function readApiErrorMessage(response, status) {
  try {
    const data = await response.clone().json();
    const e = data && data.error;
    const msg = e && (e.message || e.type);
    if (msg) return String(msg);
  } catch { /* corps vide ou non-JSON */ }
  return `Erreur HTTP ${status}`;
}

async function generateCorrection(apiKey, prompt, options = {}) {
  const { signal, onRetry } = options;
  const provider = PROVIDERS[detectProvider(apiKey)];
  let lastError = null;

  for (const model of provider.models) {
    const { url, options: reqOptions } = provider.buildRequest(apiKey, model, prompt);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) throw abortError(); // annulation utilisateur : on n'insiste pas
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
        return provider.extractText(json);
      }

      const status = response ? response.status : 0;

      // Erreur définitive (clé invalide, requête malformée…) : inutile de réessayer.
      if (response && !RETRYABLE_STATUS.has(status)) {
        const err = new Error(await readApiErrorMessage(response, status));
        err.status = status;
        throw err;
      }

      lastError = new Error(`Service indisponible (${status || "réseau"})`);
      if (status) lastError.status = status; // garde le code pour un message clair
      if (attempt === MAX_ATTEMPTS) break; // On passe au modèle de secours.

      // Backoff exponentiel + jitter : ~1s, 2s, 4s.
      const delay = Math.pow(2, attempt - 1) * 1000 + Math.floor(Math.random() * 500);
      if (onRetry) onRetry();
      await sleep(delay);
    }
  }

  throw lastError || new Error("Échec de la correction");
}

// Tons de reformulation (clés alignées sur settings.tone et les clés i18n
// "tone.*"). Les consignes restent en français comme le reste du prompt, mais
// s'appliquent à la langue détectée du texte sélectionné.
const TONE_INSTRUCTIONS = {
  professional: "un ton professionnel : clair, direct et structuré, adapté à un échange formel en entreprise",
  courteous: "un ton courtois et chaleureux : aimable, poli et bienveillant",
  concise: "un style concis : droit au but, sans superflu, avec des phrases courtes",
  formal: "un registre soutenu et formel : vocabulaire précis et tournures élégantes, adapté à un courrier officiel ou administratif",
  simplified: "un style simple et accessible : phrases claires, vocabulaire courant, facile à lire",
  joking: "un ton blagueur et léger : décontracté et plein d'humour, avec des touches drôles, des clins d'œil ou des jeux de mots bien placés, tout en gardant le message clair et compréhensible"
};

// Construit le prompt : texte (corrigé ou reformulé) + résumé, séparés par des
// marqueurs faciles à parser (comme dans les extensions navigateur). Le ton
// "standard" (ou inconnu) corrige sans reformuler — comportement historique ;
// les autres tons réécrivent librement le texte dans le ton voulu, en corrigeant.
function buildPrompt(text, tone = "standard") {
  const toneDesc = TONE_INSTRUCTIONS[tone];

  if (!toneDesc) {
    return `Tu es un correcteur professionnel.
Corrige l'orthographe, la grammaire, la syntaxe et la fluidité du texte ci-dessous.

RÈGLES :
- Détecte automatiquement la langue et corrige dans cette même langue.
- Conserve le ton (tutoiement/vouvoiement), le sens exact et la mise en forme simple (sauts de ligne, listes).
- N'ajoute, ne supprime et ne reformule rien inutilement.

FORMAT DE SORTIE — réponds EXACTEMENT ainsi, sans markdown, sans bloc de code, sans rien avant ni après :
###CORRECTION###
(ici uniquement le texte corrigé, en texte brut)
###RESUME###
(ici la liste des corrections, UNE PAR LIGNE, chacune préfixée par "- ", courte et concrète — ex. « - Orthographe : "sa" → "ça" », « - Accord du participe passé ». Si aucune correction n'est nécessaire, écris une seule ligne : "- Aucune erreur détectée.")

Texte :
"${text}"`;
  }

  return `Tu es un assistant de rédaction professionnel.
Corrige et reformule le texte ci-dessous pour qu'il adopte ${toneDesc}.

RÈGLES :
- Détecte automatiquement la langue et écris dans cette même langue.
- Corrige toutes les fautes d'orthographe, de grammaire et de syntaxe.
- Tu peux restructurer et réécrire librement les phrases pour adopter pleinement le ton demandé.
- Conserve le sens, les informations et les faits du texte d'origine ; n'invente rien et n'ajoute aucune information.
- Conserve le tutoiement/vouvoiement d'origine et la mise en forme simple (sauts de ligne, listes).

FORMAT DE SORTIE — réponds EXACTEMENT ainsi, sans markdown, sans bloc de code, sans rien avant ni après :
###CORRECTION###
(ici uniquement le texte reformulé, en texte brut)
###RESUME###
(ici un court résumé des changements apportés, UNE PUCE PAR LIGNE préfixée par "- ", brève et concrète — ex. « - Reformulé dans un ton professionnel », « - Phrases raccourcies ». Maximum 3 puces.)

Texte :
"${text}"`;
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

// Nettoie la réponse du modèle : retire d'éventuels blocs de code ou guillemets enveloppants.
function cleanOutput(raw) {
  let t = (raw || "").trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("«") && t.endsWith("»"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

module.exports = { generateCorrection, detectProvider, buildPrompt, cleanOutput, parseCorrection, describeError };
