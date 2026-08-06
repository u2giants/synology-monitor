import assert from "node:assert/strict";
import test from "node:test";
import { ALL_TOOL_DEFS, searchTools, type McpToolDef } from "../src/nas-tools.js";
import { alwaysOnToolNames, isToolEnabled } from "../src/index.js";

test("NAS-008 catalog searches and ordering are deterministic", () => {
  const enabled = new Set(ALL_TOOL_DEFS.map((tool) => tool.name));
  const first = searchTools("disk storage", enabled).map((tool) => tool.name);
  const second = searchTools("disk storage", enabled).map((tool) => tool.name);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
});

test("NAS-008 visible surface stays at seven tools", () => {
  assert.deepEqual(alwaysOnToolNames(), ["list_capabilities", "get_capability_details", "tool_search", "invoke_tool", "run_command", "check_disk_space", "restart_nas_api"]);
});

test("NAS-006 disabled operations cannot pass the catalog policy gate", () => {
  const disabled = {
    ...ALL_TOOL_DEFS[0],
    name: "test_only_disabled_operation",
  } as McpToolDef;
  assert.equal(isToolEnabled(disabled), false);
});
