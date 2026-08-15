import type { CachedMetadata, TFile } from "obsidian";

export type KnowledgeIdentity =
  | "personal_knowledge"
  | "user_curated"
  | "external_material"
  | "unknown";

export type EpistemicStatus =
  | "confirmed_by_user"
  | "user_curated_not_mastered"
  | "source_material"
  | "unverified";

export interface KnowledgeIdentityRecord {
  identity: KnowledgeIdentity;
  epistemicStatus: EpistemicStatus;
  reason: string;
}

function normalizedValue(value: unknown) {
  const primitive =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : "";
  return primitive
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function classifyKnowledgeIdentity(
  file: Pick<TFile, "path">,
  cache: CachedMetadata | null,
): KnowledgeIdentityRecord {
  const frontmatter = cache?.frontmatter || {};
  const declared = normalizedValue(
    frontmatter.arc_type ||
      frontmatter.knowledge_identity ||
      frontmatter.content_identity ||
      frontmatter.origin_type,
  );
  const sourceUrl = String(
    frontmatter.source_url || frontmatter.canonical_url || frontmatter.url || "",
  ).trim();
  const imported = normalizedValue(
    frontmatter.imported || frontmatter.origin || frontmatter.source_type,
  );
  if (
    declared === "external_material" ||
    declared === "external" ||
    sourceUrl ||
    /(?:import|wechat|公众号|web_clipper|xiaohongshu)/i.test(imported)
  ) {
    return {
      identity: "external_material",
      epistemicStatus: "source_material",
      reason: sourceUrl
        ? "Frontmatter contains an external source URL."
        : "Frontmatter explicitly marks imported or external material.",
    };
  }
  if (
    declared === "personal_knowledge" ||
    declared === "personal" ||
    normalizedValue(frontmatter.knowledge_status) === "confirmed"
  ) {
    return {
      identity: "personal_knowledge",
      epistemicStatus: "confirmed_by_user",
      reason: "Frontmatter explicitly marks personal or confirmed knowledge.",
    };
  }
  if (
    declared === "user_artifact" ||
    declared === "user_curated" ||
    declared === "curated"
  ) {
    return {
      identity: "user_curated",
      epistemicStatus: "user_curated_not_mastered",
      reason: "Frontmatter marks user-curated content without claiming mastery.",
    };
  }
  return {
    identity: "unknown",
    epistemicStatus: "unverified",
    reason: `No explicit knowledge identity is declared for ${file.path}.`,
  };
}
