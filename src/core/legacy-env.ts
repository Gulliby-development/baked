// Environment variables used to be spelled `baked_*`. Map any that are still
// set to their `BAKED_*` names before other modules read them at import time.
// Windows environment names are case-insensitive, so there is nothing to map.
if (process.platform !== "win32") {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("baked_") || value === undefined) continue;
    const current = `BAKED_${key.slice("baked_".length)}`;
    if (process.env[current] === undefined) process.env[current] = value;
  }
}
