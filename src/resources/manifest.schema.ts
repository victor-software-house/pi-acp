/**
 * Zod schema for the `.pi-acp.yaml` resource composition manifest (ADR-0008).
 *
 * Backend kinds: `local`, `ssh`, `http`, `acp-fs`. Phase 5 ships parsing and
 * validation for all four; only `local` is honored by the loader until the
 * remote-backend phases land — unknown kinds parse fine and surface as a
 * diagnostic at load time.
 */

import * as z from "zod";

const IdSchema = z.string().trim().min(1, "id is required");

const LocalPathsSchema = z
	.object({
		cwd: z.string().trim().optional(),
		agentDir: z.string().trim().optional(),
	})
	.strict();

const RemotePathsSchema = z
	.object({
		skills: z.string().trim().optional(),
		prompts: z.string().trim().optional(),
		agentsFiles: z.array(z.string().trim()).optional(),
		extensions: z.string().trim().optional(),
	})
	.strict();

const LocalRootSchema = z
	.object({
		id: IdSchema,
		kind: z.literal("local"),
		paths: LocalPathsSchema.default({}),
	})
	.strict();

const SshRootSchema = z
	.object({
		id: IdSchema,
		kind: z.literal("ssh"),
		host: z.string().trim().min(1),
		user: z.string().trim().optional(),
		paths: RemotePathsSchema.default({}),
	})
	.strict();

const HttpRootSchema = z
	.object({
		id: IdSchema,
		kind: z.literal("http"),
		baseUrl: z.url().refine((u) => u.startsWith("https://"), {
			error: "baseUrl must use https://",
		}),
		cache: z.object({ ttl: z.int().nonnegative() }).strict().optional(),
		paths: RemotePathsSchema.default({}),
	})
	.strict();

const AcpFsRootSchema = z
	.object({
		id: IdSchema,
		kind: z.literal("acp-fs"),
		paths: RemotePathsSchema.default({}),
	})
	.strict();

export const RootSchema = z.discriminatedUnion("kind", [
	LocalRootSchema,
	SshRootSchema,
	HttpRootSchema,
	AcpFsRootSchema,
]);

export const AutoImportSchema = z
	.object({
		source: IdSchema,
		paths: z.array(z.string().trim()).min(1),
	})
	.strict();

export const ManifestSchema = z
	.object({
		version: z.literal(1),
		mode: z.enum(["local", "overlay", "none"]).default("local"),
		roots: z.array(RootSchema).default([]),
		mergeStrategy: z.enum(["append", "override-by-name"]).default("append"),
		autoImport: z.array(AutoImportSchema).optional(),
		diagnostics: z.boolean().default(false),
	})
	.strict();

export type Manifest = z.infer<typeof ManifestSchema>;
export type Root = z.infer<typeof RootSchema>;
export type AutoImportEntry = z.infer<typeof AutoImportSchema>;

export const DEFAULT_MANIFEST: Manifest = {
	version: 1,
	mode: "local",
	roots: [],
	mergeStrategy: "append",
	diagnostics: false,
};
