import * as path from 'node:path';

import * as vscode from 'vscode';
import WebSocket from 'ws';

import {
  INSPECTOR_PROTOCOL_VERSION,
  sourceRangeContains,
  type InspectorMessage,
  type SourceRef,
} from '@ui-inspector/protocol';

const SOURCE_PICK_MODE_TIMEOUT_MS = 30_000;

class InspectorClient implements vscode.Disposable {
  private socket: WebSocket | null = null;
  private sourcePickTimer: NodeJS.Timeout | null = null;
  private sourcePickMode = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sourceDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    border: '1px solid',
  });

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.commands.registerCommand('uiInspector.connect', () => this.connect()),
      vscode.commands.registerCommand('uiInspector.enterSourcePickMode', () => this.enterSourcePickMode()),
      vscode.commands.registerCommand('uiInspector.clearHighlight', () => this.clearHighlight()),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
    );
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      void vscode.window.showInformationMessage('UI Inspector 已连接');
      return;
    }

    const config = vscode.workspace.getConfiguration('uiInspector');
    const host = config.get<string>('host', '127.0.0.1');
    const port = config.get<number>('port', 23459);
    const socket = new WebSocket(`ws://${host}:${port}`);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        this.send({ type: 'hello', protocol: INSPECTOR_PROTOCOL_VERSION, appId: 'vscode-extension', token: '' });
        void vscode.window.showInformationMessage('UI Inspector 已连接');
        resolve();
      });
      socket.once('error', (error: Error) => reject(error));
    }).catch((error: Error) => {
      if (this.socket === socket) this.socket = null;
      void vscode.window.showErrorMessage(`UI Inspector 连接失败：${error.message}`);
    });

    socket.on('message', (data: WebSocket.RawData) => this.onMessage(data.toString()));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.sourcePickMode = false;
      this.clearSourceDecoration();
      void vscode.window.setStatusBarMessage('UI Inspector 已断开', 3000);
    });
  }

  enterSourcePickMode(): void {
    if (!this.isConnected()) {
      void vscode.window.showWarningMessage('请先连接 UI Inspector');
      return;
    }
    this.sourcePickMode = true;
    if (this.sourcePickTimer) clearTimeout(this.sourcePickTimer);
    this.sourcePickTimer = setTimeout(() => {
      this.sourcePickMode = false;
      void vscode.window.setStatusBarMessage('UI Inspector 源码选取模式已超时', 3000);
    }, SOURCE_PICK_MODE_TIMEOUT_MS);
    void vscode.window.setStatusBarMessage('UI Inspector：请点击 JSX 标签', SOURCE_PICK_MODE_TIMEOUT_MS);
  }

  clearHighlight(): void {
    this.send({ type: 'clear-highlight' });
    this.clearSourceDecoration();
  }

  dispose(): void {
    if (this.sourcePickTimer) clearTimeout(this.sourcePickTimer);
    this.socket?.close();
    this.sourceDecoration.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.sourcePickMode || event.textEditor.document.uri.scheme !== 'file') return;
    const selection = event.selections[0];
    if (!selection) return;

    this.sourcePickMode = false;
    if (this.sourcePickTimer) clearTimeout(this.sourcePickTimer);
    const document = event.textEditor.document;
    const filePath = vscode.workspace.asRelativePath(document.uri, false);
    const line = selection.active.line + 1;
    const column = selection.active.character + 1;
    this.send({
      type: 'highlight-source',
      requestId: `vscode-${Date.now()}`,
      source: {
        projectRootHash: this.workspaceHash(),
        relativePath: filePath,
        startLine: line,
        startColumn: column,
        endLine: line,
        endColumn: column,
        sourceId: '',
        displayName: path.basename(filePath),
        role: 'instance',
      },
    });
  }

  private onMessage(raw: string): void {
    let message: InspectorMessage;
    try {
      message = JSON.parse(raw) as InspectorMessage;
    } catch {
      return;
    }
    if (message.type === 'open-source') this.openSource(message.source);
  }

  private async openSource(source: SourceRef): Promise<void> {
    const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path.join(source.relativePath)))?.uri;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot || source.projectRootHash !== this.workspaceHash()) {
      void vscode.window.showWarningMessage('UI Inspector 项目不匹配，已拒绝打开源码');
      return;
    }
    const file = vscode.Uri.joinPath(workspaceRoot, source.relativePath);
    if (!root && !file.fsPath.startsWith(workspaceRoot.fsPath + path.sep)) {
      void vscode.window.showWarningMessage('UI Inspector 源码路径不在当前 workspace 内');
      return;
    }
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const start = new vscode.Position(Math.max(0, source.startLine - 1), Math.max(0, source.startColumn - 1));
    const end = new vscode.Position(Math.max(0, source.endLine - 1), Math.max(0, source.endColumn - 1));
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(this.sourceDecoration, [new vscode.Range(start, end)]);
  }

  private clearSourceDecoration(): void {
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.sourceDecoration, []);
  }

  private send(message: InspectorMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private workspaceHash(): string {
    // The RN runtime will replace this with its project hash during the handshake.
    return vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new InspectorClient(context);
  context.subscriptions.push(client);
}

export function deactivate(): void {}
