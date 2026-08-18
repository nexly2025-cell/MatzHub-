import { describe, expect, it } from "vitest";
import {
  approvedSupplierGroups,
  approvedSupplierGroupNames,
  categoryForApprovedSupplierGroup,
  isApprovedSupplierGroup,
  selectAuthoritativeLiveGroups,
} from "@/lib/supplier-groups";

describe("verified supplier group registry", () => {
  it("contains exactly nine unique JID-canonical supplier groups", () => {
    expect(approvedSupplierGroupNames).toHaveLength(9);
    expect(new Set(approvedSupplierGroupNames)).toHaveLength(9);
    expect(new Set(approvedSupplierGroups.map((group) => group.jid))).toHaveLength(9);
  });

  it("accepts exactly the verified JIDs and maps their categories", () => {
    for (const group of approvedSupplierGroups) {
      expect(isApprovedSupplierGroup(group.jid), group.name).toBe(true);
      expect(categoryForApprovedSupplierGroup(group.jid), group.name).toBe(group.category);
    }
  });

  it("rejects duplicate-name twins and unrelated groups by JID", () => {
    // Observed near-empty duplicate of the live Sunglasses group.
    expect(isApprovedSupplierGroup("120363088478963131@g.us", "Smart Collections_Sunglasses")).toBe(false);
    expect(isApprovedSupplierGroup("120363420070237908@g.us", "Mfbuddy watch group 13")).toBe(false);
  });

  it("deduplicates repeated delivery of the same canonical JID", () => {
    const live = approvedSupplierGroups.find((group) => group.name === "Smart Collections_Watches")!;
    const selected = selectAuthoritativeLiveGroups([
      { jid: live.jid, subject: live.name },
      { jid: live.jid, subject: live.name },
    ]);
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0].jid).toBe(live.jid);
    expect(selected.ambiguousNames).toEqual([]);
  });

  it("drops same-name non-authoritative JID aliases rather than merging them", () => {
    const live = approvedSupplierGroups.find((group) => group.name === "Smart Collections_Watches")!;
    const selected = selectAuthoritativeLiveGroups([
      { jid: live.jid, subject: live.name },
      { jid: "120363088478963131@g.us", subject: live.name },
    ]);
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0].jid).toBe(live.jid);
    expect(selected.ambiguousNames).toEqual([]);
  });

  it("returns groups in fixed configured order and never auto-admits a new JID", () => {
    const discovered = [
      { jid: "120363420070237908@g.us", subject: "Mfbuddy watch group 13" },
      ...[...approvedSupplierGroups].reverse().map((group) => ({ jid: group.jid, subject: group.name })),
    ];
    const selected = selectAuthoritativeLiveGroups(discovered);
    expect(selected.groups.map((group) => group.jid)).toEqual(approvedSupplierGroups.map((group) => group.jid));
  });
});
