# Mac 投屏工具

Android 继续使用 scrcpy；iPhone 改用 LiveKit 官方 ReplayKit 广播链路。

## 首次安装

在此目录运行：

```bash
npm ci
brew install livekit
npm run setup:livekit
npm start
```

`setup:livekit` 将 Homebrew 的 `livekit-server` 复制到 `resources`。本次验证版本为
1.13.6，复制的是当前 Mac 架构的二进制；给另一种架构的 Mac 打包时，必须在对应架构
准备服务程序。不要通过 `brew services start livekit` 常驻运行：服务由 Electron 管理，
否则会发生端口冲突。退出 App、停止或切换 Android 时会终止本工具启动的服务。

JS 客户端固定为 2.22.3；服务端 SDK 固定为支持 Electron 30 内置 Node 的 2.15.0。
二进制未纳入 Git；重新检出后必须执行 setup。

## iPhone 安装与使用

1. 在 Xcode 打开 `../../ios/MallApp.xcworkspace`，等待 Swift Package 解析完成。
   LiveKit Swift SDK 固定为 2.16.0，并添加到 MallApp 和 UiAcceptanceBroadcaster 两个 target。
   此次没有改 Podfile，不需要为 LiveKit 执行 pod install。
2. 重新编译并安装 iOS App；仅刷新 Metro/热更新不能安装原生模块或更新扩展。
3. 保留两个 target 的现有签名、App Group `group.com.ehaier.mall.screenmirror`。
   主 App 与扩展均设置 `RTCAppGroupIdentifier`；主 App 设置 `RTCScreenSharingExtension`。
4. 在 Mac 选择 iPhone 能访问的网卡（通常为 Wi-Fi 的 en0），点击“开始”。
5. 在 iPhone 的投屏调试页输入 Mac 显示的 `http://IP:23456` 和 12 位配对码，
   点击“连接并共享屏幕”，允许本地网络访问，并在系统弹窗中开始广播。
6. 切换到商城其他页面仍保留共享。停止时使用 iPhone“停止共享 / 重置连接”，
   或系统停止广播；Mac 的“停止”同时关闭本地服务。

不能再仅从控制中心开启扩展：必须先让主 App 加入房间。官方链路为：

```text
ReplayKit → LKSampleHandler → App Group 本地 IPC → 主 App LiveKit SDK
→ Mac LiveKit Server → Electron LiveKit JS → video
```

当前仅共享屏幕，不发布麦克风和应用声音，不支持 iPhone 反向控制。
主 App 配置 audio 后台能力以符合 WebRTC 场景，但不启用录音；切到其他 App 后的长时间
共享仍须单独真机验收，不能把后台能力声明视为运行成功的证明。

## 网络与安全边界

仅用于可信局域网。配对通过 HTTP、信令通过 WS；媒体使用 WebRTC 加密，但配对令牌
没有 TLS 保护，不可用于公共 Wi-Fi 或直接开放到公网。

每次开始创建随机房间、随机服务密钥及随机 12 位十六进制配对码。密钥仅保存在
权限为 0600 的临时配置中，停止后删除；不写入源码、不传给 iPhone。
令牌有效期 10 分钟（已建立的连接不因此在 10 分钟自动中断）；Mac 仅允许订阅，
iPhone 仅允许发布 screen_share，房间最多两人。配对错误 20 次锁定，需 Mac 重新开始。

允许 Mac 防火墙中的以下端口，仅在使用时开放到所选网卡：

| 端口 | 用途 |
| --- | --- |
| 23456/TCP | 配对令牌接口，不再是 H.264 接收端口 |
| 7880/TCP | LiveKit 信令 |
| 7881/TCP | WebRTC TCP 回退 |
| 7882/UDP | WebRTC 媒体 |

IP 变化、切换 Wi-Fi 后应在 Mac 停止并重新开始，重新填写地址和配对码。

## 验证与排障

```bash
npm run verify:livekit
npm run verify:iphone
npm run pack
npm run verify:packaged
```

该命令启动真实 LiveKit 服务与两个隐藏 Electron 窗口，用生成的绿色画布视频发布
screen_share，并检查接收端实际解码像素、显示状态、错误配对拒绝和服务重启。
不读取摄像头或麦克风，也不代替 iPhone 真机验证。
`verify:packaged` 使用打包产物中的 SDK、页面和服务程序重复验证，避免只在开发环境工作。

状态分别区分房间连接、配对、轨道订阅和视频首帧。已订阅但 15 秒无首帧时检查媒体端口。
iPhone 连接时页面顶部每秒刷新原生进度，依次为 1/3 配对、2/3 房间连接、3/3 广播弹窗；
30 秒未完成会取消请求并显示错误，连接过程中也可以点击取消。地址历史保存不再阻塞连接。
若停在“正在调用 iOS 投屏模块”，检查是否重新编译安装了原生模块；若停在 1/3，
检查本地网络权限及 23456 端口；若停在 2/3，检查 7880 端口。只有 3/3 之后才需要检查广播弹窗。
iPhone 主 App 的原生连接日志在 Console 中过滤 `ScreenMirror`，不记录配对码或令牌。
iPhone 端用 Console 选择设备，过滤 `LKSampleHandler` 查看官方扩展日志。

真机验收清单：首次允许局域网访问、首帧、连续 10 分钟、横竖屏、启停 5 次、
广播弹窗取消后重试、断网重连、切到其他 App、Mac 退出清理、Android 切换回归。

### Broadcast 画质与延迟配置

iOS 保留 Broadcast，采集尺寸仍使用 SDK 的 `.h1080_169`（按比例适配，最长边目标
1920，不代表竖屏宽度为 1080），采集和发布编码均设置 30fps。发布显式使用
8Mbps 码率上限、首选 H.264、关闭 simulcast，适合一台手机到一台 Mac 的验收场景。
该上限不是固定码率；静止画面低帧率、低码率不一定异常。拥塞时优先保分辨率，可能降低
帧率；不要以牺牲持续滚动流畅度为代价盲目提高分辨率或码率。

Mac 关闭按视频窗口尺寸降级的 adaptiveStream，请求最高订阅层，并通过 SDK 请求
零额外播放缓冲（浏览器可能不支持，不代表零延迟）。窗口关闭后台节流，代价是后台耗电增加。
状态下方每秒显示实际接收尺寸、编码、解码帧率、接收码率、区间丢包/丢帧，以及每帧平均
缓冲和解码时间；计数器重置或字段缺失显示待采样/破折号，而不是伪造零值。
传输协议仅为 **Mac ↔ 本地 LiveKit** 这一段，不能据此断言 iPhone 上行走 UDP；
缓冲和解码时间也不是端到端延迟。诊断不包含屏幕内容、令牌或配对码。

### 分段诊断指标

iOS 使用 SDK 的轨道统计，每两秒通过 `screen-mirror.metrics.v1` 数据 topic 发送一次
小于等于 1200 字节的 lossy JSON，不积压历史统计，不发送截图、文本、IP、令牌或配对码。
Mac 仅接受房间中 `iphone-publisher` 的该 topic，并忽略坏包、过大的包和旧的乱序采样。
只有发布者增加 `canPublishData` 权限，屏幕视频发布权限和 Mac 只订阅权限不变。
超过 6 秒未更新的指标标为过期；首次采样、缺失字段、计数器重置均显示 `—`，不伪造零。

- **iOS 输入（IPC 后）**：WebRTC media-source 帧率；不是 ReplayKit 原始回调帧率。
- **编码/发送 fps、发送码率**：iOS outbound-rtp 计数器差分，使用统计自身时间戳。
- **编码 ms/帧**：区间总编码时间 / 编码帧数；**发包等待 ms/包**：区间累计发包等待 / 发包数。
- **限制原因**：SDK 的 `none/cpu/bandwidth/other`；缺失显示未知。
- **iPhone 上行协议、RTT、可用带宽估计**：仅使用 iOS 已选中的 ICE candidate pair，
  不使用 Mac 本地连接的 UDP 结果代替；可用带宽是 WebRTC 估计值，不是网络测速结果。
- **Mac 缓冲实际/目标/最小**：各累计 delay 的区间差值 / 区间 emitted count。
- **播放提示回读**：区分浏览器不支持、未设置以及当前属性值。回读 0ms 不代表实际零缓冲；
  `jitterBufferTarget` 只读取，不为了诊断改变播放策略。

限制：LiveKit Swift 2.16.0 的 `LKSampleHandler.processSampleBuffer` 不是 `open`，
不能从 App 的 Swift 扩展子类覆写。为避免修改依赖、运行时 hook 或替换正常工作的广播实现，
本版明确显示「Broadcast 原始入口：SDK 未开放统计」。原始入口 fps、JPEG 耗时、IPC 忙时
跳帧数仍不可见；不能用 IPC 后输入 fps 冒充它们。精确拆解这段需要 SDK 提供观测接口或维护 fork。

**更新两端后必须停止旧会话、重启 Mac 服务并重新配对**，旧 token 不包含诊断数据权限。
重新编译安装 iOS，Mac 打包版需重新打包。持续滚动时比较：IPC 后输入、编码、发送、接收 fps，
再结合限制原因和缓冲目标定位。诊断面板可滚动，不会无限挤占投屏画面。

修改后重新编译安装 iOS App，重启 Electron（使用打包版则重新打包）。在同一网络下
比较静止小字、连续滚动 30 秒、横竖屏和持续 10 分钟的表现；记录接收分辨率、滚动时
fps/码率、丢帧及缓冲变化。端到端延迟需用外部相机同时拍摄手机和 Mac 上的同一画面变化测量。

旧 `iphoneReceiver.js`、`src/iphoneReceiver.js` 以及
`ios/MallApp/UiAcceptanceBroadcaster/SampleHandler.swift` 是历史实现，未接入新链路，
暂时保留以免丢失已有未提交改动。真正编译的扩展是 `ios/UiAcceptanceBroadcaster/SampleHandler.swift`。
`screen-mirror-mac/Sources` 中的旧 Swift Mac 工具也不属于此 Electron 入口。

## 打包

先执行 `npm run setup:livekit` 和验证，再运行 `npm run pack` 或 `npm run dist`。
electron-builder 会将资源复制到 App 的 Resources，运行时不依赖目标电脑的 Homebrew。
正式分发前还需配置 Developer ID 签名、公证，并在目标架构验证嵌套可执行文件的签名。

## 官方参考

- https://github.com/livekit/client-sdk-swift/blob/2.16.0/Docs/ios-screen-sharing.md
- https://docs.livekit.io/transport/self-hosting/local/
- https://github.com/livekit/livekit/blob/v1.13.6/config-sample.yaml
