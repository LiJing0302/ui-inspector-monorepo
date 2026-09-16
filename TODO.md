# TODO

## Monorepo

- [ ] Create the isolated Git repository and baseline commit.
- [ ] Migrate the Mac app into `apps/screen-mirror-mac` without changing behavior.
- [ ] Migrate the Figma plugin into `apps/figma-plugin` and keep its sandbox build independent.
- [ ] Migrate the RN SDK into `packages/react-native-ui-acceptance` and verify npm tarball consumption.
- [ ] Create `apps/vscode-extension` with source navigation and reverse-highlight commands.
- [ ] Extract the duplicated Figma/Mac bridge definitions into `packages/inspector-protocol`.
- [ ] Add the RN Inspector source-marking and Fiber/native-tag mapping layer.
- [ ] Add the Electron InspectorBridge and Android ADB reverse transport.
- [ ] Add cross-project protocol, fixture, and integration checks.
- [ ] Add CI for Mac app, Figma plugin, RN SDK, protocol, and VS Code extension.

## Scope guards

- [ ] Keep iPhone reverse inspection out of the first release.
- [ ] Do not use Metro source maps as the runtime node identity.
- [ ] Do not mutate the original three project directories during migration.
