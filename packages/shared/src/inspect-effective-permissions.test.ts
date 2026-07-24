import { describe, expect, it } from "vitest";
import { ALL_TOOL_DEFS } from "./nas-tools";

function build(username: string, exactPath = "/volume1/files/customer"): string {
  const def = ALL_TOOL_DEFS.find((tool) => tool.name === "inspect_effective_permissions");
  if (!def?.buildCommand) throw new Error("inspect_effective_permissions is missing");
  return def.buildCommand({ filter: username, exact_path: exactPath } as never);
}

describe("inspect_effective_permissions", () => {
  it("resolves DSM domain users through winbind instead of container NSS", () => {
    const command = build("IML\\mzabo");

    expect(command).toContain('"$wbinfo" --user-info "$username"');
    expect(command).toContain('"$wbinfo" --user-groups "$username"');
    expect(command).not.toContain("id 'IML\\mzabo'");
    expect(command).toContain("this does not mean the DSM account is missing");
  });

  it("impersonates numeric credentials for ACL permission checks", () => {
    const command = build("IML\\mzabo");

    expect(command).toContain('setpriv --reuid "$uid" --regid "$gid" --groups "$group_csv"');
    expect(command).toContain('synoacltool -check "$check_path" "$perm"');
    expect(command).toContain("Delete target itself");
    expect(command).toContain("Delete children from parent");
    expect(command).toContain("Create folders in parent");
  });

  it("keeps a host account-file fallback for local DSM users", () => {
    const command = build("local-user");

    expect(command).toContain("/host/etc/pass??");
    expect(command).toContain("/host/etc/group");
  });
});
