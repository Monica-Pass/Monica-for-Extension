import { describe, expect, it } from "vitest";
import { HOME_MODULES, MAX_HOME_PINS, homeStartupSource, normalizeHomePreferences } from "./home-preferences";
import { createEmptyVaultState } from "./model";
import { migrateVaultState } from "./migrations";

describe("home preferences", () => {
  it("keeps old vaults compatible and gives each default its own arrays", () => {
    const state = createEmptyVaultState();
    expect(migrateVaultState(state).settings).not.toHaveProperty("home");
    const defaults = normalizeHomePreferences();
    expect(defaults.order).toEqual(HOME_MODULES);
    expect(defaults).toMatchObject({ hidden: [], pinnedItemIds: [], suggestFrequent: true, favoritesExpanded: true });
    defaults.order.reverse();
    expect(normalizeHomePreferences().order).toEqual(HOME_MODULES);
  });

  it("normalizes imported layouts, bounds pins, and discards arbitrary fields", () => {
    const input = {
      order: ["folders", "folders", "unknown", null, "frequent"],
      hidden: ["types", "unknown", "types"],
      pinnedItemIds: [null, "", "x".repeat(257), "a", "a", ...Array.from({ length: 50 }, (_, i) => `item-${i}`)],
      title: "Must not enter preferences", password: "secret", version: 999,
      suggestFrequent: false, favoritesExpanded: false
    };
    const normalized = normalizeHomePreferences(input);
    expect(normalized.order).toEqual(["folders", "frequent", "favorites", "types", "databases", "lifecycle"]);
    expect(normalized.hidden).toEqual(["types"]);
    expect(normalized.pinnedItemIds).toHaveLength(MAX_HOME_PINS);
    expect(new Set(normalized.pinnedItemIds).size).toBe(MAX_HOME_PINS);
    expect(normalized.pinnedItemIds[0]).toBe("a");
    expect(normalized).not.toHaveProperty("password");
    expect(normalized).not.toHaveProperty("title");
    expect(normalized.version).toBe(1);
    expect(normalizeHomePreferences(normalized)).toEqual(normalized);
    const state = createEmptyVaultState();
    expect(migrateVaultState({ ...state, settings: { ...state.settings, home: input } }).settings.home).toEqual(normalized);
  });

  it("preserves an explicitly empty card deck and a fully hidden layout", () => {
    const preferences = normalizeHomePreferences({ suggestFrequent: false, pinnedItemIds: [], hidden: HOME_MODULES, favoritesExpanded: false });
    expect(preferences.hidden).toEqual(HOME_MODULES);
    expect(preferences.suggestFrequent).toBe(false);
    expect(preferences.favoritesExpanded).toBe(false);
    expect(normalizeHomePreferences(["frequent"])).toEqual(normalizeHomePreferences());
  });

  it("restores the requested startup scope and falls back only when that source is gone", () => {
    const available = ["local", "work", "personal"];
    expect(homeStartupSource(normalizeHomePreferences({ lastSourceId: "work" }), available)).toEqual({ id: "work", missing: false });
    expect(homeStartupSource(normalizeHomePreferences({ startupSource: "all", lastSourceId: "work" }), available)).toEqual({ id: "all", missing: false });
    expect(homeStartupSource(normalizeHomePreferences({ startupSource: "fixed", preferredSourceId: "personal", lastSourceId: "work" }), available)).toEqual({ id: "personal", missing: false });
    expect(homeStartupSource(normalizeHomePreferences({ startupSource: "fixed", preferredSourceId: "removed" }), available)).toEqual({ id: "all", missing: true });
  });

  it("migrates older preferences and bounds imported source identifiers", () => {
    const migrated = normalizeHomePreferences({ density: "unknown", startupSource: "unknown", lastSourceId: { password: "secret" }, preferredSourceId: "x".repeat(257) });
    expect(migrated).toMatchObject({ density: "compact", startupSource: "last", lastSourceId: "all", preferredSourceId: "local" });
    expect(normalizeHomePreferences({ density: "comfortable", startupSource: "fixed", preferredSourceId: "personal" })).toMatchObject({ density: "comfortable", startupSource: "fixed", preferredSourceId: "personal" });
  });

  it("keeps module expansion separate from visibility and the legacy favorites preference", () => {
    expect(normalizeHomePreferences({ favoritesExpanded: false }).collapsedModules).toEqual(["databases"]);
    const preferences = normalizeHomePreferences({ collapsedModules: ["folders", "folders", "unknown", "favorites", "lifecycle"], hidden: ["types"], favoritesExpanded: false });
    expect(preferences.collapsedModules).toEqual(["folders"]);
    expect(preferences.hidden).toEqual(["types"]);
    expect(preferences.favoritesExpanded).toBe(false);
    expect(normalizeHomePreferences({ collapsedModules: [] }).collapsedModules).toEqual([]);
    preferences.collapsedModules.push("frequent");
    expect(normalizeHomePreferences().collapsedModules).toEqual(["databases"]);
  });
});
