import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import {
  uniqWith,
  getImportItemCode,
  getUrlHelperCode,
  getUrlItemCode,
} from '../utils';

const pluginName = 'postcss-import-parser';

function getArg(nodes) {
  return nodes.length !== 0 && nodes[0].type === 'string'
    ? nodes[0].value
    : valueParser.stringify(nodes);
}

function getUrl(node) {
  if (node.type === 'function' && node.value.toLowerCase() === 'url') {
    return getArg(node.nodes);
  }

  if (node.type === 'string') {
    return node.value;
  }

  return null;
}

function parseImport(params) {
  const { nodes } = valueParser(params);

  if (nodes.length === 0) {
    return null;
  }

  const url = getUrl(nodes[0]);

  if (!url || url.trim().length === 0) {
    return null;
  }

  return {
    url,
    media: valueParser
      .stringify(nodes.slice(1))
      .trim()
      .toLowerCase(),
  };
}

function walkAtRules(css, result, filter) {
  const items = [];

  css.walkAtRules(/^import$/i, (atRule) => {
    // Convert only top-level @import
    if (atRule.parent.type !== 'root') {
      return;
    }

    if (atRule.nodes) {
      result.warn(
        "It looks like you didn't end your @import statement correctly. " +
          'Child nodes are attached to it.',
        { node: atRule }
      );
      return;
    }

    const parsed = parseImport(atRule.params);

    if (!parsed) {
      // eslint-disable-next-line consistent-return
      return result.warn(`Unable to find uri in '${atRule.toString()}'`, {
        node: atRule,
      });
    }

    if (filter && !filter(parsed)) {
      return;
    }

    const { url, media } = parsed;

    items.push({ url, media, atRule });
  });

  return items;
}

export default postcss.plugin(
  pluginName,
  (options = {}) =>
    function process(css, result) {
      const traversed = walkAtRules(css, result, options.filter);
      const paths = uniqWith(
        traversed,
        (value, other) => value.url === other.url && value.media === other.media
      );

      const placeholders = [];

      paths.forEach((item, index) => {
        // TODO function import mode support
        const { importMode } = options;
        if (importMode === 'keep') {
          const placeholder = `___CSS_LOADER_IMPORT_URL___${index}___`;

          placeholders.push({ placeholder, path: item });

          result.messages.push({
            pluginName,
            type: 'import',
            import: '',
            importType: 'import',
            placeholder,
          });
        } else {
          result.messages.push({
            pluginName,
            type: 'import',
            import: getImportItemCode(
              item,
              options.loaderContext,
              options.importPrefix
            ),
          });
        }
      });

      traversed.forEach((item) => {
        const { url, atRule } = item;
        if (atRule) {
          const value = placeholders.find(
            (placeholder) => placeholder.path.url === url
          );

          if (value) {
            atRule.params = value.placeholder;
          } else {
            atRule.remove();
          }
        }
      });
    }
);
