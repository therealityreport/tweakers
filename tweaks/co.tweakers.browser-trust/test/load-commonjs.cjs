"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCommonJs(entryPath, overrides = {}) {
  const cache = new Map();

  function load(filePath) {
    const resolved = resolveFile(filePath);
    if (cache.has(resolved)) return cache.get(resolved).exports;

    const module = { exports: {} };
    cache.set(resolved, module);
    const source = fs.readFileSync(resolved, "utf8");
    const wrapper = vm.runInThisContext(
      `(function (require, module, exports, __filename, __dirname) {\n${source}\n})`,
      { filename: resolved },
    );
    const localRequire = (specifier) => {
      if (Object.prototype.hasOwnProperty.call(overrides, specifier)) {
        const replacement = overrides[specifier];
        return typeof replacement === "function" && replacement.__testFactory === true
          ? replacement()
          : replacement;
      }
      if (specifier.startsWith(".")) return load(path.resolve(path.dirname(resolved), specifier));
      return require(specifier);
    };
    wrapper(localRequire, module, module.exports, resolved, path.dirname(resolved));
    return module.exports;
  }

  return load(entryPath);
}

function resolveFile(candidate) {
  for (const file of [candidate, `${candidate}.js`, `${candidate}.cjs`]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.realpathSync(file);
  }
  throw new Error(`Cannot resolve CommonJS test target: ${candidate}`);
}

module.exports = { loadCommonJs };
