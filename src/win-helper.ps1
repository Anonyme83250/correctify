# ---------------------------------------------------------------------------
# Correctify — host PowerShell PERSISTANT (Windows uniquement).
#
# Pourquoi un process qui vit longtemps ?
#   - On charge UI Automation (UIAutomationClient/Types) UNE SEULE FOIS au
#     démarrage : le chargement coûte ~0,5 s, donc on ne le paie pas à chaque
#     correction → l'app reste « instantanée ».
#   - On garde EN MÉMOIRE l'élément UIA focalisé + sa plage de sélection
#     (TextPatternRange) entre deux requêtes. C'est la clé du report
#     d'application : même si l'utilisateur change de fenêtre, on peut
#     re-sélectionner EXACTEMENT le texte d'origine plus tard via range.Select().
#
# Protocole (piloté par win-helper.js) :
#   - Node écrit une requête JSON sur une ligne dans stdin : {"id":1,"action":"capture"}
#   - On répond une ligne préfixée par __CF__ sur stdout : __CF__<base64(JSON UTF-8)>
#     La réponse ENTIÈRE est armée en base64 : stdout traverse l'encodage CONSOLE
#     (non-UTF8, ex. CP850) — du texte de document brut y perdrait ses accents, et
#     un caractère « best-fit » (“ ” devient ") peut CASSER le JSON → réponse
#     silencieusement perdue côté Node et timeout (bug observé sur la capture).
#   Le texte corrigé NE transite PAS par ici : il est placé dans le presse-papier
#   côté Node, et on le colle via un Ctrl+V simulé (keybd_event).
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'SilentlyContinue'

# Débogage : activé par la variable d'environnement CF_DEBUG (posée par win-helper.js
# d'après debug.js). On journalise sur STDERR — le protocole __CF__ reste SEUL sur
# stdout — et win-helper.js relaie ces lignes vers la console quand DEBUG est vrai.
$script:dbg = ($env:CF_DEBUG -eq '1')
function DbgPS([string]$m) {
  if ($script:dbg) { try { [Console]::Error.WriteLine('[PS ' + (Get-Date -Format 'HH:mm:ss.fff') + '] ' + $m) } catch {} }
}

# UI Automation (présent sur tout Windows via .NET Framework).
try { Add-Type -AssemblyName UIAutomationClient } catch {}
try { Add-Type -AssemblyName UIAutomationTypes } catch {}

# P/Invoke user32 : fenêtres + clavier. keybd_event est plus fiable que SendKeys
# pour Ctrl+C / Ctrl+V (pas de soucis de timing des modificateurs).
$cs = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct CFRECT { public int Left, Top, Right, Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct CFGUI {
  public int cbSize;
  public int flags;
  public IntPtr hwndActive;
  public IntPtr hwndFocus;     // <- le contrôle qui a le focus clavier
  public IntPtr hwndCapture;
  public IntPtr hwndMenuOwner;
  public IntPtr hwndMoveSize;
  public IntPtr hwndCaret;
  public CFRECT rcCaret;
}

public static class CFWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  // Code virtuel -> scan code matériel : les moteurs Gecko/Chromium exigent un
  // scan code non nul, sinon ils ignorent la frappe synthétique.
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  // Récupère le contrôle focalisé du thread (sans AttachThreadInput requis).
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref CFGUI lpgui);
  // EM_GETSEL : start/end via pointeurs DWORD (gère >64K).
  [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr SendMessageSel(IntPtr hWnd, uint Msg, ref int wParam, ref int lParam);
  // EM_SETSEL : start/end passés par valeur.
  [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr SendMessageVal(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  // État clavier PHYSIQUE : pour attendre le relâchement du raccourci avant le Ctrl+C.
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  // WM_GETTEXT vers un StringBuilder : repli texte des contrôles natifs (sans Ctrl+C).
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageText(IntPtr hWnd, uint Msg, IntPtr wParam, System.Text.StringBuilder lParam);
  // OpenProcess : détecte une cible ÉLEVÉE (admin) — un échec ACCESS_DENIED (5) signe
  // un process en élévation, dont l'UIPI Windows bloque l'injection clavier ET l'UIA.
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  // Numéro de séquence du presse-papier : INCRÉMENTÉ à chaque modification, par
  // n'importe quelle source. Sert à savoir si un Ctrl+C a VRAIMENT déclenché une
  // copie (même si le texte ressort vide), indépendamment de notre lecture du texte.
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
'@
Add-Type -TypeDefinition $cs

# État conservé entre les requêtes (le report d'application en dépend).
$script:hwnd      = [IntPtr]::Zero
$script:el        = $null
$script:range     = $null
$script:selText   = $null            # texte exact sélectionné (repli FindText)
$script:focusHwnd = [IntPtr]::Zero   # contrôle Edit/RichEdit focalisé (EM_SETSEL)
$script:selStart  = 0                # bornes de la sélection native (EM_GETSEL)
$script:selEnd    = 0
$script:procName  = ''               # nom du process de la fenêtre cible (ex. WINWORD)
$script:wordRange = $null            # plage Word (COM) capturée : sélection d'ORIGINE figée
$script:wordTextCap = $null          # Range.Text de la plage figée AU MOMENT de la capture

# Réponse sur UNE ligne : __CF__ + base64(JSON en UTF-8). Le base64 (ASCII pur)
# traverse n'importe quel encodage console sans perte — le JSON brut, lui, se
# faisait corrompre (accents) voire casser (« best-fit » de “ ” en ") par la
# console non-UTF8, et la réponse était alors jetée en silence côté Node.
function Out-Json($o) {
  $j = $null
  try { $j = $o | ConvertTo-Json -Compress -Depth 5 } catch {}
  if ([string]::IsNullOrEmpty($j)) {
    # Sérialisation impossible : réponse d'erreur minimale AVEC l'id, pour que la
    # promesse Node soit rejetée immédiatement au lieu d'attendre le timeout.
    $rid = 0
    try { $rid = [int64]$o.id } catch {}
    $j = '{"id":' + $rid + ',"ok":false,"error":"json-serialize"}'
  }
  $b = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($j))
  [Console]::Out.WriteLine('__CF__' + $b)
  [Console]::Out.Flush()
}

# Décode une chaîne base64 (UTF-8) reçue de Node ; '' si vide/invalide.
function FromB64([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  try { return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($s)) } catch { return '' }
}

# Ramène une fenêtre au premier plan malgré le verrou « anti-vol de focus » de
# Windows : on attache la file d'entrée de notre thread à celle du thread
# propriétaire du premier plan le temps de l'opération (pattern recommandé).
# Renvoie $true si la fenêtre cible est bien au premier plan après coup.
function Restore-Window([IntPtr]$target) {
  if ($target -eq [IntPtr]::Zero) { return $false }
  $fg = [CFWin]::GetForegroundWindow()
  # Déjà au premier plan (cas immédiat : le HUD ne vole pas le focus) → on ne
  # touche À RIEN. Le bricolage de focus ci-dessous peut faire perdre le caret /
  # collapser la sélection encore vivante dans certaines apps ; on l'évite.
  if ($fg -eq $target) { return $true }
  $me = [CFWin]::GetCurrentThreadId()
  $procId = [uint32]0
  $ft = [CFWin]::GetWindowThreadProcessId($fg, [ref]$procId)
  [CFWin]::AttachThreadInput($me, $ft, $true) | Out-Null
  # Tap sur Alt : lève le verrou anti-vol de focus de Windows. Sans ça,
  # SetForegroundWindow est ignoré quand on n'est pas déjà au premier plan
  # (typiquement depuis un clic sur notification) → la fenêtre cible ne revient pas.
  [CFWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # Alt down
  [CFWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # Alt up (KEYEVENTF_KEYUP=0x2)
  # SW_RESTORE seulement si minimisée (ne dé-maximise pas une fenêtre plein écran).
  if ([CFWin]::IsIconic($target)) { [CFWin]::ShowWindow($target, 9) | Out-Null }
  [CFWin]::BringWindowToTop($target) | Out-Null
  [CFWin]::SetForegroundWindow($target) | Out-Null
  [CFWin]::AttachThreadInput($me, $ft, $false) | Out-Null
  Start-Sleep -Milliseconds 90
  return ([CFWin]::GetForegroundWindow() -eq $target)
}

# Durée pendant laquelle Ctrl+touche reste enfoncé. 12 ms était trop court pour
# certaines apps qui échantillonnent le clavier moins souvent (Electron/VS Code,
# Gecko/Thunderbird) → la combinaison passait inaperçue « par moments ». 35 ms
# reste imperceptible mais fiabilise la prise en compte du Ctrl+C / Ctrl+V.
$script:keyHoldMs = 35

# Relâche les modificateurs qui pourraient être ENCORE enfoncés : le raccourci
# global Ctrl+Alt+C peut laisser Alt (voire Maj/Win) « collé » au moment où l'on
# simule Ctrl+C / Ctrl+V → la combinaison devient Ctrl+Alt+C et la copie/collage
# échoue (« Aucun texte sélectionné »). On NE touche PAS à Ctrl (géré juste après).
# Inoffensif si aucune touche n'est tenue.
function Release-Modifiers {
  foreach ($vk in 0x12, 0x10, 0xA0, 0xA1, 0xA4, 0xA5, 0x5B, 0x5C) {  # Alt, Maj, LMaj, RMaj, LAlt, RAlt, LWin, RWin
    [CFWin]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)            # KEYEVENTF_KEYUP=0x2
  }
}

# Frappe d'une touche AVEC son scan code matériel (MapVirtualKey) : indispensable
# pour les apps à moteur Gecko/Chromium (Thunderbird, VS Code…), qui ignorent les
# frappes synthétiques au scan code nul → c'est la cause des Ctrl+C / Ctrl+V qui
# « ne prennent pas » dans ces applications.
function KeyDown([byte]$vk) {
  $sc = [byte]([CFWin]::MapVirtualKey([uint32]$vk, 0))
  [CFWin]::keybd_event($vk, $sc, 0, [UIntPtr]::Zero)
}
function KeyUp([byte]$vk) {
  $sc = [byte]([CFWin]::MapVirtualKey([uint32]$vk, 0))
  [CFWin]::keybd_event($vk, $sc, 2, [UIntPtr]::Zero)   # KEYEVENTF_KEYUP=0x2
}

# Variantes EXTENDED-KEY pour la touche Insert (et autres touches « grises » :
# flèches, Home/End, PgUp/PgDn). Sans le flag 0x1, Insert envoie le scan code de
# Numpad-0/Ins ; avec, c'est la touche Insert dédiée, ce qu'attendent Gecko/Win32.
function KeyDownExt([byte]$vk) {
  $sc = [byte]([CFWin]::MapVirtualKey([uint32]$vk, 0))
  [CFWin]::keybd_event($vk, $sc, 1, [UIntPtr]::Zero)   # KEYEVENTF_EXTENDEDKEY=0x1
}
function KeyUpExt([byte]$vk) {
  $sc = [byte]([CFWin]::MapVirtualKey([uint32]$vk, 0))
  [CFWin]::keybd_event($vk, $sc, 3, [UIntPtr]::Zero)   # EXTENDED|KEYUP = 0x1|0x2
}

function Send-Copy {
  Release-Modifiers
  Start-Sleep -Milliseconds 20
  KeyDown 0x11   # Ctrl
  KeyDown 0x43   # C
  Start-Sleep -Milliseconds $script:keyHoldMs
  KeyUp 0x43
  KeyUp 0x11
}

# Combinaison historique de copie reconnue par la plupart des apps Win32 et par
# Gecko (Firefox/Thunderbird). Sert d'alternative quand Ctrl+C est intercepté ou
# ne déclenche pas la copie (raccourci interne, focus exotique…). Insert = VK 0x2D
# et DOIT être envoyée en touche étendue (flag 0x1).
function Send-CopyIns {
  Release-Modifiers
  Start-Sleep -Milliseconds 20
  KeyDown 0x11        # Ctrl
  KeyDownExt 0x2D     # Insert (touche dédiée, non Numpad-0)
  Start-Sleep -Milliseconds $script:keyHoldMs
  KeyUpExt 0x2D
  KeyUp 0x11
}

function Send-Paste {
  Release-Modifiers
  Start-Sleep -Milliseconds 20
  KeyDown 0x11   # Ctrl
  KeyDown 0x56   # V
  Start-Sleep -Milliseconds $script:keyHoldMs
  KeyUp 0x56
  KeyUp 0x11
}

# Lit la sélection courante de l'élément focalisé via UIA (ou $null).
function Get-CurrentSelection {
  try {
    $e = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $e) { return $null }
    $pat = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
      $tp = [System.Windows.Automation.TextPattern]$pat
      $sel = $tp.GetSelection()
      if ($sel -and $sel.Length -gt 0) { return $sel[0] }
    }
  } catch {}
  return $null
}

# Confirme qu'une vraie sélection (non vide) est active : certains contrôles
# acceptent Select() sans effet, il faut donc vérifier plutôt que faire confiance.
function Test-HasSelection {
  $r = Get-CurrentSelection
  if ($null -eq $r) { return $false }
  try { $t = $r.GetText(50000); return ($null -ne $t -and $t.Length -gt 0) } catch { return $false }
}

# Rétablit la sélection d'origine, du mécanisme le plus fiable au plus générique :
#   0) 'live'  : la sélection d'origine est ENCORE active → ne rien toucher
#   1) 'emsel' : EM_SETSEL sur le contrôle natif (Bloc-notes, RichEdit, champs Win32)
#   2) 'range' : re-sélection de la plage UIA capturée (emplacement exact)
#   3) 'find'  : recherche du texte exact dans le document UIA (FindText)
# Renvoie le nom de la méthode qui a réussi, ou 'none'.
#
# $immediate = $true : la fenêtre n'a JAMAIS perdu le premier plan. On rétablit la sélection
# du plus fiable au plus générique. Cas clé : la sélection a pu être COLLAPSÉE pendant
# l'attente (HUD, focus transitoire, copie) → si on collait alors au caret, on écrirait À
# CÔTÉ (texte AJOUTÉ au lieu de remplacé : bug observé dans Thunderbird/Firefox/Chrome). On :
#  - garde 'live' si la sélection est confirmée encore vivante (UIA la voit = l'original,
#    ou contrôle natif intact) → collage direct au caret = bon endroit ;
#  - RÉACQUIERT la sélection (range.Select()/FindText) si l'UIA VOIT le document mais que la
#    sélection courante NE correspond PLUS à l'original (= perdue) — c'est ce qui répare
#    Thunderbird/Outlook & co ;
#  - retombe sur le collage au caret si l'UIA est AVEUGLE (Firefox/Chrome ne voient rien) :
#    on ne peut pas réacquérir sans risquer de collapser une sélection vivante invisible.
function Restore-Selection([string]$orig, [bool]$immediate = $false) {
  $uiaSawSel = $false   # l'UIA voit-il une sélection ? (distingue « perdue » d'« UIA aveugle »)
  # 0) La sélection d'origine est-elle TOUJOURS active ? Comparaison TOLÉRANTE aux fins
  #    de ligne (l'UIA de Chromium renvoie \n, le presse-papier \r\n) → une sélection
  #    multi-lignes encore vivante est bien reconnue. Si ça correspond, on ne touche À RIEN.
  if ($orig -and $orig.Length -gt 0) {
    try {
      $cur = Get-CurrentSelection
      if ($null -ne $cur) {
        $uiaSawSel = $true
        $t = $cur.GetText(50000)
        if ($null -ne $t) {
          $tn = ($t -replace "`r`n", "`n")
          $on = ($orig -replace "`r`n", "`n")
          if ($tn -eq $on -or $tn.Trim() -eq $on.Trim()) { return 'live' }
        }
      }
    } catch {}
  }

  # 1) Contrôle natif : on rétablit directement les bornes de caractères. Fiable et SANS
  #    effet de bord (n'affecte ni Gecko ni Word). On ne renvoie 'emsel' QUE si EM_SETSEL
  #    a réellement posé la sélection sur [selStart,selEnd] (vérif STRICTE) : sur un HWND
  #    non-Edit (ex. fenêtre Gecko qui répond du bruit aux messages Edit), la vérif échoue
  #    → on n'invente pas de fausse re-sélection. En immédiat, si la sélection native est
  #    déjà intacte, elle est vivante → 'live'.
  if ($script:focusHwnd -ne [IntPtr]::Zero -and $script:selEnd -ne $script:selStart) {
    try {
      if ($immediate) {
        $gs = 0; $ge = 0
        [CFWin]::SendMessageSel($script:focusHwnd, 0xB0, [ref]$gs, [ref]$ge) | Out-Null  # EM_GETSEL
        if ($gs -eq $script:selStart -and $ge -eq $script:selEnd) { return 'live' }
      }
      [CFWin]::SendMessageVal($script:focusHwnd, 0xB1, [IntPtr]::new($script:selStart), [IntPtr]::new($script:selEnd)) | Out-Null  # EM_SETSEL
      $gs = 0; $ge = 0
      [CFWin]::SendMessageSel($script:focusHwnd, 0xB0, [ref]$gs, [ref]$ge) | Out-Null  # EM_GETSEL (vérif STRICTE)
      if ($gs -eq $script:selStart -and $ge -eq $script:selEnd) { return 'emsel' }
    } catch {}
  }

  # IMMÉDIAT + UIA AVEUGLE (n'a vu AUCUNE sélection) : typiquement Firefox/Chrome (l'UIA
  # ne voit pas le contenu web). La sélection est peut-être encore vivante mais invisible →
  # range.Select()/FindText la collapseraient. On colle donc au caret (repli, inchangé).
  # En revanche, si l'UIA A VU une sélection (qui ne correspond plus à l'original = perdue),
  # on NE s'arrête PAS ici : on la RÉACQUIERT ci-dessous (corrige Thunderbird/Outlook…).
  if ($immediate -and -not $uiaSawSel) { return 'live' }

  if ($null -ne $script:el) { try { $script:el.SetFocus() | Out-Null } catch {} }

  # 2) Plage UIA capturée (REPORT, ou IMMÉDIAT quand la sélection a été perdue mais que
  #    l'UIA voit le document) → re-sélectionne EXACTEMENT le texte d'origine.
  if ($null -ne $script:range) {
    try {
      $script:range.Select()
      if (Test-HasSelection) { return 'range' }
    } catch {}
  }

  # 3) Recherche du texte exact dans le document UIA (repli de la plage capturée).
  if ($orig -and $orig.Length -gt 0 -and $null -ne $script:el) {
    try {
      $pat = $null
      if ($script:el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
        $tp = [System.Windows.Automation.TextPattern]$pat
        $found = $tp.DocumentRange.FindText($orig, $false, $false)  # exact, vers l'avant
        if ($null -ne $found) {
          $found.Select()
          if (Test-HasSelection) { return 'find' }
        }
      }
    } catch {}
  }
  return 'none'
}

# Boucle principale : lit une requête par ligne sur stdin jusqu'à fermeture.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }          # stdin fermé → on quitte proprement
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $reqId  = $req.id
  $action = [string]$req.action
  DbgPS ("req '" + $action + "' #" + $reqId)

  try {
    switch ($action) {

      # Mémorise la fenêtre active + le contrôle focalisé + sa sélection.
      # Deux mécanismes en parallèle, du plus fiable au plus générique :
      #   1) natif Edit/RichEdit  -> EM_GETSEL (bornes de caractères)
      #   2) UI Automation        -> TextPatternRange + texte sélectionné
      'capture' {
        $script:hwnd      = [CFWin]::GetForegroundWindow()
        $script:el        = $null
        $script:range     = $null
        $script:selText   = $null
        $script:focusHwnd = [IntPtr]::Zero
        $script:selStart  = 0
        $script:selEnd    = 0
        $script:procName  = ''
        $txt = $null
        $txtSrc = '(aucune)'   # d'où vient le texte de capture (debug)

        # Nom du process de la fenêtre cible : active le chemin COM pour Word.
        $script:wordRange = $null
        $wpid = [uint32]0
        try {
          [CFWin]::GetWindowThreadProcessId($script:hwnd, [ref]$wpid) | Out-Null
          $script:procName = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName
        } catch {}

        # Cible en administrateur ? Si on ne peut pas OUVRIR le process (ACCESS_DENIED=5),
        # il est élevé → l'UIPI bloque toute injection clavier ET l'UIA, donc la copie ne
        # pourra pas aboutir. On le remonte pour afficher un message d'action (et non un
        # « Aucun texte sélectionné » trompeur). Best-effort : en cas de doute, $false.
        $elevated = $false
        if ($wpid -ne [uint32]0) {
          try {
            $ph = [CFWin]::OpenProcess(0x1000, $false, $wpid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if ($ph -eq [IntPtr]::Zero) {
              if ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 5) { $elevated = $true }
            } else { [CFWin]::CloseHandle($ph) | Out-Null }
          } catch {}
        }

        # Word : on FIGE la plage de la sélection d'origine (COM) au déclenchement.
        # Ainsi, même si l'utilisateur clique ailleurs pendant la correction, on
        # remplacera bien le texte d'ORIGINE (et pas là où le curseur est rendu).
        if ($script:procName -ieq 'WINWORD') {
          try {
            $w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
            $s = $w.Selection
            if ($null -ne $s -and $s.Start -ne $s.End) { $script:wordRange = $s.Range.Duplicate }
          } catch { $script:wordRange = $null }
        }
        # Outlook (classique / Office desktop) : la fenêtre de rédaction est un éditeur
        # WORD (WordEditor = Word.Document). Au COLLAGE, Word/Outlook IGNORENT le HTML du
        # presse-papier au profit du texte brut → la mise en forme est perdue (« ça ne
        # prend pas la mise en forme » signalé sur Outlook). On gèle donc la MÊME plage
        # COM que pour Word : à l'application on corrige par PORTIONS (diff) directement
        # dans le document → gras/couleur/police/liens conservés, sans passer par le HTML.
        #
        # On ANCRE sur la fenêtre Outlook AU PREMIER PLAN ($ol.ActiveWindow()), PAS sur
        # ActiveInspector : ce dernier peut pointer une fenêtre de lecture résiduelle (mail
        # double-cliqué puis réduit) → on figerait/éditerait le MAUVAIS mail. Selon la
        # classe de la fenêtre active :
        #   - olInspector (35) : rédaction/lecture pop-out  → .WordEditor
        #   - olExplorer  (34) : volet de lecture           → .ActiveInlineResponseWordEditor
        #     (réponse/transfert EN LIGNE dans la fenêtre principale)
        # (if autonomes, PAS elseif : un commentaire ou saut de ligne entre accolade
        # fermante et elseif casse l'analyse PowerShell ; et $cls vaut 34 OU 35.)
        if ($script:procName -ieq 'OUTLOOK') {
          try {
            $ol = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
            $wordEd = $null
            $aw = $ol.ActiveWindow()
            if ($null -ne $aw) {
              $cls = [int]$aw.Class
              if ($cls -eq 35) { try { $wordEd = $aw.WordEditor } catch {} }                      # olInspector : $null si mail texte brut
              if ($cls -eq 34) { try { $wordEd = $aw.ActiveInlineResponseWordEditor } catch {} }   # olExplorer  : $null si pas de réponse en ligne active
            }
            if ($null -ne $wordEd) {
              # La sélection vient du document focalisé : comme on a ancré sur la fenêtre
              # ACTIVE, Application.Selection reflète bien CE document. Filet ultime au
              # collage : la plage figée n'est éditée que si son texte n'a pas changé depuis
              # la capture (sinon repli collage), donc même un Selection « qui dérive » ne
              # corrompt rien.
              $s = $wordEd.Application.Selection
              if ($null -ne $s -and $s.Start -ne $s.End) { $script:wordRange = $s.Range.Duplicate }
            }
          } catch { $script:wordRange = $null }
        }

        # Texte BRUT de la plage figée (Range.Text tel quel : CR, sauts doux `v,
        # marques de cellule...). Il part vers Node (champ wtext, réponse base64) qui
        # y calcule les éditions diff SUR CE TEXTE → offsets valides par construction.
        # Il est aussi gardé ici pour vérifier à l'application que la plage n'a pas
        # changé depuis la capture (comparaison stricte possible : même source).
        $script:wordTextCap = $null
        if ($null -ne $script:wordRange) {
          try {
            $wt = [string]$script:wordRange.Text
            if ($wt.Length -le 20000) { $script:wordTextCap = $wt }   # au-delà, le diff Node renonce de toute façon
          } catch {}
        }

        # 1) Contrôle focalisé + sélection native (EM_GETSEL).
        try {
          $procId = [uint32]0
          $tid = [CFWin]::GetWindowThreadProcessId($script:hwnd, [ref]$procId)
          $gui = New-Object CFGUI
          $gui.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($gui)
          if ([CFWin]::GetGUIThreadInfo($tid, [ref]$gui)) {
            $script:focusHwnd = $gui.hwndFocus
            if ($script:focusHwnd -ne [IntPtr]::Zero) {
              $s = 0; $e = 0
              [CFWin]::SendMessageSel($script:focusHwnd, 0xB0, [ref]$s, [ref]$e) | Out-Null  # EM_GETSEL
              $script:selStart = $s
              $script:selEnd = $e
            }
          }
        } catch {}

        # 2) UI Automation (repli pour les contrôles non-Win32).
        try {
          $a = [System.Windows.Automation.AutomationElement]::FocusedElement
          if ($null -ne $a) {
            $script:el = $a
            $pat = $null
            if ($a.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
              $tp = [System.Windows.Automation.TextPattern]$pat
              $sels = $tp.GetSelection()
              if ($sels -and $sels.Length -gt 0) {
                $script:range = $sels[0].Clone()
                try { $txt = $sels[0].GetText(50000); $script:selText = $txt } catch {}
                if (-not [string]::IsNullOrEmpty($txt)) { $txtSrc = 'uia' }
              }
            }
          }
        } catch {}

        # Replis texte DIRECTS (sans Ctrl+C) : nourrissent `text`, utilisé côté Node
        # comme ultime source si la copie simulée rate. C'est ce qui supprime « Aucun
        # texte sélectionné » sur Word et les champs natifs même quand Ctrl+C échoue.
        #   a) Word (COM) : la sélection figée. Marque de cellule (7) → tab, comme le
        #      presse-papier, pour rester cohérent côté IA et diff.
        if ([string]::IsNullOrEmpty($txt) -and $null -ne $script:wordRange) {
          try { $txt = ([string]$script:wordRange.Text).Replace([char]7, [char]9); $script:selText = $txt; if (-not [string]::IsNullOrEmpty($txt)) { $txtSrc = 'word-com' } } catch {}
        }
        #   b) Contrôle natif Edit/RichEdit : on lit tout le texte (WM_GETTEXT) et on
        #      découpe la sélection [selStart, selEnd) — les mêmes bornes qu'EM_SETSEL
        #      utilisera pour ré-appliquer, donc cohérent même si le rendu diffère.
        if ([string]::IsNullOrEmpty($txt) -and $script:focusHwnd -ne [IntPtr]::Zero -and $script:selEnd -gt $script:selStart) {
          try {
            $len = ([CFWin]::SendMessageVal($script:focusHwnd, 0x000E, [IntPtr]::Zero, [IntPtr]::Zero)).ToInt32()  # WM_GETTEXTLENGTH
            if ($len -gt 0 -and $len -lt 200000 -and $script:selEnd -le $len) {
              $sb = New-Object System.Text.StringBuilder ($len + 1)
              [CFWin]::SendMessageText($script:focusHwnd, 0x000D, [IntPtr]::new($len + 1), $sb) | Out-Null  # WM_GETTEXT
              $all = $sb.ToString()
              if ($script:selEnd -le $all.Length) {
                $sub = $all.Substring($script:selStart, $script:selEnd - $script:selStart)
                if (-not [string]::IsNullOrEmpty($sub)) { $txt = $sub; $script:selText = $sub; $txtSrc = 'native-wm_gettext' }
              }
            }
          } catch {}
        }

        $hasSel = (($script:selEnd -ne $script:selStart) -or ($null -ne $script:range))
        $txtLen = $(if ([string]::IsNullOrEmpty($txt)) { 0 } else { $txt.Length })
        $wtLen = -1
        if ($null -ne $script:wordTextCap) { $wtLen = $script:wordTextCap.Length }
        DbgPS ("capture: proc='" + $script:procName + "' hwnd=" + $script:hwnd + " elevated=" + $elevated +
               " | natif focus=" + ($script:focusHwnd -ne [IntPtr]::Zero) + " sel=[" + $script:selStart + ',' + $script:selEnd + ']' +
               " | uia.range=" + ($null -ne $script:range) + " word.range=" + ($null -ne $script:wordRange) +
               " | texte direct: src=" + $txtSrc + " len=" + $txtLen + " | wtext.len=" + $wtLen)
        Out-Json @{ id = $reqId; ok = $true; hwnd = $script:hwnd.ToInt64(); hasRange = $hasSel; text = $txt; wtext = $script:wordTextCap; proc = $script:procName; elevated = $elevated }
      }

      'copy'    { Send-Copy;    Out-Json @{ id = $reqId; ok = $true } }
      'copyins' { Send-CopyIns; Out-Json @{ id = $reqId; ok = $true } }   # Ctrl+Insert (alternative à Ctrl+C)
      'paste'   { Send-Paste;   Out-Json @{ id = $reqId; ok = $true } }

      # Numéro de séquence du presse-papier — diagnostic « un copier a-t-il VRAIMENT
      # eu lieu ? ». Si la séquence ne bouge pas après un Ctrl+C, c'est qu'aucune
      # copie n'a été déclenchée (ni par l'app ni par personne) — distingue ça d'une
      # copie qui aurait abouti à un texte vide.
      'clipseq' { Out-Json @{ id = $reqId; ok = $true; seq = [int64][CFWin]::GetClipboardSequenceNumber() } }

      # Attend le relâchement PHYSIQUE des modificateurs du raccourci AVANT de simuler
      # Ctrl+C : un Alt (ou Ctrl) encore enfoncé transforme Ctrl+C en Ctrl+Alt+C et la
      # copie échoue silencieusement → « Aucun texte sélectionné ». C'est la cause n°1
      # des ratés intermittents. Plafonné à ~600 ms : au pire on retombe sur le délai
      # fixe d'avant. On termine par Release-Modifiers (filet si une touche reste).
      'waitkeysup' {
        $waited = 0
        while ($waited -lt 600) {
          $down = $false
          foreach ($vk in 0x11, 0x12, 0x10, 0x5B, 0x5C) {  # Ctrl, Alt, Maj, LWin, RWin
            if (([int]([CFWin]::GetAsyncKeyState($vk)) -band 0x8000) -ne 0) { $down = $true; break }
          }
          if (-not $down) { break }
          Start-Sleep -Milliseconds 10
          $waited += 10
        }
        Release-Modifiers
        DbgPS ("waitkeysup: relachement attendu " + $waited + "ms")
        Out-Json @{ id = $reqId; ok = $true; waited = $waited }
      }

      # HWND du premier plan actuel : sert au polling « l'utilisateur est-il
      # revenu sur sa fenêtre d'origine ? » pendant le report d'application.
      'foreground' {
        Out-Json @{ id = $reqId; ok = $true; hwnd = ([CFWin]::GetForegroundWindow()).ToInt64() }
      }

      # Applique : restaure la fenêtre, re-sélectionne EXACTEMENT le texte d'origine
      # (plage capturée, sinon FindText), puis colle.
      #   Word/Outlook : édition directe par l'API Word (COM) sur la plage figée → mise
      #   en forme préservée et indépendance totale vis-à-vis du caret courant.
      #   immediate=true : la fenêtre est restée au premier plan. On NE re-sélectionne
      #   que de façon PRUDENTE (cf. Restore-Selection $immediate) : collage direct si la
      #   sélection est confirmée vivante ou l'UIA aveugle (Gecko), re-sélection sûre
      #   (EM_SETSEL/UIA) si le caret a bougé dans une app où on peut le détecter.
      'apply' {
        $orig = FromB64 ([string]$req.text_b64)
        if ([string]::IsNullOrEmpty($orig)) { $orig = $script:selText }  # repli si non transmis
        $corrected = FromB64 ([string]$req.corrected_b64)
        $editsJson = FromB64 ([string]$req.edits_b64)
        $immediate = [bool]$req.immediate
        $fgOk = Restore-Window $script:hwnd
        $method = 'none'
        $done = $false
        DbgPS ("apply: proc='" + $script:procName + "' immediate=" + $immediate + " fgOk=" + $fgOk +
               " word.range=" + ($null -ne $script:wordRange) + " corrLen=" + $corrected.Length + " editsLen=" + $editsJson.Length)

        # Word ET Outlook (même moteur d'édition Word) : remplacer le texte VIA L'API
        # Word (COM), sur la plage d'ORIGINE figée à la capture ($script:wordRange) —
        # indépendant de l'endroit où le curseur est rendu (donc résout AUSSI le « le
        # curseur a bougé → la sélection n'est plus reprise » : on édite la plage figée,
        # pas le caret courant). On ne touche pas au paragraphe → bordure, style, table
        # des matières conservés. Et on n'applique QUE les portions changées (diff) → la
        # mise en forme VARIÉE du texte (gras, couleurs par mot) est préservée. C'est le
        # chemin qui fait que la mise en forme « prend » enfin dans Outlook.
        if ((($script:procName -ieq 'WINWORD') -or ($script:procName -ieq 'OUTLOOK')) -and -not [string]::IsNullOrEmpty($corrected) -and $null -ne $script:wordRange) {
          try {
            $base = [int]$script:wordRange.Start
            $doc  = $script:wordRange.Document
            $rangeText = [string]$script:wordRange.Text
            # TABLEAU ? Word borne les cellules par des MARQUES DE CELLULE (char 7 ; une
            # fin de cellule vaut CR + char 7, soit 2 caractères là où le presse-papier
            # n'en rend qu'un) → des offsets d'édition ne peuvent pas être fiables dans un
            # tableau. On n'édite donc JAMAIS un tableau par diff : le collage HTML (plus
            # bas) recrée la structure. (Un remplacement global COM, lui, fusionnerait les
            # cellules de la ligne dans la première — bug observé par le passé.)
            $isTable = ($rangeText.IndexOf([char]7) -ge 0)
            # La plage a-t-elle changé depuis la capture ? Comparaison STRICTE de
            # Range.Text avec le texte mémorisé à la capture ($script:wordTextCap) : MÊME
            # SOURCE des deux côtés → aucun piège de représentation (apostrophes courbes,
            # insécables, sauts doux…), -ceq redevient sûr. Les éditions reçues de Node
            # sont calculées sur CE texte-là (wtext, cf. rich-paste.js diffWordEdits) :
            # si la plage n'a pas changé, les offsets sont valides PAR CONSTRUCTION.
            # Fini l'ancienne garde de longueur exacte contre le presse-papier : elle
            # échouait sur des différences bénignes (puces de liste, sauts doux Maj+Entrée,
            # insécables) et faisait retomber sur un collage qui APLATISSAIT toute la mise
            # en forme (bug observé sur un article entier).
            $unchanged = ($null -ne $script:wordTextCap -and $rangeText -ceq $script:wordTextCap)
            $applied = $false

            # Chemin SÛR (word-diff) : n'édite QUE les portions changées → la mise en
            # forme variée (gras, couleurs par mot) est préservée, et le document garde
            # ses caractères RÉELS (apostrophes courbes, insécables, sauts doux) partout
            # où rien n'a changé — les équivalences de représentation sont neutralisées
            # côté Node (vues 1:1 de diffWordEdits) et ne génèrent aucune édition.
            # NB : '[]' compte comme VIDE — en PS 5.1, ConvertFrom-Json '[]' rend $null,
            # et une liste vide ferait un no-op "reussi" qui court-circuiterait le repli
            # word-affix/collage (correction silencieusement perdue).
            if ($unchanged -and -not $isTable -and -not [string]::IsNullOrEmpty($editsJson) -and $editsJson -ne '[]') {
              # word-diff RESILIENT : chaque edition est independante (un echec n'annule plus
              # tout le word-diff -> on ne retombe pas sur le collage qui aplatit). On tente
              # 2 facons d'obtenir la sous-plage (Document.Range, puis Range.Duplicate+SetRange)
              # car selon l'editeur Word/Outlook l'une ou l'autre peut echouer. On journalise
              # le compte + la derniere erreur pour diagnostiquer sans deviner.
              try {
                # PS 5.1 : ConvertFrom-Json emet un tableau JSON de TETE comme UN SEUL objet
                # tableau (non deroule). @(pipeline) le renvoyait alors IMBRIQUE -> la boucle
                # liait $ed au tableau ENTIER, d ou $ed.s = Object[] et "Impossible de convertir
                # Object[] en Int32" : word-diff ne s appliquait JAMAIS (on tombait sur le repli
                # qui aplatit). On capture le tableau DIRECTEMENT puis on normalise en tableau plat.
                $edits = $editsJson | ConvertFrom-Json
                if ($edits -isnot [array]) { $edits = @($edits) }
                if ($edits.Count -eq 1 -and ($edits[0] -is [array])) { $edits = $edits[0] }
                $docEnd = 0
                try { $docEnd = [int]$doc.Content.End } catch { $docEnd = 0 }
                $okCount = 0; $failCount = 0; $lastErr = ''
                # END -> START : editer d'abord les positions hautes garde les offsets bas valides.
                foreach ($ed in @($edits | Sort-Object -Property s -Descending)) {
                  if ($null -eq $ed) { continue }   # filet : entree nulle (liste vide/malformee)
                  $rs = [int]($base + [int]$ed.s); $re = [int]($base + [int]$ed.e)
                  if ($rs -lt 0 -or $re -lt $rs) { continue }
                  if ($docEnd -gt 0 -and $re -gt $docEnd) { $failCount++; continue }
                  $newt = (([string]$ed.t) -replace "`r`n", "`r") -replace "`n", "`r"
                  # Span d'origine contenant un saut DOUX (Maj+Entrée, char 11) sans marque
                  # de paragraphe : les fins de ligne du remplacement sont réécrites en saut
                  # doux, pour ne pas transformer un saut doux en paragraphe (ce genre de
                  # conversion AJOUTAIT de l'interligne dans les mails corrigés).
                  if ($re -gt $rs -and [int]$ed.e -le $rangeText.Length) {
                    $rawSpan = $rangeText.Substring([int]$ed.s, [int]$ed.e - [int]$ed.s)
                    if ($rawSpan.IndexOf([char]11) -ge 0 -and $rawSpan.IndexOf([char]13) -lt 0) { $newt = $newt.Replace("`r", "`v") }
                  }
                  $edOk = $false
                  # Methode 1 : Document.Range(start, end)
                  try {
                    $r = $doc.Range($rs, $re)
                    $r.Text = $newt; $edOk = $true
                  } catch {
                    $lastErr = $_.Exception.Message
                    # Methode 2 (repli) : Range.Duplicate + SetRange (parfois plus fiable cote Outlook)
                    try {
                      $r2 = $script:wordRange.Duplicate
                      $r2.SetRange($rs, $re)
                      $r2.Text = $newt; $edOk = $true
                    } catch { $lastErr = $_.Exception.Message }
                  }
                  if ($edOk) { $okCount++ } else { $failCount++ }
                }
                DbgPS ("  word-diff: ok=" + $okCount + " fail=" + $failCount + " lastErr='" + $lastErr + "'")
                if ($okCount -gt 0) { $applied = $true; $method = 'word-diff' }
              } catch { $applied = $false; DbgPS ("  word-diff EXC: " + $_.Exception.Message) }
            }

            if (-not $applied) {
              if ($isTable) {
                # Tableau sans diff sûr possible : on NE touche PAS via COM (le
                # remplacement global aplatirait la ligne dans la 1ʳᵉ cellule). On laisse
                # $done à $false → le collage HTML (Ctrl+V, plus bas) recrée le tableau.
                $method = 'word-table-paste'
              } else {
                # Repli word-affix : diff PRÉFIXE/SUFFIXE calculé sur le TEXTE RÉEL de la
                # plage Word ($rangeText), PAS sur le presse-papier → les offsets sont
                # TOUJOURS valides. Il prend le relais quand word-diff n'a pas pu jouer :
                # plage modifiée depuis la capture, aucune édition transmise par Node
                # (diff trop gros ou non pertinent), ou éditions toutes en échec. On ne
                # remplace QUE le segment central qui diffère : le préfixe et le suffixe
                # communs ne sont pas touchés (ils gardent gras/couleur/police), et le
                # centre hérite du format de son 1ᵉʳ caractère D'ORIGINE → une faute DANS
                # un mot rouge reste rouge.
                $rtA = (($rangeText.Replace([char]7, [char]9) -replace "`r`n", "`r") -replace "`n", "`r").TrimEnd("`r")
                $coA = (($corrected -replace "`r`n", "`r") -replace "`n", "`r").TrimEnd("`r")
                $maxPre = [Math]::Min($rtA.Length, $coA.Length)
                $pre = 0
                while ($pre -lt $maxPre -and $rtA[$pre] -ceq $coA[$pre]) { $pre++ }
                $suf = 0
                $maxSuf = $maxPre - $pre
                while ($suf -lt $maxSuf -and $rtA[$rtA.Length - 1 - $suf] -ceq $coA[$coA.Length - 1 - $suf]) { $suf++ }
                # Garde anti-mauvaise-cible / grosse réécriture : on n'édite en COM que si le
                # corrigé PARTAGE au moins UN TIERS de la plage = vraie correction (même à
                # plusieurs endroits). Sinon (document modifié depuis la capture, sélection COM
                # qui aurait dérivé sur un autre mail, ou reformulage massif) → $done reste
                # $false → repli collage : jamais de corruption ni d'écriture au mauvais endroit.
                # (comparaison entière : commun*3 >= longueur, sans division ni arrondi.)
                if ($rtA.Length -gt 0 -and (($pre + $suf) * 3) -ge $rtA.Length) {
                  # Fin exclue des marques de paragraphe via TrimEnd ci-dessus → pas de
                  # fusion. Le centre remplacé hérite du format du caractère d'origine en pre.
                  $doc.Range($base + $pre, $base + $rtA.Length - $suf).Text = $coA.Substring($pre, $coA.Length - $suf - $pre)
                  $applied = $true
                  $method = 'word-affix'
                } else {
                  $method = 'word-nomatch-paste'
                }
              }
            }

            $capLen = -1
            if ($null -ne $script:wordTextCap) { $capLen = $script:wordTextCap.Length }
            DbgPS ("  word: isTable=" + $isTable + " unchanged=" + $unchanged + " rtLen=" + $rangeText.Length + " capLen=" + $capLen + " -> method='" + $method + "' applied=" + $applied)

            if ($applied) {
              $done = $true            # AVANT Select() : si Select échoue, pas de repli (pas de doublon)
              $cNorm = (($corrected -replace "`r`n", "`r") -replace "`n", "`r").TrimEnd("`r")
              try { $doc.Range($base, $base + $cNorm.Length).Select() | Out-Null } catch {}  # retour visuel
            }
          } catch {}
        }

        if (-not $done) {
          # Re-sélection prudente AVANT de coller — y compris en immédiat : si la fenêtre
          # n'a jamais bougé mais que l'utilisateur a déplacé le caret (clic ailleurs dans
          # la même fenêtre), la sélection vivante a disparu et un collage « au caret »
          # raterait la cible. Restore-Selection ($immediate) garde le collage direct quand
          # la sélection est confirmée vivante (ou que l'UIA est aveugle, ex. Thunderbird),
          # et ne re-sélectionne (EM_SETSEL/UIA) que lorsque c'est sûr. NB : Word/Outlook
          # ne passent ici QUE si le chemin COM a échoué/abandonné (ex. tableau, ou COM
          # indisponible) → repli collage HTML : jamais pire que l'ancien comportement.
          $method = Restore-Selection $orig $immediate
          Start-Sleep -Milliseconds 50
          Send-Paste
        }
        DbgPS ("apply -> done=" + $done + " method='" + $method + "'")
        Out-Json @{ id = $reqId; ok = $true; foreground = $fgOk; method = $method }
      }

      default { Out-Json @{ id = $reqId; ok = $false; error = 'unknown action' } }
    }
  } catch {
    Out-Json @{ id = $reqId; ok = $false; error = $_.Exception.Message }
  }
}
