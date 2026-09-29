/**
 * `RCTInvalidating` 的最小桩，见 `RCTBridgeModule.h` 顶部的说明。
 *
 * 真身只是「模块被桥销毁时回调一次」的协议；我们确实实现了 `-invalidate`，
 * 所以这里也必须声明它 —— 否则检查会漏掉「签名写错、根本没对上协议」这种错。
 */
#import <Foundation/Foundation.h>

@protocol RCTInvalidating <NSObject>
- (void)invalidate;
@end
