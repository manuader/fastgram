import { describe, expect, it } from "vitest";
import {
  checkUrl,
  classifyAddress,
  hostMatchesBlockEntry,
  parseIpv6,
} from "./website-ssrf.js";

const POLICY = { blockedHosts: [] as string[], allowedPorts: [80, 443] };

describe("classifyAddress — rangos que nunca se conectan (NFR-017)", () => {
  const blocked: readonly [string, string][] = [
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["169.254.169.254", "link_local"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["255.255.255.255", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["febf::1", "link_local"],
    ["fc00::1", "unique_local"],
    ["fd12:3456::1", "unique_local"],
    ["fec0::1", "site_local"],
    ["ff02::1", "multicast"],
    // IPv4-mapped: el kernel conecta a la IPv4 embebida.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "link_local"],
    ["::ffff:a00:1", "private"],
    ["[::ffff:192.168.0.1]", "private"],
    ["::127.0.0.1", "reserved"],
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link_local"],
    ["2002:7f00:1::", "loopback"],
    ["2002:c0a8:101::1", "private"],
    ["2001:0:4136:e378::1", "reserved"],
    ["fe80::1%lo0", "link_local"],
  ];
  for (const [ip, reason] of blocked) {
    it(`${ip} → ${reason}`, () => {
      expect(classifyAddress(ip)).toBe(reason);
    });
  }

  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.255.255",
    "100.63.255.255",
    "100.128.0.0",
    "169.253.255.255",
    "11.0.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ];
  for (const ip of allowed) {
    it(`${ip} es pública`, () => {
      expect(classifyAddress(ip)).toBeNull();
    });
  }

  it("un nombre no es una IP: falla cerrado", () => {
    expect(classifyAddress("example.com")).toBe("not_an_ip");
    expect(classifyAddress("")).toBe("not_an_ip");
  });
});

describe("parseIpv6", () => {
  it("expande :: y el cuarteto final", () => {
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIpv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("no")).toBeNull();
  });
});

describe("checkUrl — lo que se decide sin red", () => {
  const reason = (raw: string, policy = POLICY): string | null => {
    const r = checkUrl(new URL(raw), policy);
    return r.ok ? null : r.reason;
  };

  it("formas raras de 127.0.0.1: el parser de URL las normaliza y caen igual", () => {
    // Decimal, octal, hex y abreviada. Si alguna llegara como nombre, iría al
    // DNS; lo que se afirma es que ninguna llega como nombre.
    for (const raw of [
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://0x7f.0.0.1/",
      "http://0x7f000001/",
      "http://127.1/",
      "http://017700000001/",
    ]) {
      expect(new URL(raw).hostname).toBe("127.0.0.1");
      expect(reason(raw)).toBe("loopback");
    }
  });

  it("IPv6 literal, incluida la mapeada", () => {
    expect(reason("http://[::1]/")).toBe("loopback");
    expect(reason("http://[::ffff:127.0.0.1]/")).toBe("loopback");
    expect(reason("http://[::ffff:a9fe:a9fe]/")).toBe("link_local");
  });

  it("localhost y *.localhost se cortan antes del DNS", () => {
    expect(reason("http://localhost/")).toBe("localhost_name");
    expect(reason("http://LOCALHOST./")).toBe("localhost_name");
    expect(reason("http://app.localhost/")).toBe("localhost_name");
  });

  it("sólo http/https", () => {
    expect(reason("file:///etc/passwd")).toBe("scheme");
    expect(reason("ftp://example.com/")).toBe("scheme");
    expect(reason("gopher://example.com/")).toBe("scheme");
  });

  it("puertos: sólo los de la configuración, contando el implícito", () => {
    expect(reason("http://example.com:6379/")).toBe("port");
    expect(reason("http://example.com/")).toBeNull();
    expect(reason("https://example.com/")).toBeNull();
    expect(reason("https://example.com/", { blockedHosts: [], allowedPorts: [80] })).toBe(
      "port",
    );
  });

  it("hosts bloqueados: subdominios, mayúsculas y punto final", () => {
    const policy = { blockedHosts: ["blocked.example"], allowedPorts: [80, 443] };
    expect(reason("http://blocked.example/", policy)).toBe("blocked_host");
    expect(reason("http://BLOCKED.example./", policy)).toBe("blocked_host");
    expect(reason("http://a.b.blocked.example/", policy)).toBe("blocked_host");
    expect(reason("http://notblocked.example/", policy)).toBeNull();
    expect(hostMatchesBlockEntry("x.com", "")).toBe(false);
  });

  it("un nombre público pasa, y queda pendiente de DNS", () => {
    const r = checkUrl(new URL("https://Example.COM./x"), POLICY);
    expect(r).toEqual({ ok: true, host: "example.com", port: 443, literalAddress: null });
  });
});
