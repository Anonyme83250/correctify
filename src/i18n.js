// ---------------------------------------------------------------------------
// Internationalisation (FR / EN). Source UNIQUE des chaînes visibles par
// l'utilisateur (tray, notifications, HUD, erreurs, fenêtre d'options).
//
// t(lang, key, vars) : renvoie la chaîne traduite ; replie sur le français si
// la clé manque dans la langue demandée, et sur la clé brute en dernier recours.
// Les variables s'écrivent {nom} dans les chaînes.
//
// Note : la langue du TEXTE CORRIGÉ n'est PAS gérée ici — elle vient du texte
// sélectionné (détection locale, ou réglage « Langue de la correction » quand
// l'utilisateur l'impose) ; cf. ai.js, buildPrompt. Seule l'INTERFACE est
// traduite ici — ainsi que le RÉSUMÉ des corrections, rédigé dans la langue de
// l'interface même quand le texte corrigé est dans une autre langue.
// ---------------------------------------------------------------------------

const STRINGS = {
  fr: {
    "tray.correct": "Corriger la sélection ({hotkey})",
    "tray.working": "Correction en cours…",
    "tray.model": "{model}",
    "tray.notConfigured": "⚠ API non configurée",
    "tray.options": "Options…",
    "tray.quit": "Quitter",

    "tray.tone": "Ton de correction",
    "tray.forceLang": "Langue de la correction",
    "tone.standard": "Standard (correction seule)",
    "tone.professional": "Professionnel",
    "tone.courteous": "Courtois",
    "tone.concise": "Concis",
    "tone.formal": "Soutenu",
    "tone.simplified": "Simplifié",
    "tone.joking": "Blagueur (avec une touche d'humour)",

    "notify.macAccess": "Autorisez Correctify dans Réglages Système → Confidentialité et sécurité → Accessibilité, puis réessayez.",
    "notify.hotkeyFail": "Impossible d'enregistrer le raccourci « {hotkey} » (déjà utilisé ?).",

    "defer.ready": "Correction prête ✓ — revenez sur votre fenêtre, ou cliquez ici pour l'appliquer.",
    "defer.timeout": "Correction toujours dans le presse-papier — collez-la avec Ctrl+V quand vous voulez.",

    "err.provider": "Renseignez d'abord l'URL de votre API et le nom du modèle dans les options.",
    "err.noSelection": "Aucun texte sélectionné. Sélectionnez du texte, puis réessayez.",
    "err.blankSelection": "La sélection ne contient que des espaces. Sélectionnez du texte, puis réessayez.",
    "err.elevatedTarget": "Cette fenêtre s'exécute en administrateur. Lancez Correctify en tant qu'administrateur pour la corriger.",
    "err.empty": "Réponse vide du service. Réessayez.",
    "err.unknown": "Une erreur inconnue est survenue. Merci de réessayer.",
    "err.timeout": "Connexion trop lente (réseau ou proxy). Réessayez.",
    "err.network": "Connexion impossible. Vérifiez l'URL de l'API et votre connexion Internet.",
    "err.refused": "Le service a refusé la requête. Réessayez.",
    "err.serverDown": "Le service est temporairement indisponible. Réessayez dans un instant.",
    "err.http.400": "Requête refusée par le service (texte peut-être trop long, ou type d'API mal choisi). Réessayez.",
    "err.http.401": "Clé API invalide. Vérifiez votre clé dans les options.",
    "err.http.402": "Crédit insuffisant sur votre compte. Vérifiez votre facturation chez le fournisseur.",
    "err.http.403": "Accès refusé : clé non autorisée, ou service indisponible dans votre région.",
    "err.http.404": "Adresse introuvable. Vérifiez l'URL de l'API et le nom du modèle dans les options.",
    "err.modelUnknown": "Le modèle « {model} » n'existe pas chez ce fournisseur, ou votre clé n'y a pas accès. Corrigez-le dans les options.",
    "err.http.408": "Le service a mis trop de temps à répondre. Réessayez.",
    "err.http.413": "Texte trop long. Sélectionnez un passage plus court.",
    "err.http.429": "Quota dépassé ou trop de requêtes. Patientez un instant, ou vérifiez votre quota chez le fournisseur.",
    "err.http.500": "Le service rencontre un problème. Réessayez dans un instant.",
    "err.http.502": "Le service est momentanément indisponible. Réessayez dans un instant.",
    "err.http.503": "Le service est surchargé. Réessayez dans un instant.",
    "err.http.504": "Le service met trop de temps à répondre. Réessayez.",
    "err.http.529": "Le service est surchargé. Réessayez dans un instant.",

    "hud.working": "· correction en cours…",
    "hud.cancel": "Annuler",
    "hud.pending": "· correction prête · revenez sur votre fenêtre",
    "summary.badge": "Corrigé",
    "error.badge": "Erreur",

    "opt.eyebrow": "CORRECTEUR ORTHOGRAPHIQUE IA",
    "opt.sub": "Sélectionnez du texte n'importe où, puis appuyez sur le raccourci pour le corriger en place.",
    "opt.apiLabel": "URL de l'API",
    "opt.apiHint": "L'adresse de base de l'API que vous voulez utiliser. Elle reste sur votre ordinateur : Correctify l'appelle directement, sans aucun serveur intermédiaire.",
    "opt.apiKindLabel": "Type d'API",
    "opt.apiKindHint": "La forme de l'API attendue par cette adresse. « OpenAI » couvre aussi Mistral, Groq, OpenRouter, Ollama, LM Studio, LiteLLM et la plupart des serveurs maison.",
    "opt.modelLabel": "Modèle",
    "opt.modelPlaceholder": "nom du modèle",
    "opt.modelHint": "Le nom exact du modèle, tel que votre fournisseur l'attend.",
    "opt.apiKeyLabel": "Clé API",
    "opt.apiKeyHint": "Laissez vide pour un serveur local qui n'en demande pas (Ollama, LM Studio).",
    "opt.ready": "prêt",
    "opt.notReady": "à compléter",
    "opt.hotkeyLabel": "Raccourci global",
    "opt.hotkeyPlaceholder": "Cliquez puis tapez la combinaison",
    "opt.hotkeyHint": "Cliquez dans le champ et appuyez sur vos touches (ex. <code>Ctrl</code> + <code>Alt</code> + <code>C</code>).",
    "opt.toneLabel": "Ton de correction",
    "opt.toneHint": "« Standard » corrige sans reformuler. Les autres tons réécrivent le texte, en le corrigeant.",
    "opt.forceLangLabel": "Langue de la correction",
    "opt.forceLangHint": "Par défaut, la langue de votre texte est reconnue toute seule. Imposez-la si un texte court ou mêlé de citations vous revient dans la mauvaise langue.",
    "opt.forceLang.auto": "Détection automatique",
    "opt.forceLang.fr": "Toujours en français",
    "opt.forceLang.en": "Toujours en anglais",
    "opt.restoreLabel": "Restaurer le presse-papier",
    "opt.restoreHint": "Remet votre ancien contenu après correction.",
    "opt.launchLabel": "Lancer au démarrage",
    "opt.launchHint": "Ouvre Correctify à l'ouverture de session.",
    "opt.themeLabel": "Mode sombre",
    "opt.themeHint": "Affiche l'application sur un fond sombre, plus reposant le soir.",
    "opt.save": "Enregistrer",
    "opt.saved": "✓ Enregistré !",
    "opt.revealTitle": "Afficher/Masquer",
    "opt.closeTitle": "Fermer"
  },

  en: {
    "tray.correct": "Correct selection ({hotkey})",
    "tray.working": "Correcting…",
    "tray.model": "{model}",
    "tray.notConfigured": "⚠ API not configured",
    "tray.options": "Options…",
    "tray.quit": "Quit",

    "tray.tone": "Correction tone",
    "tray.forceLang": "Correction language",
    "tone.standard": "Standard (correction only)",
    "tone.professional": "Professional",
    "tone.courteous": "Courteous",
    "tone.concise": "Concise",
    "tone.formal": "Formal",
    "tone.simplified": "Simplified",
    "tone.joking": "Joking (with a touch of humor)",

    "notify.macAccess": "Allow Correctify in System Settings → Privacy & Security → Accessibility, then try again.",
    "notify.hotkeyFail": "Couldn't register the shortcut “{hotkey}” (already in use?).",

    "defer.ready": "Correction ready ✓ — go back to your window, or click here to apply it.",
    "defer.timeout": "Correction still on the clipboard — paste it with Ctrl+V whenever you want.",

    "err.provider": "Fill in your API URL and the model name in the options first.",
    "err.noSelection": "No text selected. Select some text, then try again.",
    "err.blankSelection": "The selection contains only spaces. Select some text, then try again.",
    "err.elevatedTarget": "This window is running as administrator. Run Correctify as administrator to correct it.",
    "err.empty": "Empty response from the service. Please try again.",
    "err.unknown": "An unknown error occurred. Please try again.",
    "err.timeout": "Connection too slow (network or proxy). Please try again.",
    "err.network": "Can't connect. Check the API URL and your Internet connection.",
    "err.refused": "The service refused the request. Please try again.",
    "err.serverDown": "The service is temporarily unavailable. Try again shortly.",
    "err.http.400": "Request refused by the service (text may be too long, or the API type may be wrong). Please try again.",
    "err.http.401": "Invalid API key. Check your key in the options.",
    "err.http.402": "Insufficient credit on your account. Check your billing with the provider.",
    "err.http.403": "Access denied: key not authorized, or service unavailable in your region.",
    "err.http.404": "Address not found. Check the API URL and the model name in the options.",
    "err.modelUnknown": "The model “{model}” does not exist at this provider, or your key has no access to it. Fix it in the options.",
    "err.http.408": "The service took too long to respond. Please try again.",
    "err.http.413": "Text too long. Select a shorter passage.",
    "err.http.429": "Quota exceeded or too many requests. Wait a moment, or check your quota with the provider.",
    "err.http.500": "The service is having trouble. Try again shortly.",
    "err.http.502": "The service is momentarily unavailable. Try again shortly.",
    "err.http.503": "The service is overloaded. Try again shortly.",
    "err.http.504": "The service took too long to respond. Please try again.",
    "err.http.529": "The service is overloaded. Try again shortly.",

    "hud.working": "· correcting…",
    "hud.cancel": "Cancel",
    "hud.pending": "· correction ready · go back to your window",
    "summary.badge": "Corrected",
    "error.badge": "Error",

    "opt.eyebrow": "AI SPELLING CORRECTOR",
    "opt.sub": "Select text anywhere, then press the shortcut to correct it in place.",
    "opt.apiLabel": "API URL",
    "opt.apiHint": "The base address of the API you want to use. It stays on your computer: Correctify calls it directly, with no server in between.",
    "opt.apiKindLabel": "API type",
    "opt.apiKindHint": "The API shape this address expects. “OpenAI” also covers Mistral, Groq, OpenRouter, Ollama, LM Studio, LiteLLM and most self-hosted servers.",
    "opt.modelLabel": "Model",
    "opt.modelPlaceholder": "model name",
    "opt.modelHint": "The exact model name, as your provider expects it.",
    "opt.apiKeyLabel": "API key",
    "opt.apiKeyHint": "Leave empty for a local server that doesn't ask for one (Ollama, LM Studio).",
    "opt.ready": "ready",
    "opt.notReady": "incomplete",
    "opt.hotkeyLabel": "Global shortcut",
    "opt.hotkeyPlaceholder": "Click then type the combination",
    "opt.hotkeyHint": "Click the field and press your keys (e.g. <code>Ctrl</code> + <code>Alt</code> + <code>C</code>).",
    "opt.toneLabel": "Correction tone",
    "opt.toneHint": "“Standard” corrects without rewriting. The other tones rewrite the text while correcting it.",
    "opt.forceLangLabel": "Correction language",
    "opt.forceLangHint": "By default, the language of your text is recognised on its own. Force it if a short text, or one with quotations, comes back in the wrong language.",
    "opt.forceLang.auto": "Automatic detection",
    "opt.forceLang.fr": "Always French",
    "opt.forceLang.en": "Always English",
    "opt.restoreLabel": "Restore clipboard",
    "opt.restoreHint": "Puts your previous content back after correction.",
    "opt.launchLabel": "Launch at startup",
    "opt.launchHint": "Opens Correctify when you log in.",
    "opt.themeLabel": "Dark mode",
    "opt.themeHint": "Displays the app on a dark background, easier on the eyes at night.",
    "opt.save": "Save",
    "opt.saved": "✓ Saved!",
    "opt.revealTitle": "Show/Hide",
    "opt.closeTitle": "Close"
  }
};

const LANGS = ["fr", "en"];

function t(lang, key, vars) {
  const table = STRINGS[lang] || STRINGS.fr;
  let s = (table[key] != null) ? table[key]
        : (STRINGS.fr[key] != null ? STRINGS.fr[key] : key);
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
  }
  return s;
}

module.exports = { STRINGS, LANGS, t };
