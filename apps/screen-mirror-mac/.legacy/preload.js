const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startSource: (opts) => ipcRenderer.invoke('start-source', opts),
  stopSource: () => ipcRenderer.invoke('stop-source'),
  sendAndroidControl: (command) => ipcRenderer.invoke('android-control', command),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  openVerify: () => ipcRenderer.invoke('open-verify'),
  onStatus: (cb) => {
    const listener = (_e, text) => cb(text);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
  onH264: (cb) => {
    // main.js 用 webContents.send('h264', Buffer) 发送，这里收到的是 Uint8Array，直接透传（零拷贝）
    const listener = (e, buffer) => cb(buffer);
    ipcRenderer.on('h264', listener);
    return () => ipcRenderer.removeListener('h264', listener);
  },
  onVideoPacket: (cb) => {
    const listener = (_e, packet) => cb(packet);
    ipcRenderer.on('video-packet', listener);
    return () => ipcRenderer.removeListener('video-packet', listener);
  },
});
