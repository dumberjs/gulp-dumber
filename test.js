'use strict';
const test = require('tape');
const fs = require('fs');
const {Readable} = require('stream');
const Vinyl = require('vinyl');
const streamAssert = require('stream-assert');
const gulpDumber = require('./index');
const {contentOrFile} = require('dumber/lib/shared');
const path = require('path');
const _defaultFileReader = require('dumber/lib/package-file-reader/default');
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

function mockReader(fakeReader) {
  return packageConfig => _defaultFileReader(packageConfig, {resolve: mockResolve, readFile: fakeReader});
}

function mockContentOrFile(fakeReader) {
  return pathOrContent => contentOrFile(pathOrContent, {readFile: fakeReader});
}

function createGulpDumber(fakeFs = {}, opts = {}) {
  const fakeReader = buildReadFile(fakeFs);
  opts.packageFileReader = mockReader(fakeReader);
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
    'node_modules/dumber-module-loader/dist/index.debug.js': 'dumber-module-loader;',
    'node_modules/base64-arraybuffer/package.json': '{"name":"base64-arraybuffer","main":"index"}',
    'node_modules/base64-arraybuffer/index.js': 'define([],function(){});',
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
    contents: Buffer.from("define(['foo'],function(){});")
  });

  const b = new Vinyl({
    cwd,
    base: path.join(cwd, 'src'),
    path: path.join(cwd, 'src', 'fib.wasm'),
    contents: fs.readFileSync(path.join(cwd, 'fib.wasm'))
  });

  Readable.from([a, b])
  .pipe(dr())
  .once('error', function (err) {
    t.fail(err.message);
    t.end();
  })
  .pipe(streamAssert.length(1))
  .pipe(streamAssert.first(f => {
    t.deepEqual(filenameMap, {
      'entry-bundle.js': 'entry-bundle.js'
    });

    t.equal(f.path, path.join(cwd, '__output__', 'entry-bundle.js'));
    t.equal(f.contents.toString(), `dumber-module-loader;
define.switchToUserSpace();
define('app.js',['foo'],function(){});
define('raw!fib.wasm',['base64-arraybuffer'],function(a){return {arrayBuffer: function() {return Promise.resolve(a.decode("AGFzbQEAAAABBgFgAX8BfwMCAQAHBwEDZmliAAAKHwEdACAAQQJIBEBBAQ8LIABBAmsQACAAQQFrEABqDws="));}}});
define.switchToPackageSpace();
define('base64-arraybuffer/index.js',[],function(){});
;define.alias('base64-arraybuffer','base64-arraybuffer/index.js');
define('foo/index.js',[],function(){});
;define.alias('foo','foo/index.js');
define.switchToUserSpace();
requirejs.config({
  "baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL : "/dist",
  "paths": {
    "../src": ""
  },
  "bundles": {}
});`);

    t.notOk(f.sourceMap);
  }))
  .pipe(streamAssert.end(t.end));
});

test('gulpDumber bundles js with above surface module', t => {
  let filenameMap;

  const dr = createGulpDumber({
    'node_modules/foo/package.json': '{"name":"foo","main":"index"}',
    'node_modules/foo/index.js': 'define([],function(){});',
    'node_modules/dumber-module-loader/dist/index.debug.js': 'dumber-module-loader;'
  }, {
    cache: false,
    paths: {
      foo: 'common/foo'
    },
    onManifest: function(m) {
      filenameMap = m;
    },
    appends: [
      "requirejs(['../test/app.spec']);"
    ]
  });

  const a = new Vinyl({
    cwd,
    base: path.join(cwd, 'src'),
    path: path.join(cwd, 'src', 'app.js'),
    contents: Buffer.from("define(['foo'],function(){});")
  });

  const b = new Vinyl({
    cwd,
    base: path.join(cwd, 'test'),
    path: path.join(cwd, 'test', 'app.spec.js'),
    contents: Buffer.from("define(['../src/app'],function(){});")
  });

  const c = new Vinyl({
    cwd,
    base: path.join(cwd, 'src'),
    path: path.join(cwd, 'src', 'common', 'foo.js'),
    contents: Buffer.from("define([],function(){});")
  });

  Readable.from([a, b, c])
  .pipe(dr())
  .once('error', function (err) {
    t.fail(err.message);
    t.end();
  })
  .pipe(streamAssert.length(1))
  .pipe(streamAssert.first(f => {
    t.deepEqual(filenameMap, {
      'entry-bundle.js': 'entry-bundle.js'
    });

    t.equal(f.path, path.join(cwd, '__output__', 'entry-bundle.js'));
    t.equal(f.contents.toString(), `dumber-module-loader;
define.switchToUserSpace();
define('../test/app.spec.js',['../src/app'],function(){});
define('app.js',['foo'],function(){});
define('common/foo.js',[],function(){});
requirejs.config({
  "baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL : "/dist",
  "paths": {
    "foo": "common/foo",
    "../src": ""
  },
  "bundles": {}
});
requirejs(['../test/app.spec']);`);
    t.notOk(f.sourceMap);
  }))
  .pipe(streamAssert.end(t.end));
});

test('gulpDumber does not support streaming', t => {
  const dr = createGulpDumber({
    'node_modules/foo/package.json': '{"name":"foo","main":"index"}',
    'node_modules/foo/index.js': 'define([],function(){});',
    'node_modules/dumber-module-loader/dist/index.debug.js': 'dumber-module-loader;'
  }, {cache: false});

  Readable.from([new Vinyl({
    cwd: cwd,
    base: cwd,
    path: path.join(cwd, 'index.js'),
    contents: fs.createReadStream('index.js')
  })])
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
    'node_modules/dumber-module-loader/dist/index.debug.js': 'dumber-module-loader;'
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
    contents: Buffer.from("define(['foo'],function(){});")
  });

  Readable.from([a])
  .pipe(dr())
  .once('error', function (err) {
    t.fail(err.message);
    t.end();
  })
  .pipe(streamAssert.length(2))
  .pipe(streamAssert.first(f => {
    t.ok(filenameMap['app-bundle.js'].match(/^app-bundle\.[a-f0-9]{32}\.js$/));
    t.ok(filenameMap['vendor-bundle.js'].match(/^vendor-bundle\.[a-f0-9]{32}\.js$/));

    t.equal(f.path, path.join(cwd, '__output__', filenameMap['vendor-bundle.js']));
    t.equal(f.contents.toString(), `define.switchToPackageSpace();
define('foo/index.js',[],function(){});
;define.alias('foo','foo/index.js');
define.switchToUserSpace();`);
  }))
  .pipe(streamAssert.second(f => {
    t.equal(f.path, path.join(cwd, '__output__', filenameMap['app-bundle.js']));
    t.equal(f.contents.toString(), `dumber-module-loader;
define.switchToUserSpace();
define('app.js',['foo'],function(){});
requirejs.config({
  "baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL : "/dist",
  "paths": {
    "../src": "",
    "vendor-bundle": "${filenameMap['vendor-bundle.js']}"
  },
  "bundles": {
    "vendor-bundle": {
      "user": [],
      "package": [
        "foo",
        "foo/index.js"
      ]
    }
  }
});`);
  }));


  setTimeout(() => {
    const b = new Vinyl({
      cwd,
      base: path.join(cwd, 'src'),
      path: path.join(cwd, 'src', 'page/one.js'),
      contents: Buffer.from("define(['bar'],function(){});")
    });

    Readable.from([b])
    .pipe(dr())
    .once('error', function (err) {
      t.fail(err.message);
      t.end();
    })
    .pipe(streamAssert.length(3))
    .pipe(streamAssert.all(f => {
      t.ok(filenameMap['app-bundle.js'].match(/^app-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['vendor-bundle.js'].match(/^vendor-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['page-bundle.js'].match(/^page-bundle\.[a-f0-9]{32}\.js$/));

      if (f.path.includes('vendor-bundle')) {
        t.equal(f.path, path.join(cwd, '__output__', filenameMap['vendor-bundle.js']));
        t.equal(f.contents.toString(), `define.switchToPackageSpace();
define('bar/index.js',[],function(){});
;define.alias('bar','bar/index.js');
define('foo/index.js',[],function(){});
;define.alias('foo','foo/index.js');
define.switchToUserSpace();`);
      } else if (f.path.includes('page-bundle')) {
        t.equal(f.path, path.join(cwd, '__output__', filenameMap['page-bundle.js']));
        t.equal(f.contents.toString(), `define.switchToUserSpace();
define('page/one.js',['bar'],function(){});`);
      } else if (f.path.includes('app-bundle')) {
        t.equal(f.path, path.join(cwd, '__output__', filenameMap['app-bundle.js']));
        t.equal(f.contents.toString(), `dumber-module-loader;
define.switchToUserSpace();
define('app.js',['foo'],function(){});
requirejs.config({
  "baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL : "/dist",
  "paths": {
    "../src": "",
    "vendor-bundle": "${filenameMap['vendor-bundle.js']}",
    "page-bundle": "${filenameMap['page-bundle.js']}"
  },
  "bundles": {
    "vendor-bundle": {
      "user": [],
      "package": [
        "bar",
        "bar/index.js",
        "foo",
        "foo/index.js"
      ]
    },
    "page-bundle": {
      "user": [
        "page/one.js"
      ],
      "package": []
    }
  }
});`);
      }
    }));
  }, 100);

  setTimeout(() => {
    const c = new Vinyl({
      cwd,
      base: path.join(cwd, 'src'),
      path: path.join(cwd, 'src', 'app.js'),
      contents: Buffer.from("define(['foo', 'bar'],function(){});")
    });

    const d = new Vinyl({
      cwd,
      base: path.join(cwd, 'src'),
      path: path.join(cwd, 'src', 'help.js'),
      contents: Buffer.from("define([],function(){});")
    });

    Readable.from([c, d])
    .pipe(dr())
    .once('error', function (err) {
      t.fail(err.message);
      t.end();
    })
    .pipe(streamAssert.length(1))
    .pipe(streamAssert.first(f => {
      t.ok(filenameMap['app-bundle.js'].match(/^app-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['vendor-bundle.js'].match(/^vendor-bundle\.[a-f0-9]{32}\.js$/));
      t.ok(filenameMap['page-bundle.js'].match(/^page-bundle\.[a-f0-9]{32}\.js$/));

      t.equal(f.path, path.join(cwd, '__output__', filenameMap['app-bundle.js']));
      t.equal(f.contents.toString(), `dumber-module-loader;
define.switchToUserSpace();
define('app.js',['foo', 'bar'],function(){});
define('help.js',[],function(){});
requirejs.config({
  "baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL : "/dist",
  "paths": {
    "../src": "",
    "vendor-bundle": "${filenameMap['vendor-bundle.js']}",
    "page-bundle": "${filenameMap['page-bundle.js']}"
  },
  "bundles": {
    "vendor-bundle": {
      "user": [],
      "package": [
        "bar",
        "bar/index.js",
        "foo",
        "foo/index.js"
      ]
    },
    "page-bundle": {
      "user": [
        "page/one.js"
      ],
      "package": []
    }
  }
});`);
    }))
    .pipe(streamAssert.end(t.end));
  }, 200);
});

test('gulpDumber does basic sourceMap', t => {
  let filenameMap;

  const dr = createGulpDumber({
    'node_modules/dumber-module-loader/dist/index.debug.js': 'dumber-module-loader;'
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
    contents: Buffer.from("define([],function(){});"),
    sourceMap: {
      version: 3,
      file: 'app.js',
      sources: ['app.js'],
      mappings: 'AAAA',
      sourcesContent: ["define([],function(){});"]
    }
  });

  const b = new Vinyl({
    cwd,
    base: path.join(cwd, 'src'),
    path: path.join(cwd, 'src', 'app.d.ts'),
    contents: Buffer.from("")
  });

  Readable.from([a, b])
  .pipe(dr())
  .once('error', function (err) {
    t.fail(err.message);
    t.end();
  })
  .pipe(streamAssert.length(1))
  .pipe(streamAssert.first(f => {
    t.deepEqual(filenameMap, {
      'entry-bundle.js': 'entry-bundle.js'
    });

    t.equal(f.path, path.join(cwd, '__output__', 'entry-bundle.js'));
    t.equal(f.contents.toString(), `dumber-module-loader;
define.switchToUserSpace();
define('app.js',[],function(){});
requirejs.config({
  "baseUrl": (typeof REQUIREJS_BASE_URL === "string") ? REQUIREJS_BASE_URL : "/dist",
  "paths": {
    "../src": ""
  },
  "bundles": {}
});`);
    t.ok(f.sourceMap);
    t.deepEqual(f.sourceMap.sources, ['node_modules/dumber-module-loader/dist/index.debug.js', 'src/app.js']);
    t.equal(f.sourceMap.file, 'entry-bundle.js');
    t.equal(f.sourceMap.sourcesContent.length, 2);
  }))
  .pipe(streamAssert.end(t.end));
});
