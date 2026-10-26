#import "UiAcceptanceModule.h"

#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <sys/utsname.h>

typedef struct {
  BOOL showOverlay;
  BOOL showLabels;
  BOOL includeInvisible;
  BOOL includeZeroSize;
  BOOL includeText;
  NSInteger maxDepth;
  NSInteger maxNodes;
  NSTimeInterval refreshInterval;
} HMUiAcceptanceOptions;

@interface HMUiAcceptanceOverlayView : UIView
@property(nonatomic, copy) NSArray<NSDictionary *> *nodes;
@property(nonatomic, assign) BOOL showLabels;
@end

/**
 * 一次遍历的统计量，只服务于 `snapshot.collection` 的如实上报。
 *
 * 三个字段的口径与 Android 的 `NodeCollector.CollectStats` 逐字对齐：
 * `actualDepth` 是**所见最深节点的 depth（根为 0）**，不是节点层数 ——
 * 两边对同一棵树报出不同的数字，会让 Mac 侧那些「采集是否被截断」的结论无从对账。
 */
@interface HMCollectStats : NSObject
@property(nonatomic, assign) NSInteger actualDepth;
@property(nonatomic, assign) BOOL depthLimitReached;
@property(nonatomic, assign) BOOL nodeLimitReached;
@end

@implementation HMCollectStats
@end

@interface UiAcceptanceModule ()
@property(nonatomic, strong) HMUiAcceptanceOverlayView *overlayView;
@property(nonatomic, strong) NSTimer *refreshTimer;
@property(nonatomic, assign) HMUiAcceptanceOptions options;
@end

static NSInteger HMClampInteger(NSInteger value, NSInteger minValue, NSInteger maxValue) {
  return MAX(minValue, MIN(maxValue, value));
}

static NSTimeInterval HMClampInterval(NSTimeInterval value, NSTimeInterval minValue, NSTimeInterval maxValue) {
  return MAX(minValue, MIN(maxValue, value));
}

static BOOL HMViewIsEffectivelyVisible(UIView *view, UIWindow *window) {
  if (view != window && view.window != window) {
    return NO;
  }
  for (UIView *current = view; current != nil; current = current.superview) {
    if (current.hidden || current.alpha <= 0.001) {
      return NO;
    }
    if (current == window) {
      break;
    }
  }
  return YES;
}

/**
 * 沿祖先裁剪链求交后的**有效可见矩形**：自身矩形 ∩ 祖先给的裁剪窗口。
 *
 * 与安卓 `CollectPolicy.effectiveVisibleRect` 逐条一致。为什么不能只靠平台字段：
 * `convertRect:toView:` 报的是**布局**矩形，对 `clipsToBounds` 造成的绘制期裁剪完全无感
 * （会算出「子节点比父节点更可见」这种几何上不可能的结果）。这条链只能自己走。
 *
 * 返回值可能为空 —— 空即「屏幕上没有它的任何像素」，由 `HMIsClippedOut` 给出结论。
 */
static CGRect HMEffectiveVisibleRect(CGRect own, CGRect clipWindow) {
  return CGRectIntersection(own, clipWindow);
}

/**
 * 传给**子节点**的裁剪窗口。
 *
 * 自身开了裁剪就收紧成自己的有效矩形，没开就原样继承 —— 子节点合法地溢出父节点是真实存在的
 * 布局（气泡、角标、绝对定位的浮层、动画起始态），一律按父盒裁剪会把它们整批判成
 * 「屏幕上没有像素」的假阴性。
 *
 * ⚠️ 判据只看 `clipsToBounds`，必须与 JS 侧 `getUiAcceptanceVisibleRect`（浮层与点选用它）
 * 保持一致：同一份快照在两个进程里算出不同答案，症状只会是「画布上框了一个、点选又选不到」。
 */
static CGRect HMClipWindowForChildren(BOOL clipsToBounds, CGRect ownEffective, CGRect clipWindow) {
  return clipsToBounds ? ownEffective : clipWindow;
}

/**
 * 有效矩形比自身矩形小（含被裁没）：这个节点「有一部分像素被祖先剪掉了」。
 *
 * 与平台可见矩形不是一回事（那个对绘制期裁剪恒为「没被裁」）。自身没有面积时返回 NO ——
 * 零尺寸是另一件事，不该混进裁剪结论。
 *
 * 容差取 0.01pt：两端都用 CGFloat，求交会引入浮点毛刺，不加容差会让「刚好贴着父盒」的节点
 * 被报成被裁剪（实测里这类节点很多，全是 1e-9 量级的差）。
 */
static BOOL HMIsClippedByAncestor(CGRect own, CGRect effective) {
  if (CGRectIsEmpty(own)) {
    return NO;
  }
  const CGFloat epsilon = 0.01;
  return CGRectGetMinX(effective) > CGRectGetMinX(own) + epsilon ||
         CGRectGetMinY(effective) > CGRectGetMinY(own) + epsilon ||
         CGRectGetMaxX(effective) < CGRectGetMaxX(own) - epsilon ||
         CGRectGetMaxY(effective) < CGRectGetMaxY(own) - epsilon;
}

/** 自身有面积、有效矩形却没有面积：屏幕上没有它的**任何**像素。 */
static BOOL HMIsClippedOut(CGRect own, CGRect effective) {
  return !CGRectIsEmpty(own) && CGRectIsEmpty(effective);
}

static BOOL HMViewIsSvg(UIView *view) {
  return [NSStringFromClass(view.class) hasSuffix:@"RNSVGSvgView"];
}

static BOOL HMViewIsImage(UIView *view) {
  return [view isKindOfClass:UIImageView.class];
}

static BOOL HMViewIsGradient(UIView *view) {
  NSString *className = NSStringFromClass(view.class);
  return [className isEqualToString:@"BVLinearGradient"] ||
         [className hasSuffix:@"BVLinearGradient"];
}

static BOOL HMLayerHasVisualContent(CALayer *layer) {
  if (layer.hidden || layer.opacity <= 0.001) {
    return NO;
  }
  if (layer.backgroundColor != nil && CGColorGetAlpha(layer.backgroundColor) > 0.001) {
    return YES;
  }
  if (layer.borderWidth > 0.001 && layer.borderColor != nil &&
      CGColorGetAlpha(layer.borderColor) > 0.001) {
    return YES;
  }
  if (layer.contents != nil) {
    return YES;
  }

  for (CALayer *sublayer in layer.sublayers) {
    // A UIView's layer is also attached as a sublayer. Its visual content belongs
    // to that child node and must not make the parent node drawable.
    id delegate = sublayer.delegate;
    if ([delegate isKindOfClass:UIView.class]) {
      continue;
    }
    if (HMLayerHasVisualContent(sublayer)) {
      return YES;
    }
  }
  return NO;
}

/**
 * 取一个 view **自身**显示的文本，取不到返回 nil。
 *
 * ⚠️ 只认 `UILabel` / `UITextView` / `UITextField` 是不够的。React Native 新架构（Fabric）
 * 的文本是 `RCTParagraphComponentView`（公开类，带只读属性 `attributedText`）里套一个
 * 私有的 `RCTParagraphTextView`（`@interface RCTParagraphTextView : UIView`，**不是** UILabel）
 * —— 于是两端都躲过了 isKindOfClass 判定。
 *
 * 2026-09-24 实测的代价：iOS 快照 959 个节点里只有 3 个取到文本（全是系统「下拉刷新」
 * 那个 UILabel），143 个文本节点全空。后果有两个，都不是「少了个字段」那么轻：
 *   · 画布上文本节点的名字退化成类名（`RCTParagraphTextView`），用户看到的就是「节点名全是类名」；
 *   · 匹配引擎的 L2 文本锚点对 iOS 完全失效 —— 而文本是最强的那类匹配证据。
 *
 * 所以这里按鸭子类型取：`attributedText` 优先（`RCTParagraphComponentView` 与 `UITextView`
 * 都有），其次 `text`。两者都用 `respondsToSelector:` 守卫，避免 KVC 对不存在的 key
 * 抛 `NSUnknownKeyException`（那个异常在采集路径上会直接把整次上传打断）。
 */
/**
 * 取一个视图的 `NSAttributedString` 文本。
 *
 * RN Fabric 的 `RCTParagraphComponentView` 把真正画字的活交给内部私有子视图
 * `RCTParagraphTextView`（只暴露 `state` / `paragraphAttributes`，没有 `attributedText` 属性）。
 * SDK 会把这层内部子视图也遍历成独立节点，于是选到内层视图时文本整段为空、字体属性也读不到。
 * 这里在**自身**不暴露文本时，向上沿 `superview` 链找一层 `attributedText`
 * （`_textView` 经 `contentView` 挂到 `RCTParagraphComponentView` 的 `currentContainerView` 下，
 * 链长恰好 2：`RCTParagraphTextView` → `currentContainerView` → `RCTParagraphComponentView`）。
 *
 * 只认 `attributedText`（这是文本组件专属属性，普通容器不会响应），所以不会把无关容器
 * 误判成有文本；命中后立刻返回，不会继续往上污染更高层的容器。
 */
static NSAttributedString *HMAttributedTextOfView(UIView *view) {
  UIView *candidate = view;
  for (NSInteger level = 0; level < 4 && candidate != nil; level++) {
    if ([candidate respondsToSelector:NSSelectorFromString(@"attributedText")]) {
      id value = [candidate valueForKey:@"attributedText"];
      if ([value isKindOfClass:NSAttributedString.class]) {
        return (NSAttributedString *)value;
      }
    }
    candidate = candidate.superview;
  }
  return nil;
}

static NSString *HMTextOfView(UIView *view) {
  if ([view isKindOfClass:UILabel.class]) {
    return ((UILabel *)view).text;
  }
  if ([view isKindOfClass:UITextView.class]) {
    return ((UITextView *)view).text;
  }
  if ([view isKindOfClass:UITextField.class]) {
    return ((UITextField *)view).text;
  }
  NSAttributedString *attributed = HMAttributedTextOfView(view);
  if (attributed.length > 0) {
    return attributed.string;
  }
  if ([view respondsToSelector:NSSelectorFromString(@"text")]) {
    id text = [view valueForKey:@"text"];
    if ([text isKindOfClass:NSString.class]) {
      return (NSString *)text;
    }
  }
  return nil;
}

#pragma mark - 样式采集（背景色 / 字体）

/**
 * `UIColor` → `#rrggbb` / `#aarrggbb`，与安卓 `CollectPolicy.formatColor` 同一口径。
 *
 * 完全透明（alpha = 0）返回 nil：RN 里「颜色设成 transparent」与「根本没设颜色」在屏幕上
 * 没有区别，多给一行 `#00000000` 只会让人以为这里有背景色。
 *
 * 先按当前 trait 解析再取分量：动态色（浅/深色各一份）直接 `getRed:` 在部分色彩空间上会
 * 返回 NO，那时退回灰度通道；两条都失败才放弃 —— **不兜底成黑色**（「没读到」与「是黑色」
 * 在面板上是两个结论）。
 */
static NSString *HMFormatColor(UIColor *color) {
  if (color == nil) {
    return nil;
  }
  UIColor *resolved = color;
  if (@available(iOS 13.0, *)) {
    resolved = [color resolvedColorWithTraitCollection:UITraitCollection.currentTraitCollection];
  }
  CGFloat red = 0;
  CGFloat green = 0;
  CGFloat blue = 0;
  CGFloat alpha = 0;
  if (![resolved getRed:&red green:&green blue:&blue alpha:&alpha]) {
    CGFloat white = 0;
    if (![resolved getWhite:&white alpha:&alpha]) {
      return nil;
    }
    red = green = blue = white;
  }
  if (!(alpha > 0.0)) {
    return nil;
  }
  const int a = (int)lround(alpha * 255.0);
  const int r = (int)lround(red * 255.0);
  const int g = (int)lround(green * 255.0);
  const int b = (int)lround(blue * 255.0);
  return a == 255 ? [NSString stringWithFormat:@"#%02x%02x%02x", r, g, b]
                  : [NSString stringWithFormat:@"#%02x%02x%02x%02x", a, r, g, b];
}

/** 保留两位小数，与安卓 `CollectPolicy.round2` 同口径（浮点毛刺不该进面板）。 */
static double HMRound2(double value) {
  return round(value * 100.0) / 100.0;
}

/**
 * 系统字体缩放倍数 —— iOS 侧的 `scaledDensity`。
 *
 * ⚠️ **这是本次最容易写错的一处**。RN 在 iOS 上是
 * `effectiveFontSize = sizeMultiplier × size`（`RCTFontUtils.mm:308`），而那个 multiplier 直接
 * 来自 `AccessibilityManager`（`RCTAccessibilityManager.mm:238` `multiplierForContentSizeCategory:`
 * 查同一张表），也就是**用户的系统字体设置**：调到最大时字号会被乘 3.571 倍。直接上报
 * `UIFont.pointSize`，同一份设计稿在两台字体设置不同的手机上会显示出两个字号，验收同学
 * 看到的结论是「App 字号写错了」—— 与安卓不除 `scaledDensity` 是同一个病。
 *
 * 表逐字抄自 RN（`RCTAccessibilityManager.mm:256` `multipliers`），取值来源也与它同源
 * （`UIApplication.preferredContentSizeCategory`）。**不要改成 `UIFontMetrics`** ——
 * 那是 Dynamic Type，只对 `dynamicTypeRamp` 生效，与这里的默认路径不是同一条。
 *
 * 已知近似（与安卓同性质）：`allowFontScaling={false}` 的文本 RN 侧不乘这个倍数，这里照样
 * 除了，会偏小一个倍数。RN 没把 `allowFontScaling` 暴露到 View 上，要精确只能从 RN 侧一起改。
 * 另：宿主若调过 JS 的 `AccessibilityManager.setMultipliers` 覆盖了这张表，此处的值会对不上。
 */
static CGFloat HMSystemFontScale(void) {
  static NSDictionary<NSString *, NSNumber *> *multipliers = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    multipliers = @{
      UIContentSizeCategoryExtraSmall : @0.823,
      UIContentSizeCategorySmall : @0.882,
      UIContentSizeCategoryMedium : @0.941,
      UIContentSizeCategoryLarge : @1.0,
      UIContentSizeCategoryExtraLarge : @1.118,
      UIContentSizeCategoryExtraExtraLarge : @1.235,
      UIContentSizeCategoryExtraExtraExtraLarge : @1.353,
      UIContentSizeCategoryAccessibilityMedium : @1.786,
      UIContentSizeCategoryAccessibilityLarge : @2.143,
      UIContentSizeCategoryAccessibilityExtraLarge : @2.643,
      UIContentSizeCategoryAccessibilityExtraExtraLarge : @3.143,
      UIContentSizeCategoryAccessibilityExtraExtraExtraLarge : @3.571
    };
  });
  NSString *category = UIApplication.sharedApplication.preferredContentSizeCategory;
  NSNumber *value = category == nil ? nil : multipliers[category];
  return value == nil ? 1.0 : value.doubleValue;
}

/**
 * 从 `UIFont` 反解字重（100–900）。
 *
 * RN 的正向映射是一条 9 档表（`RCTAttributedTextUtils.mm:20` `RCTUIFontWeightFromInteger`：
 * 100→UltraLight … 900→Black），所以这里做**反向的就近匹配**，档位表与它逐个对齐 ——
 * 写死别的数值会让「设计稿 600」在上面显示成别的档，而且错得很安静。
 *
 * 已知近似：自定义字族里的非标准字重（如 350）会落到邻近档；字体被替换成系统字体时同理。
 * 这与安卓的 `fontWeightOf` 一样，是 View 上仅剩线索的代价。
 */
static NSInteger HMFontWeightOf(UIFont *font) {
  // 这张表只能声明在函数内：`UIFontWeightUltraLight` 这些是 `const UIFontWeight`（extern 变量），
  // 不是编译期常量，写成函数外的 static 数组会被 clang 判「initializer element is not a
  // compile-time constant」。自动存储期的聚合初始化可以在运行期逐项赋值，没问题。
  const CGFloat weights[] = {
    UIFontWeightUltraLight,
    UIFontWeightThin,
    UIFontWeightLight,
    UIFontWeightRegular,
    UIFontWeightMedium,
    UIFontWeightSemibold,
    UIFontWeightBold,
    UIFontWeightHeavy,
    UIFontWeightBlack,
  };
  const NSInteger values[] = {100, 200, 300, 400, 500, 600, 700, 800, 900};
  const size_t count = sizeof(weights) / sizeof(weights[0]);

  NSDictionary *traits = [font.fontDescriptor objectForKey:UIFontDescriptorTraitsAttribute];
  NSNumber *trait = [traits isKindOfClass:NSDictionary.class] ? traits[UIFontWeightTrait] : nil;
  CGFloat weight = [trait isKindOfClass:NSNumber.class] ? trait.doubleValue : UIFontWeightRegular;

  NSInteger closest = 400;
  CGFloat smallest = CGFLOAT_MAX;
  for (size_t index = 0; index < count; index++) {
    CGFloat delta = (CGFloat)fabs(weight - weights[index]);
    if (delta < smallest) {
      smallest = delta;
      closest = values[index];
    }
  }
  return closest;
}

/**
 * 一个节点的**文本样式**（字号 / 字重 / 字体 / 斜体 / 行高 / 字距 / 颜色）；不是文本节点返回 nil。
 *
 * 取值优先级刻意是 `attributedText` 优先：RN 把**原始值**挂在 `NSAttributedString` 的属性上
 * （`RCTAttributedTextUtils.mm`：`NSFontAttributeName` 171 / `NSForegroundColorAttributeName` 178 /
 * `NSKernAttributeName` 187 / `NSParagraphStyleAttributeName` 232），而 `UIFont` 上拿到的是
 * **解析后**的字体。`RCTParagraphComponentView`（Fabric 的 `<Text>`）与 `RCTTextInputComponentView`
 * 都有这个属性 —— 仍然走 `respondsToSelector:` 鸭子类型，**不 import RN 头文件**：
 * `scripts/ios-compile-check.sh` 只有两个桩头文件，引 RN 类型会让那个 3 秒脚本直接失效。
 *
 * `UILabel` 系直读只是为了兜住 RN 之外的库（以及 TextInput 的占位符），不是主路径。
 */
static NSDictionary *HMTextStyleOfView(UIView *view) {
  UIFont *font = nil;
  UIColor *color = nil;
  CGFloat kern = NAN;
  CGFloat lineHeight = NAN;

  NSAttributedString *attributed = HMAttributedTextOfView(view);
  if (attributed.length > 0) {
    NSDictionary<NSAttributedStringKey, id> *attributes = [attributed attributesAtIndex:0 effectiveRange:NULL];
    if ([attributes[NSFontAttributeName] isKindOfClass:UIFont.class]) {
      font = attributes[NSFontAttributeName];
    }
    if ([attributes[NSForegroundColorAttributeName] isKindOfClass:UIColor.class]) {
      color = attributes[NSForegroundColorAttributeName];
    }
    NSNumber *kernValue = attributes[NSKernAttributeName];
    if ([kernValue isKindOfClass:NSNumber.class]) {
      kern = kernValue.doubleValue;
    }
    NSParagraphStyle *paragraph = attributes[NSParagraphStyleAttributeName];
    if ([paragraph isKindOfClass:NSParagraphStyle.class] && paragraph.minimumLineHeight > 0) {
      lineHeight = paragraph.maximumLineHeight > 0 ? paragraph.maximumLineHeight : paragraph.minimumLineHeight;
    }
  }

  if (font == nil && [view isKindOfClass:UILabel.class]) {
    font = ((UILabel *)view).font;
    if (color == nil) {
      color = ((UILabel *)view).textColor;
    }
  }
  if (font == nil && [view isKindOfClass:UITextView.class]) {
    font = ((UITextView *)view).font;
    if (color == nil) {
      color = ((UITextView *)view).textColor;
    }
  }
  if (font == nil && [view isKindOfClass:UITextField.class]) {
    font = ((UITextField *)view).font;
    if (color == nil) {
      color = ((UITextField *)view).textColor;
    }
  }
  if (font == nil) {
    return nil;
  }

  CGFloat scale = HMSystemFontScale();
  if (!(scale > 0)) {
    scale = 1.0;
  }
  double fontSize = HMRound2(font.pointSize / scale);
  if (!(fontSize > 0)) {
    return nil;
  }

  NSMutableDictionary *style = [NSMutableDictionary dictionary];
  style[@"fontSize"] = @(fontSize);
  style[@"fontWeight"] = @(HMFontWeightOf(font));
  style[@"fontStyle"] =
    (font.fontDescriptor.symbolicTraits & UIFontDescriptorTraitItalic) != 0 ? @"italic" : @"normal";
  // RN 自己的默认字族就是 `[UIFont systemFontOfSize:].familyName`（`RCTFontUtils.mm:24`），
  // 所以直接报 familyName 与设计稿/RN 侧同名同源，不需要做「系统字体 → System」这类映射。
  if (font.familyName.length > 0) {
    style[@"fontFamily"] = font.familyName;
  }
  style[@"color"] = HMFormatColor(color) ?: (id)[NSNull null];
  // 行高乘过同一个倍数（`RCTAttributedTextUtils.mm:225`），要除；字距 **没有** 乘
  // （`:187` 直接写 `textAttributes.letterSpacing`），跟着除会凭空小一个倍数。
  style[@"lineHeight"] = isnan(lineHeight) ? (id)[NSNull null] : @(HMRound2(lineHeight / scale));
  style[@"letterSpacing"] = isnan(kern) ? (id)[NSNull null] : @(HMRound2(kern));
  return style;
}

/**
 * 一个节点的**盒样式**。iOS 这一版采得到**背景色 + 圆角**（圆角见下），返回对象里至少这两者之一。
 *
 * 为什么边框（描边）不在里面：RN 在 iOS 上把边框画成一张轮廓图贴在独立的 `_borderLayer` 上，
 * `layer.borderWidth` 被显式置 0（`RCTViewComponentView.mm:944`），而只有当「四边同类同色 +
 * solid + 四角等半径 + (宽=0 或 `clipsToBounds` 或边框透明)」时才走 `layer.borderWidth` 那条路
 * （判定在 `:885`）—— RN 默认 `overflow` 不是 hidden，所以**最需要看边框的节点恰好读不到**。
 *
 * **圆角能采到什么**：等半径 + 被裁剪的节点，`layer.cornerRadius` 是真实值（逻辑点，与 RN 的
 * dp 口径一致），配合 `layer.maskedCorners` 知道哪几角被圆，可还原成四角数组。而不等半径 /
 * `overflow` 非 hidden 的圆角，RN 会把它折进私有形状路径、把 `layer.cornerRadius` 置 0（边框那条
 * 路同机制），这一档 iOS 读不到 —— 与安卓 `ViewStyleReader` 的「四角各不同」相比是已知差距。
 * 输出键名 `topLeft / topRight / bottomRight / bottomLeft` 与安卓 `CORNER_KEYS` 完全一致，
 * Mac 侧归一化层与面板直接复用同一套折叠逻辑。
 *
 * ⚠️ **永远返回对象、永不返回 nil**，哪怕里面一个键都没有。这是为了让 Mac 侧能区分
 * 「采过了、确定没有背景色/圆角」与「这版没采样式」：发 nil 时两者混成一件事，面板会画三行「—」
 * 告诉验收同学「这个元素确定没有边框」—— 而事实是这版没读描边。
 */
static id HMGradientValue(UIView *view, NSString *key) {
  @try { return [view valueForKey:key]; } @catch (__unused NSException *exception) { return nil; }
}

static NSDictionary *HMPointDictionary(id value) {
  if ([value isKindOfClass:NSValue.class]) {
    CGPoint point = [value CGPointValue];
    return @{ @"x": @(point.x), @"y": @(point.y) };
  }
  if ([value isKindOfClass:NSDictionary.class]) {
    NSNumber *x = value[@"x"], *y = value[@"y"];
    if (x && y) return @{ @"x": x, @"y": y };
  }
  return nil;
}

static NSDictionary *HMGradientOfView(UIView *view) {
  if (!HMViewIsGradient(view)) return nil;
  NSArray *rawColors = HMGradientValue(view, @"colors");
  if (![rawColors isKindOfClass:NSArray.class] || rawColors.count < 2) return nil;
  NSMutableArray *colors = [NSMutableArray arrayWithCapacity:rawColors.count];
  for (id raw in rawColors) {
    NSString *color = nil;
    if ([raw isKindOfClass:UIColor.class]) {
      color = HMFormatColor(raw);
      if (!color && CGColorGetAlpha(((UIColor *)raw).CGColor) <= 0.001) color = @"#00000000";
    } else if ([raw isKindOfClass:NSString.class]) {
      color = raw;
    }
    if (!color) return nil;
    [colors addObject:color];
  }
  NSMutableDictionary *gradient = [@{ @"type": @"linear", @"colors": colors } mutableCopy];
  id locations = HMGradientValue(view, @"locations");
  if ([locations isKindOfClass:NSArray.class]) gradient[@"locations"] = locations;
  NSDictionary *start = HMPointDictionary(HMGradientValue(view, @"startPoint"));
  NSDictionary *end = HMPointDictionary(HMGradientValue(view, @"endPoint"));
  NSDictionary *center = HMPointDictionary(HMGradientValue(view, @"angleCenter"));
  if (start) gradient[@"startPoint"] = start;
  if (end) gradient[@"endPoint"] = end;
  if (center) gradient[@"angleCenter"] = center;
  id useAngle = HMGradientValue(view, @"useAngle");
  id angle = HMGradientValue(view, @"angle");
  if ([useAngle isKindOfClass:NSNumber.class]) gradient[@"useAngle"] = useAngle;
  if ([angle isKindOfClass:NSNumber.class]) gradient[@"angle"] = angle;
  return gradient;
}

static NSDictionary *HMBoxStyleOfView(UIView *view) {
  NSMutableDictionary *style = [NSMutableDictionary dictionary];
  NSString *backgroundColor = HMFormatColor(view.backgroundColor);
  if (backgroundColor.length > 0) {
    style[@"backgroundColor"] = backgroundColor;
  }
  // 圆角：只可靠拿到「等半径 + 被裁剪」这一档（见上方注释）。cornerRadius 是逻辑点，
  // 与 RN 的 dp 口径一致；maskedCorners 是 CACornerMask，告诉哪几角被圆。
  CGFloat radius = view.layer.cornerRadius;
  if (radius > 0.001) {
    CACornerMask masked = view.layer.maskedCorners;
    // `kCALayerAllCorners` 在部分 iOS SDK 头里不暴露（只有四个位标志常量可见），
    // 自己拼一个全角掩码来判断「四角都圆」。
    CACornerMask allMask = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner |
                           kCALayerMinXMaxYCorner | kCALayerMaxXMaxYCorner;
    BOOL allCorners = (masked == allMask) || (masked == 0);
    style[@"borderRadius"] = @{
      @"topLeft":     @((allCorners || (masked & kCALayerMinXMinYCorner)) ? radius : 0),
      @"topRight":    @((allCorners || (masked & kCALayerMaxXMinYCorner)) ? radius : 0),
      @"bottomRight": @((allCorners || (masked & kCALayerMaxXMaxYCorner)) ? radius : 0),
      @"bottomLeft":  @((allCorners || (masked & kCALayerMinXMaxYCorner)) ? radius : 0),
    };
  }
  NSDictionary *gradient = HMGradientOfView(view);
  if (gradient) style[@"gradient"] = gradient;
  return style;
}

static BOOL HMViewHasVisualContent(UIView *view) {
  if (view.hidden || view.alpha <= 0.001) {
    return NO;
  }

  // react-native-svg draws paths inside RNSVGSvgView rather than exposing them as ordinary
  // UIView instances with backgroundColor or layer.contents.
  if (HMViewIsSvg(view)) {
    return YES;
  }
  if (HMViewIsGradient(view)) {
    return YES;
  }

  if (view.backgroundColor != nil && CGColorGetAlpha(view.backgroundColor.CGColor) > 0.001) {
    return YES;
  }
  if (view.layer.borderWidth > 0.001 && view.layer.borderColor != nil &&
      CGColorGetAlpha(view.layer.borderColor) > 0.001) {
    return YES;
  }
  if ([view isKindOfClass:UIImageView.class]) {
    return ((UIImageView *)view).image != nil;
  }
  if ([view isKindOfClass:UITextField.class] && ((UITextField *)view).placeholder.length > 0) {
    return YES;
  }
  // 文本一律走 HMTextOfView：它同时兜住了 UILabel / UITextView / UITextField
  // 与 RN Fabric 的 `RCTParagraphComponentView`（后者不是 UILabel，见该函数注释）。
  NSString *ownText = HMTextOfView(view);
  if (ownText.length > 0) {
    // UILabel 的文字可能是透明的（当无障碍或占位用的空标签），那种不算画得出像素。
    if ([view isKindOfClass:UILabel.class]) {
      return CGColorGetAlpha(((UILabel *)view).textColor.CGColor) > 0.001;
    }
    return YES;
  }
  if (HMLayerHasVisualContent(view.layer)) {
    return YES;
  }

  // UIKit container views frequently report isOpaque == YES even when they do not
  // paint anything themselves. Treating that flag as content makes the entire RN
  // hierarchy look like nested opaque full-screen overlays.
  return NO;
}

static HMUiAcceptanceOptions HMOptionsFromDictionary(NSDictionary *dictionary) {
  HMUiAcceptanceOptions options = {
    .showOverlay = dictionary[@"showOverlay"] == nil ? YES : [dictionary[@"showOverlay"] boolValue],
    .showLabels = dictionary[@"showLabels"] == nil ? NO : [dictionary[@"showLabels"] boolValue],
    .includeInvisible = dictionary[@"includeInvisible"] == nil ? NO : [dictionary[@"includeInvisible"] boolValue],
    .includeZeroSize = dictionary[@"includeZeroSize"] == nil ? NO : [dictionary[@"includeZeroSize"] boolValue],
    .includeText = dictionary[@"includeText"] == nil ? NO : [dictionary[@"includeText"] boolValue],
    .maxDepth = HMClampInteger(dictionary[@"maxDepth"] == nil ? 64 : [dictionary[@"maxDepth"] integerValue], 0, 128),
    .maxNodes = HMClampInteger(dictionary[@"maxNodes"] == nil ? 10000 : [dictionary[@"maxNodes"] integerValue], 1, 30000),
    .refreshInterval = HMClampInterval(
      dictionary[@"refreshIntervalMs"] == nil ? 0.25 : [dictionary[@"refreshIntervalMs"] doubleValue] / 1000.0,
      0.1,
      2.0
    ),
  };
  return options;
}

/**
 * 机型标识（`iPhone15,3` 这种），前面补上「厂商」凑成与 Android 同形状的字符串。
 *
 * Android 那边上报的是 `Build.MANUFACTURER + " " + Build.MODEL`（如 `OPPO PGZ110`）。
 * 这里用 `uname` 取硬件标识而不是 `UIDevice.model`（后者只有 "iPhone"，五台设备报同一个值，
 * 需求里那堆截图就分不出是哪台机器跑的了）。
 */
static NSString *HMDeviceModel(void) {
  struct utsname info;
  if (uname(&info) != 0) {
    NSString *model = UIDevice.currentDevice.model;
    return model.length > 0 ? model : @"iOS";
  }
  return [NSString stringWithFormat:@"Apple %s", info.machine];
}

static NSString *HMAppBundleIdentifier(void) {
  NSString *identifier = NSBundle.mainBundle.bundleIdentifier;
  return identifier.length > 0 ? identifier : @"unknown.bundle";
}

/**
 * window 的屏幕倍数（pt → 像素）。
 *
 * 截图与节点几何都取自这一个函数：两处各自取一次 `screen.scale` 的话，
 * 一旦某处取到 nil 退回 1.0，就会出现「图是 3x、坐标是 1x」这种只差一个倍数、
 * 却要花很久才能看出根因的错位。
 */
static CGFloat HMWindowScale(UIWindow *window) {
  UIScreen *screen = window.screen ?: window.windowScene.screen;
  CGFloat scale = screen.scale;
  return scale > 0 ? scale : 1.0;
}

/**
 * 把整窗渲染成一张位图。
 *
 * 两个刻意之处：
 *
 * ① **画的是 window 自己的层级，不是整屏合成。** UIKit 没有「截整屏」的公开接口（那属于
 * ReplayKit），而 `drawViewHierarchyInRect:` 会跳过系统自绘的那层 —— 所以 iOS 截图上
 * 不会有状态栏。这是与 Android 的 `PixelCopy`（整屏）唯一的口径差异，已写进 README。
 * 对验收无害：节点树同样是 window 坐标系，底图和框来自同一个空间。
 *
 * ② **`afterScreenUpdates:NO`**：调用方在进来之前已经把调试浮层 `hidden = YES` 并 flush 过
 * 一次事务，此刻的层级树里浮层已经不存在了，直接按当前层级树渲染即可。
 * 若哪天实测发现浮层边框混进了截图（表现为底图上多出一圈彩色细线），
 * 把它改成 `YES` 即可 —— 代价是需要一次额外的合成等待。
 *
 * ⚠️ 必须在主线程调用（`drawViewHierarchyInRect:` 的硬性要求）。
 */
static UIImage * _Nullable HMRenderWindowImage(UIWindow *window) {
  CGRect bounds = window.bounds;
  if (CGRectGetWidth(bounds) <= 0 || CGRectGetHeight(bounds) <= 0) {
    return nil;
  }

  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  // 用屏幕自身的 scale，产出的图就是**物理像素**尺寸（如 393pt → 1179px），
  // 与 snapshot 里同样是像素口径的 windowWidth / 节点坐标同空间。
  format.scale = HMWindowScale(window);
  // 不设 opaque：窗口若有透明区域，透明比伪造一片黑色（或白色）更接近事实。
  format.opaque = NO;

  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithBounds:bounds format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    (void)context;
    [window drawViewHierarchyInRect:bounds afterScreenUpdates:NO];
  }];
}

static BOOL HMIsUsableWindow(UIWindow *window) {
  if (window == nil || window.hidden || window.alpha <= 0.001) {
    return NO;
  }
  if (CGRectGetWidth(window.bounds) <= 0 || CGRectGetHeight(window.bounds) <= 0) {
    return NO;
  }
  return window.rootViewController != nil;
}

static UIWindow * _Nullable HMWindowForScene(UIWindowScene *scene) {
  if (scene == nil) {
    return nil;
  }

  UIWindow *normalWindow = nil;
  UIWindow *fallbackWindow = nil;
  for (UIWindow *window in scene.windows.reverseObjectEnumerator) {
    if (!HMIsUsableWindow(window)) {
      continue;
    }
    if (fallbackWindow == nil) {
      fallbackWindow = window;
    }
    if (window.windowLevel == UIWindowLevelNormal) {
      if (window.isKeyWindow) {
        return window;
      }
      if (normalWindow == nil) {
        normalWindow = window;
      }
    }
  }
  return normalWindow ?: fallbackWindow;
}

static UIWindow * _Nullable HMCurrentWindow(void) {
  UIApplication *application = UIApplication.sharedApplication;
  if (@available(iOS 13.0, *)) {
    UIWindow *inactiveWindow = nil;
    for (UIScene *scene in application.connectedScenes) {
      if (![scene isKindOfClass:UIWindowScene.class]) {
        continue;
      }
      UIWindowScene *windowScene = (UIWindowScene *)scene;
      if (windowScene.activationState == UISceneActivationStateForegroundActive) {
        UIWindow *window = HMWindowForScene(windowScene);
        if (window != nil) {
          return window;
        }
      } else if (windowScene.activationState == UISceneActivationStateForegroundInactive &&
                 inactiveWindow == nil) {
        inactiveWindow = HMWindowForScene(windowScene);
      }
    }
    if (inactiveWindow != nil) {
      return inactiveWindow;
    }
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if (HMIsUsableWindow(application.keyWindow)) {
    return application.keyWindow;
  }
  for (UIWindow *window in application.windows.reverseObjectEnumerator) {
    if (HMIsUsableWindow(window)) {
      return window;
    }
  }
#pragma clang diagnostic pop
  return nil;
}

@implementation UiAcceptanceModule

RCT_EXPORT_MODULE(UiAcceptanceModule);

- (instancetype)init {
  self = [super init];
  if (self) {
    // capture() can be called directly from JS without start(). Keep the native
    // traversal limits valid even when no overlay has been started.
    self.options = HMOptionsFromDictionary(@{});
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

RCT_REMAP_METHOD(start,
                 start:(NSDictionary *)dictionary
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    self.options = HMOptionsFromDictionary(dictionary ?: @{});
    UIWindow *window = HMCurrentWindow();
    if (window == nil) {
      reject(@"UI_ACCEPTANCE_NO_WINDOW", @"No foreground UIWindow is available", nil);
      return;
    }

    [self.refreshTimer invalidate];
    self.refreshTimer = nil;
    [self.overlayView removeFromSuperview];
    self.overlayView = nil;

    if (self.options.showOverlay) {
      self.overlayView = [[HMUiAcceptanceOverlayView alloc] initWithFrame:window.bounds];
      self.overlayView.showLabels = self.options.showLabels;
      [window addSubview:self.overlayView];
      [self refreshOverlay];

      self.refreshTimer = [NSTimer timerWithTimeInterval:self.options.refreshInterval
                                                   target:self
                                                 selector:@selector(refreshOverlay)
                                                 userInfo:nil
                                                  repeats:YES];
      [[NSRunLoop mainRunLoop] addTimer:self.refreshTimer forMode:NSRunLoopCommonModes];
    }
    resolve(@YES);
  });
}

RCT_REMAP_METHOD(stop,
                 stopWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  (void)reject;
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.refreshTimer invalidate];
    self.refreshTimer = nil;
    [self.overlayView removeFromSuperview];
    self.overlayView = nil;
    resolve(@YES);
  });
}

RCT_REMAP_METHOD(capture,
                 capture:(NSDictionary *)dictionary
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = HMCurrentWindow();
    if (window == nil) {
      reject(@"UI_ACCEPTANCE_NO_WINDOW", @"No foreground UIWindow is available", nil);
      return;
    }
    NSString *profile = [self applyCaptureOptions:dictionary];
    // 浮层路径：`scale` 传 1.0，坐标与 windowWidth 都是 **pt** ——
    // 与 UiAcceptanceBoundsOverlay 的 `unit: 'pt'` 读数一致。见 nodesForWindow:scale:stats:。
    HMCollectStats *stats = [HMCollectStats new];
    NSArray<NSDictionary *> *nodes = [self nodesForWindow:window scale:1.0 stats:stats];
    resolve([self snapshotForWindow:window scale:1.0 nodes:nodes stats:stats profile:profile]);
  });
}

/**
 * 一次调用同时拿到**同一帧**的节点树与截图。这是「上传到 Mac」用的那一个。
 *
 * 与 `capture()` 的三处差别，都是刻意的：
 *
 * ① **几何是像素口径**（节点与 windowWidth/Height 都乘了屏幕 scale）。Android 的
 *    `getLocationInWindow` 报的也是物理像素，而 Mac 侧只有一条换算
 *    `logical = value × 160 / densityDpi`。若 iOS 报 pt，同一条换算会把它再除一次 scale，
 *    于是设计稿比对上整体小 3 倍 —— 那不是「差一点」，是每一页都错。
 * ② **带截图**。Mac 自 2026-09-24 起不再自己截屏，`screenshot` 是必填字段。
 * ③ **带 collection**。上传门禁要看采集档位与是否被上限截断，缺了它 Mac 一律拒收。
 *
 * 顺序与 Android 相同：藏浮层 → 采树 → 截图 → 恢复浮层。采树是同步的，先做；
 * 截图最贴近「用户按下上传的那一刻」。
 *
 * 为什么不像 Android 那样「先 capture() 再单独传一次截图」：两次 JS→原生往返之间隔着一次
 * React 渲染，页面翻页/弹窗都会让节点与底图错位，而错位在画布上看起来像「开发写歪了」。
 */
RCT_REMAP_METHOD(captureBundle,
                 captureBundle:(NSDictionary *)dictionary
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *window = HMCurrentWindow();
    if (window == nil) {
      reject(@"UI_ACCEPTANCE_NO_WINDOW", @"No foreground UIWindow is available", nil);
      return;
    }

    NSString *profile = [self applyCaptureOptions:dictionary];
    CGFloat scale = HMWindowScale(window);

    // SDK 自己的调试浮层必须从截图里消失：它画的是一圈节点边框，留在底图上就是一堆
    // 设计稿里不存在的线，会被验收直接判成差异。
    // ⚠️ 只能藏 SDK 自己那一层。调用方自己的悬浮 UI 属于 React 视图，原生不认识它，
    // 需要宿主在调用前自己藏（README 里那条「先 opacity: 0 再上传」）。
    BOOL overlayWasVisible = self.overlayView != nil && !self.overlayView.hidden;
    if (overlayWasVisible) {
      self.overlayView.hidden = YES;
      // 只改 hidden 还停在「待提交」的事务里，flush 一次之后这次渲染才会按
      // 「浮层不存在」来画。少这一次 flush，截图里就有机会带回浮层的边框。
      [CATransaction flush];
    }

    HMCollectStats *stats = [HMCollectStats new];
    NSArray<NSDictionary *> *nodes = [self nodesForWindow:window scale:scale stats:stats];
    UIImage *image = HMRenderWindowImage(window);

    if (overlayWasVisible) {
      self.overlayView.hidden = NO;
    }

    if (image == nil) {
      reject(@"UI_ACCEPTANCE_SCREENSHOT_FAILED", @"Window snapshot produced no image", nil);
      return;
    }
    NSData *png = UIImagePNGRepresentation(image);
    if (png.length == 0) {
      reject(@"UI_ACCEPTANCE_SCREENSHOT_ENCODE_FAILED", @"PNG encoding returned no data", nil);
      return;
    }

    CGFloat imageScale = image.scale > 0 ? image.scale : scale;
    resolve(@{
      @"snapshot": [self snapshotForWindow:window scale:scale nodes:nodes stats:stats profile:profile],
      @"screenshot": @{
        @"mimeType": @"image/png",
        @"width": @((NSInteger)lround(image.size.width * imageScale)),
        @"height": @((NSInteger)lround(image.size.height * imageScale)),
        // ⚠️ 不要加 NSDataBase64Encoding64CharacterLineLength：Mac 侧那条 base64 正则
        // `^[A-Za-z0-9+/]+={0,2}$` 不接受换行，带换行的串会被判成「含非法字符」直接拒收。
        @"base64": [png base64EncodedStringWithOptions:0],
      },
    });
  });
}

/**
 * `capture` / `captureBundle` 共用的档位解析，返回写进 `collection.profile` 的档位名。
 *
 * 默认**一定是验收全量档**：dictionary 为 nil、没有 profile、或显式写 `acceptance-full`
 * 都走全量。只有显式写了别的 profile 才退回轻量档 —— 并在 collection 里如实标成那个名字，
 * 让 Mac 侧的门禁能据此拒绝，而不是让一份缺字段的树被当成有效输入。
 *
 * 反面是「传了不含 profile 的 config 就静默退回轻量档」：不报错，只会让验收结果
 * 少几个节点、少一段文本，而调用方从返回值里看不出任何异常。
 */
- (NSString *)applyCaptureOptions:(NSDictionary *)dictionary {
  // 取出来先验类型再比对：JS 侧传个数字 / null 进来时，`[NSUInteger isEqualToString:]`
  // 是「无法识别的选择器」——直接崩掉宿主，而这只是为了判断档位。
  id rawProfile = dictionary[@"profile"];
  NSString *profile = [rawProfile isKindOfClass:NSString.class] ? (NSString *)rawProfile : nil;
  if (profile != nil && ![profile isEqualToString:@"acceptance-full"]) {
    // 轻量档：隐藏节点 / 零尺寸 / 文本都不收，上限也退到 Android 的 legacyDefaults
    // （maxDepth 64 / maxNodes 10000）。仍然允许调用方逐项覆盖。
    self.options = HMOptionsFromDictionary(dictionary ?: @{});
    return profile;
  }
  self.options = HMOptionsFromDictionary(@{
    @"includeInvisible": @YES,
    @"includeZeroSize": @YES,
    @"includeText": @YES,
    @"maxDepth": @128,
    @"maxNodes": @30000,
  });
  return @"acceptance-full";
}

- (void)dealloc {
  [self.refreshTimer invalidate];
}

- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.refreshTimer invalidate];
    self.refreshTimer = nil;
    [self.overlayView removeFromSuperview];
    self.overlayView = nil;
  });
}

- (void)refreshOverlay {
  UIWindow *window = HMCurrentWindow();
  if (window == nil || self.overlayView == nil) {
    return;
  }
  self.overlayView.frame = window.bounds;
  // scale 传 1.0：浮层在自己的坐标系里画（`drawRect:` 收到的就是 pt 空间的 rect）。
  self.overlayView.nodes = [self nodesForWindow:window scale:1.0 stats:[HMCollectStats new]];
}

- (NSDictionary *)snapshotForWindow:(UIWindow *)window
                              scale:(CGFloat)scale
                              nodes:(NSArray<NSDictionary *> *)nodes
                              stats:(HMCollectStats *)stats
                            profile:(NSString *)profile {
  CGFloat screenScale = HMWindowScale(window);
  return @{
    @"platform": @"ios",
    // 与 Android 逐字相同的来源名：Mac 侧只认这一个值判定「这份树是不是本 SDK 采的」，
    // 平台差异一律交给 platform 字段，不靠 source 分叉。
    // （旧版这里写的是 "ios-uiview-tree"，历史数据仍按原样读得出来，类型里也留着。）
    @"source": @"react-native-ui-acceptance",
    @"timestamp": @([[NSDate date] timeIntervalSince1970] * 1000.0),
    @"nodeCount": @(nodes.count),
    // 与 nodes 同口径：scale = 1 时是 pt，scale = 屏幕倍数时是像素。
    @"windowWidth": @(CGRectGetWidth(window.bounds) * scale),
    @"windowHeight": @(CGRectGetHeight(window.bounds) * scale),
    @"scale": @(screenScale),
    // ⚠️ density 一族描述的是「本机 pt→像素 的倍数」这个**设备事实**，两种口径下都照扫，
    // 但它只跟**像素口径**的坐标配对使用（captureBundle）。Mac 侧那条
    // `logical = px × 160 / densityDpi` 成立的前提正是「节点是像素」。
    // capture() 报的是 pt，与 density 不同口径 —— 浮层只用它自己的 rect，不做换算。
    @"density": @(screenScale),
    @"densityDpi": @(screenScale * 160.0),
    // iOS 不向本 SDK 暴露字体缩放因子（节点也不带 textStyle），
    // 因此不伪造一个没用上的乘数，scaledDensity 与 density 同值。
    @"scaledDensity": @(screenScale),
    // Android 这两个字段来自 Build / getPackageName；截图改由 SDK 自己上传之后，
    // 设备信息只能由采集方如实上报，否则需求里那堆截图分不出是哪台机器跑的。
    @"deviceModel": HMDeviceModel(),
    @"packageName": HMAppBundleIdentifier(),
    @"collection": [self collectionForNodes:nodes stats:stats profile:profile],
    @"nodes": nodes,
  };
}

/**
 * 采集质量信息。字段名与 Android 的 `snapshot.collection` 逐字一致 ——
 * Mac 侧的上传门禁按同一份判据读它（档位、是否被上限截断、节点数对账）。
 */
- (NSDictionary *)collectionForNodes:(NSArray<NSDictionary *> *)nodes
                               stats:(HMCollectStats *)stats
                             profile:(NSString *)profile {
  NSMutableArray<NSDictionary *> *excluded = [NSMutableArray array];
  if (self.overlayView != nil) {
    // 浮层被排除在采集之外（它画的是节点边框，不是 App 的 UI）。
    [excluded addObject:@{ @"reason": @"sdk-overlay", @"count": @1 }];
  }
  return @{
    @"profile": profile,
    @"requestedMaxDepth": @(self.options.maxDepth),
    @"requestedMaxNodes": @(self.options.maxNodes),
    @"actualDepth": @(stats.actualDepth),
    @"actualNodeCount": @(nodes.count),
    @"depthLimitReached": @(stats.depthLimitReached),
    @"nodeLimitReached": @(stats.nodeLimitReached),
    @"hiddenNodesIncluded": @(self.options.includeInvisible),
    @"zeroSizeNodesIncluded": @(self.options.includeZeroSize),
    @"textIncluded": @(self.options.includeText),
    @"excludedNodes": excluded,
  };
}

/**
 * 采一棵 flat 节点树。
 *
 * `scale` 决定几何的**口径**，两个消费者要的不是同一个空间：
 *  - 浮层路径（`capture` / `refreshOverlay`）传 1.0 → 坐标是 **pt**，与 UIKit 一致，
 *    浮层里的距离读数就是设计稿上的数字（单位标注也是 pt）。
 *  - 上传路径（`captureBundle`）传屏幕倍数 → 坐标是**像素**，与 Android 的
 *    `getLocationInWindow` 同口径，Mac 侧那条 `160 / densityDpi` 的换算对两端才都成立。
 *
 * 两种口径各自自洽（节点与 windowWidth/windowHeight 永远同一空间），混用则必然整体错位，
 * 所以入口只留一个、由这一个参数决定。
 *
 * 裁剪链也从这里起手：初始裁剪窗口 = 窗口自身（窗口之外屏幕上没有像素），之后每层按
 * `clipsToBounds` 决定要不要收紧。见 `HMClipWindowForChildren`。
 */
- (NSArray<NSDictionary *> *)nodesForWindow:(UIWindow *)window
                                      scale:(CGFloat)scale
                                      stats:(HMCollectStats *)stats {
  NSMutableArray<NSDictionary *> *nodes = [NSMutableArray array];
  // 裁剪链的起点就是窗口自己：窗口之外的区域屏幕上没有像素，与安卓的
  // 「坐标先减窗口原点、窗口矩形即初始窗口」是同一件事。
  [self collectView:window
           parentID:nil
           treePath:@"0"
       siblingCount:1
              depth:0
              index:0
             window:window
              scale:scale
         clipWindow:window.bounds
              nodes:nodes
              stats:stats];
  return nodes;
}

- (void)collectView:(UIView *)view
           parentID:(NSString * _Nullable)parentID
           treePath:(NSString *)treePath
       siblingCount:(NSInteger)siblingCount
              depth:(NSInteger)depth
              index:(NSInteger)index
             window:(UIWindow *)window
              scale:(CGFloat)scale
         clipWindow:(CGRect)clipWindow
              nodes:(NSMutableArray<NSDictionary *> *)nodes
              stats:(HMCollectStats *)stats {
  if (view == self.overlayView) {
    return;
  }
  if (nodes.count >= self.options.maxNodes) {
    stats.nodeLimitReached = YES;
    return;
  }
  if (depth > self.options.maxDepth) {
    stats.depthLimitReached = YES;
    return;
  }

  stats.actualDepth = MAX(stats.actualDepth, depth);

  BOOL visible = HMViewIsEffectivelyVisible(view, window);
  if (!self.options.includeInvisible && !visible) {
    return;
  }

  CGRect rect = [view convertRect:view.bounds toView:window];
  if (!self.options.includeZeroSize && (CGRectGetWidth(rect) <= 0 || CGRectGetHeight(rect) <= 0)) {
    return;
  }

  CGRect effectiveRect = HMEffectiveVisibleRect(rect, clipWindow);
  BOOL hasEffectiveRect = !CGRectIsEmpty(effectiveRect);

  NSString *nodeID = [NSString stringWithFormat:@"view:%p", view];
  BOOL enabled = ![view isKindOfClass:UIControl.class] || ((UIControl *)view).isEnabled;
  NSMutableDictionary *node = [@{
    @"nodeId": nodeID,
    // treePath 是 **Mac 侧的稳定主键**（它拿不到我们的 view 指针，换个进程就变了），
    // 要求「非空 + 全树唯一」；格式与 Android 一致：根是 "0"，第 i 个子节点是 "<父>/<i>"。
    @"treePath": treePath,
    @"parentId": parentID ?: [NSNull null],
    @"className": NSStringFromClass(view.class),
    @"depth": @(depth),
    @"index": @(index),
    @"siblingCount": @(siblingCount),
    @"attached": @(view.window != nil),
    // 几何一律乘 scale：见 nodesForWindow:scale:stats: 里那段口径说明。
    @"x": @(CGRectGetMinX(rect) * scale),
    @"y": @(CGRectGetMinY(rect) * scale),
    @"width": @(CGRectGetWidth(rect) * scale),
    @"height": @(CGRectGetHeight(rect) * scale),
    @"visible": @(visible),
    @"isSvg": @(HMViewIsSvg(view)),
    @"isImage": @(HMViewIsImage(view)),
    @"isGradient": @(HMViewIsGradient(view)),
    @"hasVisualContent": @(HMViewHasVisualContent(view)),
    @"alpha": @(view.alpha),
    @"clickable": @(view.userInteractionEnabled),
    @"enabled": @(enabled),
    @"clipsToBounds": @(view.clipsToBounds),
    @"accessibilityIdentifier": view.accessibilityIdentifier ?: [NSNull null],
    @"accessibilityLabel": view.accessibilityLabel ?: [NSNull null],
    @"z": @(view.layer.zPosition),
  } mutableCopy];

  // 有效可见矩形与裁剪结论（字段名与安卓 NativeNode 逐字相同，Mac 侧读的是同一套）。
  // 「自身上报的可见矩形」对绘制期裁剪无感，所以这里必须自己沿祖先链求交 ——
  // 缺了这组，被列表 / 滚动容器裁掉的那些行会被下游当成完整可见。
  if (hasEffectiveRect) {
    node[@"effectiveVisibleX"] = @(CGRectGetMinX(effectiveRect) * scale);
    node[@"effectiveVisibleY"] = @(CGRectGetMinY(effectiveRect) * scale);
    node[@"effectiveVisibleWidth"] = @(CGRectGetWidth(effectiveRect) * scale);
    node[@"effectiveVisibleHeight"] = @(CGRectGetHeight(effectiveRect) * scale);
  } else {
    node[@"effectiveVisibleX"] = [NSNull null];
    node[@"effectiveVisibleY"] = [NSNull null];
    node[@"effectiveVisibleWidth"] = [NSNull null];
    node[@"effectiveVisibleHeight"] = [NSNull null];
  }
  node[@"clippedByAncestor"] = @(HMIsClippedByAncestor(rect, effectiveRect));
  node[@"clippedOut"] = @(HMIsClippedOut(rect, effectiveRect));

  if (self.options.includeText) {
    // 取值来源见 HMTextOfView：只认 UILabel 系会让 RN Fabric 的文本节点整片变空。
    // 空串与「没有文本」在下游等价（画布 label 与文本锚点都按 trim 后非空判），
    // 这里统一落成 null，免得快照里出现一堆 ""。
    NSString *text = HMTextOfView(view);
    node[@"text"] = text.length > 0 ? text : [NSNull null];
  } else {
    node[@"text"] = [NSNull null];
  }

  // ── 样式：背景色 / 字体 ──
  //
  // 与安卓同样的分工（见 `NativeNode.TextStyle` 那段）：**样式不受 `includeText` 影响**。
  // 文本内容涉及隐私（密码框要脱敏、source-inspector 档根本不收），而「这个密码框是 14px
  // 常规体」不涉及 —— 两件事分开，免得为了脱敏把字号也一起丢掉。
  //
  // `style` 这一端**永远发对象、绝不发 null**（理由见 HMBoxStyleOfView）。`textStyle` 则
  // 照三态走：nil → null 表示「采过了、这个节点不是文本」。
  node[@"style"] = HMBoxStyleOfView(view);
  node[@"textStyle"] = HMTextStyleOfView(view) ?: (id)[NSNull null];

  [nodes addObject:node.copy];
  CGRect childClipWindow = HMClipWindowForChildren(view.clipsToBounds, effectiveRect, clipWindow);
  NSInteger childCount = (NSInteger)view.subviews.count;
  for (NSUInteger childIndex = 0; childIndex < view.subviews.count; childIndex++) {
    [self collectView:view.subviews[childIndex]
             parentID:nodeID
             treePath:[NSString stringWithFormat:@"%@/%lu", treePath, (unsigned long)childIndex]
         siblingCount:childCount
                depth:depth + 1
                index:(NSInteger)childIndex
               window:window
                scale:scale
           clipWindow:childClipWindow
                nodes:nodes
                stats:stats];
    if (nodes.count >= self.options.maxNodes) {
      stats.nodeLimitReached = YES;
      break;
    }
  }
}

@end

@implementation HMUiAcceptanceOverlayView

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    self.backgroundColor = UIColor.clearColor;
    self.opaque = NO;
    self.userInteractionEnabled = NO;
    self.nodes = @[];
  }
  return self;
}

- (void)setNodes:(NSArray<NSDictionary *> *)nodes {
  _nodes = [nodes copy];
  [self setNeedsDisplay];
}

- (void)drawRect:(CGRect)rect {
  (void)rect;
  // 线宽要除以屏幕倍数才能画出**一物理像素**的细线（1pt 在 3x 屏上是 3px，看着像粗线）。
  // 浮层已从父视图摘下来但还留着一次绘制时 window 为 nil，此时退回 traitCollection；
  // `UIScreen.mainScreen` 在 iOS 26 起被标记弃用，不再用它。
  CGFloat scale = self.window != nil ? HMWindowScale(self.window) : self.traitCollection.displayScale;
  if (!(scale > 0)) {
    scale = 1.0;
  }
  CGContextRef context = UIGraphicsGetCurrentContext();
  CGContextSetLineWidth(context, 1.0 / scale);
  for (NSDictionary *node in self.nodes) {
    NSInteger depth = [node[@"depth"] integerValue];
    CGFloat hue = (CGFloat)((depth * 37) % 360) / 360.0;
    UIColor *color = [UIColor colorWithHue:hue saturation:0.85 brightness:0.95 alpha:0.75];
    CGContextSetStrokeColorWithColor(context, color.CGColor);
    CGRect nodeRect = CGRectMake(
      [node[@"x"] doubleValue],
      [node[@"y"] doubleValue],
      [node[@"width"] doubleValue],
      [node[@"height"] doubleValue]
    );
    CGContextStrokeRect(context, nodeRect);

    if (self.showLabels && CGRectGetWidth(nodeRect) > 16 && CGRectGetHeight(nodeRect) > 12) {
      NSString *className = node[@"className"];
      NSString *label = [NSString stringWithFormat:@"%@ %.0fx%.0f", className.lastPathComponent,
                                                   CGRectGetWidth(nodeRect), CGRectGetHeight(nodeRect)];
      NSDictionary *attributes = @{
        NSFontAttributeName: [UIFont systemFontOfSize:9],
        NSForegroundColorAttributeName: UIColor.blackColor,
      };
      [label drawAtPoint:CGPointMake(CGRectGetMinX(nodeRect) + 2, CGRectGetMinY(nodeRect) + 10)
          withAttributes:attributes];
    }
  }
}

@end
