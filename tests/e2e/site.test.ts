import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { baseUrl } from "../helpers/reach";

test("browsers and link previews get the homepage instead of the agent", async () => {
  const visitors: Record<string, string>[] = [{ Accept: "text/html" }, { "User-Agent": "Slackbot-LinkExpanding 1.0" }];
  for (const headers of visitors) {
    const response = await fetch(baseUrl, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
    const page = await response.text();
    assert.match(page, /Reach any shell from anywhere\./);
    assert.match(page, new RegExp(`curl -sS ${baseUrl} \\| sh`));
  }
});

test("the agent script explains how to use it", async () => {
  const script = await (await fetch(baseUrl)).text();
  assert.match(script, /^#!\/bin\/sh\n# reach: /);
  assert.match(script, new RegExp(`#\\s+curl ${baseUrl}/<code> -d pwd`));
});

test("browsers get a not found page and the site serves its images", async () => {
  const missing = await fetch(`${baseUrl}/nothing/here`, { headers: { Accept: "text/html" } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No shell answers at this address\./);

  const image = await fetch(`${baseUrl}/social/reach.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Type"), "image/png");
});
