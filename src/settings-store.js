// Stockage des options dans un simple fichier JSON, dans le dossier de données
// utilisateur de l'app (pas de dépendance externe, pas de base de données).
//
// Tout est local : l'URL d'API, le modèle et la clé saisis ici ne quittent
// jamais la machine — ils ne servent qu'à appeler DIRECTEMENT le fournisseur
// choisi par l'utilisateur.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";

const DEFAULTS = {
  // ── Le fournisseur d'IA, saisi entièrement par l'utilisateur ───────────────
  // URL de base de l'API. Exemples :
  //   https://api.openai.com/v1
  //   https://generativelanguage.googleapis.com/v1
  //   https://api.anthropic.com/v1
  //   http://localhost:11434/v1            (Ollama)
  //   http://localhost:1234/v1             (LM Studio)
  baseUrl: "",
  // Forme du dialogue HTTP attendue par cette URL : "openai" (tout ce qui est
  // compatible OpenAI), "google" (Gemini) ou "anthropic" (Claude). Cf. ai.js.
  apiKind: "openai",
  // Nom du modèle, tel que le fournisseur l'attend (« gpt-4o-mini »,
  // « gemini-3.1-flash-lite », « llama3.1 »…).
  model: "",
  // Clé d'API. Facultative : un serveur local (Ollama, LM Studio) n'en veut pas.
  apiKey: "",

  // ── Interface et comportement ─────────────────────────────────────────────
  // Langue de l'INTERFACE (fr / en). N'affecte pas la langue du texte corrigé.
  lang: "fr",
  // Thème de l'INTERFACE : "light" (clair, défaut) ou "dark" (sombre).
  theme: "light",
  // Raccourci global déclenchant la correction de la sélection.
  hotkey: isMac ? "Command+Alt+C" : "Control+Alt+C",
  // Restaurer le contenu précédent du presse-papier après la correction.
  restoreClipboard: true,
  // Ton de correction : "standard" = correction seule (sans reformulation) ;
  // sinon un ton de reformulation. Cf. ai.js (TONE_INSTRUCTIONS).
  tone: "standard",
  // Langue de la CORRECTION : "auto" = déduite du texte sélectionné (défaut),
  // "fr" / "en" = imposée. Cf. ai.js (buildPrompt).
  forceLang: "auto",
  // Lancer l'app à l'ouverture de session.
  launchAtLogin: false
};

function filePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  const merged = { ...DEFAULTS, ...settings };
  fs.writeFileSync(filePath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

// true si des réglages ont déjà été enregistrés (≠ tout premier lancement).
function fileExists() {
  try { return fs.existsSync(filePath()); } catch { return false; }
}

module.exports = { loadSettings, saveSettings, DEFAULTS, fileExists };
