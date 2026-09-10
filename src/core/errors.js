// Shared error classes (leaf module — no imports; breaks the machine/strategies cycle).
export class BuildError extends Error {
  constructor(m) { super(m); this.name = "BuildError"; }
}
