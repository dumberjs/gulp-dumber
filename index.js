'use strict';
const through = require('through2');
const PluginError = require('plugin-error');
const Dumber = require('dumber').default;
const Concat = require('concat-with-sourcemaps');
const Vinyl = require('vinyl');
const path = require('path');

const PLUGIN_NAME = 'dumber';

/*
Optional options:

// src folder, default to "src",
src: "my-src",

// baseUrl for requirejs at runtime, default to "dist",
baseUrl: "my-server/foler", or "/my/server/folder"

// dependencies (or deps in short)
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

// TBD
// on requiring a module, before tracing
onRequiringModule: function (moduleId: string) {
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
  const dumber = new Dumber(opts);

  return through.obj(function(file, enc, cb) {
    if (file.isStream()) {
      this.emit('error', new PluginError(PLUGIN_NAME, 'Stream is not supported'));
    } else if (file.isBuffer()) {
      const p = path.relative(src, file.path).replace(/\\/g, '/');
      const moduleId = p.endsWith('.js') ? p.substring(0, p.length - 3) : p;

      console.log('')
      dumber.capture({
        path: file.path,
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
    // flush
    dumber.resolve().then(() => dumber.bundle()).then(
      bundles => {
        Object.keys(bundles).forEach(bundleName => {
          this.push(createBundle(bundleName, bundles[bundleName]));
        });
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
    concat.add(file.path || null, file.contents, file.sourceMap);
  });

  if (bundle.config) {
    let config = `requirejs.config(${JSON.stringify(bundle.config)});`;
    config.replace(/"baseUrl":/, '"baseUrl": REQUIREJS_BASE_URL ||');
  }

  return new Vinyl({
    cwd: './',
    base: '/',
    path: filename,
    contents: new Buffer(concat.content),
    sourceMap: concat.sourceMap
  })
}
