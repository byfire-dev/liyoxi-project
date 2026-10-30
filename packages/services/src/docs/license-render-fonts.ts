import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Font } from "@react-pdf/renderer";
import { hyphenationCallback } from "./license-render-text.js";

export const BODY_FAMILY = "LyxSerifSC";
export const HEADING_FAMILY = "LyxSansSC";
const fonts = [
  {
    file: "NotoSerifSC-Regular.ttf",
    family: BODY_FAMILY,
    fontWeight: 400,
    hash: "c358a69de3df5f423a8946a7b03e3126fb6ba116f1130a463455b4e39e1f0742",
  },
  {
    file: "NotoSerifSC-Bold.ttf",
    family: BODY_FAMILY,
    fontWeight: 700,
    hash: "9c6a2ba736e4b499c84f65ce366bd3625c0401885fd3e585ace50fb738b96ff6",
  },
  {
    file: "NotoSansSC-Bold.ttf",
    family: HEADING_FAMILY,
    fontWeight: 700,
    hash: "9a38ae0ab28cd5a256f9ea8e00dedc688aac17f7915fcb000572990afa956b96",
  },
] as const;
interface GlyphFont {
  hasGlyphForCodePoint(point: number): boolean;
}
let registered: Promise<readonly GlyphFont[]> | undefined;

/** Validate each instance's files; global renderer registration is bound to immutable font hashes. */
export async function loadLicenseFonts(directory: string): Promise<readonly GlyphFont[]> {
  const buffers = await Promise.all(
    fonts.map(async (font) => {
      const bytes = await readFile(join(directory, font.file));
      if (createHash("sha256").update(bytes).digest("hex") !== font.hash)
        throw new Error("授权书字体版本不匹配");
      return bytes;
    }),
  );
  registered ??= (async () => {
    fonts.forEach((font, index) =>
      Font.register({
        family: font.family,
        fontWeight: font.fontWeight,
        // Read exactly the validated bytes, not a second mutable path lookup.
        src: `data:font/ttf;base64,${buffers[index]!.toString("base64")}`,
      }),
    );
    Font.registerHyphenationCallback(hyphenationCallback);
    await Promise.all(
      fonts.map((font) => Font.load({ fontFamily: font.family, fontWeight: font.fontWeight })),
    );
    return fonts.map((font) => {
      const data: unknown = Font.getFont({
        fontFamily: font.family,
        fontWeight: font.fontWeight,
      }).data;
      if (
        !data ||
        typeof data !== "object" ||
        !("hasGlyphForCodePoint" in data) ||
        typeof data.hasGlyphForCodePoint !== "function"
      )
        throw new Error("授权书字体不可用");
      const query = data.hasGlyphForCodePoint;
      return {
        hasGlyphForCodePoint: (point: number) => Reflect.apply(query, data, [point]) === true,
      };
    });
  })();
  return registered;
}
