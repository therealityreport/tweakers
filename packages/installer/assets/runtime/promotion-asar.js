"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashRawAsarHeader = hashRawAsarHeader;
const node_crypto_1 = require("node:crypto");
const nodeFs = __importStar(require("node:fs"));
function readExactly(fileSystem, descriptor, buffer, position, truncatedMessage) {
    let offset = 0;
    while (offset < buffer.length) {
        const remaining = buffer.length - offset;
        const bytesRead = fileSystem.readSync(descriptor, buffer, offset, remaining, position + offset);
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > remaining) {
            throw new Error("promotion ASAR read result is invalid");
        }
        if (bytesRead === 0)
            throw new Error(truncatedMessage);
        offset += bytesRead;
    }
}
/** Hash the decoded ASAR header JSON using an explicitly raw filesystem. */
function hashRawAsarHeader(archivePath, fileSystem = nodeFs) {
    const stat = fileSystem.lstatSync(archivePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16) {
        throw new Error("promotion app surface is not a regular ASAR archive");
    }
    const descriptor = fileSystem.openSync(archivePath, "r");
    try {
        const sizeBuffer = Buffer.alloc(8);
        readExactly(fileSystem, descriptor, sizeBuffer, 0, "promotion ASAR size pickle is truncated");
        if (sizeBuffer.readUInt32LE(0) !== 4)
            throw new Error("promotion ASAR size pickle is invalid");
        const headerSize = sizeBuffer.readUInt32LE(4);
        if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || headerSize + 8 > stat.size) {
            throw new Error("promotion ASAR header size is invalid");
        }
        const headerBuffer = Buffer.alloc(headerSize);
        readExactly(fileSystem, descriptor, headerBuffer, 8, "promotion ASAR header is truncated");
        const payloadSize = headerBuffer.readUInt32LE(0);
        const stringSize = headerBuffer.readInt32LE(4);
        if (payloadSize < 4 || payloadSize > headerSize - 4 || stringSize <= 0 || stringSize > payloadSize - 4) {
            throw new Error("promotion ASAR header pickle is invalid");
        }
        const headerString = headerBuffer.subarray(8, 8 + stringSize).toString("utf8");
        JSON.parse(headerString);
        return (0, node_crypto_1.createHash)("sha256").update(headerString).digest("hex");
    }
    finally {
        fileSystem.closeSync(descriptor);
    }
}
//# sourceMappingURL=promotion-asar.js.map