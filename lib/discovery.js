/**
 * discovery.js — mDNS advertise + browse (LocalSend-style zero-config
 * discovery on the LAN). Optional by design: if bonjour-service is missing
 * or the network blocks multicast, discovery degrades to an empty list and
 * manually-configured peer URLs keep working.
 */
const SERVICE_TYPE = "dsh-workspace-sync";

async function loadBonjour(log) {
  try {
    const mod = await import("bonjour-service");
    return mod.Bonjour ? mod : null;
  } catch (e) {
    if (log) log("mDNS unavailable (bonjour-service not installed): discovery disabled — " + String((e && e.message) || e));
    return null;
  }
}

/**
 * Advertise this machine until stop() is called.
 * @returns {Promise<{stop: () => Promise<void>}>}
 */
export async function startAdvertising({ deviceName, port, deviceId, log }) {
  const mod = await loadBonjour(log);
  if (!mod) return { stop: async () => {} };
  try {
    const bonjour = new mod.Bonjour();
    // host MUST NOT default: bonjour-service falls back to os.hostname() and
    // publishes A records for the SYSTEM hostname through its own responder —
    // macOS's mDNSResponder then sees the name as claimed, renames the local
    // hostname with a numeric suffix and pops a dialog at every boot
    // (juweideMac-mini-301 → -367 …). Advertise under a deviceId-derived name;
    // peers connect via resolved IP addresses, never via this host name.
    const hostTag = String(deviceId || "anon").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 12) || "anon";
    const host = "dsh-wss-" + hostTag + ".local";
    const baseTxt = { id: String(deviceId), v: "1" };
    let currentTxt = { ...baseTxt };
    let svc = null;
    const publishNow = () => {
      svc = bonjour.publish({ name: "dsh-sync " + deviceName, type: SERVICE_TYPE, port, host, txt: currentTxt });
      svc.on("error", (e) => log && log("mDNS publish error: " + String((e && e.message) || e)));
    };
    publishNow();
    return {
      /** Swap TXT records (pairing-offer beacon) — republish; the library has
       *  no in-place TXT update. Empty-string values are dropped. */
      async setTxt(extra) {
        currentTxt = { ...baseTxt, ...extra };
        for (const k of Object.keys(currentTxt)) {
          if (currentTxt[k] === "" || currentTxt[k] === undefined) delete currentTxt[k];
        }
        try {
          await new Promise((done) => bonjour.unpublishAll(() => done()));
          publishNow();
        } catch (e) {
          if (log) log("mDNS re-publish failed: " + String((e && e.message) || e));
        }
      },
      stop: () =>
        new Promise((done) => {
          try {
            bonjour.unpublishAll(() => {
              try {
                bonjour.destroy();
              } catch {}
              done();
            });
          } catch {
            done();
          }
        }),
    };
  } catch (e) {
    if (log) log("mDNS advertise failed: " + String((e && e.message) || e));
    return { stop: async () => {} };
  }
}

/**
 * Browse the LAN for dsh-workspace-sync peers.
 * @returns {Promise<Array<{id:string, name:string, host:string, port:number, url:string}>>}
 */
export async function browsePeers({ timeoutMs = 4000, log } = {}) {
  const mod = await loadBonjour(log);
  if (!mod) return [];
  return new Promise((done) => {
    const found = new Map();
    try {
      const bonjour = new mod.Bonjour();
      const browser = bonjour.find({ type: SERVICE_TYPE });
      browser.on("up", (svc) => {
        const id = svc.txt && svc.txt.id ? String(svc.txt.id) : String(svc.fqdn || svc.name);
        if (!found.has(id)) {
          found.set(id, {
            id,
            name: String(svc.name || id).replace(/^dsh-sync\s+/, ""),
            host: String(svc.addresses && svc.addresses[0] ? svc.addresses[0] : svc.host || ""),
            port: Number(svc.port) || 0,
            url: "http://" + (svc.addresses && svc.addresses[0] ? svc.addresses[0] : svc.host) + ":" + svc.port,
            pair: svc.txt && svc.txt.pair ? String(svc.txt.pair) : "",
          });
        }
      });
      browser.on("error", () => {});
      setTimeout(() => {
        try {
          browser.stop();
          bonjour.destroy();
        } catch {}
        done([...found.values()]);
      }, Math.max(500, timeoutMs));
    } catch (e) {
      if (log) log("mDNS browse failed: " + String((e && e.message) || e));
      done([]);
    }
  });
}
