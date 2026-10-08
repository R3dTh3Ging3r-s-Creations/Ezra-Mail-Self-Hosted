import { readFile } from "node:fs/promises";
import { constants } from "node:os";

interface VitestAssertionResult {
  fullName?: unknown;
  status?: unknown;
}

interface VitestFileResult {
  assertionResults?: unknown;
}

interface VitestJsonReport {
  numPassedTests?: unknown;
  numPendingTests?: unknown;
  numFailedTests?: unknown;
  testResults?: unknown;
}

function requiredCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Public test report has an invalid ${label}.`);
  }
  return Number(value);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function assertPublicTestAccounting(
  value: unknown,
  expectedPassedTests: number,
  permittedSkippedTests: readonly string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Public test report is not an object.");
  }
  const report = value as VitestJsonReport;
  const passedCount = requiredCount(report.numPassedTests, "passed-test count");
  const pendingCount = requiredCount(report.numPendingTests, "pending-test count");
  const failedCount = requiredCount(report.numFailedTests, "failed-test count");
  if (!Array.isArray(report.testResults)) throw new Error("Public test report has no file results.");

  const assertions: VitestAssertionResult[] = [];
  for (const file of report.testResults as VitestFileResult[]) {
    if (!file || typeof file !== "object" || !Array.isArray(file.assertionResults)) {
      throw new Error("Public test report has an invalid file result.");
    }
    assertions.push(...file.assertionResults as VitestAssertionResult[]);
  }
  if (assertions.some((assertion) => typeof assertion.fullName !== "string" || typeof assertion.status !== "string")) {
    throw new Error("Public test report has an invalid assertion result.");
  }
  const passed = assertions.filter((assertion) => assertion.status === "passed");
  const skipped = assertions.filter((assertion) => assertion.status === "skipped");
  if (assertions.length !== passed.length + skipped.length || failedCount !== 0) {
    throw new Error("Public test report contains a failed or unsupported test status.");
  }
  if (passedCount !== expectedPassedTests || passed.length !== expectedPassedTests) {
    throw new Error(`Public test passed count did not match: required ${expectedPassedTests}; received ${passedCount} reported and ${passed.length} collected.`);
  }
  if (pendingCount !== skipped.length || pendingCount !== permittedSkippedTests.length) {
    throw new Error("Public test skip count did not match the permitted set.");
  }
  const actualSkippedTests = sorted(skipped.map((assertion) => assertion.fullName as string));
  const expectedSkippedTests = sorted(permittedSkippedTests);
  if (actualSkippedTests.length !== expectedSkippedTests.length
    || actualSkippedTests.some((name, index) => name !== expectedSkippedTests[index])) {
    throw new Error(`Public test skip identities did not match the permitted set. Expected ${JSON.stringify(expectedSkippedTests)}; received ${JSON.stringify(actualSkippedTests)}.`);
  }
}

/** Preserve runner failure evidence without printing process output, arguments or paths. */
export async function readPublicTestFailureReport(reportPath: string, processError: unknown): Promise<unknown> {
  const failure = processError && typeof processError === "object"
    ? processError as Record<string, unknown> : {};
  const code = Number.isSafeInteger(failure.code) ? String(failure.code)
    : failure.code === null ? "none"
    : typeof failure.code === "string" && (Object.hasOwn(constants.errno, failure.code)
      || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") ? failure.code : "unknown";
  const killed = typeof failure.killed === "boolean" ? String(failure.killed) : "unknown";
  const signal = failure.signal === null ? "none"
    : typeof failure.signal === "string" && Object.hasOwn(constants.signals, failure.signal) ? failure.signal : "unknown";
  const diagnostic = `code=${code}; killed=${killed}; signal=${signal}`;
  let contents: string;
  try { contents = await readFile(reportPath, "utf8"); }
  catch { throw new Error(`Fresh public export unit suite failed: report unavailable; ${diagnostic}.`); }
  try { return JSON.parse(contents); }
  catch { throw new Error(`Fresh public export unit suite failed: report malformed; ${diagnostic}.`); }
}
