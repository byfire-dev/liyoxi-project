export interface PortalLivePreviewScope {
  merchantUserId: string;
  entityId: string;
  storeId: string;
}
export type PortalLivePreviewScopes = Readonly<
  Record<"owner" | "clerk" | "otherOwner", PortalLivePreviewScope>
>;
export type PortalLivePreviewAction =
  | "push-ad-version"
  | "queue-license-correction"
  | "complete-license-correction"
  | "void-license"
  | "expire-media-grants"
  | "ad-channel-unavailable"
  | "ad-channel-available";
export interface PortalLivePreviewFacts {
  playbackAuditCount: number;
  ad: { adId: string; versionNo: number };
  license: {
    verifyCode: string;
    revNo: number;
    pendingRevNo: number | null;
    displayStatus: "pending_effective" | "effective" | "voided" | "expired";
    expiredVerifyCode: string;
    unissuedVerifyCode: string;
  };
}
