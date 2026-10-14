import { describe, expect, it, vi } from "vitest";
import { createJobHandlerRegistry } from "./job-handler-registry";

describe("job handler registry", () => {
  it("creates a frozen registry from explicit registrations", () => {
    const handler = vi.fn();
    const registry = createJobHandlerRegistry([{ type: "catalog.sync", handler }]);

    expect(Object.getPrototypeOf(registry)).toBeNull();
    expect(registry["catalog.sync"]).toBe(handler);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("rejects an empty registry so a worker cannot be started accidentally without handlers", () => {
    expect(() => createJobHandlerRegistry([])).toThrow(
      "At least one job handler must be registered."
    );
  });

  it("rejects blank or non-canonical handler types", () => {
    const handler = vi.fn();

    for (const type of ["", " ", " catalog.sync", "catalog.sync "]) {
      expect(() => createJobHandlerRegistry([{ type, handler }])).toThrow(
        "Job handler type must be a non-empty canonical string."
      );
    }
  });

  it("rejects duplicate job types rather than silently overwriting a handler", () => {
    expect(() => createJobHandlerRegistry([
      { type: "catalog.sync", handler: vi.fn() },
      { type: "catalog.sync", handler: vi.fn() }
    ])).toThrow('Job handler type "catalog.sync" is already registered.');
  });

  it("rejects values that are not callable handlers", () => {
    expect(() => createJobHandlerRegistry([
      { type: "catalog.sync", handler: null as never }
    ])).toThrow('Job handler for "catalog.sync" must be a function.');
  });

  it("supports names that exist on Object.prototype without inheriting those properties", () => {
    const handler = vi.fn();
    const registry = createJobHandlerRegistry([{ type: "toString", handler }]);

    expect(Object.hasOwn(registry, "toString")).toBe(true);
    expect(registry.toString).toBe(handler);
    expect(Object.hasOwn(registry, "constructor")).toBe(false);
  });
});
