// Recorded output shapes without a production frame. Each test has a different name/location.
export const ASSERTION_FAILURES = {
  maven: (name: string) => `[ERROR] p.${name}Test.order:42 expected: <[- removed, ~ changed, + added]> but was: <[~ changed, - removed, + added]>`,
  python: (name: string) => `FAILED tests/test_${name}.py::test_order\nE       assert ['changed', 'removed'] == ['removed', 'changed']`,
  bun: (name: string) => `tests/${name}.test.ts:\nExpected: ["removed", "changed"]\nReceived: ["changed", "removed"]\n(fail) ${name} orders results`,
  go: (name: string) => `--- FAIL: Test${name} (0.01s)\n    ${name}_test.go:42: got [changed removed], want [removed changed]`,
  rust: (name: string) => `thread '${name}' panicked at tests/${name}.rs:42:5:\nassertion \`left == right\` failed\n  left: ["changed", "removed"]\n right: ["removed", "changed"]`,
} as const;
