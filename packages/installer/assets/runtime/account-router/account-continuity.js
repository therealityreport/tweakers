"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/toml-eslint-parser/lib/internal-utils/index.js
var require_internal_utils = __commonJS({
  "node_modules/toml-eslint-parser/lib/internal-utils/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.last = last;
    exports2.toKeyName = toKeyName;
    function last(arr) {
      var _a;
      return (_a = arr[arr.length - 1]) !== null && _a !== void 0 ? _a : null;
    }
    function toKeyName(node) {
      return node.type === "TOMLBare" ? node.name : node.value;
    }
  }
});

// node_modules/toml-eslint-parser/lib/parser-options.js
var require_parser_options = __commonJS({
  "node_modules/toml-eslint-parser/lib/parser-options.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getTOMLVer = getTOMLVer;
    var TOMLVerImpl = class {
      constructor(major, minor) {
        this.major = major;
        this.minor = minor;
      }
      lt(major, minor) {
        return this.major < major || this.major === major && this.minor < minor;
      }
      gte(major, minor) {
        return this.major > major || this.major === major && this.minor >= minor;
      }
    };
    var TOML_VERSION_1_0 = new TOMLVerImpl(1, 0);
    var TOML_VERSION_1_1 = new TOMLVerImpl(1, 1);
    var DEFAULT_TOML_VERSION = TOML_VERSION_1_0;
    var SUPPORTED_TOML_VERSIONS = {
      "1.0": TOML_VERSION_1_0,
      "1.0.0": TOML_VERSION_1_0,
      "1.1": TOML_VERSION_1_1,
      "1.1.0": TOML_VERSION_1_1,
      latest: TOML_VERSION_1_1,
      next: TOML_VERSION_1_1
    };
    function getTOMLVer(v) {
      return v && SUPPORTED_TOML_VERSIONS[v] || DEFAULT_TOML_VERSION;
    }
  }
});

// node_modules/toml-eslint-parser/lib/errors.js
var require_errors = __commonJS({
  "node_modules/toml-eslint-parser/lib/errors.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ParseError = void 0;
    var MESSAGES = {
      "unterminated-string": "Unterminated string constant",
      "unterminated-table-key": "Unterminated table-key",
      "unterminated-array": "Unterminated array",
      "unterminated-inline-table": "Unterminated inline table",
      "missing-key": "Empty bare keys are not allowed",
      "missing-newline": "Must be a newline",
      "missing-equals-sign": "Expected equal (=) token",
      "missing-value": "Unspecified values are invalid",
      "missing-comma": "Expected comma (,) token",
      "dupe-keys": "Defining a key multiple times is invalid",
      "unexpected-char": "Unexpected character",
      "unexpected-token": "Unexpected token",
      "invalid-control-character": "Control characters (codes < 0x1f and 0x7f) are not allowed",
      "invalid-comment-character": "Invalid code point {{cp}} within comments",
      "invalid-key-value-newline": "The key, equals sign, and value must be on the same line",
      "invalid-inline-table-newline": "No newlines are allowed between the curly braces unless they are valid within a value",
      "invalid-underscore": "Underscores are allowed between digits",
      "invalid-space": "Unexpected spaces",
      "invalid-three-quotes": "Three or more quotes are not permitted",
      "invalid-date": "Unexpected invalid date",
      "invalid-time": "Unexpected invalid time",
      "invalid-leading-zero": "Leading zeros are not allowed",
      "invalid-trailing-comma-in-inline-table": "Trailing comma is not permitted in an inline table",
      "invalid-char-in-escape-sequence": "Invalid character in escape sequence",
      "invalid-consecutive-dots-in-key": "Consecutive dots are not permitted in keys",
      "invalid-code-point": "Invalid code point {{cp}}",
      "invalid-trailing-dot-in-key": "Keys cannot end with a dot",
      "invalid-leading-dot-in-key": "Keys cannot start with a dot"
    };
    function getMessage(code, data) {
      if (data) {
        return MESSAGES[code].replace(/\{\{(.*?)\}\}/gu, (_, name) => {
          if (name in data) {
            return data[name];
          }
          return `{{${name}}}`;
        });
      }
      return MESSAGES[code];
    }
    var ParseError = class extends SyntaxError {
      /**
       * Initialize this ParseError instance.
       *
       */
      constructor(code, offset, line, column, data) {
        super(getMessage(code, data));
        this.index = offset;
        this.lineNumber = line;
        this.column = column;
      }
    };
    exports2.ParseError = ParseError;
  }
});

// node_modules/toml-eslint-parser/lib/tokenizer/locs.js
var require_locs = __commonJS({
  "node_modules/toml-eslint-parser/lib/tokenizer/locs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Locations = void 0;
    function sortedLastIndex(array, value) {
      let low = 0;
      let high = array.length;
      while (low < high) {
        const mid = low + high >>> 1;
        const val = array[mid];
        if (val === value)
          return mid + 1;
        if (val < value) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    }
    var Locations = class {
      constructor() {
        this.offsets = [];
      }
      addOffset(offset) {
        for (let i = this.offsets.length - 1; i >= 0; i--) {
          const element = this.offsets[i];
          if (element === offset)
            return;
          if (element < offset)
            break;
        }
        this.offsets.push(offset);
      }
      /**
       * Calculate the location of the given index.
       * @param index The index to calculate their location.
       * @returns The location of the index.
       */
      getLocFromIndex(offset) {
        const line = sortedLastIndex(this.offsets, offset) + 1;
        const column = offset - (line === 1 ? 0 : this.offsets[line - 2]);
        return { line, column };
      }
    };
    exports2.Locations = Locations;
  }
});

// node_modules/toml-eslint-parser/lib/tokenizer/code-point-iterator.js
var require_code_point_iterator = __commonJS({
  "node_modules/toml-eslint-parser/lib/tokenizer/code-point-iterator.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CodePointIterator = void 0;
    var locs_1 = require_locs();
    var CodePointIterator = class {
      /**
       * Initialize this char iterator.
       */
      constructor(text) {
        this.locs = new locs_1.Locations();
        this.lastCodePoint = 0;
        this.start = -1;
        this.end = 0;
        this.text = text;
      }
      next() {
        if (this.lastCodePoint === -1) {
          return -1;
        }
        return this.lastCodePoint = this.moveAt(this.end);
      }
      getLocFromIndex(index) {
        return this.locs.getLocFromIndex(index);
      }
      eat(cp) {
        if (this.text.codePointAt(this.end) === cp) {
          this.next();
          return true;
        }
        return false;
      }
      moveAt(offset) {
        var _a;
        this.start = this.end = offset;
        const cp = (_a = this.text.codePointAt(this.start)) !== null && _a !== void 0 ? _a : -1;
        if (cp === -1) {
          this.end = this.start;
          return cp;
        }
        const shift = cp >= 65536 ? 2 : 1;
        this.end += shift;
        if (cp === 10) {
          this.locs.addOffset(this.end);
        } else if (cp === 13) {
          if (this.text.codePointAt(this.end) === 10) {
            this.end++;
            this.locs.addOffset(this.end);
          }
          return 10;
        }
        return cp;
      }
    };
    exports2.CodePointIterator = CodePointIterator;
  }
});

// node_modules/toml-eslint-parser/lib/tokenizer/code-point.js
var require_code_point = __commonJS({
  "node_modules/toml-eslint-parser/lib/tokenizer/code-point.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isControl = isControl;
    exports2.isWhitespace = isWhitespace;
    exports2.isEOL = isEOL;
    exports2.isLetter = isLetter;
    exports2.isDigit = isDigit;
    exports2.isHexDig = isHexDig;
    exports2.isOctalDig = isOctalDig;
    exports2.isHighSurrogate = isHighSurrogate;
    exports2.isLowSurrogate = isLowSurrogate;
    exports2.isUnicodeScalarValue = isUnicodeScalarValue;
    function isControl(cp) {
      return cp >= 0 && cp <= 31;
    }
    function isWhitespace(cp) {
      return cp === 9 || cp === 32;
    }
    function isEOL(cp) {
      return cp === 10 || cp === 13;
    }
    function isUpperLetter(cp) {
      return cp >= 65 && cp <= 90;
    }
    function isLowerLetter(cp) {
      return cp >= 97 && cp <= 122;
    }
    function isLetter(cp) {
      return isLowerLetter(cp) || isUpperLetter(cp);
    }
    function isDigit(cp) {
      return cp >= 48 && cp <= 57;
    }
    function isHexDig(cp) {
      return isDigit(cp) || cp >= 97 && cp <= 102 || cp >= 65 && cp <= 70;
    }
    function isOctalDig(cp) {
      return cp >= 48 && cp <= 55;
    }
    function isHighSurrogate(cp) {
      return cp >= 55296 && cp <= 57343;
    }
    function isLowSurrogate(cp) {
      return cp >= 56320 && cp <= 57343;
    }
    function isUnicodeScalarValue(cp) {
      return cp >= 0 && cp <= 55295 || cp >= 57344 && cp <= 1114111;
    }
  }
});

// node_modules/toml-eslint-parser/lib/tokenizer/tokenizer.js
var require_tokenizer = __commonJS({
  "node_modules/toml-eslint-parser/lib/tokenizer/tokenizer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Tokenizer = void 0;
    var errors_1 = require_errors();
    var parser_options_1 = require_parser_options();
    var code_point_iterator_1 = require_code_point_iterator();
    var code_point_1 = require_code_point();
    var HAS_BIGINT = typeof BigInt !== "undefined";
    var RADIX_PREFIXES = {
      16: "0x",
      10: "",
      8: "0o",
      2: "0b"
    };
    var ESCAPES_1_0 = {
      // escape-seq-char =  %x22         ; "    quotation mark  U+0022
      [
        34
        /* CodePoint.QUOTATION_MARK */
      ]: 34,
      // escape-seq-char =/ %x5C         ; \    reverse solidus U+005C
      [
        92
        /* CodePoint.BACKSLASH */
      ]: 92,
      // escape-seq-char =/ %x62         ; b    backspace       U+0008
      [
        98
        /* CodePoint.LATIN_SMALL_B */
      ]: 8,
      // escape-seq-char =/ %x66         ; f    form feed       U+000C
      [
        102
        /* CodePoint.LATIN_SMALL_F */
      ]: 12,
      // escape-seq-char =/ %x6E         ; n    line feed       U+000A
      [
        110
        /* CodePoint.LATIN_SMALL_N */
      ]: 10,
      // escape-seq-char =/ %x72         ; r    carriage return U+000D
      [
        114
        /* CodePoint.LATIN_SMALL_R */
      ]: 13,
      // escape-seq-char =/ %x74         ; t    tab             U+0009
      [
        116
        /* CodePoint.LATIN_SMALL_T */
      ]: 9
    };
    var ESCAPES_LATEST = Object.assign(Object.assign({}, ESCAPES_1_0), {
      // escape-seq-char =/ %x65         ; e    escape          U+001B
      // Added in TOML 1.1
      [
        101
        /* CodePoint.LATIN_SMALL_E */
      ]: 27
      /* CodePoint.ESCAPE */
    });
    var Tokenizer = class {
      /**
       * Initialize this tokenizer.
       */
      constructor(text, parserOptions) {
        this.backCode = false;
        this.lastCodePoint = 0;
        this.state = "DATA";
        this.token = null;
        this.tokenStart = -1;
        this.valuesEnabled = false;
        this.text = text;
        this.parserOptions = parserOptions || {};
        this.codePointIterator = new code_point_iterator_1.CodePointIterator(text);
        this.tomlVersion = (0, parser_options_1.getTOMLVer)(this.parserOptions.tomlVersion);
        this.ESCAPES = this.tomlVersion.gte(1, 1) ? ESCAPES_LATEST : ESCAPES_1_0;
      }
      get start() {
        return this.codePointIterator.start;
      }
      get end() {
        return this.codePointIterator.end;
      }
      getLocFromIndex(index) {
        return this.codePointIterator.getLocFromIndex(index);
      }
      /**
       * Report an invalid character error.
       */
      reportParseError(code, data) {
        const offset = this.codePointIterator.start;
        const loc = this.codePointIterator.getLocFromIndex(offset);
        throw new errors_1.ParseError(code, offset, loc.line, loc.column, data);
      }
      /**
       * Get the next token.
       */
      nextToken() {
        let token = this.token;
        if (token != null) {
          this.token = null;
          return token;
        }
        let cp = this.lastCodePoint;
        while (cp !== -1 && !this.token) {
          cp = this.nextCode();
          const nextState = this[this.state](cp);
          if (!nextState) {
            throw new Error(`Unknown error: pre state=${this.state}`);
          }
          this.state = nextState;
        }
        token = this.token;
        this.token = null;
        return token;
      }
      /**
       * Get the next code point.
       */
      nextCode() {
        if (this.lastCodePoint === -1) {
          return -1;
        }
        if (this.backCode) {
          this.backCode = false;
          return this.lastCodePoint;
        }
        return this.lastCodePoint = this.codePointIterator.next();
      }
      /**
       * Eat the next code point.
       */
      eatCode(cp) {
        if (this.lastCodePoint === -1) {
          return false;
        }
        if (this.backCode) {
          if (this.lastCodePoint === cp) {
            this.backCode = false;
            return true;
          }
          return false;
        }
        return this.codePointIterator.eat(cp);
      }
      /**
       * Moves the character position to the given position.
       */
      moveAt(loc) {
        if (this.backCode) {
          this.backCode = false;
        }
        this.lastCodePoint = this.codePointIterator.moveAt(loc);
      }
      /**
       * Back the current code point as the given state.
       */
      back(state) {
        this.backCode = true;
        return state;
      }
      punctuatorToken() {
        this.startToken();
        this.endToken("Punctuator", "end");
      }
      startToken() {
        this.tokenStart = this.codePointIterator.start;
      }
      /**
       * Commit the current token.
       */
      endToken(type, pos, option1, option2) {
        const { tokenStart } = this;
        const end = this.codePointIterator[pos];
        const range = [tokenStart, end];
        const loc = {
          start: this.codePointIterator.getLocFromIndex(tokenStart),
          end: this.codePointIterator.getLocFromIndex(end)
        };
        if (type === "Block") {
          this.token = {
            type,
            value: this.text.slice(tokenStart + 1, end),
            range,
            loc
          };
        } else {
          let token;
          const value = this.text.slice(tokenStart, end);
          if (type === "BasicString" || type === "LiteralString" || type === "MultiLineBasicString" || type === "MultiLineLiteralString") {
            token = {
              type,
              value,
              string: option1,
              range,
              loc
            };
          } else if (type === "Integer") {
            const text = option1;
            token = {
              type,
              value,
              number: parseInt(text, option2),
              bigint: HAS_BIGINT ? BigInt(RADIX_PREFIXES[option2] + text) : null,
              range,
              loc
            };
          } else if (type === "Float") {
            token = {
              type,
              value,
              number: option1,
              range,
              loc
            };
          } else if (type === "Boolean") {
            token = {
              type,
              value,
              boolean: option1,
              range,
              loc
            };
          } else if (type === "LocalDate" || type === "LocalTime" || type === "LocalDateTime" || type === "OffsetDateTime") {
            token = {
              type,
              value,
              date: option1,
              range,
              loc
            };
          } else {
            token = {
              type,
              value,
              range,
              loc
            };
          }
          this.token = token;
        }
      }
      DATA(cp) {
        while ((0, code_point_1.isWhitespace)(cp) || (0, code_point_1.isEOL)(cp)) {
          cp = this.nextCode();
        }
        if (cp === 35) {
          this.startToken();
          return "COMMENT";
        }
        if (cp === 34) {
          this.startToken();
          return "BASIC_STRING";
        }
        if (cp === 39) {
          this.startToken();
          return "LITERAL_STRING";
        }
        if (cp === 46 || // .
        cp === 61 || // =
        cp === 91 || // [
        cp === 93 || // ]
        cp === 123 || // {
        cp === 125 || // }
        cp === 44) {
          this.punctuatorToken();
          return "DATA";
        }
        if (this.valuesEnabled) {
          if (cp === 45 || cp === 43) {
            this.startToken();
            return "SIGN";
          }
          if (cp === 110 || cp === 105) {
            this.startToken();
            return this.back("NAN_OR_INF");
          }
          if ((0, code_point_1.isDigit)(cp)) {
            this.startToken();
            return this.back("NUMBER");
          }
          if (cp === 116 || cp === 102) {
            this.startToken();
            return this.back("BOOLEAN");
          }
        } else {
          if (isUnquotedKeyChar(cp, this.tomlVersion)) {
            this.startToken();
            return "BARE";
          }
        }
        if (cp === -1) {
          return "DATA";
        }
        return this.reportParseError("unexpected-char");
      }
      COMMENT(cp) {
        const processCommentChar = this.tomlVersion.gte(1, 1) ? (c) => {
          if (!isNonEOL(c)) {
            this.reportParseError("invalid-comment-character", {
              cp: JSON.stringify(String.fromCodePoint(c)).slice(1, -1)
            });
          }
        } : (c) => {
          if (isControlOtherThanTab(c)) {
            this.reportParseErrorControlChar();
          }
        };
        while (!(0, code_point_1.isEOL)(cp) && cp !== -1) {
          processCommentChar(cp);
          cp = this.nextCode();
        }
        this.endToken("Block", "start");
        return "DATA";
      }
      BARE(cp) {
        while (isUnquotedKeyChar(cp, this.tomlVersion)) {
          cp = this.nextCode();
        }
        this.endToken("Bare", "start");
        return this.back("DATA");
      }
      BASIC_STRING(cp) {
        if (cp === 34) {
          cp = this.nextCode();
          if (cp === 34) {
            return "MULTI_LINE_BASIC_STRING";
          }
          this.endToken("BasicString", "start", "");
          return this.back("DATA");
        }
        const out = [];
        while (cp !== 34 && cp !== -1 && cp !== 10) {
          if (isControlOtherThanTab(cp)) {
            return this.reportParseErrorControlChar();
          }
          if (cp === 92) {
            cp = this.nextCode();
            const ecp = this.ESCAPES[cp];
            if (ecp) {
              out.push(ecp);
              cp = this.nextCode();
              continue;
            } else if (cp === 117) {
              const code = this.parseUnicode(4);
              out.push(code);
              cp = this.nextCode();
              continue;
            } else if (cp === 85) {
              const code = this.parseUnicode(8);
              out.push(code);
              cp = this.nextCode();
              continue;
            } else if (cp === 120 && this.tomlVersion.gte(1, 1)) {
              const code = this.parseUnicode(2);
              out.push(code);
              cp = this.nextCode();
              continue;
            }
            return this.reportParseError("invalid-char-in-escape-sequence");
          }
          out.push(cp);
          cp = this.nextCode();
        }
        if (cp !== 34) {
          return this.reportParseError("unterminated-string");
        }
        this.endToken("BasicString", "end", String.fromCodePoint(...out));
        return "DATA";
      }
      MULTI_LINE_BASIC_STRING(cp) {
        const out = [];
        if (cp === 10) {
          cp = this.nextCode();
        }
        while (cp !== -1) {
          if (cp !== 10 && isControlOtherThanTab(cp)) {
            return this.reportParseErrorControlChar();
          }
          if (cp === 34) {
            const startPos = this.codePointIterator.start;
            if (this.eatCode(
              34
              /* CodePoint.QUOTATION_MARK */
            ) && this.eatCode(
              34
              /* CodePoint.QUOTATION_MARK */
            )) {
              if (this.eatCode(
                34
                /* CodePoint.QUOTATION_MARK */
              )) {
                out.push(
                  34
                  /* CodePoint.QUOTATION_MARK */
                );
                if (this.eatCode(
                  34
                  /* CodePoint.QUOTATION_MARK */
                )) {
                  out.push(
                    34
                    /* CodePoint.QUOTATION_MARK */
                  );
                  if (this.eatCode(
                    34
                    /* CodePoint.QUOTATION_MARK */
                  )) {
                    this.moveAt(startPos);
                    return this.reportParseError("invalid-three-quotes");
                  }
                }
              }
              this.endToken("MultiLineBasicString", "end", String.fromCodePoint(...out));
              return "DATA";
            }
            this.moveAt(startPos);
          }
          if (cp === 92) {
            cp = this.nextCode();
            const ecp = this.ESCAPES[cp];
            if (ecp) {
              out.push(ecp);
              cp = this.nextCode();
              continue;
            } else if (cp === 117) {
              const code = this.parseUnicode(4);
              out.push(code);
              cp = this.nextCode();
              continue;
            } else if (cp === 85) {
              const code = this.parseUnicode(8);
              out.push(code);
              cp = this.nextCode();
              continue;
            } else if (cp === 120 && this.tomlVersion.gte(1, 1)) {
              const code = this.parseUnicode(2);
              out.push(code);
              cp = this.nextCode();
              continue;
            } else if (cp === 10) {
              cp = this.nextCode();
              while ((0, code_point_1.isWhitespace)(cp) || cp === 10) {
                cp = this.nextCode();
              }
              continue;
            } else if ((0, code_point_1.isWhitespace)(cp)) {
              let valid = true;
              const startPos = this.codePointIterator.start;
              let nextCp;
              while ((nextCp = this.nextCode()) !== -1) {
                if (nextCp === 10) {
                  break;
                }
                if (!(0, code_point_1.isWhitespace)(nextCp)) {
                  this.moveAt(startPos);
                  valid = false;
                  break;
                }
              }
              if (valid) {
                cp = this.nextCode();
                while ((0, code_point_1.isWhitespace)(cp) || cp === 10) {
                  cp = this.nextCode();
                }
                continue;
              }
            }
            return this.reportParseError("invalid-char-in-escape-sequence");
          }
          out.push(cp);
          cp = this.nextCode();
        }
        return this.reportParseError("unterminated-string");
      }
      LITERAL_STRING(cp) {
        if (cp === 39) {
          cp = this.nextCode();
          if (cp === 39) {
            return "MULTI_LINE_LITERAL_STRING";
          }
          this.endToken("LiteralString", "start", "");
          return this.back("DATA");
        }
        const out = [];
        while (cp !== 39 && cp !== -1 && cp !== 10) {
          if (isControlOtherThanTab(cp)) {
            return this.reportParseErrorControlChar();
          }
          out.push(cp);
          cp = this.nextCode();
        }
        if (cp !== 39) {
          return this.reportParseError("unterminated-string");
        }
        this.endToken("LiteralString", "end", String.fromCodePoint(...out));
        return "DATA";
      }
      MULTI_LINE_LITERAL_STRING(cp) {
        const out = [];
        if (cp === 10) {
          cp = this.nextCode();
        }
        while (cp !== -1) {
          if (cp !== 10 && isControlOtherThanTab(cp)) {
            return this.reportParseErrorControlChar();
          }
          if (cp === 39) {
            const startPos = this.codePointIterator.start;
            if (this.eatCode(
              39
              /* CodePoint.SINGLE_QUOTE */
            ) && this.eatCode(
              39
              /* CodePoint.SINGLE_QUOTE */
            )) {
              if (this.eatCode(
                39
                /* CodePoint.SINGLE_QUOTE */
              )) {
                out.push(
                  39
                  /* CodePoint.SINGLE_QUOTE */
                );
                if (this.eatCode(
                  39
                  /* CodePoint.SINGLE_QUOTE */
                )) {
                  out.push(
                    39
                    /* CodePoint.SINGLE_QUOTE */
                  );
                  if (this.eatCode(
                    39
                    /* CodePoint.SINGLE_QUOTE */
                  )) {
                    this.moveAt(startPos);
                    return this.reportParseError("invalid-three-quotes");
                  }
                }
              }
              this.endToken("MultiLineLiteralString", "end", String.fromCodePoint(...out));
              return "DATA";
            }
            this.moveAt(startPos);
          }
          out.push(cp);
          cp = this.nextCode();
        }
        return this.reportParseError("unterminated-string");
      }
      SIGN(cp) {
        if (cp === 110 || cp === 105) {
          return this.back("NAN_OR_INF");
        }
        if ((0, code_point_1.isDigit)(cp)) {
          return this.back("NUMBER");
        }
        return this.reportParseError("unexpected-char");
      }
      NAN_OR_INF(cp) {
        if (cp === 110) {
          const startPos = this.codePointIterator.start;
          if (this.eatCode(
            97
            /* CodePoint.LATIN_SMALL_A */
          ) && this.eatCode(
            110
            /* CodePoint.LATIN_SMALL_N */
          )) {
            this.endToken("Float", "end", NaN);
            return "DATA";
          }
          this.moveAt(startPos);
        } else if (cp === 105) {
          const startPos = this.codePointIterator.start;
          if (this.eatCode(
            110
            /* CodePoint.LATIN_SMALL_N */
          ) && this.eatCode(
            102
            /* CodePoint.LATIN_SMALL_F */
          )) {
            this.endToken("Float", "end", this.text[this.tokenStart] === "-" ? -Infinity : Infinity);
            return "DATA";
          }
          this.moveAt(startPos);
        }
        return this.reportParseError("unexpected-char");
      }
      NUMBER(cp) {
        const start = this.text[this.tokenStart];
        const sign = start === "+" ? 43 : start === "-" ? 45 : 0;
        if (cp === 48) {
          if (sign === 0) {
            const startPos = this.codePointIterator.start;
            const nextCp2 = this.nextCode();
            if ((0, code_point_1.isDigit)(nextCp2)) {
              const nextNextCp = this.nextCode();
              if (nextNextCp === 58) {
                const data = {
                  hasDate: false,
                  year: 0,
                  month: 0,
                  day: 0,
                  hour: Number(String.fromCodePoint(48, nextCp2)),
                  minute: 0,
                  second: 0
                };
                this.data = data;
                return "TIME_MINUTE";
              }
              if ((0, code_point_1.isDigit)(nextNextCp)) {
                const nextNextNextCp = this.nextCode();
                if ((0, code_point_1.isDigit)(nextNextNextCp) && this.eatCode(
                  45
                  /* CodePoint.DASH */
                )) {
                  const data = {
                    hasDate: true,
                    year: Number(String.fromCodePoint(48, nextCp2, nextNextCp, nextNextNextCp)),
                    month: 0,
                    day: 0,
                    hour: 0,
                    minute: 0,
                    second: 0
                  };
                  this.data = data;
                  return "DATE_MONTH";
                }
              }
              this.moveAt(startPos);
              return this.reportParseError("invalid-leading-zero");
            }
            this.moveAt(startPos);
          }
          cp = this.nextCode();
          if (cp === 120 || cp === 111 || cp === 98) {
            if (sign !== 0) {
              return this.reportParseError("unexpected-char");
            }
            return cp === 120 ? "HEX" : cp === 111 ? "OCTAL" : "BINARY";
          }
          if (cp === 101 || cp === 69) {
            const data = {
              // Float values -0.0 and +0.0 are valid and should map according to IEEE 754.
              minus: sign === 45,
              left: [
                48
                /* CodePoint.DIGIT_0 */
              ]
            };
            this.data = data;
            return "EXPONENT_RIGHT";
          }
          if (cp === 46) {
            const data = {
              minus: sign === 45,
              absInt: [
                48
                /* CodePoint.DIGIT_0 */
              ]
            };
            this.data = data;
            return "FRACTIONAL_RIGHT";
          }
          this.endToken("Integer", "start", "0", 10);
          return this.back("DATA");
        }
        const { out, nextCp, hasUnderscore } = this.parseDigits(cp, code_point_1.isDigit);
        if (nextCp === 45 && sign === 0 && !hasUnderscore && out.length === 4) {
          const data = {
            hasDate: true,
            year: Number(String.fromCodePoint(...out)),
            month: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0
          };
          this.data = data;
          return "DATE_MONTH";
        }
        if (nextCp === 58 && sign === 0 && !hasUnderscore && out.length === 2) {
          const data = {
            hasDate: false,
            year: 0,
            month: 0,
            day: 0,
            hour: Number(String.fromCodePoint(...out)),
            minute: 0,
            second: 0
          };
          this.data = data;
          return "TIME_MINUTE";
        }
        if (nextCp === 101 || nextCp === 69) {
          const data = {
            minus: sign === 45,
            left: out
          };
          this.data = data;
          return "EXPONENT_RIGHT";
        }
        if (nextCp === 46) {
          const data = {
            minus: sign === 45,
            absInt: out
          };
          this.data = data;
          return "FRACTIONAL_RIGHT";
        }
        this.endToken("Integer", "start", sign === 45 ? String.fromCodePoint(45, ...out) : String.fromCodePoint(...out), 10);
        return this.back("DATA");
      }
      HEX(cp) {
        const { out } = this.parseDigits(cp, code_point_1.isHexDig);
        this.endToken("Integer", "start", String.fromCodePoint(...out), 16);
        return this.back("DATA");
      }
      OCTAL(cp) {
        const { out } = this.parseDigits(cp, code_point_1.isOctalDig);
        this.endToken("Integer", "start", String.fromCodePoint(...out), 8);
        return this.back("DATA");
      }
      BINARY(cp) {
        const { out } = this.parseDigits(
          cp,
          (c) => c === 48 || c === 49
          /* CodePoint.DIGIT_1 */
        );
        this.endToken("Integer", "start", String.fromCodePoint(...out), 2);
        return this.back("DATA");
      }
      FRACTIONAL_RIGHT(cp) {
        const { minus, absInt } = this.data;
        const { out, nextCp } = this.parseDigits(cp, code_point_1.isDigit);
        const absNum = [...absInt, 46, ...out];
        if (nextCp === 101 || nextCp === 69) {
          const data = {
            minus,
            left: absNum
          };
          this.data = data;
          return "EXPONENT_RIGHT";
        }
        const value = Number(minus ? String.fromCodePoint(45, ...absNum) : String.fromCodePoint(...absNum));
        this.endToken("Float", "start", value);
        return this.back("DATA");
      }
      EXPONENT_RIGHT(cp) {
        const { left, minus: leftMinus } = this.data;
        let minus = false;
        if (cp === 45 || cp === 43) {
          minus = cp === 45;
          cp = this.nextCode();
        }
        const { out } = this.parseDigits(cp, code_point_1.isDigit);
        const right = out;
        if (minus) {
          right.unshift(
            45
            /* CodePoint.DASH */
          );
        }
        const value = Number(leftMinus ? String.fromCodePoint(45, ...left, 101, ...right) : String.fromCodePoint(...left, 101, ...right));
        this.endToken("Float", "start", value);
        return this.back("DATA");
      }
      BOOLEAN(cp) {
        if (cp === 116) {
          const startPos = this.codePointIterator.start;
          if (this.eatCode(
            114
            /* CodePoint.LATIN_SMALL_R */
          ) && this.eatCode(
            117
            /* CodePoint.LATIN_SMALL_U */
          ) && this.eatCode(
            101
            /* CodePoint.LATIN_SMALL_E */
          )) {
            this.endToken("Boolean", "end", true);
            return "DATA";
          }
          this.moveAt(startPos);
        } else if (cp === 102) {
          const startPos = this.codePointIterator.start;
          if (this.eatCode(
            97
            /* CodePoint.LATIN_SMALL_A */
          ) && this.eatCode(
            108
            /* CodePoint.LATIN_SMALL_L */
          ) && this.eatCode(
            115
            /* CodePoint.LATIN_SMALL_S */
          ) && this.eatCode(
            101
            /* CodePoint.LATIN_SMALL_E */
          )) {
            this.endToken("Boolean", "end", false);
            return "DATA";
          }
          this.moveAt(startPos);
        }
        return this.reportParseError("unexpected-char");
      }
      DATE_MONTH(cp) {
        const start = this.codePointIterator.start;
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (cp !== 45) {
          return this.reportParseError("unexpected-char");
        }
        const end = this.codePointIterator.start;
        const data = this.data;
        data.month = Number(this.text.slice(start, end));
        return "DATE_DAY";
      }
      DATE_DAY(cp) {
        const start = this.codePointIterator.start;
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const end = this.codePointIterator.end;
        const data = this.data;
        data.day = Number(this.text.slice(start, end));
        if (!isValidDate(data.year, data.month, data.day)) {
          return this.reportParseError("invalid-date");
        }
        cp = this.nextCode();
        if (cp === 84 || cp === 116) {
          return "TIME_HOUR";
        }
        if (cp === 32) {
          const startPos = this.codePointIterator.start;
          if ((0, code_point_1.isDigit)(this.nextCode()) && (0, code_point_1.isDigit)(this.nextCode())) {
            this.moveAt(startPos);
            return "TIME_HOUR";
          }
          this.moveAt(startPos);
        }
        const dateValue = getDateFromDateTimeData(data, "");
        this.endToken("LocalDate", "start", dateValue);
        return this.back("DATA");
      }
      TIME_HOUR(cp) {
        const start = this.codePointIterator.start;
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (cp !== 58) {
          return this.reportParseError("unexpected-char");
        }
        const end = this.codePointIterator.start;
        const data = this.data;
        data.hour = Number(this.text.slice(start, end));
        return "TIME_MINUTE";
      }
      TIME_MINUTE(cp) {
        const start = this.codePointIterator.start;
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const end = this.codePointIterator.end;
        const data = this.data;
        data.minute = Number(this.text.slice(start, end));
        cp = this.nextCode();
        if (cp === 58) {
          return "TIME_SECOND";
        }
        if (this.tomlVersion.lt(1, 1)) {
          return this.reportParseError("unexpected-char");
        }
        if (!isValidTime(data.hour, data.minute, data.second)) {
          return this.reportParseError("invalid-time");
        }
        return this.processTimeEnd(cp, data);
      }
      TIME_SECOND(cp) {
        const start = this.codePointIterator.start;
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const end = this.codePointIterator.end;
        const data = this.data;
        data.second = Number(this.text.slice(start, end));
        if (!isValidTime(data.hour, data.minute, data.second)) {
          return this.reportParseError("invalid-time");
        }
        cp = this.nextCode();
        if (cp === 46) {
          return "TIME_SEC_FRAC";
        }
        return this.processTimeEnd(cp, data);
      }
      TIME_SEC_FRAC(cp) {
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const start = this.codePointIterator.start;
        while ((0, code_point_1.isDigit)(cp)) {
          cp = this.nextCode();
        }
        const end = this.codePointIterator.start;
        const data = this.data;
        data.frac = this.text.slice(start, end);
        return this.processTimeEnd(cp, data);
      }
      processTimeEnd(cp, data) {
        if (data.hasDate) {
          if (cp === 45 || cp === 43) {
            data.offsetSign = cp;
            return "TIME_OFFSET";
          }
          if (cp === 90 || cp === 122) {
            const dateValue3 = getDateFromDateTimeData(data, "Z");
            this.endToken("OffsetDateTime", "end", dateValue3);
            return "DATA";
          }
          const dateValue2 = getDateFromDateTimeData(data, "");
          this.endToken("LocalDateTime", "start", dateValue2);
          return this.back("DATA");
        }
        const dateValue = getDateFromDateTimeData(data, "");
        this.endToken("LocalTime", "start", dateValue);
        return this.back("DATA");
      }
      TIME_OFFSET(cp) {
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const hourStart = this.codePointIterator.start;
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (cp !== 58) {
          return this.reportParseError("unexpected-char");
        }
        const hourEnd = this.codePointIterator.start;
        cp = this.nextCode();
        const minuteStart = this.codePointIterator.start;
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        cp = this.nextCode();
        if (!(0, code_point_1.isDigit)(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const minuteEnd = this.codePointIterator.end;
        const hour = Number(this.text.slice(hourStart, hourEnd));
        const minute = Number(this.text.slice(minuteStart, minuteEnd));
        if (!isValidTime(hour, minute, 0)) {
          return this.reportParseError("invalid-time");
        }
        const data = this.data;
        const dateValue = getDateFromDateTimeData(data, `${String.fromCodePoint(data.offsetSign)}${padStart(hour, 2)}:${padStart(minute, 2)}`);
        this.endToken("OffsetDateTime", "end", dateValue);
        return "DATA";
      }
      parseDigits(cp, checkDigit) {
        if (cp === 95) {
          return this.reportParseError("invalid-underscore");
        }
        if (!checkDigit(cp)) {
          return this.reportParseError("unexpected-char");
        }
        const out = [];
        let before = 0;
        let hasUnderscore = false;
        while (checkDigit(cp) || cp === 95) {
          if (cp === 95) {
            hasUnderscore = true;
            if (before === 95) {
              return this.reportParseError("invalid-underscore");
            }
          } else {
            out.push(cp);
          }
          before = cp;
          cp = this.nextCode();
        }
        if (before === 95) {
          return this.reportParseError("invalid-underscore");
        }
        return {
          out,
          nextCp: cp,
          hasUnderscore
        };
      }
      parseUnicode(count) {
        const startLoc = this.codePointIterator.start;
        const start = this.codePointIterator.end;
        let charCount = 0;
        let cp;
        while ((cp = this.nextCode()) !== -1) {
          if (!(0, code_point_1.isHexDig)(cp)) {
            this.moveAt(startLoc);
            return this.reportParseError("invalid-char-in-escape-sequence");
          }
          charCount++;
          if (charCount >= count) {
            break;
          }
        }
        const end = this.codePointIterator.end;
        const code = this.text.slice(start, end);
        const codePoint = parseInt(code, 16);
        if (!(0, code_point_1.isUnicodeScalarValue)(codePoint)) {
          return this.reportParseError("invalid-code-point", { cp: code });
        }
        return codePoint;
      }
      reportParseErrorControlChar() {
        return this.reportParseError("invalid-control-character");
      }
    };
    exports2.Tokenizer = Tokenizer;
    function isUnquotedKeyChar(cp, tomlVersion) {
      if ((0, code_point_1.isLetter)(cp) || (0, code_point_1.isDigit)(cp) || cp === 95 || cp === 45) {
        return true;
      }
      if (tomlVersion.lt(1, 1)) {
        return false;
      }
      return false;
    }
    function isControlOtherThanTab(cp) {
      return (0, code_point_1.isControl)(cp) && cp !== 9 || cp === 127;
    }
    function isNonEOL(cp) {
      return cp === 9 || 32 <= cp && cp <= 126 || isNonAscii(cp);
    }
    function isNonAscii(cp) {
      return 128 <= cp && cp <= 55295 || 57344 <= cp && cp <= 1114111;
    }
    function isValidDate(y, m, d) {
      if (y >= 0 && m <= 12 && m >= 1 && d >= 1) {
        const maxDayOfMonth = m === 2 ? y & 3 || !(y % 25) && y & 15 ? 28 : 29 : 30 + (m + (m >> 3) & 1);
        return d <= maxDayOfMonth;
      }
      return false;
    }
    function isValidTime(h, m, s) {
      if (h >= 24 || h < 0 || m > 59 || m < 0 || s > 60 || s < 0) {
        return false;
      }
      return true;
    }
    function getDateFromDateTimeData(data, timeZone) {
      const year = padStart(data.year, 4);
      const month = data.month ? padStart(data.month, 2) : "01";
      const day = data.day ? padStart(data.day, 2) : "01";
      const hour = padStart(data.hour, 2);
      const minute = padStart(data.minute, 2);
      const second = padStart(data.second, 2);
      const textDate = `${year}-${month}-${day}`;
      const frac = data.frac ? `.${data.frac}` : "";
      const dateValue = /* @__PURE__ */ new Date(`${textDate}T${hour}:${minute}:${second}${frac}${timeZone}`);
      if (!isNaN(dateValue.getTime()) || data.second !== 60) {
        return dateValue;
      }
      return /* @__PURE__ */ new Date(`${textDate}T${hour}:${minute}:59${frac}${timeZone}`);
    }
    function padStart(num, maxLength) {
      return String(num).padStart(maxLength, "0");
    }
  }
});

// node_modules/toml-eslint-parser/lib/tokenizer/index.js
var require_tokenizer2 = __commonJS({
  "node_modules/toml-eslint-parser/lib/tokenizer/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    __exportStar(require_tokenizer(), exports2);
  }
});

// node_modules/toml-eslint-parser/lib/toml-parser/keys-resolver.js
var require_keys_resolver = __commonJS({
  "node_modules/toml-eslint-parser/lib/toml-parser/keys-resolver.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.KeysResolver = void 0;
    var internal_utils_1 = require_internal_utils();
    var KeysResolver = class {
      constructor(ctx) {
        this.rootKeys = /* @__PURE__ */ new Map();
        this.tables = [];
        this.ctx = ctx;
      }
      applyResolveKeyForTable(node) {
        let keys = this.rootKeys;
        const peekKeyIndex = node.key.keys.length - 1;
        for (let index = 0; index < peekKeyIndex; index++) {
          const keyNode = node.key.keys[index];
          const keyName = (0, internal_utils_1.toKeyName)(keyNode);
          node.resolvedKey.push(keyName);
          let keyStore = keys.get(keyName);
          if (!keyStore) {
            keyStore = { node: keyNode, keys: /* @__PURE__ */ new Map() };
            keys.set(keyName, keyStore);
          } else if (keyStore.table === "array") {
            const peekIndex = keyStore.peekIndex;
            node.resolvedKey.push(peekIndex);
            keyStore = keyStore.keys.get(peekIndex);
          }
          keys = keyStore.keys;
        }
        const lastKeyNode = node.key.keys[peekKeyIndex];
        const lastKeyName = (0, internal_utils_1.toKeyName)(lastKeyNode);
        node.resolvedKey.push(lastKeyName);
        const lastKeyStore = keys.get(lastKeyName);
        if (!lastKeyStore) {
          if (node.kind === "array") {
            node.resolvedKey.push(0);
            const newKeyStore = {
              node: lastKeyNode,
              keys: /* @__PURE__ */ new Map()
            };
            keys.set(lastKeyName, {
              table: node.kind,
              node: lastKeyNode,
              keys: /* @__PURE__ */ new Map([[0, newKeyStore]]),
              peekIndex: 0
            });
            this.tables.push({ node, keys: newKeyStore.keys });
          } else {
            const newKeyStore = {
              table: node.kind,
              node: lastKeyNode,
              keys: /* @__PURE__ */ new Map()
            };
            keys.set(lastKeyName, newKeyStore);
            this.tables.push({ node, keys: newKeyStore.keys });
          }
        } else if (!lastKeyStore.table) {
          if (node.kind === "array") {
            this.ctx.reportParseError("dupe-keys", lastKeyNode);
          } else {
            const transformKey = {
              table: node.kind,
              node: lastKeyNode,
              keys: lastKeyStore.keys
            };
            keys.set(lastKeyName, transformKey);
            this.tables.push({ node, keys: transformKey.keys });
          }
        } else if (lastKeyStore.table === "array") {
          if (node.kind === "array") {
            const newKeyStore = {
              node: lastKeyNode,
              keys: /* @__PURE__ */ new Map()
            };
            const newIndex = lastKeyStore.peekIndex + 1;
            node.resolvedKey.push(newIndex);
            lastKeyStore.keys.set(newIndex, newKeyStore);
            lastKeyStore.peekIndex = newIndex;
            this.tables.push({ node, keys: newKeyStore.keys });
          } else {
            this.ctx.reportParseError("dupe-keys", lastKeyNode);
          }
        } else {
          this.ctx.reportParseError("dupe-keys", lastKeyNode);
        }
      }
      verifyDuplicateKeys(node) {
        for (const body of node.body) {
          if (body.type === "TOMLKeyValue") {
            verifyDuplicateKeysForKeyValue(this.ctx, this.rootKeys, body);
          }
        }
        for (const { node: tableNode, keys } of this.tables) {
          for (const body of tableNode.body) {
            verifyDuplicateKeysForKeyValue(this.ctx, keys, body);
          }
        }
      }
    };
    exports2.KeysResolver = KeysResolver;
    function verifyDuplicateKeysForKeyValue(ctx, defineKeys, node) {
      let keys = defineKeys;
      const lastKey = (0, internal_utils_1.last)(node.key.keys);
      for (const keyNode of node.key.keys) {
        const key = (0, internal_utils_1.toKeyName)(keyNode);
        let defineKey = keys.get(key);
        if (defineKey) {
          if (defineKey.value === 0) {
            ctx.reportParseError("dupe-keys", getAfterNode(keyNode, defineKey.node));
          } else if (lastKey === keyNode) {
            ctx.reportParseError("dupe-keys", getAfterNode(keyNode, defineKey.node));
          } else if (defineKey.table) {
            ctx.reportParseError("dupe-keys", getAfterNode(keyNode, defineKey.node));
          }
          defineKey.value = 1;
        } else {
          if (lastKey === keyNode) {
            const keyStore = {
              value: 0,
              node: keyNode,
              keys: /* @__PURE__ */ new Map()
            };
            defineKey = keyStore;
          } else {
            const keyStore = {
              value: 1,
              node: keyNode,
              keys: /* @__PURE__ */ new Map()
            };
            defineKey = keyStore;
          }
          keys.set(key, defineKey);
        }
        keys = defineKey.keys;
      }
      if (node.value.type === "TOMLInlineTable") {
        verifyDuplicateKeysForInlineTable(ctx, keys, node.value);
      } else if (node.value.type === "TOMLArray") {
        verifyDuplicateKeysForArray(ctx, keys, node.value);
      }
    }
    function verifyDuplicateKeysForInlineTable(ctx, defineKeys, node) {
      for (const body of node.body) {
        verifyDuplicateKeysForKeyValue(ctx, defineKeys, body);
      }
    }
    function verifyDuplicateKeysForArray(ctx, defineKeys, node) {
      const keys = defineKeys;
      for (let index = 0; index < node.elements.length; index++) {
        const element = node.elements[index];
        let defineKey = keys.get(index);
        if (defineKey) {
          ctx.reportParseError("dupe-keys", getAfterNode(element, defineKey.node));
        } else {
          defineKey = {
            value: 0,
            node: element,
            keys: /* @__PURE__ */ new Map()
          };
          defineKeys.set(index, defineKey);
          if (element.type === "TOMLInlineTable") {
            verifyDuplicateKeysForInlineTable(ctx, defineKey.keys, element);
          } else if (element.type === "TOMLArray") {
            verifyDuplicateKeysForArray(ctx, defineKey.keys, element);
          }
        }
      }
    }
    function getAfterNode(a, b) {
      return a.range[0] <= b.range[0] ? b : a;
    }
  }
});

// node_modules/toml-eslint-parser/lib/toml-parser/context.js
var require_context = __commonJS({
  "node_modules/toml-eslint-parser/lib/toml-parser/context.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Context = void 0;
    var errors_1 = require_errors();
    var tokenizer_1 = require_tokenizer2();
    var keys_resolver_1 = require_keys_resolver();
    var Context = class {
      constructor(data) {
        this.tokens = [];
        this.comments = [];
        this.back = null;
        this.stateStack = [];
        this.needNewLine = false;
        this.needSameLine = false;
        this.currToken = null;
        this.prevToken = null;
        this.valueContainerStack = [];
        this.tokenizer = new tokenizer_1.Tokenizer(data.text, data.parserOptions);
        this.topLevelTable = data.topLevelTable;
        this.table = data.topLevelTable;
        this.keysResolver = new keys_resolver_1.KeysResolver(this);
      }
      /**
       * Get the next token.
       */
      nextToken(option) {
        this.prevToken = this.currToken;
        if (this.back) {
          this.currToken = this.back;
          this.back = null;
        } else {
          this.currToken = this._nextTokenFromTokenizer(option);
        }
        if ((this.needNewLine || this.needSameLine || (option === null || option === void 0 ? void 0 : option.needSameLine)) && this.prevToken && this.currToken) {
          if (this.prevToken.loc.end.line === this.currToken.loc.start.line) {
            if (this.needNewLine) {
              return this.reportParseError("missing-newline", this.currToken);
            }
          } else {
            const needSameLine = this.needSameLine || (option === null || option === void 0 ? void 0 : option.needSameLine);
            if (needSameLine) {
              return this.reportParseError(needSameLine, this.currToken);
            }
          }
        }
        this.needNewLine = false;
        this.needSameLine = false;
        return this.currToken;
      }
      _nextTokenFromTokenizer(option) {
        const valuesEnabled = this.tokenizer.valuesEnabled;
        if (option === null || option === void 0 ? void 0 : option.valuesEnabled) {
          this.tokenizer.valuesEnabled = option.valuesEnabled;
        }
        let token = this.tokenizer.nextToken();
        while (token && token.type === "Block") {
          this.comments.push(token);
          token = this.tokenizer.nextToken();
        }
        if (token) {
          this.tokens.push(token);
        }
        this.tokenizer.valuesEnabled = valuesEnabled;
        return token;
      }
      backToken() {
        if (this.back) {
          throw new Error("Illegal state");
        }
        this.back = this.currToken;
        this.currToken = this.prevToken;
      }
      addValueContainer(valueContainer) {
        this.valueContainerStack.push(valueContainer);
        this.tokenizer.valuesEnabled = true;
      }
      consumeValueContainer() {
        const valueContainer = this.valueContainerStack.pop();
        this.tokenizer.valuesEnabled = this.valueContainerStack.length > 0;
        return valueContainer;
      }
      applyResolveKeyForTable(node) {
        this.keysResolver.applyResolveKeyForTable(node);
      }
      verifyDuplicateKeys() {
        this.keysResolver.verifyDuplicateKeys(this.topLevelTable);
      }
      /**
       * Report an invalid token error.
       */
      reportParseError(code, token) {
        let offset, line, column;
        if (token) {
          offset = token.range[0];
          line = token.loc.start.line;
          column = token.loc.start.column;
        } else {
          offset = this.tokenizer.start;
          const startPos = this.tokenizer.getLocFromIndex(offset);
          line = startPos.line;
          column = startPos.column;
        }
        throw new errors_1.ParseError(code, offset, line, column);
      }
    };
    exports2.Context = Context;
  }
});

// node_modules/toml-eslint-parser/lib/toml-parser/index.js
var require_toml_parser = __commonJS({
  "node_modules/toml-eslint-parser/lib/toml-parser/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TOMLParser = void 0;
    var internal_utils_1 = require_internal_utils();
    var parser_options_1 = require_parser_options();
    var context_1 = require_context();
    var STATE_FOR_ERROR = {
      VALUE: "missing-value"
    };
    var STRING_VALUE_STYLE_MAP = {
      BasicString: "basic",
      MultiLineBasicString: "basic",
      LiteralString: "literal",
      MultiLineLiteralString: "literal"
    };
    var STRING_KEY_STYLE_MAP = {
      BasicString: "basic",
      LiteralString: "literal"
    };
    var DATETIME_VALUE_KIND_MAP = {
      OffsetDateTime: "offset-date-time",
      LocalDateTime: "local-date-time",
      LocalDate: "local-date",
      LocalTime: "local-time"
    };
    var TOMLParser = class {
      /**
       * Initialize this parser.
       */
      constructor(text, parserOptions) {
        this.text = text;
        this.parserOptions = parserOptions || {};
        this.tomlVersion = (0, parser_options_1.getTOMLVer)(this.parserOptions.tomlVersion);
      }
      /**
       * Parse TOML
       */
      parse() {
        const ast = {
          type: "Program",
          body: [],
          sourceType: "module",
          tokens: [],
          comments: [],
          parent: null,
          range: [0, 0],
          loc: {
            start: {
              line: 1,
              column: 0
            },
            end: {
              line: 1,
              column: 0
            }
          }
        };
        const node = {
          type: "TOMLTopLevelTable",
          body: [],
          parent: ast,
          range: cloneRange(ast.range),
          loc: cloneLoc(ast.loc)
        };
        ast.body = [node];
        const ctx = new context_1.Context({
          text: this.text,
          parserOptions: this.parserOptions,
          topLevelTable: node
        });
        let token = ctx.nextToken();
        if (token) {
          node.range[0] = token.range[0];
          node.loc.start = clonePos(token.loc.start);
          while (token) {
            const state2 = ctx.stateStack.pop() || "TABLE";
            ctx.stateStack.push(...this[state2](token, ctx));
            token = ctx.nextToken();
          }
          const state = ctx.stateStack.pop() || "TABLE";
          if (state in STATE_FOR_ERROR) {
            return ctx.reportParseError(STATE_FOR_ERROR[state], null);
          }
          if (ctx.table.type === "TOMLTable") {
            applyEndLoc(ctx.table, (0, internal_utils_1.last)(ctx.table.body));
          }
          applyEndLoc(node, (0, internal_utils_1.last)(node.body));
        }
        ctx.verifyDuplicateKeys();
        ast.tokens = ctx.tokens;
        ast.comments = ctx.comments;
        const endOffset = ctx.tokenizer.end;
        const endPos = ctx.tokenizer.getLocFromIndex(endOffset);
        ast.range[1] = endOffset;
        ast.loc.end = {
          line: endPos.line,
          column: endPos.column
        };
        return ast;
      }
      TABLE(token, ctx) {
        if (isBare(token) || isString(token)) {
          return this.processKeyValue(token, ctx.table, ctx);
        }
        if (isLeftBracket(token)) {
          return this.processTable(token, ctx.topLevelTable, ctx);
        }
        return ctx.reportParseError("unexpected-token", token);
      }
      VALUE(token, ctx) {
        if (isString(token) || isMultiLineString(token)) {
          return this.processStringValue(token, ctx);
        }
        if (isNumber(token)) {
          return this.processNumberValue(token, ctx);
        }
        if (isBoolean(token)) {
          return this.processBooleanValue(token, ctx);
        }
        if (isDateTime(token)) {
          return this.processDateTimeValue(token, ctx);
        }
        if (isLeftBracket(token)) {
          return this.processArray(token, ctx);
        }
        if (isLeftBrace(token)) {
          return this.processInlineTable(token, ctx);
        }
        return ctx.reportParseError("unexpected-token", token);
      }
      processTable(token, topLevelTableNode, ctx) {
        const tableNode = {
          type: "TOMLTable",
          kind: "standard",
          key: null,
          resolvedKey: [],
          body: [],
          parent: topLevelTableNode,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        if (ctx.table.type === "TOMLTable") {
          applyEndLoc(ctx.table, (0, internal_utils_1.last)(ctx.table.body));
        }
        topLevelTableNode.body.push(tableNode);
        ctx.table = tableNode;
        let targetToken = ctx.nextToken({
          needSameLine: "invalid-key-value-newline"
        });
        if (isLeftBracket(targetToken)) {
          if (token.range[1] < targetToken.range[0]) {
            return ctx.reportParseError("invalid-space", targetToken);
          }
          tableNode.kind = "array";
          targetToken = ctx.nextToken({
            needSameLine: "invalid-key-value-newline"
          });
        }
        if (isRightBracket(targetToken)) {
          return ctx.reportParseError("missing-key", targetToken);
        }
        if (!targetToken) {
          return ctx.reportParseError("unterminated-table-key", null);
        }
        const keyNodeData = this.processKeyNode(targetToken, tableNode, ctx);
        targetToken = keyNodeData.nextToken;
        if (!isRightBracket(targetToken)) {
          return ctx.reportParseError("unterminated-table-key", targetToken);
        }
        if (tableNode.kind === "array") {
          const rightBracket = targetToken;
          targetToken = ctx.nextToken({
            needSameLine: "invalid-key-value-newline"
          });
          if (!isRightBracket(targetToken)) {
            return ctx.reportParseError("unterminated-table-key", targetToken);
          }
          if (rightBracket.range[1] < targetToken.range[0]) {
            return ctx.reportParseError("invalid-space", targetToken);
          }
        }
        applyEndLoc(tableNode, targetToken);
        ctx.applyResolveKeyForTable(tableNode);
        ctx.needNewLine = true;
        return [];
      }
      processKeyValue(token, tableNode, ctx) {
        const keyValueNode = {
          type: "TOMLKeyValue",
          key: null,
          value: null,
          parent: tableNode,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        tableNode.body.push(keyValueNode);
        const { nextToken: targetToken } = this.processKeyNode(token, keyValueNode, ctx);
        if (!isEq(targetToken)) {
          return ctx.reportParseError("missing-equals-sign", targetToken);
        }
        ctx.addValueContainer({
          parent: keyValueNode,
          set: (valNode) => {
            keyValueNode.value = valNode;
            applyEndLoc(keyValueNode, valNode);
            ctx.needNewLine = true;
            return [];
          }
        });
        ctx.needSameLine = "invalid-key-value-newline";
        return ["VALUE"];
      }
      processKeyNode(token, parent, ctx) {
        if (isDot(token)) {
          ctx.reportParseError("invalid-leading-dot-in-key", token);
        }
        const keyNode = {
          type: "TOMLKey",
          keys: [],
          parent,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        parent.key = keyNode;
        let targetToken = token;
        let dotToken = null;
        do {
          if (isBare(targetToken)) {
            this.processBareKey(targetToken, keyNode);
          } else if (isString(targetToken)) {
            this.processStringKey(targetToken, keyNode);
          } else {
            break;
          }
          dotToken = null;
          targetToken = ctx.nextToken({
            needSameLine: "invalid-key-value-newline"
          });
          if (!isDot(targetToken))
            break;
          dotToken = targetToken;
          targetToken = ctx.nextToken({
            needSameLine: "invalid-key-value-newline"
          });
        } while (targetToken);
        if (dotToken) {
          ctx.reportParseError(isDot(targetToken) ? "invalid-consecutive-dots-in-key" : "invalid-trailing-dot-in-key", dotToken);
        }
        applyEndLoc(keyNode, (0, internal_utils_1.last)(keyNode.keys));
        return { keyNode, nextToken: targetToken };
      }
      processBareKey(token, keyNode) {
        const node = {
          type: "TOMLBare",
          name: token.value,
          parent: keyNode,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        keyNode.keys.push(node);
      }
      processStringKey(token, keyNode) {
        const node = {
          type: "TOMLQuoted",
          kind: "string",
          value: token.string,
          style: STRING_KEY_STYLE_MAP[token.type],
          multiline: false,
          parent: keyNode,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        keyNode.keys.push(node);
      }
      processStringValue(token, ctx) {
        const valueContainer = ctx.consumeValueContainer();
        const node = {
          type: "TOMLValue",
          kind: "string",
          value: token.string,
          style: STRING_VALUE_STYLE_MAP[token.type],
          multiline: isMultiLineString(token),
          parent: valueContainer.parent,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        return valueContainer.set(node);
      }
      processNumberValue(token, ctx) {
        const valueContainer = ctx.consumeValueContainer();
        const text = this.text;
        const [startRange, endRange] = token.range;
        let numberString = null;
        const getNumberText = () => {
          return numberString !== null && numberString !== void 0 ? numberString : numberString = text.slice(startRange, endRange).replace(/_/g, "");
        };
        let node;
        if (token.type === "Integer") {
          node = {
            type: "TOMLValue",
            kind: "integer",
            value: token.number,
            bigint: token.bigint,
            get number() {
              return getNumberText();
            },
            parent: valueContainer.parent,
            range: cloneRange(token.range),
            loc: cloneLoc(token.loc)
          };
        } else {
          node = {
            type: "TOMLValue",
            kind: "float",
            value: token.number,
            get number() {
              return getNumberText();
            },
            parent: valueContainer.parent,
            range: cloneRange(token.range),
            loc: cloneLoc(token.loc)
          };
        }
        return valueContainer.set(node);
      }
      processBooleanValue(token, ctx) {
        const valueContainer = ctx.consumeValueContainer();
        const node = {
          type: "TOMLValue",
          kind: "boolean",
          value: token.boolean,
          parent: valueContainer.parent,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        return valueContainer.set(node);
      }
      processDateTimeValue(token, ctx) {
        const valueContainer = ctx.consumeValueContainer();
        const node = {
          type: "TOMLValue",
          kind: DATETIME_VALUE_KIND_MAP[token.type],
          value: token.date,
          datetime: token.value,
          parent: valueContainer.parent,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        return valueContainer.set(node);
      }
      processArray(token, ctx) {
        const valueContainer = ctx.consumeValueContainer();
        const node = {
          type: "TOMLArray",
          elements: [],
          parent: valueContainer.parent,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        const nextToken = ctx.nextToken({ valuesEnabled: true });
        if (isRightBracket(nextToken)) {
          applyEndLoc(node, nextToken);
          return valueContainer.set(node);
        }
        ctx.backToken();
        return this.processArrayValue(node, valueContainer, ctx);
      }
      processArrayValue(node, valueContainer, ctx) {
        ctx.addValueContainer({
          parent: node,
          set: (valNode) => {
            node.elements.push(valNode);
            let nextToken = ctx.nextToken({ valuesEnabled: true });
            const hasComma = isComma(nextToken);
            if (hasComma) {
              nextToken = ctx.nextToken({ valuesEnabled: true });
            }
            if (isRightBracket(nextToken)) {
              applyEndLoc(node, nextToken);
              return valueContainer.set(node);
            }
            if (hasComma) {
              ctx.backToken();
              return this.processArrayValue(node, valueContainer, ctx);
            }
            return ctx.reportParseError(nextToken ? "missing-comma" : "unterminated-array", nextToken);
          }
        });
        return ["VALUE"];
      }
      processInlineTable(token, ctx) {
        const valueContainer = ctx.consumeValueContainer();
        const node = {
          type: "TOMLInlineTable",
          body: [],
          parent: valueContainer.parent,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        const needSameLine = this.tomlVersion.gte(1, 1) ? (
          // Line breaks in inline tables are allowed.
          // Added in TOML 1.1
          void 0
        ) : "invalid-inline-table-newline";
        const nextToken = ctx.nextToken({
          needSameLine
        });
        if (nextToken) {
          if (isBare(nextToken) || isString(nextToken)) {
            return this.processInlineTableKeyValue(nextToken, node, valueContainer, ctx);
          }
          if (isRightBrace(nextToken)) {
            applyEndLoc(node, nextToken);
            return valueContainer.set(node);
          }
        }
        return ctx.reportParseError("unexpected-token", nextToken);
      }
      processInlineTableKeyValue(token, inlineTableNode, valueContainer, ctx) {
        const keyValueNode = {
          type: "TOMLKeyValue",
          key: null,
          value: null,
          parent: inlineTableNode,
          range: cloneRange(token.range),
          loc: cloneLoc(token.loc)
        };
        inlineTableNode.body.push(keyValueNode);
        const { nextToken: targetToken } = this.processKeyNode(token, keyValueNode, ctx);
        if (!isEq(targetToken)) {
          return ctx.reportParseError("missing-equals-sign", targetToken);
        }
        const needSameLine = this.tomlVersion.gte(1, 1) ? (
          // Line breaks in inline tables are allowed.
          // Added in TOML 1.1
          void 0
        ) : "invalid-inline-table-newline";
        ctx.addValueContainer({
          parent: keyValueNode,
          set: (valNode) => {
            keyValueNode.value = valNode;
            applyEndLoc(keyValueNode, valNode);
            let nextToken = ctx.nextToken({ needSameLine });
            if (isComma(nextToken)) {
              nextToken = ctx.nextToken({ needSameLine });
              if (nextToken && (isBare(nextToken) || isString(nextToken))) {
                return this.processInlineTableKeyValue(nextToken, inlineTableNode, valueContainer, ctx);
              }
              if (isRightBrace(nextToken)) {
                if (this.tomlVersion.lt(1, 1)) {
                  return ctx.reportParseError("invalid-trailing-comma-in-inline-table", nextToken);
                }
              } else {
                return ctx.reportParseError(nextToken ? "unexpected-token" : "unterminated-inline-table", nextToken);
              }
            }
            if (isRightBrace(nextToken)) {
              applyEndLoc(inlineTableNode, nextToken);
              return valueContainer.set(inlineTableNode);
            }
            return ctx.reportParseError(nextToken ? "missing-comma" : "unterminated-inline-table", nextToken);
          }
        });
        ctx.needSameLine = "invalid-key-value-newline";
        return ["VALUE"];
      }
    };
    exports2.TOMLParser = TOMLParser;
    function isDot(token) {
      return isPunctuator(token) && token.value === ".";
    }
    function isEq(token) {
      return isPunctuator(token) && token.value === "=";
    }
    function isLeftBracket(token) {
      return isPunctuator(token) && token.value === "[";
    }
    function isRightBracket(token) {
      return isPunctuator(token) && token.value === "]";
    }
    function isLeftBrace(token) {
      return isPunctuator(token) && token.value === "{";
    }
    function isRightBrace(token) {
      return isPunctuator(token) && token.value === "}";
    }
    function isComma(token) {
      return isPunctuator(token) && token.value === ",";
    }
    function isPunctuator(token) {
      return Boolean(token && token.type === "Punctuator");
    }
    function isBare(token) {
      return token.type === "Bare";
    }
    function isString(token) {
      return token.type === "BasicString" || token.type === "LiteralString";
    }
    function isMultiLineString(token) {
      return token.type === "MultiLineBasicString" || token.type === "MultiLineLiteralString";
    }
    function isNumber(token) {
      return token.type === "Integer" || token.type === "Float";
    }
    function isBoolean(token) {
      return token.type === "Boolean";
    }
    function isDateTime(token) {
      return token.type === "OffsetDateTime" || token.type === "LocalDateTime" || token.type === "LocalDate" || token.type === "LocalTime";
    }
    function applyEndLoc(node, child) {
      if (child) {
        node.range[1] = child.range[1];
        node.loc.end = clonePos(child.loc.end);
      }
    }
    function cloneRange(range) {
      return [range[0], range[1]];
    }
    function cloneLoc(loc) {
      return {
        start: clonePos(loc.start),
        end: clonePos(loc.end)
      };
    }
    function clonePos(pos) {
      return {
        line: pos.line,
        column: pos.column
      };
    }
  }
});

// ../../node_modules/eslint-visitor-keys/dist/eslint-visitor-keys.cjs
var require_eslint_visitor_keys = __commonJS({
  "../../node_modules/eslint-visitor-keys/dist/eslint-visitor-keys.cjs"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var KEYS = {
      ArrayExpression: [
        "elements"
      ],
      ArrayPattern: [
        "elements"
      ],
      ArrowFunctionExpression: [
        "params",
        "body"
      ],
      AssignmentExpression: [
        "left",
        "right"
      ],
      AssignmentPattern: [
        "left",
        "right"
      ],
      AwaitExpression: [
        "argument"
      ],
      BinaryExpression: [
        "left",
        "right"
      ],
      BlockStatement: [
        "body"
      ],
      BreakStatement: [
        "label"
      ],
      CallExpression: [
        "callee",
        "arguments"
      ],
      CatchClause: [
        "param",
        "body"
      ],
      ChainExpression: [
        "expression"
      ],
      ClassBody: [
        "body"
      ],
      ClassDeclaration: [
        "id",
        "superClass",
        "body"
      ],
      ClassExpression: [
        "id",
        "superClass",
        "body"
      ],
      ConditionalExpression: [
        "test",
        "consequent",
        "alternate"
      ],
      ContinueStatement: [
        "label"
      ],
      DebuggerStatement: [],
      DoWhileStatement: [
        "body",
        "test"
      ],
      EmptyStatement: [],
      ExperimentalRestProperty: [
        "argument"
      ],
      ExperimentalSpreadProperty: [
        "argument"
      ],
      ExportAllDeclaration: [
        "exported",
        "source"
      ],
      ExportDefaultDeclaration: [
        "declaration"
      ],
      ExportNamedDeclaration: [
        "declaration",
        "specifiers",
        "source"
      ],
      ExportSpecifier: [
        "exported",
        "local"
      ],
      ExpressionStatement: [
        "expression"
      ],
      ForInStatement: [
        "left",
        "right",
        "body"
      ],
      ForOfStatement: [
        "left",
        "right",
        "body"
      ],
      ForStatement: [
        "init",
        "test",
        "update",
        "body"
      ],
      FunctionDeclaration: [
        "id",
        "params",
        "body"
      ],
      FunctionExpression: [
        "id",
        "params",
        "body"
      ],
      Identifier: [],
      IfStatement: [
        "test",
        "consequent",
        "alternate"
      ],
      ImportDeclaration: [
        "specifiers",
        "source"
      ],
      ImportDefaultSpecifier: [
        "local"
      ],
      ImportExpression: [
        "source"
      ],
      ImportNamespaceSpecifier: [
        "local"
      ],
      ImportSpecifier: [
        "imported",
        "local"
      ],
      JSXAttribute: [
        "name",
        "value"
      ],
      JSXClosingElement: [
        "name"
      ],
      JSXClosingFragment: [],
      JSXElement: [
        "openingElement",
        "children",
        "closingElement"
      ],
      JSXEmptyExpression: [],
      JSXExpressionContainer: [
        "expression"
      ],
      JSXFragment: [
        "openingFragment",
        "children",
        "closingFragment"
      ],
      JSXIdentifier: [],
      JSXMemberExpression: [
        "object",
        "property"
      ],
      JSXNamespacedName: [
        "namespace",
        "name"
      ],
      JSXOpeningElement: [
        "name",
        "attributes"
      ],
      JSXOpeningFragment: [],
      JSXSpreadAttribute: [
        "argument"
      ],
      JSXSpreadChild: [
        "expression"
      ],
      JSXText: [],
      LabeledStatement: [
        "label",
        "body"
      ],
      Literal: [],
      LogicalExpression: [
        "left",
        "right"
      ],
      MemberExpression: [
        "object",
        "property"
      ],
      MetaProperty: [
        "meta",
        "property"
      ],
      MethodDefinition: [
        "key",
        "value"
      ],
      NewExpression: [
        "callee",
        "arguments"
      ],
      ObjectExpression: [
        "properties"
      ],
      ObjectPattern: [
        "properties"
      ],
      PrivateIdentifier: [],
      Program: [
        "body"
      ],
      Property: [
        "key",
        "value"
      ],
      PropertyDefinition: [
        "key",
        "value"
      ],
      RestElement: [
        "argument"
      ],
      ReturnStatement: [
        "argument"
      ],
      SequenceExpression: [
        "expressions"
      ],
      SpreadElement: [
        "argument"
      ],
      StaticBlock: [
        "body"
      ],
      Super: [],
      SwitchCase: [
        "test",
        "consequent"
      ],
      SwitchStatement: [
        "discriminant",
        "cases"
      ],
      TaggedTemplateExpression: [
        "tag",
        "quasi"
      ],
      TemplateElement: [],
      TemplateLiteral: [
        "quasis",
        "expressions"
      ],
      ThisExpression: [],
      ThrowStatement: [
        "argument"
      ],
      TryStatement: [
        "block",
        "handler",
        "finalizer"
      ],
      UnaryExpression: [
        "argument"
      ],
      UpdateExpression: [
        "argument"
      ],
      VariableDeclaration: [
        "declarations"
      ],
      VariableDeclarator: [
        "id",
        "init"
      ],
      WhileStatement: [
        "test",
        "body"
      ],
      WithStatement: [
        "object",
        "body"
      ],
      YieldExpression: [
        "argument"
      ]
    };
    var NODE_TYPES = Object.keys(KEYS);
    for (const type of NODE_TYPES) {
      Object.freeze(KEYS[type]);
    }
    Object.freeze(KEYS);
    var KEY_BLACKLIST = /* @__PURE__ */ new Set([
      "parent",
      "leadingComments",
      "trailingComments"
    ]);
    function filterKey(key) {
      return !KEY_BLACKLIST.has(key) && key[0] !== "_";
    }
    function getKeys(node) {
      return Object.keys(node).filter(filterKey);
    }
    function unionWith(additionalKeys) {
      const retv = (
        /** @type {{
            [type: string]: ReadonlyArray<string>
        }} */
        Object.assign({}, KEYS)
      );
      for (const type of Object.keys(additionalKeys)) {
        if (Object.prototype.hasOwnProperty.call(retv, type)) {
          const keys = new Set(additionalKeys[type]);
          for (const key of retv[type]) {
            keys.add(key);
          }
          retv[type] = Object.freeze(Array.from(keys));
        } else {
          retv[type] = Object.freeze(Array.from(additionalKeys[type]));
        }
      }
      return Object.freeze(retv);
    }
    exports2.KEYS = KEYS;
    exports2.getKeys = getKeys;
    exports2.unionWith = unionWith;
  }
});

// node_modules/toml-eslint-parser/lib/visitor-keys.js
var require_visitor_keys = __commonJS({
  "node_modules/toml-eslint-parser/lib/visitor-keys.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.KEYS = void 0;
    var eslint_visitor_keys_1 = require_eslint_visitor_keys();
    var tomlKeys = {
      Program: ["body"],
      TOMLTopLevelTable: ["body"],
      TOMLTable: ["key", "body"],
      TOMLKeyValue: ["key", "value"],
      TOMLKey: ["keys"],
      TOMLArray: ["elements"],
      TOMLInlineTable: ["body"],
      TOMLBare: [],
      TOMLQuoted: [],
      TOMLValue: []
    };
    exports2.KEYS = (0, eslint_visitor_keys_1.unionWith)(tomlKeys);
  }
});

// node_modules/toml-eslint-parser/lib/parser.js
var require_parser = __commonJS({
  "node_modules/toml-eslint-parser/lib/parser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseForESLint = parseForESLint;
    var toml_parser_1 = require_toml_parser();
    var visitor_keys_1 = require_visitor_keys();
    function parseForESLint(code, options) {
      const parser = new toml_parser_1.TOMLParser(code, options);
      const ast = parser.parse();
      return {
        ast,
        visitorKeys: visitor_keys_1.KEYS,
        services: {
          isTOML: true
        }
      };
    }
  }
});

// node_modules/toml-eslint-parser/lib/traverse.js
var require_traverse = __commonJS({
  "node_modules/toml-eslint-parser/lib/traverse.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getFallbackKeys = getFallbackKeys;
    exports2.getKeys = getKeys;
    exports2.getNodes = getNodes;
    exports2.traverseNodes = traverseNodes;
    var visitor_keys_1 = require_visitor_keys();
    function fallbackKeysFilter(key) {
      let value = null;
      return key !== "comments" && key !== "leadingComments" && key !== "loc" && key !== "parent" && key !== "range" && key !== "tokens" && key !== "trailingComments" && (value = this[key]) !== null && typeof value === "object" && (typeof value.type === "string" || Array.isArray(value));
    }
    function getFallbackKeys(node) {
      return Object.keys(node).filter(fallbackKeysFilter, node);
    }
    function getKeys(node, visitorKeys) {
      const keys = (visitorKeys || visitor_keys_1.KEYS)[node.type] || getFallbackKeys(node);
      return keys.filter((key) => !getNodes(node, key).next().done);
    }
    function* getNodes(node, key) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (isNode(c)) {
            yield c;
          }
        }
      } else if (isNode(child)) {
        yield child;
      }
    }
    function isNode(x) {
      return x !== null && typeof x === "object" && typeof x.type === "string";
    }
    function traverse(node, parent, visitor) {
      visitor.enterNode(node, parent);
      const keys = getKeys(node, visitor.visitorKeys);
      for (const key of keys) {
        for (const child of getNodes(node, key)) {
          traverse(child, node, visitor);
        }
      }
      visitor.leaveNode(node, parent);
    }
    function traverseNodes(node, visitor) {
      traverse(node, null, visitor);
    }
  }
});

// node_modules/toml-eslint-parser/lib/utils.js
var require_utils = __commonJS({
  "node_modules/toml-eslint-parser/lib/utils.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getStaticTOMLValue = void 0;
    exports2.generateConvertTOMLValue = generateConvertTOMLValue;
    var internal_utils_1 = require_internal_utils();
    exports2.getStaticTOMLValue = generateConvertTOMLValue((node) => node.value);
    function generateConvertTOMLValue(convertValue) {
      function resolveValue(node, baseTable) {
        return resolver[node.type](node, baseTable);
      }
      const resolver = {
        Program(node, baseTable = {}) {
          return resolveValue(node.body[0], baseTable);
        },
        TOMLTopLevelTable(node, baseTable = {}) {
          for (const body of node.body) {
            resolveValue(body, baseTable);
          }
          return baseTable;
        },
        TOMLKeyValue(node, baseTable = {}) {
          const value = resolveValue(node.value);
          set(baseTable, resolveValue(node.key), value);
          return baseTable;
        },
        TOMLTable(node, baseTable = {}) {
          const table = getTable(baseTable, resolveValue(node.key), node.kind === "array");
          for (const body of node.body) {
            resolveValue(body, table);
          }
          return baseTable;
        },
        TOMLArray(node) {
          return node.elements.map((e) => resolveValue(e));
        },
        TOMLInlineTable(node) {
          const table = {};
          for (const body of node.body) {
            resolveValue(body, table);
          }
          return table;
        },
        TOMLKey(node) {
          return node.keys.map((key) => resolveValue(key));
        },
        TOMLBare(node) {
          return node.name;
        },
        TOMLQuoted(node) {
          return node.value;
        },
        TOMLValue(node) {
          return convertValue(node);
        }
      };
      return (node) => resolveValue(node);
    }
    function getTable(baseTable, keys, array) {
      let target = baseTable;
      for (let index = 0; index < keys.length - 1; index++) {
        const key = keys[index];
        target = getNextTargetFromKey(target, key);
      }
      const lastKey = (0, internal_utils_1.last)(keys);
      const lastTarget = target[lastKey];
      if (lastTarget == null) {
        const tableValue2 = {};
        target[lastKey] = array ? [tableValue2] : tableValue2;
        return tableValue2;
      }
      if (isValue(lastTarget)) {
        const tableValue2 = {};
        target[lastKey] = array ? [tableValue2] : tableValue2;
        return tableValue2;
      }
      if (!array) {
        if (Array.isArray(lastTarget)) {
          const tableValue2 = {};
          target[lastKey] = tableValue2;
          return tableValue2;
        }
        return lastTarget;
      }
      if (Array.isArray(lastTarget)) {
        const tableValue2 = {};
        lastTarget.push(tableValue2);
        return tableValue2;
      }
      const tableValue = {};
      target[lastKey] = [tableValue];
      return tableValue;
      function getNextTargetFromKey(currTarget, key) {
        const nextTarget = currTarget[key];
        if (nextTarget == null) {
          const val = {};
          currTarget[key] = val;
          return val;
        }
        if (isValue(nextTarget)) {
          const val = {};
          currTarget[key] = val;
          return val;
        }
        let resultTarget = nextTarget;
        while (Array.isArray(resultTarget)) {
          const lastIndex = resultTarget.length - 1;
          const nextElement = resultTarget[lastIndex];
          if (isValue(nextElement)) {
            const val = {};
            resultTarget[lastIndex] = val;
            return val;
          }
          resultTarget = nextElement;
        }
        return resultTarget;
      }
    }
    function set(baseTable, keys, value) {
      let target = baseTable;
      for (let index = 0; index < keys.length - 1; index++) {
        const key = keys[index];
        const nextTarget = target[key];
        if (nextTarget == null) {
          const val = {};
          target[key] = val;
          target = val;
        } else {
          if (isValue(nextTarget) || Array.isArray(nextTarget)) {
            const val = {};
            target[key] = val;
            target = val;
          } else {
            target = nextTarget;
          }
        }
      }
      target[(0, internal_utils_1.last)(keys)] = value;
    }
    function isValue(value) {
      return typeof value !== "object" || value instanceof Date;
    }
  }
});

// node_modules/toml-eslint-parser/lib/meta.js
var require_meta = __commonJS({
  "node_modules/toml-eslint-parser/lib/meta.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.version = exports2.name = void 0;
    exports2.name = "toml-eslint-parser";
    exports2.version = "0.12.0";
  }
});

// node_modules/toml-eslint-parser/lib/index.js
var require_lib = __commonJS({
  "node_modules/toml-eslint-parser/lib/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ (function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    })();
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getStaticTOMLValue = exports2.traverseNodes = exports2.VisitorKeys = exports2.parseForESLint = exports2.ParseError = exports2.name = exports2.meta = void 0;
    exports2.parseTOML = parseTOML2;
    var parser_1 = require_parser();
    Object.defineProperty(exports2, "parseForESLint", { enumerable: true, get: function() {
      return parser_1.parseForESLint;
    } });
    var traverse_1 = require_traverse();
    Object.defineProperty(exports2, "traverseNodes", { enumerable: true, get: function() {
      return traverse_1.traverseNodes;
    } });
    var utils_1 = require_utils();
    Object.defineProperty(exports2, "getStaticTOMLValue", { enumerable: true, get: function() {
      return utils_1.getStaticTOMLValue;
    } });
    var visitor_keys_1 = require_visitor_keys();
    var errors_1 = require_errors();
    Object.defineProperty(exports2, "ParseError", { enumerable: true, get: function() {
      return errors_1.ParseError;
    } });
    exports2.meta = __importStar(require_meta());
    var meta_1 = require_meta();
    Object.defineProperty(exports2, "name", { enumerable: true, get: function() {
      return meta_1.name;
    } });
    exports2.VisitorKeys = visitor_keys_1.KEYS;
    function parseTOML2(code, options) {
      return (0, parser_1.parseForESLint)(code, options).ast;
    }
  }
});

// src/account-router/account-continuity.ts
var account_continuity_exports = {};
__export(account_continuity_exports, {
  ACCOUNT_LOCAL_OAUTH_MUTATION_METHOD_V1: () => ACCOUNT_LOCAL_OAUTH_MUTATION_METHOD_V1,
  ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1: () => ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1,
  DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: () => DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
  abortUnpublishedSharedSourceRebase: () => abortUnpublishedSharedSourceRebase,
  bootstrapAccountContinuity: () => bootstrapAccountContinuity,
  bootstrapSharedPluginsManifest: () => bootstrapSharedPluginsManifest,
  captureAccountCapabilitiesAfterExit: () => captureAccountCapabilitiesAfterExit,
  captureAccountConfigAfterExit: () => captureAccountConfigAfterExit,
  captureIdleAccountChangesBeforeSpawn: () => captureIdleAccountChangesBeforeSpawn,
  captureUnmaterializedNativeChangesBeforeSpawn: () => captureUnmaterializedNativeChangesBeforeSpawn,
  ensureAccountContinuityEnrollment: () => ensureAccountContinuityEnrollment,
  isAccountScopedCapabilityMutationV1: () => isAccountScopedCapabilityMutationV1,
  loadAccountCapabilityOverrides: () => loadAccountCapabilityOverrides,
  loadAccountConfigOverrides: () => loadAccountConfigOverrides,
  loadAccountContinuitySharedSourceProvenanceV1: () => loadAccountContinuitySharedSourceProvenanceV1,
  loadSharedAccountBase: () => loadSharedAccountBase,
  loadSharedPluginsManifestV1: () => loadSharedPluginsManifestV1,
  observeExistingNativeAccountContinuity: () => observeExistingNativeAccountContinuity,
  parseLosslessTomlDocument: () => parseLosslessTomlDocument,
  prepareAccountConfigBeforeSpawn: () => prepareAccountConfigBeforeSpawn,
  projectPrimarySharedBase: () => projectPrimarySharedBase,
  publishPrimaryPluginInventoryAfterExit: () => publishPrimaryPluginInventoryAfterExit,
  publishPrimarySharedBaseAfterExit: () => publishPrimarySharedBaseAfterExit,
  readLosslessTomlDocument: () => readLosslessTomlDocument,
  rebaseAccountContinuitySharedSource: () => rebaseAccountContinuitySharedSource,
  renderResolvedAccountToml: () => renderResolvedAccountToml,
  resolveAccountCapabilities: () => resolveAccountCapabilities,
  resolveAccountConfig: () => resolveAccountConfig,
  scanCapabilityTree: () => scanCapabilityTree,
  validateAccountContinuityMaterialization: () => validateAccountContinuityMaterialization
});
module.exports = __toCommonJS(account_continuity_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_toml_eslint_parser = __toESM(require_lib());

// src/account-router/types.ts
function isOpaqueAccountId(value) {
  return typeof value === "string" && /^ar_[A-Za-z0-9_-]{43}$/.test(value);
}

// src/account-router/account-continuity.ts
var VERSION = 1;
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var MAX_CONFIG_BYTES = 2 * 1024 * 1024;
var MAX_METADATA_BYTES = 4 * 1024 * 1024;
var MAX_CAPABILITY_FILE_BYTES = 512 * 1024;
var MAX_CAPABILITY_TOTAL_BYTES = 8 * 1024 * 1024;
var MAX_CAPABILITY_FILES = 2048;
var MAX_CAPABILITY_DEPTH = 16;
var ACCOUNT_CONFIG_DIRECTORY = "shared-account-config";
var CONFIG_OVERRIDES_FILE = "config-overrides.v1.json";
var CAPABILITY_OVERRIDES_FILE = "capability-overrides.v1.json";
var MATERIALIZATION_FILE = "config-materialization.v1.json";
var MATERIALIZATION_INTENT_FILE = "config-materialization-intent.v1.json";
var CAPTURE_RECEIPT_FILE = "config-capture-receipt.v1.json";
var CAPABILITY_CAPTURE_RECEIPT_FILE = "capability-capture-receipt.v1.json";
var NATIVE_CAPTURE_INTENT_FILE = "native-initial-capture-intent.v1.json";
var NATIVE_CAPTURE_RECEIPT_FILE = "native-initial-capture-receipt.v1.json";
var BASE_FILE = "base.v1.json";
var BASE_RECEIPT_FILE = "base-source-receipt.v1.json";
var CAPABILITY_GENERATIONS_DIRECTORY = "capability-generations";
var CAPABILITY_MANIFEST_FILE = "manifest.v1.json";
var PLUGIN_GENERATIONS_DIRECTORY = "plugin-generations";
var PLUGIN_MANIFEST_FILE = "plugins.v1.json";
var PLUGIN_GENERATION_MANIFEST_FILE = "manifest.v1.json";
var CAPABILITY_OVERRIDE_FILES_DIRECTORY = "capability-override-files";
var BOOTSTRAP_RECEIPT_FILE = "bootstrap-receipt.v1.json";
var SHARED_SOURCE_REBASE_INTENT_FILE = "shared-source-rebase-intent.v1.json";
var SHARED_SOURCE_REBASE_RECEIPT_FILE = "shared-source-rebase-receipt.v1.json";
var DEFAULT_SHARED_TOP_LEVEL = [
  "model",
  "personality",
  "service_tier",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "developer_instructions",
  "web_search",
  "notify",
  "sandbox_mode",
  "approval_policy"
];
var DEFAULT_ALWAYS_LOCAL_TOP_LEVEL = [
  "cli_auth_credentials_store",
  "mcp_oauth_credentials_store"
];
var DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1 = {
  version: VERSION,
  schemaFingerprint: sha256Json({
    version: VERSION,
    authorizationClassificationRevision: 2,
    sharedTopLevel: DEFAULT_SHARED_TOP_LEVEL,
    alwaysLocalTopLevel: DEFAULT_ALWAYS_LOCAL_TOP_LEVEL
  }),
  sharedTopLevel: DEFAULT_SHARED_TOP_LEVEL,
  alwaysLocalTopLevel: DEFAULT_ALWAYS_LOCAL_TOP_LEVEL
};
var ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1 = /* @__PURE__ */ new Set([
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/value/write",
  "experimentalFeature/enablement/set",
  "skills/config/write",
  "skills/extraRoots/set",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
  "marketplace/upgrade"
]);
var ACCOUNT_LOCAL_OAUTH_MUTATION_METHOD_V1 = "mcpServer/oauth/login";
function isAccountScopedCapabilityMutationV1(method) {
  return ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1.has(method);
}
function sha256(bytes) {
  return `sha256:${(0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex")}`;
}
function sha256Json(value) {
  return sha256(stableJson(value));
}
function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (!isRecord(value)) throw new Error("account continuity refuses a non-serializable value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clone(value) {
  return structuredClone(value);
}
function pathKey(path) {
  return JSON.stringify(path);
}
function decodePathKey(key) {
  const parsed = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string" && !Number.isInteger(part))) throw new Error("invalid account continuity path key");
  return parsed;
}
function configPathKey(path) {
  if (path.length === 0 || path.some((part) => typeof part !== "string" || part.length === 0)) throw new Error("invalid account continuity config path");
  return pathKey(path);
}
function capabilityPathKey(path) {
  if (!isSafeCapabilityRelativePath(path)) throw new Error("unsafe account continuity capability path");
  return path;
}
function isTomlScalar(value) {
  const record = isRecord(value) ? value : void 0;
  return record !== void 0 && typeof record.type === "string" && ["string", "boolean", "integer", "float", "datetime"].includes(record.type);
}
function isTomlArray(value) {
  const record = isRecord(value) ? value : void 0;
  return record !== void 0 && record.type === "array" && Array.isArray(record.values);
}
function isTomlInlineTable(value) {
  const record = isRecord(value) ? value : void 0;
  return record !== void 0 && record.type === "inline-table" && isRecord(record.entries);
}
function isTomlArrayTable(value) {
  const record = isRecord(value) ? value : void 0;
  return record !== void 0 && record.type === "array-table" && Array.isArray(record.entries);
}
function isTomlDataValue(value) {
  return isTomlScalar(value) || isTomlArray(value) || isTomlInlineTable(value) || isTomlArrayTable(value);
}
function isTomlTable(value) {
  return value !== void 0 && isRecord(value) && !isTomlDataValue(value);
}
function compareToml(left, right) {
  if (left === void 0 || right === void 0) return left === right;
  return stableJson(left) === stableJson(right);
}
function renderTomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}
function renderTomlPath(path) {
  return path.map(renderTomlKey).join(".");
}
function renderTomlValue(value) {
  switch (value.type) {
    case "string":
      return JSON.stringify(value.value);
    case "boolean":
      return value.value ? "true" : "false";
    case "integer":
      return value.value;
    case "float":
      return value.value;
    case "datetime":
      return value.value;
    case "array":
      return `[${value.values.map(renderTomlValue).join(", ")}]`;
    case "inline-table":
      return `{ ${Object.keys(value.entries).sort().map((key) => {
        const child = value.entries[key];
        if (!isTomlDataValue(child)) throw new Error("inline TOML table cannot contain a standard table");
        return `${renderTomlKey(key)} = ${renderTomlValue(child)}`;
      }).join(", ")} }`;
    case "array-table":
      throw new Error("array-table values cannot appear on a TOML assignment");
  }
}
function astKeyPath(key) {
  return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}
function astValue(value) {
  if (value.type === "TOMLArray") return { type: "array", values: value.elements.map(astValue) };
  if (value.type === "TOMLInlineTable") {
    const entries = {};
    for (const entry of value.body) assignTomlNode(entries, astKeyPath(entry.key), astValue(entry.value));
    return { type: "inline-table", entries };
  }
  switch (value.kind) {
    case "string":
      return { type: "string", value: value.value };
    case "boolean":
      return { type: "boolean", value: value.value };
    case "integer":
      return { type: "integer", value: value.bigint.toString(10) };
    case "float": {
      if (!Number.isFinite(value.value)) throw new Error("account continuity rejects non-finite TOML floats");
      return { type: "float", value: value.number.replace(/_/g, "") };
    }
    case "offset-date-time":
    case "local-date-time":
    case "local-date":
    case "local-time":
      return { type: "datetime", kind: value.kind, value: value.datetime };
    default:
      throw new Error("account continuity rejects an unsupported TOML value");
  }
}
function ensureTomlTableAt(root, path) {
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    if (typeof part !== "string") throw new Error("TOML table path unexpectedly entered an array table");
    const existing = current[part];
    if (existing === void 0) {
      const next = {};
      current[part] = next;
      current = next;
      continue;
    }
    if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
    current = existing;
  }
  return current;
}
function assignTomlNode(root, path, value) {
  if (path.length === 0) throw new Error("empty TOML path");
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index];
    const nextPart = path[index + 1];
    if (typeof part !== "string") throw new Error("TOML key path may not start with an array index");
    let existing = current[part];
    if (typeof nextPart === "number") {
      if (existing === void 0) {
        existing = { type: "array-table", entries: [] };
        current[part] = existing;
      }
      if (!isTomlArrayTable(existing) || !existing.entries[nextPart]) throw new Error("invalid TOML array-table path");
      current = existing.entries[nextPart];
      index += 1;
      continue;
    }
    if (existing === void 0) {
      existing = {};
      current[part] = existing;
    }
    if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
    current = existing;
  }
  const terminal = path.at(-1);
  if (typeof terminal !== "string" || current[terminal] !== void 0) throw new Error("duplicate TOML key");
  current[terminal] = value;
}
function assignTomlTable(root, tablePath, kind) {
  if (tablePath.length === 0) throw new Error("empty TOML table path");
  let current = root;
  for (let index = 0; index < tablePath.length; index += 1) {
    const part = tablePath[index];
    const nextPart = tablePath[index + 1];
    if (typeof part !== "string") throw new Error("invalid TOML array table parent");
    if (index === tablePath.length - 1) {
      if (kind !== "standard") throw new Error("invalid TOML array table path");
      const existing2 = current[part];
      if (existing2 === void 0) {
        const next = {};
        current[part] = next;
        return next;
      }
      if (!isTomlTable(existing2)) throw new Error("TOML table/key collision");
      return existing2;
    }
    let existing = current[part];
    if (typeof nextPart === "number") {
      if (existing === void 0) {
        existing = { type: "array-table", entries: [] };
        current[part] = existing;
      }
      if (!isTomlArrayTable(existing)) throw new Error("TOML table/key collision");
      const entries = existing.entries;
      if (index + 1 === tablePath.length - 1 && kind === "array") {
        if (entries.length !== nextPart) throw new Error("invalid TOML array table order");
        const next = {};
        entries.push(next);
        return next;
      }
      const selected = entries[nextPart];
      if (!selected) throw new Error("invalid TOML array table path");
      current = selected;
      index += 1;
      continue;
    }
    if (existing === void 0) {
      existing = {};
      current[part] = existing;
    }
    if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
    current = existing;
  }
  throw new Error("invalid TOML table path");
}
function collectInlineAssignments(value, path, ownerPath, output) {
  if (value.type !== "TOMLInlineTable") return;
  for (const entry of value.body) {
    const childPath = [...path, ...astKeyPath(entry.key)];
    output[pathKey(childPath)] = {
      path: childPath,
      range: [entry.range[0], entry.range[1]],
      valueRange: [entry.value.range[0], entry.value.range[1]],
      ownerPath
    };
    collectInlineAssignments(entry.value, childPath, ownerPath, output);
  }
}
function parseLosslessTomlDocument(source) {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) throw new Error("account continuity config exceeds its bounded size");
  let ast;
  try {
    ast = (0, import_toml_eslint_parser.parseTOML)(source, { tomlVersion: "1.0.0" });
  } catch (error) {
    throw new Error(`account continuity rejected invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tree = {};
  const assignments = {};
  const tables = {};
  const body = ast.body[0]?.body ?? [];
  for (const node of body) {
    if (node.type === "TOMLKeyValue") {
      const path = astKeyPath(node.key);
      assignTomlNode(tree, path, astValue(node.value));
      assignments[pathKey(path)] = { path, range: [node.range[0], node.range[1]], valueRange: [node.value.range[0], node.value.range[1]], ownerPath: path };
      collectInlineAssignments(node.value, path, path, assignments);
      continue;
    }
    const tablePath = node.resolvedKey;
    const table = assignTomlTable(tree, tablePath, node.kind);
    tables[pathKey(tablePath)] = { path: tablePath, kind: node.kind, range: [node.range[0], node.range[1]] };
    for (const entry of node.body) {
      const path = [...tablePath, ...astKeyPath(entry.key)];
      assignTomlNode(table, astKeyPath(entry.key), astValue(entry.value));
      assignments[pathKey(path)] = { path, range: [entry.range[0], entry.range[1]], valueRange: [entry.value.range[0], entry.value.range[1]], ownerPath: path };
      collectInlineAssignments(entry.value, path, path, assignments);
    }
  }
  return { version: VERSION, source, tree, fingerprint: sha256(source), assignments, tables };
}
function readLosslessTomlDocument(path) {
  const bytes = readSafeRegularFile(path, MAX_CONFIG_BYTES, true, false);
  if (bytes === null) throw new Error("account continuity refused an unsafe config.toml");
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseLosslessTomlDocument(source);
  } finally {
    bytes.fill(0);
  }
}
function getTomlNode(root, path) {
  let current = root;
  for (const part of path) {
    if (!isTomlTable(current)) return void 0;
    current = current[part];
    if (current === void 0) return void 0;
  }
  return current;
}
function setTomlNode(root, path, value) {
  if (path.length === 0) throw new Error("empty TOML override path");
  const parent = ensureTomlTableAt(root, path.slice(0, -1));
  parent[path.at(-1)] = clone(value);
}
function deleteTomlNode(root, path) {
  if (path.length === 0) throw new Error("empty TOML override path");
  let current = root;
  const parents = [];
  for (const part of path.slice(0, -1)) {
    const node = current[part];
    if (!isTomlTable(node)) return;
    parents.push([current, part]);
    current = node;
  }
  delete current[path.at(-1)];
  for (const [parent, key] of parents.reverse()) {
    const node = parent[key];
    if (isTomlTable(node) && Object.keys(node).length === 0) delete parent[key];
  }
}
function flattenTomlLeaves(root, prefix = [], output = /* @__PURE__ */ new Map()) {
  for (const key of Object.keys(root)) {
    const value = root[key];
    const path = [...prefix, key];
    if (isTomlTable(value)) flattenTomlLeaves(value, path, output);
    else output.set(configPathKey(path), { path, value });
  }
  return output;
}
function isCanonicalProjectPath(value) {
  return value.length > 0 && value.length <= 4096 && !value.includes("\0") && (0, import_node_path.isAbsolute)(value) && (0, import_node_path.resolve)(value) === value;
}
function credentialShaped(value) {
  return /(?:^|[_-])(auth(?:orization)?|oauth|token|cookie|credential|secret|password|passwd|api[_-]?key|bearer|keychain)(?:$|[_-])/i.test(value) || /^(?:\.netrc|credentials?\.json|cookies?\.json|oauth\.json|tokens?\.json|secrets?\.json)$/i.test(value);
}
function containsLiteralAuthorization(value) {
  if (value === void 0) return false;
  if (isTomlArray(value)) return value.values.some(containsLiteralAuthorization);
  if (isTomlInlineTable(value)) return Object.entries(value.entries).some(([key, child]) => credentialShaped(key) || containsLiteralAuthorization(child));
  if (isTomlArrayTable(value)) return value.entries.some(containsLiteralAuthorization);
  if (isTomlTable(value)) return Object.entries(value).some(([key, child]) => credentialShaped(key) || containsLiteralAuthorization(child));
  if (!isTomlScalar(value) || value.type !== "string") return false;
  const text = value.value;
  if (/^(?:Bearer|Basic)\s+\S+/i.test(text)) return true;
  const assignment = /^(?:--?)?([^=\s]+)(?:=|$)/.exec(text);
  if (assignment && credentialShaped(assignment[1])) return true;
  const urlText = /[a-z][a-z0-9+.-]*:\/\/[^\s]+/i.exec(text)?.[0];
  if (urlText) {
    try {
      const url = new URL(urlText);
      if (url.username || url.password || [...url.searchParams.keys()].some(credentialShaped)) return true;
    } catch {
    }
  }
  return false;
}
function classifyTomlPath(path, schema, value) {
  const top = path[0];
  if (!top) return "local";
  const locals = /* @__PURE__ */ new Set([...DEFAULT_ALWAYS_LOCAL_TOP_LEVEL, ...schema.alwaysLocalTopLevel ?? []]);
  if (locals.has(top) || path.some(credentialShaped)) return "local";
  if (top === "features" || top === "model_provider" && path.length === 1) return "shared";
  if (top === "projects") return path.length >= 2 && isCanonicalProjectPath(path[1]) ? "shared" : "local";
  if ((top === "mcp_servers" || top === "model_providers" || top === "marketplaces") && containsLiteralAuthorization(value)) return "local";
  if (top === "mcp_servers" || top === "model_providers" || top === "plugins" || top === "marketplace" || top === "marketplaces") return "shared";
  const sharedTop = /* @__PURE__ */ new Set([...DEFAULT_SHARED_TOP_LEVEL, ...schema.sharedTopLevel ?? []]);
  return path.length === 1 && sharedTop.has(top) ? "shared" : "local";
}
function selectSharedTomlTree(tree, schema) {
  const selected = {};
  for (const { path, value } of flattenTomlLeaves(tree).values()) {
    if (classifyTomlPath(path, schema, value) === "shared") setTomlNode(selected, path, value);
  }
  const servers = getTomlNode(selected, ["mcp_servers"]);
  if (isTomlTable(servers)) {
    for (const [name, server] of Object.entries(servers)) {
      const original = getTomlNode(tree, ["mcp_servers", name]);
      if (isTomlTable(server) && isTomlTable(original) && (original.url !== void 0 || original.command !== void 0) && server.url === void 0 && server.command === void 0) deleteTomlNode(selected, ["mcp_servers", name]);
    }
  }
  return selected;
}
function preservationFingerprint(tree, schema) {
  const fields = {};
  for (const { path, value } of flattenTomlLeaves(tree).values()) {
    if (classifyTomlPath(path, schema, value) === "local") fields[configPathKey(path)] = value;
  }
  return sha256Json(fields);
}
function baseConfigFingerprint(generation, schemaFingerprint, tree) {
  return sha256Json({ version: VERSION, generation, schemaFingerprint, tree });
}
function capabilityManifestFingerprint(generation, files) {
  return sha256Json({
    version: VERSION,
    generation,
    files: [...files].map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  });
}
function accountConfigOverridesFingerprint(value) {
  return sha256Json({
    version: value.version,
    opaqueAccountId: value.opaqueAccountId,
    revision: value.revision,
    basedOnSharedGeneration: value.basedOnSharedGeneration,
    operations: value.operations,
    preservationFingerprint: value.preservationFingerprint
  });
}
function accountCapabilityOverridesFingerprint(value) {
  return sha256Json({
    version: value.version,
    opaqueAccountId: value.opaqueAccountId,
    revision: value.revision,
    basedOnSharedGeneration: value.basedOnSharedGeneration,
    operations: value.operations,
    preservationFingerprint: value.preservationFingerprint
  });
}
function validateConfigOperations(operations) {
  const seen = /* @__PURE__ */ new Set();
  for (const operation of operations) {
    const key = configPathKey(operation.path);
    if (seen.has(key)) throw new Error("duplicate account continuity config override");
    seen.add(key);
    if (operation.op === "set" && !isTomlDataValue(operation.value) && !isTomlTable(operation.value)) {
      throw new Error("invalid account continuity config override value");
    }
  }
  const paths = operations.map((operation) => operation.path);
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (pathsOverlapBySegments(paths[left], paths[right])) throw new Error("overlapping account continuity config overrides");
    }
  }
}
function pathsOverlapBySegments(left, right) {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function normalizeConfigOperations(operations) {
  validateConfigOperations(operations);
  return [...operations].map((operation) => clone(operation)).sort((left, right) => configPathKey(left.path).localeCompare(configPathKey(right.path)));
}
function buildConfigOverrides(opaqueAccountId, generation, tree, schema, prior) {
  const operations = [];
  for (const { path, value } of flattenTomlLeaves(tree).values()) {
    if (classifyTomlPath(path, schema, value) === "shared") operations.push({ path, op: "set", value: clone(value) });
  }
  const draft = {
    version: VERSION,
    opaqueAccountId,
    revision: prior ? prior.revision + 1 : 1,
    basedOnSharedGeneration: generation,
    operations: normalizeConfigOperations(operations),
    preservationFingerprint: preservationFingerprint(tree, schema)
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}
function projectPrimarySharedBase(toml, capabilities, schema) {
  validateSchema(schema);
  const generation = 1;
  const configTree = selectSharedTomlTree(toml.tree, schema);
  const config = {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree: configTree,
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, configTree)
  };
  const files = capabilities.files.filter((file) => file.scope === "shareable").map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint, bytes: Buffer.from(file.bytes) })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest = {
    version: VERSION,
    generation,
    files,
    fingerprint: capabilityManifestFingerprint(generation, files)
  };
  return { version: VERSION, config, capabilities: manifest, fingerprint: sha256Json({ version: VERSION, config: config.fingerprint, capabilities: manifest.fingerprint }) };
}
function withGeneration(base, generation) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid shared account base generation");
  const config = {
    ...base.config,
    generation,
    fingerprint: baseConfigFingerprint(generation, base.config.schemaFingerprint, base.config.tree)
  };
  const capabilities = {
    ...base.capabilities,
    generation,
    fingerprint: capabilityManifestFingerprint(generation, base.capabilities.files)
  };
  return { version: VERSION, config, capabilities, fingerprint: sha256Json({ version: VERSION, config: config.fingerprint, capabilities: capabilities.fingerprint }) };
}
function validateSchema(schema) {
  if (schema.version !== VERSION || !isSha256(schema.schemaFingerprint)) throw new Error("invalid account continuity schema");
  for (const field of [...schema.sharedTopLevel ?? [], ...schema.alwaysLocalTopLevel ?? []]) {
    if (typeof field !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(field)) throw new Error("invalid account continuity schema field");
  }
}
function pluginEnablementFromTree(tree, plugins) {
  const sealed = new Set(plugins.plugins.map((plugin) => plugin.id));
  if (plugins.version !== VERSION || !isSha256(plugins.fingerprint) || plugins.plugins.some((plugin) => !isSafePluginId(plugin.id))) {
    return { state: "blocked", reason: "invalid sealed plugin manifest" };
  }
  const result = {};
  for (const plugin of plugins.plugins) result[plugin.id] = Boolean(plugin.enabledByDefault);
  const pluginRoot = getTomlNode(tree, ["plugins"]);
  if (!pluginRoot) return { state: "ready", value: result };
  if (!isTomlTable(pluginRoot)) return { state: "blocked", reason: "plugins configuration is not a table" };
  for (const [id, configuration] of Object.entries(pluginRoot)) {
    if (!sealed.has(id)) continue;
    if (!isTomlTable(configuration)) return { state: "blocked", reason: "plugin configuration is not a table" };
    const enabled = configuration.enabled;
    if (enabled === void 0) continue;
    if (!isTomlScalar(enabled) || enabled.type !== "boolean") return { state: "blocked", reason: "plugin enabled flag is invalid" };
    result[id] = enabled.value;
  }
  return { state: "ready", value: result };
}
function isSafePluginId(value) {
  return value.length > 0 && value.length <= 256 && !value.includes("\0") && !value.includes("/") && !value.includes("\\");
}
function resolveAccountConfig(input) {
  try {
    const schema = input.schema ?? { ...DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, schemaFingerprint: input.shared.schemaFingerprint };
    validateSchema(schema);
    if (input.shared.version !== VERSION || input.shared.schemaFingerprint !== schema.schemaFingerprint || !isSha256(input.shared.fingerprint)) {
      return { state: "blocked", reason: "shared config base schema mismatch" };
    }
    if (input.overrides.version !== VERSION || !isOpaqueAccountId(input.overrides.opaqueAccountId) || !isSha256(input.overrides.fingerprint)) {
      return { state: "blocked", reason: "invalid config overrides" };
    }
    validateConfigOperations(input.overrides.operations);
    if (input.overrides.fingerprint !== accountConfigOverridesFingerprint({
      version: input.overrides.version,
      opaqueAccountId: input.overrides.opaqueAccountId,
      revision: input.overrides.revision,
      basedOnSharedGeneration: input.overrides.basedOnSharedGeneration,
      operations: input.overrides.operations,
      preservationFingerprint: input.overrides.preservationFingerprint
    })) return { state: "blocked", reason: "config override fingerprint mismatch" };
    const effective = clone(input.shared.tree);
    const inherited = new Set(flattenTomlLeaves(input.shared.tree).keys());
    for (const operation of input.overrides.operations) {
      if (operation.op === "set") setTomlNode(effective, operation.path, operation.value);
      else deleteTomlNode(effective, operation.path);
      for (const key of [...inherited]) {
        const path = decodePathKey(key);
        if (path.every((part) => typeof part === "string") && pathsOverlapBySegments(path, operation.path)) inherited.delete(key);
      }
    }
    for (const { path, value } of flattenTomlLeaves(input.currentLocal.tree).values()) {
      if (classifyTomlPath(path, schema, value) === "local" || isPortableConfigUpgradePath(path) && getTomlNode(effective, path) === void 0 && !input.overrides.operations.some((operation) => pathsOverlapBySegments(operation.path, path))) setTomlNode(effective, path, value);
    }
    const plugins = pluginEnablementFromTree(effective, input.plugins);
    if (plugins.state === "blocked") return plugins;
    const resultTree = effective;
    return {
      state: "ready",
      tree: resultTree,
      effectiveFingerprint: sha256Json(resultTree),
      inheritedPaths: [...inherited].map((key) => decodePathKey(key)).sort(compareStringPaths),
      pluginEnablement: plugins.value,
      preservationFingerprint: preservationFingerprint(input.currentLocal.tree, schema)
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "invalid account config input" };
  }
}
function compareStringPaths(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
function isSafeCapabilityRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || (0, import_node_path.isAbsolute)(value)) return false;
  const components = value.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === ".." || component.includes("\\"))) return false;
  if (components[0] !== "AGENTS.md" && components[0] !== "hooks.json" && components[0] !== "agents" && components[0] !== "skills") return false;
  if ((components[0] === "AGENTS.md" || components[0] === "hooks.json") && components.length !== 1) return false;
  return true;
}
function capabilityFileIsLocalOnly(relativePath) {
  return relativePath.split("/").some((component) => credentialShaped(component));
}
function capabilityFingerprint(files) {
  return sha256Json(files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint, scope: file.scope ?? "shareable" })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}
function assertSafeCapabilityDirectory(path, allowMissing = false) {
  try {
    const stat = (0, import_node_fs.lstatSync)(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (stat.mode & 18) !== 0) {
      throw new Error("unsafe account capability directory");
    }
    return true;
  } catch (error) {
    if (allowMissing && isMissing(error)) return false;
    throw error;
  }
}
function scanCapabilityDirectory(root, prefix, files, counters, depth) {
  if (depth > MAX_CAPABILITY_DEPTH) throw new Error("account capability tree exceeds its maximum depth");
  for (const name of (0, import_node_fs.readdirSync)(root).sort()) {
    if (name === ".DS_Store") continue;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (!isSafeCapabilityRelativePath(relativePath)) throw new Error("unsafe account capability path");
    const path = (0, import_node_path.join)(root, name);
    const stat = (0, import_node_fs.lstatSync)(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) throw new Error("unsafe account capability entry");
    if (process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (stat.mode & 18) !== 0) throw new Error("unsafe account capability ownership");
    if (stat.isDirectory()) {
      if (name === "node_modules" || credentialShaped(name)) {
        throw new Error("unsafe account capability container");
      }
      scanCapabilityDirectory(path, relativePath, files, counters, depth + 1);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CAPABILITY_FILE_BYTES) throw new Error("unsafe account capability file");
    if (counters.count >= MAX_CAPABILITY_FILES || counters.total + stat.size > MAX_CAPABILITY_TOTAL_BYTES) throw new Error("account capability tree exceeds its bounded size");
    const bytes = readSafeRegularFile(path, MAX_CAPABILITY_FILE_BYTES, true, false);
    if (!bytes) throw new Error("unsafe account capability file");
    counters.count += 1;
    counters.total += bytes.byteLength;
    files.push({ relativePath, bytes, fingerprint: sha256(bytes), scope: capabilityFileIsLocalOnly(relativePath) ? "local_only" : "shareable" });
  }
}
function scanCapabilityTree(root) {
  const canonicalRoot = (0, import_node_path.resolve)(root);
  assertSafeCapabilityDirectory(canonicalRoot);
  const files = [];
  const counters = { total: 0, count: 0 };
  for (const entry of ["AGENTS.md", "hooks.json", "agents", "skills"]) {
    const path = (0, import_node_path.join)(canonicalRoot, entry);
    if (!(0, import_node_fs.existsSync)(path)) continue;
    const stat = (0, import_node_fs.lstatSync)(path);
    if (stat.isSymbolicLink()) continue;
    if (entry === "agents" || entry === "skills") {
      if (!stat.isDirectory()) throw new Error("unsafe account capability root type");
      assertSafeCapabilityDirectory(path);
      scanCapabilityDirectory(path, entry, files, counters, 1);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CAPABILITY_FILE_BYTES || process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (stat.mode & 18) !== 0) {
      throw new Error("unsafe account capability file");
    }
    const bytes = readSafeRegularFile(path, MAX_CAPABILITY_FILE_BYTES, true, false);
    if (!bytes) throw new Error("unsafe account capability file");
    counters.count += 1;
    counters.total += bytes.byteLength;
    if (counters.count > MAX_CAPABILITY_FILES || counters.total > MAX_CAPABILITY_TOTAL_BYTES) throw new Error("account capability tree exceeds its bounded size");
    files.push({ relativePath: entry, bytes, fingerprint: sha256(bytes), scope: capabilityFileIsLocalOnly(entry) ? "local_only" : "shareable" });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { version: VERSION, root: canonicalRoot, files, fingerprint: capabilityFingerprint(files) };
}
function scanPrimarySharedCapabilities(root) {
  const regular = scanCapabilityTree(root);
  const files = [...regular.files];
  const counters = { count: files.length, total: files.reduce((sum, file) => sum + file.bytes.byteLength, 0) };
  const importLink = (path, prefix) => {
    const before = (0, import_node_fs.lstatSync)(path);
    const link = (0, import_node_fs.readlinkSync)(path);
    if (before.uid !== process.getuid?.()) throw new Error("primary capability link has another owner");
    let target;
    try {
      target = (0, import_node_fs.realpathSync)(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    assertSafeCapabilityDirectory(target);
    scanCapabilityDirectory(target, prefix, files, counters, 1);
    const after = (0, import_node_fs.lstatSync)(path);
    if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || (0, import_node_fs.readlinkSync)(path) !== link || (0, import_node_fs.realpathSync)(path) !== target) throw new Error("primary capability link changed during snapshot");
  };
  for (const name of ["skills", "agents"]) {
    const directory = (0, import_node_path.join)((0, import_node_path.resolve)(root), name);
    const stat = lstatIfPresent(directory);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      importLink(directory, name);
      continue;
    }
    for (const entry of (0, import_node_fs.readdirSync)(directory)) {
      const path = (0, import_node_path.join)(directory, entry);
      if ((0, import_node_fs.lstatSync)(path).isSymbolicLink()) importLink(path, `${name}/${entry}`);
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { version: VERSION, root: (0, import_node_path.resolve)(root), files, fingerprint: capabilityFingerprint(files) };
}
function capabilityPathHasLocalLink(root, path) {
  let current = (0, import_node_path.resolve)(root);
  for (const part of path.split("/")) {
    current = (0, import_node_path.join)(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}
function validateCapabilityOperations(operations) {
  const seen = /* @__PURE__ */ new Set();
  for (const operation of operations) {
    const key = capabilityPathKey(operation.relativePath);
    if (seen.has(key)) throw new Error("duplicate account continuity capability override");
    seen.add(key);
    if (operation.op === "set" && (!isSha256(operation.fingerprint) || !/^[a-f0-9]{64}$/.test(operation.payloadFile))) {
      throw new Error("invalid account continuity capability payload reference");
    }
  }
}
function normalizeCapabilityOperations(operations) {
  validateCapabilityOperations(operations);
  return [...operations].map((operation) => clone(operation)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
function buildCapabilityOverrides(opaqueAccountId, generation, snapshot, prior) {
  const operations = snapshot.files.filter((file) => file.scope === "shareable").map((file) => ({
    relativePath: file.relativePath,
    op: "set",
    fingerprint: file.fingerprint,
    payloadFile: file.fingerprint.slice("sha256:".length)
  }));
  const draft = {
    version: VERSION,
    opaqueAccountId,
    revision: prior ? prior.revision + 1 : 1,
    basedOnSharedGeneration: generation,
    operations: normalizeCapabilityOperations(operations),
    preservationFingerprint: capabilityFingerprint(snapshot.files.filter((file) => file.scope === "local_only"))
  };
  return { ...draft, fingerprint: accountCapabilityOverridesFingerprint(draft) };
}
function readCapabilityPayload(root, operation) {
  if (!root || !safeResolvedChild(root, operation.payloadFile)) return null;
  const bytes = readSafeRegularFile((0, import_node_path.join)(root, operation.payloadFile), MAX_CAPABILITY_FILE_BYTES, true, true);
  if (!bytes || sha256(bytes) !== operation.fingerprint) {
    bytes?.fill(0);
    return null;
  }
  return bytes;
}
function resolveAccountCapabilities(input) {
  try {
    if (input.shared.version !== VERSION || !isSha256(input.shared.fingerprint) || input.shared.fingerprint !== capabilityManifestFingerprint(input.shared.generation, input.shared.files)) {
      return { state: "blocked", reason: "invalid shared capability manifest" };
    }
    if (input.overrides.version !== VERSION || !isOpaqueAccountId(input.overrides.opaqueAccountId) || !isSha256(input.overrides.fingerprint)) {
      return { state: "blocked", reason: "invalid capability overrides" };
    }
    validateCapabilityOperations(input.overrides.operations);
    const expectedOverrideFingerprint = accountCapabilityOverridesFingerprint({
      version: input.overrides.version,
      opaqueAccountId: input.overrides.opaqueAccountId,
      revision: input.overrides.revision,
      basedOnSharedGeneration: input.overrides.basedOnSharedGeneration,
      operations: input.overrides.operations,
      preservationFingerprint: input.overrides.preservationFingerprint
    });
    if (input.overrides.fingerprint !== expectedOverrideFingerprint) return { state: "blocked", reason: "capability override fingerprint mismatch" };
    const resolved = /* @__PURE__ */ new Map();
    const inherited = /* @__PURE__ */ new Set();
    for (const file of input.shared.files) {
      if (!isSafeCapabilityRelativePath(file.relativePath) || !isSha256(file.fingerprint) || !file.bytes || sha256(file.bytes) !== file.fingerprint) {
        return { state: "blocked", reason: "invalid immutable capability file" };
      }
      resolved.set(file.relativePath, { relativePath: file.relativePath, bytes: Buffer.from(file.bytes), fingerprint: file.fingerprint, provenance: "shared" });
      inherited.add(file.relativePath);
    }
    for (const operation of input.overrides.operations) {
      if (operation.op === "delete") {
        resolved.delete(operation.relativePath);
        inherited.delete(operation.relativePath);
        continue;
      }
      const bytes = readCapabilityPayload(input.overrides.payloadRoot, operation);
      if (!bytes) return { state: "blocked", reason: "capability override payload is missing or changed" };
      resolved.set(operation.relativePath, { relativePath: operation.relativePath, bytes, fingerprint: operation.fingerprint, provenance: "override" });
      inherited.delete(operation.relativePath);
    }
    for (const [path, file] of resolved) {
      if (capabilityPathHasLocalLink(input.currentLocalRoot, path)) {
        file.bytes.fill(0);
        resolved.delete(path);
        inherited.delete(path);
      }
    }
    const current = scanCapabilityTree(input.currentLocalRoot);
    for (const file of current.files) {
      if (file.scope !== "local_only") continue;
      const prior = resolved.get(file.relativePath);
      if (prior) {
        for (const entry of resolved.values()) entry.bytes.fill(0);
        return { state: "blocked", reason: "local-only capability path collides with shared capability" };
      }
      resolved.set(file.relativePath, { relativePath: file.relativePath, bytes: Buffer.from(file.bytes), fingerprint: file.fingerprint, provenance: "local_only" });
    }
    const files = [...resolved.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      state: "ready",
      files,
      effectiveFingerprint: capabilityFingerprint(files),
      inheritedPaths: [...inherited].sort(),
      preservationFingerprint: capabilityFingerprint(current.files.filter((file) => file.scope === "local_only"))
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "invalid account capability input" };
  }
}
function isSha256(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function isMissing(error) {
  return isRecord(error) && error.code === "ENOENT";
}
function accountStateRoot(stateRoot, account) {
  if (!isOpaqueAccountId(account.opaqueAccountId)) throw new Error("invalid account continuity account id");
  const root = account.accountStateRoot ?? (0, import_node_path.join)(stateRoot, "accounts", account.opaqueAccountId);
  if (!(0, import_node_path.isAbsolute)(root)) throw new Error("account continuity state root must be absolute");
  return (0, import_node_path.resolve)(root);
}
function sharedAccountConfigRoot(stateRoot) {
  if (!(0, import_node_path.isAbsolute)(stateRoot)) throw new Error("account continuity state root must be absolute");
  return (0, import_node_path.join)((0, import_node_path.resolve)(stateRoot), ACCOUNT_CONFIG_DIRECTORY);
}
function assertSafeOwnerDirectory(path, create = false) {
  const resolved = (0, import_node_path.resolve)(path);
  if ((0, import_node_fs.existsSync)(resolved)) {
    const stat = (0, import_node_fs.lstatSync)(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (stat.mode & 18) !== 0) {
      throw new Error("account continuity refused an unsafe directory");
    }
  } else {
    if (!create) throw new Error("account continuity directory is missing");
    (0, import_node_fs.mkdirSync)(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  (0, import_node_fs.chmodSync)(resolved, PRIVATE_DIRECTORY_MODE);
  const checked = (0, import_node_fs.statSync)(resolved);
  if (!checked.isDirectory() || process.getuid?.() !== void 0 && checked.uid !== process.getuid?.() || (checked.mode & 63) !== 0) {
    throw new Error("account continuity directory is not owner-private");
  }
}
function assertSafePrivateDirectoryReadOnly(path) {
  assertSafeCapabilityDirectory(path);
  const stat = (0, import_node_fs.lstatSync)(path);
  if ((stat.mode & 63) !== 0 || (0, import_node_fs.realpathSync)(path) !== (0, import_node_path.resolve)(path)) throw new Error("account continuity directory is not owner-private");
}
function safeResolvedChild(root, child) {
  const resolvedRoot = (0, import_node_path.resolve)(root);
  const resolvedChild = (0, import_node_path.resolve)(root, child);
  const relation = (0, import_node_path.relative)(resolvedRoot, resolvedChild);
  return relation !== "" && !relation.startsWith(`..${import_node_path.sep}`) && relation !== ".." && !(0, import_node_path.isAbsolute)(relation);
}
function assertSafeRegularFile(path, maxBytes, allowEmpty, requirePrivate) {
  const stat = (0, import_node_fs.lstatSync)(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (requirePrivate ? (stat.mode & 63) !== 0 : (stat.mode & 18) !== 0) || stat.size > maxBytes || !allowEmpty && stat.size === 0) throw new Error("account continuity refused an unsafe regular file");
  return stat;
}
function readSafeRegularFile(path, maxBytes, allowEmpty, requirePrivate) {
  let descriptor;
  let bytes = null;
  let accepted = false;
  try {
    descriptor = (0, import_node_fs.openSync)(path, import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW);
    const before = (0, import_node_fs.fstatSync)(descriptor);
    if (!before.isFile() || before.nlink !== 1 || process.getuid?.() !== void 0 && before.uid !== process.getuid?.() || (requirePrivate ? (before.mode & 63) !== 0 : (before.mode & 18) !== 0) || before.size > maxBytes || !allowEmpty && before.size === 0) return null;
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = (0, import_node_fs.readSync)(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!read) return null;
      offset += read;
    }
    const after = (0, import_node_fs.fstatSync)(descriptor);
    const current = (0, import_node_fs.lstatSync)(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) return null;
    accepted = true;
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== void 0) (0, import_node_fs.closeSync)(descriptor);
    if (bytes && !accepted) bytes.fill(0);
  }
}
function atomicWriteFile(path, bytes, mode, requireExistingSafe = false) {
  const parent = (0, import_node_path.dirname)(path);
  assertSafeOwnerDirectory(parent);
  if (bytes.byteLength > MAX_CAPABILITY_TOTAL_BYTES) throw new Error("account continuity refused an oversized write");
  if ((0, import_node_fs.existsSync)(path)) {
    if (requireExistingSafe) assertSafeRegularFile(path, Math.max(MAX_CONFIG_BYTES, MAX_CAPABILITY_TOTAL_BYTES), true, false);
    else assertSafeRegularFile(path, Math.max(MAX_METADATA_BYTES, MAX_CAPABILITY_TOTAL_BYTES), true, true);
  }
  const temporary = (0, import_node_path.join)(parent, `.${(0, import_node_path.basename)(path)}.${process.pid}.${(0, import_node_crypto.randomBytes)(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = (0, import_node_fs.openSync)(temporary, import_node_fs.constants.O_WRONLY | import_node_fs.constants.O_CREAT | import_node_fs.constants.O_EXCL | import_node_fs.constants.O_NOFOLLOW, mode);
    (0, import_node_fs.writeFileSync)(descriptor, bytes);
    (0, import_node_fs.fsyncSync)(descriptor);
    (0, import_node_fs.closeSync)(descriptor);
    descriptor = void 0;
    (0, import_node_fs.chmodSync)(temporary, mode);
    assertSafeRegularFile(temporary, Math.max(MAX_CONFIG_BYTES, MAX_CAPABILITY_TOTAL_BYTES), true, mode === PRIVATE_FILE_MODE);
    (0, import_node_fs.renameSync)(temporary, path);
    (0, import_node_fs.chmodSync)(path, mode);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== void 0) (0, import_node_fs.closeSync)(descriptor);
    if ((0, import_node_fs.existsSync)(temporary)) {
      try {
        (0, import_node_fs.unlinkSync)(temporary);
      } catch {
      }
    }
  }
}
function atomicWritePrivateJson(root, fileName, value) {
  assertSafeOwnerDirectory(root, true);
  if ((0, import_node_path.basename)(fileName) !== fileName || fileName.includes("..")) throw new Error("unsafe account continuity metadata file");
  const bytes = Buffer.from(`${JSON.stringify(value)}
`, "utf8");
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("account continuity metadata exceeds its bounded size");
  atomicWriteFile((0, import_node_path.join)(root, fileName), bytes, PRIVATE_FILE_MODE);
}
function readPrivateJson(root, fileName) {
  if ((0, import_node_path.basename)(fileName) !== fileName || fileName.includes("..")) throw new Error("unsafe account continuity metadata file");
  const path = (0, import_node_path.join)(root, fileName);
  if (!(0, import_node_fs.existsSync)(path)) return null;
  const bytes = readSafeRegularFile(path, MAX_METADATA_BYTES, false, true);
  if (!bytes) throw new Error("unsafe account continuity metadata file");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = (0, import_node_fs.openSync)(path, import_node_fs.constants.O_RDONLY);
    (0, import_node_fs.fsyncSync)(descriptor);
  } catch {
  } finally {
    if (descriptor !== void 0) (0, import_node_fs.closeSync)(descriptor);
  }
}
function validateTomlNode(value) {
  if (!isRecord(value)) return false;
  if (typeof value.type === "string") {
    switch (value.type) {
      case "string":
        return typeof value.value === "string";
      case "boolean":
        return typeof value.value === "boolean";
      case "integer":
        return typeof value.value === "string" && /^-?[0-9]+$/.test(value.value);
      case "float":
        return typeof value.value === "string" && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value.value);
      case "datetime":
        return typeof value.value === "string" && ["offset-date-time", "local-date-time", "local-date", "local-time"].includes(String(value.kind));
      case "array":
        return Array.isArray(value.values) && value.values.every(validateTomlDataValue);
      case "inline-table":
        return isRecord(value.entries) && Object.values(value.entries).every(validateTomlNode);
      case "array-table":
        return Array.isArray(value.entries) && value.entries.every((entry) => isRecord(entry) && Object.values(entry).every(validateTomlNode));
      default:
        return false;
    }
  }
  return Object.keys(value).every((key) => key.length > 0 && Object.prototype.hasOwnProperty.call(value, key) && validateTomlNode(value[key]));
}
function validateTomlDataValue(value) {
  return validateTomlNode(value) && isTomlDataValue(value);
}
function parseConfigOverrides(value, payloadRoot) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "opaqueAccountId", "revision", "basedOnSharedGeneration", "operations", "preservationFingerprint", "fingerprint"].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Number.isSafeInteger(value.basedOnSharedGeneration) || Number(value.basedOnSharedGeneration) < 1 || !Array.isArray(value.operations) || !isSha256(value.preservationFingerprint) || !isSha256(value.fingerprint)) return null;
  const operations = [];
  for (const operation of value.operations) {
    if (!isRecord(operation) || !Array.isArray(operation.path) || operation.path.some((part) => typeof part !== "string" || part.length === 0)) return null;
    if (operation.op === "delete" && Object.keys(operation).length === 2) operations.push({ path: operation.path, op: "delete" });
    else if (operation.op === "set" && Object.keys(operation).length === 3 && validateTomlNode(operation.value)) operations.push({ path: operation.path, op: "set", value: operation.value });
    else return null;
  }
  try {
    validateConfigOperations(operations);
  } catch {
    return null;
  }
  const draft = {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId,
    revision: value.revision,
    basedOnSharedGeneration: value.basedOnSharedGeneration,
    operations: normalizeConfigOperations(operations),
    preservationFingerprint: value.preservationFingerprint
  };
  if (accountConfigOverridesFingerprint(draft) !== value.fingerprint) return null;
  void payloadRoot;
  return { ...draft, fingerprint: value.fingerprint };
}
function parseCapabilityOverrides(value, payloadRoot) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "opaqueAccountId", "revision", "basedOnSharedGeneration", "operations", "preservationFingerprint", "fingerprint"].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Number.isSafeInteger(value.basedOnSharedGeneration) || Number(value.basedOnSharedGeneration) < 1 || !Array.isArray(value.operations) || !isSha256(value.preservationFingerprint) || !isSha256(value.fingerprint)) return null;
  const operations = [];
  for (const operation of value.operations) {
    if (!isRecord(operation) || typeof operation.relativePath !== "string" || !isSafeCapabilityRelativePath(operation.relativePath)) return null;
    if (operation.op === "delete" && Object.keys(operation).length === 2) operations.push({ relativePath: operation.relativePath, op: "delete" });
    else if (operation.op === "set" && Object.keys(operation).length === 4 && isSha256(operation.fingerprint) && typeof operation.payloadFile === "string") {
      operations.push({ relativePath: operation.relativePath, op: "set", fingerprint: operation.fingerprint, payloadFile: operation.payloadFile });
    } else return null;
  }
  try {
    validateCapabilityOperations(operations);
  } catch {
    return null;
  }
  const draft = {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId,
    revision: value.revision,
    basedOnSharedGeneration: value.basedOnSharedGeneration,
    operations: normalizeCapabilityOperations(operations),
    preservationFingerprint: value.preservationFingerprint
  };
  if (accountCapabilityOverridesFingerprint(draft) !== value.fingerprint) return null;
  return { ...draft, fingerprint: value.fingerprint, ...payloadRoot ? { payloadRoot } : {} };
}
function serializableSharedBase(base) {
  return {
    version: VERSION,
    config: base.config,
    capabilities: {
      version: base.capabilities.version,
      generation: base.capabilities.generation,
      files: base.capabilities.files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })),
      fingerprint: base.capabilities.fingerprint
    },
    fingerprint: base.fingerprint
  };
}
function parseSharedBase(value, root, readOnly = false) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "config", "capabilities", "fingerprint"].includes(key)) || value.version !== VERSION || !isRecord(value.config) || !isRecord(value.capabilities) || !isSha256(value.fingerprint)) return null;
  const config = value.config;
  if (Object.keys(config).some((key) => !["version", "generation", "schemaFingerprint", "tree", "fingerprint"].includes(key)) || config.version !== VERSION || !Number.isSafeInteger(config.generation) || Number(config.generation) < 1 || !isSha256(config.schemaFingerprint) || !validateTomlNode(config.tree) || !isTomlTable(config.tree) || !isSha256(config.fingerprint)) return null;
  const expectedConfig = {
    version: VERSION,
    generation: config.generation,
    schemaFingerprint: config.schemaFingerprint,
    tree: config.tree,
    fingerprint: baseConfigFingerprint(config.generation, config.schemaFingerprint, config.tree)
  };
  if (expectedConfig.fingerprint !== config.fingerprint) return null;
  const cap = value.capabilities;
  if (Object.keys(cap).some((key) => !["version", "generation", "files", "fingerprint"].includes(key)) || cap.version !== VERSION || cap.generation !== config.generation || !Array.isArray(cap.files) || !isSha256(cap.fingerprint)) return null;
  const files = [];
  for (const entry of cap.files) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "relativePath" && key !== "fingerprint") || !isSafeCapabilityRelativePath(String(entry.relativePath)) || !isSha256(entry.fingerprint)) return null;
    files.push({ relativePath: entry.relativePath, fingerprint: entry.fingerprint });
  }
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) return null;
  if (capabilityManifestFingerprint(config.generation, files) !== cap.fingerprint) return null;
  const capabilities = { version: VERSION, generation: config.generation, files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)), fingerprint: cap.fingerprint };
  const base = { version: VERSION, config: expectedConfig, capabilities, fingerprint: sha256Json({ version: VERSION, config: expectedConfig.fingerprint, capabilities: capabilities.fingerprint }) };
  if (base.fingerprint !== value.fingerprint) return null;
  if (!root) return base;
  const generationRoot = (0, import_node_path.join)(root, CAPABILITY_GENERATIONS_DIRECTORY, String(config.generation));
  try {
    if (readOnly) {
      assertSafeCapabilityDirectory(generationRoot);
      if ((0, import_node_fs.realpathSync)(generationRoot) !== generationRoot || ((0, import_node_fs.lstatSync)(generationRoot).mode & 63) !== 0) return null;
    } else assertSafeOwnerDirectory(generationRoot);
    const hydrated = base.capabilities.files.map((file) => {
      const path = (0, import_node_path.join)(generationRoot, ...file.relativePath.split("/"));
      if (!safeResolvedChild(generationRoot, (0, import_node_path.relative)(generationRoot, path))) throw new Error("unsafe immutable capability path");
      const bytes = readSafeRegularFile(path, MAX_CAPABILITY_FILE_BYTES, true, true);
      if (!bytes || sha256(bytes) !== file.fingerprint) throw new Error("immutable capability file changed");
      return { ...file, bytes };
    });
    const manifestBytes = readSafeRegularFile((0, import_node_path.join)(generationRoot, CAPABILITY_MANIFEST_FILE), MAX_METADATA_BYTES, false, true);
    if (!manifestBytes || sha256(manifestBytes) !== sha256Json({ version: VERSION, generation: config.generation, files: base.capabilities.files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })) })) {
      manifestBytes?.fill(0);
      throw new Error("immutable capability manifest changed");
    }
    manifestBytes.fill(0);
    return { ...base, capabilities: { ...base.capabilities, files: hydrated, root: generationRoot } };
  } catch {
    return null;
  }
}
function loadSharedAccountBase(stateRoot) {
  try {
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafePrivateDirectoryReadOnly(root);
    return parseSharedBase(readPrivateJson(root, BASE_FILE), root);
  } catch {
    return null;
  }
}
function loadAccountConfigOverrides(stateRoot, account) {
  try {
    const root = accountStateRoot(stateRoot, account);
    assertSafeOwnerDirectory(root);
    const parsed = parseConfigOverrides(readPrivateJson(root, CONFIG_OVERRIDES_FILE));
    return parsed?.opaqueAccountId === account.opaqueAccountId ? parsed : null;
  } catch {
    return null;
  }
}
function loadAccountCapabilityOverrides(stateRoot, account) {
  try {
    const root = accountStateRoot(stateRoot, account);
    assertSafeOwnerDirectory(root);
    const payloadRoot = (0, import_node_path.join)(root, CAPABILITY_OVERRIDE_FILES_DIRECTORY);
    assertSafeOwnerDirectory(payloadRoot);
    const parsed = parseCapabilityOverrides(readPrivateJson(root, CAPABILITY_OVERRIDES_FILE), payloadRoot);
    return parsed?.opaqueAccountId === account.opaqueAccountId ? parsed : null;
  } catch {
    return null;
  }
}
function writeCapabilityPayloads(accountRoot, snapshot) {
  const payloadRoot = (0, import_node_path.join)(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY);
  assertSafeOwnerDirectory(payloadRoot, true);
  for (const file of snapshot.files) {
    if (file.scope !== "shareable") continue;
    const fileName = file.fingerprint.slice("sha256:".length);
    const target = (0, import_node_path.join)(payloadRoot, fileName);
    if ((0, import_node_fs.existsSync)(target)) {
      const existing = readSafeRegularFile(target, MAX_CAPABILITY_FILE_BYTES, true, true);
      if (!existing || sha256(existing) !== file.fingerprint) {
        existing?.fill(0);
        throw new Error("account capability override payload collision");
      }
      existing.fill(0);
      continue;
    }
    atomicWriteFile(target, file.bytes, PRIVATE_FILE_MODE);
  }
}
function persistConfigOverrides(root, overrides) {
  atomicWritePrivateJson(root, CONFIG_OVERRIDES_FILE, {
    version: overrides.version,
    opaqueAccountId: overrides.opaqueAccountId,
    revision: overrides.revision,
    basedOnSharedGeneration: overrides.basedOnSharedGeneration,
    operations: overrides.operations,
    preservationFingerprint: overrides.preservationFingerprint,
    fingerprint: overrides.fingerprint
  });
}
function persistCapabilityOverrides(root, overrides) {
  atomicWritePrivateJson(root, CAPABILITY_OVERRIDES_FILE, {
    version: overrides.version,
    opaqueAccountId: overrides.opaqueAccountId,
    revision: overrides.revision,
    basedOnSharedGeneration: overrides.basedOnSharedGeneration,
    operations: overrides.operations,
    preservationFingerprint: overrides.preservationFingerprint,
    fingerprint: overrides.fingerprint
  });
}
function readAccountConfig(codexHome) {
  assertSafeCapabilityDirectory(codexHome);
  const path = (0, import_node_path.join)(codexHome, "config.toml");
  return (0, import_node_fs.existsSync)(path) ? readLosslessTomlDocument(path) : parseLosslessTomlDocument("");
}
function writeSharedAccountBase(stateRoot, base, expectedPriorFingerprint) {
  const root = sharedAccountConfigRoot(stateRoot);
  assertSafeOwnerDirectory(root, true);
  const current = parseSharedBase(readPrivateJson(root, BASE_FILE), root);
  if (expectedPriorFingerprint === void 0) {
    if (current !== null) throw new Error("shared account base already exists; refusing overwrite");
  } else if (!current || current.fingerprint !== expectedPriorFingerprint) {
    throw new Error("shared account base changed before primary publication");
  }
  const generationsRoot = (0, import_node_path.join)(root, CAPABILITY_GENERATIONS_DIRECTORY);
  assertSafeOwnerDirectory(generationsRoot, true);
  const generationRoot = (0, import_node_path.join)(generationsRoot, String(base.config.generation));
  if ((0, import_node_fs.existsSync)(generationRoot)) throw new Error("shared account capability generation already exists");
  (0, import_node_fs.mkdirSync)(generationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertSafeOwnerDirectory(generationRoot);
  try {
    for (const file of base.capabilities.files) {
      if (!file.bytes || !isSafeCapabilityRelativePath(file.relativePath) || sha256(file.bytes) !== file.fingerprint) throw new Error("invalid shared capability source");
      const target = (0, import_node_path.join)(generationRoot, ...file.relativePath.split("/"));
      const targetDirectory = (0, import_node_path.dirname)(target);
      if ((0, import_node_path.resolve)(targetDirectory) !== (0, import_node_path.resolve)(generationRoot) && !safeResolvedChild(generationRoot, (0, import_node_path.relative)(generationRoot, targetDirectory))) {
        throw new Error("unsafe shared capability target");
      }
      assertSafeOwnerDirectory(targetDirectory, true);
      atomicWriteFile(target, file.bytes, PRIVATE_FILE_MODE);
    }
    const manifest = {
      version: VERSION,
      generation: base.capabilities.generation,
      files: base.capabilities.files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint }))
    };
    atomicWriteFile((0, import_node_path.join)(generationRoot, CAPABILITY_MANIFEST_FILE), Buffer.from(stableJson(manifest)), PRIVATE_FILE_MODE);
    (0, import_node_fs.chmodSync)(generationRoot, 320);
    makeTreeReadOnly(generationRoot);
    atomicWritePrivateJson(root, BASE_FILE, serializableSharedBase(base));
    atomicWritePrivateJson(root, BASE_RECEIPT_FILE, {
      version: VERSION,
      generation: base.config.generation,
      configFingerprint: base.config.fingerprint,
      capabilityFingerprint: base.capabilities.fingerprint,
      baseFingerprint: base.fingerprint
    });
  } catch (error) {
    throw error;
  }
}
function primaryPublishedSharedBase(prior, proposedConfig, proposedCapabilities, schema) {
  validateSchema(schema);
  const generation = prior.config.generation + 1;
  if (!Number.isSafeInteger(generation) || proposedConfig.version !== VERSION || proposedConfig.generation !== generation || proposedConfig.schemaFingerprint !== schema.schemaFingerprint || !validateTomlNode(proposedConfig.tree) || !isTomlTable(proposedConfig.tree) || proposedConfig.fingerprint !== baseConfigFingerprint(generation, schema.schemaFingerprint, proposedConfig.tree)) {
    throw new Error("invalid primary shared config publication candidate");
  }
  if (proposedCapabilities.version !== VERSION || proposedCapabilities.fingerprint !== capabilityFingerprint(proposedCapabilities.files)) {
    throw new Error("invalid primary shared capability publication candidate");
  }
  const files = proposedCapabilities.files.filter((file) => file.scope === "shareable").map((file) => {
    if (!isSafeCapabilityRelativePath(file.relativePath) || !isSha256(file.fingerprint) || sha256(file.bytes) !== file.fingerprint) {
      throw new Error("invalid primary shared capability source");
    }
    return { relativePath: file.relativePath, fingerprint: file.fingerprint, bytes: Buffer.from(file.bytes) };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) throw new Error("duplicate primary shared capability path");
  const config = {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree: clone(proposedConfig.tree),
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, proposedConfig.tree)
  };
  const capabilities = {
    version: VERSION,
    generation,
    files,
    fingerprint: capabilityManifestFingerprint(generation, files)
  };
  return {
    version: VERSION,
    config,
    capabilities,
    fingerprint: sha256Json({ version: VERSION, config: config.fingerprint, capabilities: capabilities.fingerprint })
  };
}
function publishPrimarySharedBaseAfterExit(input) {
  try {
    validateSchema(input.schema);
    const current = loadSharedAccountBase(input.stateRoot);
    if (!current || current.fingerprint !== input.prior.fingerprint) {
      return { state: "blocked", reason: "shared account base changed before primary publication" };
    }
    const shared = primaryPublishedSharedBase(current, input.proposedConfig, input.proposedCapabilities, input.schema);
    if (!input.apply) return { state: "would_publish", shared };
    writeSharedAccountBase(input.stateRoot, shared, current.fingerprint);
    const persisted = loadSharedAccountBase(input.stateRoot);
    if (!persisted || persisted.fingerprint !== shared.fingerprint) {
      return { state: "blocked", reason: "published shared account base could not be revalidated" };
    }
    return { state: "published", shared: persisted };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "primary shared base publication failed" };
  }
}
function makeTreeReadOnly(root) {
  const stat = (0, import_node_fs.lstatSync)(root);
  if (stat.isDirectory()) {
    for (const name of (0, import_node_fs.readdirSync)(root)) makeTreeReadOnly((0, import_node_path.join)(root, name));
    (0, import_node_fs.chmodSync)(root, 320);
  } else if (stat.isFile()) (0, import_node_fs.chmodSync)(root, 256);
  else throw new Error("unsafe immutable capability artifact");
}
var MAX_PLUGIN_FILES = 25e4;
var MAX_PLUGIN_BYTES = 4 * 1024 * 1024 * 1024;
function isSafePluginSegment(value) {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}
function pluginPrivateContainer(name) {
  const value = name.toLowerCase();
  return value === ".env" || value.startsWith(".env.") || ["auth.json", "authorization.json", "cookies.json", "credentials", "credentials.json", "oauth.json", "token.json", "tokens.json", "secret.json", "secrets.json", "client_secret.json", "api-key.json", "api_key.json", ".netrc"].includes(value) || value.endsWith(".sqlite");
}
function scanPluginPackage(root) {
  assertSafeCapabilityDirectory(root);
  const canonicalRoot = (0, import_node_fs.realpathSync)(root);
  const files = [];
  let total = 0;
  const visit = (directory, prefix, depth) => {
    if (depth > 64) throw new Error("plugin package exceeds maximum depth");
    for (const name of (0, import_node_fs.readdirSync)(directory).sort()) {
      if (name === ".DS_Store" || pluginPrivateContainer(name)) continue;
      if (!isSafePluginSegment(name)) throw new Error("unsafe plugin package path");
      const path = (0, import_node_path.join)(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = (0, import_node_fs.lstatSync)(path);
      if (relativePath === ".venv/.lock" && stat.isFile() && stat.size === 0 && stat.nlink === 1) continue;
      if (stat.isSymbolicLink()) {
        const linkTarget = (0, import_node_fs.readlinkSync)(path);
        const target = (0, import_node_fs.realpathSync)(path);
        const targetRelative = (0, import_node_path.relative)(canonicalRoot, target);
        if ((0, import_node_path.isAbsolute)(linkTarget) || !targetRelative || targetRelative.startsWith(`..${import_node_path.sep}`) || targetRelative === ".." || targetRelative.split(import_node_path.sep).some(pluginPrivateContainer)) throw new Error("plugin package link escapes its definition tree");
        files.push({ path: relativePath, bytes: 0, fingerprint: sha256Json({ linkTarget }), linkTarget });
        continue;
      }
      if (stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (stat.mode & 18) !== 0) throw new Error("unsafe plugin package entry");
      if (stat.isDirectory()) {
        visit(path, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PLUGIN_BYTES || files.length >= MAX_PLUGIN_FILES || total + stat.size > MAX_PLUGIN_BYTES) {
        throw new Error("plugin package exceeds bounded size");
      }
      const bytes = readSafeRegularFile(path, MAX_PLUGIN_BYTES, true, false);
      if (!bytes) throw new Error("unsafe plugin package file");
      try {
        total += bytes.byteLength;
        files.push({ path: relativePath, bytes: bytes.byteLength, fingerprint: sha256(bytes), executable: (stat.mode & 73) !== 0 });
      } finally {
        bytes.fill(0);
      }
    }
  };
  visit(root, "", 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
function compareNativePluginVersions(left, right) {
  const pattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
  const a = pattern.exec(left), b = pattern.exec(right);
  const lexical = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  if (!a || !b) return lexical(left, right);
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(a[i]), y = BigInt(b[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a[4] !== b[4]) {
    if (!a[4]) return 1;
    if (!b[4]) return -1;
    const x = a[4].split("."), y = b[4].split(".");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === void 0) return -1;
      if (y[i] === void 0) return 1;
      if (x[i] === y[i]) continue;
      const xn = /^[0-9]+$/.test(x[i]), yn = /^[0-9]+$/.test(y[i]);
      if (xn && yn) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1;
      if (xn !== yn) return xn ? -1 : 1;
      return lexical(x[i], y[i]);
    }
  }
  return lexical(a[5] ?? "", b[5] ?? "");
}
function scanPluginCache(source, enabledIds) {
  assertSafeCapabilityDirectory(source);
  const packages = [];
  const selectedRegistries = enabledIds ? new Set([...enabledIds].map((id) => id.split("@")[1])) : void 0;
  for (const registry of (0, import_node_fs.readdirSync)(source, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (selectedRegistries && !selectedRegistries.has(registry)) continue;
    if (!isSafePluginSegment(registry)) throw new Error("unsafe plugin registry");
    const registryRoot = (0, import_node_path.join)(source, registry);
    assertSafeCapabilityDirectory(registryRoot);
    for (const name of (0, import_node_fs.readdirSync)(registryRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const id = `${name}@${registry}`;
      if (enabledIds && !enabledIds.has(id)) continue;
      if (!isSafePluginSegment(name)) throw new Error("unsafe plugin name");
      const nameRoot = (0, import_node_path.join)(registryRoot, name);
      assertSafeCapabilityDirectory(nameRoot);
      const versions = (0, import_node_fs.readdirSync)(nameRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_.+-]+$/.test(entry.name) && entry.name !== "." && entry.name !== "..").map((entry) => entry.name).sort(compareNativePluginVersions);
      const version = versions.includes("local") ? "local" : versions.at(-1);
      if (!version) continue;
      const files = scanPluginPackage((0, import_node_path.join)(nameRoot, version));
      if (!files.length) throw new Error("empty plugin package is not a sealed inventory entry");
      packages.push({ id, registry, name, version, files, fingerprint: sha256Json({ id, version, files }), bytes: files.reduce((total, file) => total + file.bytes, 0) });
    }
  }
  return packages.sort((left, right) => left.id.localeCompare(right.id));
}
function pluginInventoryFingerprint(generation, plugins) {
  return sha256Json({
    version: VERSION,
    generation,
    plugins: [...plugins].map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      fingerprint: plugin.fingerprint,
      fileCount: plugin.fileCount,
      bytes: plugin.bytes
    })).sort((left, right) => left.id.localeCompare(right.id))
  });
}
function copyPluginPackage(source, destination, files, immutable = true, afterFile) {
  assertSafeCapabilityDirectory(source);
  assertSafeOwnerDirectory(destination, true);
  for (const file of files) {
    const target = (0, import_node_path.join)(destination, ...file.path.split("/"));
    assertSafeOwnerDirectory((0, import_node_path.dirname)(target), true);
    if (file.linkTarget !== void 0) (0, import_node_fs.symlinkSync)(file.linkTarget, target);
    else {
      const bytes = readSafeRegularFile((0, import_node_path.join)(source, ...file.path.split("/")), MAX_PLUGIN_BYTES, true, false);
      if (!bytes || sha256(bytes) !== file.fingerprint) throw new Error("plugin source changed before immutable copy");
      try {
        atomicWriteFile(target, bytes, file.executable ? 448 : PRIVATE_FILE_MODE);
      } finally {
        bytes.fill(0);
      }
    }
    afterFile?.();
  }
  const seal = (path) => {
    const stat = (0, import_node_fs.lstatSync)(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of (0, import_node_fs.readdirSync)(path)) seal((0, import_node_path.join)(path, entry));
      (0, import_node_fs.chmodSync)(path, 320);
    } else if (stat.isFile()) (0, import_node_fs.chmodSync)(path, stat.mode & 73 ? 320 : 256);
    else throw new Error("unsafe plugin seal artifact");
  };
  if (immutable) seal(destination);
}
function pluginGenerationArtifactFingerprint(manifest, cache) {
  assertSafePrivateDirectoryReadOnly(cache);
  const expected = new Map(manifest.plugins.map((plugin) => {
    const [name, registry] = plugin.id.split("@");
    return [`${registry}/${name}`, plugin];
  }));
  const actual = [];
  for (const registry of (0, import_node_fs.readdirSync)(cache).sort()) {
    if (!isSafePluginSegment(registry)) throw new Error("unsafe shared plugin generation registry");
    const registryRoot = (0, import_node_path.join)(cache, registry);
    assertSafePrivateDirectoryReadOnly(registryRoot);
    for (const name of (0, import_node_fs.readdirSync)(registryRoot).sort()) {
      if (!isSafePluginSegment(name)) throw new Error("unsafe shared plugin generation name");
      const nameRoot = (0, import_node_path.join)(registryRoot, name);
      assertSafePrivateDirectoryReadOnly(nameRoot);
      const plugin = expected.get(`${registry}/${name}`);
      if (!plugin) throw new Error("unexpected shared plugin generation package");
      const versions = (0, import_node_fs.readdirSync)(nameRoot);
      if (versions.length === 0) continue;
      if (versions.length !== 1 || versions[0] !== plugin.version) throw new Error("unexpected shared plugin generation version");
      const versionRoot = (0, import_node_path.join)(nameRoot, plugin.version);
      assertSafePrivateDirectoryReadOnly(versionRoot);
      let files;
      try {
        files = scanPluginPackage(versionRoot);
      } catch (error) {
        if (error instanceof Error && error.message === "empty plugin package is not a sealed inventory entry") return null;
        throw error;
      }
      const fingerprint = sha256Json({ id: plugin.id, version: plugin.version, files });
      actual.push({ id: plugin.id, version: plugin.version, fingerprint, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
    }
  }
  return pluginInventoryFingerprint(manifest.generation, actual);
}
function assertPluginGenerationContainer(path) {
  const stat = (0, import_node_fs.lstatSync)(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid?.() !== void 0 && stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0 || (0, import_node_fs.realpathSync)(path) !== (0, import_node_path.resolve)(path)) {
    throw new Error("unsafe shared plugin generation container");
  }
  const entries = (0, import_node_fs.readdirSync)(path);
  if (entries.some((entry) => entry !== "cache" && entry !== PLUGIN_GENERATION_MANIFEST_FILE)) {
    throw new Error("unexpected shared plugin generation artifact");
  }
  if (entries.includes("cache")) assertSafePrivateDirectoryReadOnly((0, import_node_path.join)(path, "cache"));
  else if (entries.includes(PLUGIN_GENERATION_MANIFEST_FILE)) throw new Error("shared plugin generation manifest lacks a cache");
}
function verifiedPluginGeneration(path, manifest) {
  assertPluginGenerationContainer(path);
  if (!(0, import_node_fs.existsSync)((0, import_node_path.join)(path, "cache"))) return false;
  const localManifest = readPrivateJson(path, PLUGIN_GENERATION_MANIFEST_FILE);
  if (localManifest !== null) {
    const parsed = parseSharedPluginsManifest(localManifest);
    if (!parsed || parsed.generation !== manifest.generation || parsed.fingerprint !== manifest.fingerprint) {
      throw new Error("shared plugin generation manifest does not match candidate");
    }
  }
  try {
    const artifactFingerprint = pluginGenerationArtifactFingerprint(manifest, (0, import_node_path.join)(path, "cache"));
    if (localManifest !== null && artifactFingerprint !== manifest.fingerprint) {
      throw new Error("sealed shared plugin generation payload changed");
    }
    return artifactFingerprint === manifest.fingerprint;
  } catch (error) {
    if (localManifest === null && error instanceof Error && error.message === "empty plugin package is not a sealed inventory entry") return false;
    throw error;
  }
}
function sealPluginGeneration(path, manifest) {
  (0, import_node_fs.chmodSync)(path, PRIVATE_DIRECTORY_MODE);
  const manifestPath = (0, import_node_path.join)(path, PLUGIN_GENERATION_MANIFEST_FILE);
  if (!(0, import_node_fs.existsSync)(manifestPath)) atomicWritePrivateJson(path, PLUGIN_GENERATION_MANIFEST_FILE, {
    version: VERSION,
    generation: manifest.generation,
    plugins: manifest.plugins,
    fingerprint: manifest.fingerprint
  });
  const seal = (entryPath) => {
    const stat = (0, import_node_fs.lstatSync)(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of (0, import_node_fs.readdirSync)(entryPath)) seal((0, import_node_path.join)(entryPath, entry));
      (0, import_node_fs.chmodSync)(entryPath, 320);
    } else if (stat.isFile()) (0, import_node_fs.chmodSync)(entryPath, stat.mode & 73 ? 320 : 256);
    else throw new Error("unsafe shared plugin generation artifact");
  };
  seal(path);
}
function parseSharedPluginsManifest(value, root) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "generation", "plugins", "fingerprint"].includes(key)) || value.version !== VERSION || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || !Array.isArray(value.plugins) || !isSha256(value.fingerprint)) return null;
  const plugins = [];
  for (const plugin of value.plugins) {
    if (!isRecord(plugin) || Object.keys(plugin).some((key) => !["id", "version", "fingerprint", "fileCount", "bytes"].includes(key)) || !isSafePluginId(String(plugin.id)) || typeof plugin.version !== "string" || !isSafePluginSegment(plugin.version) || !isSha256(plugin.fingerprint) || !Number.isSafeInteger(plugin.fileCount) || Number(plugin.fileCount) < 1 || !Number.isSafeInteger(plugin.bytes) || Number(plugin.bytes) < 0) return null;
    plugins.push({
      id: plugin.id,
      version: plugin.version,
      fingerprint: plugin.fingerprint,
      fileCount: plugin.fileCount,
      bytes: plugin.bytes
    });
  }
  if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length || pluginInventoryFingerprint(value.generation, plugins) !== value.fingerprint) return null;
  const manifest = { version: VERSION, generation: value.generation, plugins: plugins.sort((left, right) => left.id.localeCompare(right.id)), fingerprint: value.fingerprint };
  if (!root) return manifest;
  const cache = (0, import_node_path.join)(root, PLUGIN_GENERATIONS_DIRECTORY, String(value.generation), "cache");
  try {
    const scanned = scanPluginCache(cache);
    const actual = scanned.map((entry) => ({ id: entry.id, version: entry.version, fingerprint: entry.fingerprint, fileCount: entry.files.length, bytes: entry.bytes }));
    if (pluginInventoryFingerprint(value.generation, actual) !== manifest.fingerprint) return null;
    return { ...manifest, root: cache };
  } catch {
    return null;
  }
}
function bootstrapSharedPluginsManifest(stateRoot, primaryCodexHome, generation = 1, apply = false, expectedPrior, expectedCandidate, faultAt) {
  try {
    const source = (0, import_node_path.join)((0, import_node_path.resolve)(primaryCodexHome), "plugins", "cache");
    const config = readAccountConfig(primaryCodexHome);
    const enabledIds = new Set(Object.entries(getTomlNode(config.tree, ["plugins"]) ?? {}).filter(([, value]) => isTomlTable(value) && isTomlScalar(value.enabled) && value.enabled.type === "boolean" && value.enabled.value).map(([id]) => id));
    const packages = (0, import_node_fs.existsSync)(source) ? scanPluginCache(source, enabledIds) : [];
    const plugins = packages.map((entry) => ({
      id: entry.id,
      version: entry.version,
      fingerprint: entry.fingerprint,
      fileCount: entry.files.length,
      bytes: entry.bytes
    }));
    const manifest = { version: VERSION, generation, plugins, fingerprint: pluginInventoryFingerprint(generation, plugins) };
    if (expectedCandidate && manifest.fingerprint !== expectedCandidate) {
      throw new Error("shared plugin candidate does not match recovery intent");
    }
    if (!apply) return manifest;
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafeOwnerDirectory(root, true);
    const previous = readPrivateJson(root, PLUGIN_MANIFEST_FILE);
    const previousManifest = previous === null ? null : parseSharedPluginsManifest(previous);
    if (previous !== null && !previousManifest) throw new Error("shared plugin publication preimage is invalid");
    if (expectedPrior ? !isRecord(previous) || previous.fingerprint !== expectedPrior : previous !== null) {
      throw new Error("shared plugin inventory changed before publication");
    }
    if (previousManifest && generation <= (previousManifest.generation ?? 0) && previousManifest.fingerprint !== manifest.fingerprint) {
      throw new Error("shared plugin publication cannot replace a published generation");
    }
    if (previousManifest?.fingerprint === manifest.fingerprint) {
      const loaded = parseSharedPluginsManifest(previous, root);
      if (!loaded) throw new Error("published shared plugin generation is invalid");
      return loaded;
    }
    const generationsRoot = (0, import_node_path.join)(root, PLUGIN_GENERATIONS_DIRECTORY);
    assertSafeOwnerDirectory(generationsRoot, true);
    const generationRoot = (0, import_node_path.join)(generationsRoot, String(generation));
    const fingerprintTag = manifest.fingerprint.slice("sha256:".length, "sha256:".length + 16);
    const stagingRoot = (0, import_node_path.join)(generationsRoot, `.staging-${generation}-${fingerprintTag}`);
    const interruptedRoot = (0, import_node_path.join)(generationsRoot, `.interrupted-${generation}-${fingerprintTag}`);
    if (!expectedCandidate && ((0, import_node_fs.existsSync)(generationRoot) || (0, import_node_fs.existsSync)(stagingRoot))) {
      throw new Error("shared plugin unpublished generation requires an exact recovery candidate");
    }
    const currentSourceFingerprint = () => {
      const latestConfig = readAccountConfig(primaryCodexHome);
      const latestEnabledIds = new Set(Object.entries(getTomlNode(latestConfig.tree, ["plugins"]) ?? {}).filter(([, value]) => isTomlTable(value) && isTomlScalar(value.enabled) && value.enabled.type === "boolean" && value.enabled.value).map(([id]) => id));
      const latestPackages = (0, import_node_fs.existsSync)(source) ? scanPluginCache(source, latestEnabledIds) : [];
      return pluginInventoryFingerprint(generation, latestPackages.map((entry) => ({
        id: entry.id,
        version: entry.version,
        fingerprint: entry.fingerprint,
        fileCount: entry.files.length,
        bytes: entry.bytes
      })));
    };
    const assertPublicationInputsUnchanged = () => {
      if (currentSourceFingerprint() !== manifest.fingerprint) throw new Error("shared plugin source changed before publication");
      const latest = readPrivateJson(root, PLUGIN_MANIFEST_FILE);
      if (expectedPrior ? !isRecord(latest) || latest.fingerprint !== expectedPrior : latest !== null) {
        throw new Error("plugin publication preimage changed");
      }
    };
    const preserveIncomplete = (path) => {
      assertPluginGenerationContainer(path);
      assertPublicationInputsUnchanged();
      if ((0, import_node_fs.existsSync)(interruptedRoot)) throw new Error("shared plugin interrupted-generation archive already exists");
      (0, import_node_fs.renameSync)(path, interruptedRoot);
      fsyncDirectory(generationsRoot);
    };
    if ((0, import_node_fs.existsSync)(generationRoot)) {
      if (!verifiedPluginGeneration(generationRoot, manifest)) preserveIncomplete(generationRoot);
      else {
        assertPublicationInputsUnchanged();
        sealPluginGeneration(generationRoot, manifest);
      }
    }
    if (!(0, import_node_fs.existsSync)(generationRoot) && (0, import_node_fs.existsSync)(stagingRoot)) {
      if (verifiedPluginGeneration(stagingRoot, manifest)) {
        assertPublicationInputsUnchanged();
        sealPluginGeneration(stagingRoot, manifest);
        (0, import_node_fs.renameSync)(stagingRoot, generationRoot);
        fsyncDirectory(generationsRoot);
      } else preserveIncomplete(stagingRoot);
    }
    if (!(0, import_node_fs.existsSync)(generationRoot)) {
      (0, import_node_fs.mkdirSync)(stagingRoot, { mode: PRIVATE_DIRECTORY_MODE });
      const cache = (0, import_node_path.join)(stagingRoot, "cache");
      assertSafeOwnerDirectory(cache, true);
      let copiedFiles = 0;
      for (const entry of packages) {
        const target = (0, import_node_path.join)(cache, entry.registry, entry.name, entry.version);
        copyPluginPackage((0, import_node_path.join)(source, entry.registry, entry.name, entry.version), target, entry.files, true, () => {
          copiedFiles += 1;
          if (faultAt === "during_copy" && copiedFiles === 1) throw new Error("injected shared plugin fault during copy");
        });
        const after = scanPluginPackage(target);
        if (sha256Json({ id: entry.id, version: entry.version, files: after }) !== entry.fingerprint) throw new Error("sealed plugin copy verification failed");
      }
      if (pluginGenerationArtifactFingerprint(manifest, cache) !== manifest.fingerprint) throw new Error("sealed plugin generation verification failed");
      sealPluginGeneration(stagingRoot, manifest);
      assertPublicationInputsUnchanged();
      if ((0, import_node_fs.existsSync)(generationRoot)) throw new Error("shared plugin generation appeared before publication");
      (0, import_node_fs.renameSync)(stagingRoot, generationRoot);
      fsyncDirectory(generationsRoot);
    }
    if (!verifiedPluginGeneration(generationRoot, manifest)) throw new Error("shared plugin generation failed final verification");
    assertPublicationInputsUnchanged();
    atomicWritePrivateJson(root, PLUGIN_MANIFEST_FILE, {
      version: VERSION,
      generation,
      plugins,
      fingerprint: manifest.fingerprint
    });
    return { ...manifest, root: (0, import_node_path.join)(generationRoot, "cache") };
  } catch {
    return null;
  }
}
function loadSharedPluginsManifestV1(stateRoot) {
  try {
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafeOwnerDirectory(root);
    return parseSharedPluginsManifest(readPrivateJson(root, PLUGIN_MANIFEST_FILE), root);
  } catch {
    return null;
  }
}
function publishPrimaryPluginInventoryAfterExit(input) {
  try {
    const generation = input.prior.generation ?? 1;
    const preview = bootstrapSharedPluginsManifest(input.stateRoot, input.account.codexHome, generation, false);
    if (!preview) return null;
    if (preview.fingerprint === input.prior.fingerprint) return input.prior;
    assertWriteEvidence(input.writeEvidence);
    const candidate = bootstrapSharedPluginsManifest(input.stateRoot, input.account.codexHome, generation + 1, false);
    if (!candidate) return null;
    return bootstrapSharedPluginsManifest(input.stateRoot, input.account.codexHome, generation + 1, true, input.prior.fingerprint, candidate.fingerprint);
  } catch {
    return null;
  }
}
var PLUGIN_PROJECTIONS_FILE = "plugin-projections.v1.json";
var PLUGIN_PROJECTION_INTENT_FILE = "plugin-projection-intent.v1.json";
function pluginNameFingerprint(path, id, entry) {
  try {
    assertSafeCapabilityDirectory(path);
    const names = (0, import_node_fs.readdirSync)(path);
    if (names.length !== 1 || names[0] !== entry.version) return null;
    return sha256Json({ id, version: entry.version, files: scanPluginPackage((0, import_node_path.join)(path, entry.version)) });
  } catch {
    return null;
  }
}
function preparePluginPackages(input, accountRoot) {
  const raw = readPrivateJson(accountRoot, PLUGIN_PROJECTIONS_FILE);
  if (raw !== null && (!isRecord(raw) || raw.version !== 1 || raw.opaqueAccountId !== input.account.opaqueAccountId || !isRecord(raw.entries))) {
    throw new Error("invalid plugin projection receipt");
  }
  const entries = raw === null ? {} : { ...raw.entries };
  for (const [id, entry] of Object.entries(entries)) {
    if (!isSafePluginId(id) || !isRecord(entry) || !isSafePluginSegment(entry.version) || !isSha256(entry.fingerprint)) throw new Error("invalid plugin projection entry");
  }
  const root = (0, import_node_path.join)((0, import_node_path.resolve)(input.account.codexHome), "plugins", "cache");
  const save = () => atomicWritePrivateJson(accountRoot, PLUGIN_PROJECTIONS_FILE, { version: 1, opaqueAccountId: input.account.opaqueAccountId, entries });
  const pending = readPrivateJson(accountRoot, PLUGIN_PROJECTION_INTENT_FILE);
  if (pending !== null) {
    if (!input.apply) return false;
    assertWriteEvidence(input.writeEvidence);
    if (!isRecord(pending) || !isSafePluginId(String(pending.id)) || typeof pending.transaction !== "string" || !/^\.tweakers-plugins-[a-f0-9]{16}$/.test(pending.transaction) || !isRecord(pending.after) || !isSafePluginSegment(String(pending.after.version)) || !isSha256(pending.after.fingerprint) || pending.before !== null && (!isRecord(pending.before) || !isSafePluginSegment(String(pending.before.version)) || !isSha256(pending.before.fingerprint))) {
      throw new Error("invalid pending plugin projection");
    }
    const id = String(pending.id);
    const [name, registry] = id.split("@");
    const target = (0, import_node_path.join)(root, registry, name);
    const transaction = (0, import_node_path.join)((0, import_node_path.resolve)(input.account.codexHome), pending.transaction);
    assertSafeCapabilityDirectory(transaction);
    const before = pending.before;
    const after = pending.after;
    const backup = (0, import_node_path.join)(transaction, "backup");
    if (pluginNameFingerprint(target, id, after) === after.fingerprint) {
      entries[id] = after;
      save();
    } else if (!lstatIfPresent(target) && before && pluginNameFingerprint(backup, id, before) === before.fingerprint) {
      (0, import_node_fs.renameSync)(backup, target);
    } else if (before && pluginNameFingerprint(target, id, before) === before.fingerprint || !before && !lstatIfPresent(target)) {
    } else throw new Error("plugin projection recovery requires inspection");
    (0, import_node_fs.rmSync)(transaction, { recursive: true, force: true });
    (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, PLUGIN_PROJECTION_INTENT_FILE));
  }
  let ready = true;
  for (const plugin of input.plugins.plugins) {
    if (!plugin.version || !plugin.fingerprint || !input.plugins.root) throw new Error("plugin inventory lacks immutable payload");
    const [name, registry] = plugin.id.split("@");
    if (!isSafePluginId(plugin.id) || !isSafePluginSegment(plugin.version)) throw new Error("invalid plugin inventory path");
    const target = (0, import_node_path.join)(root, registry, name);
    for (const parent of [(0, import_node_path.join)(input.account.codexHome, "plugins"), root, (0, import_node_path.join)(root, registry)]) {
      if (lstatIfPresent(parent)) assertSafeCapabilityDirectory(parent);
    }
    const prior = entries[plugin.id];
    const present = lstatIfPresent(target);
    if (present && (!prior || pluginNameFingerprint(target, plugin.id, prior) !== prior.fingerprint)) continue;
    if (present && prior?.version === plugin.version && prior.fingerprint === plugin.fingerprint) continue;
    ready = false;
    if (!input.apply) continue;
    assertWriteEvidence(input.writeEvidence);
    assertSafeOwnerDirectory((0, import_node_path.join)(root, registry), true);
    const after = { version: plugin.version, fingerprint: plugin.fingerprint };
    const source = (0, import_node_path.join)(input.plugins.root, registry, name, plugin.version);
    const files = scanPluginPackage(source);
    if (sha256Json({ id: plugin.id, version: plugin.version, files }) !== plugin.fingerprint) throw new Error("shared plugin package changed");
    const transactionName = `.tweakers-plugins-${(0, import_node_crypto.randomBytes)(8).toString("hex")}`;
    const transaction = (0, import_node_path.join)((0, import_node_path.resolve)(input.account.codexHome), transactionName);
    (0, import_node_fs.mkdirSync)(transaction, { mode: PRIVATE_DIRECTORY_MODE });
    const candidate = (0, import_node_path.join)(transaction, "candidate");
    copyPluginPackage(source, (0, import_node_path.join)(candidate, plugin.version), files, false);
    if (pluginNameFingerprint(candidate, plugin.id, after) !== plugin.fingerprint) throw new Error("account plugin copy failed verification");
    atomicWritePrivateJson(accountRoot, PLUGIN_PROJECTION_INTENT_FILE, { id: plugin.id, transaction: transactionName, before: present ? prior : null, after });
    assertWriteEvidence(input.writeEvidence);
    if (present ? pluginNameFingerprint(target, plugin.id, prior) !== prior.fingerprint : lstatIfPresent(target) !== null) throw new Error("account plugin changed before publication");
    if (present) (0, import_node_fs.renameSync)(target, (0, import_node_path.join)(transaction, "backup"));
    (0, import_node_fs.renameSync)(candidate, target);
    fsyncDirectory((0, import_node_path.dirname)(target));
    entries[plugin.id] = after;
    save();
    (0, import_node_fs.rmSync)(transaction, { recursive: true, force: true });
    (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, PLUGIN_PROJECTION_INTENT_FILE));
  }
  return input.apply ? true : ready;
}
function parseSharedSourceProvenanceReceipt(value, source) {
  if (!isRecord(value) || !isOpaqueAccountId(value.primaryOpaqueAccountId) || !isSha256(value.sharedBaseFingerprint) || !isSha256(value.sharedPluginFingerprint)) return null;
  if (source === "bootstrap") {
    const legacy = value.version === 1;
    const allowed2 = legacy ? ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"] : ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedSourceOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"];
    if (!legacy && value.version !== 2 || Object.keys(value).some((key) => !allowed2.includes(key)) || !isSha256(value.schemaFingerprint) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || typeof value.createdAt !== "string" || !Array.isArray(value.accounts) || !legacy && !isOpaqueAccountId(value.sharedSourceOpaqueAccountId)) return null;
    const accountIds = value.accounts.map((entry) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 3 || !isOpaqueAccountId(entry.opaqueAccountId) || !isSha256(entry.configOverridesFingerprint) || !isSha256(entry.capabilityOverridesFingerprint)) return null;
      return entry.opaqueAccountId;
    });
    const donor = legacy ? value.primaryOpaqueAccountId : value.sharedSourceOpaqueAccountId;
    if (accountIds.includes(null) || new Set(accountIds).size !== accountIds.length || !accountIds.includes(value.primaryOpaqueAccountId) || !accountIds.includes(donor)) return null;
    return {
      state: "ready",
      primaryOpaqueAccountId: value.primaryOpaqueAccountId,
      sharedSourceOpaqueAccountId: donor,
      legacy,
      sharedBaseFingerprint: value.sharedBaseFingerprint,
      sharedPluginFingerprint: value.sharedPluginFingerprint
    };
  }
  const allowed = [
    "version",
    "primaryOpaqueAccountId",
    "previousSharedSourceOpaqueAccountId",
    "sharedSourceOpaqueAccountId",
    "priorSharedBaseFingerprint",
    "priorSharedPluginFingerprint",
    "sharedBaseFingerprint",
    "sharedPluginFingerprint",
    "sharedGeneration",
    "pluginGeneration",
    "accounts",
    "createdAt"
  ];
  if (value.version !== VERSION || Object.keys(value).some((key) => !allowed.includes(key)) || !isOpaqueAccountId(value.previousSharedSourceOpaqueAccountId) || !isOpaqueAccountId(value.sharedSourceOpaqueAccountId) || !isSha256(value.priorSharedBaseFingerprint) || !isSha256(value.priorSharedPluginFingerprint) || !Number.isSafeInteger(value.sharedGeneration) || Number(value.sharedGeneration) < 1 || !Number.isSafeInteger(value.pluginGeneration) || Number(value.pluginGeneration) < 1 || !Array.isArray(value.accounts) || typeof value.createdAt !== "string" || value.accounts.some((entry) => !isRecord(entry) || Object.keys(entry).length !== 3 || !isOpaqueAccountId(entry.opaqueAccountId) || !isSha256(entry.configOverridesFingerprint) || !isSha256(entry.capabilityOverridesFingerprint)) || new Set(value.accounts.map((entry) => entry.opaqueAccountId)).size !== value.accounts.length) return null;
  return {
    state: "ready",
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    sharedSourceOpaqueAccountId: value.sharedSourceOpaqueAccountId,
    legacy: false,
    sharedBaseFingerprint: value.sharedBaseFingerprint,
    sharedPluginFingerprint: value.sharedPluginFingerprint
  };
}
function loadAccountContinuitySharedSourceProvenanceV1(stateRoot) {
  try {
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafePrivateDirectoryReadOnly(root);
    const shared = loadSharedAccountBase(stateRoot);
    const plugins = loadSharedPluginsManifestV1(stateRoot);
    if (!shared || !plugins) return { state: "blocked", reason: "shared account continuity is not initialized" };
    const rebaseValue = readPrivateJson(root, SHARED_SOURCE_REBASE_RECEIPT_FILE);
    const source = rebaseValue === null ? "bootstrap" : "rebase";
    const value = rebaseValue ?? readPrivateJson(root, BOOTSTRAP_RECEIPT_FILE);
    const parsed = parseSharedSourceProvenanceReceipt(value, source);
    if (!parsed) return { state: "blocked", reason: "shared-source provenance is missing or invalid" };
    return { ...parsed, sharedBaseFingerprint: shared.fingerprint, sharedPluginFingerprint: plugins.fingerprint };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "shared-source provenance could not be loaded" };
  }
}
function sharedSourceRebaseIsPending(stateRoot) {
  const root = sharedAccountConfigRoot(stateRoot);
  assertSafePrivateDirectoryReadOnly(root);
  return readPrivateJson(root, SHARED_SOURCE_REBASE_INTENT_FILE) !== null;
}
function bootstrapAccountContinuity(input) {
  try {
    validateSchema(input.schema);
    const sharedSourceOpaqueAccountId = input.sharedSourceOpaqueAccountId ?? input.primaryOpaqueAccountId;
    if (!isOpaqueAccountId(input.primaryOpaqueAccountId) || !isOpaqueAccountId(sharedSourceOpaqueAccountId) || input.accounts.length === 0 || input.accounts.length > 64) {
      return { state: "blocked", reason: "invalid account continuity bootstrap accounts" };
    }
    const accounts = [...input.accounts];
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length || !accounts.some((account) => account.opaqueAccountId === input.primaryOpaqueAccountId) || !accounts.some((account) => account.opaqueAccountId === sharedSourceOpaqueAccountId)) {
      return { state: "blocked", reason: "invalid account continuity bootstrap binding" };
    }
    const sharedSource = accounts.find((account) => account.opaqueAccountId === sharedSourceOpaqueAccountId);
    const documents = /* @__PURE__ */ new Map();
    const capabilities = /* @__PURE__ */ new Map();
    for (const account of accounts) {
      if (!isOpaqueAccountId(account.opaqueAccountId) || !(0, import_node_path.isAbsolute)(account.codexHome)) return { state: "blocked", reason: "invalid account home" };
      documents.set(account.opaqueAccountId, readAccountConfig(account.codexHome));
      capabilities.set(account.opaqueAccountId, scanCapabilityTree(account.codexHome));
    }
    const generation = input.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) return { state: "blocked", reason: "invalid shared account generation" };
    const shared = withGeneration(projectPrimarySharedBase(documents.get(sharedSource.opaqueAccountId), scanPrimarySharedCapabilities(sharedSource.codexHome), input.schema), generation);
    const configOverrides = {};
    const capabilityOverrides = {};
    for (const account of accounts) {
      const document = documents.get(account.opaqueAccountId);
      const snapshot = capabilities.get(account.opaqueAccountId);
      configOverrides[account.opaqueAccountId] = buildConfigOverrides(account.opaqueAccountId, generation, document.tree, input.schema);
      capabilityOverrides[account.opaqueAccountId] = buildCapabilityOverrides(account.opaqueAccountId, generation, snapshot);
    }
    const pluginPreview = bootstrapSharedPluginsManifest(input.stateRoot, sharedSource.codexHome, generation, false);
    if (!pluginPreview) return { state: "blocked", reason: "shared-source plugin inventory is unsafe or unsupported" };
    if (!input.apply) return { state: "ready", shared, plugins: pluginPreview, configOverrides, capabilityOverrides };
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    if (loadSharedAccountBase(input.stateRoot) || loadSharedPluginsManifestV1(input.stateRoot)) {
      return { state: "blocked", reason: "account continuity bootstrap metadata already exists" };
    }
    for (const account of accounts) {
      const root = accountStateRoot(input.stateRoot, account);
      if ((0, import_node_fs.existsSync)((0, import_node_path.join)(root, CONFIG_OVERRIDES_FILE)) || (0, import_node_fs.existsSync)((0, import_node_path.join)(root, CAPABILITY_OVERRIDES_FILE))) {
        return { state: "blocked", reason: "account continuity bootstrap sidecar already exists" };
      }
    }
    for (const account of accounts) {
      const root = accountStateRoot(input.stateRoot, account);
      assertSafeOwnerDirectory(root, true);
      writeCapabilityPayloads(root, capabilities.get(account.opaqueAccountId));
      persistConfigOverrides(root, configOverrides[account.opaqueAccountId]);
      persistCapabilityOverrides(root, capabilityOverrides[account.opaqueAccountId]);
    }
    writeSharedAccountBase(input.stateRoot, shared);
    const plugins = bootstrapSharedPluginsManifest(input.stateRoot, sharedSource.codexHome, generation, true, void 0, pluginPreview.fingerprint);
    if (!plugins) throw new Error("unable to publish shared-source plugin inventory");
    atomicWritePrivateJson(sharedRoot, BOOTSTRAP_RECEIPT_FILE, {
      version: 2,
      schemaFingerprint: input.schema.schemaFingerprint,
      generation,
      primaryOpaqueAccountId: input.primaryOpaqueAccountId,
      sharedSourceOpaqueAccountId,
      sharedBaseFingerprint: shared.fingerprint,
      sharedPluginFingerprint: plugins.fingerprint,
      accounts: accounts.map((account) => ({
        opaqueAccountId: account.opaqueAccountId,
        configOverridesFingerprint: configOverrides[account.opaqueAccountId].fingerprint,
        capabilityOverridesFingerprint: capabilityOverrides[account.opaqueAccountId].fingerprint
      })).sort((left, right) => left.opaqueAccountId.localeCompare(right.opaqueAccountId)),
      createdAt: input.now?.() ?? (/* @__PURE__ */ new Date()).toISOString()
    });
    return { state: "ready", shared, plugins, configOverrides, capabilityOverrides };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account continuity bootstrap failed" };
  }
}
function rebasedConfigOverrides(overrides, generation) {
  if (overrides.basedOnSharedGeneration === generation) return overrides;
  const draft = {
    ...overrides,
    revision: overrides.revision + 1,
    basedOnSharedGeneration: generation,
    operations: normalizeConfigOperations(overrides.operations)
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}
function rebasedCapabilityOverrides(overrides, generation) {
  if (overrides.basedOnSharedGeneration === generation) return overrides;
  const draft = {
    version: VERSION,
    opaqueAccountId: overrides.opaqueAccountId,
    revision: overrides.revision + 1,
    basedOnSharedGeneration: generation,
    operations: normalizeCapabilityOperations(overrides.operations),
    preservationFingerprint: overrides.preservationFingerprint
  };
  return { ...draft, fingerprint: accountCapabilityOverridesFingerprint(draft), ...overrides.payloadRoot ? { payloadRoot: overrides.payloadRoot } : {} };
}
function serializableCapabilityOverrides(overrides) {
  const { payloadRoot: _payloadRoot, ...serializable } = overrides;
  return serializable;
}
function parseSharedSourceRebaseIntent(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version",
    "primaryOpaqueAccountId",
    "previousSharedSourceOpaqueAccountId",
    "sharedSourceOpaqueAccountId",
    "priorSharedBaseFingerprint",
    "priorSharedPluginFingerprint",
    "sharedBaseFingerprint",
    "sharedPluginFingerprint",
    "sharedGeneration",
    "pluginGeneration",
    "accounts",
    "fingerprint"
  ].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.primaryOpaqueAccountId) || !isOpaqueAccountId(value.previousSharedSourceOpaqueAccountId) || !isOpaqueAccountId(value.sharedSourceOpaqueAccountId) || ![value.priorSharedBaseFingerprint, value.priorSharedPluginFingerprint, value.sharedBaseFingerprint, value.sharedPluginFingerprint, value.fingerprint].every(isSha256) || !Number.isSafeInteger(value.sharedGeneration) || Number(value.sharedGeneration) < 1 || !Number.isSafeInteger(value.pluginGeneration) || Number(value.pluginGeneration) < 1 || !Array.isArray(value.accounts)) return null;
  const accounts = [];
  for (const entry of value.accounts) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => ![
      "opaqueAccountId",
      "capturedConfigArtifactFingerprint",
      "capturedCapabilityArtifactFingerprint",
      "beforeConfig",
      "beforeCapabilities",
      "afterConfig",
      "afterCapabilities"
    ].includes(key)) || !isOpaqueAccountId(entry.opaqueAccountId) || !isSha256(entry.capturedConfigArtifactFingerprint) || !isSha256(entry.capturedCapabilityArtifactFingerprint)) return null;
    const beforeConfig = parseConfigOverrides(entry.beforeConfig);
    const beforeCapabilities = parseCapabilityOverrides(entry.beforeCapabilities);
    const afterConfig = parseConfigOverrides(entry.afterConfig);
    const afterCapabilities = parseCapabilityOverrides(entry.afterCapabilities);
    if (!beforeConfig || !beforeCapabilities || !afterConfig || !afterCapabilities || [beforeConfig, beforeCapabilities, afterConfig, afterCapabilities].some((sidecar) => sidecar.opaqueAccountId !== entry.opaqueAccountId)) return null;
    accounts.push({
      opaqueAccountId: entry.opaqueAccountId,
      capturedConfigArtifactFingerprint: entry.capturedConfigArtifactFingerprint,
      capturedCapabilityArtifactFingerprint: entry.capturedCapabilityArtifactFingerprint,
      beforeConfig,
      beforeCapabilities: serializableCapabilityOverrides(beforeCapabilities),
      afterConfig,
      afterCapabilities: serializableCapabilityOverrides(afterCapabilities)
    });
  }
  if (new Set(accounts.map((entry) => entry.opaqueAccountId)).size !== accounts.length) return null;
  const { fingerprint, ...draft } = value;
  if (sha256Json(draft) !== fingerprint) return null;
  return { ...draft, accounts, fingerprint: value.fingerprint };
}
function sharedSourceCandidate(input, source, generations = {
  shared: input.priorShared.config.generation + 1,
  plugins: (input.priorPlugins.generation ?? input.priorShared.config.generation) + 1
}) {
  const sharedGeneration = generations.shared;
  const pluginGeneration = generations.plugins;
  if (!Number.isSafeInteger(sharedGeneration) || !Number.isSafeInteger(pluginGeneration)) throw new Error("shared-source generation overflow");
  const shared = withGeneration(projectPrimarySharedBase(readAccountConfig(source.codexHome), scanPrimarySharedCapabilities(source.codexHome), input.schema), sharedGeneration);
  const plugins = bootstrapSharedPluginsManifest(input.stateRoot, source.codexHome, pluginGeneration, false);
  if (!plugins) throw new Error("shared-source plugin inventory is unsafe or unsupported");
  return { shared, plugins, fingerprint: sha256Json({ shared: shared.fingerprint, plugins: plugins.fingerprint }) };
}
function abortUnpublishedSharedSourceRebase(input) {
  try {
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    assertSafeOwnerDirectory(sharedRoot);
    if (!isSha256(input.expectedIntentFingerprint) || input.accounts.length === 0 || input.accounts.length > 64 || new Set(input.accounts.map((account) => account.opaqueAccountId)).size !== input.accounts.length || input.accounts.some((account) => !isOpaqueAccountId(account.opaqueAccountId) || !(0, import_node_path.isAbsolute)(account.codexHome))) {
      throw new Error("invalid unpublished rebase recovery input");
    }
    const raw = readPrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE);
    if (raw === null) return { state: "absent" };
    const intent = parseSharedSourceRebaseIntent(raw);
    if (!intent || intent.fingerprint !== input.expectedIntentFingerprint) throw new Error("shared-source rebase intent changed");
    const archiveFile = `shared-source-rebase-aborted-${intent.fingerprint.slice("sha256:".length)}.v1.json`;
    const archivePath = (0, import_node_path.join)(sharedRoot, archiveFile);
    if (lstatIfPresent(archivePath)) throw new Error("shared-source rebase recovery archive already exists");
    const assertUnchanged = (requireLease) => {
      const currentIntent = parseSharedSourceRebaseIntent(readPrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE));
      const shared = loadSharedAccountBase(input.stateRoot);
      const plugins = loadSharedPluginsManifestV1(input.stateRoot);
      if (!currentIntent || currentIntent.fingerprint !== intent.fingerprint || shared?.fingerprint !== intent.priorSharedBaseFingerprint || plugins?.fingerprint !== intent.priorSharedPluginFingerprint) {
        throw new Error("shared-source rebase was published or changed; rollback is unavailable");
      }
      for (const entry of intent.accounts) {
        const account = input.accounts.find((candidate) => candidate.opaqueAccountId === entry.opaqueAccountId);
        if (!account) throw new Error("shared-source recovery account is missing");
        if (requireLease) assertWriteEvidence(input.accountWriteEvidence?.[entry.opaqueAccountId]);
        const config = loadAccountConfigOverrides(input.stateRoot, account);
        const capabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
        if (!config || !capabilities || ![entry.beforeConfig.fingerprint, entry.afterConfig.fingerprint].includes(config.fingerprint) || ![entry.beforeCapabilities.fingerprint, entry.afterCapabilities.fingerprint].includes(capabilities.fingerprint)) {
          throw new Error("shared-source recovery sidecars changed");
        }
        if (readAccountConfig(account.codexHome).fingerprint !== entry.capturedConfigArtifactFingerprint || effectiveCapabilityFingerprint(scanCapabilityTree(account.codexHome).files) !== entry.capturedCapabilityArtifactFingerprint) {
          throw new Error("shared-source recovery account artifacts changed");
        }
      }
    };
    assertUnchanged(Boolean(input.apply));
    if (!input.apply) return { state: "would_abort", archiveFile };
    for (const entry of intent.accounts) {
      const account = input.accounts.find((candidate) => candidate.opaqueAccountId === entry.opaqueAccountId);
      const root = accountStateRoot(input.stateRoot, account);
      assertUnchanged(true);
      if (loadAccountConfigOverrides(input.stateRoot, account).fingerprint !== entry.beforeConfig.fingerprint) {
        persistConfigOverrides(root, entry.beforeConfig);
      }
      assertUnchanged(true);
      if (loadAccountCapabilityOverrides(input.stateRoot, account).fingerprint !== entry.beforeCapabilities.fingerprint) {
        persistCapabilityOverrides(root, entry.beforeCapabilities);
      }
    }
    if (input.faultAt === "after_sidecars") throw new Error("injected unpublished rebase recovery fault after sidecars");
    assertUnchanged(true);
    if (lstatIfPresent(archivePath)) throw new Error("shared-source rebase recovery archive changed");
    (0, import_node_fs.renameSync)((0, import_node_path.join)(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE), archivePath);
    fsyncDirectory(sharedRoot);
    return { state: "aborted", archiveFile };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "unpublished rebase recovery failed" };
  }
}
function rebaseAccountContinuitySharedSource(input) {
  try {
    validateSchema(input.schema);
    if (!isOpaqueAccountId(input.primaryOpaqueAccountId) || !isOpaqueAccountId(input.sharedSourceOpaqueAccountId) || input.accounts.length === 0 || input.accounts.length > 64) throw new Error("invalid shared-source rebase accounts");
    const accounts = [...input.accounts];
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length || !accounts.some((account) => account.opaqueAccountId === input.primaryOpaqueAccountId)) throw new Error("routing primary is not an exact rebase member");
    const source = accounts.find((account) => account.opaqueAccountId === input.sharedSourceOpaqueAccountId);
    if (!source) throw new Error("shared source is not an exact rebase member");
    for (const account of accounts) if (!isOpaqueAccountId(account.opaqueAccountId) || !(0, import_node_path.isAbsolute)(account.codexHome)) throw new Error("invalid shared-source rebase account home");
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    assertSafeOwnerDirectory(sharedRoot);
    const existingIntentValue = readPrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE);
    const existingIntent = existingIntentValue === null ? null : parseSharedSourceRebaseIntent(existingIntentValue);
    if (existingIntentValue !== null && !existingIntent) throw new Error("invalid shared-source rebase recovery intent");
    const currentShared = loadSharedAccountBase(input.stateRoot);
    const currentPlugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!currentShared || !currentPlugins) throw new Error("shared account continuity is not initialized");
    if (!existingIntent) {
      if (currentShared.fingerprint !== input.priorShared.fingerprint || currentPlugins.fingerprint !== input.priorPlugins.fingerprint) {
        throw new Error("shared account state changed before donor rebase");
      }
      const provenance = loadAccountContinuitySharedSourceProvenanceV1(input.stateRoot);
      if (provenance.state !== "ready") throw new Error(provenance.reason ?? "shared-source provenance is unavailable");
      if (provenance.sharedSourceOpaqueAccountId === input.sharedSourceOpaqueAccountId) {
        return {
          state: "ready",
          sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
          sharedGeneration: currentShared.config.generation,
          pluginGeneration: currentPlugins.generation,
          shared: currentShared,
          plugins: currentPlugins
        };
      }
    }
    const journalGenerations = existingIntent ? { shared: existingIntent.sharedGeneration, plugins: existingIntent.pluginGeneration } : void 0;
    const firstCandidate = sharedSourceCandidate(input, source, journalGenerations);
    const finalCandidate = sharedSourceCandidate(input, source, journalGenerations);
    if (firstCandidate.fingerprint !== finalCandidate.fingerprint) {
      const changed = [
        ...firstCandidate.shared.config.fingerprint !== finalCandidate.shared.config.fingerprint ? ["config"] : [],
        ...firstCandidate.shared.capabilities.fingerprint !== finalCandidate.shared.capabilities.fingerprint ? ["capabilities"] : [],
        ...firstCandidate.plugins.fingerprint !== finalCandidate.plugins.fingerprint ? ["plugins"] : []
      ];
      throw new Error(`shared source changed during read-only snapshot (${changed.join(", ") || "unknown"})`);
    }
    const candidate = finalCandidate;
    const candidatePluginGeneration = candidate.plugins.generation;
    if (candidatePluginGeneration === void 0) throw new Error("shared-source plugin candidate lacks a generation");
    let previousSource;
    let receiptPrimary;
    let planned;
    if (existingIntent) {
      if (existingIntent.sharedSourceOpaqueAccountId !== input.sharedSourceOpaqueAccountId || existingIntent.sharedBaseFingerprint !== candidate.shared.fingerprint || existingIntent.sharedPluginFingerprint !== candidate.plugins.fingerprint || ![existingIntent.priorSharedBaseFingerprint, existingIntent.sharedBaseFingerprint].includes(currentShared.fingerprint) || ![existingIntent.priorSharedPluginFingerprint, existingIntent.sharedPluginFingerprint].includes(currentPlugins.fingerprint)) {
        throw new Error("shared-source rebase recovery inputs changed");
      }
      previousSource = existingIntent.previousSharedSourceOpaqueAccountId;
      receiptPrimary = existingIntent.primaryOpaqueAccountId;
      planned = [...existingIntent.accounts];
    } else {
      const provenance = loadAccountContinuitySharedSourceProvenanceV1(input.stateRoot);
      if (provenance.state !== "ready" || !provenance.sharedSourceOpaqueAccountId) throw new Error(provenance.reason ?? "shared-source provenance is unavailable");
      previousSource = provenance.sharedSourceOpaqueAccountId;
      receiptPrimary = input.primaryOpaqueAccountId;
      planned = [];
      for (const account of accounts) {
        if (account.opaqueAccountId === input.sharedSourceOpaqueAccountId) continue;
        let config = loadAccountConfigOverrides(input.stateRoot, account);
        let capabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
        if (!config || !capabilities) throw new Error(`account ${account.opaqueAccountId} lacks rebase sidecars`);
        const stored = parseStoredMaterialization(readPrivateJson(accountStateRoot(input.stateRoot, account), MATERIALIZATION_FILE));
        if (!stored) throw new Error(`account ${account.opaqueAccountId} lacks a materialization receipt for donor rebase`);
        const captured = captureIdleAccountChangesBeforeSpawn({
          stateRoot: input.stateRoot,
          account,
          shared: input.priorShared,
          plugins: input.priorPlugins,
          schema: input.schema,
          configOverrides: config,
          capabilityOverrides: capabilities,
          writeEvidence: input.accountWriteEvidence?.[account.opaqueAccountId] ?? { accountChildAbsent: false },
          apply: false
        });
        if (captured.state === "blocked") throw new Error(captured.reason ?? `account ${account.opaqueAccountId} capture was blocked`);
        config = captured.configOverrides ?? config;
        capabilities = captured.capabilityOverrides ?? capabilities;
        const afterConfig = rebasedConfigOverrides(config, candidate.shared.config.generation);
        const afterCapabilities = rebasedCapabilityOverrides(capabilities, candidate.shared.capabilities.generation);
        const capturedConfig = readAccountConfig(account.codexHome);
        const capturedCapabilities = scanCapabilityTree(account.codexHome);
        planned.push({
          opaqueAccountId: account.opaqueAccountId,
          capturedConfigArtifactFingerprint: capturedConfig.fingerprint,
          capturedCapabilityArtifactFingerprint: effectiveCapabilityFingerprint(capturedCapabilities.files),
          beforeConfig: config,
          beforeCapabilities: serializableCapabilityOverrides(capabilities),
          afterConfig,
          afterCapabilities: serializableCapabilityOverrides(afterCapabilities)
        });
      }
    }
    const configOverrides = {};
    const capabilityOverrides = {};
    for (const account of accounts) {
      const entry = planned.find((candidateEntry) => candidateEntry.opaqueAccountId === account.opaqueAccountId);
      const config = entry?.afterConfig ?? loadAccountConfigOverrides(input.stateRoot, account);
      const capabilities = entry?.afterCapabilities ?? loadAccountCapabilityOverrides(input.stateRoot, account);
      if (!config || !capabilities) throw new Error(`account ${account.opaqueAccountId} lacks rebase sidecars`);
      configOverrides[account.opaqueAccountId] = config;
      capabilityOverrides[account.opaqueAccountId] = capabilities;
    }
    const result = {
      state: "ready",
      sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
      sharedGeneration: candidate.shared.config.generation,
      pluginGeneration: candidatePluginGeneration,
      shared: candidate.shared,
      plugins: candidate.plugins,
      configOverrides,
      capabilityOverrides
    };
    if (!input.apply) return result;
    for (const entry of planned) assertWriteEvidence(input.accountWriteEvidence?.[entry.opaqueAccountId]);
    const assertCapturedArtifactsUnchanged = () => {
      for (const entry of planned) {
        const account = accounts.find((candidateAccount) => candidateAccount.opaqueAccountId === entry.opaqueAccountId);
        const currentConfig = readAccountConfig(account.codexHome);
        const currentCapabilities = scanCapabilityTree(account.codexHome);
        if (currentConfig.fingerprint !== entry.capturedConfigArtifactFingerprint || effectiveCapabilityFingerprint(currentCapabilities.files) !== entry.capturedCapabilityArtifactFingerprint) {
          throw new Error(`account ${entry.opaqueAccountId} artifacts changed after donor capture`);
        }
      }
    };
    if (!existingIntent) {
      for (const entry of planned) {
        const account = accounts.find((candidateAccount) => candidateAccount.opaqueAccountId === entry.opaqueAccountId);
        const currentConfig = loadAccountConfigOverrides(input.stateRoot, account);
        const currentCapabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
        if (currentConfig.fingerprint !== entry.beforeConfig.fingerprint || currentCapabilities.fingerprint !== entry.beforeCapabilities.fingerprint) {
          const captured = captureIdleAccountChangesBeforeSpawn({
            stateRoot: input.stateRoot,
            account,
            shared: input.priorShared,
            plugins: input.priorPlugins,
            schema: input.schema,
            configOverrides: currentConfig,
            capabilityOverrides: currentCapabilities,
            writeEvidence: input.accountWriteEvidence[entry.opaqueAccountId],
            apply: true
          });
          if (captured.state === "blocked" || captured.configOverrides?.fingerprint !== entry.beforeConfig.fingerprint || captured.capabilityOverrides?.fingerprint !== entry.beforeCapabilities.fingerprint) {
            throw new Error(captured.reason ?? `account ${entry.opaqueAccountId} changed during donor capture`);
          }
        }
      }
      assertCapturedArtifactsUnchanged();
      const intentDraft = {
        version: VERSION,
        primaryOpaqueAccountId: receiptPrimary,
        previousSharedSourceOpaqueAccountId: previousSource,
        sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
        priorSharedBaseFingerprint: input.priorShared.fingerprint,
        priorSharedPluginFingerprint: input.priorPlugins.fingerprint,
        sharedBaseFingerprint: candidate.shared.fingerprint,
        sharedPluginFingerprint: candidate.plugins.fingerprint,
        sharedGeneration: candidate.shared.config.generation,
        pluginGeneration: candidatePluginGeneration,
        accounts: planned
      };
      atomicWritePrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE, { ...intentDraft, fingerprint: sha256Json(intentDraft) });
      if (input.faultAt === "after_intent") throw new Error("injected shared-source rebase fault after intent");
    }
    assertCapturedArtifactsUnchanged();
    for (const entry of planned) {
      const account = accounts.find((candidateAccount) => candidateAccount.opaqueAccountId === entry.opaqueAccountId);
      const root = accountStateRoot(input.stateRoot, account);
      const currentConfig = loadAccountConfigOverrides(input.stateRoot, account);
      const currentCapabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
      if (!currentConfig || !currentCapabilities) throw new Error("shared-source rebase sidecars disappeared");
      if (![entry.beforeConfig.fingerprint, entry.afterConfig.fingerprint].includes(currentConfig.fingerprint) || ![entry.beforeCapabilities.fingerprint, entry.afterCapabilities.fingerprint].includes(currentCapabilities.fingerprint)) {
        throw new Error(`account ${entry.opaqueAccountId} sidecars changed during donor rebase`);
      }
      assertWriteEvidence(input.accountWriteEvidence?.[entry.opaqueAccountId]);
      if (currentConfig.fingerprint !== entry.afterConfig.fingerprint) persistConfigOverrides(root, entry.afterConfig);
      if (currentCapabilities.fingerprint !== entry.afterCapabilities.fingerprint) persistCapabilityOverrides(root, entry.afterCapabilities);
    }
    if (input.faultAt === "after_sidecars") throw new Error("injected shared-source rebase fault after sidecars");
    const beforePublish = sharedSourceCandidate(input, source, journalGenerations);
    if (beforePublish.fingerprint !== candidate.fingerprint) throw new Error("shared source changed before donor publication");
    let publishedPlugins = loadSharedPluginsManifestV1(input.stateRoot);
    const expectedPriorPluginFingerprint = existingIntent?.priorSharedPluginFingerprint ?? input.priorPlugins.fingerprint;
    if (publishedPlugins?.fingerprint === expectedPriorPluginFingerprint) {
      publishedPlugins = bootstrapSharedPluginsManifest(
        input.stateRoot,
        source.codexHome,
        candidatePluginGeneration,
        true,
        expectedPriorPluginFingerprint,
        candidate.plugins.fingerprint,
        input.faultAt === "during_plugins" ? "during_copy" : void 0
      );
    }
    if (!publishedPlugins || publishedPlugins.fingerprint !== candidate.plugins.fingerprint) throw new Error("shared-source plugin publication failed");
    if (input.faultAt === "after_plugins") throw new Error("injected shared-source rebase fault after plugins");
    let publishedShared = loadSharedAccountBase(input.stateRoot);
    const expectedPriorSharedFingerprint = existingIntent?.priorSharedBaseFingerprint ?? input.priorShared.fingerprint;
    if (publishedShared?.fingerprint === expectedPriorSharedFingerprint) writeSharedAccountBase(input.stateRoot, candidate.shared, expectedPriorSharedFingerprint);
    publishedShared = loadSharedAccountBase(input.stateRoot);
    if (!publishedShared || publishedShared.fingerprint !== candidate.shared.fingerprint) throw new Error("shared-source base publication failed");
    if (input.faultAt === "after_shared") throw new Error("injected shared-source rebase fault after shared base");
    atomicWritePrivateJson(sharedRoot, SHARED_SOURCE_REBASE_RECEIPT_FILE, {
      version: VERSION,
      primaryOpaqueAccountId: receiptPrimary,
      previousSharedSourceOpaqueAccountId: previousSource,
      sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
      priorSharedBaseFingerprint: existingIntent?.priorSharedBaseFingerprint ?? input.priorShared.fingerprint,
      priorSharedPluginFingerprint: existingIntent?.priorSharedPluginFingerprint ?? input.priorPlugins.fingerprint,
      sharedBaseFingerprint: publishedShared.fingerprint,
      sharedPluginFingerprint: publishedPlugins.fingerprint,
      sharedGeneration: publishedShared.config.generation,
      pluginGeneration: publishedPlugins.generation,
      accounts: planned.map((entry) => ({ opaqueAccountId: entry.opaqueAccountId, configOverridesFingerprint: entry.afterConfig.fingerprint, capabilityOverridesFingerprint: entry.afterCapabilities.fingerprint })),
      createdAt: input.now?.() ?? (/* @__PURE__ */ new Date()).toISOString()
    });
    (0, import_node_fs.unlinkSync)((0, import_node_path.join)(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE));
    fsyncDirectory(sharedRoot);
    return { ...result, shared: publishedShared, plugins: publishedPlugins };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "shared-source rebase failed" };
  }
}
function ensureAccountContinuityEnrollment(input) {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before enrollment" };
    if (!isOpaqueAccountId(input.account.opaqueAccountId) || !(0, import_node_path.isAbsolute)(input.account.codexHome)) {
      return { state: "blocked", reason: "invalid account continuity enrollment home" };
    }
    const shared = loadSharedAccountBase(input.stateRoot);
    const plugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!shared || !plugins) return { state: "blocked", reason: "shared account continuity is not initialized" };
    if (shared.config.schemaFingerprint !== input.schema.schemaFingerprint) {
      return { state: "blocked", reason: "shared account continuity schema does not match enrollment" };
    }
    const root = accountStateRoot(input.stateRoot, input.account);
    const hasConfig = (0, import_node_fs.existsSync)((0, import_node_path.join)(root, CONFIG_OVERRIDES_FILE));
    const hasCapabilities = (0, import_node_fs.existsSync)((0, import_node_path.join)(root, CAPABILITY_OVERRIDES_FILE));
    if (hasConfig || hasCapabilities) {
      if (!hasConfig || !hasCapabilities) return { state: "blocked", reason: "account continuity enrollment has partial existing sidecars" };
      const configOverrides2 = loadAccountConfigOverrides(input.stateRoot, input.account);
      const capabilityOverrides2 = loadAccountCapabilityOverrides(input.stateRoot, input.account);
      if (!configOverrides2 || !capabilityOverrides2 || configOverrides2.opaqueAccountId !== input.account.opaqueAccountId || capabilityOverrides2.opaqueAccountId !== input.account.opaqueAccountId) {
        return { state: "blocked", reason: "account continuity enrollment sidecars are invalid" };
      }
      return { state: "ready", shared, plugins, configOverrides: configOverrides2, capabilityOverrides: capabilityOverrides2 };
    }
    const document = readAccountConfig(input.account.codexHome);
    const capabilities = scanCapabilityTree(input.account.codexHome);
    const configOverrides = buildConfigOverrides(input.account.opaqueAccountId, shared.config.generation, document.tree, input.schema);
    const capabilityOverrides = buildCapabilityOverrides(input.account.opaqueAccountId, shared.config.generation, capabilities);
    if (!input.apply) return { state: "would_enroll", shared, plugins, configOverrides, capabilityOverrides };
    assertWriteEvidence(input.writeEvidence);
    assertSafeOwnerDirectory(root, true);
    writeCapabilityPayloads(root, capabilities);
    persistConfigOverrides(root, configOverrides);
    persistCapabilityOverrides(root, capabilityOverrides);
    atomicWritePrivateJson(root, "enrollment-receipt.v1.json", {
      version: VERSION,
      schemaFingerprint: input.schema.schemaFingerprint,
      opaqueAccountId: input.account.opaqueAccountId,
      sharedBaseFingerprint: shared.fingerprint,
      sharedPluginFingerprint: plugins.fingerprint,
      configOverridesFingerprint: configOverrides.fingerprint,
      capabilityOverridesFingerprint: capabilityOverrides.fingerprint
    });
    return { state: "ready", shared, plugins, configOverrides, capabilityOverrides };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account continuity enrollment failed" };
  }
}
function pathHasPrefix(path, prefix) {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
function applyTextPatches(source, patches) {
  const ordered = [...patches].sort((left, right) => right.start - left.start || right.end - left.end);
  let previousStart = source.length + 1;
  let output = source;
  for (const patch of ordered) {
    if (!Number.isInteger(patch.start) || !Number.isInteger(patch.end) || patch.start < 0 || patch.end < patch.start || patch.end > source.length || patch.end > previousStart) {
      throw new Error("overlapping account continuity TOML patches");
    }
    output = `${output.slice(0, patch.start)}${patch.replacement}${output.slice(patch.end)}`;
    previousStart = patch.start;
  }
  return output;
}
function sourceTableBlockEnd(document, table) {
  const tables = Object.values(document.tables).sort((left, right) => left.range[0] - right.range[0]);
  const index = tables.findIndex((candidate) => candidate === table || candidate.range[0] === table.range[0] && candidate.range[1] === table.range[1]);
  if (index < 0) return document.source.length;
  return tables[index + 1]?.range[0] ?? document.source.length;
}
function insertionText(source, offset, lines) {
  if (lines.length === 0) return "";
  const before = source.slice(0, offset);
  const needLeadingNewline = before.length > 0 && !before.endsWith("\n");
  return `${needLeadingNewline ? "\n" : ""}${lines.join("\n")}
`;
}
function sourceAssignmentFor(document, path) {
  return document.assignments[pathKey(path)];
}
function effectiveTomlText(current, effective, inheritedPaths) {
  const currentLeaves = flattenTomlLeaves(current.tree);
  const effectiveLeaves = flattenTomlLeaves(effective);
  const inherited = new Set(inheritedPaths.map(configPathKey));
  const patches = [];
  const patchedOwnerPaths = /* @__PURE__ */ new Set();
  const removedPaths = /* @__PURE__ */ new Set();
  for (const [key, sourceEntry] of currentLeaves) {
    const desired = effectiveLeaves.get(key);
    const assignment = sourceAssignmentFor(current, sourceEntry.path);
    if (!assignment) throw new Error("missing TOML source assignment");
    const ownerKey = pathKey(assignment.ownerPath);
    if (desired === void 0) {
      if (!inherited.has(key)) continue;
      if (patchedOwnerPaths.has(ownerKey)) continue;
      patches.push({ start: assignment.range[0], end: consumeAssignmentNewline(current.source, assignment.range[1]), replacement: "" });
      patchedOwnerPaths.add(ownerKey);
      removedPaths.add(key);
      continue;
    }
    if (compareToml(sourceEntry.value, desired.value)) continue;
    if (patchedOwnerPaths.has(ownerKey)) continue;
    const ownerPath = assignment.ownerPath.map((part) => {
      if (typeof part !== "string") throw new Error("array-table source replacement is unsupported");
      return part;
    });
    const ownerDesired = getTomlNode(effective, ownerPath);
    if (!ownerDesired || !isTomlDataValue(ownerDesired)) throw new Error("changed TOML source owner has no effective value");
    const ownerAssignment = sourceAssignmentFor(current, ownerPath);
    if (!ownerAssignment) throw new Error("missing TOML source owner assignment");
    patches.push({ start: ownerAssignment.valueRange[0], end: ownerAssignment.valueRange[1], replacement: renderTomlValue(ownerDesired) });
    patchedOwnerPaths.add(ownerKey);
  }
  const additions = /* @__PURE__ */ new Map();
  for (const [key, desired] of effectiveLeaves) {
    if (currentLeaves.has(key)) continue;
    if (!isTomlDataValue(desired.value)) throw new Error("cannot materialize a bare TOML table");
    const parent = desired.path.slice(0, -1);
    const parentNode = getTomlNode(current.tree, parent);
    if (isTomlInlineTable(parentNode) || isTomlArrayTable(parentNode)) throw new Error("cannot extend a local inline or array TOML table");
    const groupKey = pathKey(parent);
    const group = additions.get(groupKey) ?? { parent, values: [] };
    group.values.push({ key: desired.path.at(-1), value: desired.value });
    additions.set(groupKey, group);
  }
  const tableBlocks = Object.values(current.tables).filter((table) => table.kind === "standard");
  const firstTableOffset = tableBlocks.length ? Math.min(...tableBlocks.map((table) => table.range[0])) : current.source.length;
  for (const group of additions.values()) {
    const lines = group.values.sort((left, right) => left.key.localeCompare(right.key)).map((entry) => `${renderTomlKey(entry.key)} = ${renderTomlValue(entry.value)}`);
    const knownTable = current.tables[pathKey(group.parent)];
    if (knownTable && knownTable.kind === "standard") {
      const offset2 = sourceTableBlockEnd(current, knownTable);
      patches.push({ start: offset2, end: offset2, replacement: insertionText(current.source, offset2, lines) });
      continue;
    }
    if (group.parent.length === 0) {
      patches.push({ start: firstTableOffset, end: firstTableOffset, replacement: insertionText(current.source, firstTableOffset, lines) });
      continue;
    }
    const offset = current.source.length;
    patches.push({ start: offset, end: offset, replacement: insertionText(current.source, offset, [`[${renderTomlPath(group.parent)}]`, ...lines]) });
  }
  const output = applyTextPatches(current.source, compactNonOverlappingPatches(patches));
  const parsed = parseLosslessTomlDocument(output);
  if (!compareTomlTrees(parsed.tree, effective)) {
    throw new Error("lossless TOML materialization did not produce the intended effective configuration");
  }
  void removedPaths;
  return output;
}
function compactNonOverlappingPatches(patches) {
  const grouped = /* @__PURE__ */ new Map();
  for (const patch of patches) {
    const key = `${patch.start}:${patch.end}`;
    const values = grouped.get(key) ?? [];
    values.push(patch);
    grouped.set(key, values);
  }
  return [...grouped.values()].map((values) => {
    if (values.length === 1) return values[0];
    if (values.some((value) => value.start !== value.end)) throw new Error("overlapping account continuity TOML patches");
    const first = values[0];
    return { ...first, replacement: values.map((value) => value.replacement).join("") };
  });
}
function consumeAssignmentNewline(source, end) {
  if (source.slice(end, end + 2) === "\r\n") return end + 2;
  if (source.slice(end, end + 1) === "\n") return end + 1;
  return end;
}
function compareTomlTrees(left, right) {
  return stableJson(left) === stableJson(right);
}
function renderResolvedAccountToml(current, effective, inheritedPaths = []) {
  return effectiveTomlText(current, effective, inheritedPaths);
}
function effectiveCapabilityFingerprint(files) {
  return sha256Json(files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}
function materializationFingerprint(value) {
  return sha256Json(value);
}
function parseStoredMaterialization(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version",
    "opaqueAccountId",
    "codexHome",
    "schemaFingerprint",
    "pluginFingerprint",
    "sharedGeneration",
    "configOverridesFingerprint",
    "capabilityOverridesFingerprint",
    "configArtifactFingerprint",
    "capabilityArtifactFingerprint",
    "effectiveConfigFingerprint",
    "effectiveCapabilityFingerprint",
    "expectedConfig",
    "expectedCapabilities",
    "inheritedConfigPaths",
    "inheritedCapabilityPaths",
    "fingerprint"
  ].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !(0, import_node_path.isAbsolute)(String(value.codexHome)) || ![
    value.schemaFingerprint,
    value.pluginFingerprint,
    value.configOverridesFingerprint,
    value.capabilityOverridesFingerprint,
    value.configArtifactFingerprint,
    value.capabilityArtifactFingerprint,
    value.effectiveConfigFingerprint,
    value.effectiveCapabilityFingerprint,
    value.fingerprint
  ].every(isSha256) || !Number.isSafeInteger(value.sharedGeneration) || Number(value.sharedGeneration) < 1 || !validateTomlNode(value.expectedConfig) || !isTomlTable(value.expectedConfig) || !Array.isArray(value.expectedCapabilities) || !Array.isArray(value.inheritedConfigPaths) || !Array.isArray(value.inheritedCapabilityPaths)) return null;
  const expectedCapabilities = [];
  for (const file of value.expectedCapabilities) {
    if (!isRecord(file) || Object.keys(file).some((key) => !["relativePath", "fingerprint", "provenance"].includes(key)) || !isSafeCapabilityRelativePath(String(file.relativePath)) || !isSha256(file.fingerprint) || !["shared", "override", "local_only"].includes(String(file.provenance))) return null;
    expectedCapabilities.push({ relativePath: file.relativePath, fingerprint: file.fingerprint, provenance: file.provenance });
  }
  if (new Set(expectedCapabilities.map((file) => file.relativePath)).size !== expectedCapabilities.length) return null;
  const inheritedConfigPaths = [];
  for (const path of value.inheritedConfigPaths) {
    if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string" || part.length === 0)) return null;
    inheritedConfigPaths.push(path);
  }
  const inheritedCapabilityPaths = [];
  for (const path of value.inheritedCapabilityPaths) {
    if (!isSafeCapabilityRelativePath(String(path))) return null;
    inheritedCapabilityPaths.push(path);
  }
  const draft = {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId,
    codexHome: (0, import_node_path.resolve)(value.codexHome),
    schemaFingerprint: value.schemaFingerprint,
    pluginFingerprint: value.pluginFingerprint,
    sharedGeneration: value.sharedGeneration,
    configOverridesFingerprint: value.configOverridesFingerprint,
    capabilityOverridesFingerprint: value.capabilityOverridesFingerprint,
    configArtifactFingerprint: value.configArtifactFingerprint,
    capabilityArtifactFingerprint: value.capabilityArtifactFingerprint,
    effectiveConfigFingerprint: value.effectiveConfigFingerprint,
    effectiveCapabilityFingerprint: value.effectiveCapabilityFingerprint,
    expectedConfig: value.expectedConfig,
    expectedCapabilities: expectedCapabilities.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    inheritedConfigPaths: inheritedConfigPaths.sort(compareStringPaths),
    inheritedCapabilityPaths: inheritedCapabilityPaths.sort()
  };
  return materializationFingerprint(draft) === value.fingerprint ? { ...draft, fingerprint: value.fingerprint } : null;
}
function materializationResult(stored, expectedCapabilities, state, written, reason) {
  return {
    version: VERSION,
    state,
    ...reason ? { reason } : {},
    opaqueAccountId: stored.opaqueAccountId,
    sharedGeneration: stored.sharedGeneration,
    configOverridesFingerprint: stored.configOverridesFingerprint,
    capabilityOverridesFingerprint: stored.capabilityOverridesFingerprint,
    configArtifactFingerprint: stored.configArtifactFingerprint,
    capabilityArtifactFingerprint: stored.capabilityArtifactFingerprint,
    effectiveConfigFingerprint: stored.effectiveConfigFingerprint,
    effectiveCapabilityFingerprint: stored.effectiveCapabilityFingerprint,
    expectedConfig: clone(stored.expectedConfig),
    expectedCapabilities: expectedCapabilities.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
    inheritedConfigPaths: clone(stored.inheritedConfigPaths),
    inheritedCapabilityPaths: [...stored.inheritedCapabilityPaths],
    written
  };
}
function materializationCandidate(input, config, capabilities, currentConfig, currentCapabilities) {
  if (config.state !== "ready" || !config.tree || !config.effectiveFingerprint || !config.inheritedPaths || !config.preservationFingerprint || capabilities.state !== "ready" || !capabilities.files || !capabilities.effectiveFingerprint || !capabilities.inheritedPaths) {
    throw new Error("cannot construct an account continuity materialization from a blocked resolution");
  }
  const expectedCapabilities = capabilities.files;
  const draft = {
    version: VERSION,
    opaqueAccountId: input.account.opaqueAccountId,
    codexHome: (0, import_node_path.resolve)(input.account.codexHome),
    schemaFingerprint: input.schema.schemaFingerprint,
    pluginFingerprint: input.plugins.fingerprint,
    sharedGeneration: input.shared.config.generation,
    configOverridesFingerprint: input.configOverrides.fingerprint,
    capabilityOverridesFingerprint: input.capabilityOverrides.fingerprint,
    configArtifactFingerprint: currentConfig.fingerprint,
    capabilityArtifactFingerprint: effectiveCapabilityFingerprint(currentCapabilities.files),
    effectiveConfigFingerprint: config.effectiveFingerprint,
    effectiveCapabilityFingerprint: capabilities.effectiveFingerprint,
    expectedConfig: clone(config.tree),
    expectedCapabilities: expectedCapabilities.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint, provenance: file.provenance })),
    inheritedConfigPaths: clone(config.inheritedPaths),
    inheritedCapabilityPaths: [...capabilities.inheritedPaths]
  };
  return { stored: { ...draft, fingerprint: materializationFingerprint(draft) }, expectedCapabilities };
}
function storedMatchesCurrent(stored, input, currentConfig, currentCapabilities) {
  return stored.opaqueAccountId === input.account.opaqueAccountId && stored.codexHome === (0, import_node_path.resolve)(input.account.codexHome) && stored.schemaFingerprint === input.schema.schemaFingerprint && stored.pluginFingerprint === input.plugins.fingerprint && stored.sharedGeneration === input.shared.config.generation && stored.configOverridesFingerprint === input.configOverrides.fingerprint && stored.capabilityOverridesFingerprint === input.capabilityOverrides.fingerprint && stored.configArtifactFingerprint === currentConfig.fingerprint && stored.capabilityArtifactFingerprint === effectiveCapabilityFingerprint(currentCapabilities.files);
}
function assertWriteEvidence(evidence) {
  if (!evidence?.accountChildAbsent) throw new Error("account continuity requires an absent-child write lease");
  if (!evidence.nativeWriterCensus) return;
  const first = evidence.nativeWriterCensus();
  const second = evidence.nativeWriterCensus();
  if (first !== "zero" || second !== "zero") throw new Error("account continuity native writer census is not clean");
}
function stagePrivateFile(path, bytes) {
  assertSafeOwnerDirectory((0, import_node_path.dirname)(path), true);
  atomicWriteFile(path, bytes, PRIVATE_FILE_MODE);
}
function stageCapabilities(root, files) {
  assertSafeOwnerDirectory(root, true);
  const paths = /* @__PURE__ */ new Set();
  for (const file of files) {
    if (!isSafeCapabilityRelativePath(file.relativePath) || sha256(file.bytes) !== file.fingerprint) throw new Error("invalid resolved capability file");
    if (paths.has(file.relativePath)) throw new Error("duplicate resolved capability file");
    const components = file.relativePath.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const prefix = components.slice(0, index).join("/");
      if (paths.has(prefix)) throw new Error("conflicting resolved capability file layout");
    }
    if ([...paths].some((path) => path.startsWith(`${file.relativePath}/`))) throw new Error("conflicting resolved capability file layout");
    paths.add(file.relativePath);
    const target = (0, import_node_path.join)(root, ...file.relativePath.split("/"));
    if (!safeResolvedChild(root, (0, import_node_path.relative)(root, target))) throw new Error("unsafe capability staging target");
    stagePrivateFile(target, file.bytes);
  }
}
function lstatIfPresent(path) {
  try {
    return (0, import_node_fs.lstatSync)(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
function genericArtifactFingerprint(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return "missing";
  if (stat.isSymbolicLink() || stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) throw new Error("unsafe account materialization artifact");
  if (stat.isFile()) {
    const bytes = readSafeRegularFile(path, MAX_CAPABILITY_TOTAL_BYTES, true, false);
    if (!bytes) throw new Error("unsafe account materialization file");
    try {
      return sha256(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  if (!stat.isDirectory()) throw new Error("unsafe account materialization artifact");
  const entries = [];
  const visit = (directory, prefix) => {
    assertSafeCapabilityDirectory(directory);
    for (const name of (0, import_node_fs.readdirSync)(directory).sort()) {
      if (!isSafePluginSegment(name)) throw new Error("unsafe account materialization path");
      const child = (0, import_node_path.join)(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const childStat = (0, import_node_fs.lstatSync)(child);
      if (childStat.isDirectory()) visit(child, relativePath);
      else {
        const bytes = readSafeRegularFile(child, MAX_CAPABILITY_FILE_BYTES, true, false);
        if (!bytes) throw new Error("unsafe account materialization file");
        try {
          entries.push({ path: relativePath, fingerprint: sha256(bytes) });
        } finally {
          bytes.fill(0);
        }
      }
    }
  };
  visit(path, "");
  return sha256Json(entries);
}
function isMaterializationPath(name) {
  return name === "config.toml" || isSafeCapabilityRelativePath(name);
}
function materializationPath(root, name) {
  if (!isMaterializationPath(name)) throw new Error("unsafe account materialization path");
  return (0, import_node_path.join)((0, import_node_path.resolve)(root), ...name.split("/"));
}
function assertSafeMaterializationLeaf(codexHome, name, createParents = false) {
  const root = (0, import_node_path.resolve)(codexHome);
  assertSafeCapabilityDirectory(root);
  const parts = name.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = (0, import_node_path.join)(parent, part);
    const stat = lstatIfPresent(parent);
    if (!stat) {
      if (!createParents) continue;
      (0, import_node_fs.mkdirSync)(parent, { mode: PRIVATE_DIRECTORY_MODE });
      assertSafeCapabilityDirectory(parent);
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error("shared capability conflicts with an account-local linked path");
    if (!stat.isDirectory()) throw new Error("shared capability parent is not a directory");
    assertSafeCapabilityDirectory(parent);
  }
  const target = materializationPath(root, name);
  const targetStat = lstatIfPresent(target);
  if (!targetStat) return;
  if (targetStat.isSymbolicLink()) throw new Error("shared capability conflicts with an account-local linked path");
  if (targetStat.isDirectory()) throw new Error("account materialization leaf is unexpectedly a directory");
  if (!targetStat.isFile()) throw new Error("unsafe account materialization artifact");
}
function parseMaterializationIntent(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "opaqueAccountId", "codexHome", "transactionRoot", "receiptFingerprint", "steps"].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !(0, import_node_path.isAbsolute)(String(value.codexHome)) || !(0, import_node_path.isAbsolute)(String(value.transactionRoot)) || !isSha256(value.receiptFingerprint) || !Array.isArray(value.steps)) return null;
  const codexHome = (0, import_node_path.resolve)(value.codexHome);
  const transactionRoot = (0, import_node_path.resolve)(value.transactionRoot);
  const steps = [];
  for (const step of value.steps) {
    if (!isRecord(step) || Object.keys(step).some((key) => !["name", "target", "candidate", "backup", "before", "after", "applied"].includes(key)) || !isMaterializationPath(String(step.name)) || !(0, import_node_path.isAbsolute)(String(step.target)) || step.candidate !== null && !(0, import_node_path.isAbsolute)(String(step.candidate)) || !(0, import_node_path.isAbsolute)(String(step.backup)) || !(step.before === "missing" || isSha256(step.before)) || !(step.after === "missing" || isSha256(step.after)) || typeof step.applied !== "boolean") return null;
    const name = String(step.name);
    const expectedTarget = materializationPath(codexHome, name);
    const expectedCandidate = step.candidate === null ? null : (0, import_node_path.join)(transactionRoot, "candidates", ...name.split("/"));
    const expectedBackup = (0, import_node_path.join)(transactionRoot, "backups", ...name.split("/"));
    if ((0, import_node_path.resolve)(String(step.target)) !== expectedTarget || (step.candidate === null ? step.after !== "missing" : (0, import_node_path.resolve)(String(step.candidate)) !== expectedCandidate || !isSha256(step.after)) || (0, import_node_path.resolve)(String(step.backup)) !== expectedBackup) return null;
    steps.push(step);
  }
  if (new Set(steps.map((step) => step.name)).size !== steps.length) return null;
  return {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId,
    codexHome,
    transactionRoot,
    receiptFingerprint: value.receiptFingerprint,
    steps
  };
}
function safeTransactionPath(codexHome, transactionRoot) {
  return safeResolvedChild(codexHome, (0, import_node_path.relative)(codexHome, transactionRoot)) && (0, import_node_path.basename)(transactionRoot).startsWith(".tweakers-continuity-");
}
function recoverMaterialization(accountRoot, account) {
  const raw = readPrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE);
  if (raw === null) return "none";
  const intent = parseMaterializationIntent(raw);
  if (!intent || intent.opaqueAccountId !== account.opaqueAccountId || intent.codexHome !== (0, import_node_path.resolve)(account.codexHome) || !safeTransactionPath(intent.codexHome, intent.transactionRoot)) return "manual";
  const receipt = parseStoredMaterialization(readPrivateJson(accountRoot, MATERIALIZATION_FILE));
  if (receipt && receipt.opaqueAccountId === account.opaqueAccountId && receipt.codexHome === intent.codexHome && receipt.fingerprint === intent.receiptFingerprint) {
    try {
      if ((0, import_node_fs.existsSync)(intent.transactionRoot)) (0, import_node_fs.rmSync)(intent.transactionRoot, { recursive: true, force: true });
      (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, MATERIALIZATION_INTENT_FILE));
      fsyncDirectory(accountRoot);
      return "recovered";
    } catch {
      return "manual";
    }
  }
  try {
    for (const step of [...intent.steps].reverse()) {
      if (step.before === step.after) continue;
      assertSafeMaterializationLeaf(intent.codexHome, step.name);
      const current = genericArtifactFingerprint(step.target);
      const backup = genericArtifactFingerprint(step.backup);
      if (current === step.before && backup === "missing") continue;
      if (step.before !== "missing" && backup !== step.before) return "manual";
      if (current !== step.after && !(current === "missing" && backup === step.before)) return "manual";
      const discarded = (0, import_node_path.join)(intent.transactionRoot, "discard", ...step.name.split("/"));
      assertSafeOwnerDirectory((0, import_node_path.dirname)(discarded), true);
      if (lstatIfPresent(step.target)) (0, import_node_fs.renameSync)(step.target, discarded);
      if (step.before !== "missing") {
        assertSafeOwnerDirectory((0, import_node_path.dirname)(step.target), true);
        (0, import_node_fs.renameSync)(step.backup, step.target);
      }
    }
    if ((0, import_node_fs.existsSync)(intent.transactionRoot)) (0, import_node_fs.rmSync)(intent.transactionRoot, { recursive: true, force: true });
    (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, MATERIALIZATION_INTENT_FILE));
    fsyncDirectory(accountRoot);
    return "recovered";
  } catch {
    return "manual";
  }
}
function publishMaterialization(accountRoot, input, currentConfig, currentCapabilities, configText, expectedCapabilities, candidate, prior) {
  const codexHome = (0, import_node_path.resolve)(input.account.codexHome);
  assertSafeCapabilityDirectory(codexHome);
  const transactionRoot = (0, import_node_path.join)(codexHome, `.tweakers-continuity-${process.pid}-${(0, import_node_crypto.randomBytes)(8).toString("hex")}`);
  (0, import_node_fs.mkdirSync)(transactionRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertSafeOwnerDirectory(transactionRoot);
  const candidatesRoot = (0, import_node_path.join)(transactionRoot, "candidates");
  const backupsRoot = (0, import_node_path.join)(transactionRoot, "backups");
  assertSafeOwnerDirectory(candidatesRoot, true);
  assertSafeOwnerDirectory(backupsRoot, true);
  try {
    const candidateConfig = (0, import_node_path.join)(candidatesRoot, "config.toml");
    stagePrivateFile(candidateConfig, Buffer.from(configText, "utf8"));
    stageCapabilities(candidatesRoot, expectedCapabilities);
    const filesByPath = new Map(expectedCapabilities.map((file) => [file.relativePath, file]));
    const priorPaths = new Set(prior?.expectedCapabilities.map((file) => file.relativePath) ?? []);
    const removedPaths = [...priorPaths].filter((path) => !filesByPath.has(path)).sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
    const desiredPaths = [...filesByPath.keys()].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
    const targets = [
      ["config.toml", candidateConfig],
      ...removedPaths.map((path) => [path, null]),
      ...desiredPaths.map((path) => [path, (0, import_node_path.join)(candidatesRoot, ...path.split("/"))])
    ].filter(([name]) => !capabilityPathHasLocalLink(codexHome, name));
    for (const [name] of targets) assertSafeMaterializationLeaf(codexHome, name);
    const steps = targets.map(([name, source]) => {
      const target = materializationPath(codexHome, name);
      const before = genericArtifactFingerprint(target);
      const after = source ? genericArtifactFingerprint(source) : "missing";
      return { name, target, candidate: source, backup: (0, import_node_path.join)(backupsRoot, ...name.split("/")), before, after, applied: false };
    });
    const { fingerprint: _beforeFingerprint, ...beforeDraft } = candidate;
    const expectedReceiptFingerprint = materializationFingerprint({
      ...beforeDraft,
      configArtifactFingerprint: sha256(configText),
      capabilityArtifactFingerprint: effectiveCapabilityFingerprint(expectedCapabilities)
    });
    const initialIntent = { version: VERSION, opaqueAccountId: input.account.opaqueAccountId, codexHome, transactionRoot, receiptFingerprint: expectedReceiptFingerprint, steps };
    atomicWritePrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE, initialIntent);
    if (input.faultAt === "after_intent") throw new Error("injected materialization fault after intent");
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step.before === step.after) continue;
      assertSafeMaterializationLeaf(codexHome, step.name, true);
      if (genericArtifactFingerprint(step.target) !== step.before) throw new Error("account continuity materialization preimage drift");
      assertSafeOwnerDirectory((0, import_node_path.dirname)(step.backup), true);
      if (lstatIfPresent(step.target)) (0, import_node_fs.renameSync)(step.target, step.backup);
      if (step.candidate) (0, import_node_fs.renameSync)(step.candidate, step.target);
      if (genericArtifactFingerprint(step.target) !== step.after) throw new Error("account continuity materialization postimage drift");
      const applied = { ...step, applied: true };
      steps[index] = applied;
      atomicWritePrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE, { ...initialIntent, steps });
      if (input.faultAt === "after_config" && step.name === "config.toml") throw new Error("injected materialization fault after config");
    }
    if (input.faultAt === "after_capabilities") throw new Error("injected materialization fault after capabilities");
    const finalConfig = readAccountConfig(codexHome);
    const finalCapabilities = scanCapabilityTree(codexHome);
    const finalCapabilityFingerprint = effectiveCapabilityFingerprint(finalCapabilities.files);
    const expectedCapabilityFingerprint = effectiveCapabilityFingerprint(expectedCapabilities);
    if (finalConfig.source !== configText || finalCapabilityFingerprint !== expectedCapabilityFingerprint) {
      throw new Error("account continuity materialization verification failed");
    }
    const { fingerprint: _candidateFingerprint, ...candidateDraft } = candidate;
    const finalDraft = {
      ...candidateDraft,
      configArtifactFingerprint: finalConfig.fingerprint,
      capabilityArtifactFingerprint: finalCapabilityFingerprint
    };
    const finalStored = { ...finalDraft, fingerprint: materializationFingerprint(finalDraft) };
    atomicWritePrivateJson(accountRoot, MATERIALIZATION_FILE, finalStored);
    if ((0, import_node_fs.existsSync)(transactionRoot)) (0, import_node_fs.rmSync)(transactionRoot, { recursive: true, force: true });
    (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, MATERIALIZATION_INTENT_FILE));
    fsyncDirectory(accountRoot);
    void currentConfig;
    void currentCapabilities;
    return finalStored;
  } catch (error) {
    const recovery = recoverMaterialization(accountRoot, input.account);
    if (recovery === "manual") throw new Error("account continuity materialization requires manual recovery");
    throw error;
  }
}
function blockedMaterialization(account, reason) {
  return { version: VERSION, state: "blocked", reason, opaqueAccountId: account, written: false };
}
function isPortableConfigUpgradePath(path) {
  return path[0] === "model_provider" || path[0] === "model_providers" || path[0] === "marketplaces";
}
function preservePortableConfigOverrides(prior, current, stored, schema) {
  const additions = [];
  for (const { path, value } of flattenTomlLeaves(current.tree).values()) {
    if (!isPortableConfigUpgradePath(path) || classifyTomlPath(path, schema, value) !== "shared") continue;
    if (prior.operations.some((operation) => pathsOverlapBySegments(operation.path, path)) || stored?.inheritedConfigPaths.some((inherited) => pathsOverlapBySegments(inherited, path))) continue;
    additions.push({ op: "set", path, value: clone(value) });
  }
  if (!additions.length) return prior;
  const draft = {
    ...prior,
    revision: prior.revision + 1,
    operations: normalizeConfigOperations([...prior.operations, ...additions]),
    preservationFingerprint: preservationFingerprint(current.tree, schema)
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}
function prepareAccountConfigBeforeSpawn(input) {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return blockedMaterialization(input.account.opaqueAccountId, "shared-source rebase recovery is required before spawn");
    if (!isOpaqueAccountId(input.account.opaqueAccountId)) return blockedMaterialization(input.account.opaqueAccountId, "invalid account id");
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot, Boolean(input.apply));
    if (lstatIfPresent((0, import_node_path.join)(accountRoot, NATIVE_CAPTURE_INTENT_FILE))) return blockedMaterialization(input.account.opaqueAccountId, "native initial capture recovery is required before spawn");
    const pending = readPrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE);
    if (pending !== null) {
      if (!input.apply) return blockedMaterialization(input.account.opaqueAccountId, "account continuity recovery is required before spawn");
      assertWriteEvidence(input.writeEvidence);
      const recovery = recoverMaterialization(accountRoot, input.account);
      if (recovery === "manual") return blockedMaterialization(input.account.opaqueAccountId, "account continuity requires manual recovery");
    }
    let configOverrides = input.configOverrides ?? loadAccountConfigOverrides(input.stateRoot, input.account);
    const capabilityOverrides = input.capabilityOverrides ?? loadAccountCapabilityOverrides(input.stateRoot, input.account);
    if (!configOverrides || !capabilityOverrides) return blockedMaterialization(input.account.opaqueAccountId, "account continuity bootstrap sidecars are missing");
    if (configOverrides.opaqueAccountId !== input.account.opaqueAccountId || capabilityOverrides.opaqueAccountId !== input.account.opaqueAccountId) {
      return blockedMaterialization(input.account.opaqueAccountId, "account continuity sidecar account mismatch");
    }
    const currentConfig = readAccountConfig(input.account.codexHome);
    const currentCapabilities = scanCapabilityTree(input.account.codexHome);
    const prior = parseStoredMaterialization(readPrivateJson(accountRoot, MATERIALIZATION_FILE));
    if (prior && prior.configOverridesFingerprint === configOverrides.fingerprint && prior.capabilityOverridesFingerprint === capabilityOverrides.fingerprint && (prior.configArtifactFingerprint !== currentConfig.fingerprint || prior.capabilityArtifactFingerprint !== effectiveCapabilityFingerprint(currentCapabilities.files))) {
      return blockedMaterialization(input.account.opaqueAccountId, "account configuration changed without an after-exit capture receipt");
    }
    const portableOverrides = preservePortableConfigOverrides(configOverrides, currentConfig, prior, input.schema);
    if (portableOverrides.fingerprint !== configOverrides.fingerprint) {
      if (input.apply) {
        assertWriteEvidence(input.writeEvidence);
        if (readAccountConfig(input.account.codexHome).fingerprint !== currentConfig.fingerprint) throw new Error("portable configuration changed during migration");
        persistConfigOverrides(accountRoot, portableOverrides);
      }
      configOverrides = portableOverrides;
    }
    const normalizedInput = { ...input, configOverrides, capabilityOverrides };
    const config = resolveAccountConfig({ shared: input.shared.config, overrides: configOverrides, currentLocal: currentConfig, plugins: input.plugins, schema: input.schema });
    if (config.state !== "ready") return blockedMaterialization(input.account.opaqueAccountId, config.reason ?? "account config resolution failed");
    const capabilities = resolveAccountCapabilities({ shared: input.shared.capabilities, overrides: capabilityOverrides, currentLocalRoot: input.account.codexHome });
    if (capabilities.state !== "ready") return blockedMaterialization(input.account.opaqueAccountId, capabilities.reason ?? "account capability resolution failed");
    const pluginsReady = preparePluginPackages(normalizedInput, accountRoot);
    const candidate = materializationCandidate(normalizedInput, config, capabilities, currentConfig, currentCapabilities);
    if (prior && storedMatchesCurrent(prior, normalizedInput, currentConfig, currentCapabilities) && prior.effectiveConfigFingerprint === config.effectiveFingerprint && prior.effectiveCapabilityFingerprint === capabilities.effectiveFingerprint) {
      return materializationResult(prior, capabilities.files, pluginsReady ? "ready" : "would_write", false);
    }
    if (prior && prior.configOverridesFingerprint === configOverrides.fingerprint && prior.capabilityOverridesFingerprint === capabilityOverrides.fingerprint && (prior.configArtifactFingerprint !== currentConfig.fingerprint || prior.capabilityArtifactFingerprint !== effectiveCapabilityFingerprint(currentCapabilities.files))) {
      return blockedMaterialization(input.account.opaqueAccountId, "account configuration changed without an after-exit capture receipt");
    }
    const previousInherited = prior?.inheritedConfigPaths ?? [];
    const configText = effectiveTomlText(currentConfig, config.tree, previousInherited);
    if (!input.apply) return materializationResult(candidate.stored, capabilities.files, "would_write", false);
    assertWriteEvidence(input.writeEvidence);
    const published = publishMaterialization(accountRoot, normalizedInput, currentConfig, currentCapabilities, configText, capabilities.files, candidate.stored, prior);
    return materializationResult(published, capabilities.files, "ready", true);
  } catch (error) {
    return blockedMaterialization(input.account.opaqueAccountId, error instanceof Error ? error.message : "account continuity prepare failed");
  }
}
function assertNativeContinuityIdentity(input) {
  const home = (0, import_node_path.resolve)(input.account.codexHome);
  const accountRoot = accountStateRoot(input.stateRoot, input.account);
  const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
  const privateRoots = [(0, import_node_path.resolve)(input.stateRoot), sharedRoot, accountRoot, (0, import_node_path.join)(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY)];
  if (!(0, import_node_path.isAbsolute)(input.account.codexHome) || (0, import_node_fs.realpathSync)(home) !== home) throw new Error("native account home is not canonical");
  assertSafeCapabilityDirectory(home);
  const stat = (0, import_node_fs.lstatSync)(home);
  if (stat.ino !== input.nativeHomeIdentity.inode || stat.dev !== input.nativeHomeIdentity.device && !input.nativeBindingPreflight()) throw new Error("native account home identity changed");
  for (const root of privateRoots) {
    assertSafeCapabilityDirectory(root);
    if ((0, import_node_fs.realpathSync)(root) !== root || ((0, import_node_fs.lstatSync)(root).mode & 63) !== 0 || root === home || safeResolvedChild(home, (0, import_node_path.relative)(home, root)) || safeResolvedChild(root, (0, import_node_path.relative)(root, home))) {
      throw new Error("native baseline metadata must be private and disjoint from the native home");
    }
  }
  if (!safeResolvedChild((0, import_node_path.resolve)(input.stateRoot), (0, import_node_path.relative)((0, import_node_path.resolve)(input.stateRoot), accountRoot))) throw new Error("native baseline account metadata is outside broker state");
}
function observeExistingNativeAccountContinuity(input) {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return blockedMaterialization(input.account.opaqueAccountId, "shared-source rebase recovery is required before native observation");
    const home = (0, import_node_path.resolve)(input.account.codexHome);
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    const observe = () => {
      if (!input.nativeBindingPreflight()) throw new Error("native account binding changed");
      assertNativeContinuityIdentity(input);
      const metadata = {
        shared: readPrivateJson(sharedRoot, BASE_FILE),
        plugins: readPrivateJson(sharedRoot, PLUGIN_MANIFEST_FILE),
        config: readPrivateJson(accountRoot, CONFIG_OVERRIDES_FILE),
        capabilities: readPrivateJson(accountRoot, CAPABILITY_OVERRIDES_FILE),
        receipt: readPrivateJson(accountRoot, MATERIALIZATION_FILE),
        projections: readPrivateJson(accountRoot, PLUGIN_PROJECTIONS_FILE)
      };
      for (const pending of [MATERIALIZATION_INTENT_FILE, PLUGIN_PROJECTION_INTENT_FILE, NATIVE_CAPTURE_INTENT_FILE]) {
        if (lstatIfPresent((0, import_node_path.join)(accountRoot, pending))) throw new Error("native account continuity recovery is required");
      }
      if (metadata.projections === null && lstatIfPresent((0, import_node_path.join)(accountRoot, PLUGIN_PROJECTIONS_FILE))) throw new Error("invalid plugin projection receipt");
      const shared = parseSharedBase(metadata.shared, sharedRoot, true);
      const plugins = parseSharedPluginsManifest(metadata.plugins, sharedRoot);
      const configOverrides = parseConfigOverrides(metadata.config);
      const capabilityOverrides = parseCapabilityOverrides(metadata.capabilities, (0, import_node_path.join)(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY));
      if (!shared || !plugins || !configOverrides || !capabilityOverrides || shared.fingerprint !== input.shared.fingerprint || stableJson(serializableSharedBase(input.shared)) !== stableJson(metadata.shared) || plugins.fingerprint !== input.plugins.fingerprint || configOverrides.opaqueAccountId !== input.account.opaqueAccountId || capabilityOverrides.opaqueAccountId !== input.account.opaqueAccountId || input.configOverrides && input.configOverrides.fingerprint !== configOverrides.fingerprint || input.capabilityOverrides && input.capabilityOverrides.fingerprint !== capabilityOverrides.fingerprint) {
        throw new Error("native account continuity inputs are missing, invalid or changed");
      }
      const normalized = { ...input, shared, plugins, configOverrides, capabilityOverrides, apply: false };
      const currentConfig = readAccountConfig(home);
      const currentCapabilities = scanCapabilityTree(home);
      const config = resolveAccountConfig({ shared: shared.config, overrides: configOverrides, currentLocal: currentConfig, plugins, schema: input.schema });
      const capabilities = resolveAccountCapabilities({ shared: shared.capabilities, overrides: capabilityOverrides, currentLocalRoot: home });
      if (config.state !== "ready" || capabilities.state !== "ready") throw new Error(config.reason ?? capabilities.reason ?? "native continuity resolution failed");
      const pluginsReady = preparePluginPackages(normalized, accountRoot);
      const cache = (0, import_node_path.join)(home, "plugins", "cache");
      const sharedPluginIds = new Set(plugins.plugins.map((plugin) => plugin.id));
      if (sharedPluginIds.size && lstatIfPresent((0, import_node_path.join)(home, "plugins"))) assertSafeCapabilityDirectory((0, import_node_path.join)(home, "plugins"));
      const pluginSnapshot = sharedPluginIds.size && lstatIfPresent(cache) ? scanPluginCache(cache, sharedPluginIds) : [];
      const candidate = materializationCandidate(normalized, config, capabilities, currentConfig, currentCapabilities);
      const prior = parseStoredMaterialization(metadata.receipt);
      if ((metadata.receipt !== null || lstatIfPresent((0, import_node_path.join)(accountRoot, MATERIALIZATION_FILE))) && !prior) throw new Error("invalid native materialization receipt");
      if (prior && (!idleCaptureReceiptIsCoherent(prior) || prior.opaqueAccountId !== input.account.opaqueAccountId || prior.codexHome !== home || prior.schemaFingerprint !== input.schema.schemaFingerprint)) throw new Error("native account continuity receipt binding is invalid");
      assertNativeContinuityIdentity(input);
      const priorCompatibleWithReadOnlyDonorRebase = Boolean(prior && (prior.sharedGeneration !== candidate.stored.sharedGeneration || prior.pluginFingerprint !== candidate.stored.pluginFingerprint) && prior.configOverridesFingerprint === candidate.stored.configOverridesFingerprint && prior.capabilityOverridesFingerprint === candidate.stored.capabilityOverridesFingerprint);
      return {
        candidate,
        prior,
        ready: (!prior || prior.fingerprint === candidate.stored.fingerprint || priorCompatibleWithReadOnlyDonorRebase) && pluginsReady && sha256Json(currentConfig.tree) === config.effectiveFingerprint && effectiveCapabilityFingerprint(currentCapabilities.files) === effectiveCapabilityFingerprint(capabilities.files),
        fingerprint: sha256Json({ metadata, candidate: candidate.stored.fingerprint, pluginSnapshot })
      };
    };
    const first = observe();
    const final = observe();
    if (first.fingerprint !== final.fingerprint || first.ready !== final.ready) throw new Error("native account continuity changed during observation");
    if (!final.ready) return materializationResult(final.candidate.stored, final.candidate.expectedCapabilities, "would_write", false, "native account inheritance requires an idle home");
    if (input.apply && !final.prior) atomicWritePrivateJson(accountRoot, MATERIALIZATION_FILE, final.candidate.stored);
    return materializationResult(final.prior ?? final.candidate.stored, final.candidate.expectedCapabilities, "ready", false);
  } catch (error) {
    return blockedMaterialization(input.account.opaqueAccountId, error instanceof Error ? error.message : "native account continuity observation failed");
  }
}
function parseNativeInitialCaptureReceipt(value, input) {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version",
    "opaqueAccountId",
    "codexHome",
    "nativeHomeIdentity",
    "schemaFingerprint",
    "sourceReceiptFingerprint",
    "configOverridesFingerprint",
    "capabilityOverridesFingerprint",
    "observedConfig",
    "observedCapabilities",
    "fingerprint"
  ].includes(key)) || value.version !== VERSION || value.opaqueAccountId !== input.account.opaqueAccountId || value.codexHome !== (0, import_node_path.resolve)(input.account.codexHome) || value.schemaFingerprint !== input.schema.schemaFingerprint || !isRecord(value.nativeHomeIdentity) || Object.keys(value.nativeHomeIdentity).length !== 2 || value.nativeHomeIdentity.device !== input.nativeHomeIdentity.device || value.nativeHomeIdentity.inode !== input.nativeHomeIdentity.inode || ![value.sourceReceiptFingerprint, value.configOverridesFingerprint, value.capabilityOverridesFingerprint, value.fingerprint].every(isSha256) || !validateTomlNode(value.observedConfig) || !isTomlTable(value.observedConfig) || !Array.isArray(value.observedCapabilities)) {
    throw new Error("invalid native initial capture receipt binding");
  }
  for (const file of value.observedCapabilities) {
    if (!isRecord(file) || Object.keys(file).length !== 2 || !isSafeCapabilityRelativePath(String(file.relativePath)) || !isSha256(file.fingerprint)) {
      throw new Error("invalid native initial capture capability baseline");
    }
  }
  if (new Set(value.observedCapabilities.map((file) => file.relativePath)).size !== value.observedCapabilities.length) throw new Error("duplicate native initial capture capability");
  const { fingerprint, ...draft } = value;
  if (sha256Json(draft) !== fingerprint) throw new Error("native initial capture receipt fingerprint changed");
  return value;
}
function parseNativeInitialCaptureIntent(value, input) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "beforeConfig", "beforeCapabilities", "afterConfig", "afterCapabilities", "completion", "fingerprint"].includes(key)) || value.version !== VERSION || !isSha256(value.fingerprint)) throw new Error("invalid native initial capture intent");
  const { fingerprint, ...draft } = value;
  if (sha256Json(draft) !== fingerprint) throw new Error("native initial capture intent fingerprint changed");
  const beforeConfig = parseConfigOverrides(value.beforeConfig);
  const beforeCapabilities = parseCapabilityOverrides(value.beforeCapabilities);
  const afterConfig = parseConfigOverrides(value.afterConfig);
  const afterCapabilities = parseCapabilityOverrides(value.afterCapabilities);
  const completion = parseNativeInitialCaptureReceipt(value.completion, input);
  if (!beforeConfig || !beforeCapabilities || !afterConfig || !afterCapabilities || [beforeConfig, beforeCapabilities, afterConfig, afterCapabilities].some((entry) => entry.opaqueAccountId !== input.account.opaqueAccountId) || afterConfig.revision !== beforeConfig.revision + 1 || afterCapabilities.revision !== beforeCapabilities.revision + 1 || completion.configOverridesFingerprint !== afterConfig.fingerprint || completion.capabilityOverridesFingerprint !== afterCapabilities.fingerprint) {
    throw new Error("invalid native initial capture sidecar pair");
  }
  return { version: VERSION, beforeConfig, beforeCapabilities, afterConfig, afterCapabilities, completion, fingerprint: value.fingerprint };
}
function originalNativeCaptureBaseline(bootstrap, enrollment, config, capabilities, input) {
  const receipt = enrollment ?? bootstrap;
  if (!isRecord(receipt) || (enrollment !== null ? receipt.version !== VERSION : ![1, 2].includes(Number(receipt.version))) || !isSha256(receipt.sharedBaseFingerprint) || !isSha256(receipt.sharedPluginFingerprint) || (receipt.schemaFingerprint === void 0 ? receipt.sharedBaseFingerprint !== input.shared.fingerprint : receipt.schemaFingerprint !== input.schema.schemaFingerprint) || config.revision !== 1 || capabilities.revision !== 1 || config.basedOnSharedGeneration !== capabilities.basedOnSharedGeneration || config.operations.some((operation) => operation.op !== "set") || capabilities.operations.some((operation) => operation.op !== "set")) {
    throw new Error("native initial capture lacks an original schema-bound enrollment receipt");
  }
  let binding;
  if (enrollment !== null) {
    if (Object.keys(receipt).some((key) => !["version", "schemaFingerprint", "opaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "configOverridesFingerprint", "capabilityOverridesFingerprint"].includes(key))) throw new Error("invalid native enrollment receipt");
    binding = receipt;
  } else {
    const allowedBootstrapKeys = receipt.version === 1 ? ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"] : ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedSourceOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"];
    if (Object.keys(receipt).some((key) => !allowedBootstrapKeys.includes(key)) || !Array.isArray(receipt.accounts) || receipt.generation !== config.basedOnSharedGeneration || !isOpaqueAccountId(receipt.primaryOpaqueAccountId) || receipt.version === 2 && !isOpaqueAccountId(receipt.sharedSourceOpaqueAccountId) || typeof receipt.createdAt !== "string" || receipt.accounts.some((entry) => !isRecord(entry) || Object.keys(entry).length !== 3 || !isOpaqueAccountId(entry.opaqueAccountId) || !isSha256(entry.configOverridesFingerprint) || !isSha256(entry.capabilityOverridesFingerprint)) || new Set(receipt.accounts.map((entry) => entry.opaqueAccountId)).size !== receipt.accounts.length) throw new Error("invalid native bootstrap receipt");
    binding = receipt.accounts.find((entry) => entry.opaqueAccountId === input.account.opaqueAccountId) ?? {};
  }
  if (binding.opaqueAccountId !== input.account.opaqueAccountId || binding.configOverridesFingerprint !== config.fingerprint || binding.capabilityOverridesFingerprint !== capabilities.fingerprint) throw new Error("native initial capture sidecars no longer match enrollment");
  const tree = {};
  for (const operation of config.operations) if (operation.op === "set") setTomlNode(tree, operation.path, operation.value);
  return {
    config: tree,
    capabilities: capabilities.operations.flatMap((operation) => operation.op === "set" ? [{ relativePath: operation.relativePath, fingerprint: operation.fingerprint }] : []),
    receiptFingerprint: sha256Json(receipt)
  };
}
function captureUnmaterializedNativeChangesBeforeSpawn(input) {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) throw new Error("shared-source rebase recovery is required before native capture");
    if (!input.writeEvidence?.nativeWriterCensus) throw new Error("native initial capture requires a native idle census");
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    const payloadRoot = (0, import_node_path.join)(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY);
    const observe = () => {
      if (!input.nativeBindingPreflight()) throw new Error("native account binding changed before initial capture");
      assertNativeContinuityIdentity(input);
      assertWriteEvidence(input.writeEvidence);
      for (const pending of [MATERIALIZATION_FILE, MATERIALIZATION_INTENT_FILE, PLUGIN_PROJECTION_INTENT_FILE]) {
        if (lstatIfPresent((0, import_node_path.join)(accountRoot, pending))) throw new Error("native initial capture requires an unmaterialized home without pending recovery");
      }
      const metadata = {
        shared: readPrivateJson(sharedRoot, BASE_FILE),
        plugins: readPrivateJson(sharedRoot, PLUGIN_MANIFEST_FILE),
        config: readPrivateJson(accountRoot, CONFIG_OVERRIDES_FILE),
        capabilities: readPrivateJson(accountRoot, CAPABILITY_OVERRIDES_FILE),
        bootstrap: readPrivateJson(sharedRoot, BOOTSTRAP_RECEIPT_FILE),
        enrollment: readPrivateJson(accountRoot, "enrollment-receipt.v1.json"),
        intent: readPrivateJson(accountRoot, NATIVE_CAPTURE_INTENT_FILE),
        completion: readPrivateJson(accountRoot, NATIVE_CAPTURE_RECEIPT_FILE)
      };
      for (const [file, value] of [[NATIVE_CAPTURE_INTENT_FILE, metadata.intent], [NATIVE_CAPTURE_RECEIPT_FILE, metadata.completion], ["enrollment-receipt.v1.json", metadata.enrollment]]) {
        if (value === null && lstatIfPresent((0, import_node_path.join)(accountRoot, file))) throw new Error("invalid native initial capture metadata");
      }
      const shared = parseSharedBase(metadata.shared, sharedRoot, true);
      const plugins = parseSharedPluginsManifest(metadata.plugins, sharedRoot);
      const config = parseConfigOverrides(metadata.config);
      const capabilities = parseCapabilityOverrides(metadata.capabilities, payloadRoot);
      if (!shared || !plugins || !config || !capabilities || shared.fingerprint !== input.shared.fingerprint || stableJson(serializableSharedBase(input.shared)) !== stableJson(metadata.shared) || shared.config.schemaFingerprint !== input.schema.schemaFingerprint || plugins.fingerprint !== input.plugins.fingerprint || config.opaqueAccountId !== input.account.opaqueAccountId || capabilities.opaqueAccountId !== input.account.opaqueAccountId) throw new Error("native initial capture inputs are missing or changed");
      for (const operation of capabilities.operations) {
        if (operation.op !== "set") continue;
        const bytes = readCapabilityPayload(payloadRoot, operation);
        if (!bytes) throw new Error("native initial capture capability payload changed");
        bytes.fill(0);
      }
      const currentConfig = readAccountConfig(input.account.codexHome);
      const currentCapabilities = scanCapabilityTree(input.account.codexHome);
      assertNativeContinuityIdentity(input);
      return {
        metadata,
        config,
        capabilities,
        currentConfig,
        currentCapabilities,
        fingerprint: sha256Json({ metadata, config: currentConfig.fingerprint, capabilities: currentCapabilities.fingerprint })
      };
    };
    const first = observe();
    const final = observe();
    if (first.fingerprint !== final.fingerprint) throw new Error("native initial capture changed during observation");
    if (final.metadata.intent !== null) {
      const intent = parseNativeInitialCaptureIntent(final.metadata.intent, input);
      if (![intent.beforeConfig.fingerprint, intent.afterConfig.fingerprint].includes(final.config.fingerprint) || ![intent.beforeCapabilities.fingerprint, intent.afterCapabilities.fingerprint].includes(final.capabilities.fingerprint)) throw new Error("native initial capture recovery has ambiguous sidecar drift");
      if (final.metadata.completion !== null) {
        const completed2 = parseNativeInitialCaptureReceipt(final.metadata.completion, input);
        if (completed2.fingerprint !== intent.completion.fingerprint && completed2.fingerprint !== intent.completion.sourceReceiptFingerprint) throw new Error("native initial capture completion changed during recovery");
        if (completed2.fingerprint === intent.completion.fingerprint ? final.config.fingerprint !== intent.afterConfig.fingerprint || final.capabilities.fingerprint !== intent.afterCapabilities.fingerprint : completed2.configOverridesFingerprint !== intent.beforeConfig.fingerprint || completed2.capabilityOverridesFingerprint !== intent.beforeCapabilities.fingerprint) {
          throw new Error("native initial capture completion has ambiguous sidecars");
        }
      } else {
        const original = originalNativeCaptureBaseline(final.metadata.bootstrap, final.metadata.enrollment, intent.beforeConfig, intent.beforeCapabilities, input);
        if (original.receiptFingerprint !== intent.completion.sourceReceiptFingerprint) throw new Error("native initial capture recovery enrollment changed");
      }
      for (const operation of intent.afterCapabilities.operations) {
        if (operation.op !== "set") continue;
        const bytes = readCapabilityPayload(payloadRoot, operation);
        if (!bytes) throw new Error("native initial capture recovery payload changed");
        bytes.fill(0);
      }
      if (!input.apply) throw new Error("native initial capture recovery is required");
      assertWriteEvidence(input.writeEvidence);
      persistConfigOverrides(accountRoot, intent.afterConfig);
      persistCapabilityOverrides(accountRoot, intent.afterCapabilities);
      atomicWritePrivateJson(accountRoot, NATIVE_CAPTURE_RECEIPT_FILE, intent.completion);
      (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, NATIVE_CAPTURE_INTENT_FILE));
      fsyncDirectory(accountRoot);
      const resumed = captureUnmaterializedNativeChangesBeforeSpawn({ ...input, configOverrides: void 0, capabilityOverrides: void 0, captureFaultAt: void 0 });
      return resumed.state === "unchanged" ? { ...resumed, state: "captured" } : resumed;
    }
    if (input.configOverrides && input.configOverrides.fingerprint !== final.config.fingerprint || input.capabilityOverrides && input.capabilityOverrides.fingerprint !== final.capabilities.fingerprint) throw new Error("native initial capture supplied sidecars changed");
    const completed = final.metadata.completion === null ? null : parseNativeInitialCaptureReceipt(final.metadata.completion, input);
    if (completed && (completed.configOverridesFingerprint !== final.config.fingerprint || completed.capabilityOverridesFingerprint !== final.capabilities.fingerprint)) throw new Error("native initial capture completion sidecars changed");
    const baseline = completed ? { config: completed.observedConfig, capabilities: completed.observedCapabilities, receiptFingerprint: completed.fingerprint } : originalNativeCaptureBaseline(final.metadata.bootstrap, final.metadata.enrollment, final.config, final.capabilities, input);
    const actualConfig = selectSharedTomlTree(final.currentConfig.tree, input.schema);
    const actualCapabilities = final.currentCapabilities.files.filter((file) => file.scope === "shareable").map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint }));
    if (compareTomlTrees(baseline.config, actualConfig) && effectiveCapabilityFingerprint(baseline.capabilities) === effectiveCapabilityFingerprint(actualCapabilities)) {
      return { state: "unchanged", configOverrides: final.config, capabilityOverrides: final.capabilities };
    }
    const nextConfig = capturedConfigOverrides(final.config, baseline.config, final.currentConfig.tree, input.shared.config.generation, input.schema);
    const nextCapabilities = capturedCapabilityOverrides(final.capabilities, baseline.capabilities.map((file) => ({ ...file, provenance: "override" })), final.currentCapabilities, input.shared.capabilities.generation);
    if (!input.apply) return { state: "captured", configOverrides: nextConfig, capabilityOverrides: nextCapabilities };
    const completionDraft = {
      version: VERSION,
      opaqueAccountId: input.account.opaqueAccountId,
      codexHome: (0, import_node_path.resolve)(input.account.codexHome),
      nativeHomeIdentity: { ...input.nativeHomeIdentity },
      schemaFingerprint: input.schema.schemaFingerprint,
      sourceReceiptFingerprint: baseline.receiptFingerprint,
      configOverridesFingerprint: nextConfig.fingerprint,
      capabilityOverridesFingerprint: nextCapabilities.fingerprint,
      observedConfig: actualConfig,
      observedCapabilities: actualCapabilities
    };
    const completion = { ...completionDraft, fingerprint: sha256Json(completionDraft) };
    const { payloadRoot: _beforePayload, ...beforeCapabilities } = final.capabilities;
    const { payloadRoot: _afterPayload, ...afterCapabilities } = nextCapabilities;
    const intentDraft = {
      version: VERSION,
      beforeConfig: final.config,
      beforeCapabilities,
      afterConfig: nextConfig,
      afterCapabilities,
      completion
    };
    assertWriteEvidence(input.writeEvidence);
    writeCapabilityPayloads(accountRoot, final.currentCapabilities);
    if (observe().fingerprint !== final.fingerprint) throw new Error("native initial capture changed before publication");
    atomicWritePrivateJson(accountRoot, NATIVE_CAPTURE_INTENT_FILE, { ...intentDraft, fingerprint: sha256Json(intentDraft) });
    if (input.captureFaultAt === "after_intent") throw new Error("injected native initial capture fault after intent");
    persistConfigOverrides(accountRoot, nextConfig);
    if (input.captureFaultAt === "after_config") throw new Error("injected native initial capture fault after config");
    persistCapabilityOverrides(accountRoot, nextCapabilities);
    if (input.captureFaultAt === "after_capabilities") throw new Error("injected native initial capture fault after capabilities");
    atomicWritePrivateJson(accountRoot, NATIVE_CAPTURE_RECEIPT_FILE, completion);
    (0, import_node_fs.unlinkSync)((0, import_node_path.join)(accountRoot, NATIVE_CAPTURE_INTENT_FILE));
    fsyncDirectory(accountRoot);
    return { state: "captured", configOverrides: nextConfig, capabilityOverrides: nextCapabilities };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "native initial capture failed" };
  }
}
function validateAccountContinuityMaterialization(stateRoot, opaqueAccountId) {
  try {
    if (!isOpaqueAccountId(opaqueAccountId)) return false;
    const account = { opaqueAccountId, codexHome: (0, import_node_path.join)((0, import_node_path.resolve)(stateRoot), "accounts", opaqueAccountId, "codex-home") };
    const root = accountStateRoot(stateRoot, account);
    assertSafeOwnerDirectory(root);
    if (readPrivateJson(root, MATERIALIZATION_INTENT_FILE) !== null || lstatIfPresent((0, import_node_path.join)(root, NATIVE_CAPTURE_INTENT_FILE))) return false;
    const receipt = parseStoredMaterialization(readPrivateJson(root, MATERIALIZATION_FILE));
    if (!receipt) return false;
    const config = readAccountConfig(receipt.codexHome);
    const capabilities = scanCapabilityTree(receipt.codexHome);
    return idleCaptureReceiptIsCoherent(receipt) && config.fingerprint === receipt.configArtifactFingerprint && effectiveCapabilityFingerprint(capabilities.files) === receipt.capabilityArtifactFingerprint && sha256Json(config.tree) === receipt.effectiveConfigFingerprint && effectiveCapabilityFingerprint(capabilities.files) === effectiveCapabilityFingerprint(receipt.expectedCapabilities);
  } catch {
    return false;
  }
}
function tablePaths(root, prefix = [], output = []) {
  const mutable = output;
  for (const [key, value] of Object.entries(root)) {
    const path = [...prefix, key];
    if (!isTomlTable(value)) continue;
    mutable.push(path);
    tablePaths(value, path, mutable);
  }
  return mutable;
}
function operationMap(operations) {
  return new Map(operations.map((operation) => [configPathKey(operation.path), clone(operation)]));
}
function replaceConfigOperation(map, operation) {
  for (const [key, existing] of [...map]) {
    if (pathsOverlapBySegments(existing.path, operation.path)) map.delete(key);
  }
  map.set(configPathKey(operation.path), clone(operation));
}
function capturedConfigOverrides(prior, expected, actual, sharedGeneration, schema) {
  const operations = operationMap(prior.operations);
  const expectedLeaves = flattenTomlLeaves(expected);
  const actualLeaves = flattenTomlLeaves(actual);
  for (const path of tablePaths(expected)) {
    if (classifyTomlPath(path, schema) !== "shared" || getTomlNode(actual, path) !== void 0) continue;
    replaceConfigOperation(operations, { path, op: "delete" });
  }
  for (const [key, entry] of actualLeaves) {
    if (classifyTomlPath(entry.path, schema, entry.value) !== "shared") continue;
    const expectedEntry = expectedLeaves.get(key);
    if (!expectedEntry || !compareToml(expectedEntry.value, entry.value)) replaceConfigOperation(operations, { path: entry.path, op: "set", value: entry.value });
  }
  for (const [key, entry] of expectedLeaves) {
    if (classifyTomlPath(entry.path, schema, entry.value) !== "shared" || actualLeaves.has(key)) continue;
    if ([...operations.values()].some((operation) => operation.op === "delete" && pathHasPrefix(entry.path, operation.path))) continue;
    replaceConfigOperation(operations, { path: entry.path, op: "delete" });
  }
  const normalized = normalizeConfigOperations([...operations.values()]);
  const draft = {
    version: VERSION,
    opaqueAccountId: prior.opaqueAccountId,
    revision: prior.revision + 1,
    basedOnSharedGeneration: sharedGeneration,
    operations: normalized,
    preservationFingerprint: preservationFingerprint(actual, schema)
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}
function proposedConfigBase(document, shared, schema) {
  const generation = shared.config.generation + 1;
  const tree = selectSharedTomlTree(document.tree, schema);
  return {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree,
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, tree)
  };
}
function captureAccountConfigAfterExit(input) {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before config capture" };
    if (input.materialization.state !== "ready" || !input.materialization.expectedConfig || !input.materialization.effectiveConfigFingerprint) {
      return { state: "blocked", reason: "a valid prelaunch materialization receipt is required for config capture" };
    }
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot, Boolean(input.apply));
    const prior = input.configOverrides ?? loadAccountConfigOverrides(input.stateRoot, input.account);
    if (!prior || prior.opaqueAccountId !== input.account.opaqueAccountId) return { state: "blocked", reason: "account config override sidecar is missing" };
    const current = readAccountConfig(input.account.codexHome);
    const next = capturedConfigOverrides(prior, input.materialization.expectedConfig, current.tree, input.shared.config.generation, input.schema);
    if (input.apply) {
      persistConfigOverrides(accountRoot, next);
      atomicWritePrivateJson(accountRoot, CAPTURE_RECEIPT_FILE, {
        version: VERSION,
        opaqueAccountId: input.account.opaqueAccountId,
        prelaunchEffectiveFingerprint: input.materialization.effectiveConfigFingerprint,
        observedConfigFingerprint: current.fingerprint,
        nextOverridesFingerprint: next.fingerprint,
        preservationFingerprint: next.preservationFingerprint
      });
    }
    return {
      state: "captured",
      overrides: next,
      ...input.primary ? { proposedSharedBase: proposedConfigBase(current, input.shared, input.schema) } : {}
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account config capture failed" };
  }
}
function capabilityOperationMap(operations) {
  return new Map(operations.map((operation) => [operation.relativePath, clone(operation)]));
}
function replaceCapabilityOperation(map, operation) {
  map.set(operation.relativePath, clone(operation));
}
function capturedCapabilityOverrides(prior, expected, actual, sharedGeneration) {
  const operations = capabilityOperationMap(prior.operations);
  const expectedByPath = new Map(expected.filter((file) => file.provenance !== "local_only").map((file) => [file.relativePath, file]));
  const actualByPath = new Map(actual.files.filter((file) => file.scope === "shareable").map((file) => [file.relativePath, file]));
  for (const [path, file] of actualByPath) {
    const expectedFile = expectedByPath.get(path);
    if (!expectedFile || expectedFile.fingerprint !== file.fingerprint) {
      replaceCapabilityOperation(operations, {
        relativePath: path,
        op: "set",
        fingerprint: file.fingerprint,
        payloadFile: file.fingerprint.slice("sha256:".length)
      });
    }
  }
  for (const [path] of expectedByPath) {
    if (!actualByPath.has(path)) replaceCapabilityOperation(operations, { relativePath: path, op: "delete" });
  }
  const draft = {
    version: VERSION,
    opaqueAccountId: prior.opaqueAccountId,
    revision: prior.revision + 1,
    basedOnSharedGeneration: sharedGeneration,
    operations: normalizeCapabilityOperations([...operations.values()]),
    preservationFingerprint: capabilityFingerprint(actual.files.filter((file) => file.scope === "local_only"))
  };
  return { ...draft, fingerprint: accountCapabilityOverridesFingerprint(draft), ...prior.payloadRoot ? { payloadRoot: prior.payloadRoot } : {} };
}
function captureAccountCapabilitiesAfterExit(input) {
  try {
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before capability capture" };
    if (input.materialization.state !== "ready" || !input.materialization.expectedCapabilities || !input.materialization.effectiveCapabilityFingerprint) {
      return { state: "blocked", reason: "a valid prelaunch materialization receipt is required for capability capture" };
    }
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot, Boolean(input.apply));
    const prior = input.capabilityOverrides ?? loadAccountCapabilityOverrides(input.stateRoot, input.account);
    if (!prior || prior.opaqueAccountId !== input.account.opaqueAccountId) return { state: "blocked", reason: "account capability override sidecar is missing" };
    const current = scanCapabilityTree(input.account.codexHome);
    const next = capturedCapabilityOverrides(prior, input.materialization.expectedCapabilities, current, input.shared.capabilities.generation);
    if (input.apply) {
      writeCapabilityPayloads(accountRoot, current);
      persistCapabilityOverrides(accountRoot, next);
      atomicWritePrivateJson(accountRoot, CAPABILITY_CAPTURE_RECEIPT_FILE, {
        version: VERSION,
        opaqueAccountId: input.account.opaqueAccountId,
        prelaunchEffectiveFingerprint: input.materialization.effectiveCapabilityFingerprint,
        observedCapabilityFingerprint: effectiveCapabilityFingerprint(current.files),
        nextOverridesFingerprint: next.fingerprint,
        preservationFingerprint: next.preservationFingerprint
      });
    }
    return { state: "captured", overrides: next, ...input.primary ? { proposedSharedCapabilities: current } : {} };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account capability capture failed" };
  }
}
function materializationForIdleCapture(stored) {
  return {
    version: VERSION,
    state: "ready",
    opaqueAccountId: stored.opaqueAccountId,
    sharedGeneration: stored.sharedGeneration,
    configOverridesFingerprint: stored.configOverridesFingerprint,
    capabilityOverridesFingerprint: stored.capabilityOverridesFingerprint,
    configArtifactFingerprint: stored.configArtifactFingerprint,
    capabilityArtifactFingerprint: stored.capabilityArtifactFingerprint,
    effectiveConfigFingerprint: stored.effectiveConfigFingerprint,
    effectiveCapabilityFingerprint: stored.effectiveCapabilityFingerprint,
    expectedConfig: clone(stored.expectedConfig),
    // Capture compares path/fingerprint/provenance only. Do not read any
    // mutable home file merely to populate an unused payload here.
    expectedCapabilities: stored.expectedCapabilities.map((file) => ({ ...file, bytes: Buffer.alloc(0) })),
    inheritedConfigPaths: clone(stored.inheritedConfigPaths),
    inheritedCapabilityPaths: [...stored.inheritedCapabilityPaths],
    written: false
  };
}
function idleCaptureReceiptIsCoherent(stored) {
  return sha256Json(stored.expectedConfig) === stored.effectiveConfigFingerprint && capabilityFingerprint(stored.expectedCapabilities) === stored.effectiveCapabilityFingerprint;
}
function nextPrimaryConfigFromShared(shared, schema) {
  const generation = shared.config.generation + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("shared account generation overflow");
  return {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree: clone(shared.config.tree),
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, shared.config.tree)
  };
}
function captureIdleAccountChangesBeforeSpawn(input) {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before idle capture" };
    if (!isOpaqueAccountId(input.account.opaqueAccountId)) return { state: "blocked", reason: "invalid account id" };
    const persistedShared = loadSharedAccountBase(input.stateRoot);
    const persistedPlugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!persistedShared || !persistedPlugins || persistedShared.fingerprint !== input.shared.fingerprint || persistedPlugins.fingerprint !== input.plugins.fingerprint) {
      return { state: "blocked", reason: "shared account state changed before idle capture" };
    }
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot);
    if (readPrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE) !== null) {
      return { state: "blocked", reason: "account continuity recovery is required before idle capture" };
    }
    const stored = parseStoredMaterialization(readPrivateJson(accountRoot, MATERIALIZATION_FILE));
    if (!stored) return { state: "blocked", reason: "idle account changes lack a prior materialization receipt" };
    if (!idleCaptureReceiptIsCoherent(stored)) return { state: "blocked", reason: "idle account changes have an incoherent prior materialization receipt" };
    if (stored.opaqueAccountId !== input.account.opaqueAccountId || stored.codexHome !== (0, import_node_path.resolve)(input.account.codexHome)) {
      return { state: "blocked", reason: "idle account changes belong to a different account home" };
    }
    const currentConfig = readAccountConfig(input.account.codexHome);
    const currentCapabilities = scanCapabilityTree(input.account.codexHome);
    const configChanged = currentConfig.fingerprint !== stored.configArtifactFingerprint;
    const capabilitiesChanged = effectiveCapabilityFingerprint(currentCapabilities.files) !== stored.capabilityArtifactFingerprint;
    const primaryCapabilities = input.primary ? scanPrimarySharedCapabilities(input.account.codexHome) : void 0;
    const primaryLinksChanged = primaryCapabilities && capabilityFingerprint(primaryCapabilities.files.filter((file) => file.scope === "shareable")) !== capabilityFingerprint(input.shared.capabilities.files);
    if (primaryLinksChanged && input.apply) assertWriteEvidence(input.writeEvidence);
    if (!configChanged && !capabilitiesChanged) return primaryLinksChanged ? {
      state: "captured",
      proposedSharedConfig: nextPrimaryConfigFromShared(input.shared, input.schema),
      proposedSharedCapabilities: primaryCapabilities
    } : { state: "unchanged" };
    if (input.apply) assertWriteEvidence(input.writeEvidence);
    if (stored.schemaFingerprint !== input.schema.schemaFingerprint) {
      return { state: "blocked", reason: "changed idle account artifacts were materialized against an incompatible schema" };
    }
    const configOverrides = input.configOverrides ?? loadAccountConfigOverrides(input.stateRoot, input.account);
    const capabilityOverrides = input.capabilityOverrides ?? loadAccountCapabilityOverrides(input.stateRoot, input.account);
    if (!configOverrides || !capabilityOverrides) return { state: "blocked", reason: "idle account changes lack account-private override sidecars" };
    const materialization = materializationForIdleCapture(stored);
    const configCapture = configChanged ? captureAccountConfigAfterExit({
      stateRoot: input.stateRoot,
      account: input.account,
      shared: input.shared,
      schema: input.schema,
      materialization,
      configOverrides,
      primary: input.primary,
      apply: false
    }) : void 0;
    const capabilityCapture = capabilitiesChanged ? captureAccountCapabilitiesAfterExit({
      stateRoot: input.stateRoot,
      account: input.account,
      shared: input.shared,
      materialization,
      capabilityOverrides,
      primary: input.primary,
      apply: false
    }) : void 0;
    if (configCapture?.state === "blocked") return { state: "blocked", reason: configCapture.reason };
    if (capabilityCapture?.state === "blocked") return { state: "blocked", reason: capabilityCapture.reason };
    const nextConfigOverrides = configCapture?.overrides ?? configOverrides;
    const nextCapabilityOverrides = capabilityCapture?.overrides ?? capabilityOverrides;
    if (!nextConfigOverrides || !nextCapabilityOverrides) return { state: "blocked", reason: "idle account change capture did not produce sidecars" };
    if (input.apply) {
      if (configChanged) {
        const applied = captureAccountConfigAfterExit({
          stateRoot: input.stateRoot,
          account: input.account,
          shared: input.shared,
          schema: input.schema,
          materialization,
          configOverrides,
          primary: input.primary,
          apply: true
        });
        if (applied.state === "blocked" || !applied.overrides || applied.overrides.fingerprint !== nextConfigOverrides.fingerprint) {
          return { state: "blocked", reason: applied.reason ?? "idle config change capture changed during publication" };
        }
      }
      if (capabilitiesChanged) {
        const applied = captureAccountCapabilitiesAfterExit({
          stateRoot: input.stateRoot,
          account: input.account,
          shared: input.shared,
          materialization,
          capabilityOverrides,
          primary: input.primary,
          apply: true
        });
        if (applied.state === "blocked" || !applied.overrides || applied.overrides.fingerprint !== nextCapabilityOverrides.fingerprint) {
          return { state: "blocked", reason: applied.reason ?? "idle capability change capture changed during publication" };
        }
      }
    }
    return {
      state: "captured",
      configOverrides: nextConfigOverrides,
      capabilityOverrides: nextCapabilityOverrides,
      ...input.primary ? {
        proposedSharedConfig: configCapture?.proposedSharedBase ?? nextPrimaryConfigFromShared(input.shared, input.schema),
        proposedSharedCapabilities: primaryCapabilities
      } : {}
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "idle account change capture failed" };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ACCOUNT_LOCAL_OAUTH_MUTATION_METHOD_V1,
  ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1,
  DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1,
  abortUnpublishedSharedSourceRebase,
  bootstrapAccountContinuity,
  bootstrapSharedPluginsManifest,
  captureAccountCapabilitiesAfterExit,
  captureAccountConfigAfterExit,
  captureIdleAccountChangesBeforeSpawn,
  captureUnmaterializedNativeChangesBeforeSpawn,
  ensureAccountContinuityEnrollment,
  isAccountScopedCapabilityMutationV1,
  loadAccountCapabilityOverrides,
  loadAccountConfigOverrides,
  loadAccountContinuitySharedSourceProvenanceV1,
  loadSharedAccountBase,
  loadSharedPluginsManifestV1,
  observeExistingNativeAccountContinuity,
  parseLosslessTomlDocument,
  prepareAccountConfigBeforeSpawn,
  projectPrimarySharedBase,
  publishPrimaryPluginInventoryAfterExit,
  publishPrimarySharedBaseAfterExit,
  readLosslessTomlDocument,
  rebaseAccountContinuitySharedSource,
  renderResolvedAccountToml,
  resolveAccountCapabilities,
  resolveAccountConfig,
  scanCapabilityTree,
  validateAccountContinuityMaterialization
});
//# sourceMappingURL=account-continuity.js.map
