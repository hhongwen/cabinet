// preload.cjs —— 只暴露有限系统能力，不暴露 Node 或 ipcRenderer
//
// D0 先只给版本与平台；目录选择、通知等能力按 §7.3 的白名单逐项新增，
// 每个方法都要在 Main 侧校验参数与调用来源。

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('cabinet', {
  platform: process.platform,
  desktop: true
});
