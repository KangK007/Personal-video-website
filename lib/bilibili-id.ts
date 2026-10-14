const BVID_PATTERN = /^BV[0-9A-Za-z]{6,32}$/;

export function isValidBvid(value: unknown): value is string {
  return typeof value === "string" && BVID_PATTERN.test(value);
}

export function extractBvidFromPathname(pathname: string) {
  const id = pathname.match(/^\/video\/([^/]+)(?:\/|$)/)?.[1];
  return isValidBvid(id) ? id : undefined;
}
