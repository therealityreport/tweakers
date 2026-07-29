"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureTweakReloadFocus = captureTweakReloadFocus;
exports.restoreTweakReloadFocus = restoreTweakReloadFocus;
function captureTweakReloadFocus(document) {
    const element = document.activeElement;
    if (!element
        || element === document.body
        || element === document.documentElement
        || typeof element.focus !== "function") {
        return null;
    }
    return {
        document,
        element,
        selection: captureSelection(document, element),
    };
}
function restoreTweakReloadFocus(snapshot) {
    if (!snapshot?.element.isConnected)
        return false;
    const { document, element } = snapshot;
    const current = document.activeElement;
    if (current
        && current !== element
        && current !== document.body
        && current !== document.documentElement) {
        return false;
    }
    element.focus({ preventScroll: true });
    restoreSelection(snapshot);
    return document.activeElement === element;
}
function captureSelection(document, element) {
    if (isTextControl(element)) {
        const start = element.selectionStart;
        const end = element.selectionEnd;
        if (start === null || end === null)
            return null;
        return {
            kind: "control",
            start,
            end,
            direction: element.selectionDirection ?? "none",
        };
    }
    if (!element.isContentEditable)
        return null;
    const selection = document.getSelection?.();
    if (!selection
        || !selection.anchorNode
        || !selection.focusNode
        || !element.contains(selection.anchorNode)
        || !element.contains(selection.focusNode)) {
        return null;
    }
    return {
        kind: "contenteditable",
        anchor: textOffset(document, element, selection.anchorNode, selection.anchorOffset),
        focus: textOffset(document, element, selection.focusNode, selection.focusOffset),
    };
}
function restoreSelection(snapshot) {
    const { document, element, selection } = snapshot;
    if (!selection)
        return;
    if (selection.kind === "control" && isTextControl(element)) {
        element.setSelectionRange(selection.start, selection.end, selection.direction);
        return;
    }
    if (selection.kind !== "contenteditable" || !element.isContentEditable)
        return;
    const anchor = textPosition(document, element, selection.anchor);
    const focus = textPosition(document, element, selection.focus);
    const liveSelection = document.getSelection?.();
    if (!anchor || !focus || !liveSelection)
        return;
    if (typeof liveSelection.setBaseAndExtent === "function") {
        liveSelection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
        return;
    }
    const range = document.createRange();
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(focus.node, focus.offset);
    liveSelection.removeAllRanges();
    liveSelection.addRange(range);
}
function isTextControl(element) {
    return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}
function textOffset(document, root, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
}
function textPosition(document, root, target) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, target);
    let node = walker.nextNode();
    while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length)
            return { node, offset: remaining };
        remaining -= length;
        node = walker.nextNode();
    }
    return root.lastChild
        ? { node: root.lastChild, offset: root.lastChild.textContent?.length ?? 0 }
        : { node: root, offset: 0 };
}
//# sourceMappingURL=reload-focus.js.map