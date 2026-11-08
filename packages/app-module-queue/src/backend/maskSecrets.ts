const MASK = '***';

/** A first path segment kept readable: a short plain word (`services`, `hooks`, `api`). Anything else may be a token (`bot123:AAH...`). */
const PLAIN_SEGMENT = /^[A-Za-z][A-Za-z_-]{0,19}$/;

/**
 * A subscriber url as shown in the dashboard. Rule (best effort, documented in docs/subscribers.md): scheme, host and port stay; the userinfo and
 * the fragment are dropped; the path keeps its first segment when that is a short plain word and hides the rest (webhook urls carry their secret
 * in the path); query keys stay, every value is hidden. A value that is not an absolute url is hidden whole, except a bare `{{ field }}` placeholder.
 */
export function maskUrl(url: string): string {
  if (/^\{\{[^{}]*\}\}$/.test(url.trim())) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MASK;
  }
  const segments = parsed.pathname.split('/').slice(1);
  if (segments.at(-1) === '') {
    segments.pop();
  }
  let path = '/';
  if (segments.length > 0) {
    const first = segments[0]!;
    if (!PLAIN_SEGMENT.test(first)) {
      path = `/${MASK}`;
    } else {
      path = segments.length === 1 ? `/${first}` : `/${first}/${MASK}`;
    }
  }
  const query = parsed.search === '' || parsed.search === '?'
    ? ''
    : '?' + parsed.search.slice(1).split('&').map((part) => {
      const eq = part.indexOf('=');
      return eq === -1 ? MASK : `${part.slice(0, eq)}=${MASK}`;
    }).join('&');
  return `${parsed.protocol}//${parsed.host}${path}${query}`;
}

const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{8,}|sk-[A-Za-z0-9_-]{16,}|glpat-[\w-]{16,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+)/g;
const SECRET_NAME = '(?:token|secret|password|passwd|pwd|api[-_]?key|auth|credential|key)';

/**
 * A cli command as shown in the dashboard: the same text with what looks like a secret replaced by `***`. Best effort on a free-form string, not a
 * guarantee (docs/subscribers.md lists what is covered): header values after -H/--header, Bearer/Basic credentials, -u/--user, the value of an option or
 * NAME=value assignment whose name holds token/secret/password/key/auth/credential, userinfo and query values of http(s) urls, and well-known token shapes.
 */
export function maskCommand(command: string): string {
  return command
    .replace(/https?:\/\/[^\s'"]+/g, (found) => found.replace(/\/\/[^\s/@]+@/, '//').replace(/([?&][^=\s&#]+)=[^\s&#]*/g, `$1=${MASK}`))
    .replace(/(-H|--header)(\s+|=)(["'])([^:"']*):[^"']*\3/g, `$1$2$3$4: ${MASK}$3`)
    .replace(/(-H|--header)(\s+|=)([^\s"':]+):\S*/g, `$1$2$3: ${MASK}`)
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, `$1 ${MASK}`)
    .replace(/(\s(?:-u|--user|--proxy-user)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/g, `$1${MASK}`)
    .replace(new RegExp(`(--?[\\w-]*${SECRET_NAME}[\\w-]*)(=|\\s+(?!-))("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1$2${MASK}`)
    .replace(new RegExp(`\\b([A-Za-z_]\\w*${SECRET_NAME}\\w*)=("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1=${MASK}`)
    .replace(TOKEN_SHAPES, MASK);
}
