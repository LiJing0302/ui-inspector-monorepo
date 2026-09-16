# react-native-ui-acceptance

React Native native view-tree inspection for development and UI acceptance workflows.

The package captures the mounted Android `View` tree or iOS `UIView` tree and returns a
platform-neutral snapshot. It also includes optional React Native components for displaying
node bounds and measuring the distance between two selected nodes.

## Installation

```bash
npm install react-native-ui-acceptance
cd ios && pod install
```

The package supports React Native `0.81.x` and requires a native rebuild after installation.

## API

```tsx
import {
  UiAcceptanceFloatingButton,
  UiAcceptanceModule,
} from 'react-native-ui-acceptance';

const snapshot = await UiAcceptanceModule.capture();

// Development-only opt-in UI.
<UiAcceptanceFloatingButton onSnapshot={console.log} />;
```


`includeText` is disabled by default. Enable it only for local debugging because captured
text may contain user input. Node identifiers are temporary and must not be persisted.

The package only inspects the current native window. It does not include screen mirroring,
LiveKit, ReplayKit, or any transport implementation — except the opt-in upload described below,
which talks to the Mac UI-acceptance receiver over the LAN.

## React Native source inspector (development only)

The source inspector is an Android development feature. Add the Babel plugin to the app's
development Babel configuration; it writes a source manifest and stores the marker in React's
`__source` element metadata, so the marker is not forwarded as a native View prop:

```js
// babel.config.js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  env: {
    development: {
      plugins: [
        ['react-native-ui-acceptance/babel-plugin', {
          projectRoot: __dirname,
          // Optional; defaults to an FNV-1a hash of projectRoot.
          projectRootHash: process.env.UI_INSPECTOR_PROJECT_ROOT_HASH,
        }],
      ],
    },
  },
};
```

Start the runtime after the React root is mounted:

```tsx
import { useEffect } from 'react';
import { UiInspector } from 'react-native-ui-acceptance';

const inspector = new UiInspector();
export function InspectorBootstrap() {
  useEffect(() => {
    void inspector.start({ host: '127.0.0.1', port: 23459 });
    return () => { void inspector.stop(); };
  }, []);
  return null;
}
```

The Mac app establishes `adb reverse tcp:23459 tcp:23459` while Android scrcpy is running.
For an authenticated local session, set the same `UI_INSPECTOR_TOKEN` in the Mac process, pass it
as `token` to `inspector.start`, and configure `uiInspector.token` in VS Code. With no token, the
default transport is intentionally limited to localhost/ADB reverse.
The first mounted Fiber instance is used to infer the project hash when the app does not provide
one explicitly. Source maps remain useful for validating file/line locations, but do not identify
runtime View instances. A source position with no mounted Fiber is reported as `not-mounted`;
conditional branches and virtualized list rows therefore cannot reuse stale native tags.

## Upload to the Mac receiver (Android only)

The Mac app ("UI 验收投屏") runs an always-on receiver. You pair the phone **once** by pasting the
connection string shown on the Mac acceptance page, e.g.
`smacceptance://192.168.1.5:23458?token=<hex>`.

```tsx
import {
  UiAcceptanceFloatingButton,
  UiAcceptanceModule,
  parseAcceptanceConnectionString,
} from 'react-native-ui-acceptance';

const receiver = parseAcceptanceConnectionString(storedString);
const { armed } = await UiAcceptanceModule.ping(receiver);

// Node tree + screenshot, captured from the same frame, in one request.
const result = await UiAcceptanceModule.uploadBundle(receiver);
// { accepted, captureId, nodeCount, screenshotBytes, serverTimestamp }

<UiAcceptanceFloatingButton receiver={receiver} onUploaded={console.log} onError={console.error} />;
```

Why the screenshot travels in the same request as the node tree: they must describe the same
frame. Fetching them over separate channels (which is what the old `adb screencap` path did)
produces "the nodes are from this screen, the image is from the next one" — that reads as
*the developer placed things wrong*, which is far harder to diagnose than a plain error.

Two things the caller must know:

1. **Hide your own floating UI before capturing.** The component does this for itself
   (`opacity: 0` for two frames). If your app renders its own debug overlay, do the same, or it
   will show up in the acceptance screenshot as an element the design does not have.
2. **The receiver must be armed.** Uploading with nothing waiting is rejected with `409`; the
   message tells the user to press "开始接收" on the Mac first.

`uploadBundle` always captures the `acceptance-full` profile. A lighter profile omits hidden
nodes and text, which downstream reads as "the app is missing this element" — a false negative
that is more dangerous than a missing report, so it is rejected locally before any bytes are sent.

## Recording (Android only)

`startRecording` captures a full snapshot at a fixed frame rate and streams the frames to a
JSONL file in the app's files directory. Frames never cross the React bridge.

```tsx
await UiAcceptanceModule.startRecording({ fps: 10, maxFrames: 300 });
const result = await UiAcceptanceModule.stopRecording();
// { path, frameCount, byteSize, durationMs, avgCaptureMs, maxCaptureMs }
```

Every frame is currently a full snapshot, which is deliberately wasteful. `avgCaptureMs` and
`maxCaptureMs` measure the tree walk only and are the numbers that decide whether a higher
frame rate or an incremental recorder makes sense for a given screen.

Each recording is one JSON object per line:

```jsonl
{"type":4,"data":{"format":"ui-acceptance-jsonl-v1","platform":"android","source":"android-view-tree","startElapsedNanos":...,"startWallClockMs":...,"targetFps":10,"density":3,"refreshRateHz":60,"windowWidth":1080,"windowHeight":2400}}
{"type":2,"frame":0,"elapsedNanos":16,"wallClockMs":...,"captureMs":0.06,"data":{"nodeCount":312,"windowWidth":1080,"windowHeight":2400,"nodes":[...]}}
```

`type` uses the rrweb event enumeration so the stream can later be fed to an rrweb-compatible
player: `4` is `Meta`, `2` is `FullSnapshot`.

**Size warning.** At 10 fps a screen with roughly 500 nodes produces about 90 MB per minute.
Keep recordings short, or use `maxFrames` to stop automatically.
