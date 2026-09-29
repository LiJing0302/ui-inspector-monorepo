#!/usr/bin/env bash
#
# 不依赖 Xcode 工程 / pod install 的 iOS 源码检查。
#
# 为什么需要它：与安卓侧同一个处境 —— 这个包是库模块，仓库里没有 Podfile、没有 Pods/，
# 不能被单独构建，只能被宿主 App（MallApp）通过 pod install 编进去。改完一行 .m 想确认
# 没写错，通常要么等宿主全量构建，要么肉眼 review；安卓侧已经用 compile-check.sh 把那条路
# 缩短到 3 秒，iOS 侧此前一直是空白。
#
# 做法：直接用本机 iPhoneOS SDK 对 `ios/*.m` 跑 `clang -fsyntax-only`，
# RN 的桥接头用 scripts/ios-stubs/React/ 里的**最小桩**代替（理由见那个文件顶部）。
#
# 它能抓住：语法错、ARC 下的内存管理错、属性/方法签名不匹配、格式串
# （`%@` / `%d`）与参数类型不符、协议没实现、Foundation/UIKit 接口用错。
# 它抓不住：RN 宏用法是否正确、与宿主实际依赖版本的兼容性 —— 那些只能靠宿主构建。
#
# 用法：
#   scripts/ios-compile-check.sh
#
# 环境变量（都有默认值，通常不用设）：
#   IOS_SDK   iPhoneOS SDK 名，默认 iphoneos（走 xcrun）
#   EXTRA_FLAGS  追加给 clang 的额外参数

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"
STUB_DIR="$REPO_ROOT/scripts/ios-stubs"

if [ ! -d "$IOS_DIR" ]; then
  echo "找不到源码目录：$IOS_DIR" >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "找不到 xcrun：这台机器上没有可用的 Xcode 命令行工具，跳过 iOS 检查。" >&2
  exit 1
fi

SDK_NAME="${IOS_SDK:-iphoneos}"
if ! SDK_PATH="$(xcrun --sdk "$SDK_NAME" --show-sdk-path 2>/dev/null)"; then
  echo "取不到 $SDK_NAME 的 SDK 路径（Xcode 未安装或未选择？）。" >&2
  exit 1
fi

SOURCES=()
while IFS= read -r file; do
  SOURCES+=("$file")
done < <(find "$IOS_DIR" -maxdepth 1 -name '*.m' | sort)

if [ ${#SOURCES[@]} -eq 0 ]; then
  echo "ios/ 下没有 .m 文件。" >&2
  exit 1
fi

echo "iOS 检查：SDK=$(basename "$SDK_PATH") · ${#SOURCES[@]} 个源文件 · 桩头文件 $STUB_DIR"

# -fobjc-arc 与 podspec 的 s.requires_arc = true 一致；缺了它，ARC 下的
# 内存管理错误（如漏 __weak、错用 __block）根本不会报出来。
xcrun --sdk "$SDK_NAME" clang \
  -fsyntax-only \
  -fobjc-arc \
  -x objective-c \
  -isysroot "$SDK_PATH" \
  -I "$STUB_DIR" \
  -Wno-nullability-completeness \
  ${EXTRA_FLAGS:-} \
  "${SOURCES[@]}"

echo "iOS 检查通过。"
