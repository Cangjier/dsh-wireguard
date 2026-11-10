/** SSH access helpers for WireGuard peers. */

/** Linux usernames accepted by the panel. */
export const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

/**
 * Build the command the operator pastes on the client. It adds the server's
 * public key to the chosen user's authorized_keys. The server private key is
 * never part of this command.
 * @param {string} user target Linux username.
 * @param {string} publicKey SSH public key generated on the server.
 * @returns {string} one-line shell command.
 */
export function buildSshAuthorizeCommand(user: string, publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const key = parts.slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) {
    throw new Error('Unexpected SSH public key format.');
  }
  return `u='${user}'; h=$(awk -F: -v u="$u" '$1==u{print $6; exit}' /etc/passwd); [ -n "$h" ] || { echo "No such user: $u" >&2; exit 1; }; S=""; [ "$(id -u)" -ne 0 ] && S="sudo"; $S sh -c 'mkdir -p "$1/.ssh" && chmod 700 "$1/.ssh" && touch "$1/.ssh/authorized_keys" && { grep -qxF "$2" "$1/.ssh/authorized_keys" || printf "%s\\n" "$2" >> "$1/.ssh/authorized_keys"; } && chown -R "$3" "$1/.ssh" && chmod 600 "$1/.ssh/authorized_keys"' sh "$h" '${key}' '${user}' && echo "SSH key installed for $u"`;
}
