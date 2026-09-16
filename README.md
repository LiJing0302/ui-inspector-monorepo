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
RN Babel __source marker -> Fiber registry -> native tag / Android View
       -> adb reverse -> Electron InspectorBridge
       -> scrcpy canvas pick <-> VS Code source selection
```

The SDK Babel plugin is development-only and emits `.ui-inspector/source-manifest.json`. Runtime
identity is the mounted Fiber/native tag pair; Metro source maps are used only for source
validation. Configure the plugin and `UiInspector` from the SDK README before launching Android
scrcpy. iPhone reverse inspection and LAN fallback remain later scope.
