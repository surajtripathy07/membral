import { describe, expect, it } from "vitest";
import { redactCommandSecrets, redactFileSecrets, redactPii, redactSecrets } from "../../sessions/redact.js";

// Secret-shaped values are assembled at runtime so no source literal matches a secret scanner.
const AKIA_KEY = "AKIA" + "A".repeat(16);
const GHP = "ghp" + "_" + "a".repeat(30);
const PEM_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_BEGIN_RSA = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");

describe("redactSecrets", () => {
  it("redacts AWS access key ids", () => {
    const out = redactSecrets(`my key is ${AKIA_KEY}, don't commit it`);
    expect(out).toBe("my key is [REDACTED], don't commit it");
  });

  it("redacts a labeled AWS secret access key, keeping the label", () => {
    const out = redactSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY123456");
    expect(out).toBe("aws_secret_access_key=[REDACTED]");
  });

  it("redacts sk- style API keys", () => {
    const out = redactSecrets("set OPENAI_API_KEY to sk-testFAKEKEY1234567890abcdef in .env");
    expect(out).toBe("set OPENAI_API_KEY to [REDACTED] in .env");
  });

  it("redacts lls_ style API keys", () => {
    const out = redactSecrets("use lls_abcdefghijklmnopqrstuvwx as the CLI key");
    expect(out).toBe("use [REDACTED] as the CLI key");
  });

  it("redacts GitHub tokens", () => {
    const out = redactSecrets(`token: ${GHP}`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(GHP);
  });

  it("redacts Bearer tokens, keeping the Bearer label", () => {
    const out = redactSecrets("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test'");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts password= assignments, keeping the key name", () => {
    expect(redactSecrets("password=hunter2verysecret")).toBe("password=[REDACTED]");
    expect(redactSecrets('PASSWORD: "hunter2 with spaces"')).toBe("PASSWORD: [REDACTED]");
  });

  it("redacts generic labeled secrets (token=, secret=, api_key=)", () => {
    expect(redactSecrets("api_key=abcd1234efgh5678ijkl")).toBe("api_key=[REDACTED]");
    expect(redactSecrets("secret: superlongrandomvaluehere1234")).toBe("secret: [REDACTED]");
  });

  it("does not touch ordinary prose or code identifiers", () => {
    const prose =
      "Let's rename getUserProfile to fetchUserProfile and update the healthCheckHandler in routes/health.ts.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not touch git-like SHAs or plain long identifiers mentioned in prose", () => {
    const prose = "Reverted to commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 to fix the regression.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("does not touch the bare word 'password' without an assignment", () => {
    const prose = "Ask the user to reset their password from the account settings page.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("returns empty/falsy input unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("redacts lls_/llk_ keys containing base64url - and _ characters", () => {
    expect(redactSecrets("key is lls_ab-cdefghijklmnop1234efgh ok")).toBe("key is [REDACTED] ok");
    expect(redactSecrets("llk_aa_bb-ccddeeff00112233")).toBe("[REDACTED]");
  });
});

describe("redactCommandSecrets — shell-command credential shapes, command digests only", () => {
  it("redacts `--token X`, `--token=X`, `--password X` and `--api-key X` values, keeping the flag", () => {
    expect(redactCommandSecrets("npx vercel --prod --token abc123")).toBe("npx vercel --prod --token [REDACTED]");
    expect(redactCommandSecrets("gh auth login --token=abcd1234")).toBe("gh auth login --token=[REDACTED]");
    expect(redactCommandSecrets("cli --password 'hunter 2'")).toBe("cli --password [REDACTED]");
    expect(redactCommandSecrets("cli --api-key k1")).toBe("cli --api-key [REDACTED]");
  });

  it("redacts a password glued to `-p` but leaves letter-only flags like `-pthread` alone", () => {
    expect(redactCommandSecrets("mysql -uroot -pS3cret! db")).toBe("mysql -uroot -p[REDACTED] db");
    expect(redactCommandSecrets("gcc -pthread main.c")).toBe("gcc -pthread main.c");
    expect(redactCommandSecrets("mkdir -p out")).toBe("mkdir -p out");
  });

  it("leaves a port glued to `-p` and flag words like `-print0` alone", () => {
    expect(redactCommandSecrets("docker run -p8080:80 img")).toBe("docker run -p8080:80 img");
    expect(redactCommandSecrets("ssh -p2222 host")).toBe("ssh -p2222 host");
    expect(redactCommandSecrets("docker run -p127.0.0.1:5432:5432/tcp db")).toBe(
      "docker run -p127.0.0.1:5432:5432/tcp db",
    );
    expect(redactCommandSecrets("find . -print0")).toBe("find . -print0");
  });

  it("redacts upper-case `PGPASSWORD=`, `*_KEY=`, `*_TOKEN=` and `*_SECRET=` env values, keeping the name", () => {
    expect(redactCommandSecrets("PGPASSWORD=x psql")).toBe("PGPASSWORD=[REDACTED] psql");
    expect(redactCommandSecrets("API_TOKEN=xyz gh api")).toBe("API_TOKEN=[REDACTED] gh api");
    expect(redactCommandSecrets(`STRIPE_KEY=${"sk_" + "live_1"} GH_TOKEN=t APP_SECRET=s npm test`)).toBe(
      "STRIPE_KEY=[REDACTED] GH_TOKEN=[REDACTED] APP_SECRET=[REDACTED] npm test",
    );
    expect(redactCommandSecrets("git log --format=x sort_key=created_at")).toBe(
      "git log --format=x sort_key=created_at",
    );
  });
});

describe("redactSecrets — prose keeps ports, column names and talk about flags", () => {
  it.each([
    "run `docker run -p8080:80` locally",
    "then `ssh -p2222 box`",
    "order by sort_key=created_at",
    "the table has PRIMARY_KEY=id",
    "use the --token flag; set -p later",
  ])("leaves %j unchanged", (prose) => {
    expect(redactSecrets(prose)).toBe(prose);
  });
});

describe("redactPii", () => {
  it("redacts an E.164 phone number", () => {
    expect(redactPii("call me at +15551234567 today")).toBe("call me at [redacted] today");
  });

  it("redacts a spaced international phone number", () => {
    expect(redactPii("Sent to your number (+1 55512 34567) — done")).toBe("Sent to your number ([redacted]) — done");
  });

  it("redacts a dashed/dotted local phone number", () => {
    expect(redactPii("reach the office at 555-123-4567 please")).toBe("reach the office at [redacted] please");
    expect(redactPii("or 555.123.4567")).toBe("or [redacted]");
  });

  it("redacts a parenthesized local phone number", () => {
    expect(redactPii("(555) 123-4567 is the line")).toBe("[redacted] is the line");
  });

  it("does not touch a bare digit run (a git sha or issue id must survive)", () => {
    expect(redactPii("commit 1234567890 fixed it")).toBe("commit 1234567890 fixed it");
    expect(redactPii("see issues 133 through 138")).toBe("see issues 133 through 138");
  });

  it("redacts an email address", () => {
    expect(redactPii("ping jane.doe@example.com about it")).toBe("ping [redacted] about it");
  });

  // step2d finding 2 (docs/goals/2026-09-13_memory-v1-build_goal.md, issue
  // #151): home-directory paths are NOT PII — `redactPii` no longer touches
  // them (see this file's own header comment for why). Path correctness
  // (repo-relative vs. off-repo) is handled by memory/paths.ts instead.
  it("does not redact an absolute home path — paths are a correctness concern, not PII", () => {
    expect(redactPii("see ~/dev/life/fd-notes.md for the ruling")).toBe("see ~/dev/life/fd-notes.md for the ruling");
    expect(redactPii("copied from /Users/jane/Documents/taxes.pdf")).toBe(
      "copied from /Users/jane/Documents/taxes.pdf",
    );
  });

  it("does not touch ordinary prose", () => {
    const prose = "Let's rename getUserProfile to fetchUserProfile.";
    expect(redactPii(prose)).toBe(prose);
  });

  it("returns empty/falsy input unchanged", () => {
    expect(redactPii("")).toBe("");
  });
});

// Fictional placeholders only: none of these is, or looks like, a live credential.
describe("redactSecrets — structured secret shapes (written file text)", () => {
  it("redacts a JWT", () => {
    const jwt = ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(20), "c".repeat(20)].join(".");
    expect(redactSecrets(`auth = ${jwt} end`)).toBe("auth = [REDACTED] end");
  });

  it("does not touch a short eyJ-prefixed word", () => {
    expect(redactSecrets("eyJ.a.b is not a token")).toBe("eyJ.a.b is not a token");
  });

  it("redacts a PEM private-key block, BEGIN through END", () => {
    const pem = `${PEM_BEGIN_RSA}\nTESTONLY000\nTESTONLY000\n-----END RSA PRIVATE KEY-----`;
    expect(redactSecrets(`before\n${pem}\nafter`)).toBe("before\n[REDACTED]\nafter");
  });

  it("redacts a PEM block with no END line through the end of the text", () => {
    expect(redactSecrets(`x\n${PEM_BEGIN}\nTESTONLY000`)).toBe("x\n[REDACTED]");
  });

  it("keeps a URL's user and host, redacts its password", () => {
    expect(redactSecrets(`DATABASE at ${"postgres" + "://"}app:placeholder_pw@db.codehub.test:5432/app`)).toBe(
      `DATABASE at ${"postgres" + "://"}app:[REDACTED]@db.codehub.test:5432/app`,
    );
  });

  it("leaves a URL without credentials alone", () => {
    const s = "see https://codehub.test:8443/path?a=1";
    expect(redactSecrets(s)).toBe(s);
  });

  it("redacts quoted JSON/YAML secret-key values, case-insensitive, keeping the key", () => {
    expect(redactSecrets(`{"api_key": "${"sk_" + "test_000"}", "name": "x"}`)).toBe(
      '{"api_key": "[REDACTED]", "name": "x"}',
    );
    expect(redactSecrets('"Password":"placeholder"')).toBe('"Password":"[REDACTED]"');
    expect(redactSecrets('"private-key": "TESTONLY"')).toBe('"private-key": "[REDACTED]"');
    expect(redactSecrets('"token" : "t0"')).toBe('"token" : "[REDACTED]"');
  });

  it("leaves non-secret quoted keys alone", () => {
    const s = '{"tokenizer": "bpe", "secretary": "x"}';
    expect(redactSecrets(s)).toBe(s);
  });
});

// Fictional placeholders only: each is shaped like a credential, none is a live one.
describe("redactFileSecrets — written file text", () => {
  it.each([
    ["glp" + "at-0000000000000000000a", "Git" + "Lab PAT"],
    ["git" + "hub_pat_00000000000000000000_placeholder", "GitHub fine-grained PAT"],
    ["xox" + "b-0000000000-placeholder", "Slack bot token"],
    ["xox" + "p-0000000000-placeholder", "Slack user token"],
    ["sk_" + "live_0000000000placeholder", "Stripe live secret key"],
    ["sk_" + "test_0000000000placeholder", "Stripe test secret key"],
    ["rk_" + "live_0000000000placeholder", "Stripe restricted key"],
    ["pk_" + "test_0000000000placeholder", "Stripe publishable test key"],
    ["AIz" + "a000000000000000000000000000000placeh", "Google API key"],
    ["ghs" + "_000000000000000000000000placeholder", "GitHub server token"],
    ["gho" + "_000000000000000000000000placeholder", "GitHub OAuth token"],
    ["ghu" + "_000000000000000000000000placeholder", "GitHub user token"],
    ["ghr" + "_000000000000000000000000placeholder", "GitHub refresh token"],
    ["npm" + "_000000000000000000000000000000placeholder", "npm token"],
    ["AKI" + "A0000000000PLACEH", "AWS access key id"],
    ["ASI" + "A0000000000PLACEH", "AWS temporary access key id"],
  ])("redacts a bare %s (%s), in prose too", (token) => {
    expect(redactFileSecrets(`use ${token} here`)).toBe("use [REDACTED] here");
    expect(redactSecrets(`use ${token} here`)).toBe("use [REDACTED] here");
  });

  it("redacts Authorization Basic and Bearer of any length, keeping the scheme", () => {
    expect(redactFileSecrets("Authorization: Basic dTpw")).toBe("Authorization: Basic [REDACTED]");
    expect(redactFileSecrets("Authorization: Bearer abc")).toBe("Authorization: Bearer [REDACTED]");
    expect(redactFileSecrets('{"Authorization": "Bearer abc"}')).toBe('{"Authorization": "Bearer [REDACTED]"}');
  });

  it("redacts X-Api-Key, Api-Key and X-Auth-Token header values", () => {
    expect(redactFileSecrets("X-Api-Key: abc123")).toBe("X-Api-Key: [REDACTED]");
    expect(redactFileSecrets("api-key: abc123")).toBe("api-key: [REDACTED]");
    expect(redactFileSecrets("X-Auth-Token: abc123")).toBe("X-Auth-Token: [REDACTED]");
  });

  it.each([
    ["SECRET_KEY: abc", "SECRET_KEY: [REDACTED]"],
    ["client_secret: abc", "client_secret: [REDACTED]"],
    ["Stripe_Secret_Key=abc", "Stripe_Secret_Key=[REDACTED]"],
    ["SECRETKEY=abc", "SECRETKEY=[REDACTED]"],
    ["TOKEN=abcd1234", "TOKEN=[REDACTED]"],
    ['"client_secret": "abc"', '"client_secret": "[REDACTED]"'],
    ['"accessToken": "abc"', '"accessToken": "[REDACTED]"'],
    ["secret: 'abc'", "secret: '[REDACTED]'"],
    ["db_passwd: abc", "db_passwd: [REDACTED]"],
    ["private_key=abc", "private_key=[REDACTED]"],
    ["signingKey: abc", "signingKey: [REDACTED]"],
    ["SERVICE_CREDENTIALS=abc", "SERVICE_CREDENTIALS=[REDACTED]"],
    ["basic_auth: abc", "basic_auth: [REDACTED]"],
    ["export DEPLOY_KEY=abc", "export DEPLOY_KEY=[REDACTED]"],
  ])("key/value: %j -> %j", (input, expected) => {
    expect(redactFileSecrets(input)).toBe(expected);
  });

  it.each([
    "the token budget is 4,000",
    "password reset flow",
    "author: Jane Placeholder",
    "const token = await getToken();",
    "if (token === other) return;",
  ])("leaves %j unchanged", (s) => {
    expect(redactFileSecrets(s)).toBe(s);
  });

  it("redacts a URL password with an empty or a named user", () => {
    expect(redactFileSecrets("redis://:placeholder@cache.codehub.test:6379")).toBe(
      "redis://:[REDACTED]@cache.codehub.test:6379",
    );
    expect(redactFileSecrets("amqp://app:placeholder@mq.codehub.test")).toBe("amqp://app:[REDACTED]@mq.codehub.test");
  });

  it("redacts npmrc _authToken and _auth values", () => {
    expect(redactFileSecrets("//registry.codehub.test/:_authToken=placeholder")).toBe(
      "//registry.codehub.test/:_authToken=[REDACTED]",
    );
    expect(redactFileSecrets("_auth=placeholder")).toBe("_auth=[REDACTED]");
  });

  it("redacts netrc login and password, on a machine line and standalone", () => {
    expect(redactFileSecrets("machine api.codehub.test login dev password placeholder")).toBe(
      "machine api.codehub.test login [REDACTED] password [REDACTED]",
    );
    expect(redactFileSecrets("machine api.codehub.test\n  login dev\n  password placeholder\n")).toBe(
      "machine api.codehub.test\n  login [REDACTED]\n  password [REDACTED]\n",
    );
  });

  it("redacts the last field of a pgpass line", () => {
    expect(redactFileSecrets(["db.codehub.test", "5432", "app", "dev", "placeholder"].join(":"))).toBe(
      ["db.codehub.test", "5432", "app", "dev", "[REDACTED]"].join(":"),
    );
    expect(redactFileSecrets("*:*:*:dev:placeholder")).toBe("*:*:*:dev:[REDACTED]");
  });
});
