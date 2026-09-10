# Tweak UI examples

These examples illustrate UI patterns from an earlier app version. Verify current
markup, tokens, accessibility, and behavior against the target runtime before reuse.
They are reference material, not proof of current compatibility or authority to
reload an app. The workflow in `../AGENTS.md` and authoring rules in
`../tweaks/AGENTS.md` remain authoritative.

### 1. Section title row

Use this above each card-grouped form section.

```js
const titleRow = document.createElement("div");
titleRow.className = "flex h-toolbar items-center justify-between gap-2 px-0 py-0";
const inner = document.createElement("div");
inner.className = "flex min-w-0 flex-1 flex-col gap-1";
const t = document.createElement("div");
t.className = "text-base font-medium text-token-text-primary";
t.textContent = "General";
inner.appendChild(t);
titleRow.appendChild(inner);
root.appendChild(titleRow);
```

Optional subtitle below:

```js
const sub = document.createElement("div");
sub.className = "text-token-text-secondary text-sm";
sub.textContent = "Configure how the thing behaves.";
inner.appendChild(sub);
```

### 2. Rounded grouped card

Group rows inside one of these — Codex's signature settings card:

```js
const card = document.createElement("div");
card.className =
  "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
```

### 3. Setting row (label + control)

```js
const row = document.createElement("div");
row.className = "flex items-center justify-between gap-4 p-3";
const left = document.createElement("div");
left.className = "flex min-w-0 flex-col gap-1";
const label = document.createElement("div");
label.className = "min-w-0 text-sm text-token-text-primary";
label.textContent = "Show line numbers";
const desc = document.createElement("div");
desc.className = "text-token-text-secondary min-w-0 text-sm";
desc.textContent = "Display 1-indexed line numbers in the gutter.";
left.append(label, desc);
row.appendChild(left);
// row.appendChild(<your control>);
card.appendChild(row);
```

### 4. Toggle switch (Codex-native)

```js
function switchControl(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className =
    "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] " +
    "shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.className =
      "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 " +
      "focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
    pill.className =
      "relative inline-flex shrink-0 items-center rounded-full transition-colors " +
      "duration-200 ease-out h-5 w-8 " +
      (on ? "bg-token-charts-blue" : "bg-token-foreground/20");
    knob.style.transform = on ? "translateX(14px)" : "translateX(2px)";
  };
  apply(initial);
  btn.appendChild(pill);
  btn.addEventListener("click", async () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    apply(next);
    await onChange?.(next);
  });
  return btn;
}
```

### 5. Dropdown (Codex / Radix-style trigger)

```js
const trigger = document.createElement("button");
trigger.type = "button";
trigger.className =
  "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 " +
  "h-token-button-composer w-[240px] inline-flex items-center justify-between gap-2 " +
  "rounded-md border px-3 text-sm text-token-text-primary cursor-interaction";
trigger.innerHTML =
  '<span>Auto</span>' +
  '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="text-token-text-secondary">' +
    '<path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
```

(Wire your own popover; Radix isn't exposed.)

### 6. Link button ("Open file" pattern)

```js
const link = document.createElement("button");
link.type = "button";
link.className =
  "inline-flex items-center gap-1 text-sm text-token-text-link-foreground hover:underline cursor-interaction";
link.innerHTML =
  '<span>Open file</span>' +
  '<svg width="14" height="14" viewBox="0 0 20 20" fill="none">' +
    '<path d="M11 4h5v5M9 11l7-7M14 12v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3"' +
    ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
```

### 7. Danger pill (small, e.g. "Reset")

```js
const pill = document.createElement("button");
pill.type = "button";
pill.className =
  "rounded-full px-2 py-0.5 text-sm bg-token-charts-red/10 text-token-charts-red " +
  "hover:bg-token-charts-red/20 cursor-interaction";
pill.textContent = "Reset";
```

### 8. Danger button (large)

```js
const btn = document.createElement("button");
btn.type = "button";
btn.className =
  "h-token-button-composer rounded-md px-3 text-sm font-medium " +
  "bg-token-charts-red/10 text-token-charts-red hover:bg-token-charts-red/20 cursor-interaction";
btn.textContent = "Delete all data";
```
