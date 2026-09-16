# RN 0.81 Inspector Fixture

This fixture intentionally covers direct host elements, a custom component, an HOC, a conditional
branch, and two `FlatList` instances sharing one JSX source range. Run it inside a React Native
0.81.6 host app with the SDK Babel plugin enabled, then start `UiInspector` and Android scrcpy.

Expected behavior:

- clicking a mounted branch opens its JSX range;
- selecting the `ThemedRow` usage highlights both mounted rows;
- selecting `Loading branch` while `loading` is false reports `not-mounted`;
- toggling or scrolling never reuses a detached native tag.
