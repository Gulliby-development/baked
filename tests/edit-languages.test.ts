import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { clearEditStacks, undoEditTool } from "../src/core/tools/edit-stack.js";
import { editFileTool } from "../src/core/tools/edit-file.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { setFormatCache } from "../src/core/tools/auto-format.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), `edit-lang-test-${Date.now()}`);

async function writeTestFile(name: string, content: string): Promise<string> {
	const path = join(TMP, name);
	await writeFile(path, content, "utf-8");
	return path;
}

beforeEach(async () => {
	clearEditStacks();
	setFormatCache(null);
	await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
	await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ════════════════════════════════════════════════════════════
// Python — indentation is semantic (tabs vs spaces = broken code)
// ════════════════════════════════════════════════════════════

const PYTHON_FILE = `class DataProcessor:
    def __init__(self, config):
        self.config = config
        self.data = []
        self.cache = {}

    def process(self, raw_data):
        """Process raw data through the pipeline."""
        for item in raw_data:
            if item.get("type") == "record":
                result = self._transform(item)
                if result:
                    self.data.append(result)
                    self.cache[item["id"]] = result
            elif item.get("type") == "metadata":
                self._update_metadata(item)

    def _transform(self, item):
        """Apply transformations based on config."""
        transformed = {}
        for key, value in item.items():
            if key in self.config.get("fields", []):
                transformed[key] = self._apply_rules(value)
        return transformed if transformed else None

    def _apply_rules(self, value):
        if isinstance(value, str):
            return value.strip().lower()
        elif isinstance(value, (int, float)):
            return round(value, 2)
        return value

    def _update_metadata(self, item):
        self.config.update(item.get("meta", {}))

    def get_results(self):
        return {
            "count": len(self.data),
            "items": self.data,
            "cache_size": len(self.cache),
        }
`;

describe("Python: indentation-sensitive editing", () => {
	it("edits a method body preserving 8-space indentation", async () => {
		const path = await writeTestFile("processor.py", PYTHON_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: '        for item in raw_data:\n            if item.get("type") == "record":\n                result = self._transform(item)\n                if result:\n                    self.data.append(result)\n                    self.cache[item["id"]] = result\n            elif item.get("type") == "metadata":\n                self._update_metadata(item)',
			newString: '        validated = [i for i in raw_data if i.get("valid", True)]\n        for item in validated:\n            if item.get("type") == "record":\n                result = self._transform(item)\n                if result:\n                    self.data.append(result)\n                    self.cache[item["id"]] = result\n            elif item.get("type") == "metadata":\n                self._update_metadata(item)',
			lineStart: 9,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("validated = [i for i in raw_data");
		expect(content).toContain("        validated");
	}, 30_000);

	it("fuzzy matches tabs→spaces in Python", async () => {
		// File uses tabs, agent sends spaces
		const tabPython = PYTHON_FILE.replace(/    /g, "\t");
		const path = await writeTestFile("tabbed.py", tabPython);
		const result = await editFileTool.execute({
			path,
			// _apply_rules is at line 26, body spans 26-28
			oldString: '    def _apply_rules(self, value):\n        if isinstance(value, str):\n            return value.strip().lower()',
			newString: '    def _apply_rules(self, value):\n        if isinstance(value, str):\n            return value.strip().upper()',
			lineStart: 26,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("upper()");
		// Should preserve tabs
		expect(content).toContain("\t\t\treturn value.strip().upper()");
	}, 30_000);

	it("rejects stale edit after method insertion shifted lines", async () => {
		const path = await writeTestFile("shifted.py", PYTHON_FILE);

		// First: insert a new method before _transform (line 18), adding 3 lines
		await editFileTool.execute({
			path,
			oldString: "    def _transform(self, item):",
			newString: "    def validate(self, item):\n        return bool(item)\n\n    def _transform(self, item):",
			lineStart: 18,
		});

		// _apply_rules was at line 26, now shifted to line 29.
		// Agent tries old line 26 — should fail because content shifted
		const result = await editFileTool.execute({
			path,
			oldString: "    def _apply_rules(self, value):",
			newString: "    def _apply_rules(self, value, strict=False):",
			lineStart: 26,
		});
		// Line 26 now has "        return transformed if transformed else None" — mismatch
		expect(result.success).toBe(false);
		expect(result.output).toContain("oldString does not match");
	}, 30_000);

	it("multi_edit on Python file preserves indentation", async () => {
		const path = await writeTestFile("multi-py.py", PYTHON_FILE);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{
					oldString: "        self.config = config",
					newString: "        self.config = config\n        self.logger = logging.getLogger(__name__)",
					lineStart: 3,
				},
				{
					oldString: '            return value.strip().lower()',
					newString: '            return value.strip().lower()\n        elif isinstance(value, list):\n            return [self._apply_rules(v) for v in value]',
					lineStart: 28,
				},
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("self.logger = logging.getLogger");
		expect(content).toContain("elif isinstance(value, list):");
	}, 30_000);

	it("undo restores Python file exactly", async () => {
		const path = await writeTestFile("undo-py.py", PYTHON_FILE);
		await editFileTool.execute({
			path,
			oldString: '    def get_results(self):\n        return {\n            "count": len(self.data),\n            "items": self.data,\n            "cache_size": len(self.cache),\n        }',
			newString: '    def get_results(self, include_cache=False):\n        result = {\n            "count": len(self.data),\n            "items": self.data,\n        }\n        if include_cache:\n            result["cache"] = dict(self.cache)\n        return result',
			lineStart: 36,
		});
		const undoResult = await undoEditTool.execute({ path });
		expect(undoResult.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toBe(PYTHON_FILE);
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// TypeScript — complex types, generics, JSX
// ════════════════════════════════════════════════════════════

const TS_FILE = `import { useState, useEffect, useCallback } from "react";
import type { Config, Result } from "./types";

interface UseDataOptions<T> {
  endpoint: string;
  transform?: (raw: unknown) => T;
  pollInterval?: number;
}

export function useData<T extends Record<string, unknown>>(
  options: UseDataOptions<T>,
): { data: T | null; loading: boolean; error: Error | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(options.endpoint);
      if (!response.ok) {
        throw new Error(\`HTTP \${response.status}\`);
      }
      const raw = await response.json();
      const transformed = options.transform ? options.transform(raw) : (raw as T);
      setData(transformed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [options.endpoint, options.transform]);

  useEffect(() => {
    fetchData();
    if (options.pollInterval) {
      const timer = setInterval(fetchData, options.pollInterval);
      return () => clearInterval(timer);
    }
  }, [fetchData, options.pollInterval]);

  return { data, loading, error, refetch: fetchData };
}

export function formatResult<T>(result: Result<T>): string {
  if (result.error) {
    return \`Error: \${result.error.message}\`;
  }
  return JSON.stringify(result.data, null, 2);
}
`;

describe("TypeScript: generics and complex types", () => {
	it("edits generic function signature", async () => {
		const path = await writeTestFile("hook.tsx", TS_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: "export function useData<T extends Record<string, unknown>>(\n  options: UseDataOptions<T>,\n): { data: T | null; loading: boolean; error: Error | null; refetch: () => void } {",
			newString: "export function useData<T extends Record<string, unknown>>(\n  options: UseDataOptions<T>,\n): { data: T | null; loading: boolean; error: Error | null; refetch: () => Promise<void> } {",
			lineStart: 10,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("Promise<void>");
	});

	it("edits template literal with escaped backticks", async () => {
		const path = await writeTestFile("template.tsx", TS_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: '        throw new Error(`HTTP ${response.status}`);',
			newString: '        throw new Error(`HTTP ${response.status}: ${response.statusText}`);',
			lineStart: 22,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("statusText");
	}, 30_000);

	it("multi_edit on TypeScript preserves generics", async () => {
		const path = await writeTestFile("multi-ts.tsx", TS_FILE);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{
					oldString: "  pollInterval?: number;",
					newString: "  pollInterval?: number;\n  retryCount?: number;",
					lineStart: 7,
				},
				{
					oldString: "    } catch (err) {\n      setError(err instanceof Error ? err : new Error(String(err)));",
					newString: "    } catch (err) {\n      const wrapped = err instanceof Error ? err : new Error(String(err));\n      setError(wrapped);\n      console.error(\"[useData]\", wrapped);",
					lineStart: 28,
				},
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("retryCount?: number;");
		expect(content).toContain("[useData]");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// Rust — lifetime annotations, match arms, macros
// ════════════════════════════════════════════════════════════

const RUST_FILE = `use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Cache<'a, T: Clone + Send> {
    store: HashMap<&'a str, T>,
    max_size: usize,
    hits: u64,
    misses: u64,
}

impl<'a, T: Clone + Send> Cache<'a, T> {
    pub fn new(max_size: usize) -> Self {
        Self {
            store: HashMap::new(),
            max_size,
            hits: 0,
            misses: 0,
        }
    }

    pub fn get(&mut self, key: &'a str) -> Option<&T> {
        match self.store.get(key) {
            Some(val) => {
                self.hits += 1;
                Some(val)
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    pub fn insert(&mut self, key: &'a str, value: T) -> Result<(), &'static str> {
        if self.store.len() >= self.max_size {
            return Err("cache full");
        }
        self.store.insert(key, value);
        Ok(())
    }

    pub fn stats(&self) -> (u64, u64, f64) {
        let total = self.hits + self.misses;
        let ratio = if total > 0 {
            self.hits as f64 / total as f64
        } else {
            0.0
        };
        (self.hits, self.misses, ratio)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_get() {
        let mut cache = Cache::new(10);
        cache.insert("key1", 42).unwrap();
        assert_eq!(cache.get("key1"), Some(&42));
    }
}
`;

describe("Rust: lifetimes, generics, match arms", () => {
	it("edits match arms correctly", async () => {
		const path = await writeTestFile("cache.rs", RUST_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: '        match self.store.get(key) {\n            Some(val) => {\n                self.hits += 1;\n                Some(val)\n            }\n            None => {\n                self.misses += 1;\n                None\n            }\n        }',
			newString: '        if let Some(val) = self.store.get(key) {\n            self.hits += 1;\n            Some(val)\n        } else {\n            self.misses += 1;\n            None\n        }',
			lineStart: 23,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("if let Some(val)");
		expect(content).not.toContain("match self.store");
	}, 30_000);

	it("edits lifetime annotations without corruption", async () => {
		const path = await writeTestFile("lifetime.rs", RUST_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: "pub struct Cache<'a, T: Clone + Send> {\n    store: HashMap<&'a str, T>,",
			newString: "pub struct Cache<'a, T: Clone + Send + 'static> {\n    store: HashMap<&'a str, Arc<T>>,",
			lineStart: 5,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("+ 'static>");
		expect(content).toContain("Arc<T>>");
	});

	it("multi_edit on Rust — add method + modify test", async () => {
		const path = await writeTestFile("multi-rs.rs", RUST_FILE);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{
					oldString: "    pub fn stats(&self) -> (u64, u64, f64) {",
					newString: "    pub fn clear(&mut self) {\n        self.store.clear();\n        self.hits = 0;\n        self.misses = 0;\n    }\n\n    pub fn stats(&self) -> (u64, u64, f64) {",
					lineStart: 43,
				},
				{
					oldString: '        assert_eq!(cache.get("key1"), Some(&42));',
					newString: '        assert_eq!(cache.get("key1"), Some(&42));\n        cache.clear();\n        assert_eq!(cache.get("key1"), None);',
					lineStart: 62,
				},
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("pub fn clear");
		expect(content).toContain("cache.clear()");
	});
});

// ════════════════════════════════════════════════════════════
// Go — strict formatting, interface embedding
// ════════════════════════════════════════════════════════════

const GO_FILE = `package server

import (
\t"context"
\t"fmt"
\t"net/http"
\t"sync"
\t"time"
)

type Handler struct {
\tmu      sync.RWMutex
\troutes  map[string]http.HandlerFunc
\tmiddleware []func(http.Handler) http.Handler
}

func NewHandler() *Handler {
\treturn &Handler{
\t\troutes: make(map[string]http.HandlerFunc),
\t}
}

func (h *Handler) Handle(pattern string, fn http.HandlerFunc) {
\th.mu.Lock()
\tdefer h.mu.Unlock()
\th.routes[pattern] = fn
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
\th.mu.RLock()
\tfn, ok := h.routes[r.URL.Path]
\th.mu.RUnlock()

\tif !ok {
\t\thttp.NotFound(w, r)
\t\treturn
\t}

\tvar handler http.Handler = fn
\tfor i := len(h.middleware) - 1; i >= 0; i-- {
\t\thandler = h.middleware[i](handler)
\t}
\thandler.ServeHTTP(w, r)
}

func (h *Handler) Use(mw func(http.Handler) http.Handler) {
\th.mu.Lock()
\tdefer h.mu.Unlock()
\th.middleware = append(h.middleware, mw)
}
`;

describe("Go: tab indentation, strict formatting", () => {
	it("edits Go code with tab indentation", async () => {
		const path = await writeTestFile("handler.go", GO_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: "\tif !ok {\n\t\thttp.NotFound(w, r)\n\t\treturn\n\t}",
			newString: "\tif !ok {\n\t\tw.WriteHeader(http.StatusNotFound)\n\t\tfmt.Fprintf(w, \"route %s not found\", r.URL.Path)\n\t\treturn\n\t}",
			lineStart: 34,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("WriteHeader");
		expect(content).toContain("fmt.Fprintf");
		// Ensure tabs preserved
		expect(content).toContain("\t\tw.WriteHeader");
	}, 30_000);

	it("fuzzy matches spaces→tabs for Go", async () => {
		const path = await writeTestFile("fuzzy-go.go", GO_FILE);
		// Agent sends spaces but file uses tabs
		const result = await editFileTool.execute({
			path,
			oldString: "func NewHandler() *Handler {\n    return &Handler{\n        routes: make(map[string]http.HandlerFunc),\n    }\n}",
			newString: "func NewHandler(opts ...Option) *Handler {\n    h := &Handler{\n        routes: make(map[string]http.HandlerFunc),\n    }\n    for _, opt := range opts {\n        opt(h)\n    }\n    return h\n}",
			lineStart: 17,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("func NewHandler(opts ...Option)");
		// Should use tabs, not spaces
		expect(content).toContain("\th := &Handler{");
	});

	it("multi_edit on Go: add field + method", async () => {
		const path = await writeTestFile("multi-go.go", GO_FILE);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{
					oldString: "\tmiddleware []func(http.Handler) http.Handler",
					newString: "\tmiddleware []func(http.Handler) http.Handler\n\ttimeout    time.Duration",
					lineStart: 14,
				},
				{
					oldString: "\th.middleware = append(h.middleware, mw)\n}",
					newString: "\th.middleware = append(h.middleware, mw)\n}\n\nfunc (h *Handler) SetTimeout(d time.Duration) {\n\th.mu.Lock()\n\tdefer h.mu.Unlock()\n\th.timeout = d\n}",
					lineStart: 49,
				},
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("timeout    time.Duration");
		expect(content).toContain("func (h *Handler) SetTimeout");
	});
});

// ════════════════════════════════════════════════════════════
// YAML — indentation-sensitive like Python
// ════════════════════════════════════════════════════════════

const YAML_FILE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
  labels:
    app: api-server
    version: v2
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
        - name: api
          image: api-server:v2.1.0
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: url
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
`;

describe("YAML: indentation-sensitive editing", () => {
	it("edits nested YAML structure", async () => {
		const path = await writeTestFile("deploy.yaml", YAML_FILE);
		const result = await editFileTool.execute({
			path,
			oldString: '          resources:\n            requests:\n              memory: "256Mi"\n              cpu: "250m"\n            limits:\n              memory: "512Mi"\n              cpu: "500m"',
			newString: '          resources:\n            requests:\n              memory: "512Mi"\n              cpu: "500m"\n            limits:\n              memory: "1Gi"\n              cpu: "1000m"',
			lineStart: 30,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain('"1Gi"');
		expect(content).toContain('"1000m"');
	}, 30_000);

	it("rejects edit at wrong indentation level", async () => {
		const path = await writeTestFile("indent-mismatch.yaml", YAML_FILE);
		// Agent has wrong indentation — 4 spaces instead of 10
		const result = await editFileTool.execute({
			path,
			oldString: "    image: api-server:v2.1.0",
			newString: "    image: api-server:v3.0.0",
			lineStart: 21,
		});
		// Fuzzy match should fix the indentation
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("v3.0.0");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// Makefile — tab-only indentation (spaces = syntax error)
// ════════════════════════════════════════════════════════════

const MAKEFILE = `.PHONY: build test clean deploy

VERSION := $(shell git describe --tags --always)
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

build:
\tgo build $(LDFLAGS) -o bin/server ./cmd/server

test:
\tgo test -race -cover ./...

lint:
\tgolangci-lint run ./...

clean:
\trm -rf bin/
\trm -rf coverage/

deploy: build test
\tdocker build -t api-server:$(VERSION) .
\tdocker push api-server:$(VERSION)
\tkubectl apply -f k8s/
`;

describe("Makefile: tab-only indentation", () => {
	it("edits Makefile recipe preserving tabs", async () => {
		const path = await writeTestFile("Makefile", MAKEFILE);
		const result = await editFileTool.execute({
			path,
			oldString: "test:\n\tgo test -race -cover ./...",
			newString: "test:\n\tgo test -race -cover -count=1 -v ./...",
			lineStart: 9,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("\tgo test -race -cover -count=1 -v");
	}, 30_000);

	it("multi_edit on Makefile: add target + modify deploy", async () => {
		const path = await writeTestFile("Makefile2", MAKEFILE);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{
					oldString: "clean:\n\trm -rf bin/\n\trm -rf coverage/",
					newString: "clean:\n\trm -rf bin/\n\trm -rf coverage/\n\nfmt:\n\tgofmt -w .",
					lineStart: 15,
				},
				{
					oldString: "deploy: build test\n\tdocker build -t api-server:$(VERSION) .\n\tdocker push api-server:$(VERSION)\n\tkubectl apply -f k8s/",
					newString: "deploy: build test lint\n\tdocker build -t api-server:$(VERSION) .\n\tdocker push api-server:$(VERSION)\n\tkubectl rollout restart deployment/api-server",
					lineStart: 19,
				},
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("fmt:\n\tgofmt -w .");
		expect(content).toContain("deploy: build test lint");
		expect(content).toContain("\tkubectl rollout restart");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// correctIndentation: NEW lines beyond oldStr get indent correction
// ════════════════════════════════════════════════════════════

describe("correctIndentation: new insertion lines get corrected indentation", () => {
	it("Go: new lines in insertion use tabs when file uses tabs", async () => {
		// File uses tabs, agent sends spaces. The INSERTED lines (beyond oldStr)
		// should also get tab indentation, not just the matched lines.
		const goCode = "func main() {\n\tx := 1\n\ty := 2\n}";
		const path = await writeTestFile("indent-insert.go", goCode);
		const result = await editFileTool.execute({
			path,
			// Agent sends spaces — fuzzy match will correct indentation
			oldString: "    x := 1",
			// newString has MORE lines than oldString — the new lines should also get tabs
			newString: "    x := 1\n    z := 3\n    w := 4",
			lineStart: 2,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		// All inserted lines should use tabs, not spaces
		expect(content).toContain("\tz := 3");
		expect(content).toContain("\tw := 4");
	}, 30_000);

	it("Python: inserted lines at deeper nesting get correct spaces", async () => {
		// File uses tabs, agent sends 4-space indentation
		const pyCode = "class Foo:\n\tdef bar(self):\n\t\tx = 1\n\t\treturn x";
		const path = await writeTestFile("indent-insert.py", pyCode);
		const result = await editFileTool.execute({
			path,
			oldString: "        x = 1",
			newString: "        x = 1\n        y = 2\n        z = 3",
			lineStart: 3,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		// Inserted lines should use tabs like the file
		expect(content).toContain("\t\ty = 2");
		expect(content).toContain("\t\tz = 3");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// Complex scenario: Python class with multiple edits + undo all
// ════════════════════════════════════════════════════════════

describe("Python: multi_edit + full undo round-trip", () => {
	it("applies 3 edits and undoes entire batch", async () => {
		const path = await writeTestFile("roundtrip.py", PYTHON_FILE);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{
					oldString: "    def __init__(self, config):\n        self.config = config\n        self.data = []\n        self.cache = {}",
					newString: "    def __init__(self, config, name=\"default\"):\n        self.config = config\n        self.name = name\n        self.data = []\n        self.cache = {}",
					lineStart: 2,
				},
				{
					oldString: "    def _transform(self, item):\n        \"\"\"Apply transformations based on config.\"\"\"",
					newString: "    def _transform(self, item):\n        \"\"\"Apply transformations based on config.\n\n        Args:\n            item: Raw data item to transform.\n        \"\"\"",
					lineStart: 18,
				},
				{
					oldString: "    def get_results(self):\n        return {\n            \"count\": len(self.data),\n            \"items\": self.data,\n            \"cache_size\": len(self.cache),\n        }",
					newString: "    def get_results(self, verbose=False):\n        result = {\n            \"count\": len(self.data),\n            \"items\": self.data,\n            \"cache_size\": len(self.cache),\n        }\n        if verbose:\n            result[\"name\"] = self.name\n        return result",
					lineStart: 36,
				},
			],
		});
		expect(result.success).toBe(true);

		const edited = await Bun.file(path).text();
		expect(edited).toContain('name="default"');
		expect(edited).toContain("Args:");
		expect(edited).toContain("verbose=False");

		// Undo entire batch
		const undoResult = await undoEditTool.execute({ path });
		expect(undoResult.success).toBe(true);
		const restored = await Bun.file(path).text();
		expect(restored).toBe(PYTHON_FILE);
	}, 30_000);
});
