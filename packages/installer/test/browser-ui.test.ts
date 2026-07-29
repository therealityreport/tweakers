import assert from "node:assert/strict";
import test from "node:test";
import { preparePortlessBrowserUiRoute } from "../src/commands/browser-ui";

test("browser host mode registers a non-forcing Portless alias for its loopback port", () => {
  const calls: Array<{ command: string; args: string[]; captureOutput: boolean }> = [];
  const url = preparePortlessBrowserUiRoute(8765, (command, args, captureOutput = false) => {
    calls.push({ command, args, captureOutput });
    return captureOutput ? "https://tweakers.localhost\n" : "";
  });

  assert.equal(url, "https://tweakers.localhost/");
  assert.deepEqual(calls, [
    {
      command: "portless",
      args: ["proxy", "start", "--https", "-p", "443", "--tld", "localhost"],
      captureOutput: false,
    },
    {
      command: "portless",
      args: ["get", "tweakers", "--no-worktree"],
      captureOutput: true,
    },
    {
      command: "portless",
      args: ["alias", "tweakers", "8765"],
      captureOutput: false,
    },
  ]);
  assert.equal(calls.some(({ args }) => args.includes("--force")), false);
});

test("browser host mode rejects a non-canonical proxy before registering an alias", () => {
  const calls: string[][] = [];

  assert.throws(
    () =>
      preparePortlessBrowserUiRoute(8765, (_command, args, captureOutput = false) => {
        calls.push(args);
        return captureOutput ? "https://tweakers.localhost:1355\n" : "";
      }),
    /Codex was not restarted.*requires https:\/\/tweakers\.localhost\//,
  );
  assert.deepEqual(calls, [
    ["proxy", "start", "--https", "-p", "443", "--tld", "localhost"],
    ["get", "tweakers", "--no-worktree"],
  ]);
});
