// preload.cjs —— 只暴露有限系统能力，不暴露 Node 或 ipcRenderer
//
// D0 只给平台、桌面标识与访问凭据；目录选择、通知等能力按 §7.3 的白名单
// 逐项新增，每个方法都要在 Main 侧校验参数与调用来源。
// 凭据经 sendSync 一次性读取，不写入 localStorage、URL 或日志。

const { contextBridge, ipcRenderer } = require('electron');

let authToken = '';
try { authToken = ipcRenderer.sendSync('cabinet:token') || ''; } catch { /* 主进程没起 */ }

contextBridge.exposeInMainWorld('cabinet', {
  platform: process.platform,
  desktop: true,
  authToken
});
