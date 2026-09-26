import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildTableSelectSql, quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { tableDataLargeValuePreviewOptions, tableDataNeedsCanonicalProjection } from "@/lib/dataGrid/dataGridLargeValues";
import { isProjectionRetryableError } from "@/lib/sql/columnChangeErrors";
import { elasticsearchCursorPageJumpRequestCount } from "@/lib/dataGrid/dataGridPagination";
import { columnsCarryRealPrimaryKey, editablePrimaryKeys, shouldIncludeSyntheticRowId } from "@/lib/table/tableEditing";
import { tableMetaForDataTab } from "@/lib/table/tableDataTabMeta";
import * as api from "@/lib/backend/api";
import type { ColumnInfo, QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { invalidateTableMetadataCache, loadTableColumns, loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS } from "@/lib/metadata/tableMetadataCache";
import { isDataTabMetadataLifecycleStale } from "@/lib/sidebar/dataTabOpenPolicy";
import { applyMongoFindSort } from "@/lib/mongo/mongoShellCommand";
import { uuid } from "@/lib/common/utils";
import { simpleDataGridOrderByReferencesMissingColumn, type DataGridSortMode } from "@/lib/dataGrid/dataGridSort";
import type { DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import { continuousQueryResultMaxRows } from "@/lib/dataGrid/queryResultRowLimit";
import { queryResultBaseSql, queryResultExecutionSql } from "@/lib/tabs/tabPresentation";
import { sqlExecutionTargetCapabilities } from "@/lib/database/sqlExecutionTargetCapabilities";

const DATA_TAB_METADATA_TTL_MS = TABLE_METADATA_CACHE_TTL_MS;

type TableMetadataColumns = ColumnInfo[];

function visibleQuerySortColumns(columns: string[], hiddenColumnIndexes: number[] | undefined, columnIndex: number): { resultColumns: string[]; columnIndex: number } | undefined {
  const hiddenIndexes = new Set(hiddenColumnIndexes ?? []);
  const resultColumns: string[] = [];
  let visibleColumnIndex: number | undefined;
  for (const [index, resultColumn] of columns.entries()) {
    if (hiddenIndexes.has(index)) continue;
    if (index === columnIndex) visibleColumnIndex = resultColumns.length;
    resultColumns.push(resultColumn);
  }
  if (visibleColumnIndex === undefined) return undefined;
  return { resultColumns, columnIndex: visibleColumnIndex };
}

export function useDataGridActions(activeTab: ComputedRef<QueryTab | undefined>) {
  const { t } = useI18n();
  const { toast } = useToast();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();
  const pendingDataReloads = new Set<QueryTab>();
  const metadataRequests = new WeakMap<QueryTab, object>();

  // A data-grid action names the tab that emitted the event, so a queued
  // or late-routed event cannot fall back to whichever tab is active now.
  function resolveActionTab(tabId: string | undefined): QueryTab | undefined {
    if (!tabId) {
      return activeTab.value;
    }
    const fromStore = queryStore.tabs.find((candidate) => candidate.id === tabId);
    if (fromStore) {
      return fromStore;
    }
    // Hosts may hold the acting tab outside the store array; identity comes
    // from the captured id either way.
    return activeTab.value?.id === tabId ? activeTab.value : undefined;
  }

  function activeQueryTargetOptions(tab: QueryTab) {
    const executionTarget = queryStore.activeResultExecutionTarget(tab.id);
    if (!executionTarget) return {};
    const connection = connectionStore.getConfig(executionTarget.connectionId);
    const capabilities = sqlExecutionTargetCapabilities(connection);
    return capabilities ? { executionTarget, targetContext: capabilities.provider.toExecutionContext(executionTarget, connection!) } : { executionTarget };
  }

  function quoteIdent(tab: QueryTab, name: string): string {
    const config = connectionStore.getConfig(tab.connectionId);
    return quoteTableDataIdentifier(effectiveDatabaseTypeForConnection(config), name, connectionStore.connectionIdentifierQuote?.(tab.connectionId));
  }

  function tableDataPageLimit(tab: QueryTab): number {
    return tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
  }

  function reconcileOracleTableType(tab: QueryTab): void {
    const config = connectionStore.getConfig(tab.connectionId);
    const databaseType = effectiveDatabaseTypeForConnection(config);
    if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle") return;
    const tableMeta = tab.tableMeta;
    if (!tableMeta?.tableName) return;

    const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";
    const resolvedSchema = tableMeta.schema?.trim() || config?.default_schema?.trim();
    const matches = connectionStore
      .lookupLocalCompletionTables(tab.connectionId, tableMeta.database ?? tab.database, tableMeta.tableName, 20, resolvedSchema, tableMeta.catalog)
      .filter((candidate) => normalize(candidate.name) === normalize(tableMeta.tableName) && normalize(candidate.schema) === normalize(resolvedSchema) && normalize(candidate.catalog) === normalize(tableMeta.catalog));
    if (matches.length !== 1) return;

    const objectType = matches[0]?.type;
    const resolvedTableType = objectType === "view" ? "VIEW" : objectType === "materialized_view" ? "MATERIALIZED_VIEW" : objectType === "table" ? "TABLE" : undefined;
    if (!resolvedTableType || tableMeta.tableType?.trim().toUpperCase() === resolvedTableType) return;
    queryStore.setTableMeta(tab.id, { ...tableMeta, tableType: resolvedTableType });
  }

  function resultSortPagination(tab: QueryTab): { limit: number; offset: number } | undefined {
    const limit = tab.resultPageLimit;
    return typeof limit === "number" && limit > 0 ? { limit, offset: 0 } : undefined;
  }

  function buildTableSql(tab: QueryTab, options: { orderBy?: string; limit?: number; offset?: number; whereInput?: string; starProjection?: boolean } = {}): Promise<string> {
    const config = connectionStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const tableMeta = tableMetaForDataTab(tab);
    const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : (tableMeta?.primaryKeys ?? []);
    const useRowId = shouldIncludeSyntheticRowId(effectiveDbType, primaryKeys, tableMeta?.tableType);
    // 列投影只信任真实元数据列：tableMetaForDataTab 的 fallback 列来自查询
    // 结果（可能是失败结果的 ["Error"]），进入 SQL 会生成非法投影；
    // 真实列缺失时省略 columns 让 builder 生成 SELECT *
    const realColumns = tab.tableMeta?.columns.length ? tab.tableMeta.columns : undefined;
    const limit = options.limit ?? tableDataPageLimit(tab);
    // 星号投影：语句里不出现任何列名，别人增删列后刷新依旧有效，且结果自带最新列
    // 集合。大字段预览按列类型裁剪，星号投影无法表达，调用方需先用
    // tableDataNeedsCanonicalProjection 确认该表不需要预览。
    const starProjection = options.starProjection === true;
    return buildTableSelectSql({
      databaseType: effectiveDbType,
      driverProfile: config?.driver_profile,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(tab.connectionId),
      database: tableMeta?.database,
      schema: tableMeta?.schema,
      tableName: tableMeta?.tableName ?? "",
      tableType: tableMeta?.tableType,
      catalog: tableMeta?.catalog,
      columns: starProjection ? undefined : realColumns?.map((column) => column.name),
      primaryKeys,
      ...(starProjection ? {} : tableDataLargeValuePreviewOptions(effectiveDbType, realColumns ?? [], primaryKeys, limit)),
      includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName,
      includeRowId: useRowId,
      limit,
      injectDefaultTimeSeriesWhere: true,
      starProjection,
      ...options,
    });
  }

  async function refreshDataTabTableMeta(tab: QueryTab, options: { force?: boolean; columnsOnly?: boolean; trace?: { traceId: string; elapsed: () => string } } = {}): Promise<boolean> {
    if (tab.mode !== "data" || !tab.connectionId || !tab.database) return false;
    const tableMeta = tableMetaForDataTab(tab);
    if (!tableMeta?.tableName) return false;
    const target = {
      tabId: tab.id,
      connectionId: tab.connectionId,
      database: tableMeta.database ?? tab.database,
      catalog: tableMeta.catalog,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
    };
    // Cache invalidation prevents stale cache writes, but an older caller can
    // still receive its result. Only the latest request may update this tab.
    const requestToken = {};
    metadataRequests.set(tab, requestToken);
    tab.tableMetaPending = true;
    const metadataGenerationAtStart = connectionStore.metadataGenerationFor(target.connectionId, target.database);
    const trace = options.trace;

    console.info("[DBX][reloadData:metadata:ensure-connected:start]", { traceId: trace?.traceId, elapsed: trace?.elapsed() });
    await connectionStore.ensureConnected(target.connectionId);
    console.info("[DBX][reloadData:metadata:ensure-connected:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed() });
    if (metadataRequests.get(tab) !== requestToken || connectionStore.metadataGenerationFor(target.connectionId, target.database) !== metadataGenerationAtStart) {
      console.info("[DBX][reloadData:metadata:superseded-by-connection-generation]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return false;
    }
    const config = connectionStore.getConfig(target.connectionId);
    const querySchema = metadataSchemaForConnection(config, target.database, target.schema);
    console.info("[DBX][reloadData:metadata:get-columns:start]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), schema: querySchema, table: target.tableName, columnsOnly: options.columnsOnly === true });
    // 复用共享表元数据缓存（30s TTL + in-flight 去重），多个入口对同一张表
    // 不再各自往返 getColumns/listIndexes。跨连接生命周期的强制重建走 force，
    // 避免同一共享缓存把断链前的旧列再次交回本次 reload。
    const loaded: { columns: TableMetadataColumns; primaryKeys: string[]; rowIdentityResolved: boolean } = options.columnsOnly
      ? await (async () => {
          const { columns } = await loadTableColumns({
            connectionId: target.connectionId,
            database: target.database,
            schema: querySchema,
            tableName: target.tableName,
            tableType: target.tableType,
            databaseType: effectiveDatabaseTypeForConnection(config) ?? config?.db_type ?? "",
            driverProfile: config?.driver_profile || config?.db_type,
            catalog: target.catalog,
            force: options.force === true,
          });
          const primaryKeys = editablePrimaryKeys(effectiveDatabaseTypeForConnection(config), columns, target.tableType);
          // 列已带真实主键时行标识就是确定的：索引只可能提供"唯一索引回退"，
          // 而那条路径在 primaryKeys 非空时根本不会走到。因此不必为了解除
          // rowIdentityPending 再拉一次索引（慢链路上那是一条新连接 + 数秒往返）。
          return { columns, primaryKeys, rowIdentityResolved: columnsCarryRealPrimaryKey(columns) };
        })()
      : await (async () => {
          const { metadata } = await loadTableMetadata({
            connectionId: target.connectionId,
            database: target.database,
            schema: querySchema,
            tableName: target.tableName,
            tableType: target.tableType,
            databaseType: effectiveDatabaseTypeForConnection(config) ?? config?.db_type ?? "",
            driverProfile: config?.driver_profile || config?.db_type,
            catalog: target.catalog,
            force: options.force === true,
          });
          return { columns: metadata.columns, primaryKeys: metadata.primaryKeys, rowIdentityResolved: metadata.rowIdentityResolved !== false };
        })();
    const columns = loaded.columns;
    console.info("[DBX][reloadData:metadata:get-columns:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), columnCount: columns.length });
    if (metadataRequests.get(tab) !== requestToken || connectionStore.metadataGenerationFor(target.connectionId, target.database) !== metadataGenerationAtStart) {
      console.info("[DBX][reloadData:metadata:superseded-by-connection-generation]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return false;
    }
    const current = queryStore.tabs.find((item) => item.id === target.tabId);
    const currentMeta = current ? tableMetaForDataTab(current) : undefined;
    const currentSourceDatabase = currentMeta?.database ?? current?.database;
    if (
      !current ||
      current !== tab ||
      current.mode !== "data" ||
      current.connectionId !== target.connectionId ||
      currentSourceDatabase !== target.database ||
      currentMeta?.tableName !== target.tableName ||
      (currentMeta.schema ?? "") !== (target.schema ?? "") ||
      (currentMeta.catalog ?? "") !== (target.catalog ?? "")
    ) {
      console.info("[DBX][reloadData:metadata:stale-tab]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return false;
    }
    const primaryKeys = loaded.primaryKeys;
    const refreshedMeta = {
      catalog: target.catalog,
      database: target.database,
      schema: target.schema,
      tableName: target.tableName,
      tableType: target.tableType,
      columns,
      primaryKeys,
    };
    if (loaded.rowIdentityResolved) {
      queryStore.setTableMeta(target.tabId, refreshedMeta);
    } else {
      queryStore.setTableMeta(target.tabId, refreshedMeta, { rowIdentityPending: true });
    }
    return true;
  }

  async function onExecuteSql(tabId: string, sql: string) {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeTabSql(tab.id, sql, { preserveResultDuringExecution: true });
  }

  async function onReloadData(tabId: string | undefined, sql?: string, _searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent) {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    const traceId = uuid().slice(0, 8);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    if (tab.mode === "data" && tableMetaForDataTab(tab)) {
      if (pendingDataReloads.has(tab)) return;
      pendingDataReloads.add(tab);
      const registered = queryStore.tabs.includes(tab);
      const currentTab = () => (registered ? queryStore.tabs.find((item) => item.id === tab.id) : resolveActionTab(tab.id));
      const source = tableMetaForDataTab(tab)!;
      const target = { connectionId: tab.connectionId, database: tab.database, sourceDatabase: source.database ?? tab.database, tableName: source.tableName, schema: source.schema, catalog: source.catalog };
      const stillCurrent = () => {
        const meta = tableMetaForDataTab(tab);
        return (
          currentTab() === tab &&
          tab.mode === "data" &&
          tab.connectionId === target.connectionId &&
          tab.database === target.database &&
          (meta?.database ?? tab.database) === target.sourceDatabase &&
          meta?.tableName === target.tableName &&
          meta?.schema === target.schema &&
          meta?.catalog === target.catalog
        );
      };
      const stopPreparing = () => {
        // A late request must not reset a replacement tab's execution state.
        if (currentTab() === tab) queryStore.setExecuting(tab.id, false);
      };
      try {
        reconcileOracleTableType(tab);
        tab.whereInput = whereInput ?? "";
        queryStore.clearInvalidDataTabSort(tab.id);
        const realColumnNames = tab.tableMeta?.columns.map((column) => column.name) ?? [];
        let incomingSortMissing = realColumnNames.length > 0 && simpleDataGridOrderByReferencesMissingColumn(orderBy, realColumnNames);
        if (incomingSortMissing) tab.orderByInput = undefined;
        const pageLimit = limit ?? tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
        const pageOffset = offset ?? 0;
        // 数据先呈现、元数据随后补齐（见下方首查路径选择）：这里保存后台元数据刷新的
        // Promise，待它落地后再决定是否需要补一次规范投影查询。
        let deferredMetadataRefresh: Promise<boolean> | undefined;
        // 本次元数据的索引发现是否交给了延迟分支（星号投影路径）：下面判断行标识是否
        // 已经确定时要区分几种路径，见 background-indexes 前的说明。
        let metadataRefreshServedByColumnsOnly = false;
        // 星号投影首查若命中"列变化 / 列级权限"类失败，由 handoffColumnChangeError 接管：
        // 记下原始错误，待新列落地后用规范投影重试一次（重试失败才发布错误结果）。
        let handedOffColumnChangeError: unknown;
        let columnChangeRetryHandled = false;
        console.info("[DBX][reloadData:start]", {
          traceId,
          tabId: tab.id,
          connectionId: tab.connectionId,
          database: tab.database,
          table: tableMetaForDataTab(tab)?.tableName,
          elapsed: elapsed(),
        });
        queryStore.setExecuting(tab.id, true);
        const metadataAgeMs = tab.tableMetaUpdatedAt ? Date.now() - tab.tableMetaUpdatedAt : Number.POSITIVE_INFINITY;
        // 判断元数据是否真实存在必须用原始 tab.tableMeta：tableMetaForDataTab 会在
        // 真实列缺失时用查询结果列合成 columns（包括失败结果的 ["Error"] 列），
        // 不能据此跳过刷新，否则恢复/失败后的重试会被 TTL 卡住
        const hasRealTableMetaColumns = !!tab.tableMeta?.columns.length;
        if (hasRealTableMetaColumns) {
          try {
            console.info("[DBX][reloadData:ensure-connected:start]", { traceId, elapsed: elapsed() });
            await connectionStore.ensureConnected(tab.connectionId);
            console.info("[DBX][reloadData:ensure-connected:done]", { traceId, elapsed: elapsed() });
          } catch (e: any) {
            console.warn("[DBX][reloadData:ensure-connected:error]", { traceId, elapsed: elapsed(), error: e });
            stopPreparing();
            toast(e?.message || String(e), 5000);
            throw e;
          }
        }
        if (!stillCurrent()) {
          stopPreparing();
          return;
        }
        const connectionGeneration = connectionStore.metadataGenerationFor(tab.connectionId, tab.database);
        const lifecycleStale = isDataTabMetadataLifecycleStale(tab, connectionGeneration);
        const shouldRefreshMetadata = lifecycleStale || tab.tableMetaPending || !hasRealTableMetaColumns || metadataAgeMs > DATA_TAB_METADATA_TTL_MS;
        // Dameng 元数据必须与数据查询串行（同 useSidebarDataOpenRuntime），
        // 延后到查询完成后再启动。主动刷新和跨生命周期重建除外：必须先拿到新列再
        // 构建 SQL，否则第一次 toolbar reload 仍会沿用断链前的显式列列表。
        const effectiveDbType = effectiveDatabaseTypeForConnection(connectionStore.getConfig(tab.connectionId));
        const deferMetadataRefresh = intent !== "refresh" && !lifecycleStale && effectiveDbType === "dameng";
        // 刷新首查用"列名无关"的星号投影：语句里不出现任何列名，所以别人新增/删除列后
        // 刷新不会再先显示旧列、也不会因引用已删除的列而报错，结果自身就带回最新的列
        // 集合与类型。唯一例外是大字段预览：它按列类型生成裁剪投影，星号投影无法表达，
        // 这类表必须先拿到最新列与新类型再发一条规范投影查询（两条路径都只发一条查询）。
        const starProjectionQuery = (intent === "refresh" || intent === "auto-refresh") && !lifecycleStale && hasRealTableMetaColumns && !tableDataNeedsCanonicalProjection(effectiveDbType, tab.tableMeta?.columns ?? [], tab.tableMeta?.primaryKeys ?? [], pageLimit);
        const startMetadataRefresh = () => {
          console.info("[DBX][reloadData:metadata:background:start]", { traceId, elapsed: elapsed(), reason: hasRealTableMetaColumns ? "stale" : "missing", metadataAgeMs });
          void refreshDataTabTableMeta(tab, { force: lifecycleStale, trace: { traceId, elapsed } })
            .then(() => {
              console.info("[DBX][reloadData:metadata:background:done]", { traceId, elapsed: elapsed() });
            })
            .catch((e: any) => {
              console.warn("[DBX][reloadData:metadata:background:error]", { traceId, elapsed: elapsed(), error: e });
              toast(e?.message || String(e), 5000);
            });
        };
        // 行标识没有被列确定时（无主键表 / 主键刚被删 / 索引发现失败）才做索引发现：
        // 列已带真实主键时索引既不会改变行标识也不会改变 SELECT 投影，这次请求
        // （慢链路上一整条新连接 + 数秒往返）可以整段省掉。
        const startIndexDiscoveryRefresh = () => {
          void refreshDataTabTableMeta(tab, { force: false, trace: { traceId, elapsed } })
            .then(() => {
              console.info("[DBX][reloadData:metadata:background-indexes:done]", { traceId, elapsed: elapsed() });
            })
            .catch((e: any) => {
              console.warn("[DBX][reloadData:metadata:background-indexes:error]", { traceId, elapsed: elapsed(), error: e });
            });
        };
        if (lifecycleStale || intent === "refresh") {
          tab.tableMetaPending = true;
          console.info("[DBX][reloadData:metadata:await:start]", { traceId, elapsed: elapsed(), reason: intent === "refresh" ? "manual-refresh" : "lifecycle-stale", metadataAgeMs });
          try {
            if (intent === "refresh") {
              const meta = tableMetaForDataTab(tab)!;
              const config = connectionStore.getConfig(tab.connectionId);
              const match = {
                connectionId: tab.connectionId,
                database: meta.database ?? tab.database,
                schema: metadataSchemaForConnection(config, meta.database ?? tab.database, meta.schema),
                tableName: meta.tableName,
              };
              invalidateTableMetadataCache(match);
              // 持久缓存（object-meta L2）删除只服务后续结构面板/DDL 读取的
              // 新鲜度，不参与本次查询构建：移出关键路径 fire-and-forget，
              // 失败不再中断刷新（网格侧已由上面的内存失效保证列新鲜）。
              console.info("[DBX][reloadData:object-cache-invalidate:start]", { traceId, elapsed: elapsed() });
              invalidateObjectMetadataCache(match).catch((e: unknown) => {
                console.warn("[DBX][reloadData:object-cache-invalidate:error]", { traceId, elapsed: elapsed(), error: e });
              });
              if (!stillCurrent() || connectionStore.metadataGenerationFor(tab.connectionId, tab.database) !== connectionGeneration) {
                stopPreparing();
                return;
              }
            }
            // 元数据是否移出关键路径由 starProjectionQuery 决定（见其定义）：
            //  - 星号投影：首查不依赖列名，元数据完全后台跑，列/索引随后异步补齐
            //  - 规范投影（仅大字段预览表）：必须先等新列与新类型，本次仍只发一条查询
            // 高延迟链路（SSH 隧道 ~100ms RTT）上一次 getColumns 要数秒，串行等待会让
            // "刷新数据"明显慢于直接执行同一条 SQL（DataGrip 刷新数据不发元数据请求）。
            // 只有列缺失（没有可信投影）或跨生命周期重建才必须串行等待：
            // 那时旧列可能来自断链前的会话，直接发查询会得到错误结果。
            const metadataRefreshOffCriticalPath = intent === "refresh" && !lifecycleStale && hasRealTableMetaColumns;
            if (metadataRefreshOffCriticalPath && starProjectionQuery) {
              metadataRefreshServedByColumnsOnly = true;
              deferredMetadataRefresh = refreshDataTabTableMeta(tab, { force: true, columnsOnly: true, trace: { traceId, elapsed } })
                .then((rebuilt) => {
                  console.info("[DBX][reloadData:metadata:await:done]", { traceId, elapsed: elapsed(), rebuilt, deferred: true });
                  return rebuilt;
                })
                .catch((e: any) => {
                  console.warn("[DBX][reloadData:metadata:await:error]", { traceId, elapsed: elapsed(), error: e });
                  // 延迟路径不中止本次查询（星号投影不依赖列名），但失败必须让用户看到：
                  // 否则"刷新成功但结构没更新"会变成一个静默的错误。
                  toast(e?.message || String(e), 5000);
                  return false;
                });
            } else if (metadataRefreshOffCriticalPath) {
              // 大字段预览表：规范投影依赖最新列与新类型，串行取回后再构建 SQL
              const rebuilt = await refreshDataTabTableMeta(tab, { force: true, columnsOnly: true, trace: { traceId, elapsed } });
              console.info("[DBX][reloadData:metadata:await:done]", { traceId, elapsed: elapsed(), rebuilt, deferred: false });
              if (!rebuilt) {
                stopPreparing();
                return;
              }
            } else {
              const rebuilt = await refreshDataTabTableMeta(tab, { force: true, columnsOnly: false, trace: { traceId, elapsed } });
              console.info("[DBX][reloadData:metadata:await:done]", { traceId, elapsed: elapsed(), rebuilt, deferred: false });
              if (!rebuilt) {
                stopPreparing();
                return;
              }
            }
          } catch (e: any) {
            console.warn("[DBX][reloadData:metadata:await:error]", { traceId, elapsed: elapsed(), error: e });
            stopPreparing();
            toast(e?.message || String(e), 5000);
            throw e;
          }
          queryStore.clearInvalidDataTabSort(tab.id);
          const rebuiltColumnNames = tab.tableMeta?.columns.map((column) => column.name) ?? [];
          incomingSortMissing = rebuiltColumnNames.length > 0 && simpleDataGridOrderByReferencesMissingColumn(orderBy, rebuiltColumnNames);
          if (incomingSortMissing) tab.orderByInput = undefined;
          // 串行路径此刻已经拿回完整元数据，能直接判断行标识是否落定（未落定就等于
          // 索引发现失败）→ 补一次索引发现。延迟路径不能在这里判断：它的新列还没到，
          // 用刷新前的旧列判断会漏掉"这次刷新发现主键被删"的情况，让标签页永远解除
          // 不了只读；那条路径的索引发现放在 deferredMetadataRefresh 的完成分支里。
          if (intent === "refresh" && !lifecycleStale && !metadataRefreshServedByColumnsOnly && tab.tableMetaPending) {
            startIndexDiscoveryRefresh();
          }
        } else if (shouldRefreshMetadata) {
          // 元数据缺失（如重启恢复的标签页只持久化了占位身份）时行标识未知：
          // 挂起等待，防止数据查询先返回后编辑/保存以空 primaryKeys 短暂可用，
          // 走整行 WHERE 保存路径（#3727）。真实元数据经 setTableMeta 落地后解除
          if (!hasRealTableMetaColumns) tab.tableMetaPending = true;
          if (!deferMetadataRefresh) startMetadataRefresh();
        } else {
          console.info("[DBX][reloadData:metadata:skip]", { traceId, elapsed: elapsed(), columnCount: tab.tableMeta!.columns.length, metadataAgeMs });
        }
        try {
          console.info("[DBX][reloadData:build-sql:start]", { traceId, elapsed: elapsed() });
          const nextSql = await buildTableSql(tab, { whereInput, orderBy: incomingSortMissing ? undefined : orderBy, limit: pageLimit, offset: pageOffset, starProjection: starProjectionQuery });
          console.info("[DBX][reloadData:build-sql:done]", { traceId, elapsed: elapsed(), starProjection: starProjectionQuery });
          if (!stillCurrent() || connectionStore.metadataGenerationFor(tab.connectionId, tab.database) !== connectionGeneration) {
            stopPreparing();
            return;
          }
          queryStore.updateSql(tab.id, nextSql);
          console.info("[DBX][reloadData:execute:start]", { traceId, elapsed: elapsed() });
          await queryStore.executeTabSql(tab.id, nextSql, {
            pagination: { limit: pageLimit, offset: pageOffset },
            preserveResultDuringExecution: true,
            // 星号投影失败时（列被别的会话删掉、账号只有列级 SELECT 权限）先不弹错误：
            // 下面会用最新列重建规范投影重试一次，重试仍失败才发布错误结果。
            ...(starProjectionQuery
              ? {
                  handoffColumnChangeError: (error: unknown) => {
                    const config = connectionStore.getConfig(tab.connectionId);
                    if (!isProjectionRetryableError(error, { databaseType: effectiveDbType, driverProfile: config?.driver_profile })) return false;
                    handedOffColumnChangeError = error;
                    return true;
                  },
                }
              : {}),
          });
          console.info("[DBX][reloadData:execute:done]", { traceId, elapsed: elapsed(), handedOff: handedOffColumnChangeError !== undefined });
        } catch (e) {
          console.error("[DBX][reloadData:error]", { traceId, elapsed: elapsed(), error: e });
          stopPreparing();
          if (shouldRefreshMetadata && deferMetadataRefresh) startMetadataRefresh();
          throw e;
        }
        // 星号投影首查命中"列变化 / 列级权限"类失败：界面上不出现任何错误提示，
        // 等新列落地后用规范投影重试一次（这次失败照常发布错误结果，属于断链、超时等
        // 真实故障时也不会被掩盖）。重试结果即最新列与最新数据。
        if (handedOffColumnChangeError !== undefined) {
          columnChangeRetryHandled = true;
          console.info("[DBX][reloadData:column-change-retry:start]", { traceId, elapsed: elapsed(), error: handedOffColumnChangeError });
          let retryMetadataReady = false;
          try {
            retryMetadataReady = deferredMetadataRefresh ? await deferredMetadataRefresh : await refreshDataTabTableMeta(tab, { force: true, columnsOnly: true, trace: { traceId, elapsed } });
          } catch (metadataError: any) {
            console.warn("[DBX][reloadData:column-change-retry:metadata-error]", { traceId, elapsed: elapsed(), error: metadataError });
          }
          if (!retryMetadataReady) {
            // 拿不到新列就无法保证重试语句合法（多半是连接层故障）：不能静默，
            // 按原有方式把首查的错误呈现出来。
            if (stillCurrent()) {
              stopPreparing();
              queryStore.setErrorResult(tab.id, handedOffColumnChangeError);
            }
            return;
          }
          if (!stillCurrent()) {
            stopPreparing();
            return;
          }
          queryStore.clearInvalidDataTabSort(tab.id);
          const retryColumnNames = tab.tableMeta?.columns.map((column) => column.name) ?? [];
          const retrySortMissing = retryColumnNames.length > 0 && simpleDataGridOrderByReferencesMissingColumn(orderBy, retryColumnNames);
          if (retrySortMissing) tab.orderByInput = undefined;
          try {
            const retrySql = await buildTableSql(tab, {
              whereInput,
              orderBy: retrySortMissing ? undefined : orderBy,
              limit: pageLimit,
              offset: pageOffset,
            });
            if (!stillCurrent()) {
              stopPreparing();
              return;
            }
            queryStore.updateSql(tab.id, retrySql);
            console.info("[DBX][reloadData:column-change-retry:execute:start]", { traceId, elapsed: elapsed() });
            await queryStore.executeTabSql(tab.id, retrySql, {
              pagination: { limit: pageLimit, offset: pageOffset },
              preserveResultDuringExecution: true,
            });
            console.info("[DBX][reloadData:column-change-retry:execute:done]", { traceId, elapsed: elapsed() });
          } catch (e) {
            console.error("[DBX][reloadData:column-change-retry:error]", { traceId, elapsed: elapsed(), error: e });
            stopPreparing();
            throw e;
          }
        }
        // 星号投影首查之后的收尾：元数据落地时只做三件事——补一次索引发现（行标识还没被
        // 列确定时）、把编辑器里的 SQL 文本对齐到规范投影、以及在"本次才发现该表需要大字段
        // 预览"这一罕见过渡下补一条规范投影查询。常规情况**不重跑**：首查结果本身就是最新
        // 列与最新数据（路径判定已排除需要预览裁剪的表），用户已经省掉了 getColumns 的等待。
        if (deferredMetadataRefresh) {
          void deferredMetadataRefresh.then(async (rebuilt) => {
            if (!rebuilt || !stillCurrent()) return;
            // 新列到手后才判断行标识是否真的由列确定：列里没有真实主键（无主键表、
            // 本次刷新发现主键被删、索引发现失败）时才需要索引发现提供唯一索引回退。
            if (!columnsCarryRealPrimaryKey(tab.tableMeta?.columns ?? [])) {
              startIndexDiscoveryRefresh();
            }
            // 列变化重试路径已经用规范投影重建并执行过语句：这里不再重复对齐 SQL 文本或
            // 补跑查询，只保留上面的索引发现（行标识可能还需要唯一索引回退）。
            if (columnChangeRetryHandled) return;
            const refreshedColumnNames = tab.tableMeta?.columns.map((column) => column.name) ?? [];
            const refreshedSortMissing = refreshedColumnNames.length > 0 && simpleDataGridOrderByReferencesMissingColumn(orderBy, refreshedColumnNames);
            // 罕见过渡：旧元数据里没有需要裁剪的列，但本次新增的列恰是大字段（CLOB/BLOB
            // 等）。星号投影的结果没有预览裁剪，补一条规范投影查询把大值收敛回来；下一次
            // 刷新会直接走"等列 + 规范投影"路径，不再需要补跑。
            const canonicalProjectionNeeded = tableDataNeedsCanonicalProjection(effectiveDbType, tab.tableMeta?.columns ?? [], tab.tableMeta?.primaryKeys ?? [], pageLimit);
            try {
              const sql = await buildTableSql(tab, {
                whereInput,
                orderBy: refreshedSortMissing ? undefined : orderBy,
                limit: pageLimit,
                offset: pageOffset,
              });
              if (!stillCurrent()) return;
              if (!canonicalProjectionNeeded) {
                // 常规路径：只把编辑器 SQL 文本对齐到规范投影，不重跑查询。后续分页/排序/
                // 编辑都会用最新 tableMeta 重新生成 SQL，因此文本与数据始终一致。
                if (!tab.isExecuting) queryStore.updateSql(tab.id, sql);
                return;
              }
              queryStore.updateSql(tab.id, sql);
              console.info("[DBX][reloadData:metadata:canonical-reexecute:start]", { traceId, elapsed: elapsed() });
              await queryStore.executeTabSql(tab.id, sql, {
                pagination: { limit: pageLimit, offset: pageOffset },
                preserveResultDuringExecution: true,
              });
              console.info("[DBX][reloadData:metadata:canonical-reexecute:done]", { traceId, elapsed: elapsed() });
            } catch (e: any) {
              console.warn("[DBX][reloadData:metadata:canonical-reexecute:error]", { traceId, elapsed: elapsed(), error: e });
            }
          });
        }
        if (shouldRefreshMetadata && deferMetadataRefresh) startMetadataRefresh();
        return;
      } finally {
        pendingDataReloads.delete(tab);
      }
    }
    if ((intent === "refresh" || intent === "auto-refresh") && tab.mode === "query" && (tab.results?.length ?? 0) > 1) {
      const resultGroupSql = tab.resultBaseSql || tab.lastExecutedSql || tab.sql;
      if (!resultGroupSql.trim()) return;
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultSortedSql = undefined;
      await queryStore.executeTabSql(tab.id, resultGroupSql, {
        ...activeQueryTargetOptions(tab),
        resultBaseSql: resultGroupSql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
        preserveActiveResultIndex: true,
      });
      return;
    }
    if (tab.resultSortedSql) {
      const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, tab.resultSortColumnIndex ?? -1);
      const rebuildHiddenKeySort = !!tab.result?.hidden_column_indexes?.length && tab.resultSortMode === "database" && !!tab.resultSortDirection && !!tab.resultSortColumn && !!sortColumns;
      await queryStore.executeTabSql(tab.id, rebuildHiddenKeySort ? (tab.resultBaseSql ?? tab.sql) : tab.resultSortedSql, {
        ...activeQueryTargetOptions(tab),
        resultBaseSql: tab.resultBaseSql ?? tab.sql,
        ...(rebuildHiddenKeySort
          ? {
              querySort: {
                resultColumns: sortColumns.resultColumns,
                columnIndex: sortColumns.columnIndex,
                column: tab.resultSortColumn!,
                direction: tab.resultSortDirection!,
              },
            }
          : { resultSortedSql: tab.resultSortedSql }),
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
      });
      return;
    }
    if (sql?.trim()) {
      const hasMultiResults = tab.mode === "query" && (tab.results?.length ?? 0) > 1;
      await queryStore.executeTabSql(tab.id, sql, {
        ...(tab.mode === "query" ? activeQueryTargetOptions(tab) : {}),
        resultBaseSql: sql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
        ...(hasMultiResults ? { replaceActiveResultInGroup: true, preserveActiveResultIndex: true } : {}),
      });
      return;
    }
    await queryStore.executeCurrentTab();
  }

  async function onPaginate(tabId: string | undefined, offset: number, limit: number, whereInput?: string, orderBy?: string, appendRequested = false) {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    const appendResult = (appendRequested || settingsStore.editorSettings.infiniteScroll) && offset > 0 && offset === tab.result?.rows.length;
    const appendOptions = appendResult
      ? {
          appendResult: {
            maxRows: continuousQueryResultMaxRows(settingsStore.editorSettings.queryResultMaxRowsEnabled, settingsStore.editorSettings.queryResultMaxRows),
          },
        }
      : {};
    if (tab.mode !== "data") {
      const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, tab.resultSortColumnIndex ?? -1);
      const hasDatabaseSort = !!tab.result?.hidden_column_indexes?.length && tab.resultSortMode === "database" && !!tab.resultSortDirection && !!tab.resultSortColumn && !!sortColumns;
      const baseSql = hasDatabaseSort ? queryResultBaseSql(tab) : queryResultExecutionSql(tab);
      if (!baseSql.trim()) return;
      const expectedNextOffset = appendResult ? tab.result?.rows.length : (tab.resultPageOffset ?? 0) + (tab.resultPageLimit ?? limit);
      const continuesResultSession = appendResult ? offset === expectedNextOffset : offset === expectedNextOffset && limit === tab.resultPageLimit;
      const sessionId = tab.result?.has_more && tab.result?.session_id && continuesResultSession ? tab.result.session_id : undefined;
      const resultBaseSql = queryResultBaseSql(tab);
      const executePage = (pageOffset: number, pageSessionId?: string, retainDisplayedResult = false) =>
        queryStore.executeTabSql(tab.id, baseSql, {
          ...activeQueryTargetOptions(tab),
          resultBaseSql,
          resultSortedSql: tab.resultSortedSql,
          ...(hasDatabaseSort
            ? {
                querySort: {
                  resultColumns: sortColumns.resultColumns,
                  columnIndex: sortColumns.columnIndex,
                  column: tab.resultSortColumn!,
                  direction: tab.resultSortDirection!,
                },
              }
            : {}),
          pagination: { offset: pageOffset, limit, sessionId: pageSessionId, clientSessionId: pageSessionId ? tab.resultClientSessionId : undefined },
          ...appendOptions,
          preserveResultDuringExecution: true,
          preserveTotalRowCountDuringExecution: true,
          replaceActiveResultInGroup: true,
          ...(retainDisplayedResult ? { retainDisplayedResult: true } : {}),
        });
      const executionTarget = queryStore.activeResultExecutionTarget(tab.id);
      const executionConnection = connectionStore.getConfig(executionTarget?.connectionId ?? tab.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(executionConnection);
      const usesElasticsearchCursor = effectiveDbType === "elasticsearch" || effectiveDbType === "easysearch";

      // Elasticsearch search_after has no random page access, so every missing
      // cursor must be fetched in order. This workaround still sends one ES
      // request per skipped page (page 1 -> 101 sends 100 requests);
      // retainDisplayedResult only hides those intermediate pages from the UI.
      const currentResultSessionId = tab.resultSessionId ?? tab.result?.session_id;
      if (usesElasticsearchCursor && tab.result?.has_more === true && !appendResult && typeof expectedNextOffset === "number" && limit === tab.resultPageLimit && currentResultSessionId) {
        let nextOffset = expectedNextOffset;
        let nextSessionId: string | undefined = currentResultSessionId;
        const currentPage = Math.floor(nextOffset / limit);
        const targetPage = Math.floor(offset / limit) + 1;
        const totalRequests = elasticsearchCursorPageJumpRequestCount(currentPage, targetPage);
        const jumpProgress =
          totalRequests > 1
            ? {
                completedRequests: 0,
                totalRequests,
                targetPage,
              }
            : undefined;
        if (jumpProgress) {
          tab.resultPageJumpProgress = jumpProgress;
        }
        const activeJumpProgress = tab.resultPageJumpProgress;
        const executeCursorPage = async (pageOffset: number, pageSessionId?: string, retainDisplayedResult = false) => {
          await executePage(pageOffset, pageSessionId, retainDisplayedResult);
          if (activeJumpProgress) {
            activeJumpProgress.completedRequests += 1;
          }
        };

        try {
          if (offset < nextOffset) {
            await executeCursorPage(0, undefined, offset !== 0);
            if (offset === 0) {
              return;
            }
            const restartedTab = activeTab.value;
            if (restartedTab?.id !== tab.id) {
              return;
            }
            nextOffset = limit;
            nextSessionId = restartedTab.resultSessionId;
          }
          while (nextOffset < offset) {
            if (!nextSessionId) {
              return;
            }
            await executeCursorPage(nextOffset, nextSessionId, true);
            const advancedTab = activeTab.value;
            if (advancedTab?.id !== tab.id) {
              return;
            }
            nextOffset += limit;
            nextSessionId = advancedTab.resultSessionId;
          }
          if (nextOffset === offset && nextSessionId) {
            await executeCursorPage(offset, nextSessionId);
            return;
          }
        } finally {
          if (tab.resultPageJumpProgress === activeJumpProgress) {
            tab.resultPageJumpProgress = undefined;
          }
        }
      }

      await executePage(offset, sessionId);
      return;
    }

    if (!tableMetaForDataTab(tab)) return;
    tab.whereInput = whereInput ?? "";
    const sql = await buildTableSql(tab, { limit, offset, whereInput, orderBy: orderBy ?? tab.orderByInput });
    queryStore.updateSql(tab.id, sql);
    const expectedNextOffset = appendResult ? tab.result?.rows.length : (tab.resultPageOffset ?? 0) + (tab.resultPageLimit ?? limit);
    const continuesResultSession = offset === expectedNextOffset && limit === tab.resultPageLimit;
    const connection = useConnectionStore().getConfig(tab.connectionId);
    const isSqlServerLegacy = connection?.db_type === "sqlserver" && connection.driver_profile?.trim().toLowerCase() === "sqlserver-legacy";
    const sessionId = isSqlServerLegacy && tab.result?.has_more && tab.result.session_id && continuesResultSession ? tab.result.session_id : undefined;
    await queryStore.executeTabSql(tab.id, sql, {
      pagination: { offset, limit, sessionId, clientSessionId: sessionId ? tab.resultClientSessionId : undefined },
      ...appendOptions,
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
    });
  }

  async function onSort(tabId: string | undefined, column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string, mode: DataGridSortMode = "database") {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    tab.resultSortColumn = direction ? column : undefined;
    tab.resultSortColumnIndex = direction ? columnIndex : undefined;
    tab.resultSortDirection = direction ?? undefined;
    tab.resultSortMode = direction ? mode : undefined;

    if (mode === "local") {
      if (tab.mode === "data") {
        tab.whereInput = whereInput ?? "";
        tab.orderByInput = undefined;
      }
      queryStore.sortTabResultLocally(tab.id, column, columnIndex, direction);
      return;
    }

    if (tab.mode === "data") {
      if (!tableMetaForDataTab(tab)) return;
      tab.whereInput = whereInput ?? "";
      const config = connectionStore.getConfig(tab.connectionId);
      const quotedColumn = quoteIdent(tab, column);
      const orderBy = direction ? `${config?.db_type === "neo4j" ? `n.${quotedColumn}` : quotedColumn} ${direction.toUpperCase()}` : undefined;
      const limit = tableDataPageLimit(tab);
      const pagination = { limit, offset: 0 };
      tab.orderByInput = orderBy;
      const sql = await buildTableSql(tab, { orderBy, whereInput, limit, offset: pagination.offset });
      queryStore.updateSql(tab.id, sql);
      await queryStore.executeTabSql(tab.id, sql, {
        pagination,
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
      });
      return;
    }

    const baseSql = queryResultBaseSql(tab);
    if (!baseSql.trim()) return;
    const pagination = resultSortPagination(tab);

    if (!direction) {
      await queryStore.executeTabSql(tab.id, baseSql, {
        ...activeQueryTargetOptions(tab),
        resultBaseSql: baseSql,
        resultSortedSql: undefined,
        ...(pagination ? { pagination } : {}),
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }

    const executionTarget = queryStore.activeResultExecutionTarget(tab.id);
    const config = connectionStore.getConfig(executionTarget?.connectionId ?? tab.connectionId);
    if (effectiveDatabaseTypeForConnection(config) === "mongodb") {
      const sortedSql = applyMongoFindSort(baseSql, column, direction);
      if (!sortedSql) {
        toast(t("grid.sortUnsupported"), 5000);
        return;
      }
      queryStore.updateSql(tab.id, sortedSql);
      await queryStore.executeTabSql(tab.id, sortedSql, {
        ...activeQueryTargetOptions(tab),
        resultBaseSql: baseSql,
        resultSortedSql: sortedSql,
        ...(pagination ? { pagination } : {}),
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }

    const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, columnIndex);
    if (!sortColumns) {
      toast(t("grid.sortUnsupported"), 5000);
      return;
    }
    if (!tab.result?.hidden_column_indexes?.length) {
      const built = await api.buildSortedQuerySql({
        originalSql: baseSql,
        databaseType: effectiveDatabaseTypeForConnection(config),
        resultColumns: sortColumns.resultColumns,
        columnIndex: sortColumns.columnIndex,
        column,
        direction,
      });
      if (!built.ok || !built.sql) {
        toast(t("grid.sortUnsupported"), 5000);
        return;
      }
      await queryStore.executeTabSql(tab.id, built.sql, {
        ...activeQueryTargetOptions(tab),
        resultBaseSql: baseSql,
        resultSortedSql: built.sql,
        ...(pagination ? { pagination } : {}),
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }
    await queryStore.executeTabSql(tab.id, baseSql, {
      ...activeQueryTargetOptions(tab),
      resultBaseSql: baseSql,
      querySort: {
        resultColumns: sortColumns.resultColumns,
        columnIndex: sortColumns.columnIndex,
        column,
        direction,
      },
      ...(pagination ? { pagination } : {}),
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
      replaceActiveResultInGroup: true,
    });
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
