'use strict';

const fs = require('node:fs');
const path = require('node:path');

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}

function tagName(node) {
  if (!node) return 'Unknown';
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return `${tagName(node.object)}.${tagName(node.property)}`;
  if (node.type === 'JSXNamespacedName') return `${node.namespace.name}:${node.name.name}`;
  return 'Unknown';
}

const KNOWN_REACT_NATIVE_HOSTS = new Set([
  'ActivityIndicator', 'Button', 'FlatList', 'Image', 'ImageBackground', 'KeyboardAvoidingView',
  'Modal', 'Pressable', 'RefreshControl', 'SafeAreaView', 'ScrollView', 'SectionList', 'Switch',
  'Text', 'TextInput', 'TouchableOpacity', 'TouchableWithoutFeedback', 'View', 'VirtualizedList',
]);

function relativeFile(filename, root) {
  if (!filename) return 'unknown.tsx';
  const absolute = path.resolve(filename);
  const relative = path.relative(root, absolute);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : path.basename(absolute);
}

function writeManifest(manifestPath, source) {
  if (!manifestPath) return;
  const absolute = path.resolve(manifestPath);
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
  const next = entries.filter((entry) => entry.sourceId !== source.sourceId);
  next.push(source);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(`${absolute}.tmp`, JSON.stringify(next.sort((a, b) => a.sourceId.localeCompare(b.sourceId)), null, 2));
  fs.renameSync(`${absolute}.tmp`, absolute);
}

module.exports = function uiInspectorBabelPlugin({ types: t }, options = {}) {
  const root = path.resolve(options.projectRoot || process.cwd());
  const projectRootHash = String(options.projectRootHash || process.env.UI_INSPECTOR_PROJECT_ROOT_HASH || hash(root));
  const manifestPath = options.manifestPath || path.join(root, '.ui-inspector', 'source-manifest.json');

  return {
    name: 'ui-inspector-source-markers',
    visitor: {
      JSXElement(pathRef, state) {
        const opening = pathRef.node.openingElement;
        const closing = pathRef.node.closingElement;
        const file = relativeFile(state.file && state.file.opts && state.file.opts.filename, root);
        const start = opening.loc && opening.loc.start;
        const endNode = closing || opening;
        const end = endNode.loc && endNode.loc.end;
        if (!start || !end) return;

        const displayName = tagName(opening.name);
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
          role: /^[a-z]/.test(displayName) || KNOWN_REACT_NATIVE_HOSTS.has(displayName) ? 'host' : 'instance',
        };

        // React treats __source as development metadata and keeps it on the element/Fiber
        // instead of passing it to a native View. Append after spreads so a user prop cannot
        // overwrite the marker before React consumes it.
        opening.attributes.push(t.jsxAttribute(
          t.jsxIdentifier('__source'),
          t.jsxExpressionContainer(t.valueToNode(marker)),
        ));
        writeManifest(manifestPath, marker);
      },
    },
  };
};
