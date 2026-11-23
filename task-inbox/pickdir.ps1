# pickdir.ps1 —— 弹出系统原生的「选择文件夹」对话框
#
# 用法：powershell -NoProfile -STA -File pickdir.ps1 [-Initial "D:\xxx"]
# 输出：选中的路径（stdout）；取消则输出空行
#
# 为什么要 -STA：WinForms 和 Shell COM 都要求单线程单元。
# 为什么要一个隐藏的 TopMost 窗体：Alma 在后台时，对话框会弹到别的窗口后面，
# 用户会以为没反应。挂一个透明的置顶窗体当 owner 能把它顶到最前。

param(
  [string]$Initial = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$owner = New-Object System.Windows.Forms.Form
$owner.Text = "选择目录"
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = 'CenterScreen'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$owner.Activate()

try {
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "选择项目目录"
  $dlg.ShowNewFolderButton = $true
  $dlg.RootFolder = 'MyComputer'

  if ($Initial -and (Test-Path -LiteralPath $Initial -PathType Container)) {
    $dlg.SelectedPath = $Initial
  }

  $result = $dlg.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {
    [Console]::Out.Write($dlg.SelectedPath)
  }
}
catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
finally {
  $owner.Close()
  $owner.Dispose()
}

exit 0
