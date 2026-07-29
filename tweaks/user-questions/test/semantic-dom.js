"use strict";

class SemanticEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.key = options.key;
    this.metaKey = Boolean(options.metaKey);
    this.ctrlKey = Boolean(options.ctrlKey);
    this.defaultPrevented = false;
    this.target = null;
  }
  preventDefault() { this.defaultPrevented = true; }
}

class SemanticNode {
  constructor(document, tagName = "") {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.style = {};
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.id = "";
    this._text = "";
  }
  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.ownerDocument.documentElement) return true;
      node = node.parentNode;
    }
    return false;
  }
  get firstElementChild() { return this.children.find((child) => child.tagName) || null; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) {
    this._text = String(value ?? "");
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === "string") node = this.ownerDocument.createTextNode(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, reference) {
    node.parentNode = this;
    const index = this.children.indexOf(reference);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === "INPUT" && (this.type === "radio" || this.type === "checkbox")) {
      if (this.type === "radio") {
        for (const input of this.ownerDocument.querySelectorAll("input")) {
          if (input !== this && input.type === "radio" && input.name === this.name) input.checked = false;
        }
        this.checked = true;
      } else this.checked = !this.checked;
      this.dispatchEvent(new SemanticEvent("change"));
    }
    this.dispatchEvent(new SemanticEvent("click"));
  }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { return query(this, selector, false); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class SemanticText extends SemanticNode {
  constructor(document, text) { super(document); this._text = String(text); }
}

class SemanticDocument {
  constructor() {
    this.documentElement = new SemanticNode(this, "html");
    this.head = new SemanticNode(this, "head");
    this.body = new SemanticNode(this, "body");
    this.documentElement.append(this.head, this.body);
    this.activeElement = null;
  }
  createElement(tagName) { return new SemanticNode(this, tagName); }
  createTextNode(text) { return new SemanticText(this, text); }
  querySelectorAll(selector) { return query(this.documentElement, selector, true); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function query(root, selector, includeRoot) {
  const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
  const nodes = [];
  const visit = (node, include) => {
    if (include && node.tagName && selectors.some((part) => matches(node, part))) nodes.push(node);
    for (const child of node.children) visit(child, true);
  };
  visit(root, includeRoot);
  return [...new Set(nodes)];
}

function matches(node, selector) {
  const parsed = /^(?:([a-zA-Z][\w-]*))?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(selector);
  if (!parsed) return false;
  const [, tag, attribute, value] = parsed;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (!attribute) return Boolean(tag);
  if (!node.hasAttribute(attribute)) return false;
  return value === undefined || node.getAttribute(attribute) === value;
}

function createSemanticDom() {
  const document = new SemanticDocument();
  return {
    document,
    Event: SemanticEvent,
    requestAnimationFrame(callback) { setImmediate(() => callback(Date.now())); },
  };
}

function findByText(root, tagName, text) {
  return root.querySelectorAll(tagName).find((node) => node.textContent.trim() === text) || null;
}

function flushDom(turns = 8) {
  return new Promise((resolve) => {
    let remaining = turns;
    const next = () => remaining-- <= 0 ? resolve() : setImmediate(next);
    next();
  });
}

module.exports = { SemanticEvent, createSemanticDom, findByText, flushDom };
