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

Manual design acceptance uses the platform convention: design value × native page logical width ÷
Figma frame width. The SDK supplies measurements and device environment; `configureAcceptance(...)`
is optional diagnostic metadata and does not determine manual acceptance targets. Old captures without
sizing rules remain usable. See [manual acceptance integration](../../docs/MANUAL-UI-ACCEPTANCE-IMPLEMENTATION.md).

```tsx
import { UiAcceptanceModule } from 'react-native-ui-acceptance';

// Native view tree of the current window.
const snapshot = await UiAcceptanceModule.capture();
```

### ⚠️ Two coordinate spaces — know which one you are holding

`nodes` geometry and `windowWidth` / `windowHeight` are always in the **same** space, but which
space depends on the call (2026-09-24):

| Call | Geometry unit | Use it for |
|---|---|---|
| `capture()` | **logical** — dp on Android, pt on iOS | the overlay path; distance read-outs are design-spec numbers |
| `captureBundle()` | **physical pixels** | the upload path; macOS converts with `160 / densityDpi` |

The upload path must be in pixels because the Mac side has exactly one conversion,
`logical = value × 160 / densityDpi`, and iOS reports `density = screen.scale`
(→ `densityDpi = scale × 160`). Handing it pt would divide by the screen scale a second time —
the design would come out 3× small, on **every** page. `capture()` stays in logical units because
`UiAcceptanceBoundsOverlay` reads out `pt` on iOS and `px` on Android, and those numbers are meant
to match the design file.

### What this package ships — and what it deliberately does not

Two things are public API here:

1. **Capabilities** — `UiAcceptanceModule` (capture / upload / record) plus the pure helpers around
   it: `parseAcceptanceTarget`, `discoverUsbAcceptanceReceiver`, `createAcceptanceCaptureId`,
   `buildAcceptanceConnectionString`, `DEFAULT_ACCEPTANCE_RECEIVER_PORT`.
2. **Acceptance overlay drawing** — `UiAcceptanceBoundsOverlay` together with
   `useUiAcceptanceSelection` and the geometry helpers in `geometry`.

**Product UI is not part of it.** A toolbar (which buttons, what colour, which corner, how it shares
the screen with your own debug entries) and a "no cable found" dialog are the app's decisions, so
they live in the app. Earlier versions exported `UiAcceptanceFloatingButton` and
`UiAcceptanceLanDialog`; both moved out on 2026-09-24 (in MallApp they live in
`src/components/uiAcceptance/`). The upside beyond ownership: a UI component inside a published
package turns every styling tweak into "repack → bump the dependency → reinstall", while it needs no
native support at all.


`includeText` is disabled by default. Enable it only for local debugging because captured
text may contain user input. Node identifiers are temporary and must not be persisted.

The package only inspects the current native window. It does not include screen mirroring,
LiveKit, or ReplayKit. Upload is opt-in, on both Android and iOS — over the LAN on either
platform, plus the zero-config USB path on Android only (see the matrix below).

## React Native source inspector (development only)

The source inspector is an Android development feature. Add the Babel plugin to the app's
development Babel configuration. It adds compact source metadata as `nativeID` to host components
imported from `react-native`. Existing explicit `nativeID` values are preserved:

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
The Inspector does not install a React DevTools hook and does not poll the Fiber tree. Android reads
the source marker directly from mounted Views only when the Mac sends a pick or highlight request.
A source position with no mounted native View is reported as `not-mounted`; conditional branches
and virtualized list rows therefore cannot reuse stale view ids. Components that do not render a
native host view have no standalone source node.

## Upload to the Mac receiver

Platform support at a glance:

| | Android | iOS |
|---|---|---|
| Node tree + screenshot in one call (`captureBundle`) | ✅ | ✅ |
| Upload over the LAN (`uploadBundle`) | ✅ | ✅ |
| Zero-config USB (`uploadBundleViaUsb`) | ✅ via `adb reverse` | ❌ — see below |

**Why iOS has no USB path.** The Android path works because `adb reverse tcp:23458 tcp:23458` maps
*the device's* localhost onto the Mac's receiver — direction **device → Mac**. The iOS counterpart
(libimobiledevice's `iproxy`) can only bind the other way: it listens on the Mac and forwards into
the device, i.e. the `adb forward` direction. The usbmuxd protocol has no "device dials a Mac port
over USB" channel, so on iOS the zero-config option is the LAN (same Wi-Fi, or the phone's hotspot
with the Mac joined to it). `uploadBundleViaUsb()` and `discoverUsbAcceptanceReceiver()` therefore
reject immediately on iOS with `IOS_USB_UPLOAD_UNSUPPORTED` (exported, so a toolbar can branch on
it without catching an error); nothing is probed, so the user is not made to wait 4 s for a tunnel
that cannot exist.

The Mac app ("UI 验收投屏") runs an always-on receiver. For the recommended USB workflow, connect an
Android device with a data cable and allow USB debugging — that is the whole setup. The Mac keeps the
`adb reverse` tunnel alive by itself while the verify page has a requirement open, so the App can
upload directly from localhost without pasting a `smacceptance://` connection string and without
anyone pressing a button on the Mac.

```tsx
import { UiAcceptanceModule } from 'react-native-ui-acceptance';

// Development-only: the Mac keeps adb reverse alive while a requirement is open.
await UiAcceptanceModule.uploadBundleViaUsb();
```

The SDK calls `http://127.0.0.1:23458` on the device. The Mac maps that port to its local receiver
with `adb reverse` and automatically supplies the receiver token through a loopback-only endpoint.
The tunnel is **not** torn down after an upload: keeping it up is what makes the next upload work
without anyone touching the Mac.

`uploadBundleViaUsb` is `discoverUsbAcceptanceReceiver()` followed by `uploadBundle()`, and it
**rejects when nothing answers** — the normal outcome when no cable is attached or USB debugging is
not allowed. What to do about that is your UI's decision, not an error message: the reference
toolbar in MallApp probes the cable first (~1.2 s timeout, so "no cable" is detected quickly), then
falls back to a stored LAN address if the host has one, and only opens a dialog when there is
neither. That dialog's top half says plugging the cable in remains the zero-setup option (with a
「插好线了」 shortcut that re-probes the cable without closing the dialog); its bottom half takes the
Mac's LAN address and uploads over the LAN as soon as it is submitted. The address that worked is
handed back through `onReceiverResolved` so the host can persist it — after that the dialog stops
appearing until the address stops working.

### LAN mode (no cable)

The receiver accepts uploads from **private LAN addresses without a token**, so all the App needs
is the Mac's LAN address: the port falls back to `DEFAULT_ACCEPTANCE_RECEIVER_PORT` (23458) and no
key has to be pasted anywhere.

```tsx
import { UiAcceptanceModule, parseAcceptanceTarget } from 'react-native-ui-acceptance';

// Whatever you stored / the user typed: "192.168.1.5", "192.168.1.5:23458", a copied
// "http://192.168.1.5:23458/..." URL, or the old smacceptance://<ip>:<port>?token=<hex> line
// (still parsed and still honored — the token just becomes optional).
const receiver = parseAcceptanceTarget(storedAddress);
const { armed } = await UiAcceptanceModule.ping(receiver);

// Node tree + screenshot, captured from the same frame, in one request.
const result = await UiAcceptanceModule.uploadBundle(receiver);
// { accepted, captureId, nodeCount, screenshotBytes, serverTimestamp }
```

Persisting that address is the host's job — the SDK has no storage dependency of its own. Store what
the user typed, pre-fill it next launch, and the dialog becomes a one-time step.

Where the token-free exemption stops (worth knowing before you rely on it):

- It applies to **private source addresses only** — 10/8, 172.16/12, 192.168/16, 169.254/16 and
  the IPv6 ULA / link-local ranges. A request from a public address still needs the token.
- It does **not** include loopback. Loopback is the Mac's own process (the USB path through
  `adb reverse`), and its credentials are handed over by the loopback-only `/usb-config` endpoint —
  that endpoint still never answers non-loopback callers, because it hands out the long-lived key.
- The real gate on "who may write a snapshot" is the **target requirement**: an upload must land on
  a requirement the Mac is currently waiting for. Since 2026-09-24 that wait is **resident** — the
  verify page registers the requirement it has open and renews the target by itself, so uploads are
  accepted without anyone pressing a button. There is no time window to race any more; the window is
  "while a requirement is open in the Mac app". An upload arriving with no requirement open is
  rejected with `409`, token or not. The landing requirement is taken from the registered target,
  never from the request body.

Why the screenshot travels in the same request as the node tree: they must describe the same
frame. Fetching them over separate channels (which is what the old `adb screencap` path did)
produces "the nodes are from this screen, the image is from the next one" — that reads as
*the developer placed things wrong*, which is far harder to diagnose than a plain error.

Two things the caller must know:

1. **Hide your own floating UI before capturing.** Bind `uploadBundle` to a button that first sets
   `opacity: 0` on its own overlay for two frames (`requestAnimationFrame` twice plus a short
   `setTimeout` — rAF alone does not guarantee that frame was composited). Anything of yours still
   on screen lands in the acceptance screenshot as an element the design does not have. One trap:
   a React Native `Modal` renders into a **separate native container**, so that `opacity: 0` never
   reaches it — draw dialogs as absolutely-positioned views inside the same tree instead.
2. **A requirement must be open on the Mac.** Uploading with no resident target is rejected with
   `409` ("Mac 验收页当前没有打开任何需求"). Opening a requirement in the verify page is what starts
   the wait — the App's `ping()` reports it as `armed: true`.

`uploadBundle` always captures the `acceptance-full` profile. A lighter profile omits hidden
nodes and text, which downstream reads as "the app is missing this element" — a false negative
that is more dangerous than a missing report, so it is rejected locally before any bytes are sent.

## Node geometry: two accounts of "where can this node still be drawn"

Every node carries both, and they answer different questions:

| Field | Source | Use it for |
| --- | --- | --- |
| `visibleX/visibleY/visibleWidth/visibleHeight` | Android's `getGlobalVisibleRect()` (**iOS sends none**) | reporting the platform's own opinion (insets, native scrolling) |
| `effectiveVisibleX/effectiveVisibleY/effectiveVisibleWidth/effectiveVisibleHeight` | the SDK's own ancestor-clip walk (`CollectPolicy` on Android, `HMClipWindowForChildren` on iOS) | deciding whether the node paints any pixels at all |

The platform value **cannot see draw-time clipping**. React Native clips `overflow: hidden` by
clipping the canvas inside `ViewGroup.draw()`, and `ReactViewGroup.initView()` calls
`setClipChildren(false)` — so `ViewGroup.getChildVisibleRect()`, which is what
`getGlobalVisibleRect()` walks, never learns about that clipping. A row that is clipped away still
reports its full rectangle. iOS has no equivalent API at all (`convertRect:toView:` returns the
layout rect), so the platform half of the pair is Android-only there. Both platforms therefore walk
the chain themselves: layout rect ∩ window rect ∩ every `clipsToBounds` ancestor's own effective
rect (that ancestor may itself have been clipped) — the same predicate as the overlay's
`getUiAcceptanceVisibleRect`, kept identical on purpose.

Two flags come with it: `clippedByAncestor` (the effective rect is smaller than the layout rect)
and `clippedOut` (the layout rect has area, the effective rect does not — the node paints nothing).
`clippedOut` is what the Mac canvas uses to drop noise nodes: it is the "this row is scrolled out of
its list" answer, which the platform geometry cannot give.

What this costs when ignored, measured on a real screen: a `number-flow` price (`¥500`) is three
columns of 30 candidate rows each. Platform geometry called all 90 rows "fully visible" while only
one row per column is ever painted; 76 of the 154 nodes that survived the input gate were those
invisible rows, which is what "the canvas is full of boxes around elements that aren't there"
looks like.

## Node style: what the element actually looks like

Every node also carries two optional style channels. They exist for one consumer: the Mac app's
element inspector, where a UI reviewer asks "does this element look right" — size, copy, type,
background, border. Geometry alone could only answer the first question.

| Field | Unit | Android source | iOS source |
| --- | --- | --- | --- |
| `style.backgroundColor` | `#rrggbb` / `#aarrggbb` | `BackgroundStyleApplicator.getBackgroundColor` | `view.backgroundColor` |
| `style.borderWidth` | dp, per side | `BackgroundStyleApplicator.getBorderWidth` (already `pxToDp`-ed) | **not collected** |
| `style.borderColor` | hex, per side | `BackgroundStyleApplicator.getBorderColor` | **not collected** |
| `style.borderStyle` | `solid` / `dashed` / `dotted` | `BackgroundStyleApplicator.getBorderStyle` | **not collected** |
| `style.borderRadius` | dp, per corner | `BackgroundStyleApplicator.getBorderRadius`, replayed through **RN's own fallback chain**; if that finds nothing, a **reflected private field** for self-drawn views (both see below) | `layer.cornerRadius` + `layer.maskedCorners` — equal-radius / clipped nodes only |
| `textStyle.fontSize` | dp | `TextView.getTextSize()` ÷ `scaledDensity` | `UIFont.pointSize` ÷ content-size multiplier |
| `textStyle.fontWeight` | 100–900 | `CustomStyleSpan.getWeight()`, falling back to the typeface | `UIFontWeightTrait`, nearest of RN's 9 steps |
| `textStyle.fontFamily` | string | `CustomStyleSpan.getFontFamily()` — the **raw** RN string | `UIFont.familyName` — the **resolved** family |
| `textStyle.fontStyle` | `normal` / `italic` | typeface + span style bits | `UIFontDescriptorTraitItalic` |
| `textStyle.lineHeight` | dp | `CustomLineHeightSpan.getLineHeight()` ÷ `scaledDensity` | `NSParagraphStyle.minimum/maximumLineHeight` ÷ multiplier |
| `textStyle.letterSpacing` | dp | `TextPaint.getLetterSpacing()` ÷ `scaledDensity` | `NSKernAttributeName` (not multiplied — do not divide) |
| `textStyle.color` | hex | `TextView.getCurrentTextColor()` | `NSForegroundColorAttributeName` |

**Length units differ from geometry on purpose.** Geometry stays in px so it lines up with the
screenshot; style values are reported in dp — "the number the developer wrote". `borderWidth: 1`
should read as 1 on every device, not as 2.75 on a 3x phone. Nothing downstream may divide these by
the density a second time.

**Corner radius goes through a fallback chain, not a per-corner key lookup.** RN stores each of the
13 radius syntaxes in its own field of `BorderRadiusStyle`: the shorthand `borderRadius: 8` lands in
`uniform`, while `borderTopLeftRadius: 8` lands in `topLeft`. `BackgroundStyleApplicator`'s getter is
an **exact key lookup** — the `startStart ?: topStart ?: topLeft ?: uniform` fallback exists only in
the *drawing* path (`BorderRadiusStyle.resolve`). Asking for a physical corner therefore returns
`null` for everything styled with the shorthand. Measured on the host app (react-android
`0.81.5-mall`): 1276 shorthand uses vs 261 per-corner ones — one 530-node snapshot read radii on just
12 nodes (all ≤ 2 dp) and missed every 8–12 dp card and image, so the inspector drew no radius row at
all. `ViewStyleReader` now reads all 13 keys once and replays the same chain — the LTR branch **and**
the RTL left/right swap — before converting to dp.

**Some radii never reach RN at all — those are reflected out of the library's own private field.** A few
third-party views paint their own rounded corners in Java (`Canvas.drawPath`), with the radius handed to
them as a **custom prop** instead of RN's `borderRadius`. `react-native-linear-gradient` is the one in
the host app: its JS flattens the style, expands the four corners into an 8-element array and passes it
to `LinearGradientView.setBorderRadii`, which stores it in the private field `mBorderRadii`. None of that
value is ever in a drawable, so the official channel returns `null` for every corner. Worse, the wrapper
`<View style={{borderRadius: 28}}>` that *would* have been readable is **flattened away by Fabric** —
`borderRadius` is not in `ViewShadowNode`'s `formsView` predicate (only background colour, border width,
`overflow: hidden`, shadow, outline and testID are) — so the gradient view is the only node left that
knows the radius. `ViewStyleReader` therefore keeps a small **class name → private field name** table and
reflects the value out. It deliberately does **not** import the library: the SDK must not make every host
that lacks it fail to compile, so the class name is a string and a miss is a silent skip (a renamed field
degrades to "not read", never to a wrong number). Two conversions matter: the field is in **px** (the
setter ran `PixelUtil.toPixelFromDIP`), so it is divided by the same density RN uses; and only the even
indices (0/2/4/6) are the four corners — that is `Path.addRoundRect`'s `[tl, tl, tr, tr, br, br, bl, bl]`
layout, which happens to match the snapshot's corner order exactly. An all-zero array is the field's
default and is reported as "not read", not as `0`. This bypass runs **only** when the official channel
returns no corner at all.

**Font sizes are normalized against the system font scale, and each platform divides by its own.**
React Native multiplies `fontSize` before handing it to the native text view, so the raw value carries
the user's display-size preference. Android divides by `scaledDensity` (`density × fontScale`); iOS
looks the multiplier up in RN's own `UIContentSizeCategory` table (`RCTAccessibilityManager.mm:256`,
sourced from `UIApplication.preferredContentSizeCategory`, ranging 0.823 → 3.571). Without that step
the same design shows two different sizes on two phones, and the reviewer's conclusion is "the app
picked the wrong font size". Known approximation on both sides: text with `allowFontScaling={false}`
is not scaled by RN, so dividing it back over-corrects by one multiplier. React Native does not expose
that flag on the View. `letterSpacing` is the exception on iOS — RN writes it into `NSKern` **without**
the multiplier, so it must not be divided.

**iOS cannot read borders, and says so rather than guessing.** RN draws iOS borders as a contour image
on a private `_borderLayer` and sets `layer.borderWidth = 0` (`RCTViewComponentView.mm:944`); the
`layer` path is only taken when the border is uniform in width/color/style, solid, has uniform radii,
and the view either has zero border width, clips, or has a transparent border (`:885`) — and RN's
default `overflow` is not `hidden`. In other words **the nodes whose borders you most want to inspect
are exactly the ones that read back as 0**. So iOS emits `style` as an object containing only
`backgroundColor`, and **never emits `style: null`** — it sends `{}` when the node has no background.

That distinction is load-bearing at the consumer end. `style === null` means "collected, genuinely
none" (a transparent Android layout container) and the Mac panel draws `—`; a **missing border key**
means "this version does not collect it" and the panel skips the whole border group. Collapsing the two
would have the panel tell a reviewer "this element definitely has no border" about a node whose border
was never read. `textStyle` keeps the usual three states: object, `null` for a non-text node, and a
missing key for SDKs older than the channel.

⚠️ These fields are **not** written into the recorder's JSONL frames (`NativeNode.writeJson`). The
recorder streams hundreds of frames of the same tree for timing measurements and gains nothing from
them; they only travel over the acceptance channel (`capture()` → `toWritableMap`).

The font fields are the reason this file imports `com.facebook.react.views.text.internal.span.*`:
`TextView.getTypeface()` returns a *resolved* typeface, which carries no family name and collapses
weights to bold-or-not — neither can be compared against a design spec that says
"PingFang SC / Semibold / line height 20". Reading React Native's spans is the only way to get the
values it was actually given. If a future React Native moves those classes, **this is the one file
that fails to compile**, by design: a clear compile error at upgrade time beats a silent `null` at
runtime.

## iOS: what the payload does and does not carry

Since 2026-09-24 iOS uploads over the same protocol as Android (`platform: "ios"`,
`source: "react-native-ui-acceptance"`), and macOS accepts both. What the two sides actually share:

| | Android | iOS | Notes |
|---|---|---|---|
| `nodeId` / `treePath` / `parentId` / `className` / `depth` / `index` / `siblingCount` | ✅ | ✅ | `treePath` is the Mac's stable key: root `0`, i-th child `<parent>/<i>` |
| `x` / `y` / `width` / `height` (px) | ✅ | ✅ | converted through `160 / densityDpi` into logical units |
| `visible` / `attached` / `clickable` / `enabled` / `clipsToBounds` / `alpha` / `z` | ✅ | ✅ | |
| `isSvg` / `isImage` / `isGradient` / `hasVisualContent` | ✅ | ✅ | iOS matches `RNSVGSvgView`, `UIImageView`, `BVLinearGradient` by class name |
| `text` | ✅ | ✅ | only when `includeText` is on. iOS walks the `superview` chain for `attributedText`: RN Fabric's real text view is the private `RCTParagraphTextView` (no `attributedText` of its own), whose `RCTParagraphComponentView` parent holds it — so the inner view would otherwise report empty text |
| `resourceName` / `contentDescription` | ✅ | — | Android layout-resource id / accessibility description |
| `accessibilityIdentifier` / `accessibilityLabel` | — | ✅ | iOS's own pair. ⚠️ `accessibilityIdentifier` is **not** the same thing as Android's `resourceName` (that one is `getResourceEntryName(view.getId())`, a layout id) — so it is reported under its own name rather than aliased, and the Mac reads `null` for both Android-named fields |
| `visibleX/visibleY/visibleWidth/visibleHeight` | ✅ | ❌ | platform value; iOS has no equivalent API, so macOS falls back to the full rect |
| `effectiveVisibleX/…/effectiveVisibleHeight` / `clippedByAncestor` / `clippedOut` | ✅ | ✅ | the ancestor-clip walk; identical predicate on both sides |
| `textStyle` (7 fields) | ✅ | ✅ | Android reads RN's `CustomStyleSpan` / `CustomLineHeightSpan`; iOS reads the attributes RN puts on its own `NSAttributedString` (`attributedText`). ⚠️ `fontFamily` is the **raw** RN string on Android but the **resolved** family name on iOS (`UIFont.familyName`) — custom families usually match, but RN falls back to the system font when a family is missing, so this row can disagree |
| `style.backgroundColor` | ✅ | ✅ | Android via `BackgroundStyleApplicator`; iOS via `view.backgroundColor` |
| `style.gradient` | ✅ | ✅ | Linear gradient colors/points; Android/iOS read native linear-gradient host fields |
| `style.borderWidth` / `borderColor` / `borderStyle` | ✅ | ❌ | RN paints iOS borders into a private contour layer and zeroes `layer.borderWidth`, so the nodes you most want to inspect are the ones that read 0. iOS therefore sends **no border keys at all** — the Mac skips the border group rather than drawing three rows of `—` |
| `style.borderRadius` | ✅ | ⚠️ 等半径档 | iOS 读 `layer.cornerRadius`（逻辑点，与 RN dp 口径一致）+ `layer.maskedCorners` 还原四角；**不等半径 / `overflow` 非 hidden** 的圆角 RN 折进私有形状路径、`cornerRadius` 置 0，这一档读不到。输出键 `topLeft/topRight/bottomRight/bottomLeft` 与安卓 `CORNER_KEYS` 一致，面板复用同一折叠逻辑。⚠️ 安卓侧 **0.1.14 起**才走 RN 的回退链 —— 0.1.13 及更早按物理角精确取值，平铺 `borderRadius` 全读成 null（见上文圆角那一段）。**0.1.16 起**多一条兜底：自绘圆角的第三方视图（`LinearGradientView`）改从库的私有字段反射读 —— 那类值从没进过 drawable，回退链管不到（见上文自绘那一段） |
| `style` is `null` vs `{}` | `null` = no box style | `{}` = no background, border never collected | iOS never sends `null`; see the style section above for why that matters |
| `participation` / `passThrough` / `layoutOnly` / `elevation` / `scrollX` / `scrollY` | ✅ | ❌ | macOS recomputes `passThrough` from the rects when the flag is absent |
| `collection` (`profile`, limits, `actualDepth`, truncation flags) | ✅ | ✅ | the upload gate reads this |
| `deviceModel` / `packageName` | ✅ `OPPO PGZ110` / app id | ✅ `Apple iPhone15,3` / bundle id | used to label stored screenshots |
| Screenshot covers | the whole display (`PixelCopy`) | `window.bounds` only | iOS images therefore have **no status bar** (UIKit draws it outside the app's hierarchy); nodes and image share the window space, so alignment is unaffected |

The screenshot misses the status bar on iOS by construction, not by bug: there is no public
"capture the whole screen" API (that is ReplayKit). If a future requirement needs that strip,
compose the other scene windows into the same renderer.

## Recording (Android only)

**Not part of the acceptance path.** The node-recording capability is Android-only and is kept for
one purpose: measuring how long a full-tree walk actually takes (`avgCaptureMs` / `maxCaptureMs`).
It is not ported to iOS, and its `recording` profile is rejected by the Mac receiver — so a snapshot
produced under it can never be mistaken for an acceptance input.

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

## Local checks (no host build required)

This package is a library module: there is no Gradle project and no Podfile here, so neither
platform can be built standalone — normally that means "change one line of native code, then wait
for the host app to build". Both sides have a shortcut instead:

```bash
npm run check       # Android: javac over android/src/main/java against local android.jar + react-android
npm run check:ios   # iOS: clang -fsyntax-only over ios/*.m against the local iPhoneOS SDK
```

`check:ios` substitutes the two React bridge headers it needs with the stubs in
`scripts/ios-stubs/React/` (CocoaPods flattens `React/**` into `React/` at install time, and pulling
the real headers in would drag half of React Native along with them). It therefore validates **your
file** — syntax, ARC, signatures, format strings, protocol conformance, Foundation/UIKit misuse —
but not the correctness of RN macro usage. That part still needs the host build. `check` does not
include `check:ios`, so a machine without Xcode can still run it.
