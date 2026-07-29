"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BROKER_MAX_FRAME_BYTES,
  BROKER_PROTOCOL_VERSION,
  BrokerProtocolError,
  assertBrokerPermissions,
  createFrameDecoder,
  decodeFrame,
  encodeFrame,
  redactedDiagnostic,
  requestFrame,
} = require("../broker-protocol");

test("broker protocol accepts only versioned exact length-bounded frames", () => {
  const frame = requestFrame("request-1", "round.action", { revision: 3 });
  const encoded = encodeFrame(frame);
  assert.deepEqual(decodeFrame(encoded), frame);
  assert.equal(frame.version, BROKER_PROTOCOL_VERSION);

  assert.throws(
    () => decodeFrame(JSON.stringify({ ...frame, extra: true })),
    (error) => error instanceof BrokerProtocolError && error.code === "frame_invalid_shape",
  );
  assert.throws(
    () => decodeFrame(Buffer.alloc(BROKER_MAX_FRAME_BYTES + 1, 0x61)),
    (error) => error instanceof BrokerProtocolError && error.code === "frame_oversize",
  );
  assert.throws(
    () => requestFrame("request-2", "round.action", { invalid: undefined }),
    (error) => error instanceof BrokerProtocolError && error.code === "payload_invalid",
  );
});

test("stream decoder handles split frames and rejects an unterminated oversize frame", () => {
  const frames = [];
  const errors = [];
  const decoder = createFrameDecoder({ onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error) });
  const encoded = encodeFrame(requestFrame("request-split", "register", { nonce: "nonce-123456" }));
  decoder.push(encoded.subarray(0, 7));
  decoder.push(encoded.subarray(7));
  assert.equal(frames.length, 1);
  assert.deepEqual(errors, []);

  const rejected = createFrameDecoder({ onFrame() {}, onError: (error) => errors.push(error) });
  rejected.push(Buffer.alloc(BROKER_MAX_FRAME_BYTES + 1, 0x61));
  assert.equal(errors.at(-1)?.code, "frame_oversize");
});

test("broker permission contract requires ipc and network without manifest mutation", () => {
  assert.doesNotThrow(() => assertBrokerPermissions(["settings", "ipc", "network"]));
  assert.throws(
    () => assertBrokerPermissions(["ipc"]),
    (error) => error instanceof BrokerProtocolError && error.code === "missing_network_permission",
  );
  assert.throws(
    () => assertBrokerPermissions(["network"]),
    (error) => error instanceof BrokerProtocolError && error.code === "missing_ipc_permission",
  );
});

test("diagnostics whitelist lifecycle and error codes and redact all supplied content", () => {
  const sentinel = "PROMPT_ANSWER_SCHEMA_DO_NOT_LOG_5f84";
  const record = redactedDiagnostic("claim_request_failed", "request_timeout", {
    prompt: sentinel,
    answer: sentinel,
  });
  assert.deepEqual(record, {
    event: "claim_request_failed",
    contentRedacted: true,
    code: "request_timeout",
  });
  assert.doesNotMatch(JSON.stringify(record), new RegExp(sentinel));
  assert.deepEqual(redactedDiagnostic("secretprompt", "secretanswer"), {
    event: "diagnostic",
    contentRedacted: true,
  });
});
