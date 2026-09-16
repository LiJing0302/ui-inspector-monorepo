# UI Inspector VS Code Extension

Connects to the Mac `InspectorBridge` and provides source navigation for mounted React Native
instances plus the reverse source-pick workflow.

Commands:

- `UI Inspector: Connect`
- `UI Inspector: Enter Source Pick Mode`
- `UI Inspector: Clear Highlight`

Open the workspace containing the RN source, start Android scrcpy in the Mac app, and run Connect.
The extension validates the project root hash and refuses paths outside the current workspace.
The optional `uiInspector.token` setting must match `UI_INSPECTOR_TOKEN` used by the Mac process.
