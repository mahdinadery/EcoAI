import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  bulletinAffiliations,
  extractArxivId,
  fetchProvenance,
  formatAffiliationLine,
  normalizeOpenAlexWork,
  openAlexWorkPath,
  provenanceConfig,
} from "../src/lib/news/provenance.ts";

const inst = (name, extra = {}) => ({ display_name: name, ...extra });

test("extractArxivId: abs/pdf/DOI/OAI and legacy ids, with versions dropped", () => {
  assert.equal(extractArxivId("https://arxiv.org/abs/2511.01234"), "2511.01234");
  assert.equal(extractArxivId("https://arxiv.org/pdf/2511.01234v2"), "2511.01234");
  assert.equal(extractArxivId("http://export.arxiv.org/api/query?id_list=cs/0201001"), "cs/0201001");
  assert.equal(extractArxivId("https://doi.org/10.48550/arXiv.2511.01234"), "2511.01234");
  assert.equal(extractArxivId("oai:arXiv.org:2511.01234v3"), "2511.01234");
  assert.equal(extractArxivId(null, undefined, "https://ft.com/blog/x"), null, "a news outlet is not an arXiv id");
  assert.equal(extractArxivId("https://arxiv.org/list/econ.GN/recent"), null, "a listing page is not a paper");
  // First usable candidate wins, and an arXiv URL with a query string still parses.
  assert.equal(extractArxivId("https://example.com/x", "2412.00007"), "2412.00007");
  assert.equal(extractArxivId("https://arxiv.org/abs/2511.01234?context=cs"), "2511.01234");
  assert.equal(extractArxivId("math.GT/0309136"), "math.GT/0309136");
});

test("openAlexWorkPath builds the DOI lookup segment", () => {
  assert.equal(openAlexWorkPath("2511.01234"), "works/doi:10.48550/arXiv.2511.01234");
});

test("normalizeOpenAlexWork ranks corresponding first, then the first author", () => {
  const info = normalizeOpenAlexWork({
    doi: "https://doi.org/10.48550/arXiv.2511.01234",
    authorships: [
      { author_position: "first", author: { display_name: "A. First" }, institutions: [inst("Alpha University", { country_code: "us", type: "education" })] },
      {
        author_position: "middle",
        is_corresponding: true,
        author: { display_name: "C. Corresponding" },
        institutions: [inst("Gamma Lab", { country_code: "gb", type: "company" })],
      },
      { author_position: "middle", author: { display_name: "B. Other" }, institutions: [inst("Beta Institute")] },
      { author_position: "last", author: { display_name: "D. Other" }, institutions: [inst("Delta University"), inst("Alpha University")] },
    ],
  });
  assert.deepEqual(
    info.institutions.map((entry) => [entry.name, entry.country, entry.rank]),
    [
      ["Gamma Lab", "GB", "corresponding"],
      ["Alpha University", "US", "first"],
      ["Beta Institute", null, "other"],
    ],
  );
  assert.equal(info.arxivId, "2511.01234");
  assert.equal(info.authorCount, 4);
  assert.equal(formatAffiliationLine(info.institutions), "Gamma Lab · Alpha University · Beta Institute");
});

test("normalizeOpenAlexWork drops repository placeholders and junk payloads", () => {
  const noise = normalizeOpenAlexWork({
    authorships: [
      { author_position: "first", institutions: [inst("arXiv"), inst("Concordia Collider"), inst("  "), inst("University of Oxford")] },
    ],
  });
  assert.deepEqual(noise.institutions.map((entry) => entry.name), ["University of Oxford"]);

  for (const junk of [null, undefined, "text", [], {}, { authorships: [] }, { authorships: "no" }, { authorships: [null, 7] }]) {
    const parsed = normalizeOpenAlexWork(junk);
    assert.ok(parsed === null || parsed.institutions.length === 0, `junk payload accepted: ${JSON.stringify(junk)}`);
  }
});

// ── HTTP layer, against a local stand-in for the API ─────────────────────────

function startMockApi() {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    if (request.url.includes("2511.00001")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          doi: "https://doi.org/10.48550/arXiv.2511.00001",
          authorships: [{ author_position: "first", institutions: [inst("University of Michigan")] }],
        }),
      );
      return;
    }
    if (request.url.includes("slow")) {
      // Deliberately never answered: the caller's timeout must decide.
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Records corresponding to your query were not found." }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

test("fetchProvenance: resolves indexed papers, tolerates 404 and timeouts, never throws", async () => {
  const mock = await startMockApi();
  try {
    const results = await fetchProvenance(
      [
        { key: "found", url: "https://arxiv.org/abs/2511.00001" },
        { key: "not-indexed", url: "https://arxiv.org/abs/9999.99999" },
        { key: "not-arxiv", url: "https://www.ft.com/content/ai-capex" },
        { key: "slow", externalId: "oai:arXiv.org:slow" },
      ],
      { baseUrl: mock.baseUrl, timeoutMs: 400, budgetMs: 5_000 },
    );
    assert.deepEqual([...results.keys()], ["found"], "only the indexed arXiv paper resolves");
    assert.deepEqual(results.get("found").institutions.map((entry) => entry.name), ["University of Michigan"]);
    assert.ok(mock.seen.every((url) => url.includes("select=id,doi,authorships")), mock.seen.join("\n"));
  } finally {
    await mock.close();
  }
});

test("fetchProvenance skips the network entirely when switched off", async () => {
  const previous = process.env.NEWS_ARTICLE_PROVENANCE;
  process.env.NEWS_ARTICLE_PROVENANCE = "false";
  const mock = await startMockApi();
  try {
    const results = await fetchProvenance([{ key: "found", url: "https://arxiv.org/abs/2511.00001" }], {
      baseUrl: mock.baseUrl,
    });
    assert.equal(results.size, 0);
    assert.deepEqual(mock.seen, [], "a disabled lookup must not touch the API");
  } finally {
    await mock.close();
    if (previous === undefined) delete process.env.NEWS_ARTICLE_PROVENANCE;
    else process.env.NEWS_ARTICLE_PROVENANCE = previous;
  }
});

test("the mailto hint reaches the API and the config stays bounded", async () => {
  const mock = await startMockApi();
  try {
    await fetchProvenance([{ key: "found", url: "https://arxiv.org/abs/2511.00001" }], {
      baseUrl: mock.baseUrl,
      mailto: "editor@example.com",
      timeoutMs: 900,
    });
    assert.ok(mock.seen.some((url) => url.includes("mailto=editor%40example.com")), mock.seen.join("\n"));
  } finally {
    await mock.close();
  }

  const config = provenanceConfig();
  assert.equal(config.enabled, true, "on by default, off only with an explicit false");
  assert.equal(config.baseUrl, "https://api.openalex.org");
  // Out-of-range env values are clamped, not trusted.
  const original = process.env.NEWS_ARTICLE_PROVENANCE_TIMEOUT_MS;
  process.env.NEWS_ARTICLE_PROVENANCE_TIMEOUT_MS = "999999";
  assert.equal(provenanceConfig().timeoutMs, 10_000);
  if (original === undefined) delete process.env.NEWS_ARTICLE_PROVENANCE_TIMEOUT_MS;
  else process.env.NEWS_ARTICLE_PROVENANCE_TIMEOUT_MS = original;
});

test("bulletinAffiliations is a no-op while the option is off", async () => {
  const map = await bulletinAffiliations([{ id: "n1", url: "https://arxiv.org/abs/2511.00001" }], false);
  assert.equal(map.size, 0);
});
