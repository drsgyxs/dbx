import type { DatabaseType } from "@/types/database";
import { normalizeBackendError, sanitizeBackendErrorMessage } from "@/lib/backend/errorUtils";

/**
 * Context for classifying a failed statement. Engines report the same condition
 * through different codes, so the database type narrows the engine-specific
 * patterns; the shared text patterns cover the rest.
 */
export interface ProjectionErrorContext {
  databaseType?: DatabaseType;
  driverProfile?: string;
}

// "列不存在 / 无效标识符" 的引擎专属写法。通用文本判据已覆盖多数引擎，这里只为
// 报错文本不含通用短语的引擎补码，避免用裸数字（如 `1054`）带来的误判。
const DATABASE_COLUMN_CHANGE_PATTERNS: Partial<Record<DatabaseType, readonly RegExp[]>> = {
  oracle: [/\bORA-00904\b/i],
  "oceanbase-oracle": [/\bORA-00904\b/i],
  dameng: [/无效的列名/, /列名无效/, /无效列名/],
  gbase: [/无效的列名/, /列名无效/, /无效列名/],
  xugu: [/无效的列名/, /列名无效/, /无效列名/],
  sqlserver: [/\binvalid column name\b/i],
  postgres: [/\bSQLSTATE\b[^\n]{0,4}\b42703\b/i],
  gaussdb: [/\bSQLSTATE\b[^\n]{0,4}\b42703\b/i],
  opengauss: [/\bSQLSTATE\b[^\n]{0,4}\b42703\b/i],
  kingbase: [/\bSQLSTATE\b[^\n]{0,4}\b42703\b/i],
};

// 通用判据：语句引用了不存在的列。列被别的会话删除/改名后刷新会命中这里。
const COLUMN_CHANGE_PATTERNS: readonly RegExp[] = [
  /\bORA-00904\b/i,
  /\binvalid identifier\b/i,
  /\bunknown column\b/i,
  /\binvalid column name\b/i,
  /\bno such column\b/i,
  /\bunknown expression identifier\b/i,
  /\bcolumn\b[^\n]{0,80}?\bdoes not exist\b/i,
  /无效的列名|无效列名|列名无效|无效的列/,
  /列名?[^\n]{0,120}?不存在/,
];

// `SELECT *` 被拒绝（列级 SELECT 权限等）：显式列投影可能仍然可用，值得降级重试一次。
const SELECT_STAR_REJECTED_PATTERNS: readonly RegExp[] = [/\bORA-01031\b/i, /\binsufficient privileges\b/i, /\bSELECT command denied\b/i, /\bpermission denied for (table|relation|column)\b/i, /权限不足|权限不够|没有权限|无权限/];

function matchesAny(text: string, patterns: readonly RegExp[] | undefined): boolean {
  return patterns?.some((pattern) => pattern.test(text)) ?? false;
}

function projectionErrorText(error: unknown): string {
  const parts: string[] = [];
  if (typeof error === "string") {
    parts.push(error);
  } else if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") parts.push(message);
  }
  const detail = normalizeBackendError(error)?.detail;
  if (detail) parts.push(detail);
  // Agent envelopes append JSON metadata after the database message; strip it so
  // the patterns only ever see the server-reported text.
  return parts.map((part) => sanitizeBackendErrorMessage(part)).join("\n");
}

/**
 * The statement referenced a column that no longer exists (deleted or renamed
 * by another session). Rebuilding the statement from fresh metadata normally
 * succeeds, so this must not surface as a user-facing error.
 */
export function isColumnChangeError(error: unknown, context: ProjectionErrorContext = {}): boolean {
  const text = projectionErrorText(error);
  if (!text) return false;
  const databasePatterns = context.databaseType ? DATABASE_COLUMN_CHANGE_PATTERNS[context.databaseType] : undefined;
  return matchesAny(text, databasePatterns) || matchesAny(text, COLUMN_CHANGE_PATTERNS);
}

/**
 * `SELECT *` is not acceptable for this account (column-level SELECT grants).
 * An explicit column projection may still work, so callers degrade once.
 */
export function isSelectStarRejectedError(error: unknown): boolean {
  const text = projectionErrorText(error);
  if (!text) return false;
  return matchesAny(text, SELECT_STAR_REJECTED_PATTERNS);
}

/**
 * Whether a failed star-projection first query should be retried with the
 * canonical projection instead of being published to the grid.
 */
export function isProjectionRetryableError(error: unknown, context: ProjectionErrorContext = {}): boolean {
  return isColumnChangeError(error, context) || isSelectStarRejectedError(error);
}
