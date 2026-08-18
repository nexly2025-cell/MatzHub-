import "server-only";
import groupMapping from "../../worker/group-mapping.json";

export type ApprovedSupplierGroup = { name: string; category: string | null };

type GroupMapping = {
  jids?: Record<string, string>;
  names?: ApprovedSupplierGroup[];
};

const mapping = groupMapping as GroupMapping;
const JID_CATEGORY = mapping.jids ?? {};
const NAME_CATEGORY = new Map(
  (mapping.names ?? []).map((group) => [normaliseGroupName(group.name), group.category]),
);

export function normaliseGroupName(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Environment JIDs take precedence when configured. Until the authoritative
 * JIDs are copied from the worker, the verified supplier group-name registry
 * is the fallback boundary. Both are exact normalized matches, never broad
 * keyword searches.
 */
export function isApprovedSupplierGroup(groupId?: string | null, groupName?: string | null) {
  const configuredIds = (process.env.WA_GROUP_IDS ?? "")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
  if (configuredIds.length) return Boolean(groupId && configuredIds.includes(groupId));
  if (groupId && Object.hasOwn(JID_CATEGORY, groupId)) return true;
  return NAME_CATEGORY.has(normaliseGroupName(groupName));
}

export function categoryForApprovedSupplierGroup(groupId?: string | null, groupName?: string | null) {
  if (groupId && Object.hasOwn(JID_CATEGORY, groupId)) return JID_CATEGORY[groupId] ?? null;
  return NAME_CATEGORY.get(normaliseGroupName(groupName)) ?? null;
}

export const approvedSupplierGroupNames = (mapping.names ?? []).map((group) => group.name);
