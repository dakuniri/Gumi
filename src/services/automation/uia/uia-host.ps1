# Gumi UI Automation host
# Node.js (Main Process) から JSON Lines で要求を受け取り、Windows UI Automation の結果を返す。
# 標準入力: {"id":1,"cmd":"list","hwnd":123,...}
# 標準出力: {"id":1,"ok":true,"result":{...}}
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GumiUiaNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@

# Per-Monitor DPI Aware V2 にして物理ピクセル座標を得る
$script:dpiAware = $false
try { $script:dpiAware = [GumiUiaNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $script:dpiAware = $false }

$AE = [System.Windows.Automation.AutomationElement]
$script:cache = New-Object 'System.Collections.Generic.Dictionary[int,System.Windows.Automation.AutomationElement]'
$script:nextId = 1

$script:cr = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @(
    $AE::NameProperty, $AE::ControlTypeProperty, $AE::AutomationIdProperty, $AE::ClassNameProperty,
    $AE::BoundingRectangleProperty, $AE::IsEnabledProperty, $AE::IsOffscreenProperty,
    $AE::HasKeyboardFocusProperty, $AE::IsPasswordProperty, $AE::ProcessIdProperty,
    $AE::IsInvokePatternAvailableProperty, $AE::IsValuePatternAvailableProperty,
    $AE::IsTogglePatternAvailableProperty, $AE::IsSelectionItemPatternAvailableProperty,
    $AE::IsExpandCollapsePatternAvailableProperty, $AE::IsScrollPatternAvailableProperty)) {
  $script:cr.Add($p)
}
$script:cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
$script:cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full

$script:interactiveTypes = @('Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem',
  'RadioButton', 'TabItem', 'TreeItem', 'Slider', 'Spinner', 'SplitButton', 'DataItem', 'MenuBar', 'Document', 'ScrollBar')

function Register-Element($el) {
  if ($script:cache.Count -gt 6000) { $script:cache.Clear() }
  $id = $script:nextId
  $script:nextId++
  $script:cache[$id] = $el
  return $id
}

function Get-Element([int]$id) {
  $el = $null
  if (-not $script:cache.TryGetValue($id, [ref]$el)) {
    throw "要素ID $id は無効です。get_ui_elements で再取得してください。"
  }
  return $el
}

function Get-Prop($el, $prop) {
  try { return $el.GetCachedPropertyValue($prop) } catch { return $el.GetCurrentPropertyValue($prop) }
}

function Describe($el, [bool]$interactiveOnly) {
  $rect = Get-Prop $el $AE::BoundingRectangleProperty
  if ($null -eq $rect -or $rect.IsEmpty -or [double]::IsInfinity($rect.X) -or $rect.Width -le 0 -or $rect.Height -le 0) { return $null }
  if (Get-Prop $el $AE::IsOffscreenProperty) { return $null }
  $ct = Get-Prop $el $AE::ControlTypeProperty
  $type = if ($ct) { $ct.ProgrammaticName -replace '^ControlType\.', '' } else { 'Unknown' }
  $name = [string](Get-Prop $el $AE::NameProperty)
  if ($name.Length -gt 120) { $name = $name.Substring(0, 120) + '…' }
  $patterns = New-Object System.Collections.ArrayList
  if (Get-Prop $el $AE::IsInvokePatternAvailableProperty) { [void]$patterns.Add('invoke') }
  if (Get-Prop $el $AE::IsValuePatternAvailableProperty) { [void]$patterns.Add('value') }
  if (Get-Prop $el $AE::IsTogglePatternAvailableProperty) { [void]$patterns.Add('toggle') }
  if (Get-Prop $el $AE::IsSelectionItemPatternAvailableProperty) { [void]$patterns.Add('select') }
  if (Get-Prop $el $AE::IsExpandCollapsePatternAvailableProperty) { [void]$patterns.Add('expand') }
  if (Get-Prop $el $AE::IsScrollPatternAvailableProperty) { [void]$patterns.Add('scroll') }
  $interactive = ($patterns.Count -gt 0) -or ($script:interactiveTypes -contains $type)
  if ($interactiveOnly -and -not $interactive -and ($name.Length -eq 0 -or $type -ne 'Text')) { return $null }
  $info = [ordered]@{
    id           = (Register-Element $el)
    name         = $name
    type         = $type
    automationId = [string](Get-Prop $el $AE::AutomationIdProperty)
    className    = [string](Get-Prop $el $AE::ClassNameProperty)
    rect         = [ordered]@{ x = [int][math]::Round($rect.X); y = [int][math]::Round($rect.Y); width = [int][math]::Round($rect.Width); height = [int][math]::Round($rect.Height) }
    enabled      = [bool](Get-Prop $el $AE::IsEnabledProperty)
    focused      = [bool](Get-Prop $el $AE::HasKeyboardFocusProperty)
    patterns     = $patterns
  }
  if ($patterns -contains 'value') {
    if (Get-Prop $el $AE::IsPasswordProperty) {
      $info.value = '[パスワード欄のため非表示]'
      $info.password = $true
    } elseif ($type -eq 'Edit' -or $type -eq 'ComboBox') {
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $v = [string]$vp.Current.Value
        if ($v.Length -gt 200) { $v = $v.Substring(0, 200) + '…' }
        $info.value = $v
      } catch {}
    }
  }
  if ($patterns -contains 'toggle') {
    try {
      $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $info.toggleState = [string]$tp.Current.ToggleState
    } catch {}
  }
  return $info
}

function Get-Root($req) {
  if ($req.hwnd -and [long]$req.hwnd -ne 0) {
    return $AE::FromHandle([IntPtr]::new([long]$req.hwnd))
  }
  $fg = [GumiUiaNative]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { throw 'アクティブなウィンドウがありません' }
  return $AE::FromHandle($fg)
}

function Cmd-List($req) {
  $root = Get-Root $req
  $root = $root.GetUpdatedCache($script:cr)
  $maxCount = if ($req.maxCount) { [int]$req.maxCount } else { 150 }
  $maxDepth = if ($req.maxDepth) { [int]$req.maxDepth } else { 25 }
  $budget = if ($req.budgetMs) { [int]$req.budgetMs } else { 4000 }
  $interactiveOnly = [bool]$req.interactiveOnly
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue(@($root, 0))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $results = New-Object System.Collections.ArrayList
  $truncated = $false
  while ($queue.Count -gt 0) {
    if ($results.Count -ge $maxCount -or $sw.ElapsedMilliseconds -ge $budget) { $truncated = $true; break }
    $item = $queue.Dequeue()
    $el = $item[0]
    $depth = [int]$item[1]
    try {
      $info = Describe $el $interactiveOnly
      if ($null -ne $info) { [void]$results.Add($info) }
      if ($depth -lt $maxDepth) {
        $child = $walker.GetFirstChild($el, $script:cr)
        while ($null -ne $child) {
          $queue.Enqueue(@($child, ($depth + 1)))
          $child = $walker.GetNextSibling($child, $script:cr)
        }
      }
    } catch {
      # 列挙中に消えた要素などは無視
    }
  }
  return [ordered]@{
    window    = [string](Get-Prop $root $AE::NameProperty)
    elements  = $results
    truncated = $truncated
    elapsedMs = $sw.ElapsedMilliseconds
  }
}

function Cmd-At($req) {
  $pt = New-Object System.Windows.Point([double]$req.x, [double]$req.y)
  $el = $AE::FromPoint($pt)
  if ($null -eq $el) { return $null }
  $el = $el.GetUpdatedCache($script:cr)
  return (Describe $el $false)
}

function Cmd-Focused($req) {
  $el = $AE::FocusedElement
  if ($null -eq $el) { return $null }
  $el = $el.GetUpdatedCache($script:cr)
  return (Describe $el $false)
}

function Cmd-Invoke($req) {
  $el = Get-Element ([int]$req.elementId)
  $o = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke(); return 'invoke' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { $o.Toggle(); return 'toggle' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { $o.Select(); return 'select' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) {
    if ($o.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $o.Collapse() } else { $o.Expand() }
    return 'expandcollapse'
  }
  throw 'NO_PATTERN'
}

function Cmd-SetValue($req) {
  $el = Get-Element ([int]$req.elementId)
  $o = $null
  if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { throw 'この要素は値の設定 (ValuePattern) に対応していません' }
  if ($o.Current.IsReadOnly) { throw 'この要素は読み取り専用です' }
  $o.SetValue([string]$req.value)
  return 'ok'
}

function Cmd-Focus($req) {
  $el = Get-Element ([int]$req.elementId)
  $el.SetFocus()
  return 'ok'
}

function Cmd-Rect($req) {
  $el = Get-Element ([int]$req.elementId)
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { throw '要素は現在画面上に表示されていません' }
  return [ordered]@{ x = [int][math]::Round($r.X); y = [int][math]::Round($r.Y); width = [int][math]::Round($r.Width); height = [int][math]::Round($r.Height) }
}

function Cmd-StartApps($req) {
  $list = New-Object System.Collections.ArrayList
  try {
    foreach ($a in (Get-StartApps)) { [void]$list.Add([ordered]@{ name = [string]$a.Name; appId = [string]$a.AppID }) }
  } catch {}
  return $list
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $result = switch ([string]$req.cmd) {
      'ping' { [ordered]@{ pong = $true; dpiAware = $script:dpiAware; psVersion = $PSVersionTable.PSVersion.ToString() } }
      'list' { Cmd-List $req }
      'at' { Cmd-At $req }
      'focused' { Cmd-Focused $req }
      'invoke' { Cmd-Invoke $req }
      'setValue' { Cmd-SetValue $req }
      'focus' { Cmd-Focus $req }
      'rect' { Cmd-Rect $req }
      'startApps' { , (Cmd-StartApps $req) }
      default { throw "unknown command: $($req.cmd)" }
    }
    $resp = [ordered]@{ id = $req.id; ok = $true; result = $result }
  } catch {
    $rid = $null
    if ($null -ne $req) { $rid = $req.id }
    $resp = [ordered]@{ id = $rid; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $resp -Depth 8 -Compress))
  [Console]::Out.Flush()
}
