/**
 * pair.js — pairing codes. The whole trust model in one string.
 *
 * A pair code is `DSS1.<base64url(json)>` carrying this machine's identity,
 * LAN URL and door token. Exchange it over any channel you already trust
 * (chat, AirDrop, USB stick). Import stores the peer; from then on only
 * token-bearing requests are answered (transport.js enforces this).
 *
 * 巨维 2026-09-02 裁示: plaintext LAN transfer, no TLS. The token is
 * authorization, not encryption — it stops strangers on a shared network
 * from writing into the workspace; it does not stop them from reading
 * sniffed traffic. Documented in DESIGN.md §9.
 */
import { bestLanUrl } from "./config.js";

const PREFIX = "DSS1.";

/** @param {{deviceId:string, deviceName:string, port:number, token:string}} machine */
export function makePairCode(machine) {
  const payload = {
    v: 1,
    id: machine.deviceId,
    name: machine.deviceName,
    url: bestLanUrl(machine.port),
    token: machine.token,
  };
  return PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Parse a pair code into a peer record. Throws on garbage. */
export function parsePairCode(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith(PREFIX)) throw new Error("不是有效的配对码（应以 " + PREFIX + " 开头）");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("配对码内容无法解析（可能被截断或篡改）");
  }
  if (!payload || payload.v !== 1 || typeof payload.id !== "string" || typeof payload.token !== "string" || typeof payload.url !== "string") {
    throw new Error("配对码字段不完整");
  }
  return {
    id: payload.id,
    name: String(payload.name || payload.id),
    url: payload.url.replace(/\/+$/, ""),
    token: payload.token,
    addedAt: new Date().toISOString(),
  };
}
