/** Identify the exported, initialized native RPC facade without modifying vendor code. */
export interface NativeServicesDescriptor {
    asset: string;
    exportName: string;
}
export declare function nativeServicesDescriptor(sources: ReadonlyMap<string, string>): NativeServicesDescriptor | null;
