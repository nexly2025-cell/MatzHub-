import "server-only";
import groupMapping from "../../worker/group-mapping.json";

export type ApprovedSupplierGroup = { name: string; category: string | null; jid?: string };
export type LiveWhatsAppGroup = { jid?: string; subject?: string };

type GroupMapping = {
  jids?: Record<string, string>;
  names?: ApprovedSupplierGroup[];
};

const mapping = groupMapping as GroupMapping;
const NAME_ENTRIES = (mapping.names ?? []).map((group) => ({
  ...group,
  canonicalName: normaliseGroupName(group.name),
}));
const NAME_GROUP = new Map(NAME_ENTRIES.map((group) => [group.canonicalName, group]));

export function normaliseGroupName(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalSupplierGroupName(value: string | null | undefined) {
  return NAME_GROUP.get(normaliseGroupName(value))?.name ?? null;
}

export function configuredSupplierGroup(value: string | null | undefined) {
  return NAME_GROUP.get(normaliseGroupName(value)) ?? null;
}

/** Exactly the nine human-approved supplier sources, in configured order. */
export const approvedSupplierGroups = NAME_ENTRIES.map(({ name, category, canonicalName }) => ({ name, category, canonicalName }));
export const approvedSupplierGroupNames = approvedSupplierGroups.map((group) => group.name);

function configuredJids() {
  return (process.env.WA_GROUP_IDS ?? "")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
}

/**
 * A configured JID allow-list is the strongest boundary after the worker has
 * reported the real JIDs. Before that, exact approved names are the bootstrap
 * boundary. Bare historical JIDs without a configured canonical name are never
 * enough to authorize an unknown display name.
 */
export function isApprovedSupplierGroup(groupId?: string | null, groupName?: string | null) {
  const jids = configuredJids();
  if (jids.length) return Boolean(groupId && jids.includes(groupId));
  return Boolean(canonicalSupplierGroupName(groupName));
}

export function categoryForApprovedSupplierGroup(groupId?: string | null, groupName?: string | null) {
  if (!isApprovedSupplierGroup(groupId, groupName)) return null;
  return configuredSupplierGroup(groupName)?.category ?? null;
}

/**
 * Strict Telegram selector input. A JID is canonical: exact duplicate JIDs
 * collapse to one row. Two JIDs carrying the same approved display name are
 * deliberately withheld as ambiguous until WA_GROUP_IDS pins the intended JID;
 * this prevents accidental alias merging or ingesting a copied group.
 */
export function selectAuthoritativeLiveGroups(groups: LiveWhatsAppGroup[]) {
  const byJid = new Map<string, { jid: string; subject: string; canonicalName: string }>();
  for (const group of groups) {
    const jid = group.jid?.trim();
    const subject = group.subject?.trim() ?? "";
    const canonicalName = canonicalSupplierGroupName(subject);
    if (!jid || !canonicalName || byJid.has(jid)) continue;
    byJid.set(jid, { jid, subject, canonicalName });
  }

  const byName = new Map<string, Array<{ jid: string; subject: string; canonicalName: string }>>();
  for (const group of byJid.values()) {
    byName.set(group.canonicalName, [...(byName.get(group.canonicalName) ?? []), group]);
  }

  const allowedJids = new Set(configuredJids());
  const groupsForSelector: Array<{ jid: string; subject: string; canonicalName: string }> = [];
  const ambiguousNames: string[] = [];
  for (const configured of approvedSupplierGroups) {
    const candidates = byName.get(configured.name) ?? [];
    if (candidates.length === 1) {
      groupsForSelector.push(candidates[0]);
      continue;
    }
    if (candidates.length > 1) {
      const pinned = candidates.filter((candidate) => allowedJids.has(candidate.jid));
      if (pinned.length === 1) groupsForSelector.push(pinned[0]);
      else ambiguousNames.push(configured.name);
    }
  }

  return { groups: groupsForSelector, ambiguousNames };
}
