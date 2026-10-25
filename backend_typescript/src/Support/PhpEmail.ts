/**
 * An approximation of PHP filter_var($email, FILTER_VALIDATE_EMAIL) for the common cases: a
 * dot-atom local part (no leading/trailing/double dots, at most 64 chars) and a domain of
 * hostname labels with at least one dot. Quoted local parts and IP-literal domains, which PHP
 * accepts, are refused here (the forms collecting these addresses never send them).
 */
export function phpValidEmail(email: string): boolean {
  if (email.length > 320) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
}

/** PHP trim() with its default character mask (" \t\n\r\0\x0B"). */
export function phpTrim(v: unknown): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  return s.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '');
}
