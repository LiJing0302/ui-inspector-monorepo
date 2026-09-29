#!/usr/bin/env bash
#
# CollectPolicy / CollectOptions / IntRect 的单元测试（纯 JVM，3 秒）。
#
# 为什么能这么快：这两个类刻意不依赖 Android / RN，所以不必等宿主 App 构建、
# 也不必连设备。采集策略里最贵的那几个判定（算不算缺失 / 要不要脱敏 / 是否剪枝）
# 全在这两个类里，改完立刻就能验。
#
# 用法：
#   scripts/test-collect-policy.sh
#
# 为什么不用 gradle：这个仓库是库模块，没有 gradlew、没有 settings.gradle，
# 只能被宿主 App 构建，`gradle test` 在这里跑不起来。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/android/src/main/java/com/reactnative/uiacceptance"
TEST_DIR="$REPO_ROOT/android/src/test/java/com/reactnative/uiacceptance"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/out"

javac -nowarn -d "$WORK/out" \
  "$PKG_DIR/CollectPolicy.java" \
  "$PKG_DIR/CollectOptions.java" \
  "$PKG_DIR/IntRect.java" \
  "$TEST_DIR/CollectPolicyTest.java"

java -cp "$WORK/out" com.reactnative.uiacceptance.CollectPolicyTest
