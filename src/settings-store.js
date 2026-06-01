// Stockage des options dans un simple fichier JSON, dans le dossier de données
// utilisateur de l'app (pas de dépendance externe).
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const isMac = process.platform === "darwin";

const DEFAULTS = {
  apiKey: "",
  // Langue de l'INTERFACE (fr / en). N'affecte pas la langue du texte corrigé.
  lang: "fr",
  // Thème de l'INTERFACE : "light" (clair, défaut) ou "dark" (sombre). Appliqué à
  // tous les affichages (options, contact, nouveautés, HUD, résumé, erreur) via un
  // attribut data-theme sur <html>. Persisté ici → conservé entre deux lancements.
  theme: "light",
  // Raccourci global déclenchant la correction de la sélection.
  hotkey: isMac ? "Command+Alt+C" : "Control+Alt+C",
  // Restaurer le contenu précédent du presse-papier après la correction.
  restoreClipboard: true,
  // Ton de correction : "standard" = correction seule (sans reformulation) ;
  // sinon un ton de reformulation (professional / courteous / concise / formal /
  // simplified / joking). Cf. ai.js (TONE_INSTRUCTIONS) et i18n.js (clés "tone.*").
  tone: "standard",
  // Lancer l'app au démarrage de la session.
  launchAtLogin: false,
  // Envoyer les RAPPORTS D'ERREUR anonymes (détail d'un échec : message + code)
  // — jamais le texte. Le simple comptage d'usage, lui, part TOUJOURS (obligatoire,
  // anonyme). Activé par défaut, désactivable. Respecté dans main.js (recordCorrectionStat).
  sendStats: true,
  // Dernière version lancée : sert à afficher « Application mise à jour » après
  // une mise à jour automatique (comparée à app.getVersion() au démarrage).
  lastVersion: ""
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
