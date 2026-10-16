import { relative, isAbsolute } from "node:path";

// Never emit test stdout/stderr, names, assertions, errors, stacks or attachments.
// A fixed source location identifies the failing test without dumping private data.
export default async function* report(events) {
  for await (const { type, data } of events) {
    if (type === "test:pass" || type === "test:fail") {
      let file = typeof data.file === "string" ? relative(process.cwd(), data.file).replaceAll("\\", "/") : "";
      if (isAbsolute(file) || !/^test\/[a-zA-Z0-9_./-]+\.mjs$/.test(file) || file.includes("..")) file = "test";
      const line = Number.isSafeInteger(data.line) && data.line > 0 ? `:${data.line}` : "";
      yield `${type === "test:pass" ? "PASS" : "FAIL"} ${file}${line}\n`;
    }
    if (type === "test:summary") {
      const count = name => Number.isSafeInteger(data.counts?.[name]) ? data.counts[name] : 0;
      yield `Tests: ${count("tests")}; passed: ${count("passed")}; failed: ${count("failed")}; cancelled: ${count("cancelled")}; skipped: ${count("skipped")}\n`;
    }
  }
}
