"use strict";

function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function maskLabel(value) {
  const text = String(value || "");
  if (text.length <= 2) return "••";
  return `${text.slice(0, 2)}…${text.slice(-1)}`;
}

function scrub(value, secret) {
  return String(value || "").slice(0, 256 * 1024).split(secret).join("[redacted]");
}

function safeId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw coded("invalid-id");
  return value;
}

function safeText(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw coded("invalid-text");
  return value.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[a-z0-9-]+$/.test(error.code) ? error.code : "operation-failed";
}

function safeFailure(code) {
  return { ok: false, error: { code, message: "The request could not be completed safely." } };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return typeof value === "string"
    ? value.replace(/(?:gh[opsu]_[A-Za-z0-9_]+|Bearer\s+\S+)/g, "[redacted]")
    : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /token|cookie|secret|password|authorization|path|env/i.test(key) ? "[redacted]" : redact(item);
  }
  return out;
}

module.exports = {
  titleCase,
  maskLabel,
  scrub,
  safeId,
  safeText,
  clone,
  replaceObject,
  isRecord,
  coded,
  errorCode,
  safeFailure,
  redact,
};
