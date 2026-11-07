# 图形化目录选择:输出选中的目录路径(UTF-8),取消则无输出
# 修复:宿主窗体必须 Show() 且带任务栏入口,否则选择框开在所有窗口后面,用户看不到
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$chosen = ''
try {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $top = New-Object System.Windows.Forms.Form
  $top.Text = '海投助手-选择导出目录'
  $top.Width = 340; $top.Height = 100
  $top.StartPosition = 'CenterScreen'
  $top.TopMost = $true
  $top.ShowInTaskbar = $true
  $top.FormBorderStyle = 'FixedToolWindow'
  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = "请在弹出的对话框中选择目录…`r`n(选完此窗口自动关闭)"
  $lbl.Dock = 'Fill'
  $lbl.TextAlign = 'MiddleCenter'
  $top.Controls.Add($lbl)
  $top.Show()
  $top.Activate()

  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = '选择岗位数据导出目录'
  $dlg.ShowNewFolderButton = $true
  $r = $dlg.ShowDialog($top)
  if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $chosen = $dlg.SelectedPath }
  $top.Close()
  $top.Dispose()
} catch {
  [Console]::Error.WriteLine('FORMS_FAIL: ' + $_.Exception.Message)
}

# 兜底:经典 Shell 浏览对话框(同样原生,不同实现)
if (-not $chosen) {
  try {
    $shell = New-Object -ComObject Shell.Application
    $f = $shell.BrowseForFolder(0, '选择岗位数据导出目录', 0x41)
    if ($f -and $f.Self) { $chosen = $f.Self.Path }
  } catch {
    [Console]::Error.WriteLine('COM_FAIL: ' + $_.Exception.Message)
  }
}
if ($chosen) { Write-Output $chosen }
