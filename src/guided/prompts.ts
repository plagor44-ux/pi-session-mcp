import { CATALOG_ID_PATTERN, type PricedModelCatalog } from "../model-catalog.js";
import { isAbsolute } from "node:path";
import { ALIAS_PATTERN } from "../execution-profile.js";
import { FAMILY_PATTERN, ROLES, TIERS } from "../routing/config.js";
import { parseGuidedAnswers, type GuidedAnswers } from "./answers.js";
import { proposeProfiles } from "./propose.js";

export interface Prompter {
  text(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: readonly T[], fallback: T): Promise<T>;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function collectGuidedAnswers(prompter: Prompter, catalog: PricedModelCatalog, existing: { config?: unknown; clients?: { claudeCode: boolean; codex: boolean } }): Promise<GuidedAnswers> {
  const validatedText = async (question: string, valid: (value: string) => boolean, fallback?: string): Promise<string> => {
    for (;;) {
      const value = await prompter.text(question, fallback);
      if (valid(value)) return value;
    }
  };
  const profiles: GuidedAnswers["profiles"] = [];
  const config = record(existing.config);
  const oldProfiles = record(config.executionProfiles);
  for (const proposal of proposeProfiles(catalog)) {
    if (!CATALOG_ID_PATTERN.test(proposal.provider) || !CATALOG_ID_PATTERN.test(proposal.model)) continue;
    const action = await prompter.choose(`Use ${proposal.alias}: provider ${proposal.provider}, model ${proposal.model}, tier ${proposal.tier}, role ${proposal.role}, family ${proposal.family}, thinking level ${proposal.thinkingLevel}?`, ["accept", "change", "skip"] as const, "accept");
    if (action === "skip") continue;
    if (action === "accept") { profiles.push(proposal); continue; }
    const tier = await prompter.choose(`Tier for ${proposal.alias}`, TIERS, proposal.tier);
    const role = await prompter.choose(`Role for ${proposal.alias}`, ROLES, proposal.role);
    profiles.push({ ...proposal, tier, role,
      model: await prompter.text(`Model for ${proposal.alias}`, proposal.model),
      family: await validatedText(`Family for ${proposal.alias}`, (value) => FAMILY_PATTERN.test(value), proposal.family),
      thinkingLevel: await prompter.choose(`Thinking level for ${proposal.alias}`, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, proposal.thinkingLevel),
    });
  }
  for (const tier of TIERS) {
    const reviews = profiles.filter((p) => p.tier === tier && p.role === "review");
    const families = new Set(reviews.map((p) => p.family));
    if (reviews.length && families.size < 2) await prompter.confirm(`${tier} has fewer than two families; review may need the same-family override. Continue?`, true).then((ok) => { if (!ok) throw Object.assign(new Error("interview_declined"), { code: "interview_declined" }); });
  }
  const defaults = [...new Set([...Object.entries(oldProfiles).filter(([, p]) => record(p).permissionProfile === "read-only").map(([alias]) => alias), ...profiles.filter((p) => p.role !== "code").map((p) => p.alias)])];
  if (!defaults.length) {
    const code = catalog.providers().some((provider) => provider.authConfigured) ? "no_read_only_profile" : "provider_login_required";
    throw Object.assign(new Error(code), { code });
  }
  const oldDefault = Object.entries(oldProfiles).find(([, p]) => record(p).default === true)?.[0];
  const defaultProfile = await prompter.choose("Default read-only profile", defaults, oldDefault ?? defaults[0]!);
  const workspaces: GuidedAnswers["workspaces"] = [];
  while (await prompter.confirm("Add a repository workspace?", false)) {
    const alias = await validatedText("Workspace alias", (value) => ALIAS_PATTERN.test(value));
    const path = await validatedText("Absolute repository path (kept in configuration only)", isAbsolute);
    const mode = await prompter.choose("Workspace mode", ["read-only", "host", "container"] as const, "read-only");
    const acceptHostWrites = mode === "host" ? await prompter.confirm("Do you, the owner, accept host writes?", false) : false;
    const parseProfiles = (value: string): string[] => value.split(",").map((alias) => alias.trim()).filter(Boolean);
    const container = mode === "container" ? { profiles: parseProfiles(await validatedText("Container profile aliases, comma-separated", (value) => parseProfiles(value).length > 0, profiles.filter((p) => p.role === "code").map((p) => p.alias).join(","))) } : undefined;
    workspaces.push({ alias, path, mode, ...(mode === "host" ? { acceptHostWrites } : {}), ...(container ? { container } : {}) });
  }
  const enabled = await prompter.confirm("Enable history? It stores redacted session content locally.", record(config.history).enabled === true);
  const mode = await prompter.choose("Routing mode (auto requires history)", enabled ? ["off", "manual", "auto"] as const : ["off", "manual"] as const, "off");
  const claudeCode = await prompter.confirm("Register Claude Code (if installed), including the wake hook?", existing.clients?.claudeCode ?? false);
  const codex = await prompter.confirm("Register Codex (if installed)?", existing.clients?.codex ?? false);
  const newProfiles = profiles.filter((p) => !Object.hasOwn(oldProfiles, p.alias));
  const approveProbes = newProfiles.length === 0 || await prompter.confirm(`Approve ${newProfiles.length} provider turns: one fixed PONG probe per new profile on apply?`, false);
  const allowConfigChange = existing.config === undefined ? false : await prompter.confirm("Allow adding the confirmed profiles and blocks to the existing configuration? Existing profiles are never replaced.", false);
  return parseGuidedAnswers({ schemaVersion: 1, approveProbes, allowConfigChange, profiles, defaultProfile, workspaces, history: { enabled }, routing: { mode }, clients: { claudeCode, codex } });
}
