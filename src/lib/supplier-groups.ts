import "server-only";
import groupMapping from "../../worker/group-mapping.json";

export type ApprovedSupplierGroup = { jid: string; name: string; category: string };
export type LiveWhatsAppGroup = { jid?: string; subject?: string };

type GroupMapping = {
  jids?: Record<string, string>;
  names?: ApprovedSupplierGroup[];
};

const mapping = groupMapping as GroupMapping;
const GROUPS = (mapping.names ?? []).map((group) => ({
  ...group,
  canonicalName: normaliseGroupName(group.name),
}));
const GROUP_BY_JID = new Map(GROUPS.map((group) => [group.jid, group]));
const GROUP_BY_NAME = new Map(GROUPS.map((group) => [group.canonicalName, group]));

export function normaliseGroupName(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalSupplierGroupName(value: string | null | undefined) {
  return GROUP_BY_JID.get(value ?? "")?.name ?? GROUP_BY_NAME.get(normaliseGroupName(value))?.name ?? null;
}

export function configuredSupplierGroup(value: string | null | undefined) {
  return GROUP_BY_JID.get(value ?? "") ?? GROUP_BY_NAME.get(normaliseGroupName(value)) ?? null;
}

/** Exactly nine JID-canonical, human-approved supplier sources. */
export const approvedSupplierGroups = GROUPS.map(({ jid, name, category, canonicalName }) => ({ jid, name, category, canonicalName }));
export const approvedSupplierGroupNames = approvedSupplierGroups.map((group) => group.name);

function configuredJids() {
  return (process.env.WA_GROUP_IDS ?? "")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
}

/** A source is accepted only if its stable JID is one of the nine approved JIDs. */
export function isApprovedSupplierGroup(groupId?: string | null, _groupName?: string | null) {
  if (!groupId || !GROUP_BY_JID.has(groupId)) return false;
  const override = configuredJids();
  return !override.length || override.includes(groupId);
}

export function categoryForApprovedSupplierGroup(groupId?: string | null, _groupName?: string | null) {
  if (!isApprovedSupplierGroup(groupId)) return null;
  return GROUP_BY_JID.get(groupId ?? "")?.category ?? null;
}

/**
 * Closed Telegram selector input: one row per known JID in configured order.
 * Unknown JIDs and duplicate-name twins are rejected before any UI is built.
 */
export function selectAuthoritativeLiveGroups(groups: LiveWhatsAppGroup[]) {
  const discovered = new Map<string, LiveWhatsAppGroup>();
  for (const group of groups) {
    const jid = group.jid?.trim();
    if (jid && GROUP_BY_JID.has(jid) && !discovered.has(jid)) discovered.set(jid, group);
  }
  return {
    groups: approvedSupplierGroups.flatMap((configured) => {
      const live = discovered.get(configured.jid);
      return live ? [{ jid: configured.jid, subject: live.subject?.trim() || configured.name, canonicalName: configured.name }] : [];
    }),
    ambiguousNames: [],
  };
}
