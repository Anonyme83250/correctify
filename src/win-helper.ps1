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
#   - On répond une ligne préfixée par __CF__ sur stdout : __CF__{"id":1,"ok":true,...}
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

function Out-Json($o) {
  $j = $o | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine('__CF__' + $j)
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
function Restore-Selection([string]$orig) {
  # 0) La sélection d'origine est peut-être TOUJOURS active : dans le cas immédiat,
  #    le HUD ne vole pas le focus, donc le texte reste sélectionné. Si le texte
  #    sélectionné courant correspond à l'original, on ne touche À RIEN — toute
  #    tentative de re-sélection (SetFocus/Select) peut au contraire collapser une
  #    sélection vivante et faire coller AU CURSEUR au lieu d'écraser (bug observé
  #    notamment dans Thunderbird, dont le support UIA est limité).
  if ($orig -and $orig.Length -gt 0) {
    try {
      $cur = Get-CurrentSelection
      if ($null -ne $cur) {
        $t = $cur.GetText(50000)
        if ($null -ne $t -and ($t -eq $orig -or $t.Trim() -eq $orig.Trim())) { return 'live' }
      }
    } catch {}
  }

  # 1) Contrôle natif : on rétablit directement les bornes de caractères.
  if ($script:focusHwnd -ne [IntPtr]::Zero -and $script:selEnd -ne $script:selStart) {
    try {
      [CFWin]::SendMessageVal($script:focusHwnd, 0xB1, [IntPtr]::new($script:selStart), [IntPtr]::new($script:selEnd)) | Out-Null  # EM_SETSEL
      $s = 0; $e = 0
      [CFWin]::SendMessageSel($script:focusHwnd, 0xB0, [ref]$s, [ref]$e) | Out-Null  # EM_GETSEL (vérif)
      if ($e -ne $s) { return 'emsel' }
    } catch {}
  }

  if ($null -ne $script:el) { try { $script:el.SetFocus() | Out-Null } catch {} }

  # 2) Plage UIA capturée.
  if ($null -ne $script:range) {
    try {
      $script:range.Select()
      if (Test-HasSelection) { return 'range' }
    } catch {}
  }

  # 3) Recherche du texte exact dans le document UIA.
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
        DbgPS ("capture: proc='" + $script:procName + "' hwnd=" + $script:hwnd + " elevated=" + $elevated +
               " | natif focus=" + ($script:focusHwnd -ne [IntPtr]::Zero) + " sel=[" + $script:selStart + ',' + $script:selEnd + ']' +
               " | uia.range=" + ($null -ne $script:range) + " word.range=" + ($null -ne $script:wordRange) +
               " | texte direct: src=" + $txtSrc + " len=" + $txtLen)
        Out-Json @{ id = $reqId; ok = $true; hwnd = $script:hwnd.ToInt64(); hasRange = $hasSel; text = $txt; proc = $script:procName; elevated = $elevated }
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

      # Applique : restaure la fenêtre, re-sélectionne EXACTEMENT le texte
      # d'origine (plage capturée, sinon FindText), puis colle.
      #   immediate=true : Word/l'app est resté au premier plan, la sélection
      #   d'origine est ENCORE vivante → on NE re-sélectionne PAS (range.Select()
      #   désynchronise le caret clavier dans Word) ; on colle directement par-
      #   dessus la sélection vivante, qui correspond au vrai caret de Ctrl+V.
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

        # Word : remplacer le texte VIA L'API Word (COM), sur la plage d'ORIGINE
        # figée à la capture ($script:wordRange) — indépendant de l'endroit où le
        # curseur est rendu. On ne touche pas au paragraphe → bordure, style, table
        # des matières conservés. Et on n'applique QUE les portions changées (diff)
        # → la mise en forme VARIÉE du texte (gras, couleurs par mot) est préservée.
        if (($script:procName -ieq 'WINWORD') -and -not [string]::IsNullOrEmpty($corrected) -and $null -ne $script:wordRange) {
          try {
            $base = [int]$script:wordRange.Start
            $doc  = $script:wordRange.Document
            $rangeText = [string]$script:wordRange.Text
            # TABLEAU ? Word sépare les cellules par une MARQUE DE CELLULE (char 7), alors
            # que le presse-papier ($orig) les sépare par une TABULATION (char 9). Sans
            # réconcilier 7↔9, la comparaison ci-dessous échouerait TOUJOURS pour un
            # tableau → on tomberait sur le remplacement global, qui FUSIONNE les cellules
            # de la ligne dans la première (bug observé). On détecte donc le tableau.
            $isTable = ($rangeText.IndexOf([char]7) -ge 0)
            # La plage figée correspond-elle TOUJOURS au texte d'origine ? (sinon le doc a
            # changé → offsets non fiables). Normalisation de COMPARAISON : marque de
            # cellule → tab, fins de ligne → CR, puis on rogne les marques de fin.
            $rtNorm = (($rangeText.Replace([char]7, [char]9) -replace "`r`n", "`r") -replace "`n", "`r").TrimEnd("`r`t")
            $orNorm = (($orig -replace "`r`n", "`r") -replace "`n", "`r").TrimEnd("`r`t")
            $applied = $false

            # Chemin SÛR (word-diff) : n'édite QUE les portions changées → mise en forme
            # variée préservée, et pour un tableau les marques de cellule sont épargnées.
            if (($rtNorm -ceq $orNorm) -and -not [string]::IsNullOrEmpty($editsJson)) {
              try {
                $edits = @($editsJson | ConvertFrom-Json)
                # END → START : éditer d'abord les positions hautes garde les offsets
                # bas valides (une édition ne décale pas les positions AVANT elle).
                foreach ($ed in @($edits | Sort-Object -Property s -Descending)) {
                  $r = $doc.Range([int]($base + [int]$ed.s), [int]($base + [int]$ed.e))
                  # Garde-fou tableau : ne JAMAIS remplacer une plage contenant une marque
                  # de cellule (7) — cela fusionnerait les cellules. On saute l'édition (le
                  # mot reste non corrigé, mais la structure du tableau est intacte).
                  if ($isTable -and (([string]$r.Text).IndexOf([char]7) -ge 0)) { continue }
                  $r.Text = (([string]$ed.t) -replace "`r`n", "`r") -replace "`n", "`r"
                }
                $applied = $true
                $method = 'word-diff'
              } catch { $applied = $false }
            }

            if (-not $applied) {
              if ($isTable) {
                # Tableau sans diff sûr possible : on NE touche PAS via COM (le
                # remplacement global aplatirait la ligne dans la 1ʳᵉ cellule). On laisse
                # $done à $false → le collage HTML (Ctrl+V, plus bas) recrée le tableau.
                $method = 'word-table-paste'
              } else {
                # Repli paragraphe normal : remplacement global (aplatit la mise en forme
                # variée), en excluant une marque de fin (CR=13, line-break=11, cellule=7,
                # saut de page=12, colonne=14) pour ne pas fusionner.
                $rng = $script:wordRange.Duplicate
                $guard = 0
                while ($rng.End -gt $rng.Start -and $guard -lt 100) {
                  $rt = $rng.Text
                  if ([string]::IsNullOrEmpty($rt)) { break }
                  $code = [int]$rt[$rt.Length - 1]
                  if ($code -eq 13 -or $code -eq 11 -or $code -eq 7 -or $code -eq 12 -or $code -eq 14) {
                    $rng.End = $rng.End - 1; $guard++
                  } else { break }
                }
                $rng.Text = ($corrected -replace "`r`n", "`r") -replace "`n", "`r"
                $applied = $true
                $method = 'word-full'
              }
            }

            DbgPS ("  word: isTable=" + $isTable + " match(rt==or)=" + ($rtNorm -ceq $orNorm) + " -> method='" + $method + "' applied=" + $applied)

            if ($applied) {
              $done = $true            # AVANT Select() : si Select échoue, pas de repli (pas de doublon)
              $cNorm = (($corrected -replace "`r`n", "`r") -replace "`n", "`r").TrimEnd("`r")
              try { $doc.Range($base, $base + $cNorm.Length).Select() | Out-Null } catch {}  # retour visuel
            }
          } catch {}
        }

        if (-not $done) {
          if ($immediate) {
            # Fenêtre jamais quittée → la sélection d'origine est encore vivante. On
            # NE re-sélectionne PAS : range.Select() désynchronise le caret dans Word,
            # et UIA ne voit même pas la sélection dans Thunderbird (moteur Gecko). On
            # colle directement par-dessus la sélection vivante = le vrai caret Ctrl+V.
            $method = 'live'
          } else {
            $method = Restore-Selection $orig
          }
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
