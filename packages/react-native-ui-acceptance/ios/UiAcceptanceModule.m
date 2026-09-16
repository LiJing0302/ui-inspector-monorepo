#import "UiAcceptanceModule.h"

#import <UIKit/UIKit.h>

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
  if ([view isKindOfClass:UILabel.class]) {
    UILabel *label = (UILabel *)view;
    return label.text.length > 0 && CGColorGetAlpha(label.textColor.CGColor) > 0.001;
  }
  if ([view isKindOfClass:UIImageView.class]) {
    return ((UIImageView *)view).image != nil;
  }
  if ([view isKindOfClass:UITextView.class]) {
    return ((UITextView *)view).text.length > 0;
  }
  if ([view isKindOfClass:UITextField.class]) {
    UITextField *textField = (UITextField *)view;
    return textField.text.length > 0 || textField.placeholder.length > 0;
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
    // Keep the native signature compatible with the Android capture(options) API. The
    // acceptance profile is deliberately more complete than the overlay defaults.
    //
    // Default to the acceptance profile: only an explicit non-acceptance profile falls back
    // to the light options. The other direction (missing profile -> light options) silently
    // drops hidden nodes and all text, which no caller can notice from the returned snapshot.
    NSString *profile = dictionary[@"profile"];
    BOOL requestsLegacyProfile = profile != nil && ![profile isEqualToString:@"acceptance-full"];
    if (!requestsLegacyProfile) {
      self.options = HMOptionsFromDictionary(@{
        @"includeInvisible": @YES,
        @"includeZeroSize": @YES,
        @"includeText": @YES,
        @"maxDepth": @128,
        @"maxNodes": @30000,
      });
    }
    resolve([self snapshotForWindow:window]);
  });
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
  self.overlayView.nodes = [self nodesForWindow:window];
}

- (NSDictionary *)snapshotForWindow:(UIWindow *)window {
  NSArray<NSDictionary *> *nodes = [self nodesForWindow:window];
  UIScreen *screen = window.screen ?: UIScreen.mainScreen;
  return @{
    @"platform": @"ios",
    @"source": @"ios-uiview-tree",
    @"timestamp": @([[NSDate date] timeIntervalSince1970] * 1000.0),
    @"nodeCount": @(nodes.count),
    @"windowWidth": @(CGRectGetWidth(window.bounds)),
    @"windowHeight": @(CGRectGetHeight(window.bounds)),
    @"scale": @(screen.scale),
    @"nodes": nodes,
  };
}

- (NSArray<NSDictionary *> *)nodesForWindow:(UIWindow *)window {
  NSMutableArray<NSDictionary *> *nodes = [NSMutableArray array];
  [self collectView:window parentID:nil depth:0 index:0 window:window nodes:nodes];
  return nodes;
}

- (void)collectView:(UIView *)view
           parentID:(NSString * _Nullable)parentID
              depth:(NSInteger)depth
              index:(NSInteger)index
             window:(UIWindow *)window
              nodes:(NSMutableArray<NSDictionary *> *)nodes {
  if (view == self.overlayView || nodes.count >= self.options.maxNodes || depth > self.options.maxDepth) {
    return;
  }

  BOOL visible = HMViewIsEffectivelyVisible(view, window);
  if (!self.options.includeInvisible && !visible) {
    return;
  }

  CGRect rect = [view convertRect:view.bounds toView:window];
  if (!self.options.includeZeroSize && (CGRectGetWidth(rect) <= 0 || CGRectGetHeight(rect) <= 0)) {
    return;
  }

  NSString *nodeID = [NSString stringWithFormat:@"view:%p", view];
  BOOL enabled = ![view isKindOfClass:UIControl.class] || ((UIControl *)view).isEnabled;
  NSMutableDictionary *node = [@{
    @"nodeId": nodeID,
    @"parentId": parentID ?: [NSNull null],
    @"className": NSStringFromClass(view.class),
    @"depth": @(depth),
    @"index": @(index),
    @"x": @(CGRectGetMinX(rect)),
    @"y": @(CGRectGetMinY(rect)),
    @"width": @(CGRectGetWidth(rect)),
    @"height": @(CGRectGetHeight(rect)),
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

  if (self.options.includeText) {
    NSString *text = nil;
    if ([view isKindOfClass:UILabel.class]) {
      text = ((UILabel *)view).text;
    } else if ([view isKindOfClass:UITextView.class]) {
      text = ((UITextView *)view).text;
    } else if ([view isKindOfClass:UITextField.class]) {
      text = ((UITextField *)view).text;
    }
    node[@"text"] = text ?: [NSNull null];
  } else {
    node[@"text"] = [NSNull null];
  }

  [nodes addObject:node.copy];
  for (NSUInteger childIndex = 0; childIndex < view.subviews.count; childIndex++) {
    [self collectView:view.subviews[childIndex]
             parentID:nodeID
                depth:depth + 1
                index:(NSInteger)childIndex
               window:window
                nodes:nodes];
    if (nodes.count >= self.options.maxNodes) {
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
  CGFloat scale = self.window.screen.scale ?: UIScreen.mainScreen.scale;
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
