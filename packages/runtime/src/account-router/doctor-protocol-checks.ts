import { classifyClientMethod, classifyServerNotification, isKnownServerRequest, parseJsonRpcLine, threadIdFrom, CorrelationTable } from "./protocol";

/** Exercises production routing and correlation without an account, filesystem writes, or backend calls. */
export function runDoctorProtocolAdapterChecks(contracts: ReadonlyArray<{method: string; direction: "client" | "server" | "notification"}>): Array<{method: string; passed: boolean; summary: string}> {
  return contracts.map(({method, direction}) => {
    try {
      const scoped = /^(thread|turn|item)\//.test(method);
      const params = scoped ? { threadId: "doctor-synthetic-thread", turnId: "doctor-synthetic-turn", itemId: "doctor-synthetic-item" } : {};
      const message = parseJsonRpcLine(JSON.stringify({method, params, ...(direction === "notification" ? {} : {id: 7})}));
      if (!message || scoped && threadIdFrom(params) !== params.threadId) throw new Error("JSON-RPC parsing or thread ownership extraction failed");
      const route = direction === "client" ? classifyClientMethod(method, params)
        : direction === "notification" ? classifyServerNotification(method, params)
        : isKnownServerRequest(method) ? "correlated_server_request" : "unknown";
      const expected = direction === "server" ? "correlated_server_request"
        : direction === "notification" ? scoped ? "verify_persisted_owner_then_forward" : method.startsWith("account/") ? "ingest_per_home_primary_forward_only_redacted_control_projection" : "primary_forward_or_origin_correlation_only"
        : method === "initialize" ? "fanout_initialize_intersection"
        : method === "thread/start" ? "balance_new_thread"
        : method === "threadSection/list" ? "fanout_sections_read"
        : method === "experimentalFeature/enablement/set" ? "fanout_feature_enablement"
        : ["thread/list", "thread/search", "thread/loaded/list"].includes(method) ? "fanout_aggregate_read_with_router_cursor"
        : scoped ? "persisted_thread_owner"
        : method.startsWith("account/") ? "primary_to_desktop_internal_per_home_probe"
        : "primary_only_fail_if_semantics_require_account_or_thread_inference";
      if (route !== expected) throw new Error(`Production route ${route} differs from expected ${expected}`);
      if (direction !== "notification") {
        const correlations = new CorrelationTable();
        const entry = correlations.create(direction === "client" ? "client_to_child" : "child_to_client", "ar_doctorsynthetic0001", 7, method);
        if (entry.originalId !== 7 || correlations.get(entry.internalId)?.method !== method) throw new Error("Request correlation failed");
        if (!parseJsonRpcLine(JSON.stringify({id: entry.internalId, result: {}}))) throw new Error("Response envelope rejected");
      }
      return { method, passed: true, summary: `Production JSON-RPC parser, ${route}, thread ID extraction${direction === "notification" ? "" : ", and request correlation"}; synthetic routing evidence only` };
    } catch (error) { return {method, passed: false, summary: error instanceof Error ? error.message : String(error)}; }
  });
}
