# TODO

## Monorepo

- [x] Create the isolated Git repository and baseline commit.
- [x] Migrate the Mac app into `apps/screen-mirror-mac` without changing behavior.
- [x] Migrate the Figma plugin into `apps/figma-plugin` and keep its sandbox build independent.
- [x] Migrate the RN SDK into `packages/react-native-ui-acceptance` and preserve npm package metadata.
- [x] Create the initial `apps/vscode-extension` project with source navigation and reverse-highlight commands.
- [x] Create the initial shared `packages/inspector-protocol` package.
- [ ] Add the RN Inspector source-marking and Fiber/native-tag mapping layer.
- [ ] Add the Electron InspectorBridge and Android ADB reverse transport.
- [ ] Add cross-project protocol, fixture, and integration checks.
- [ ] Add CI for Mac app, Figma plugin, RN SDK, protocol, and VS Code extension.

### Current migration follow-ups

- [ ] Replace VS Code's temporary workspace hash with the Mac/RN handshake hash.
- [ ] Wire `open-source` and `highlight-source` through the Electron InspectorBridge.
- [ ] Add real RN 0.81 fixture coverage for Fiber/native-tag mapping.

## Migration verification

- [x] Root pnpm workspace install completed.
- [x] Protocol, Mac, Figma, RN SDK, and VS Code type checks passed.
- [x] Figma plugin build passed.
- [x] Mac Electron production build passed.
- [x] RN Android compile-check and 65 policy tests passed.
- [x] RN npm pack dry-run passed.

## Scope guards

- [x] Keep iPhone reverse inspection out of the first release.
- [x] Do not use Metro source maps as the runtime node identity.
- [x] Do not mutate the original three project directories during migration.
