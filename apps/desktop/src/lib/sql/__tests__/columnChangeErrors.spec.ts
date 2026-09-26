import { describe, expect, it } from "vitest";
import { isColumnChangeError, isProjectionRetryableError, isSelectStarRejectedError } from "@/lib/sql/columnChangeErrors";

function error(message: string): Error {
  return new Error(message);
}

describe("column change error classification", () => {
  it("recognizes a dropped column across engines", () => {
    expect(isColumnChangeError(error('ORA-00904: "OLD_COL": invalid identifier'), { databaseType: "oracle" })).toBe(true);
    expect(isColumnChangeError(error("Unknown column 'old_col' in 'field list'"), { databaseType: "mysql" })).toBe(true);
    expect(isColumnChangeError(error('column "old_col" does not exist'), { databaseType: "postgres" })).toBe(true);
    expect(isColumnChangeError(error("Invalid column name 'old_col'."), { databaseType: "sqlserver" })).toBe(true);
    expect(isColumnChangeError(error("no such column: old_col"), { databaseType: "sqlite" })).toBe(true);
    expect(isColumnChangeError(error("无效的列名[OLD_COL]"), { databaseType: "dameng" })).toBe(true);
    expect(isColumnChangeError(error("列[OLD_COL]不存在"), { databaseType: "dameng" })).toBe(true);
  });

  it("recognizes PostgreSQL SQLSTATE 42703 without the phrase form", () => {
    expect(isColumnChangeError(error("ERROR: undefined_column (SQLSTATE 42703)"), { databaseType: "postgres" })).toBe(true);
    // 同一段文本在非 PG 连接上不作为判据（避免数字误判）
    expect(isColumnChangeError(error("ERROR: undefined_column (SQLSTATE 42703)"), { databaseType: "oracle" })).toBe(false);
  });

  it("keeps genuine failures out of the retryable set", () => {
    expect(isColumnChangeError(error("Connection reset by peer"), { databaseType: "oracle" })).toBe(false);
    expect(isColumnChangeError(error("ORA-00942: table or view does not exist"), { databaseType: "oracle" })).toBe(false);
    expect(isColumnChangeError(error("Query timeout after 30s"), { databaseType: "postgres" })).toBe(false);
    expect(isColumnChangeError(error("canceling statement due to user request"), { databaseType: "postgres" })).toBe(false);
    expect(isColumnChangeError(undefined)).toBe(false);
  });

  it("treats a rejected SELECT * as retryable but not as a column change", () => {
    const denied = error("ORA-01031: insufficient privileges");
    expect(isSelectStarRejectedError(denied)).toBe(true);
    expect(isColumnChangeError(denied, { databaseType: "oracle" })).toBe(false);
    expect(isProjectionRetryableError(denied, { databaseType: "oracle" })).toBe(true);
    expect(isProjectionRetryableError(error("SELECT command denied to user 'dbx'"), { databaseType: "mysql" })).toBe(true);
    expect(isProjectionRetryableError(error("permission denied for table users"), { databaseType: "postgres" })).toBe(true);
    expect(isProjectionRetryableError(error("权限不足"), { databaseType: "xugu" })).toBe(true);
  });

  it("reads structured backend errors as well as plain messages", () => {
    const structured = {
      backendError: {
        version: 1,
        code: "DBX-DB-0001",
        messageKey: "backendErrors.queryFailed",
        messageParams: {},
        source: "query",
        operationOutcome: "unknown",
        detail: 'ORA-00904: "OLD_COL": invalid identifier',
      },
    };
    expect(isColumnChangeError(structured, { databaseType: "oracle" })).toBe(true);
  });

  it("ignores agent metadata appended after the database message", () => {
    const withAgentNoise = error('Unknown column \'old_col\' in \'field list\'\nDBX_AGENT_ERROR_DATA: {"subsystem":"agent","adapter":"mysql","driver":"mysql-go"}');
    expect(isColumnChangeError(withAgentNoise, { databaseType: "mysql" })).toBe(true);
  });
});
