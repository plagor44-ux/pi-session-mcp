/** Synthetic secrets for the history redaction tests; none of them is real. */
export const alnum = (n: number, seed = "aB3"): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
export const b64url = (value: string): string => Buffer.from(value).toString("base64url");

export const SENTINELS = {
  github_token: `ghp_${alnum(36, "Qx7")}`,
  github_pat: `github_pat_${alnum(82, "K9_z")}`,
  anthropic: `sk-ant-api03-${alnum(40, "Rt5")}`,
  openai: `sk-${alnum(48, "Mn2")}`,
  aws: `AKIA${"JX4Q".repeat(4)}`,
  slack: "xoxb-1-2-abc",
  jwt: `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"sentinel-subject"}')}.${alnum(43, "sIg")}`,
  pem: `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nSENTINELPEMBODYLINE2\n-----END OPENSSH PRIVATE KEY-----`,
  url: "https://u:p4ssw0rd@host/x",
  assignment: "PASSWORD=hunter2hunter2",
  known: "KNOWN_9f2c_long_value",
} as const;

/** The secret part of each sentinel, which must never survive. */
export const SECRET_PARTS = [
  SENTINELS.github_token, SENTINELS.github_pat, SENTINELS.anthropic, SENTINELS.openai, SENTINELS.aws,
  SENTINELS.slack, SENTINELS.jwt, "SENTINELPEMBODYLINE2", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
  "p4ssw0rd", "hunter2hunter2", SENTINELS.known,
];
