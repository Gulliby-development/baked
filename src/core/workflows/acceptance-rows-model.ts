/** Audited acceptance row data shared with the desktop renderer, without runtime dependencies. */
export interface AcceptanceRow {
  id: string;
  criterionId: string;
  source: string;
  input: unknown;
  expected: unknown;
}
