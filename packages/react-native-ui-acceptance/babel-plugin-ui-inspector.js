'use strict';

const path = require('node:path');

const SOURCE_NATIVE_ID_PREFIX = '__uii_v1|';
const KNOWN_REACT_NATIVE_HOSTS = new Set([
  'ActivityIndicator', 'Button', 'FlatList', 'Image', 'ImageBackground', 'KeyboardAvoidingView',
  'Modal', 'Pressable', 'RefreshControl', 'SafeAreaView', 'ScrollView', 'SectionList', 'Switch',
  'Text', 'TextInput', 'TouchableOpacity', 'TouchableWithoutFeedback', 'View', 'VirtualizedList',
]);

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}

function relativeFile(filename, root) {
  if (!filename) return 'unknown.tsx';
  const absolute = path.resolve(filename);
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : path.basename(absolute);
}

function importedHostName(pathRef, name) {
  const binding = pathRef.scope.getBinding(name);
  if (!binding || !binding.path) return null;
  const bindingPath = binding.path;
  const declaration = bindingPath.parentPath;
  if (!declaration?.isImportDeclaration() || declaration.node.source.value !== 'react-native') return null;
  if (!bindingPath.isImportSpecifier()) return null;
  const imported = bindingPath.node.imported;
  const importedName = imported.type === 'Identifier' ? imported.name : imported.value;
  return KNOWN_REACT_NATIVE_HOSTS.has(importedName) ? importedName : null;
}

function namespaceHostName(pathRef, node) {
  if (node.type !== 'JSXMemberExpression' || node.object.type !== 'JSXIdentifier' ||
      node.property.type !== 'JSXIdentifier' || !KNOWN_REACT_NATIVE_HOSTS.has(node.property.name)) return null;
  const binding = pathRef.scope.getBinding(node.object.name);
  if (!binding?.path?.isImportNamespaceSpecifier()) return null;
  const declaration = binding.path.parentPath;
  return declaration?.isImportDeclaration() && declaration.node.source.value === 'react-native'
    ? node.property.name
    : null;
}

function hostName(pathRef, node) {
  if (node.type === 'JSXIdentifier') return importedHostName(pathRef, node.name);
  return namespaceHostName(pathRef, node);
}

const NATIVE_VIEW_PROPS = new Set([
  'accessible', 'accessibilityActions', 'accessibilityElementsHidden', 'accessibilityHint',
  'accessibilityLabel', 'accessibilityLanguage', 'accessibilityLiveRegion', 'accessibilityRole',
  'accessibilityState', 'accessibilityValue', 'accessibilityViewIsModal', 'focusable', 'id',
  'importantForAccessibility', 'needsOffscreenAlphaCompositing', 'onAccessibilityAction',
  'onAccessibilityEscape', 'onAccessibilityTap', 'onLayout', 'onMagicTap',
  'onMoveShouldSetResponder', 'onMoveShouldSetResponderCapture', 'onResponderEnd',
  'onResponderGrant', 'onResponderMove', 'onResponderReject', 'onResponderRelease',
  'onResponderStart', 'onResponderTerminate', 'onResponderTerminationRequest',
  'onStartShouldSetResponder', 'onStartShouldSetResponderCapture', 'onTouchCancel',
  'onTouchEnd', 'onTouchEndCapture', 'onTouchMove', 'onTouchStart', 'pointerEvents', 'ref',
  'removeClippedSubviews', 'renderToHardwareTextureAndroid', 'testID',
]);

function viewAlreadyNeedsNativeNode(opening) {
  return opening.attributes.some((attribute) => {
    if (attribute.type !== 'JSXAttribute') return false;
    const name = attribute.name.name;
    if (NATIVE_VIEW_PROPS.has(name)) return true;
    if (name !== 'collapsable') return false;
    if (!attribute.value) return false;
    if (attribute.value.type === 'StringLiteral') return attribute.value.value === 'false';
    return attribute.value.type === 'JSXExpressionContainer' &&
      attribute.value.expression.type === 'BooleanLiteral' &&
      attribute.value.expression.value === false;
  });
}

function markerNativeId(marker) {
  return SOURCE_NATIVE_ID_PREFIX + [
    marker.projectRootHash,
    marker.sourceId,
    marker.startLine,
    marker.startColumn,
    marker.endLine,
    marker.endColumn,
    marker.role,
    encodeURIComponent(marker.displayName),
    encodeURIComponent(marker.relativePath),
  ].join('|');
}

module.exports = function uiInspectorBabelPlugin({ types: t }, options = {}) {
  const root = path.resolve(options.projectRoot || process.cwd());
  const projectRootHash = String(options.projectRootHash || process.env.UI_INSPECTOR_PROJECT_ROOT_HASH || hash(root));

  return {
    name: 'ui-inspector-native-source-markers',
    visitor: {
      JSXElement(pathRef, state) {
        const opening = pathRef.node.openingElement;
        const displayName = hostName(pathRef, opening.name);
        if (!displayName) return;
        // A nativeID makes an otherwise layout-only View materialize on Android. On complex
        // screens that changes hit-testing and defeats RN's view-flattening optimization. Only
        // mark View elements that already require a native node for another prop.
        if (displayName === 'View' && !viewAlreadyNeedsNativeNode(opening)) return;
        if (opening.attributes.some((attribute) =>
          attribute.type === 'JSXAttribute' && attribute.name.name === 'nativeID')) return;

        const closing = pathRef.node.closingElement;
        const start = opening.loc && opening.loc.start;
        const endNode = closing || opening;
        const end = endNode.loc && endNode.loc.end;
        if (!start || !end) return;

        const file = relativeFile(state.file && state.file.opts && state.file.opts.filename, root);
        const startColumn = start.column + 1;
        const endColumn = Math.max(startColumn, end.column + 1);
        const sourceId = hash(`${file}:${start.line}:${startColumn}:${end.line}:${endColumn}:${displayName}`);
        const marker = {
          projectRootHash,
          relativePath: file,
          startLine: start.line,
          startColumn,
          endLine: end.line,
          endColumn,
          sourceId,
          displayName,
          role: 'host',
        };

        // Put the marker first. An explicit nativeID or a later spread keeps application semantics
        // by overriding it; views without their own nativeID retain the Inspector marker natively.
        opening.attributes.unshift(t.jsxAttribute(
          t.jsxIdentifier('nativeID'),
          t.stringLiteral(markerNativeId(marker)),
        ));
      },
    },
  };
};

module.exports.SOURCE_NATIVE_ID_PREFIX = SOURCE_NATIVE_ID_PREFIX;
