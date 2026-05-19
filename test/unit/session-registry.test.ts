import { describe, expect, test } from "bun:test";
import { createSessionRegistry, type NewSessionEntry } from "@pi-acp/daemon/session-registry";

function stubSession(id: string): NewSessionEntry {
	return {
		sessionId: id,
		piSession: {} as unknown as NewSessionEntry["piSession"],
		ownerConnectionId: "conn-A",
		cwd: "/tmp/foo",
		sessionFile: undefined,
	};
}

describe("SessionRegistry", () => {
	test("register + get returns the same entry", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		const got = r.get("s1");
		expect(got).toBeDefined();
		expect(got?.sessionId).toBe("s1");
		expect(got?.ownerConnectionId).toBe("conn-A");
		expect(Array.from(got?.alsoHeldBy ?? [])).toEqual([]);
	});

	test("attach by a different connection adds to alsoHeldBy", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		const attached = r.attach("s1", "conn-B");
		expect(attached).toBeDefined();
		expect(attached?.alsoHeldBy.has("conn-B")).toBe(true);
	});

	test("attach by the owner does not duplicate in alsoHeldBy", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		const attached = r.attach("s1", "conn-A");
		expect(attached?.alsoHeldBy.size).toBe(0);
	});

	test("attach unknown session returns undefined", () => {
		const r = createSessionRegistry();
		const got = r.attach("missing", "conn-B");
		expect(got).toBeUndefined();
	});

	test("release owner with no others disposes", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		const result = r.release("s1", "conn-A");
		expect(result.kind).toBe("disposed");
		expect(r.get("s1")).toBeUndefined();
	});

	test("release non-owner still-held keeps entry", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		r.attach("s1", "conn-B");
		const result = r.release("s1", "conn-B");
		expect(result.kind).toBe("still-held");
		expect(r.get("s1")).toBeDefined();
	});

	test("release owner with others transfers ownership", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		r.attach("s1", "conn-B");
		const result = r.release("s1", "conn-A");
		expect(result.kind).toBe("still-held");
		const entry = r.get("s1");
		expect(entry?.ownerConnectionId).toBe("conn-B");
	});

	test("release unknown returns unknown", () => {
		const r = createSessionRegistry();
		const result = r.release("missing", "conn-A");
		expect(result.kind).toBe("unknown");
	});

	test("listOwnedBy returns sessions owner + held", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		r.register({ ...stubSession("s2"), ownerConnectionId: "conn-C" });
		r.attach("s2", "conn-A");
		const ownedByA = r.listOwnedBy("conn-A");
		expect(ownedByA.map((e) => e.sessionId).sort()).toEqual(["s1", "s2"]);
	});

	test("listAll returns everything", () => {
		const r = createSessionRegistry();
		r.register(stubSession("s1"));
		r.register({ ...stubSession("s2"), ownerConnectionId: "conn-C" });
		expect(r.listAll().length).toBe(2);
	});
});
