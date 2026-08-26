"use strict";

const net = require("node:net");

function exchangeEnhancement(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.once("error", (error) => finish(reject, error));
    const rejectIncompleteResponse = () => finish(
      reject,
      new Error("enhancement socket closed before a complete response frame"),
    );
    socket.once("end", rejectIncompleteResponse);
    socket.once("close", rejectIncompleteResponse);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { finish(resolve, JSON.parse(buffer.slice(0, newline))); }
      catch (error) { finish(reject, error); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
  });
}

module.exports = { exchangeEnhancement };
