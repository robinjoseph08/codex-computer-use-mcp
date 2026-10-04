import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectProcessesWithCwd } from "../src/direct-broker.ts";

const warning = "lsof: WARNING: can't stat() smbfs file system /Volumes/backups\n      Output information may be incomplete.\n      assuming \"dev=3600001f\" from mount table\n";

test("cwd enumeration tolerates only unrelated network-mount warnings", async () => {
	const workDir = await mkdtemp(path.join(os.tmpdir(), "cwd-enumeration-test."));
	try {
		for (const status of [0, 1]) {
			const pids = collectProcessesWithCwd(workDir, (command, args) => {
				assert.equal(command, "/usr/sbin/lsof");
				assert.deepEqual(args, ["-a", "-d", "cwd", "+d", workDir, "-Fp"]);
				return { status, stdout: status === 0 ? "p4242\n" : "", stderr: warning };
			});
			assert.deepEqual([...pids], status === 0 ? [4242] : []);
		}
		assert.deepEqual([...collectProcessesWithCwd(workDir, () => ({ status: 1, stderr: "" }))], []);
	} finally { await rm(workDir, { recursive: true, force: true }); }
});

test("cwd enumeration fails closed for relevant or unrecognized diagnostics", async () => {
	const workDir = await mkdtemp(path.join(os.tmpdir(), "cwd-enumeration-test."));
	try {
		for (const stderr of [
			warning.replace("/Volumes/backups", workDir),
			warning.replace("/Volumes/backups", path.dirname(workDir)),
			warning.replace("/Volumes/backups", path.join(workDir, "mounted")),
			warning.replace("smbfs", "apfs"),
			warning + "lsof: unexpected failure\n",
			"lsof: permission denied\n",
		]) {
			for (const status of [0, 1]) {
				assert.throws(
					() => collectProcessesWithCwd(workDir, () => ({ status, stderr, stdout: "p4242\n" })),
					(error: Error & { partialPids?: Set<number> }) => {
						assert.match(error.message, /Could not enumerate/);
						assert.deepEqual([...error.partialPids ?? []], [4242]);
						return true;
					},
				);
			}
		}
		assert.throws(() => collectProcessesWithCwd(workDir, () => ({ status: null, error: new Error("timeout") })), /Could not enumerate/);
		assert.throws(() => collectProcessesWithCwd(workDir, () => ({ status: 2 })), /Could not enumerate/);
	} finally { await rm(workDir, { recursive: true, force: true }); }
});
