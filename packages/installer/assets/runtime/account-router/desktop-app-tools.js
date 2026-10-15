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

// ../../node_modules/toml-eslint-parser/lib/internal-utils/index.js
var require_internal_utils = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/internal-utils/index.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/parser-options.js
var require_parser_options = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/parser-options.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/errors.js
var require_errors = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/errors.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/tokenizer/locs.js
var require_locs = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/tokenizer/locs.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/tokenizer/code-point-iterator.js
var require_code_point_iterator = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/tokenizer/code-point-iterator.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CodePointIterator = void 0;
    var locs_1 = require_locs();
    var CodePointIterator = class {
      /**
       * Initialize this char iterator.
       */
      constructor(text2) {
        this.locs = new locs_1.Locations();
        this.lastCodePoint = 0;
        this.start = -1;
        this.end = 0;
        this.text = text2;
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

// ../../node_modules/toml-eslint-parser/lib/tokenizer/code-point.js
var require_code_point = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/tokenizer/code-point.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/tokenizer/tokenizer.js
var require_tokenizer = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/tokenizer/tokenizer.js"(exports2) {
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
      constructor(text2, parserOptions) {
        this.backCode = false;
        this.lastCodePoint = 0;
        this.state = "DATA";
        this.token = null;
        this.tokenStart = -1;
        this.valuesEnabled = false;
        this.text = text2;
        this.parserOptions = parserOptions || {};
        this.codePointIterator = new code_point_iterator_1.CodePointIterator(text2);
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
            const text2 = option1;
            token = {
              type,
              value,
              number: parseInt(text2, option2),
              bigint: HAS_BIGINT ? BigInt(RADIX_PREFIXES[option2] + text2) : null,
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

// ../../node_modules/toml-eslint-parser/lib/tokenizer/index.js
var require_tokenizer2 = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/tokenizer/index.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/toml-parser/keys-resolver.js
var require_keys_resolver = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/toml-parser/keys-resolver.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/toml-parser/context.js
var require_context = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/toml-parser/context.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/toml-parser/index.js
var require_toml_parser = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/toml-parser/index.js"(exports2) {
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
      constructor(text2, parserOptions) {
        this.text = text2;
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
        const text2 = this.text;
        const [startRange, endRange] = token.range;
        let numberString = null;
        const getNumberText = () => {
          return numberString !== null && numberString !== void 0 ? numberString : numberString = text2.slice(startRange, endRange).replace(/_/g, "");
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

// ../../node_modules/toml-eslint-parser/lib/visitor-keys.js
var require_visitor_keys = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/visitor-keys.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/parser.js
var require_parser = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/parser.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/traverse.js
var require_traverse = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/traverse.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/utils.js
var require_utils = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/utils.js"(exports2) {
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

// ../../node_modules/toml-eslint-parser/lib/meta.js
var require_meta = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/meta.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.version = exports2.name = void 0;
    exports2.name = "toml-eslint-parser";
    exports2.version = "0.12.0";
  }
});

// ../../node_modules/toml-eslint-parser/lib/index.js
var require_lib = __commonJS({
  "../../node_modules/toml-eslint-parser/lib/index.js"(exports2) {
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

// src/account-router/desktop-app-tools.ts
var desktop_app_tools_exports = {};
__export(desktop_app_tools_exports, {
  DESKTOP_APP_TOOLS_CONTEXT_ENV: () => DESKTOP_APP_TOOLS_CONTEXT_ENV,
  MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES: () => MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES,
  captureDesktopAppToolsContext: () => captureDesktopAppToolsContext,
  desktopAppToolsFingerprint: () => desktopAppToolsFingerprint,
  injectDesktopAppToolsRequestConfig: () => injectDesktopAppToolsRequestConfig,
  isDesktopAppToolsContext: () => isDesktopAppToolsContext,
  parseDesktopAppToolsContext: () => parseDesktopAppToolsContext,
  stripDesktopAppToolsCliOverrides: () => stripDesktopAppToolsCliOverrides
});
module.exports = __toCommonJS(desktop_app_tools_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_toml_eslint_parser = __toESM(require_lib());
var DESKTOP_APP_TOOLS_CONTEXT_ENV = "TWEAKERS_DESKTOP_APP_TOOLS_CONTEXT_V1";
var MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES = 64 * 1024;
var pluginRelativePath = "plugins/openai-bundled/plugins/codex-app-tools";
var nativeBackendRelativePath = "codex-cli/CodexCLI.app/Contents/MacOS/codex";
var invalid = () => new Error("Desktop app tools context unavailable");
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
var text = (value) => typeof value === "string" && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/.test(value);
var absolute = (value) => text(value) && (0, import_node_path.isAbsolute)(value) && (0, import_node_path.resolve)(value) === value;
var within = (root, path) => {
  const suffix = (0, import_node_path.relative)(root, path);
  return suffix !== ".." && !suffix.startsWith("../") && !(0, import_node_path.isAbsolute)(suffix);
};
function boundedJson(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => boundedJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 256 && Object.entries(value).every(([key, item]) => text(key) && !["__proto__", "constructor", "prototype"].includes(key) && boundedJson(item, depth + 1));
}
function isDesktopAppToolsContext(value) {
  if (!record(value) || Object.keys(value).some((key) => !["schemaVersion", "resourcesPath", "definition"].includes(key)) || value.schemaVersion !== 1 || !absolute(value.resourcesPath) || !boundedJson(value)) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES) return false;
  } catch {
    return false;
  }
  const definition = value.definition;
  const pluginRoot = (0, import_node_path.join)(value.resourcesPath, pluginRelativePath);
  if (!record(definition) || definition.enabled !== true || definition.cwd !== pluginRoot || !absolute(definition.command) || !within(pluginRoot, definition.command) || !Array.isArray(definition.args) || !definition.args.length || !definition.args.every(text) || !absolute(definition.args[0]) || !within(pluginRoot, definition.args[0]) || !Array.isArray(definition.env_vars) || !definition.env_vars.every((key) => text(key) && /^[A-Z_][A-Z0-9_]*$/.test(key)) || !definition.env_vars.includes("CODEX_APP_TOOLS_PIPE_PATH") || !record(definition.env) || !Object.entries(definition.env).every(([key, val]) => definition.env_vars.includes(key) && text(val))) return false;
  const env = definition.env;
  return absolute(env.CODEX_APP_TOOLS_PIPE_PATH) && env.CODEX_ELECTRON_RESOURCES_PATH === value.resourcesPath && env.CODEX_MCP_NODE_PATH === (0, import_node_path.join)(value.resourcesPath, "cua_node", "bin", "node") && env.CODEX_BROWSER_USE_NODE_PATH === env.CODEX_MCP_NODE_PATH && typeof env.CODEX_CLI_PATH === "string" && [(0, import_node_path.join)(value.resourcesPath, "codex"), (0, import_node_path.join)(value.resourcesPath, nativeBackendRelativePath)].includes(env.CODEX_CLI_PATH) && !definition.env_vars.includes("NODE_OPTIONS");
}
function parseDesktopAppToolsContext(serialized) {
  if (Buffer.byteLength(serialized) > MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES) throw invalid();
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalid();
  }
  if (!isDesktopAppToolsContext(value)) throw invalid();
  return value;
}
function captureDesktopAppToolsContext(resourcesPath, environment, readFile = import_node_fs.readFileSync, backendCommand = (0, import_node_path.join)(resourcesPath, "codex")) {
  if (environment.CODEX_APP_TOOLS_PIPE_PATH === void 0) return null;
  if (!absolute(resourcesPath) || !absolute(environment.CODEX_APP_TOOLS_PIPE_PATH)) throw invalid();
  const backend = backendCommand === (0, import_node_path.join)(resourcesPath, "codex-cli/bin/codex") ? (0, import_node_path.join)(resourcesPath, nativeBackendRelativePath) : backendCommand;
  if (![(0, import_node_path.join)(resourcesPath, "codex"), (0, import_node_path.join)(resourcesPath, nativeBackendRelativePath)].includes(backend)) throw invalid();
  const pluginRoot = (0, import_node_path.join)(resourcesPath, pluginRelativePath);
  let manifest;
  try {
    const serialized = readFile((0, import_node_path.join)(pluginRoot, ".mcp.json"), "utf8");
    if (Buffer.byteLength(serialized) > MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES) throw invalid();
    manifest = JSON.parse(serialized);
  } catch {
    throw invalid();
  }
  const servers = record(manifest) ? manifest.mcpServers : null;
  const native = record(servers) ? servers.codex_app : null;
  if (!record(native) || !boundedJson(native) || !text(native.command) || !native.command || !Array.isArray(native.args) || !native.args.length || !native.args.every(text) || !text(native.cwd) || !Array.isArray(native.env_vars) || !native.env_vars.every(text)) throw invalid();
  const env = {};
  if (native.env !== void 0) {
    if (!record(native.env) || !Object.entries(native.env).every(([key, value2]) => native.env_vars.includes(key) && text(value2))) throw invalid();
    Object.assign(env, native.env);
  }
  for (const key of native.env_vars) if (environment[key] !== void 0) env[key] = environment[key];
  Object.assign(env, {
    CODEX_APP_TOOLS_PIPE_PATH: environment.CODEX_APP_TOOLS_PIPE_PATH,
    CODEX_MCP_NODE_PATH: (0, import_node_path.join)(resourcesPath, "cua_node", "bin", "node"),
    CODEX_BROWSER_USE_NODE_PATH: (0, import_node_path.join)(resourcesPath, "cua_node", "bin", "node"),
    CODEX_ELECTRON_RESOURCES_PATH: resourcesPath,
    CODEX_CLI_PATH: backend
  });
  const value = {
    schemaVersion: 1,
    resourcesPath,
    definition: {
      ...native,
      enabled: true,
      cwd: (0, import_node_path.resolve)(pluginRoot, native.cwd),
      command: (0, import_node_path.resolve)(pluginRoot, native.command),
      args: native.args.map((arg) => arg.startsWith("./") || arg.startsWith("../") ? (0, import_node_path.resolve)(pluginRoot, arg) : arg),
      env
    }
  };
  if (!isDesktopAppToolsContext(value)) throw invalid();
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function desktopAppToolsFingerprint(context) {
  if (!isDesktopAppToolsContext(context)) throw invalid();
  return (0, import_node_crypto.createHash)("sha256").update(canonical(context)).digest("hex");
}
function configKeyPath(key) {
  if (Buffer.byteLength(key) > 4096 || /[\r\n\0]/.test(key)) return [];
  try {
    const body = (0, import_toml_eslint_parser.parseTOML)(`${key}=true`, { tomlVersion: "1.0.0" }).body[0].body;
    const node = body.length === 1 ? body[0] : null;
    return node?.type === "TOMLKeyValue" ? node.key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value) : [];
  } catch {
    return [];
  }
}
function nativePluginKey(name) {
  return name?.split("@")[0] === "codex-app-tools";
}
function desktopOverridePath(path) {
  return path[0] === "mcp_servers" && path[1] === "codex_app" || path[0] === "plugins" && nativePluginKey(path[1]);
}
function configAssignmentKey(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "=") return value.slice(0, index);
  }
  return "";
}
function stripDesktopAppToolsCliOverrides(args) {
  const output = [];
  const owns = (value) => desktopOverridePath(configKeyPath(configAssignmentKey(value)));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === "-c" || arg === "--config") && typeof args[index + 1] === "string" && owns(args[index + 1])) {
      index++;
      continue;
    }
    const attached = arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c=") ? arg.slice(3) : arg.startsWith("-c") && arg.length > 2 ? arg.slice(2) : null;
    if (attached !== null && owns(attached)) continue;
    output.push(arg);
  }
  return output;
}
function injectDesktopAppToolsRequestConfig(config, context) {
  if (context !== null && !isDesktopAppToolsContext(context)) throw invalid();
  if (config !== void 0 && config !== null && !record(config)) throw invalid();
  const out = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const path = configKeyPath(key);
    if (desktopOverridePath(path)) continue;
    if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
    if (path.length === 1 && (path[0] === "mcp_servers" || path[0] === "plugins")) {
      if (!record(value)) continue;
      const servers = { ...value };
      for (const name of Object.keys(servers)) {
        const nested = configKeyPath(name);
        if (path[0] === "mcp_servers" && nested[0] === "codex_app" || path[0] === "plugins" && nativePluginKey(nested[0] ?? name)) delete servers[name];
      }
      out[key] = servers;
    } else out[key] = value;
  }
  if (context) out["mcp_servers.codex_app"] = JSON.parse(JSON.stringify(context.definition));
  return out;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DESKTOP_APP_TOOLS_CONTEXT_ENV,
  MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES,
  captureDesktopAppToolsContext,
  desktopAppToolsFingerprint,
  injectDesktopAppToolsRequestConfig,
  isDesktopAppToolsContext,
  parseDesktopAppToolsContext,
  stripDesktopAppToolsCliOverrides
});
//# sourceMappingURL=desktop-app-tools.js.map
