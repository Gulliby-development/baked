/** Audited acceptance row data shared with the desktop renderer, without runtime dependencies. */
export interface AcceptanceRow {
  id: string;
  criterionId: string;
  source: string;
  /** The table's Scenario (Case, Name, Description, Label) cell, when it has one. */
  label?: string;
  input: unknown;
  expected: unknown;
}
