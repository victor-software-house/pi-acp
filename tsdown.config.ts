import { defineConfig } from "tsdown";

export default defineConfig({
	entry: "src/index.ts",
	format: "esm",
	platform: "node",
	target: "node22",
	sourcemap: true,
	clean: true,
	dts: false,
	banner: {
		js: "#!/usr/bin/env node",
	},
});
