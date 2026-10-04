import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const [event, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["EOF", 0]] as const) {
	test(`stdio ${event} aborts in-flight work and waits for one cleanup`, { timeout: 5_000 }, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "stdio-shutdown-test."));
		const script = path.join(root, "fixture.mjs");
		const log = path.join(root, "cleanup.json");
		await writeFile(script, `
import { writeFile } from "node:fs/promises";
import { registerStdioShutdown } from ${JSON.stringify(new URL("../src/shutdown.ts", import.meta.url).href)};
let calls = 0;
const keepAlive = setInterval(() => {}, 1000);
const lifecycle = registerStdioShutdown(async () => {
  calls += 1;
  await new Promise(resolve => setTimeout(resolve, 30));
  await writeFile(${JSON.stringify(log)}, JSON.stringify({ calls, aborted: lifecycle.signal.aborted }));
  clearInterval(keepAlive);
});
process.stdin.resume();
process.stdout.write("ready\\n");
`);
		const proc = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
		const watchdog = setTimeout(() => proc.kill("SIGKILL"), 4_000);
		const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
			proc.once("error", reject);
			proc.once("close", (code, caughtSignal) => resolve({ code, signal: caughtSignal }));
		});
		try {
			await new Promise<void>((resolve, reject) => {
				proc.stdout.once("data", () => resolve());
				proc.once("error", reject);
				proc.once("exit", () => reject(new Error("fixture exited before startup")));
			});
			if (event === "EOF") proc.stdin.end();
			else { proc.kill(event); proc.kill(event); }
			assert.deepEqual(await exited, { code: exitCode, signal: null });
			assert.deepEqual(JSON.parse(await readFile(log, "utf8")), { calls: 1, aborted: true });
		} finally {
			clearTimeout(watchdog);
			proc.kill("SIGKILL");
			await exited;
			await rm(root, { recursive: true, force: true });
		}
	});
}

for (const phase of ["startup", "active", "retained"] as const) {
	test(`MCP stdin EOF cleans up a ${phase} request/session`, { timeout: 5_000 }, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "mcp-eof-test."));
		const script = path.join(root, "fixture.mjs");
		const log = path.join(root, "cleanup.json");
		await writeFile(script, `
import { writeFile } from "node:fs/promises";
import { StdioServerTransport } from ${JSON.stringify(new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href)};
import { registerStdioShutdown } from ${JSON.stringify(new URL("../src/shutdown.ts", import.meta.url).href)};
import { DirectSessionExecutor } from ${JSON.stringify(new URL("../src/session-executor.ts", import.meta.url).href)};
const phase = ${JSON.stringify(phase)};
const transport = new StdioServerTransport();
const keepAlive = setInterval(() => {}, 1000);
let closed = 0;
const ready = () => { void transport.send({ jsonrpc: "2.0", method: "fixture/ready" }); };
const waitForAbort = signal => {
  ready();
  return new Promise((_, reject) => {
    const abort = () => reject(new Error("fixture cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
};
const executor = new DirectSessionExecutor({ createSession: async options => {
  if (phase === "startup") await waitForAbort(options.signal);
  return {
    async call(method, args, options) {
      if (phase === "active") await waitForAbort(options.signal);
      return { content: [], isError: false, brokerVersion: "test", clientBuild: "test", elicitationRequests: 0, modelTurnsStarted: 0, ephemeralThread: true, brokerCleanupVerified: false };
    },
    async close() { closed += 1; }
  };
}});
const lifecycle = registerStdioShutdown(async () => {
  await executor.close();
  await writeFile(${JSON.stringify(log)}, JSON.stringify({ aborted: lifecycle.signal.aborted, closed }));
  clearInterval(keepAlive);
});
transport.onclose = () => { void lifecycle.shutdown(); };
transport.onmessage = () => {
  void executor.execute("get_app_state", { app: "fixture" }, { stateRoot: ${JSON.stringify(path.join(root, "state"))}, signal: lifecycle.signal })
    .then(() => { if (phase === "retained") ready(); }, () => {});
};
await transport.start();
`);
		const proc = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
		const watchdog = setTimeout(() => proc.kill("SIGKILL"), 4_000);
		const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
			proc.once("error", reject);
			proc.once("close", (code, signal) => resolve({ code, signal }));
		});
		try {
			const ready = new Promise<void>((resolve, reject) => {
				proc.stdout.once("data", () => resolve());
				proc.once("error", reject);
				proc.once("exit", () => reject(new Error("fixture exited before request entered")));
			});
			proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"fixture/start"}\n');
			await ready;
			proc.stdin.end();
			assert.deepEqual(await exited, { code: 0, signal: null });
			assert.deepEqual(JSON.parse(await readFile(log, "utf8")), { aborted: true, closed: phase === "startup" ? 0 : 1 });
		} finally {
			clearTimeout(watchdog);
			proc.kill("SIGKILL");
			await exited;
			await rm(root, { recursive: true, force: true });
		}
	});
}
