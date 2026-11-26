export function createDesktopPicker(invoke, { resolveTimeoutMs = 5_000, chooseTimeoutMs = 300_000 } = {}) {
  async function call(command, args, timeoutMs) {
    let timer;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "inaccessible" }), timeoutMs);
      });
      const result = await Promise.race([invoke(command, args), timeout]);
      switch (result?.status) {
        case "chosen": {
          const { path, folderIdentity } = result;
          if (typeof path === "string" && path.startsWith("/") && !path.includes("\0")
              && typeof folderIdentity === "string" && folderIdentity.length > 0) {
            return { status: "chosen", path, folderIdentity };
          }
          break;
        }
        case "invalid":
        case "inaccessible":
        case "cancelled":
          return { status: result.status };
      }
    } catch {
      return { status: "inaccessible" };
    } finally {
      clearTimeout(timer);
    }
    return { status: "inaccessible" };
  }

  return Object.freeze({
    pick: (path) => call("resolve_folder", { path }, resolveTimeoutMs),
    choose: () => call("choose_folder", {}, chooseTimeoutMs),
  });
}
