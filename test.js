'use strict';
const test = require('tape');
const Vinyl = require('vinyl');
const streamArray = require('stream-array');
const streamAssert = require('stream-assert');
const gulp = require('gulp');
const gulpDumber = require('./index');
const {contentOrFile} = require('dumber/dist/shared');
const path = require('path');
const _defaultLocator = require('dumber/dist/package-locators/default').default;
const cwd = process.cwd();

function mockResolve(path) {
  return 'node_modules/' + path;
}

function buildReadFile(fakeFs = {}) {
  return p => {
    p = path.normalize(p).replace(/\\/g, '/');
    if (fakeFs.hasOwnProperty(p)) return Promise.resolve(fakeFs[p]);
    return Promise.reject('no file at ' + p);
  };
}

function mockLocator(fakeReader) {
  return packageConfig => _defaultLocator(packageConfig, {resolve: mockResolve, readFile: fakeReader});
}

function mockContentOrFile(fakeReader) {
  return pathOrContent => contentOrFile(pathOrContent, {readFile: fakeReader});
}

function createGulpDumber(fakeFs = {}, opts = {}) {
  const fakeReader = buildReadFile(fakeFs);
  opts.packageLocator = mockLocator(fakeReader);
  opts.mock = {
    resolve: mockResolve,
    contentOrFile: mockContentOrFile(fakeReader)
  };
  return gulpDumber(opts);
}

test('gulpDumber bundles js', t => {
  let filenameMap;

  const dr = createGulpDumber({
    'node_modules/foo/package.json': '{"name":"foo","main":"index"}',
    'node_modules/foo/index.js': 'define([],function(){});',
    'node_modules/dumber-module-loader/dist/index.js': 'dumber-module-loader;'
  }, {
    cache: false,
    onManifest: function(m) {
      filenameMap = m;
    }
  });

  const a = new Vinyl({
    cwd,
    base: path.join(cwd, 'src'),
    path: path.join(cwd, 'src', 'app.js'),
    contents: new Buffer("define(['foo'],function(){});")
  });

  streamArray([a])
  .pipe(dr())
  .pipe(streamAssert.length(1))
  .pipe(streamAssert.first(f => {
    t.deepEqual(filenameMap, {
      'entry-bundle.js': 'entry-bundle.js'
    });

    t.equal(f.path, path.join(cwd, '__output__', 'entry-bundle.js'));
    t.equal(f.contents.toString(), `dumber-module-loader;;
define.switchToUserSpace();;
define('app',['foo'],function(){});;
define.switchToPackageSpace();;
define('foo/index',[],function(){});define('foo',['foo/index'],function(m){return m;});
;
define.switchToUserSpace();;
requirejs.config({
  "baseUrl": REQUIREJS_BASE_URL || "dist",
  "bundles": {}
});
`);

  }))
  .pipe(streamAssert.end(t.end));
});

test('gulpDumber does not support streaming', t => {
  const dr = createGulpDumber({
    'node_modules/foo/package.json': '{"name":"foo","main":"index"}',
    'node_modules/foo/index.js': 'define([],function(){});',
    'node_modules/dumber-module-loader/dist/index.js': 'dumber-module-loader;'
  }, {cache: false});

  gulp.src('index.js', {buffer: false})
  .pipe(dr())
  .once('error', function (err) {
    t.equal(err.message, 'Streaming is not supported');
    t.end();
  });
});

test('gulpDumber does code splitting, and progressive bundling in watch mode', t => {
  let filenameMap;

  const dr = createGulpDumber({
    'node_modules/foo/package.json': '{"name":"foo","main":"index"}',
    'node_modules/foo/index.js': 'define([],function(){});',
    'node_modules/bar/package.json': '{"name":"bar","main":"index"}',
    'node_modules/bar/index.js': 'define([],function(){});',
    'node_modules/dumber-module-loader/dist/index.js': 'dumber-module-loader;'
  }, {
    hash: true,
    cache: false,
    onManifest: function(m) {
      filenameMap = m;
    },
    entryBundle: 'app-bundle.js', // .js is optional, it will be normalized by dumber
    codeSplit: (moduleId, packageName) => {
      if (packageName) return 'vendor-bundle';
      if (moduleId.startsWith('page')) return 'page-bundle';
    }
  });

  const a = new Vinyl({
    cwd,
    base: path.join(cwd, 'src'),
    path: path.join(cwd, 'src', 'app.js'),
    contents: new Buffer("define(['foo'],function(){});")
  });

  streamArray([a])
  .pipe(dr())
  .pipe(streamAssert.length(2))
  .pipe(streamAssert.first(f => {
    t.ok(filenameMap['app-bundle.js'].match(/^app-bundle\.[a-f0-9]{32}\.js$/));
    t.ok(filenameMap['vendor-bundle.js'].match(/^vendor-bundle\.[a-f0-9]{32}\.js$/));

    t.equal(f.path, path.join(cwd, '__output__', filenameMap['vendor-bundle.js']));
    t.equal(f.contents.toString(), `define.switchToPackageSpace();;
define('foo/index',[],function(){});define('foo',['foo/index'],function(m){return m;});
;
define.switchToUserSpace();`);
  }))
  .pipe(streamAssert.second(f => {
    t.equal(f.path, path.join(cwd, '__output__', filenameMap['app-bundle.js']));
    t.equal(f.contents.toString(), `dumber-module-loader;;
define.switchToUserSpace();;
define('app',['foo'],function(){});;
requirejs.config({
  "baseUrl": REQUIREJS_BASE_URL || "dist",
  "bundles": {
    "vendor-bundle": {
      "user": [],
      "package": [
        "foo",
        "foo/index"
      ]
    }
  },
  "paths": {
    "vendor-bundle": "${filenameMap['vendor-bundle.js']}"
  }
});
`);
  }));


  setTimeout(() => {
    const b = new Vinyl({
      cwd,
      base: path.join(cwd, 'src'),
      path: path.join(cwd, 'src', 'page/one.js'),
      contents: new Buffer("define(['bar'],function(){});")
    });

    streamArray([b])
    .pipe(dr())
    .pipe(streamAssert.length(3))
    .pipe(streamAssert.all(f => {
      t.ok(filenameMap['app-bundle.js'].match(/^app-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['vendor-bundle.js'].match(/^vendor-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['page-bundle.js'].match(/^page-bundle\.[a-f0-9]{32}\.js$/));

      if (f.path.includes('vendor-bundle')) {
        t.equal(f.path, path.join(cwd, '__output__', filenameMap['vendor-bundle.js']));
        t.equal(f.contents.toString(), `define.switchToPackageSpace();;
define('bar/index',[],function(){});define('bar',['bar/index'],function(m){return m;});
;
define('foo/index',[],function(){});define('foo',['foo/index'],function(m){return m;});
;
define.switchToUserSpace();`);
      } else if (f.path.includes('page-bundle')) {
        t.equal(f.path, path.join(cwd, '__output__', filenameMap['page-bundle.js']));
        t.equal(f.contents.toString(), `define.switchToUserSpace();;
define('page/one',['bar'],function(){});`);
      } else if (f.path.includes('app-bundle')) {
        t.equal(f.path, path.join(cwd, '__output__', filenameMap['app-bundle.js']));
        t.equal(f.contents.toString(), `dumber-module-loader;;
define.switchToUserSpace();;
define('app',['foo'],function(){});;
requirejs.config({
  "baseUrl": REQUIREJS_BASE_URL || "dist",
  "bundles": {
    "vendor-bundle": {
      "user": [],
      "package": [
        "bar",
        "bar/index",
        "foo",
        "foo/index"
      ]
    },
    "page-bundle": {
      "user": [
        "page/one"
      ],
      "package": []
    }
  },
  "paths": {
    "vendor-bundle": "${filenameMap['vendor-bundle.js']}",
    "page-bundle": "${filenameMap['page-bundle.js']}"
  }
});
`);
      }
    }));
  }, 100);

  setTimeout(() => {
    const c = new Vinyl({
      cwd,
      base: path.join(cwd, 'src'),
      path: path.join(cwd, 'src', 'app.js'),
      contents: new Buffer("define(['foo', 'bar'],function(){});")
    });

    const d = new Vinyl({
      cwd,
      base: path.join(cwd, 'src'),
      path: path.join(cwd, 'src', 'help.js'),
      contents: new Buffer("define([],function(){});")
    });

    streamArray([c, d])
    .pipe(dr())
    .pipe(streamAssert.length(1))
    .pipe(streamAssert.first(f => {
      t.ok(filenameMap['app-bundle.js'].match(/^app-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['vendor-bundle.js'].match(/^vendor-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['page-bundle.js'].match(/^page-bundle\.[a-f0-9]{32}\.js$/));

      t.equal(f.path, path.join(cwd, '__output__', filenameMap['app-bundle.js']));
      t.equal(f.contents.toString(), `dumber-module-loader;;
define.switchToUserSpace();;
define('app',['foo', 'bar'],function(){});;
define('help',[],function(){});;
requirejs.config({
  "baseUrl": REQUIREJS_BASE_URL || "dist",
  "bundles": {
    "vendor-bundle": {
      "user": [],
      "package": [
        "bar",
        "bar/index",
        "foo",
        "foo/index"
      ]
    },
    "page-bundle": {
      "user": [
        "page/one"
      ],
      "package": []
    }
  },
  "paths": {
    "vendor-bundle": "${filenameMap['vendor-bundle.js']}",
    "page-bundle": "${filenameMap['page-bundle.js']}"
  }
});
`);
    }))
    .pipe(streamAssert.end(t.end));
  }, 200);
});
