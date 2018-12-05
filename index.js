'use strict';
const through = require('through2');
const PluginError = require('plugin-error');
const Dumber = require('dumber').default;
const Concat = require('concat-with-sourcemaps');
const Vinyl = require('vinyl');
const path = require('path');
const crypto = require('crypto');
const log = require('fancy-log');
const PLUGIN_NAME = 'dumber';

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
// When hash is on, a manifest.json file will be written
// {"entry-bundle": "entry-bundle.7215ee9c7d9dc229d2921a40e899ec5f.js"}

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

// optional npm package locator, replace default npm package locator
// which search local node_modules folders
packageLocator: function (packageName: string) {
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
  const src = path.resolve(opts.src || 'src');
  delete opts.src;

  const hash = opts.hash;
  delete opts.hash;
  const manifest = {};

  // TODO additional paths mapping for 'common': '../common'

  const dumber = new Dumber(opts);
  const cwd = path.resolve('.');

  // Note the extra wrapper () => through.obj...
  // This is for gulp-dumber to be used repeatedly in watch mode.
  // e.g.
  //   const dr = gulpDumber(opts);
  //   (...).pipe(dr()) // dr(), not dr here

  return () => through.obj(function(file, enc, cb) {
    if (file.isStream()) {
      this.emit('error', new PluginError(PLUGIN_NAME, 'Stream is not supported'));
    } else if (file.isBuffer()) {
      const p = path.relative(src, file.path).replace(/\\/g, '/');
      const moduleId = p.endsWith('.js') ? p.substring(0, p.length - 3) : p;

      dumber.capture({
        // path is relative to cwd
        path: path.relative(cwd, file.path).replace(/\\/g, '/'),
        contents: file.contents.toString(),
        sourceMap: file.sourceMap,
        moduleId
      }).then(
        () => cb(),
        err => this.emit('error', new PluginError(PLUGIN_NAME, err))
      )
    } else {
      // make sure the file goes through the next gulp plugin
      cb(null, file);
    }
  }, function(cb) {
    // Stream flush
    // This is after gulp-dumber consumes all incoming vinyl files
    // Generates new vinyl files for bundles
    dumber.resolve().then(() => dumber.bundle()).then(
      bundles => {
        const otherFiles = {};
        let entryBundleFile;

        Object.keys(bundles).forEach(bundleName => {
          const file = createBundle(bundleName, bundles[bundleName]);
          if (file.config) entryBundleFile = file;
          else otherFiles[bundleName] = file;
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

          // save persisted manifest
          entryBundleFile.config.paths = manifest;

          const entryHash = generateHash(entryBundleFile.contents + JSON.stringify(entryBundleFile.config));
          const entryFilename = entryBundleFile.bundleName + '.' + entryHash + '.js';
          manifest[entryBundleFile.bundleName] = entryFilename;
          entryBundleFile.filename = entryFilename;
          if (entryBundleFile.sourceMap) entryBundleFile.sourceMap.file = entryFilename;

          log('write manifest.json');
          // write manifest.json
          this.push(new Vinyl({
            cwd: cwd,
            base: path.join(cwd, '__output__'),
            path: path.join(cwd, '__output__', 'manifest.json'),
            contents: new Buffer(JSON.stringify(manifest, null, 2))
          }));
        }

        Object.keys(otherFiles).forEach(bundleName => {
          const file = otherFiles[bundleName];
          log('write ' + file.filename);
          this.push(new Vinyl({
            cwd: cwd,
            base: path.join(cwd, '__output__'),
            path: path.join(cwd, '__output__', file.filename),
            contents: new Buffer(file.contents),
            sourceMap: file.sourceMap
          }));
        });

        const rjsConfig = `\nrequirejs.config(${JSON.stringify(entryBundleFile.config, null , 2)});\n`

        log('write ' + entryBundleFile.filename);
        this.push(new Vinyl({
          cwd: cwd,
          base: path.join(cwd, '__output__'),
          path: path.join(cwd, '__output__', entryBundleFile.filename),
          contents: new Buffer(entryBundleFile.contents + rjsConfig),
          sourceMap: entryBundleFile.sourceMap
        }));

        cb();
      },
      err => this.emit('error', new PluginError(PLUGIN_NAME, err))
    )
  });
};

function createBundle(bundleName, bundle) {
  const filename = bundleName + '.js';
  const concat = new Concat(true, filename, '\n');
  bundle.files.forEach(file => {
    const p = (file.sourceMap && file.path) ? file.path : null;
    concat.add(p, file.contents, file.sourceMap || undefined);
  });

  const file = {
    bundleName,
    filename,
    contents: concat.content,
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
