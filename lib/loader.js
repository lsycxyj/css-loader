/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var loaderUtils = require('loader-utils');
const NodeTemplatePlugin = require('webpack/lib/node/NodeTemplatePlugin');
const NodeTargetPlugin = require('webpack/lib/node/NodeTargetPlugin');
const LibraryTemplatePlugin = require('webpack/lib/LibraryTemplatePlugin');
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin');
const LimitChunkCountPlugin = require('webpack/lib/optimize/LimitChunkCountPlugin');
const hash = require('hash-sum');
const path = require('path');
const createHelpers = require('@mpxjs/webpack-plugin/lib/helpers');
const config = require('@mpxjs/webpack-plugin/lib/config');
const toPosix = require('@mpxjs/webpack-plugin/lib/utils/to-posix')
const getMainCompilation = require('@mpxjs/webpack-plugin/lib/utils/get-main-compilation')
const fixSwanRelative = require('@mpxjs/webpack-plugin/lib/utils/fix-swan-relative')
const stripExtension = require('@mpxjs/webpack-plugin/lib/utils/strip-extention')
var processCss = require('./processCss');
var getImportPrefix = require('./getImportPrefix');
var compileExports = require('./compile-exports');
var createResolver = require('./createResolver');

const seen = {};
const parseQuery = loaderUtils.parseQuery;

module.exports = function (content, map) {
  if (this.cacheable) this.cacheable();
  var callback = this.async();
  var options = loaderUtils.getOptions(this) || {};
  var root = options.root;
  var moduleMode = options.modules || options.module;
  var camelCaseKeys = options.camelCase || options.camelcase;
  var sourceMap = options.sourceMap || false;
  var resolve = createResolver(options.alias);
  const originFilePath = this.resourcePath;

  const loaderContext = this;
  const thisCompilation = this._compilation;
  const mainCompilation = getMainCompilation(thisCompilation);
  const compilationMpx = mainCompilation.__mpx__;
  let {
    projectRoot,
    usingComponents,
    processingSubPackages,
    componentsMap,
    pagesMap,
    subPackagesMap,
    mainResourceMap,
    additionalAssets,
  } = compilationMpx;

  const appRequestpath = mainCompilation._preparedEntrypoints[0].request;
  if (!projectRoot) {
    // auto resolve projectRoot
    projectRoot = path.dirname(appRequestpath);
  }

  const context = (
    this.rootContext ||
    (this.options && this.options.context) ||
    process.cwd()
  );
  const shortFilePath = path.relative(context, originFilePath).replace(/^(\.\.[\\/])+/, '');
  const isProduction = this.minimize || process.env.NODE_ENV === 'production';
  const needCssSourceMap = (
    !isProduction &&
    this.sourceMap &&
    options.cssSourceMap !== false
  );
  const hasScoped = false;
  const hasComment = false;
  const isNative = true;
  const mode = compilationMpx.mode;
  const typeExtMap = config[mode].typeExtMap;
  const moduleId = hash(isProduction ? (shortFilePath + '\n' + content) : shortFilePath);
  const {
    getLoaderString
  } = createHelpers(
    loaderContext,
    {},
    moduleId,
    isProduction,
    hasScoped,
    hasComment,
    usingComponents,
    needCssSourceMap,
    mode,
    isNative,
    projectRoot,
  );

  if (sourceMap) {
    if (map) {
      if (typeof map === 'string') {
        map = JSON.stringify(map);
      }

      if (map.sources) {
        map.sources = map.sources.map(function (source) {
          return source.replace(/\\/g, '/');
        });
        map.sourceRoot = '';
      }
    }
  } else {
    // Some loaders (example `"postcss-loader": "1.x.x"`) always generates source map, we should remove it
    map = null;
  }

  processCss(content, map, {
    mode: moduleMode ? 'local' : 'global',
    from: loaderUtils.getRemainingRequest(this).split('!').pop(),
    to: loaderUtils.getCurrentRequest(this).split('!').pop(),
    query: options,
    resolve: resolve,
    minimize: this.minimize,
    loaderContext: this,
    sourceMap: sourceMap
  }, function (err, result) {
    if (err) return callback(err);

    var cssAsString = JSON.stringify(result.source);

    // helper for ensuring valid CSS strings from requires
    var urlEscapeHelper = '';

    if (options.url !== false && result.urlItems.length > 0) {
      urlEscapeHelper = 'var escape = require(' + loaderUtils.stringifyRequest(this, require.resolve('./url/escape.js')) + ');\n';

      cssAsString = cssAsString.replace(result.urlItemRegExpG, function (item) {
        var match = result.urlItemRegExp.exec(item);
        var idx = +match[1];
        var urlItem = result.urlItems[idx];
        var url = resolve(urlItem.url);
        idx = url.indexOf('?#');
        if (idx < 0) idx = url.indexOf('#');
        var urlRequest;
        if (idx > 0) { // idx === 0 is catched by isUrlRequest
          // in cases like url('webfont.eot?#iefix')
          urlRequest = url.substr(0, idx);
          return '" + escape(require(' + loaderUtils.stringifyRequest(this, urlRequest) + ')) + "' +
            url.substr(idx);
        }
        urlRequest = url;
        return '" + escape(require(' + loaderUtils.stringifyRequest(this, urlRequest) + ')) + "';
      }.bind(this));
    }

    const promises = [];
    const childFilename = 'child-css-filename';
    result.importItems.forEach((imp) => {
      const { url, placeholder } = imp;
      if (loaderUtils.isUrlRequest(url, root)) {
        const originalPathWithoutExt = stripExtension(originFilePath);
        // Injected in child compilation to memorize origin component/page/app and parent css output location
        let originOutputName =
          // memorized origin
          thisCompilation.$originalOutputName
          // page
          || pagesMap[originalPathWithoutExt]
          // component
          || componentsMap[originalPathWithoutExt]
          // app
          || path.relative(projectRoot, appRequestpath);
        const originOutputPath = path.resolve(projectRoot, originOutputName);

        // Part of these codes are copied from extract function
        const requestPath = path.resolve(path.dirname(originFilePath), url);
        const selfResourceName = path.parse(requestPath).name;
        let subPackageRoot = '';
        // node_modules引用的是同一路径，只有子包引用时，这种在小程序引用不合法但对于npm引用合法，会根据源的打包输出路径来决定是否应该在子包打几份输出
        if (compilationMpx.processingSubPackages) {
          for (let src in subPackagesMap) {
            // 分包引用且主包未引用的资源，需打入分包目录中
            if (originOutputPath.startsWith(src) && !mainResourceMap[requestPath]) {
              subPackageRoot = subPackagesMap[src];
              break;
            }
          }
        } else {
          mainResourceMap[requestPath] = true;
        }
        const requestHash = hash(requestPath);
        const outputFilename = toPosix(path.join(subPackageRoot, 'wxss', selfResourceName + requestHash + typeExtMap.styles));

        const parentOutputName = thisCompilation.$parentOutputName || originOutputName;

        // TODO optimize performance
        let relativePath = toPosix(path.relative(path.dirname(parentOutputName), outputFilename));
        if (mode === 'swan') {
          relativePath = fixSwanRelative(relativePath)
        }
        cssAsString = cssAsString.replace(placeholder, relativePath);

        // compile and output only once
        if (!additionalAssets[outputFilename]) {
          additionalAssets[outputFilename] = [];

          const childRequest = `${getLoaderString('styles', { noExtract: true })}${requestPath}`;
          promises.push(new Promise((resolve, reject) => {
            const outputOptions = {
              filename: childFilename
            };

            const childCompiler = mainCompilation.createChildCompiler(childRequest, outputOptions, [
              new NodeTemplatePlugin(outputOptions),
              new LibraryTemplatePlugin(null, 'commonjs2'),
              new NodeTargetPlugin(),
              new SingleEntryPlugin(this.context, childRequest, childFilename),
              new LimitChunkCountPlugin({ maxChunks: 1 })
            ]);

            childCompiler.hooks.thisCompilation.tap('MpxWebpackPlugin', (compilation) => {
              compilation.$originalOutputName = originOutputName;
              compilation.$parentOutputName = outputFilename;
            });

            let source;

            childCompiler.hooks.afterCompile.tapAsync('MpxWebpackPlugin', (compilation, callback) => {
              source = compilation.assets[childFilename] && compilation.assets[childFilename].source();

              // Remove all chunk assets
              compilation.chunks.forEach((chunk) => {
                chunk.files.forEach((file) => {
                  delete compilation.assets[file];
                });
              });

              callback();
            });

            childCompiler.runAsChild((err, entries, compilation) => {
              if (err) {
                reject(err);
              } else {
                compilation.fileDependencies.forEach((dep) => {
                  loaderContext.addDependency(dep);
                });
                compilation.contextDependencies.forEach((dep) => {
                  loaderContext.addContextDependency(dep);
                });

                if (!source) {
                  return reject(new Error('Didn\'t get a result from child compiler'));
                }

                try {
                  let text = this.exec(source, childRequest);
                  if (Array.isArray(text)) {
                    text = text.map((item) => {
                      return item[1];
                    }).join('\n');
                  }
                  additionalAssets[outputFilename][0] = text;
                } catch (err) {
                  return reject(err);
                }

                resolve();
              }

            });
          }));
        }
      }
    });

    var moduleJs;
    if (sourceMap && result.map) {
      // add a SourceMap
      map = result.map;
      if (map.sources) {
        map.sources = map.sources.map(function (source) {
          return source.split('!').pop().replace(/\\/g, '/');
        }, this);
        map.sourceRoot = '';
      }
      map.file = map.file.split('!').pop().replace(/\\/g, '/');
      map = JSON.stringify(map);
      moduleJs = 'exports.push([module.id, ' + cssAsString + ', "", ' + map + ']);';
    } else {
      moduleJs = 'exports.push([module.id, ' + cssAsString + ', ""]);';
    }

    Promise.all(promises)
      .then(() => {
        // embed runtime
        callback(null, urlEscapeHelper +
          'exports = module.exports = require(' +
          loaderUtils.stringifyRequest(this, require.resolve('./css-base.js')) +
          ')(' + sourceMap + ');\n' +
          '// module\n' +
          moduleJs + '\n\n');
      }, callback);
  }.bind(this));
};
