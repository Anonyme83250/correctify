// ---------------------------------------------------------------------------
// Internationalisation (FR / EN). Source UNIQUE des chaînes visibles par
// l'utilisateur (tray, notifications, HUD, erreurs, fenêtre d'options).
//
// t(lang, key, vars) : renvoie la chaîne traduite ; replie sur le français si
// la clé manque dans la langue demandée, et sur la clé brute en dernier recours.
// Les variables s'écrivent {nom} dans les chaînes.
//
// Note : la langue du TEXTE CORRIGÉ n'est PAS gérée ici — l'IA détecte la langue
// du texte sélectionné et corrige dans cette langue (cf. buildPrompt). Seule
// l'INTERFACE est traduite.
// ---------------------------------------------------------------------------

const STRINGS = {
  fr: {
    "tray.correct": "Corriger la sélection ({hotkey})",
    "tray.working": "Correction en cours…",
    "tray.provider": "Fournisseur : {provider}",
    "tray.noKey": "⚠ Aucune clé API",
    "tray.options": "Options…",
    "tray.feedback": "Contact & retours…",
    "tray.checkUpdates": "Vérifier les mises à jour…",
    "tray.whatsNew": "Nouveautés…",
    "tray.support": "❤ Soutenir le projet",
    "tray.quit": "Quitter",

    "whatsnew.eyebrow": "NOUVEAUTÉS",
    "whatsnew.version": "Version {version}",
    "whatsnew.updatedNote": "Correctify vient d'être mis à jour. Voici ce qui change :",
    "whatsnew.button": "Ok",
    "whatsnew.none": "Aucune nouveauté à afficher pour cette version.",

    "tray.tone": "Ton de correction",
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

    "err.noKey": "Ajoutez d'abord votre clé API dans les options.",
    "err.noSelection": "Aucun texte sélectionné. Sélectionnez du texte, puis réessayez.",
    "err.blankSelection": "La sélection ne contient que des espaces. Sélectionnez du texte, puis réessayez.",
    "err.elevatedTarget": "Cette fenêtre s'exécute en administrateur. Lancez Correctify en tant qu'administrateur pour la corriger.",
    "err.empty": "Réponse vide du service. Réessayez.",
    "err.unknown": "Une erreur inconnue est survenue. Merci de réessayer.",
    "err.timeout": "Connexion trop lente (réseau ou proxy). Réessayez.",
    "err.network": "Connexion impossible. Vérifiez votre connexion Internet.",
    "err.refused": "Le service a refusé la requête. Réessayez.",
    "err.serverDown": "Le service est temporairement indisponible. Réessayez dans un instant.",
    "err.http.400": "Requête refusée par le service (texte peut-être trop long). Réessayez.",
    "err.http.401": "Clé API invalide. Vérifiez votre clé dans les options.",
    "err.http.402": "Crédit insuffisant sur votre compte. Vérifiez votre facturation chez le fournisseur.",
    "err.http.403": "Accès refusé : clé non autorisée, ou service indisponible dans votre région.",
    "err.http.404": "Modèle introuvable. Mettez Correctify à jour.",
    "err.http.408": "Le service a mis trop de temps à répondre. Réessayez.",
    "err.http.413": "Texte trop long. Sélectionnez un passage plus court.",
    "err.http.429": "Quota dépassé ou trop de requêtes. Patientez un instant, ou vérifiez votre quota chez le fournisseur.",
    "err.http.500": "Le service rencontre un problème. Réessayez dans un instant.",
    "err.http.502": "Le service est momentanément indisponible. Réessayez dans un instant.",
    "err.http.503": "Le service est surchargé. Réessayez dans un instant.",
    "err.http.504": "Le service met trop de temps à répondre. Réessayez.",
    "err.http.529": "Le service est surchargé. Réessayez dans un instant.",

    "update.title": "Correctify — mise à jour",
    "update.available": "Une nouvelle version est disponible : {latest}",
    "update.installed": "Version installée : {current}.",
    "update.download": "Télécharger",
    "update.later": "Plus tard",
    "update.upToDate": "Vous êtes à jour",
    "update.version": "Version {current}.",
    "update.updated": "Application mise à jour ✓ — version {version}",
    "update.downloading": "Mise à jour trouvée (v{version}) — installation en cours…",
    "update.checkFailed": "Impossible de vérifier les mises à jour :\n{error}",
    "common.ok": "OK",

    "hud.working": "· correction en cours…",
    "hud.cancel": "Annuler",
    "hud.pending": "· correction prête · revenez sur votre fenêtre",
    "summary.badge": "Corrigé",
    "error.badge": "Erreur",

    "opt.eyebrow": "CORRECTEUR ORTHOGRAPHIQUE IA",
    "opt.sub": "Sélectionnez du texte n'importe où, puis appuyez sur le raccourci pour le corriger en place.",
    "opt.langLabel": "Langue de l'application",
    "opt.apiKeyLabel": "Clé API",
    "opt.notDetected": "non détecté",
    "opt.providerDefault": "Google Gemini (par défaut)",
    "opt.providerHint": "Fournisseur détecté automatiquement. Obtenir une clé :",
    "opt.hotkeyLabel": "Raccourci global",
    "opt.hotkeyPlaceholder": "Cliquez puis tapez la combinaison",
    "opt.hotkeyHint": "Cliquez dans le champ et appuyez sur vos touches (ex. <code>Ctrl</code> + <code>Alt</code> + <code>C</code>).",
    "opt.restoreLabel": "Restaurer le presse-papier",
    "opt.restoreHint": "Remet votre ancien contenu après correction.",
    "opt.launchLabel": "Lancer au démarrage",
    "opt.launchHint": "Ouvre Correctify à l'ouverture de session.",
    "opt.statsLabel": "Rapports d'erreur anonymes",
    "opt.statsHint": "En cas de problème, envoie un rapport anonyme pour aider à corriger les bugs. Aucun texte n'est envoyé.",
    "opt.themeLabel": "Mode sombre",
    "opt.themeHint": "Affiche l'application sur un fond sombre, plus reposant le soir.",
    "opt.save": "Enregistrer",
    "opt.saved": "✓ Enregistré !",
    "opt.revealTitle": "Afficher/Masquer",
    "opt.closeTitle": "Fermer",

    "contact.eyebrow": "CONTACT & RETOURS",
    "contact.sub": "Un bug, une idée, ou simplement un avis ? Écrivez-nous, on lit tout.",
    "contact.categoryLabel": "Type de message",
    "contact.cat.bug": "Bug / problème",
    "contact.cat.feature": "Nouvelle fonctionnalité",
    "contact.cat.feedback": "Avis / retour",
    "contact.nameLabel": "Nom",
    "contact.namePlaceholder": "Votre nom (optionnel)",
    "contact.emailLabel": "E-mail",
    "contact.emailPlaceholder": "vous@exemple.com (pour la réponse)",
    "contact.messageLabel": "Message",
    "contact.messagePlaceholder": "Décrivez le bug, votre idée ou votre avis…",
    "contact.send": "Envoyer",
    "contact.sending": "Envoi…",
    "contact.sent": "✓ Message envoyé, merci !",
    "contact.errEmpty": "Écrivez un message avant d'envoyer.",
    "contact.errEmail": "Adresse e-mail invalide.",
    "contact.errRate": "Trop d'envois. Patientez une minute, puis réessayez.",
    "contact.errSend": "Envoi impossible pour le moment. Réessayez plus tard."
  },

  en: {
    "tray.correct": "Correct selection ({hotkey})",
    "tray.working": "Correcting…",
    "tray.provider": "Provider: {provider}",
    "tray.noKey": "⚠ No API key",
    "tray.options": "Options…",
    "tray.feedback": "Contact & feedback…",
    "tray.checkUpdates": "Check for updates…",
    "tray.whatsNew": "What's new…",
    "tray.support": "❤ Support the project",
    "tray.quit": "Quit",

    "whatsnew.eyebrow": "WHAT'S NEW",
    "whatsnew.version": "Version {version}",
    "whatsnew.updatedNote": "Correctify was just updated. Here's what changed:",
    "whatsnew.button": "Ok",
    "whatsnew.none": "No release notes to show for this version.",

    "tray.tone": "Correction tone",
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

    "err.noKey": "Add your API key first in the options.",
    "err.noSelection": "No text selected. Select some text, then try again.",
    "err.blankSelection": "The selection contains only spaces. Select some text, then try again.",
    "err.elevatedTarget": "This window is running as administrator. Run Correctify as administrator to correct it.",
    "err.empty": "Empty response from the service. Please try again.",
    "err.unknown": "An unknown error occurred. Please try again.",
    "err.timeout": "Connection too slow (network or proxy). Please try again.",
    "err.network": "Can't connect. Check your Internet connection.",
    "err.refused": "The service refused the request. Please try again.",
    "err.serverDown": "The service is temporarily unavailable. Try again shortly.",
    "err.http.400": "Request refused by the service (text may be too long). Please try again.",
    "err.http.401": "Invalid API key. Check your key in the options.",
    "err.http.402": "Insufficient credit on your account. Check your billing with the provider.",
    "err.http.403": "Access denied: key not authorized, or service unavailable in your region.",
    "err.http.404": "Model not found. Please update Correctify.",
    "err.http.408": "The service took too long to respond. Please try again.",
    "err.http.413": "Text too long. Select a shorter passage.",
    "err.http.429": "Quota exceeded or too many requests. Wait a moment, or check your quota with the provider.",
    "err.http.500": "The service is having trouble. Try again shortly.",
    "err.http.502": "The service is momentarily unavailable. Try again shortly.",
    "err.http.503": "The service is overloaded. Try again shortly.",
    "err.http.504": "The service took too long to respond. Please try again.",
    "err.http.529": "The service is overloaded. Try again shortly.",

    "update.title": "Correctify — update",
    "update.available": "A new version is available: {latest}",
    "update.installed": "Installed version: {current}.",
    "update.download": "Download",
    "update.later": "Later",
    "update.upToDate": "You're up to date",
    "update.version": "Version {current}.",
    "update.updated": "App updated ✓ — version {version}",
    "update.downloading": "Update found (v{version}) — installing…",
    "update.checkFailed": "Couldn't check for updates:\n{error}",
    "common.ok": "OK",

    "hud.working": "· correcting…",
    "hud.cancel": "Cancel",
    "hud.pending": "· correction ready · go back to your window",
    "summary.badge": "Corrected",
    "error.badge": "Error",

    "opt.eyebrow": "AI SPELLING CORRECTOR",
    "opt.sub": "Select text anywhere, then press the shortcut to correct it in place.",
    "opt.langLabel": "Application language",
    "opt.apiKeyLabel": "API key",
    "opt.notDetected": "not detected",
    "opt.providerDefault": "Google Gemini (default)",
    "opt.providerHint": "Provider detected automatically. Get a key:",
    "opt.hotkeyLabel": "Global shortcut",
    "opt.hotkeyPlaceholder": "Click then type the combination",
    "opt.hotkeyHint": "Click the field and press your keys (e.g. <code>Ctrl</code> + <code>Alt</code> + <code>C</code>).",
    "opt.restoreLabel": "Restore clipboard",
    "opt.restoreHint": "Puts your previous content back after correction.",
    "opt.launchLabel": "Launch at startup",
    "opt.launchHint": "Opens Correctify when you log in.",
    "opt.statsLabel": "Anonymous error reports",
    "opt.statsHint": "When something fails, sends an anonymous report to help fix bugs. No text is ever sent.",
    "opt.themeLabel": "Dark mode",
    "opt.themeHint": "Displays the app on a dark background, easier on the eyes at night.",
    "opt.save": "Save",
    "opt.saved": "✓ Saved!",
    "opt.revealTitle": "Show/Hide",
    "opt.closeTitle": "Close",

    "contact.eyebrow": "CONTACT & FEEDBACK",
    "contact.sub": "A bug, an idea, or just feedback? Write to us, we read everything.",
    "contact.categoryLabel": "Message type",
    "contact.cat.bug": "Bug / problem",
    "contact.cat.feature": "Feature request",
    "contact.cat.feedback": "Feedback",
    "contact.nameLabel": "Name",
    "contact.namePlaceholder": "Your name (optional)",
    "contact.emailLabel": "Email",
    "contact.emailPlaceholder": "you@example.com (for the reply)",
    "contact.messageLabel": "Message",
    "contact.messagePlaceholder": "Describe the bug, your idea or your feedback…",
    "contact.send": "Send",
    "contact.sending": "Sending…",
    "contact.sent": "✓ Message sent, thank you!",
    "contact.errEmpty": "Write a message before sending.",
    "contact.errEmail": "Invalid email address.",
    "contact.errRate": "Too many messages. Wait a minute, then try again.",
    "contact.errSend": "Couldn't send right now. Try again later."
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
