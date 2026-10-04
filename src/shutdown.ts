export function registerStdioShutdown(closeSession: () => Promise<void>) {
	const controller = new AbortController();
	let closing: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		controller.abort();
		closing ??= Promise.resolve().then(closeSession);
		return closing;
	};
	for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
		process.on(signal, () => {
			void shutdown().then(() => process.exit(exitCode), () => process.exit(1));
		});
	}
	const disconnected = (): void => {
		void shutdown().catch(() => { process.exitCode = 1; });
	};
	process.stdin.on("end", disconnected);
	process.stdin.on("close", disconnected);
	return { signal: controller.signal, shutdown };
}
