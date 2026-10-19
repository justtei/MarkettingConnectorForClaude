// Generates docs/mcp-tools.md from the tool registry: pnpm docs:tools
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { tools } from "@sandalez/core";

const LEVEL: Record<string, string> = {
  read: "Read — no change",
  own_data: "Own data — writes only the Sandalez database",
  draft: "Draft — creates PAUSED objects, no spend",
  live: "**Live — can spend; needs `confirm: true` after the user agrees**",
};

function fields(schema: z.ZodObject<any>): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as any;
  const props = json.properties ?? {};
  const req = new Set<string>(json.required ?? []);
  const keys = Object.keys(props);
  if (!keys.length) return "_none_";
  return keys
    .map((k) => {
      const p = props[k];
      const type = p.enum ? p.enum.map((e: unknown) => `\`${e}\``).join(" \| ") : p.type ?? (p.anyOf ? "mixed" : "object");
      return `\`${k}\`${req.has(k) ? "" : "?"} (${Array.isArray(type) ? type.join("/") : type})${p.description ? ` — ${p.description}` : ""}${p.default !== undefined ? ` Default: \`${JSON.stringify(p.default)}\`.` : ""}`;
    })
    .join("<br>");
}

let md = `# MCP tools\n\n_Generated from \`packages/core/src/tools/registry.ts\` by \`pnpm docs:tools\` — do not edit by hand._\n\n${tools.length} tools. Money is always PKR (major units). Every write is recorded in the activity log.\n\n`;
const groups = [...new Set(tools.map((t) => t.group))];
for (const g of groups) {
  md += `## ${g}\n\n| Tool | What it does | Inputs | Safety | Phase |\n|---|---|---|---|---|\n`;
  for (const t of tools.filter((x) => x.group === g)) {
    md += `| \`${t.name}\` | ${t.description.replace(/\|/g, "\|").replace(/\n/g, " ")} | ${fields(t.input as any)} | ${LEVEL[t.level]} | ${t.phase} |\n`;
  }
  md += "\n";
}
writeFileSync(new URL("../docs/mcp-tools.md", import.meta.url), md);
console.log(`Wrote docs/mcp-tools.md (${tools.length} tools)`);
