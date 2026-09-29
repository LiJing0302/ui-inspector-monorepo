# UI Inspector Monorepo

This is a new, isolated workspace for the four cooperating products:

- `apps/screen-mirror-mac`: Electron/macOS mirror and acceptance app.
- `apps/figma-plugin`: Figma export plugin.
- `apps/vscode-extension`: VS Code source navigation and reverse-highlight extension.
- `packages/react-native-ui-acceptance`: React Native inspection SDK.
- `packages/inspector-protocol`: shared, runtime-neutral protocol and source mapping types.

The original projects are intentionally not moved or edited. Their source locations are recorded
in `workspace.sources.json`; this repository contains independent copies so changes can be
validated without changing the originals.

## Bootstrap

```bash
corepack enable
pnpm install
pnpm check:protocol
pnpm check:all
```

See [`docs/MONOREPO-PLAN.md`](docs/MONOREPO-PLAN.md) for the complete migration and delivery plan.

## Inspector flow

The Android development path is now wired as:

```text
RN Babel nativeID marker -> Android View tree
       -> adb reverse -> Electron InspectorBridge
       -> scrcpy canvas pick <-> VS Code source selection
```

The SDK Babel plugin is development-only. It marks React Native host views with compact source
metadata in `nativeID`; Android reads that metadata directly from the mounted View tree. There is
no Fiber hook or background tree polling. The native tree is collected only when a pick or source
highlight request arrives. Configure the plugin and `UiInspector` from the SDK README before
launching Android scrcpy. iPhone reverse inspection and LAN fallback remain later scope.
