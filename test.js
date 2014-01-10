var accessToken = process.env.TOKEN;
var jsGithub = require('js-github');
var vm = require('vm');
var urlParse = require('url').parse;
var getMime = require('simple-mime')('application/octet-stream');
var http = require('http');

var repo = jsGithub("creationix/exploder", accessToken);
require('./.')(repo, compileModule);

http.createServer(onRequest).listen(8080, function () {
  console.log("Server listening at http://localhost:8080/");
});

function onRequest(req, res) {
  var end = res.end;
  res.end = function () {
    console.log(req.method, req.url, res.statusCode);
    return end.apply(this, arguments);
  };

  var root = getRoot();
  if (!root) return onError(new Error("root not loaded yet"));

    // Ensure the request is either HEAD or GET by rejecting everything else
  var head = req.method === "HEAD";
  if (!head && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "HEAD,GET");
    res.end();
    return;
  }

  var path = urlParse(req.url).pathname;
  var etag = req.headers['if-none-match'];

  repo.servePath(root, path, etag, onEntry);

  function onEntry(err, result) {
    if (result === undefined) return onError(err);
    if (result.redirect) {
      // User error requiring redirect
      res.statusCode = 301;
      res.setHeader("Location", result.redirect);
      res.end();
      return;
    }

    if (result.internalRedirect) {
      path = result.internalRedirect;
      res.setHeader("Location", path);
      return repo.servePath(root, path, etag, onEntry);
    }

    res.setHeader("ETag", result.etag);
    if (etag === result.etag) {
      // etag matches, no change
      res.statusCode = 304;
      res.end();
      return;
    }

    res.setHeader("Content-Type", result.mime || getMime(path));
    if (head) {
      return res.end();
    }
    result.fetch(function (err, body) {
      if (body === undefined) return onError(err);

      if (Buffer.isBuffer(body)) {
        res.setHeader("Content-Length", body.length);
      }
      if (typeof body === "string") {
        res.setHeader("Content-Length", Buffer.byteLength(body));
      }
      res.end(body);
    });
  }

  function onError(err) {
    if (!err) {
      // Not found
      res.statusCode = 404;
      res.end("Not found in tree " + root + ": " + path + "\n");
      return;
    }
    // Server error
    res.statusCode = 500;
    res.end(err.stack + "\n");
    console.error(err.stack);
  }
}

function compileModule(js, filename) {
  var exports = {};
  var module = {exports:exports};
  var sandbox = {
    console: console,
    require: fakeRequire,
    module: module,
    exports: exports
  };
  vm.runInNewContext(js, sandbox, filename);
  // TODO: find a way to run this safely that doesn't crash the main process
  // when there are errors in the user-provided script.

  // Alternative implementation that doesn't use VM.
  // Function("module", "exports", "require", js)(module, exports, fakeRequire);
  return module.exports;
}

function fakeRequire(name) {
  if (name === "sha1") return require('js-git/lib/sha1.js');
  if (name === "parallel") return require('js-git/lib/parallel.js');
  if (name === "path-join") return require('js-linker/pathjoin.js');
  throw new Error("Invalid require in sandbox: " + name);
}

// Get the root, but throttle request rate.
var root;
var last;
repo.loadAs("commit", "refs/heads/master", onRoot);
function getRoot() {
  if (Date.now() - last > 500) repo.loadAs("commit", "refs/heads/master", onRoot);
  return root;
}
function onRoot(err, commit) {
  last = Date.now();
  if (err) console.error(err.stack);
  if (commit) root = commit.tree;
}
