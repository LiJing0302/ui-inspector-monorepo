# UI Inspector Monorepo

This is a new, isolated workspace for the four cooperating products:

- `apps/screen-mirror-mac`: Electron/macOS mirror and acceptance app.
- `apps/figma-plugin`: Figma export plugin.
- `apps/vscode-extension`: VS Code source navigation and reverse-highlight extension.
- `packages/react-native-ui-acceptance`: React Native inspection SDK.
- `packages/inspector-protocol`: shared, runtime-neutral protocol and source mapping types.

The original projects are intentionally not moved or edited by this bootstrap. Their current
locations are recorded in `workspace.sources.json`. Migration is an explicit later step after
the workspace checks and package boundaries are validated.

## Bootstrap

```bash
corepack enable
pnpm install
pnpm check:protocol
```

See [`docs/MONOREPO-PLAN.md`](docs/MONOREPO-PLAN.md) for the complete migration and delivery plan.
