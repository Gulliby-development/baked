/** Host-edit data shared with the desktop renderer, without runtime dependencies. */
export interface HostEdit {
  task: string | null;
  field: string;
  kind: string;
  before: unknown;
  after: unknown;
  text: string;
}
