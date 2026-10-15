"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nativeServicesDescriptor = nativeServicesDescriptor;
function nativeServicesDescriptor(sources) {
    const candidates = [];
    for (const [asset, source] of sources) {
        if (!/^app-(?:initial|shared)-[a-f0-9]+\.js$/.test(asset))
            continue;
        for (const match of source.matchAll(/([$\w]+)=await ([$\w]+)\.services/g)) {
            const local = match[1].replace(/[$]/g, "\\$");
            // The native initialization also wires its thread read-state service.
            if (!source.slice(match.index, match.index + 600).includes(".threadReadState"))
                continue;
            const exportBlock = source.slice(source.lastIndexOf("export{"));
            const exported = exportBlock.match(new RegExp(`(?:,|\\{)${local} as ([$\\w]+)(?:,|\\})`));
            if (exported)
                candidates.push({ asset, exportName: exported[1] });
        }
    }
    return candidates.length === 1 ? candidates[0] : null;
}
//# sourceMappingURL=native-services-descriptor.js.map