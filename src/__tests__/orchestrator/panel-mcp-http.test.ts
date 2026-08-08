import { describe, expect, it } from "vitest";
import type { UiBridge } from "../../services/ui-bridge.js";
import {
  authorizePanelMcpRequest,
  startPanelMcpHttpServer,
} from "../../orchestrator/panel-mcp-http.js";

const token = "0123456789abcdef0123456789abcdef";

describe("panel MCP HTTP request security", () => {
  it("preserves credential-free loopback access for orchestrator-owned agents", () => {
    expect(
      authorizePanelMcpRequest({
        remoteAddress: "::ffff:127.0.0.1",
        hostHeader: "127.0.0.1:9181",
        port: 9181,
        publicHost: "192.168.1.12:9181",
        bearerToken: token,
      }),
    ).toEqual({ ok: true, status: 200 });
  });

  it("does not let a LAN peer spoof the credential-free loopback Host", () => {
    const result = authorizePanelMcpRequest({
      remoteAddress: "192.168.1.22",
      hostHeader: "127.0.0.1:9181",
      port: 9181,
      publicHost: "192.168.1.12:9181",
      bearerToken: token,
    });
    expect(result.status).toBe(403);
  });

  it("requires the exact bearer on the advertised public Host", () => {
    const base = {
      remoteAddress: "192.168.1.22",
      hostHeader: "192.168.1.12:9181",
      port: 9181,
      publicHost: "192.168.1.12:9181",
      bearerToken: token,
    };
    expect(authorizePanelMcpRequest(base).status).toBe(401);
    expect(authorizePanelMcpRequest({ ...base, authorizationHeader: "Bearer wrong" }).status).toBe(401);
    expect(authorizePanelMcpRequest({ ...base, authorizationHeader: `Bearer ${token}` })).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("rejects browser-origin requests even when their bearer is valid", () => {
    const result = authorizePanelMcpRequest({
      remoteAddress: "192.168.1.22",
      hostHeader: "192.168.1.12:9181",
      originHeader: "https://malicious.example",
      authorizationHeader: `Bearer ${token}`,
      port: 9181,
      publicHost: "192.168.1.12:9181",
      bearerToken: token,
    });
    expect(result.status).toBe(403);
  });
});

describe("panel MCP remote configuration", () => {
  const bridge = {} as UiBridge;

  it("fails closed when a non-loopback bind has no public URL", () => {
    expect(() =>
      startPanelMcpHttpServer(bridge, 9181, {
        host: "0.0.0.0",
        bearerToken: token,
      }),
    ).toThrow(/PUBLIC_URL/);
  });

  it("requires the wildcard bind so internal loopback agents remain reachable", () => {
    expect(() =>
      startPanelMcpHttpServer(bridge, 9181, {
        host: "192.168.1.12",
        publicBaseUrl: "http://192.168.1.12:9181",
        bearerToken: token,
      }),
    ).toThrow(/HOST=0\.0\.0\.0/);
  });

  it("fails closed when remote access has no strong token", () => {
    expect(() =>
      startPanelMcpHttpServer(bridge, 9181, {
        host: "0.0.0.0",
        publicBaseUrl: "http://192.168.1.12:9181",
        bearerToken: "short",
      }),
    ).toThrow(/at least 24 characters/);
  });
});
