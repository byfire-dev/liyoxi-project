import type { operations } from "@liyoxi/contract/types/merchant";
import type { Body, Data } from "@/lib/account-api";

// Nullable named Playable is emitted as an impossible Record<string, never> intersection.
// Keep the actual standalone operation's DTO, as the existing sample adapter does.
export type Ad = Omit<Data<"m.ad.get">, "playable"> & { playable: Data<"m.playable.get"> | null };
export type AdPage = Data<"m.ad.list">;
export type AdQuote = Data<"m.ad.quote">;
export type AdTab = NonNullable<NonNullable<operations["m.ad.list"]["parameters"]["query"]>["tab"]>;
export type AdKind = Body<"m.ad.create">["type"];
