import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { targetUserHome } from "./ownership.js";

/** Private provider child; stdout stays inside this process and is never logged. */
export async function runDoctorAccountLogin(command: string, stagedHome: string, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["app-server", "-c", 'cli_auth_credentials_store="file"'], {
      cwd: stagedHome, env: { HOME: targetUserHome(), CODEX_HOME: stagedHome, CODEX_SQLITE_HOME: stagedHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let done = false, outcome: Error | undefined, loginId: string | undefined;
    let prompt: ReturnType<typeof spawn> | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; outcome = error; clearTimeout(timer);
      prompt?.kill("SIGTERM"); child.stdin.end(); child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000); force.unref();
      child.once("close", () => clearTimeout(force));
    };
    const timer = setTimeout(() => finish(new Error("Account reconnect timed out. No credentials were changed.")), 15 * 60_000);
    const send = (value: unknown) => { if (!done) child.stdin.write(`${JSON.stringify(value)}\n`); };
    child.stdin.on("error", () => finish(new Error("Account reconnect helper disconnected.")));
    child.once("error", () => finish(new Error("Account reconnect helper could not start.")));
    child.once("close", () => {
      clearTimeout(timer); prompt?.kill("SIGTERM");
      if (!done) reject(new Error("Account reconnect ended before authentication completed."));
      else if (outcome) reject(outcome); else resolve();
    });
    createInterface({ input: child.stdout }).on("line", line => {
      if (done || line.length > 1024 * 1024) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.error) { finish(new Error("Account reconnect was rejected by the login service.")); return; }
      if (message.id === "initialize") {
        send({ jsonrpc: "2.0", method: "initialized" });
        send({ jsonrpc: "2.0", id: "login", method: "account/login/start", params: { type: "chatgptDeviceCode" } });
      } else if (message.id === "login") {
        const value = message.result;
        if (typeof value?.loginId !== "string" || typeof value.userCode !== "string" || !/^[A-Za-z0-9-]{3,32}$/.test(value.userCode)) { finish(new Error("Login service returned an invalid device code.")); return; }
        let url: URL;
        try { url = new URL(value.verificationUrl); } catch { finish(new Error("Login service returned an invalid URL.")); return; }
        if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname) || url.username || url.password) { finish(new Error("Login service returned an unsupported URL.")); return; }
        loginId = value.loginId;
        const opener = spawn("/usr/bin/open", [url.href], { stdio: "ignore", env: {} }); opener.on("error", () => {});
        prompt = spawn("/usr/bin/osascript", ["-e", 'on run argv\ndisplay dialog (item 1 of argv) with title "Reconnect Tweakers account" buttons {"Cancel", "I have signed in"} default button "I have signed in" cancel button "Cancel" giving up after 900\nend run',
          `Sign into the original ${label} in your browser.\n\nDevice code: ${value.userCode}\n\n${url.href}\n\nA login to your other account will be rejected without changing either account's history.`], { stdio: "ignore", env: {} });
        prompt.once("error", () => finish(new Error("Could not display the reconnect code.")));
        prompt.once("close", code => { if (code !== 0 && !done) finish(new Error("Account reconnect cancelled. No credentials were changed.")); });
      } else if (message.method === "account/login/completed" && message.params?.loginId === loginId) {
        finish(message.params.success === true ? undefined : new Error("Account login did not complete."));
      }
    });
    send({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { clientInfo: { name: "tweakers_doctor", version: "1.0.0" } } });
  });
}
