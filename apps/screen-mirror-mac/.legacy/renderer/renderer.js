const H264 = window.H264;

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const statusEl = document.getElementById('status');

const btnIphone = document.getElementById('btn-iphone');
const btnAndroid = document.getElementById('btn-android');
const fieldIphone = document.getElementById('field-iphone');
const fieldAndroid = document.getElementById('field-android');
const iphoneAddress = document.getElementById('iphone-address');
const androidSerial = document.getElementById('android-serial');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const androidControls = document.getElementById('android-controls');
const androidControlButtons = [...document.querySelectorAll('[data-key-code]')];
const pairingInfo = document.getElementById('pairing-info');
const iphoneMirror = new window.IPhoneMirror(document.getElementById('iphone-screen'), placeholder, setStatus);
let sourceBusy = false;

async function stopSource() {
  await iphoneMirror.stop();
  await window.api.stopSource();
  pairingInfo.textContent = '';
  resetPipeline();
}

async function runSourceAction(action) {
  if (sourceBusy) return;
  sourceBusy = true;
  [btnStart, btnStop, btnIphone, btnAndroid].forEach((button) => { button.disabled = true; });
  try { await action(); } catch (error) {
    await stopSource().catch(() => {});
    setStatus(`投屏失败：${error.message}`);
  } finally {
    sourceBusy = false;
    [btnStart, btnStop, btnIphone, btnAndroid].forEach((button) => { button.disabled = false; });
  }
}

let currentSource = 'iphone';
let videoWidth = canvas.width;
let videoHeight = canvas.height;
let activePointerId = null;
let stream = new H264.H264Stream();
let decoder = null;
let sps = null;
let pps = null;
let configurationData = null;
let codecString = null;
let avcC = null;
let configKey = '';
let ptsCounter = 0;
let needsKeyframe = true;
let annexBMode = false;
let decodedFrameCount = 0;

if (typeof VideoDecoder === 'undefined') {
  statusEl.textContent = '当前 Electron 不支持 WebCodecs，无法解码。请使用 Electron 30+。';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function resetPipeline() {
  if (decoder && decoder.state !== 'closed') {
    try { decoder.close(); } catch (e) { /* ignore */ }
  }
  decoder = null;
  stream = new H264.H264Stream();
  sps = null;
  pps = null;
  configurationData = null;
  codecString = null;
  avcC = null;
  configKey = '';
  ptsCounter = 0;
  needsKeyframe = true;
  annexBMode = false;
  decodedFrameCount = 0;
  videoWidth = canvas.width;
  videoHeight = canvas.height;
  activePointerId = null;
  placeholder.classList.remove('hidden');
}

function ensureDecoder() {
  if (!codecString) return false;
  if (decoder && decoder.state === 'configured') return true;
  if (decoder && decoder.state !== 'closed') {
    try { decoder.close(); } catch (e) { /* ignore */ }
  }

  let nextDecoder;
  nextDecoder = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      videoWidth = frame.displayWidth;
      videoHeight = frame.displayHeight;
      ctx.drawImage(frame, 0, 0);
      placeholder.classList.add('hidden');
      decodedFrameCount += 1;
      if (decodedFrameCount === 1 || decodedFrameCount % 30 === 0) {
        setStatus(`画面已解码：${decodedFrameCount} 帧（${frame.displayWidth}x${frame.displayHeight}）`);
      }
      frame.close();
    },
    error: (e) => {
      // WebCodecs enters the error state permanently. Recreate it so the
      // next IDR frame can recover after a transient stream/configuration
      // error.
      if (decoder === nextDecoder) {
        decoder = null;
        needsKeyframe = true;
      }
      console.error('[decoder]', e);
      setStatus(`解码失败：${e.message || e}`);
    },
  });
  decoder = nextDecoder;
  try {
    decoder.configure(annexBMode
      ? { codec: codecString, optimizeForLatency: true }
      : { codec: codecString, description: avcC });
  } catch (error) {
    decoder = null;
    console.error('[decoder configure]', error);
    setStatus(`解码器配置失败：${error.message || error}`);
    return false;
  }
  needsKeyframe = true;
  return true;
}

function maybeConfigure() {
  if (!sps || !pps) return;
  const newCodec = H264.getCodecString(sps);
  const newAvcC = H264.buildAvcCDescription(sps, pps);
  const key = `${newCodec}|${btoa(String.fromCharCode(...sps))}|${btoa(String.fromCharCode(...pps))}`;
  if (key === configKey && decoder && decoder.state === 'configured') return;
  configKey = key;
  codecString = newCodec;
  avcC = newAvcC;

  if (!ensureDecoder()) return;
  needsKeyframe = true;
  setStatus(`解码器就绪 ${codecString}`);
}

function configureFromScrcpy(data) {
  const { sequenceParameterSet, pictureParameterSet } = H264.findParameterSets(data);
  sps = sequenceParameterSet;
  pps = pictureParameterSet;
  configurationData = data;
  annexBMode = true;
  maybeConfigure();
}

function decodeAccessUnit(data, timestamp) {
  // Trust the bitstream as the source of truth. A stale/missing scrcpy
  // metadata flag must never turn a delta frame into the first frame after
  // configure(), otherwise Chromium throws "A key frame is required".
  const containsIdr = H264.hasKeyframe(data);
  const isKeyframe = containsIdr;
  if (needsKeyframe && !isKeyframe) return;
  if (!ensureDecoder()) return;
  try {
    const accessUnit = isKeyframe && configurationData
      ? H264.concatAccessUnits(configurationData, data)
      : data;
    const encodedData = annexBMode
      ? accessUnit
      : H264.removeParameterSets(accessUnit);
    if (encodedData.length === 0) return;
    decoder.decode(
      new EncodedVideoChunk({
        type: isKeyframe ? 'key' : 'delta',
        timestamp,
        data: encodedData,
      })
    );
    if (isKeyframe) needsKeyframe = false;
  } catch (e) {
    needsKeyframe = true;
    console.error('[decode]', e);
  }
}

function feedScrcpyPacket(packet) {
  if (!packet) return;
  if (packet.type === 'session') {
    videoWidth = packet.width || videoWidth;
    videoHeight = packet.height || videoHeight;
    return;
  }
  if (packet.type === 'configuration') {
    try {
      configureFromScrcpy(new Uint8Array(packet.data));
    } catch (e) {
      console.error('[scrcpy configuration]', e);
    }
    return;
  }
  if (packet.type !== 'data') return;
  const timestamp = packet.pts === undefined ? ptsCounter++ * 1000 : Number(packet.pts);
  decodeAccessUnit(new Uint8Array(packet.data), timestamp);
}

function feed(bytes) {
  const nalus = stream.feed(bytes);
  for (const { type, payload } of nalus) {
    if (type === 7) {
      annexBMode = false;
      sps = payload;
      maybeConfigure();
    } else if (type === 8) {
      annexBMode = false;
      pps = payload;
      maybeConfigure();
    } else if (type === 1 || type === 5) {
      if (type !== 5 && needsKeyframe) continue;
      if (!ensureDecoder()) continue;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: type === 5 ? 'key' : 'delta',
            timestamp: ptsCounter++ * 1000,
            data: H264.toLengthPrefixed(payload),
          })
        );
        if (type === 5) needsKeyframe = false;
      } catch (e) {
        needsKeyframe = true;
        console.error('[decode]', e);
      }
    }
  }
}


// ---- UI ----

const ANDROID_KEY_CODES = {
  Backspace: 67,
  Tab: 61,
  Enter: 66,
  Escape: 4,
  Home: 3,
  ArrowLeft: 21,
  ArrowRight: 22,
  ArrowUp: 19,
  ArrowDown: 20,
  PageUp: 92,
  PageDown: 93,
  Delete: 112,
  ' ': 62,
};

function isAndroidSource() {
  return currentSource === 'android';
}

function sendAndroidControl(command) {
  if (!isAndroidSource() || !window.api.sendAndroidControl) return;
  window.api.sendAndroidControl(command).catch((error) => {
    console.error('[android control]', error);
  });
}

function getVideoPoint(event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    pointerX: Math.max(
      0,
      Math.min(videoWidth, Math.round((event.clientX - rect.left) / rect.width * videoWidth)),
    ),
    pointerY: Math.max(
      0,
      Math.min(videoHeight, Math.round((event.clientY - rect.top) / rect.height * videoHeight)),
    ),
  };
}

function sendTouch(action, event, buttons) {
  const point = getVideoPoint(event);
  if (!point) return;
  sendAndroidControl({
    type: 'touch',
    action,
    ...point,
    videoWidth,
    videoHeight,
    pressure: action === 1 || action === 3 ? 0 : 1,
    buttons,
  });
}

function sendKey(keyCode, action, repeat = 0) {
  sendAndroidControl({
    type: 'key',
    action,
    keyCode,
    repeat,
    metaState: 0,
  });
}

function isFormElement(target) {
  const tagName = target?.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON';
}

canvas.addEventListener('pointerdown', (event) => {
  if (!isAndroidSource() || event.button !== 0) return;
  event.preventDefault();
  canvas.focus();
  activePointerId = event.pointerId;
  try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
  sendTouch(0, event, 1);
});

canvas.addEventListener('pointermove', (event) => {
  if (!isAndroidSource() || activePointerId !== event.pointerId) return;
  event.preventDefault();
  sendTouch(2, event, 1);
});

function finishPointer(event, action) {
  if (!isAndroidSource() || activePointerId !== event.pointerId) return;
  event.preventDefault();
  sendTouch(action, event, 0);
  try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
  activePointerId = null;
}

canvas.addEventListener('pointerup', (event) => finishPointer(event, 1));
canvas.addEventListener('pointercancel', (event) => finishPointer(event, 3));
canvas.addEventListener('contextmenu', (event) => {
  if (isAndroidSource()) event.preventDefault();
});

canvas.addEventListener('wheel', (event) => {
  if (!isAndroidSource()) return;
  const point = getVideoPoint(event);
  if (!point) return;
  event.preventDefault();
  sendAndroidControl({
    type: 'scroll',
    ...point,
    videoWidth,
    videoHeight,
    scrollX: Math.max(-1, Math.min(1, -event.deltaX / 100)),
    scrollY: Math.max(-1, Math.min(1, -event.deltaY / 100)),
  });
}, { passive: false });

window.addEventListener('keydown', (event) => {
  if (!isAndroidSource() || isFormElement(event.target) || event.isComposing) return;
  const keyCode = ANDROID_KEY_CODES[event.key];
  if (keyCode !== undefined) {
    event.preventDefault();
    sendKey(keyCode, 0, event.repeat ? 1 : 0);
    return;
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    sendAndroidControl({ type: 'text', text: event.key });
  }
});

window.addEventListener('keyup', (event) => {
  if (!isAndroidSource() || isFormElement(event.target) || event.isComposing) return;
  const keyCode = ANDROID_KEY_CODES[event.key];
  if (keyCode !== undefined) {
    event.preventDefault();
    sendKey(keyCode, 1);
  }
});

function selectSource(source) {
  currentSource = source;
  canvas.hidden = source === 'iphone';
  btnIphone.classList.toggle('active', source === 'iphone');
  btnAndroid.classList.toggle('active', source === 'android');
  fieldIphone.classList.toggle('hidden', source !== 'iphone');
  fieldAndroid.classList.toggle('hidden', source !== 'android');
  androidControls.classList.toggle('hidden', source !== 'android');
}

btnIphone.addEventListener('click', () => runSourceAction(async () => { await stopSource(); selectSource('iphone'); }));
btnAndroid.addEventListener('click', () => runSourceAction(async () => { await stopSource(); selectSource('android'); }));

androidControlButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const keyCode = Number(button.dataset.keyCode);
    if (Number.isFinite(keyCode)) {
      sendKey(keyCode, 0);
      sendKey(keyCode, 1);
    }
  });
});

btnStart.addEventListener('click', () => runSourceAction(async () => {
  await stopSource();
  const opts =
    currentSource === 'iphone'
      ? { source: 'iphone', iphoneAddress: iphoneAddress.value.trim() }
      : { source: 'android', androidSerial: androidSerial.value.trim() };
  setStatus('启动中…');
  const session = await window.api.startSource(opts);
  if (currentSource === 'iphone') {
    pairingInfo.textContent = `iPhone 填写：${session.pairingAddress}\n配对码：${session.pairingCode}`;
    placeholder.textContent = '等待 iPhone 共享屏幕…';
    await iphoneMirror.start(session);
  }
  if (currentSource === 'android') {
    placeholder.textContent = '等待 scrcpy 画面…';
  }
}));

btnStop.addEventListener('click', () => runSourceAction(async () => {
  await stopSource();
  placeholder.textContent = '未连接';
  setStatus('已停止');
}));

window.api.onStatus(setStatus);
window.api.onH264(feed);
window.api.onVideoPacket(feedScrcpyPacket);

window.api.getLocalIp().then((addresses) => {
  addresses.sort((first, second) => Number(second.name.startsWith('en')) - Number(first.name.startsWith('en')));
  addresses.forEach(({ name, address }) => {
    const option = document.createElement('option');
    option.value = address;
    option.textContent = `${name} — ${address}`;
    iphoneAddress.appendChild(option);
  });
  if (!addresses.length) setStatus('没有可用局域网地址，请连接 Wi-Fi 后重启应用');
}).catch((error) => setStatus(error.message));

selectSource('iphone');
