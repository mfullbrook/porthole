import { describe, expect, test } from "bun:test";
import { parseDockerPs, parseLsof, parseServeStatus, parseTailscaleStatus, toListeners } from "../src/collect/parse.ts";
import { LAUNCHAGENT, loadFixture } from "./helpers.ts";

describe("lsof", () => {
  const c = loadFixture();

  test("parses every binding with its address family", () => {
    expect(c.bindings.length).toBe(76);
    expect(c.bindings.find((b) => b.port === 5173)).toMatchObject({ pid: 18246, family: "IPv6", addr: "::1" });
    expect(c.bindings.find((b) => b.port === 57522)).toMatchObject({ family: "IPv6", addr: "*" });
  });

  test("merges bindings per (pid, port) and classifies binds", () => {
    const ls = toListeners(c.bindings, c.tailscale!.ips);
    const redis = ls.find((l) => l.port === 6379)!;
    expect(redis.binds.map((b) => b.kind).sort()).toEqual(["loopback4", "loopback6"]);
    expect(ls.find((l) => l.port === 8844)!.binds[0]!.kind).toBe("tailscale4");
    expect(ls.find((l) => l.port === 3000)!.binds[0]!.kind).toBe("wildcard6");
    expect(ls.find((l) => l.port === 3100)!.binds[0]!.kind).toBe("wildcard4");
    // nginx workers: one listener per pid on the same port
    expect(ls.filter((l) => l.port === 80).length).toBe(10);
  });

  test("tolerates the pre-`t` launchagent capture (family defaults to IPv4)", () => {
    const old = loadFixture(LAUNCHAGENT);
    expect(old.bindings.length).toBeGreaterThan(70);
  });

  test("ignores junk lines", () => {
    expect(parseLsof("p1\ncfoo\nf3\ntIPv4\nnbogus\n")).toEqual([]);
  });
});

describe("serve status", () => {
  test("parses web handlers with upstreams and HTTP ports", () => {
    const m = loadFixture().serve!;
    expect(m.map((x) => `${x.servePort}${x.path} ${x.https ? "https" : "http"} -> ${x.upstream?.host}:${x.upstream?.port}${x.upstream?.path}`)).toEqual([
      "443/ https -> 127.0.0.1:7317",
      "443/rc https -> 127.0.0.1:8765/rc",
      "4330/ http -> 127.0.0.1:4332",
      "6006/ https -> 127.0.0.1:6006",
    ]);
  });

  test("handles bare-port and ipv6 proxies, and empty output", () => {
    const m = parseServeStatus(JSON.stringify({
      TCP: { "8443": { HTTPS: true } },
      Web: { "h:8443": { Handlers: { "/": { Proxy: "http://[::1]:5173" }, "/x": { Proxy: "3000" } } } },
    }));
    expect(m[0]!.upstream).toEqual({ scheme: "http", host: "::1", port: 5173, path: "" });
    expect(m[1]!.upstream).toEqual({ scheme: "http", host: "127.0.0.1", port: 3000, path: "" });
    expect(parseServeStatus("")).toEqual([]);
  });
});

describe("tailscale status", () => {
  test("reduced fixture: user-owned node has an owner", () => {
    expect(loadFixture().tailscale).toEqual({
      hostName: "mac-mini",
      fqdn: "mac-mini.tail0a1b2c.ts.net",
      ips: ["100.101.102.103", "fd7a:115c:a1e0::1234:5678"],
      ownerLogin: "alice@github",
      tagged: false,
    });
  });

  test("full form reads the owner from User[Self.UserID]; a tagged node has no owner", () => {
    const full = { Self: { DNSName: "m.t.ts.net.", UserID: 7, TailscaleIPs: [] }, User: { "7": { LoginName: "a@b" } } };
    expect(parseTailscaleStatus(JSON.stringify(full)).ownerLogin).toBe("a@b");
    const tagged = { ...full, Self: { ...full.Self, Tags: ["tag:server"] } };
    expect(parseTailscaleStatus(JSON.stringify(tagged))).toMatchObject({ ownerLogin: null, tagged: true });
  });
});

describe("docker ps", () => {
  test("parses publications and compose project", () => {
    expect(loadFixture().docker).toEqual([
      { name: "open-webui-hermes", image: "ghcr.io/open-webui/open-webui:main", composeProject: "open-webui-hermes", publications: [{ hostIp: "127.0.0.1", hostPort: 6006, containerPort: 8080 }] },
    ]);
  });

  test("expands port ranges and ipv6 publications", () => {
    const [c] = parseDockerPs(JSON.stringify({ Names: "db", Ports: "0.0.0.0:5432-5433->5432-5433/tcp, [::]:80->80/tcp" }));
    expect(c!.publications.map((p) => `${p.hostIp}:${p.hostPort}->${p.containerPort}`)).toEqual(["0.0.0.0:5432->5432", "0.0.0.0:5433->5433", ":::80->80"]);
  });
});
