# 图形化目录选择:输出选中的目录路径(UTF-8),取消则无输出
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$top = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Width = 1; Height = 1 }
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择岗位数据导出目录'
$dlg.ShowNewFolderButton = $true
$r = $dlg.ShowDialog($top)
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }
$top.Dispose()
