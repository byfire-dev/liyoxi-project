export interface LicenseTemplate {
  readonly title: string;
  readonly notice: string;
  readonly clauses: readonly {
    readonly key: "v1.rights" | "v1.exclusive" | "v1.offline";
    readonly title: string;
    readonly paragraphs: readonly string[];
  }[];
}

/** E8 has not supplied approved text. A deployed version must never change its text in place. */
export const LICENSE_TEMPLATE_CATALOG: Readonly<Record<string, LicenseTemplate>> = Object.freeze(
  {},
);

/** Explicit composition/test injection only; business requests cannot supply legal text. */
export type LicenseTemplateCatalog = Readonly<Record<string, LicenseTemplate>>;

/** Pure public preview projection of the same fixed formal template used by the worker. */
export function readLicenseTemplateClauses(templateVersion: string, keys: readonly string[], catalog: LicenseTemplateCatalog = LICENSE_TEMPLATE_CATALOG) {
  const template = catalog[templateVersion];
  if (!template) return [];
  const clauses = keys.map((key) => template.clauses.find((clause) => clause.key === key));
  if (clauses.some((clause) => !clause)) return [];
  return clauses.flatMap((clause) => clause
    ? [{ key: clause.key, title: clause.title, text: clause.paragraphs.join("\n") }] : []);
}
