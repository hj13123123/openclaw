import { describe, expect, it, vi } from "vitest";
import {
  AUTH_TOKEN,
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";
import { withTempConfig } from "./test-temp-config.js";

describe("gateway OpenAI-compatible disabled HTTP routes", () => {
  it("returns 404 when compat endpoints are disabled", async () => {
    await withGatewayServer({
      prefix: "openai-compat-disabled",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        for (const path of ["/v1/chat/completions", "/v1/responses"]) {
          const req = createRequest({
            path,
            method: "POST",
            headers: { "content-type": "application/json" },
          });
          const { res, getBody } = createResponse();
          await dispatchRequest(server, req, res);

          expect(res.statusCode, path).toBe(404);
          expect(getBody(), path).toBe("Not Found");
        }
      },
    });
  });
});

describe("gateway probe endpoints", () => {
  it("routes KB semantic rebuild acceptance through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-acceptance-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/api/kb/semantic-rebuild-plan/acceptance" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            mode: "acceptance-record-dry-run",
            wouldWrite: false,
            acceptance: expect.objectContaining({
              readyForHumanGate: false,
              status: expect.stringMatching(/^(missing|blocked)$/u),
            }),
            constraintsVerified: expect.objectContaining({
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild acceptance records through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-acceptance-records-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({ path: "/api/kb/semantic-rebuild-plan/acceptance-records" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "acceptance-record-list",
            reportPrefix: "kb-semantic-rebuild-acceptance-",
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild preflight through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-preflight-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/rebuild-preflight",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "semantic-rebuild-preflight",
            status: expect.stringMatching(/^(ready_for_rebuild_human_approval|blocked)$/u),
            readyForRebuildHumanApproval: expect.any(Boolean),
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild execution dry-run through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-dry-run-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/rebuild-dry-run",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "semantic-rebuild-execution-dry-run",
            status: expect.stringMatching(/^(ready_for_execution_human_gate|blocked)$/u),
            wouldExecute: false,
            readyForExecutionHumanGate: expect.any(Boolean),
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              embeddingCalls: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild approval through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-approval-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/rebuild-approval",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            mode: "rebuild-approval-record-dry-run",
            wouldWrite: false,
            dryRun: expect.objectContaining({
              mode: "semantic-rebuild-execution-dry-run",
              wouldExecute: false,
            }),
            constraintsVerified: expect.objectContaining({
              approvalRecordWritten: "no",
              embeddingCalls: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild approval records through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-approval-records-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/rebuild-approval-records",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "rebuild-approval-record-list",
            reportPrefix: "kb-semantic-rebuild-approval-",
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              embeddingCalls: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild execution entry through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-execution-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/rebuild-execution",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "semantic-rebuild-execution-entry",
            status: expect.stringMatching(/^(ready_for_real_rebuild_implementation|blocked)$/u),
            wouldExecute: false,
            executed: false,
            readyForRealRebuildImplementation: expect.any(Boolean),
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              embeddingCalls: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild execution contract through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-execution-contract-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/rebuild-execution-contract",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "semantic-rebuild-execution-contract",
            status: expect.stringMatching(/^(ready_for_executor_contract|blocked)$/u),
            readyForExecutorContract: expect.any(Boolean),
            wouldExecute: false,
            executed: false,
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              embeddingCalls: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("routes KB semantic rebuild status through the HTTP fast path", async () => {
    await withGatewayServer({
      prefix: "kb-semantic-rebuild-status-fast-path",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const req = createRequest({
          path: "/api/kb/semantic-rebuild-plan/status",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual(
          expect.objectContaining({
            available: expect.any(Boolean),
            mode: "semantic-rebuild-status",
            stage: expect.any(String),
            status: expect.stringMatching(/^(ready_for_real_rebuild_implementation|blocked)$/u),
            constraintsVerified: expect.objectContaining({
              fileWrites: "no",
              embeddingCalls: "no",
              realRebuildTriggered: "no",
              applied: "no",
            }),
          }),
        );
      },
    });
  });

  it("returns detailed readiness payload for local /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: true,
      failing: [],
      uptimeMs: 45_000,
    });

    await withGatewayServer({
      prefix: "probe-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ready: true, failing: [], uptimeMs: 45_000 });
      },
    });
  });

  it("returns only readiness state for unauthenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-not-ready",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false });
      },
    });
  });

  it("returns detailed readiness payload for authenticated remote /ready requests", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withGatewayServer({
      prefix: "probe-remote-authenticated",
      resolvedAuth: AUTH_TOKEN,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({
          path: "/ready",
          remoteAddress: "10.0.0.8",
          host: "gateway.test",
          authorization: "Bearer test-token",
        });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({
          ready: false,
          failing: ["discord", "telegram"],
          uptimeMs: 8_000,
        });
      },
    });
  });

  it("hides readiness details when trusted-proxy auth violates browser origin policy", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 8_000,
    });

    await withTempConfig({
      prefix: "probe-remote-origin-rejected",
      cfg: {
        gateway: {
          trustedProxies: ["10.0.0.1"],
          controlUi: {
            allowedOrigins: ["https://control.example"],
          },
        },
      },
      run: async () => {
        await withGatewayServer({
          prefix: "probe-remote-origin-rejected-server",
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            getReadiness,
          },
          run: async (server) => {
            const req = createRequest({
              path: "/ready",
              remoteAddress: "10.0.0.1",
              host: "gateway.test",
              headers: {
                origin: "https://evil.example",
                forwarded: "for=203.0.113.10;proto=https;host=gateway.test",
                "x-forwarded-user": "user@example.com",
                "x-forwarded-proto": "https",
              },
            });
            const { res, getBody } = createResponse();
            await dispatchRequest(server, req, res);

            expect(res.statusCode).toBe(503);
            expect(JSON.parse(getBody())).toEqual({ ready: false });
          },
        });
      },
    });
  });

  it("returns typed internal error payload when readiness evaluation throws", async () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };

    await withGatewayServer({
      prefix: "probe-throws",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/ready" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ ready: false, failing: ["internal"], uptimeMs: 0 });
      },
    });
  });

  it("keeps /healthz shallow even when readiness checker reports failing channels", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 999,
    });

    await withGatewayServer({
      prefix: "probe-healthz-unaffected",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
      },
    });
  });

  it("handles live probes before hook and plugin route stages", async () => {
    const handleHooksRequest = vi.fn(async () => {
      throw new Error("hooks should not run for live probes");
    });
    const handlePluginRequest = vi.fn(async () => {
      throw new Error("plugins should not run for live probes");
    });

    await withGatewayServer({
      prefix: "probe-healthz-fast-path",
      resolvedAuth: AUTH_NONE,
      overrides: { handleHooksRequest, handlePluginRequest },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
        expect(handleHooksRequest).not.toHaveBeenCalled();
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  it("reflects readiness status on HEAD /readyz without a response body", async () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 5_000,
    });

    await withGatewayServer({
      prefix: "probe-readyz-head",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const req = createRequest({ path: "/readyz", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });
});
