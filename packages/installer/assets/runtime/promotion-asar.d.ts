import * as nodeFs from "node:fs";
export interface RawAsarFileSystem {
    lstatSync: typeof nodeFs.lstatSync;
    openSync: typeof nodeFs.openSync;
    readSync: typeof nodeFs.readSync;
    closeSync: typeof nodeFs.closeSync;
}
/** Hash the decoded ASAR header JSON using an explicitly raw filesystem. */
export declare function hashRawAsarHeader(archivePath: string, fileSystem?: RawAsarFileSystem): string;
