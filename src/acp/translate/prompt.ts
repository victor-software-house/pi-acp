/**
 * Convert ACP prompt ContentBlocks to a pi-compatible message string and image array.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface PiImage {
	type: "image";
	mimeType: string;
	data: string;
}

export function acpPromptToPiMessage(blocks: ContentBlock[]): {
	message: string;
	images: PiImage[];
} {
	let message = "";
	const images: PiImage[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				message += block.text;
				break;

			case "resource_link":
				message += `\n[Context] ${block.uri}`;
				break;

			case "image":
				images.push({
					type: "image",
					mimeType: block.mimeType,
					data: block.data,
				});
				break;

			case "resource": {
				const resource = block.resource;
				const uri = resource.uri;
				const mime = resource.mimeType ?? null;

				if ("text" in resource) {
					message += `\n[Embedded Context] ${uri} (${mime ?? "text/plain"})\n${resource.text}`;
				} else if ("blob" in resource) {
					const bytes = Buffer.byteLength(resource.blob, "base64");
					message += `\n[Embedded Context] ${uri} (${mime ?? "application/octet-stream"}, ${bytes} bytes)`;
				} else {
					message += `\n[Embedded Context] ${uri}`;
				}
				break;
			}

			case "audio": {
				const bytes = Buffer.byteLength(block.data, "base64");
				message += `\n[Audio] (${block.mimeType}, ${bytes} bytes) not supported`;
				break;
			}

			default:
				break;
		}
	}

	return { message, images };
}
