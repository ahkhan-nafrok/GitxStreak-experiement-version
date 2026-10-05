// lib/scopes.js
// What GITSTREAK asks GitHub for, and how it describes what it got.
//
// Two tiers, least privilege by default:
//   public  -> "read:user": the contribution calendar/streak and public
//              repos. GitHub's GraphQL docs say contributions in private
//              repos are included in contributionsCollection only with the
//              optional read:user scope (and only if the user enabled
//              "private contributions" on their profile) — so the calendar
//              does NOT need the broad `repo` scope.
//   private -> "repo read:user": adds private repo listing/tracking. `repo`
//              is read/write on every private repo; GitHub offers no
//              read-only equivalent for OAuth apps. This app only ever
//              reads, but the token itself could write — which is why it
//              is an explicit opt-in.

export const SCOPE_PUBLIC = "read:user";
export const SCOPE_PRIVATE = "repo read:user";

export function scopeFor(includePrivate) {
  return includePrivate === true ? SCOPE_PRIVATE : SCOPE_PUBLIC;
}

/** Only the two vetted scope strings may ever be requested. */
export function isAllowedScope(scope) {
  return scope === SCOPE_PUBLIC || scope === SCOPE_PRIVATE;
}

/** GitHub reports granted scopes as a comma-separated string. Returns an
 * array, or null when the value is absent (unknown — e.g. fine-grained
 * tokens, or installs from before scopes were recorded). */
export function parseScopes(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return null;
  return value.split(/[,\s]+/).filter(Boolean);
}

export function canReadPrivate(scopes) {
  return Array.isArray(scopes) && scopes.includes("repo");
}

/** One-line, honest description of the access currently granted. "" when
 * unknown (nothing to claim). */
export function describeAccess(scopes) {
  if (!Array.isArray(scopes)) return "";
  if (canReadPrivate(scopes)) {
    return "Access: public and private repos. GitHub has no read-only option for this kind of access — this app only ever reads, but the token itself could write.";
  }
  return "Access: public data only. To include private repos, disconnect and reconnect with the private-repos option ticked.";
}
