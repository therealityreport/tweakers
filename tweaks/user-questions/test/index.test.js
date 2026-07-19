"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("renderer conditionally shows inline Other fields, squares checkboxes, and cleans up", () => {
  const source = fs.readFileSync(require.resolve("../index"), "utf8");
  const regularRadio = makeControl("Leave it ready", "radio", false);
  const otherRadio = makeControl("Other", "radio", false);
  const singleOther = makeOtherField();
  const singleForm = makeForm(
    "Should I restart? co-tweakers-user-questions requests input",
    [regularRadio, otherRadio],
    [singleOther.input],
  );

  const regularCheckbox = makeControl("Features — One", "checkbox", true);
  const otherCheckbox = makeControl("Features — Other", "checkbox", false);
  const multiOther = makeOtherField();
  const multiForm = makeForm(
    "Question 2 of 3: Which features? co-tweakers-user-questions requests input",
    [regularCheckbox, otherCheckbox],
    [multiOther.input],
  );

  const oldFirstOther = makeControl("Other", "radio", true, "First choice");
  const oldSecondOther = makeControl("Other", "radio", false, "Second choice");
  const oldFirstField = makeOtherField("First choice — Other");
  const oldSecondField = makeOtherField("Second choice — Other");
  const oldFlatForm = makeForm(
    "2 Antworten erforderlich — co-tweakers-user-questions bittet um Eingabe",
    [oldFirstOther, oldSecondOther],
    [oldFirstField.input, oldSecondField.input],
  );

  const unrelatedCheckbox = makeControl("Other", "checkbox", false);
  const unrelatedOther = makeOtherField();
  const unrelatedForm = makeForm(
    "another-server requests input",
    [unrelatedCheckbox],
    [unrelatedOther.input],
  );
  const forms = [singleForm, multiForm, oldFlatForm, unrelatedForm];
  const controls = [regularRadio, otherRadio, regularCheckbox, otherCheckbox, oldFirstOther, oldSecondOther, unrelatedCheckbox];
  const fields = [singleOther.field, multiOther.field, oldFirstField.field, oldSecondField.field, unrelatedOther.field];
  const inputs = [singleOther.input, multiOther.input, oldFirstField.input, oldSecondField.input, unrelatedOther.input];
  let observer;
  let appendedStyle;
  let styleRemoved = false;
  const document = {
    body: {},
    head: {
      appendChild(node) { appendedStyle = node; },
    },
    createElement(tagName) {
      if (tagName !== "style") return { tagName, className: "", textContent: "" };
      return {
        tagName,
        textContent: "",
        setAttribute() {},
        remove() { styleRemoved = true; },
      };
    },
    querySelectorAll(selector) {
      if (selector === "form") return forms;
      if (selector === "[data-tweaker-user-questions-checkbox]") {
        return controls.filter((control) => control.hasAttribute("data-tweaker-user-questions-checkbox"));
      }
      if (selector === "[data-tweaker-user-questions-other-field]") {
        return fields.filter((field) => field.hasAttribute("data-tweaker-user-questions-other-field"));
      }
      if (selector === "[data-tweaker-user-questions-other-input]") {
        return inputs.filter((input) => input.hasAttribute("data-tweaker-user-questions-other-input"));
      }
      return [];
    },
  };
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observer = this;
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() { this.disconnected = true; }
  }
  const sandbox = { document, MutationObserver: FakeMutationObserver, module: { exports: {} }, exports: {} };

  vm.runInNewContext(source, sandbox, { filename: "user-questions/index.js" });
  assert.equal(Object.hasOwn(sandbox, "require"), false);

  let page;
  let unregisterCount = 0;
  const tweak = sandbox.module.exports;
  tweak.start({
    process: "renderer",
    settings: {
      registerPage(definition) {
        page = definition;
        return { unregister() { unregisterCount += 1; } };
      },
    },
  });

  assert.ok(appendedStyle);
  assert.match(appendedStyle.textContent, /button\[role="checkbox"\]/);
  assert.match(appendedStyle.textContent, /border-radius: var\(--radius-xs, 0\.25rem\) !important/);
  assert.match(appendedStyle.textContent, /data-tweaker-user-questions-other-field/);
  assert.equal(regularCheckbox.hasAttribute("data-tweaker-user-questions-checkbox"), true);
  assert.equal(otherCheckbox.hasAttribute("data-tweaker-user-questions-checkbox"), true);
  assert.equal(regularRadio.hasAttribute("data-tweaker-user-questions-checkbox"), false);
  assert.equal(unrelatedCheckbox.hasAttribute("data-tweaker-user-questions-checkbox"), false);
  assert.equal(singleOther.field.hidden, true);
  assert.equal(singleOther.input.required, false);
  assert.equal(multiOther.field.hidden, true);
  assert.equal(oldFirstField.field.hidden, false);
  assert.equal(oldFirstField.input.required, true);
  assert.equal(oldSecondField.field.hidden, true);
  assert.equal(oldSecondField.input.required, false);
  assert.equal(unrelatedOther.field.hidden, false);
  assert.equal(observer.target, document.body);
  assert.equal(observer.options.attributes, true);
  assert.equal(observer.options.attributeFilter[0], "aria-checked");
  assert.equal(observer.options.childList, true);
  assert.equal(observer.options.subtree, true);

  otherRadio.setAttribute("aria-checked", "true");
  observer.callback();
  assert.equal(singleOther.field.hidden, false);
  assert.equal(singleOther.field.hasAttribute("aria-hidden"), false);
  assert.equal(singleOther.input.required, true);
  assert.equal(singleOther.input.getAttribute("aria-required"), "true");

  otherRadio.setAttribute("aria-checked", "false");
  observer.callback();
  assert.equal(singleOther.field.hidden, true);
  assert.equal(singleOther.input.required, false);

  otherCheckbox.setAttribute("aria-checked", "true");
  observer.callback();
  assert.equal(multiOther.field.hidden, false);
  assert.equal(multiOther.input.required, true);

  oldFirstOther.setAttribute("aria-checked", "false");
  oldSecondOther.setAttribute("aria-checked", "true");
  observer.callback();
  assert.equal(oldFirstField.field.hidden, true);
  assert.equal(oldFirstField.input.required, false);
  assert.equal(oldSecondField.field.hidden, false);
  assert.equal(oldSecondField.input.required, true);

  assert.equal(page.id, "user-questions");
  assert.match(page.description, /shown one at a time/);
  assert.match(page.description, /conditional inline Other input/);
  assert.match(page.description, /checkbox-style multi-select controls/);
  const root = {
    children: [],
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
  };
  page.render(root);
  assert.equal(root.children.length, 1);
  assert.match(root.children[0].textContent, /Question-only prompts/);
  assert.match(root.children[0].textContent, /shows questions one at a time/);
  assert.match(root.children[0].textContent, /current task stays visible/);
  assert.match(root.children[0].textContent, /rounded-square checkboxes/);
  assert.match(root.children[0].textContent, /sits directly below the Other choice/);
  assert.match(root.children[0].textContent, /visible only while Other is selected/);
  assert.match(root.children[0].textContent, /approval_policy = never/);

  tweak.stop();
  assert.equal(unregisterCount, 1);
  assert.equal(observer.disconnected, true);
  assert.equal(styleRemoved, true);
  assert.equal(regularCheckbox.hasAttribute("data-tweaker-user-questions-checkbox"), false);
  assert.equal(otherCheckbox.hasAttribute("data-tweaker-user-questions-checkbox"), false);
  assert.equal(singleOther.field.hidden, false);
  assert.equal(singleOther.field.hasAttribute("data-tweaker-user-questions-other-field"), false);
  assert.equal(multiOther.field.hidden, false);
  assert.equal(oldFirstField.field.hidden, false);
  assert.equal(oldSecondField.field.hidden, false);
  assert.equal(singleOther.input.required, false);
  assert.equal(multiOther.input.required, false);
  assert.equal(oldFirstField.input.required, false);
  assert.equal(oldSecondField.input.required, false);
  assert.equal(singleOther.input.hasAttribute("data-tweaker-user-questions-other-input"), false);
});

function makeControl(textContent, role, checked, header = "") {
  const attributes = new Map();
  attributes.set("role", role);
  attributes.set("aria-checked", String(checked));
  const fieldset = header ? {
    querySelector(selector) {
      return selector === "legend" ? { textContent: header } : null;
    },
  } : null;
  return {
    textContent,
    closest(selector) { return selector === "fieldset" ? fieldset : null; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
}

function makeOtherField(title = "Question — Other response") {
  const fieldAttributes = new Map();
  const inputAttributes = new Map();
  const field = {
    firstElementChild: { textContent: title },
    hidden: false,
    textContent: "Other response",
    setAttribute(name, value) { fieldAttributes.set(name, value); },
    removeAttribute(name) { fieldAttributes.delete(name); },
    hasAttribute(name) { return fieldAttributes.has(name); },
  };
  const input = {
    required: false,
    closest(selector) { return selector === "label" ? field : null; },
    setAttribute(name, value) { inputAttributes.set(name, value); },
    removeAttribute(name) { inputAttributes.delete(name); },
    hasAttribute(name) { return inputAttributes.has(name); },
    getAttribute(name) { return inputAttributes.get(name) ?? null; },
  };
  return { field, input };
}

function makeForm(textContent, controls, inputs) {
  return {
    textContent,
    querySelectorAll(selector) {
      if (selector === 'button[role="checkbox"]') {
        return controls.filter((control) => control.getAttribute("role") === "checkbox");
      }
      if (selector === 'button[role="radio"], button[role="checkbox"]') return controls;
      if (selector === 'input[maxlength="4000"]') return inputs;
      return [];
    },
  };
}

test("main evaluation preserves question-only approval policy repair", () => {
  const source = fs.readFileSync(require.resolve("../index"), "utf8");
  let repairCount = 0;
  const infoMessages = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(specifier) {
      assert.equal(specifier, "./policy-state");
      return {
        repairGlobalStateFile() {
          repairCount += 1;
          return { changed: true, repairedThreads: 2 };
        },
      };
    },
  };

  vm.runInNewContext(source, sandbox, { filename: "user-questions/index.js" });
  sandbox.module.exports.start({
    process: "main",
    log: {
      info(message) { infoMessages.push(message); },
      warn() {},
      error() {},
    },
  });

  assert.equal(repairCount, 1);
  assert.equal(infoMessages.length, 1);
  assert.match(infoMessages[0], /migrated 2 Full Access task record\(s\)/);
  assert.doesNotThrow(() => sandbox.module.exports.stop());
});
