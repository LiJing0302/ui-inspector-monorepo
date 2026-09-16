#!/usr/bin/env bash
#
# 不依赖 Android 工程 / gradle 的 Java 编译检查。
#
# 为什么需要它：这个包是「库模块」，仓库里没有 gradlew、没有 settings.gradle，
# 只能被宿主 App（MallApp）通过 gradle 编译。改完一行 Java 想确认没写错，通常
# 要么等宿主工程全量构建，要么就得肉眼 review —— 这个脚本把那条路缩短到 3 秒。
#
# 做法：直接用本机 Android SDK 的 android.jar + gradle 缓存里的 react-android aar
# 拼出 classpath，javac 整个 src/main/java。只做**编译**，不跑测试、不产出 aar。
#
# 用法：
#   scripts/compile-check.sh
#
# 环境变量（都有默认值，通常不用设）：
#   ANDROID_JAR   android.jar 路径，默认取平台里最高的一个
#   GRADLE_CACHE  gradle 模块缓存，默认 ~/.gradle/caches/modules-2/files-2.1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/android/src/main/java"
GRADLE_CACHE="${GRADLE_CACHE:-$HOME/.gradle/caches/modules-2/files-2.1}"
SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}"

if [ ! -d "$SRC_DIR" ]; then
  echo "找不到源码目录：$SRC_DIR" >&2
  exit 1
fi

# ---- android.jar：优先用 $ANDROID_JAR，否则挑 platforms 下版本最高的 ----
ANDROID_JAR="${ANDROID_JAR:-}"
if [ -z "$ANDROID_JAR" ]; then
  for candidate in $(ls -d "$SDK_ROOT"/platforms/android-* 2>/dev/null | sort -V -r); do
    if [ -f "$candidate/android.jar" ]; then
      ANDROID_JAR="$candidate/android.jar"
      break
    fi
  done
fi
if [ ! -f "$ANDROID_JAR" ]; then
  echo "找不到 android.jar。设 ANDROID_JAR，或安装 Android SDK platform。" >&2
  exit 1
fi

# ---- react-android aar：取版本号最高的 release 包 ----
REACT_AAR=""
for candidate in $(ls -d "$GRADLE_CACHE"/com.facebook.react/react-android/*/*/ 2>/dev/null | sort -V -r); do
  for aar in "$candidate"react-android-*-release.aar; do
    if [ -f "$aar" ]; then
      REACT_AAR="$aar"
      break 2
    fi
  done
done
if [ -z "$REACT_AAR" ]; then
  echo "找不到 react-android 的 release aar（应在 $GRADLE_CACHE/com.facebook.react/react-android/）。" >&2
  echo "先在宿主 App 里跑一次 gradle 构建把依赖下下来，或手工指定。" >&2
  exit 1
fi

# ---- androidx.annotation：@NonNull / @Nullable ----
ANNOTATION_JAR=""
for candidate in $(ls -d "$GRADLE_CACHE"/androidx.annotation/annotation-jvm/*/*/ 2>/dev/null | sort -V -r); do
  for jar in "$candidate"annotation-jvm-*.jar; do
    if [ -f "$jar" ]; then
      ANNOTATION_JAR="$jar"
      break 2
    fi
  done
done
if [ -z "$ANNOTATION_JAR" ]; then
  echo "找不到 androidx annotation-jvm jar。" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# aar 里的 classes.jar 才是真正要编译时的依赖
unzip -oq "$REACT_AAR" classes.jar -d "$WORK/rn"

# shellcheck disable=SC2046
javac -nowarn -d "$WORK/out" \
  -cp "$WORK/rn/classes.jar:$ANNOTATION_JAR:$ANDROID_JAR" \
  $(find "$SRC_DIR" -name '*.java')

echo "compile-check OK"
echo "  android.jar : $ANDROID_JAR"
echo "  react       : $(basename "$REACT_AAR")"
echo "  annotation  : $(basename "$ANNOTATION_JAR")"
