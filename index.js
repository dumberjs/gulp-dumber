'use strict';
const {Transform} = require('stream');
const PluginError = require('plugin-error');
const Dumber = require('dumber');
const Concat = require('concat-with-sourcemaps');
const Vinyl = require('vinyl');
const path = require('path');
const crypto = require('crypto');
const log = require('fancy-log');
const PLUGIN_NAME = 'dumber';
const cwd = path.resolve('.');

/*
Optional options:

// src folder, default to "src",
src: "my-src",

// baseUrl for requirejs at runtime, default to "dist",
baseUrl: "my-server/foler", or "/my/server/folder"

// hash, default to false
// Add hash for bundle file names
// like entry-bundle.7215ee9c7d9dc229d2921a40e899ec5f.js
hash: true,

// onManifest callback
// When hash is on, onManifest callback receives
// {
//   "entry-bundle.js": "entry-bundle.7215ee9c7d9dc229d2921a40e899ec5f.js",
//   "other-bundle.js": "other-bundle.xxxxyyyzzzz.js"
// }
// When hash if off, onManifest callback receives
// {
//   "entry-bundle.js": "entry-bundle.js",
//   "other-bundle.js": "other-bundle.js"
// }
// User can use this filename map to update index.html
onManifest: function(filenameMap) {...}

// dependencies (or deps in short)
// This is for deps not explicitly required by your code,
// or some package needs special treatment.
dependencies: [
  'npm_package_not_explicitly_required_by_your_code',
  {
    // This creates a shim
    name: 'very_old_npm_package_does_not_support_amd_or_cjs',
    deps: ['jquery'],
    exports: 'jQuery.veryOld',
    wrapShim: true // optional shim wrapper
  }
]

// prepends (or prepend)
// A list of files or direct contents to be written to entry bundle
// before AMD loader.
// This is the place you want to load traditional JS libs who doesn't
// support AMD/CommonJS or ES Native Module.\
prepends: [
  'path/to/file.js', // must be a js file
  'var direct = js_code;'
]

// appends (or append)
// A list of files or direct contents to be written to entry bundle
// after AMD loader and all modules definitions, but before
// requirejs.config({...}).
// Note appends are after AMD loader, means they are in AMD env.
appends: [
  'path/to/file.js', // must be a js file
  'define(some_additional_module,[],function(){});'
]

// additional deps finder, on top of standard amd+cjs deps finder
depsFinder: function (filename: string, file_contents: string) {
  return string_array_of_additional_module_ids;
  // or return a promise to resolve deps
}

// optional npm package file reader, replace default npm package file reader
// which search local node_modules folders
packageFileReader: function (packageName: string) {
  return Promise.resolve(
    // filePath is local within the package,
    // like:
    //   package.json
    //   dist/cjs/index.js
    function (filePath: string) {
      return Promise.resolve({
        path: relative_file_path_to_cwd,
        contents: file_contents_in_string
      });
    }
  };
}

// on requiring a module, before tracing
onRequire: function (moduleId: string) {
  return false; // ignore this moduleId.
  return ['a', 'b']; // ignore this moduleId, but require module id "a" and "b" instead.
  return 'define(...)'; // the full JavaScript content of this module, must be in AMD format.
  // return undefined; means go on with normal tracing
}
*/
module.exports = function (opts) {
  if (!opts) opts = {};

  // default src folder is "src/"
  const _src = opts.src || 'src';
  const src = path.resolve(_src);
  delete opts.src;

  const hash = opts.hash;
  delete opts.hash;

  const onManifest = opts.onManifest;
  delete opts.onManifest;
  const manifest = {};

  if (!opts.paths) opts.paths = {};
  // set {'../src':''}, this is to support above surface module to import a source file
  // e.g.
  // in file test/app.spec.js
  // import App from '../src/app';
  //
  // this shotcut will resolve '../src/app' into 'app'
  opts.paths['../' + _src] = '';

  const dumber = new Dumber(opts, opts.mock);
  const outputBase = path.join(cwd, '__output__');

  // listen to the stream to set needsSourceMap
  let needsSourceMap = false;

  // Note the extra wrapper () => through.obj...
  // This is for gulp-dumber to be used repeatedly in watch mode.
  // e.g.
  //   const dr = gulpDumber(opts);
  //   (...).pipe(dr()) // dr(), not dr here

  const gulpBumber = () => new Transform({
    objectMode: true,
    transform: function(file, enc, cb) {
      if (file.isStream()) {
        this.emit('error', new PluginError(PLUGIN_NAME, 'Streaming is not supported'));
      } else if (file.isBuffer()) {
        // Ignore .d.ts file.
        if (file.path.endsWith('.d.ts')) {
          cb();
          return;
        }

        const p = path.relative(src, file.path).replace(/\\/g, '/');
        const moduleId = p.endsWith('.js') ? p.slice(0, -3) : p;

        let sourceMap;
        if (file.sourceMap) {
          needsSourceMap = true;
          sourceMap = JSON.parse(JSON.stringify(file.sourceMap));
          // clean up paths in sourceMap, make all paths relative to cwd
          sourceMap.file = relativeToCwd(file, sourceMap.file);
          sourceMap.sources = sourceMap.sources.map(p => relativeToCwd(file, p));
        }

        dumber.capture({
          // path is relative to cwd
          path: path.relative(cwd, file.path).replace(/\\/g, '/'),
          contents: file.contents.toString(file.extname === '.wasm' ? 'base64' : undefined),
          sourceMap,
          moduleId
        }).then(
          () => cb(),
          err => this.emit('error', new PluginError(PLUGIN_NAME, err))
        )
      } else {
        // make sure the file goes through the next gulp plugin
        cb(null, file);
      }
    },
    flush: function(cb) {
      // Stream flush
      // This is after gulp-dumber consumes all incoming vinyl files
      // Generates new vinyl files for bundles
      dumber.resolve().then(() => dumber.bundle()).then(bundles => {
        const otherFiles = {};
        let entryBundleFile;

        Object.keys(bundles).forEach(bundleName => {
          const file = createBundle(bundleName, bundles[bundleName], needsSourceMap);
          if (file.config) entryBundleFile = file;
          else otherFiles[bundleName] = file;
          manifest[bundleName] = file.filename;
        });

        if (hash) {
          Object.keys(otherFiles).forEach(bundleName => {
            const file = otherFiles[bundleName];
            const hash = generateHash(file.contents);
            const filename = bundleName + '.' + hash + '.js';
            manifest[bundleName] = filename;
            file.filename = filename;
            if (file.sourceMap) file.sourceMap.file = filename;
          });

          // get persisted manifest plus updates
          Object.keys(manifest).forEach(bundleName => {
            if (bundleName === entryBundleFile.bundleName) return;
            entryBundleFile.config.paths[bundleName] = manifest[bundleName];
          });

          const entryHash = generateHash(entryBundleFile.contents + JSON.stringify(entryBundleFile.config) + entryBundleFile.appendContents);
          const entryFilename = entryBundleFile.bundleName + '.' + entryHash + '.js';
          manifest[entryBundleFile.bundleName] = entryFilename;
          entryBundleFile.filename = entryFilename;
          if (entryBundleFile.sourceMap) entryBundleFile.sourceMap.file = entryFilename;
        }

        if (onManifest) {
          const withExt = {};
          Object.keys(manifest).forEach(bundleName => {
            withExt[bundleName + '.js'] = manifest[bundleName];
          })
          onManifest(withExt);
        }

        Object.keys(otherFiles).forEach(bundleName => {
          const file = otherFiles[bundleName];
          log('Write ' + file.filename);
          const f = new Vinyl({
            cwd,
            base: outputBase,
            path: path.join(outputBase, file.filename),
            contents: Buffer.from(file.contents)
          });

          if (needsSourceMap && file.sourceMap) {
            f.sourceMap = file.sourceMap;
            // assume user of gulp-dumber writes bundler file with one-level dest only.
            // like gulp.dest('dist') but not gulp.dest('deep/dist');
            f.sourceMap.sourceRoot = '../';
          }

          this.push(f);
        });

        let rjsConfig = `requirejs.config(${JSON.stringify(entryBundleFile.config, null , 2)});`
        rjsConfig = rjsConfig.replace('"baseUrl":', '"baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL :');

        log('Write ' + entryBundleFile.filename);

        const concat = new Concat(needsSourceMap, entryBundleFile.filename, '\n');
        if (needsSourceMap) {
          concat.add('__' + entryBundleFile.filename, entryBundleFile.contents, entryBundleFile.sourceMap);
          concat.add(null, rjsConfig);
          if (entryBundleFile.appendContents) {
            concat.add('__append_' + entryBundleFile.filename, entryBundleFile.appendContents, entryBundleFile.appendSourceMap);
          }
        } else {
          concat.add(null, entryBundleFile.contents);
          concat.add(null, rjsConfig);
          if (entryBundleFile.appendContents) {
            concat.add(null, entryBundleFile.appendContents);
          }
        }

        const ef = new Vinyl({
          cwd,
          base: outputBase,
          path: path.join(outputBase, entryBundleFile.filename),
          contents: concat.content
        });

        if (needsSourceMap && concat.sourceMap) {
          ef.sourceMap = JSON.parse(concat.sourceMap);
          // assume user of gulp-dumber writes bundler file with one-level dest only.
          // like gulp.dest('dist') but not gulp.dest('deep/dist');
          ef.sourceMap.sourceRoot = '../';
        }

        this.push(ef);

        cb();
      })
      .catch(err => {
        this.emit('error', new PluginError(PLUGIN_NAME, err));
      });
    }
  });

  gulpBumber.clearCache = () => dumber.clearCache();
  return gulpBumber;
};

function createBundle(bundleName, bundle, needsSourceMap) {
  function concatFile(concat, file) {
    if (needsSourceMap && file.path) {
      const sourceMap = file.sourceMap && file.sourceMap.sources.length ? file.sourceMap : undefined;
      concat.add(file.path, file.contents, sourceMap);
    } else {
      concat.add(null, file.contents);
    }
  }

  const filename = bundleName + '.js';
  const concat = new Concat(needsSourceMap, filename, '\n');
  bundle.files.forEach(file => concatFile(concat, file));

  const appendConcat = new Concat(needsSourceMap, filename, '\n');
  if (bundle.appendFiles) {
    bundle.appendFiles.forEach(file => concatFile(appendConcat, file));
  }

  const file = {
    bundleName,
    filename,
    appendContents: appendConcat.content.toString(),
    appendSourceMap: appendConcat.sourceMap ? JSON.parse(appendConcat.sourceMap) : null,
    contents: concat.content.toString(),
    sourceMap: concat.sourceMap ? JSON.parse(concat.sourceMap) : null
  }

  if (bundle.config) {
    file.config = JSON.parse(JSON.stringify(bundle.config));
  }

  return file;
}

function generateHash(constents) {
  return crypto.createHash('md5').update(constents).digest('hex');
}

function relativeToCwd(file, aPath) {
  return path.relative(cwd, path.join(file.base, aPath)).replace(/\\/g, '/');
}
