/**
 * RN 桥接头文件的**最小桩**，只服务于 `scripts/ios-compile-check.sh`。
 *
 * 为什么用桩而不是真的 RN 头文件：真的那套位于 `node_modules/react-native/React/` 下，
 * 但 CocoaPods 会把它们**拍平**到 `React/` 下（物理路径是 `React/Base/RCTBridgeModule.h`，
 * 而代码里写的是 `<React/RCTBridgeModule.h>`）—— 想在仓库里复刻那套头文件映射，
 * 要么造一整个 Pods/Headers 目录树，要么把几百个头文件符号链接一遍；而
 * `RCTBridge.h` 会继续牵扯 Image/Network 等模块，链式膨胀到把 RN 半个库拖进来。
 *
 * 本脚本要回答的问题只有一个：**「我这次改的 .m 文件本身写没写错」**（语法、ARC、
 * 属性与方法的类型、格式串、纯 Foundation/UIKit 调用）。所以这里只声明本文件真正用到的
 * 那几个宏与类型 —— 正因为它们极少变，桩的维护成本接近零。
 *
 * ⚠️ 这个检查**不覆盖**「RN 的宏用法是否正确」也不跑 pod install；它与安卓侧的
 * `compile-check.sh`（用真的 android.jar + react-android aar 做 javac）在强度上不是一个级别。
 */
#import <Foundation/Foundation.h>

/// 真实实现会注册模块并生成 `+moduleName`；这里只要能让 `@implementation` 通过即可。
#define RCT_EXPORT_MODULE(...) \
  + (NSString *)moduleName { return @"stub"; }

/// 用法形如 `RCT_REMAP_METHOD(start, start:(NSDictionary *)d resolver:(...)resolve rejecter:(...)reject)`
/// —— 展开后就是那条方法本身。
#define RCT_REMAP_METHOD(js_name, method) - (void)method

#define RCT_EXPORT_METHOD(method) - (void)method

typedef void (^RCTPromiseResolveBlock)(id result);
typedef void (^RCTPromiseRejectBlock)(NSString *code, NSString *message, NSError *error);

@protocol RCTBridgeModule <NSObject>
@optional
+ (BOOL)requiresMainQueueSetup;
@end
