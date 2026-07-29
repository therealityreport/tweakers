"use strict";

class SemanticEvent {
  constructor(type) {
    this.type = type;
    this.defaultPrevented = false;
    this.target = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
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
    this.disabled = false;
    this.hidden = false;
    this.type = "";
    this._text = "";
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

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

  appendChild(node) {
    this.append(node);
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

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) {
      listener.call(this, event);
    }
    return !event.defaultPrevented;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent(new SemanticEvent("click"));
  }

  querySelectorAll(selector) {
    return query(this, selector, false);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class SemanticText extends SemanticNode {
  constructor(document, text) {
    super(document);
    this._text = String(text);
  }
}

class SemanticDocument {
  constructor() {
    this.documentElement = new SemanticNode(this, "html");
    this.head = new SemanticNode(this, "head");
    this.body = new SemanticNode(this, "body");
    this.documentElement.append(this.head, this.body);
  }

  createElement(tagName) {
    return new SemanticNode(this, tagName);
  }

  createTextNode(text) {
    return new SemanticText(this, text);
  }

  querySelectorAll(selector) {
    return query(this.documentElement, selector, true);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function query(root, selector, includeRoot) {
  const tagName = selector.toUpperCase();
  const nodes = [];
  const visit = (node, include) => {
    if (include && node.tagName === tagName) nodes.push(node);
    for (const child of node.children) visit(child, true);
  };
  visit(root, includeRoot);
  return nodes;
}

function createSemanticDom() {
  return {
    document: new SemanticDocument(),
    Event: SemanticEvent,
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

module.exports = {
  SemanticEvent,
  createSemanticDom,
  findByText,
  flushDom,
};
