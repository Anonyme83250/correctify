const { contextBridge, ipcRenderer } = require("electron");

// Expose une API minimale et sûre à la fenêtre d'options (pas d'accès direct à Node).
contextBridge.exposeInMainWorld("correctify", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  getI18n: () => ipcRenderer.invoke("get-i18n"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  closeWindow: () => ipcRenderer.invoke("close-settings"),
  resizeToContent: (height) => ipcRenderer.invoke("resize-to-content", height),
  cancelCorrection: () => ipcRenderer.invoke("cancel-correction"),
  pauseHotkey: () => ipcRenderer.invoke("pause-hotkey"),
  resumeHotkey: () => ipcRenderer.invoke("resume-hotkey")
});
