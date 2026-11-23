# stop-service.ps1 —— 停掉正在跑的 task-inbox 服务
#
# 为什么要有这个：改完代码不重启，46001 上跑的还是旧进程，
# 表现是「明明改了却没生效」，而且没有任何提示。install 每次装完顺手停一下。
#
# 只杀命令行里带 task-inbox 的 node 进程。别的 node（codex、mcp-proxy、
# 各种 dev server）一律不碰 —— 按进程名一把梭是会把别人工作弄丢的。

$ErrorActionPreference = 'SilentlyContinue'

$stopped = 0
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"

foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    if (-not $cmd) { continue }
    if ($cmd -notmatch 'task-inbox') { continue }

    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        Write-Host ("[OK] stopped pid " + $p.ProcessId)
        $stopped++
    } catch {
        Write-Host ("[!] cannot stop pid " + $p.ProcessId + ": " + $_.Exception.Message)
    }
}

if ($stopped -eq 0) {
    Write-Host "[OK] nothing running"
}

# 给端口一点时间释放，后面的 ping 才不会撞到还没死的旧进程
Start-Sleep -Milliseconds 700
