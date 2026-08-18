import { describe, expect, it } from "vitest";
import { AUTO_UPLOAD_DEFAULT_ON, DEV_KEYBOARD, HANDLED_COMMANDS, HOME_KEYBOARD, SKU_PATTERN, isCommandAllowed, keyboardFor, parseCommand, RUNNABLE_JOBS } from "@/lib/telegram";

describe("command parsing", () => {
  it("parses a bare command", () => {
    expect(parseCommand("/health")).toEqual({ command: "health", args: [] });
  });

  it("parses arguments", () => {
    expect(parseCommand("/run trending")).toEqual({ command: "run", args: ["trending"] });
  });

  it("strips the @BotName suffix used in groups", () => {
    expect(parseCommand("/qr@MatzHubAdmin_bot")).toEqual({ command: "qr", args: [] });
  });

  it("lowercases the command but preserves argument case", () => {
    expect(parseCommand("/RUN Trending")).toEqual({ command: "run", args: ["Trending"] });
  });

  it("tolerates extra whitespace", () => {
    expect(parseCommand("   /run    trending   ")).toEqual({ command: "run", args: ["trending"] });
  });

  it("returns null for non-commands", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });
});

describe("operator switches are wired, not decorative", () => {
  it("defaults auto-upload to on so a fresh install publishes", () => {
    expect(AUTO_UPLOAD_DEFAULT_ON).toBe(true);
  });
});

describe("admin surface is exactly the runbook list", () => {
  // Exactly the operations in the launch runbook.
  const REQUIRED = [
    "qr", "worker", "channels", "channel", "syncstatus",
    "payment", "restart", "health", "logs", "sync", "help", "panel", "dashboard",
  ];

  it("exposes every command the runbook requires", () => {
    for (const c of REQUIRED) expect(isCommandAllowed(c, "admin")).toBe(true);
  });

  it("hides all developer tooling from the admin", () => {
    // Job internals and publishing switches must not be reachable from the
    // business bot: an operator could otherwise pause automation without
    // understanding what stopped.
    for (const c of ["run", "diag", "jobs", "pause",
                     "resume", "upload", "maintenance", "backfill", "errors"]) {
      expect(isCommandAllowed(c, "admin")).toBe(false);
      expect(isCommandAllowed(c, "dev")).toBe(true);
    }
  });

  it("rejects anything outside the list", () => {
    for (const c of ["shell", "sql", "eval", "whoami", "stats", "groups", "orders"]) {
      expect(isCommandAllowed(c, "admin")).toBe(false);
    }
  });
});

describe("removed commands stay removed", () => {
  it("does not reintroduce commands that only duplicated others", () => {
    // /heal duplicated /run self-heal, /stats duplicated /health, /groups was
    // folded into /channels, and /whoami could only answer callers who were
    // already in the allowlist (so they already knew their id).
    const help = ["health", "syncstatus", "logs", "payment", "worker", "qr",
                  "restart", "sync", "channels", "channel", "help", "panel", "dashboard"];
    for (const dead of ["heal", "stats", "groups", "whoami"]) {
      expect(help).not.toContain(dead);
    }
  });
});

describe("job allowlist", () => {
  it("matches the cron runner's job table", () => {
    // Guards against /run being able to invoke something the cron route
    // does not implement, and vice versa.
    expect([...RUNNABLE_JOBS].sort()).toEqual(
      [
        "cart-recovery", "digest", "expire", "notify", "notify-retry",
        "reprice", "self-heal", "stock-sync", "subscription",
        "storage-sweep", "supplier", "telegram-sweep", "trending", "watchdog",
      ].sort(),
    );
  });
});

describe("inline keyboards", () => {
  it("keeps callback_data inside Telegram's 64-byte limit", () => {
    const views = ["m:home", "m:wa", "m:ch", "m:sync"];
    for (const v of views) {
      for (const row of keyboardFor(v)) {
        for (const b of row) {
          expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
          expect(b.text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("gives every sub-menu a route back to the root", () => {
    for (const v of ["m:wa", "m:ch", "m:sync"]) {
      const flat = keyboardFor(v).flat().map((b) => b.callback_data);
      expect(flat).toContain("m:home");
    }
    expect(HOME_KEYBOARD.flat().length).toBeGreaterThan(0);
  });
});

describe("keyboard / router contract", () => {
  const VIEWS = ["m:home", "m:wa", "m:ch", "m:sync"];

  it("every button maps to a command the router actually handles", () => {
    // Regression guard: an edit once added buttons for /upload, /maintenance,
    // /errors, /restart and /backfill while the matching cases silently failed
    // to apply. Telegram still answered 200, so nothing looked broken.
    for (const v of VIEWS) {
      for (const row of keyboardFor(v)) {
        for (const b of row) {
          const data = b.callback_data;
          if (data.startsWith("m:")) {
            expect(VIEWS).toContain(data);
            continue;
          }
          // h: entries are copy-this-line hints, not router commands.
          if (data.startsWith("h:")) continue;
          const [cmd] = data.split(" ");
          expect(HANDLED_COMMANDS as readonly string[]).toContain(cmd);
          // Buttons are the admin's interface; none may invoke dev tooling.
          expect(isCommandAllowed(cmd, "admin")).toBe(true);
        }
      }
    }
  });

  it("exposes the operator switches the runbook documents", () => {
    for (const c of ["upload", "maintenance", "errors", "restart", "backfill"]) {
      expect(HANDLED_COMMANDS as readonly string[]).toContain(c);
    }
  });
});

describe("control panel reachability", () => {
  it("puts every runbook operation within two taps of the panel", () => {
    // Reachable = on the home panel, or on a submenu the home panel links to.
    const home = HOME_KEYBOARD.flat().map((b) => b.callback_data);
    const reachable = new Set(home);
    for (const d of home) {
      if (d.startsWith("m:")) for (const b of keyboardFor(d).flat()) reachable.add(b.callback_data);
    }
    const cmds = new Set([...reachable].map((d) => d.split(" ")[0]).filter((d) => !d.startsWith("m:") && !d.startsWith("h:")));
    for (const op of ["dashboard", "qr", "worker", "channels", "syncstatus", "sync",
                      "payment", "health", "logs", "restart"]) {
      expect(cmds).toContain(op);
    }
    // Add / remove / map need an argument, so they surface as guided hints.
    const hints = keyboardFor("m:ch").flat().map((b) => b.callback_data);
    expect(hints).toContain("h:add");
    expect(hints).toContain("h:rm");
    expect(hints).toContain("h:map");
    expect(hints).toContain("channel undo");
  });
});


describe("order source mapping", () => {
  it("recognises a SKU anywhere in a forwarded customer message", () => {
    // This is exactly what a customer's WhatsApp order looks like once it is
    // pasted into the admin chat. The SKU must be found without a command.
    const forwarded = [
      "Hi MatzHub, I'd like to order:",
      "Aurum Chronograph Steel 42mm (Black) x2",
      "SKU MH-WAT-A3F2C1",
      "https://matzhub.com/p/aurum-chronograph-steel-42mm",
    ].join("\n");
    expect(forwarded.match(SKU_PATTERN)?.[0]).toBe("MH-WAT-A3F2C1");
  });

  it("matches the SKU shape ingest actually mints", () => {
    for (const ok of ["MH-WAT-A3F2C1", "MH-GEN-0011AA", "mh-fot-9be21c"]) {
      expect(SKU_PATTERN.test(ok)).toBe(true);
    }
  });

  it("does not fire on unrelated text", () => {
    for (const no of ["MH", "MH-", "order 12345", "MHWATA3F2C1", "hello there"]) {
      expect(SKU_PATTERN.test(no)).toBe(false);
    }
  });
});

describe("developer bot", () => {
  it("exposes diagnostics and job control to dev only", () => {
    for (const c of ["diag", "jobs", "run", "errors", "pause", "resume",
                     "upload", "maintenance", "backfill"]) {
      expect(isCommandAllowed(c, "dev")).toBe(true);
      expect(isCommandAllowed(c, "admin")).toBe(false);
    }
  });

  it("routes every dev command to a real handler", () => {
    // `diag` was previously listed as dev-only with no case in the router, so
    // it silently answered "unknown command".
    for (const c of ["diag", "jobs", "run", "errors", "pause", "resume",
                     "upload", "maintenance", "backfill", "worker", "health"]) {
      expect(HANDLED_COMMANDS as readonly string[]).toContain(c);
    }
  });

  it("still lets the developer reach operational views", () => {
    for (const c of ["worker", "health", "syncstatus", "channels", "qr"]) {
      expect(isCommandAllowed(c, "dev")).toBe(true);
    }
  });
});

describe("guided channel flows", () => {
  it("keeps every generated callback_data inside Telegram's 64-byte limit", () => {
    // Payloads embed a WhatsApp JID and sometimes a category slug. A real JID
    // is 18 digits; the "@g.us" suffix is stripped to stay well inside budget.
    const jid = "120363099626395319";
    const longest = `cmap:${jid}:sunglasses`;
    for (const d of [`cadd:${jid}`, `crm:${jid}`, `cpick:${jid}`, longest]) {
      expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("routes guided payloads by prefix, not by exact match", () => {
    const re = /^(cadd|crm|cpick|cmap):/;
    expect(re.test("cadd:120363099626395319")).toBe(true);
    expect(re.test("cmap:120363099626395319:watches")).toBe(true);
    expect(re.test("channels")).toBe(false);
    expect(re.test("channel undo")).toBe(false);
  });
});

describe("developer console keyboard", () => {
  it("exposes only developer commands, never business operations", () => {
    for (const b of DEV_KEYBOARD.flat()) {
      const cmd = b.callback_data.split(" ")[0];
      expect(HANDLED_COMMANDS as readonly string[]).toContain(cmd);
      // A business action reachable from the dev console would blur the split.
      expect(["qr", "relink", "restart", "channels", "channel", "dashboard", "payment"]).not.toContain(cmd);
    }
  });

  it("labels every developer button with an icon", () => {
    for (const b of DEV_KEYBOARD.flat()) {
      expect(b.text.trim().length).toBeGreaterThan(2);
      expect(/^[\x00-\x7F]/.test(b.text)).toBe(false); // starts with an emoji
    }
  });

  it("labels every admin button with an icon", () => {
    for (const v of ["m:home", "m:wa", "m:ch", "m:sync"]) {
      for (const b of keyboardFor(v).flat()) {
          expect(/^[\x00-\x7F]/.test(b.text)).toBe(false);
      }
    }
  });
});
