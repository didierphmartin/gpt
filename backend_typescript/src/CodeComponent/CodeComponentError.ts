/**
 * A refused collection operation: kind (not_found, invalid, name_taken, in_use, links_dropped, start_exit, is_option,
 * not_option), its HTTP status, and details. Mirrors backend/src/CodeComponent/CodeComponentError.php.
 */
export class CodeComponentError extends Error {
  constructor(public readonly kind: string, message: string, public readonly status: number,
    public readonly data: any[] = []) {
    super(message);
  }
}
