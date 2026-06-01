// ---------------------------------------------------------------------------
// Journal des nouveauté, par version. Affiché dans la fenêtre « Nouveautés »
// (whatsnew.html) après une mise à jour, et ouvrable à la demande depuis le
// menu du tray.
//
// Pour CHAQUE nouvelle version publiée, ajoutez une entrée ici (FR + EN) :
//   "x.y.z": { fr: { title, points: [...] }, en: { title, points: [...] } }
// - `title`  : la nouveauté principale en une phrase (le « pourquoi »).
// - `points` : le détail de ce qui a changé (le « quoi »), une puce par ligne.
//
// Sans entrée pour une version donnée, l'app retombe sur un simple toast de
// mise à jour (cf. main.js : showWhatsNew renvoie false).
// ---------------------------------------------------------------------------

const CHANGELOG = {
  "1.5.4": {
    fr: {
      title: "Corrections plus fiables — tableaux Word et apps Firefox / Thunderbird",
      points: [
        "Dans Word, corriger une ligne ou plusieurs cellules d'un tableau préserve désormais la structure du tableau : seuls les mots sont remplacés, plus aucune ligne aplatie dans la première cellule.",
        "Détection de la sélection nettement plus fiable dans Firefox, Thunderbird et les autres apps « Gecko » : Correctify enchaîne plusieurs méthodes de copie (Ctrl+C / Ctrl+Insert), attend que vous ayez relâché le raccourci, et capte le texte même quand vous recorrigez la même phrase qu'auparavant.",
        "Si vous lancez Correctify alors que la fenêtre cible tourne en administrateur, un message clair vous l'indique au lieu d'un « Aucun texte sélectionné » trompeur."
      ]
    },
    en: {
      title: "More reliable corrections — Word tables and Firefox / Thunderbird",
      points: [
        "In Word, correcting a row or cells of a table now preserves the table structure: only the words are replaced — no more rows flattened into the first cell.",
        "Much more reliable selection detection in Firefox, Thunderbird and other “Gecko” apps: Correctify rotates through several copy methods (Ctrl+C / Ctrl+Insert), waits for you to release the shortcut, and captures the text even when you re-correct the same sentence as before.",
        "If you trigger Correctify while the target window runs as administrator, a clear message says so instead of a misleading “No text selected”."
      ]
    }
  },
  "1.5.3": {
    fr: {
      title: "Place au mode sombre — et un meilleur support de Claude",
      points: [
        "Nouveau mode sombre : activez-le d'un simple bouton dans les options. Tous les affichages adoptent un thème sombre élégant — fenêtre d'options, contact et nouveautés, ainsi que les petites bulles de correction, de résumé et d'erreur.",
        "Votre préférence d'apparence est mémorisée : Correctify rouvre toujours dans le thème que vous avez choisi, clair ou sombre.",
        "Meilleure prise en charge des clés Claude (Anthropic) : lecture plus fiable des réponses du modèle (plus de corrections vides lorsque Claude répond en plusieurs blocs) et messages d'erreur plus clairs en cas de quota dépassé ou de service indisponible."
      ]
    },
    en: {
      title: "Say hello to dark mode — with better Claude support",
      points: [
        "New dark mode: turn it on with a single switch in the options. Every screen adopts a sleek dark theme — the options, contact and what's-new windows, plus the small correction, summary and error pop-ups.",
        "Your appearance choice is remembered: Correctify always reopens in the theme you picked, light or dark.",
        "Better handling of Claude (Anthropic) keys: more reliable reading of the model's replies (no more empty corrections when Claude answers in multiple blocks) and clearer error messages when you hit a quota or an outage."
      ]
    }
  },
  "1.5.2": {
    fr: {
      title: "Des corrections plus fiables, et plus économiques",
      points: [
        "Détection de la sélection améliorée : Correctify réessaie automatiquement quand une application (comme Thunderbird) ne renvoie pas le texte du premier coup.",
        "Remplacement du texte plus fiable, y compris dans les éditeurs de code comme Visual Studio Code.",
        "Passage à un modèle Gemini Flash plus rapide et plus économique : des corrections accélérées, et un coût réduit si vous utilisez une clé payante — sans rien changer pour vous."
      ]
    },
    en: {
      title: "More reliable corrections, at a lower cost",
      points: [
        "Improved selection detection: Correctify now retries automatically when an app (such as Thunderbird) doesn’t return the text on the first try.",
        "More reliable text replacement, including in code editors like Visual Studio Code.",
        "Switched to a faster, more affordable Gemini Flash model: quicker corrections and lower cost if you use a paid key — with nothing to change on your side."
      ]
    }
  },
  "1.5.1": {
    fr: {
      title: "Vos corrections gardent leur mise en forme",
      points: [
        "La correction conserve désormais la mise en forme : gras, italique, couleurs, police et taille restent en place — fini le texte qui redevient « brut ».",
        "Dans Word, le style des titres, la table des matières et les bordures de paragraphe sont préservés : seuls les mots corrigés sont remplacés.",
        "Le texte corrigé s'applique au bon endroit même si vous changez de fenêtre ou cliquez ailleurs pendant la correction.",
        "Cliquer sur la notification ramène désormais la bonne fenêtre au premier plan.",
        "Accents et caractères spéciaux fiabilisés lors du remplacement."
      ]
    },
    en: {
      title: "Your corrections keep their formatting",
      points: [
        "Corrections now preserve formatting: bold, italics, colors, font and size stay in place — no more text turning back to “plain”.",
        "In Word, heading styles, the table of contents and paragraph borders are preserved: only the corrected words are replaced.",
        "The corrected text lands in the right place even if you switch windows or click elsewhere during the correction.",
        "Clicking the notification now brings the right window back to the front.",
        "More reliable handling of accents and special characters when replacing."
      ]
    }
  },
  "1.5.0": {
    fr: {
      title: "Une app plus fiable — et vous gardez la main",
      points: [
        "Correctify mesure désormais son usage de façon totalement anonyme (jamais le contenu de vos textes) pour améliorer sa fiabilité et corriger les problèmes plus vite.",
        "Nouveau réglage « Rapports d'erreur anonymes » dans les options : laissez-le activé pour aider, ou désactivez-le d'un clic."
      ]
    },
    en: {
      title: "A more reliable app — and you stay in control",
      points: [
        "Correctify now measures its usage in a fully anonymous way (never your text content) to improve reliability and fix issues faster.",
        "New “Anonymous error reports” setting in the options: leave it on to help, or turn it off in one click."
      ]
    }
  },
  "1.4.4": {
    fr: {
      title: "Suivez les nouveautés de l'application",
      points: [
        "Nouveau menu « Nouveautés » dans l'icône : retrouvez à tout moment l'historique et les évolutions de l'application, version par version.",
        "À chaque mise à jour, une fenêtre s'ouvre automatiquement pour vous présenter ce qui a changé."
      ]
    },
    en: {
      title: "Keep up with what's new",
      points: [
        "New “What's new” menu in the tray: browse the app's history and improvements anytime, version by version.",
        "After each update, a window opens automatically to show you what has changed."
      ]
    }
  },
  "1.4.2": {
    fr: {
      title: "Choisissez le ton de vos corrections",
      points: [
        "Nouveau menu « Ton de correction » dans l'icône : Standard, Professionnel, Courtois, Concis, Soutenu et Simplifié.",
        "Au-delà de la simple correction, votre texte peut désormais être reformulé dans le ton choisi — toujours d'un seul raccourci.",
        "Le ton sélectionné est mémorisé et appliqué automatiquement à chaque correction ; vous pouvez en changer à tout moment."
      ]
    },
    en: {
      title: "Choose the tone of your corrections",
      points: [
        "New “Correction tone” menu in the tray: Standard, Professional, Courteous, Concise, Formal and Simplified.",
        "Beyond plain correction, your text can now be rewritten in the chosen tone — still with a single shortcut.",
        "The selected tone is remembered and applied automatically to every correction; you can change it anytime."
      ]
    }
  },
  "1.4.1": {
    fr: {
      title: "Votre correction revient toujours au bon endroit",
      points: [
        "L'application mémorise désormais la sélection d'origine pour réinsérer le texte corrigé exactement là où il était.",
        "Fini les corrections collées au mauvais endroit si vous changez de fenêtre ou cliquez ailleurs pendant le traitement.",
        "Le remplacement est plus fiable d'une application à l'autre (mail, navigateur, traitement de texte…)."
      ]
    },
    en: {
      title: "Your correction always lands in the right place",
      points: [
        "The app now remembers the original selection to paste the corrected text exactly where it was.",
        "No more corrections pasted in the wrong spot if you switch windows or click elsewhere while it works.",
        "Replacement is more reliable across apps (mail, browser, word processor…)."
      ]
    }
  },
  "1.4.0": {
    fr: {
      title: "L'application se met à jour toute seule",
      points: [
        "Correctify vérifie automatiquement les nouvelles versions et les installe en arrière-plan.",
        "Plus besoin de télécharger ni de réinstaller manuellement : vous avez toujours la dernière version.",
        "Vous pouvez aussi lancer une vérification à tout moment depuis l'icône."
      ]
    },
    en: {
      title: "The app updates itself automatically",
      points: [
        "Correctify automatically checks for new versions and installs them in the background.",
        "No more manual downloads or reinstalls: you always have the latest version.",
        "You can also trigger a check anytime from the tray icon."
      ]
    }
  }
};

// Renvoie l'entrée { title, points } pour une version + une langue, ou null si
// aucune nouveauté n'est documentée pour cette version.
function getChangelog(version, lang) {
  const entry = CHANGELOG[version];
  if (!entry) return null;
  return entry[lang] || entry.fr || null;
}

// Renvoie TOUT l'historique documenté, trié de la version la plus récente à la
// plus ancienne : [{ version, title, points }, ...] dans la langue demandée.
// Utilisé par le menu « Nouveautés » du tray (la fenêtre d'update, elle, ne
// montre que la version installée).
function getAllChangelogs(lang) {
  return Object.keys(CHANGELOG)
    .sort((a, b) => {
      const pa = a.split("."), pb = b.split(".");
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
        if (d !== 0) return d > 0 ? -1 : 1; // décroissant
      }
      return 0;
    })
    .map((version) => {
      const e = getChangelog(version, lang);
      return e ? { version, title: e.title, points: e.points } : null;
    })
    .filter(Boolean);
}

module.exports = { CHANGELOG, getChangelog, getAllChangelogs };
