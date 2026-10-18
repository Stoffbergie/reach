const SOURCE_URL = "https://github.com/Stoffbergie/reach";
const TAGLINE = "Reach any shell from anywhere.";

const STYLE = `
:root{--bg:#fafafa;--fg:#171717;--muted:#737373;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--muted:#8f8f8f}}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg);color:var(--fg);font:14px/1.7 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;-webkit-text-size-adjust:100%}
body{max-width:52rem;margin:0 auto;padding:14vh 1.5rem 6rem}
a{color:inherit;text-decoration-color:var(--muted);text-underline-offset:3px}
header{margin-bottom:3.5rem}
header a{font-weight:600;text-decoration:none}
h1{font-size:1rem;font-weight:600}
h2{margin:3rem 0 .75rem;color:var(--muted);font-size:.75rem;font-weight:400;letter-spacing:.08em;text-transform:uppercase}
p{color:var(--muted)}
dt,code{font:inherit;overflow-wrap:anywhere;user-select:all}
footer{margin-top:4rem}
.commands{display:grid;grid-template-columns:minmax(0,1fr) 11rem;gap:.8rem 2rem}
.commands dd{margin:0;color:var(--muted)}
details{margin-top:2.5rem}
summary{color:var(--muted);cursor:pointer}
details p{margin-top:2rem}
@media(max-width:600px){.commands{grid-template-columns:1fr;gap:0}.commands dd{margin-bottom:1rem}}
:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
`;

type Row = [command: string, label: string, description: string];
type Section = { title: string; rows: Row[] };

function usage(origin: string): Section[] {
  return [
    {
      title: "On the target",
      rows: [
        [
          `curl -sS ${origin} | sh`,
          "macOS and Linux",
          "Run this on the machine you want to reach. It prints an 8-character session code and copies it to the clipboard. Ctrl+C stops the agent and ends the session."
        ],
        [`irm ${origin} | iex`, "Windows PowerShell", "The same agent for PowerShell. Commands you send run as PowerShell, not sh."]
      ]
    },
    {
      title: "From anywhere",
      rows: [
        [
          `curl ${origin}/<code> -d pwd`,
          "Run a command",
          "Returns stdout then stderr as plain text, with the exit code in the X-Exit-Code header. Exit code 124 means the command timed out. Use --data-raw if the command starts with @."
        ],
        [`curl ${origin}/<code>`, "Check the session", "Returns JSON with code, shell (sh or powershell), platform, connected and expiresAt. Check shell before choosing command syntax."],
        [`curl -X DELETE ${origin}/<code>`, "End the session", "The agent exits. Sessions also end on their own after 2 hours."]
      ]
    },
    {
      title: "More",
      rows: [
        [`curl '${origin}/<code>?cwd=/tmp&timeout=10' -d ls`, "cwd and timeout", "Run in a working directory. The timeout is 1 to 50 seconds and defaults to 30."],
        [`curl ${origin}/<code> --data-binary @deploy.sh`, "Run a script file", "Sends the file as one command. --data-binary keeps newlines, which -d strips."],
        [`curl ${origin}/<code> -H 'Accept: application/json' -d 'npm test'`, "Get JSON back", 'Returns {"exitCode": 0, "stdout": "...", "stderr": "..."} with stdout and stderr kept apart.'],
        [
          `curl ${origin}/<code> -H 'Content-Type: application/json' -d '{"command":"ls","cwd":"/tmp","timeout":10}'`,
          "Send JSON",
          "Send the command, working directory and timeout as JSON instead of a raw body and query string."
        ]
      ]
    }
  ];
}

const LIMITS =
  "Sessions last 2 hours. Commands up to 64 KB, output up to 1 MB. Errors are plain text: 404 unknown session, 410 ended, 413 too large, 429 more than 300 lookups a minute, 504 no result in time. The code is the only key, so end the session when you're done.";

export function scriptUsage(origin: string, comment: string): string {
  const lines = ["reach: temporary shell access over HTTPS.", ""];
  for (const section of usage(origin)) {
    lines.push(section.title.toUpperCase());
    for (const [command, , description] of section.rows) lines.push(`  ${command}`, `      ${description}`);
    lines.push("");
  }
  lines.push(LIMITS);
  return lines.map((line) => `${comment} ${line}`.trimEnd()).join("\n");
}

export function homePage(origin: string): string {
  const sections = usage(origin).map((section) => {
    const rows = section.rows.map(([command, label, description]) => `<dt>${escapeHtml(command)}</dt><dd>${escapeHtml(label)}<span hidden> ${escapeHtml(description)}</span></dd>`).join("");
    return `<h2>${section.title}</h2><dl class="commands">${rows}</dl>`;
  });
  return layout(
    `reach · ${TAGLINE}`,
    `<h1>${TAGLINE}</h1>
${sections.slice(0, 2).join("")}
<details><summary>More options</summary>${sections.slice(2).join("")}<p>${escapeHtml(LIMITS)}</p></details>
<footer><p><a href="${SOURCE_URL}">Source</a></p></footer>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "reach", url: `${origin}/`, description: TAGLINE })}</script>`,
    {
      description: `${TAGLINE} Temporary shell access over HTTPS. No SSH, no VPN, no open ports.`,
      url: `${origin}/`,
      image: `${origin}/social/reach.png`,
      index: true
    }
  );
}

export function notFoundPage(): string {
  return layout(
    "Not found · reach",
    `<h1>Not found</h1>
<p>No shell answers at this address.</p>`,
    { description: "No shell answers at this address." }
  );
}

function layout(title: string, body: string, metadata: { description: string; url?: string; image?: string; index?: boolean }): string {
  const social =
    metadata.url && metadata.image
      ? `<link rel="canonical" href="${escapeHtml(metadata.url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="reach">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(metadata.description)}">
<meta property="og:url" content="${escapeHtml(metadata.url)}">
<meta property="og:image" content="${escapeHtml(metadata.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(TAGLINE)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(metadata.description)}">
<meta name="twitter:image" content="${escapeHtml(metadata.image)}">`
      : "";
  return `<!doctype html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(metadata.description)}">
<meta name="robots" content="${metadata.index ? "index, follow" : "noindex, nofollow"}">
${social}
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${STYLE}</style>
</head>
<body>
<header><a href="/">reach</a></header>
<main>
${body}
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
