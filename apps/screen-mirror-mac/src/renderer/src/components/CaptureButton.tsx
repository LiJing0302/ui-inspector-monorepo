import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AndroidCaptureResult,
  AndroidDeviceInfo,
  NetworkAddress,
} from '@shared/ipc';

import { pickDefaultAddress } from '../lib/networkAddress';

interface CaptureButtonProps {
  requirementId: string;
  onCaptured: () => void;
}

/**
 * 设备列表的刷新间隔。
 *
 * 这个面板上有一句话是**会变的**：「USB 直传已就绪 / 未检测到设备」。插上线之后它必须自己变，
 * 否则用户会以为「插了线也没用」，转头去填地址 —— 而那时 USB 其实已经可用了。
 *
 * 顺带每轮也重取一次**网卡列表**：它极少变，但插上网线后会多出一张有线网卡，
 * 地址得跟着切过去（见 `lib/networkAddress`）。
 *
 * ⚠️ 这里**不再取接收器信息**了（2026-09-24 三改）：端口与密钥以前只有「旧版 App 连接串」
 * 那一行在用，那一行删掉之后，这块面板就再也不需要向接收器问任何事（见下方 ⑧）。
 */
const STATUS_POLL_MS = 5 * 1000;

/**
 * 一行连接串 `smacceptance://<host>:<port>?token=<token>`。
 *
 * ⚠️ **界面上已经不展示它了**（2026-09-24 三改）：接收器对局域网私有地址免密钥之后，
 * 手机端只填一个 IP 就够，「旧版 App 专用行」属于给已经不存在的用户准备的东西。
 * 函数本身留着 —— 它是这条线的**格式定义**，SDK 侧的 `parseAcceptanceConnectionString` /
 * `buildAcceptanceConnectionString` 两头都按它对齐，删掉会让那两处注释失去落点。
 */
export function buildConnectionString(address: string, port: number, token: string): string {
  return `smacceptance://${address}:${port}?token=${token}`;
}

/**
 * 接收面板：**常驻等待手机上传**，Mac 这边不需要点任何按钮。
 *
 * 这里曾经有四样东西，现在都没了：
 * ① 设备下拉框 —— 采集不再走 USB，选设备没有意义了；
 * ② 每次采集现生成的一串 endpoint/token/captureId —— 密钥已长期化，手机上配一次就够；
 * ③ 采集完要人手抄凭据的提示 —— 那是「必须人工搬运三个随机值」年代的产物；
 * ④ 「接收网卡」下拉框 —— 多于一张网卡时才出现，选错（挑到 docker / vmnet 这类虚拟网卡）
 *    的后果是手机连不上，而这件事要到手机上才看得见。既然「哪张网卡对外可达」有客观依据，
 *    就交给 `lib/networkAddress` 按规则自动挑，人不必作答。列表仍在界面之外生效：
 *    刷新会按当前网卡重新挑一次（插上网线后点刷新即可切到有线地址）。
 * ⑤ 连接串不再是主展示（2026-09-24）—— 接收器改成「来自局域网私有地址即放行」之后，
 *    手机端只填一个地址就能上传，所以这里主展示**裸地址**，那一整行 smacceptance://
 *    一度降级成给旧版 App 看的次要一行（见 ⑧，后已删除）。
 * ⑥ 「开始接收（USB直传）/ 局域网接收」两个按钮（2026-09-24 晚）—— 挂载即登记常驻等待，
 *    见下。
 * ⑦ 「接收状态：等待中 · 靶已续期至 …」那一行，连同「Mac 这边不用先点任何按钮，也不用选设备」
 *    那句解释（2026-09-24 再改）—— 它们都在描述**用户不需要知道的事**：靶、续期、等待窗口
 *    全是实现细节，而「快照会落到当前打开的需求」这一句已经把用户的疑问答完了。
 *    删掉之后这一块只剩两件事：**怎么把快照传过来**（① USB / ② 地址）与**刚收到的那份长什么样**
 *    （下方 alert）。前者是操作，后者是结果；中间那层「系统此刻处于什么状态」既不能点、
 *    也不影响任何一个决策。至于「到底在不在收」—— 靶失效的自然出口是上传被拒，
 *    错误会落在手机上，比在这里挂一行只有本机能看见的状态字更接近问题发生的地方。
 * ⑧ 「旧版 App（只认连接串）」那一行（2026-09-24 三改）—— ⑤ 把它留成向后兼容用的次要一行，
 *    但没有任何在用的 App 需要它，留着只会让人以为「这上面还有个东西得填」。删掉之后，
 *    这块面板**再也不向接收器问任何事**（端口 / 密钥 / 靶状态全都不在界面上），
 *    只剩两件事：**怎么传**（方式一 / 方式二）与**刚收到的那份长什么样**。
 *    连接串的格式定义仍留在 `buildConnectionString`，供 SDK 侧对齐。
 *
 * ## 为什么不再需要「开始接收」
 *
 * 那两个按钮做的事是「立靶 + 等一份上传」。靶是必须的（它回答「这份快照算哪个需求的」，
 * 没有靶时接收器拒收而不是随便找个需求放），但**让人点一下才立靶**这件事本身没有价值：
 * 打开某个需求页，本身就等价于「我要收它的快照」。所以现在挂载即登记（`setAcceptanceStandby`），
 * 离开即撤销，靶由接收器自己续期。
 *
 * 这一改还顺带修好了一件事：USB 直传需要的 adb reverse 隧道原先也是点按钮时才建、等到就拆。
 * 手机侧判断「USB 可不可行」探的正是那条隧道，所以隧道必须常驻，否则插着线也永远走 WiFi。
 * 隧道现在由主进程在常驻期间定期维护，见 `verifyIpc` 的 `ensureUsbReverses`。
 */
const CaptureButton: React.FC<CaptureButtonProps> = ({ requirementId, onCaptured }) => {
  const [addresses, setAddresses] = useState<NetworkAddress[]>([]);
  const [devices, setDevices] = useState<AndroidDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AndroidCaptureResult | null>(null);
  const [copied, setCopied] = useState(false);
  const authorized = devices.filter((device) => device.state === 'device');
  /** 接收地址由网卡列表派生，没有可被人工改写的中间状态（见 lib/networkAddress） */
  const address = useMemo(() => pickDefaultAddress(addresses), [addresses]);

  const refresh = useCallback(async () => {
    try {
      const [list, deviceList] = await Promise.all([
        window.api.getLocalIp(),
        window.api.verify.listAndroidDevices().catch(() => [] as AndroidDeviceInfo[]),
      ]);
      setAddresses(list);
      setDevices(deviceList);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /**
   * 登记 / 撤销常驻等待。
   *
   * 撤销放在清理里而不是只在卸载时做：切需求时这个 effect 会先跑清理再跑新的一轮，
   * 于是中间那一下「撤销」把旧需求解绑，避免下一份上传落到一个已经没人看的需求上。
   * 失败只提示不阻断 —— 登记失败的直接后果是上传会被拒（409），
   * 错误会同时显示在手机端，比抛一句只有本机能看见的话更有指向。
   *
   * 不再接登记回执里的 arm/token：那块面板上没有任何一处要用它（见组件头 ⑧）。
   */
  useEffect(() => {
    let alive = true;
    void window.api.verify.setAcceptanceStandby(requirementId).catch((cause: unknown) => {
      if (alive) setError((cause as Error).message);
    });
    return () => {
      alive = false;
      void window.api.verify.setAcceptanceStandby(null).catch(() => {});
    };
  }, [requirementId]);

  /** 常驻接收的结果是推回来的，不是这次调用的返回值 —— 收到就刷新需求。 */
  useEffect(() => {
    return window.api.verify.onAppSnapshotReceived((payload) => {
      // 主进程只有一条常驻等待，但推送与「切换需求」可能擦肩而过：这一份是别的需求的就丢掉，
      // 否则这里会显示一份不属于当前页面尺寸的快照，而它其实已经正确落到隔壁需求里了。
      if (payload.requirementId !== requirementId) return;
      setResult(payload);
      onCaptured();
    });
  }, [onCaptured, requirementId]);

  const handleCopyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败，请手工选中复制');
    }
  }, [address]);

  return (
    <div className="capture-zone">
      <div className="capture-hint">
        <div>
          快照会落到 Mac 上<strong>当前打开的这个需求</strong>。下面两条路二选一 ——
          插着线时手机会自动优先走线，不用手动切。
        </div>

        <div className="capture-method">
          <div className="capture-hint-title">方式一 USB 直连（Android）</div>
          <div className={authorized.length > 0 ? 'capture-plain ready' : 'capture-plain'}>
            {authorized.length > 0
              ? `USB 直传已就绪（${authorized.length} 台已授权设备）：插线时手机端零配置。`
              : '未检测到已授权的 USB 设备；连接线并允许 USB 调试'}
          </div>
          <ol className="capture-steps">
            <li>用数据线连接手机与这台 Mac，手机上弹出「允许 USB 调试」时点允许</li>
            <li>在手机上打开要验收的页面，点 App 悬浮按钮里的「上传」</li>
          </ol>
        </div>

        <div className="capture-method">
          <div className="capture-hint-title">方式二 无线连接</div>
          <ol className="capture-steps">
            <li>让手机与这台 Mac 连上同一个 Wi-Fi</li>
            <li>把下面这个地址填进 App 的验收配置</li>
            <li>在手机上打开要验收的页面，点 App 悬浮按钮里的「上传」</li>
          </ol>
          <div className="capture-conn">
            <code>{address || '（正在读取接收地址…）'}</code>
            <button
              type="button"
              className="btn"
              disabled={!address}
              onClick={() => void handleCopyAddress()}
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {result && (
        <div className="alert ok">
          接收成功：{result.width}×{result.height} dp（{result.pixelWidth}×{result.pixelHeight} px @
          {result.densityDpi}dpi），{result.nodeCount} 个节点
          {result.packageName ? ` · ${result.packageName}` : ''}
          {result.deviceModel ? ` · ${result.deviceModel}` : ''}
        </div>
      )}
      {result?.warning && <div className="alert warn">{result.warning}</div>}
    </div>
  );
};

export default CaptureButton;
