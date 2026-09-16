import React, { useCallback, useEffect, useState } from 'react';

import type { BridgeStatus } from '@shared/ipc';
import type { RequirementMeta } from '@shared/verify';

import BridgeChip from './components/BridgeChip';
import RequirementsPage from './pages/RequirementsPage';
import VerifyWorkspacePage from './pages/VerifyWorkspacePage';

/**
 * 验收窗口的视图状态机。
 *
 * 只有两层：需求列表 → 验收工作台。素材导入、页面配对、画布验收都在工作台内
 * 用 tab 切换完成，不再有「需求详情 / 匹配」这些中间页 —— 点需求即直达验收。
 *
 * 刻意**不引入路由库**：两个视图、层级扁平，`useState` 足够
 * （这是桌面应用，不需要地址栏）。
 */
type View = { name: 'requirements' } | { name: 'workspace'; requirementId: string };

const App: React.FC = () => {
  const [view, setView] = useState<View>({ name: 'requirements' });
  const [currentName, setCurrentName] = useState<string>('');

  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [bridgePending, setBridgePending] = useState(false);

  /**
   * 插件直传导入完成后递增。
   *
   * 为什么要这一层：导入是**由插件触发的**，渲染层没有发起过请求，
   * 拿不到返回值，也就没有天然的刷新时机。用递增 token 而不是把素材数据提到 App：
   * 数据归各页面自己管，App 只负责说一句「外面有人改了数据，重新取一次」。
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;

    // 挂载时主动取一次：主进程可能在窗口渲染前就已经把服务起好了
    void window.api.bridge
      .status()
      .then((status) => {
        if (alive) setBridgeStatus(status);
      })
      .catch((cause: unknown) => {
        if (alive) setBridgeError((cause as Error).message);
      });

    const off = window.api.bridge.onEvent((event) => {
      if (event.type === 'status') {
        setBridgeStatus(event.status);
        return;
      }
      setBridgeStatus((current) => (current ? { ...current, lastImport: event.last } : current));
      setReloadToken((value) => value + 1);
    });

    return () => {
      alive = false;
      off();
    };
  }, []);

  const toggleBridge = useCallback((enabled: boolean) => {
    setBridgePending(true);
    setBridgeError(null);
    void window.api.bridge
      .setEnabled(enabled)
      .then(setBridgeStatus)
      .catch((cause: unknown) => setBridgeError((cause as Error).message))
      .finally(() => setBridgePending(false));
  }, []);

  const goRequirements = useCallback(() => setView({ name: 'requirements' }), []);

  const openRequirement = useCallback((requirement: RequirementMeta) => {
    setCurrentName(requirement.name);
    setView({ name: 'workspace', requirementId: requirement.id });
  }, []);

  return (
    <div className="verify-root">
      <header className="header">
        <div className="header-left">
          <span className="brand">UI 验收</span>
          <nav className="crumbs">
            <button
              type="button"
              className={`crumb${view.name === 'requirements' ? ' active' : ''}`}
              onClick={goRequirements}
            >
              需求列表
            </button>
            {view.name === 'workspace' && (
              <>
                <span className="crumb-sep">/</span>
                <span className="crumb current">{currentName || '需求'}</span>
              </>
            )}
          </nav>
        </div>
        <div className="header-right">
          <BridgeChip status={bridgeStatus} pending={bridgePending} onToggle={toggleBridge} />
          <span className="view-tag">{view.name === 'requirements' ? '需求' : '验收工作台'}</span>
        </div>
      </header>

      {bridgeError && <div className="alert error flush bridge-alert">{bridgeError}</div>}

      {view.name === 'requirements' && (
        <RequirementsPage onOpen={openRequirement} reloadToken={reloadToken} />
      )}

      {view.name === 'workspace' && (
        <VerifyWorkspacePage
          requirementId={view.requirementId}
          onBack={goRequirements}
          onNameChange={setCurrentName}
          reloadToken={reloadToken}
        />
      )}
    </div>
  );
};

export default App;
