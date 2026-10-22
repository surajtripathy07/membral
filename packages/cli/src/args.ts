// Minimal `--flag value` / `--flag` (boolean) parser shared by the CLI's
// subcommands. Deliberately tiny — no positional-arg or general `-x`
// short-flag support, since none of the current commands need it. The one
// exception is `-h`, aliased to `--help` (ADR 0050 §2.3) — everything else
// stays a `--long-flag`.
export type Flags = Record<string, string | boolean>;

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return flags;
}

export function stringFlag(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(flags: Flags, key: string): boolean {
  return flags[key] === true;
}
