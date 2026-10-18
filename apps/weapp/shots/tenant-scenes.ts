export const TENANT_SCENES = [
  { name: "tenant-stores-owner", route: "sub/profile/stores/index" },
  { name: "tenant-store-add", route: "sub/profile/store-add/index" },
  { name: "tenant-staff-profile", route: "sub/profile/staff-profile/index" },
  { name: "tenant-members-owner", route: "sub/member/members/index" },
  { name: "tenant-invite-owner", route: "sub/member/invite/index" },
  { name: "tenant-join-pending", route: `sub/member/join/index?token=${"A".repeat(43)}` },
  { name: "tenant-stores-clerk", route: "sub/profile/stores/index" },
  { name: "tenant-join-expired", route: `sub/member/join/index?token=${"A".repeat(43)}` },
];
