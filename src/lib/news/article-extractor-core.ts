/**
 * Pure HTML-to-article-body extraction & AI context composition.
 *
 * Dependency-free (no runtime imports) so Node's native test runner can test it
 * directly. Many English analytical economic outlets (Project Syndicate, VoxEU,
 * Brookings, PIIE, IMF Blog, The Economist, Fed Notes) emit only a 1–2 sentence
 * RSS teaser while the article webpage carries the full economic argument.
 */

const MAX_EXTRACTED_BODY_CHARS = 12_000;
const MAX_AI_CONTEXT_CHARS = 4_800;
const MIN_RICH_CONTENT_CHARS = 450;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201C",
  rdquo: "\u201D",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  copy: "\u00A9",
};

const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /^subscribe(\s+now|\s+to\b)/i,
  /^sign\s+(up|in)\b/i,
  /^log\s+in\b/i,
  /^cookie\s+(policy|settings|preferences)/i,
  /^all\s+rights\s+reserved\.?$/i,
  /^share\s+(this|on)\b/i,
  /^follow\s+us\s+on\b/i,
  /^advertisement$/i,
  /^read\s+more:?$/i,
  /^related\s+(articles|stories|posts):?$/i,
];

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (!Number.isFinite(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTagsToPlain(fragment: string): string {
  return decodeHtmlEntities(
    decodeHtmlEntities(
      fragment
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, " "),
    ),
  )
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function isBoilerplateParagraph(text: string): boolean {
  if (text.length < 35) return true;
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function extractAcademicAbstractMeta(html: string): string | null {
  const head = /<head[\s>][\s\S]*?<\/head>/i.exec(html)?.[0] ?? html.slice(0, 20_000);
  const abstractPatterns = [
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:citation_abstract|dc\.description|dcterms\.abstract)["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:citation_abstract|dc\.description|dcterms\.abstract)["']/i,
  ];
  for (const pattern of abstractPatterns) {
    const raw = pattern.exec(head)?.[1];
    if (raw) {
      const cleaned = stripTagsToPlain(raw);
      if (cleaned.length >= 45) return cleaned.slice(0, 2_500);
    }
  }
  return null;
}

function extractJsonLdLead(html: string): string | null {
  const scripts = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi) ?? [];
  for (const block of scripts.slice(0, 4)) {
    const inner = block.replace(/^<script\b[^>]*>/i, "").replace(/<\/script\s*>$/i, "").trim();
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown> | Array<Record<string, unknown>>;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        for (const field of ["abstract", "articleBody", "description"] as const) {
          const val = item?.[field];
          if (typeof val === "string") {
            const cleaned = stripTagsToPlain(val);
            if (cleaned.length >= 60) return cleaned.slice(0, 2_500);
          }
        }
      }
    } catch {
      // malformed JSON-LD on third-party sites is ignored safely
    }
  }
  return null;
}

function extractMetaDescription(html: string): string | null {
  const academic = extractAcademicAbstractMeta(html);
  if (academic) return academic;

  const head = /<head[\s>][\s\S]*?<\/head>/i.exec(html)?.[0] ?? html.slice(0, 12_000);
  const patterns = [
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:description|twitter:description|description)["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](?:og:description|twitter:description|description)["']/i,
  ];
  for (const pattern of patterns) {
    const raw = pattern.exec(head)?.[1];
    if (raw) {
      const cleaned = stripTagsToPlain(raw);
      if (cleaned.length >= 40) return cleaned.slice(0, 1_200);
    }
  }
  return extractJsonLdLead(html);
}

/**
 * Extracts readable article paragraphs from raw HTML.
 * Returns null when no meaningful article prose could be recovered.
 */
export function extractArticleTextFromHtml(html: string | null | undefined): string | null {
  if (!html || typeof html !== "string") return null;

  const academicAbstract = extractAcademicAbstractMeta(html);

  // Strip comments and non-prose containers first.
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|canvas|form|nav|footer|aside|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  // Prefer <article> or <main> when substantial; fall back to <body> / whole document.
  const articleMatch = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(stripped)?.[1];
  const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(stripped)?.[1];
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(stripped)?.[1];

  const candidateRegions = [articleMatch, mainMatch, bodyMatch, stripped].filter(
    (region): region is string => Boolean(region && region.trim().length > 100),
  );

  for (const region of candidateRegions) {
    const blocks = region.match(/<(p|h2|h3|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi) ?? [];
    const paragraphs: string[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
      const isHeading = /^<h[23]\b/i.test(block);
      const text = stripTagsToPlain(block);
      if (!text) continue;
      if (!isHeading && isBoilerplateParagraph(text)) continue;
      if (isHeading && (text.length < 8 || text.length > 180)) continue;

      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      paragraphs.push(isHeading ? `## ${text}` : text);
    }

    const joined = paragraphs.join("\n\n").trim();
    if (joined.length >= 120) {
      const withAbstract =
        academicAbstract && !joined.toLowerCase().includes(academicAbstract.slice(0, 90).toLowerCase())
          ? `${academicAbstract}\n\n${joined}`
          : joined;
      return withAbstract.length <= MAX_EXTRACTED_BODY_CHARS
        ? withAbstract
        : `${withAbstract.slice(0, MAX_EXTRACTED_BODY_CHARS).trimEnd()}…`;
    }
  }

  return extractMetaDescription(html);
}

const BYLINE_OR_META_LINE = /^(?:by\s+[A-Z\u0600-\u06FF]|working\s+paper\s+\d+|doi\s*:|jel\s*(?:codes?|classification|no)\b|published\s+(?:on|in)\b|author[s]?\s*:)/i;

/**
 * Extracts the opening substantive paragraph (or short standfirst + first body
 * paragraph) of a report/article, skipping headings, author bylines (`"by ..."`),
 * and boilerplate lines so title-rejected reports can be judged by their true
 * opening paragraph rather than footer links or author metadata.
 */
export function extractFirstParagraph(
  text: string | null | undefined,
  maxChars = 900,
): string | null {
  if (!text || typeof text !== "string") return null;

  const rawBlocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}|\n/)
    .map((line) => line.replace(/[ \t\u00A0]+/g, " ").trim())
    .filter(Boolean);

  const substantive: string[] = [];
  for (const block of rawBlocks) {
    if (block.startsWith("## ") || block.startsWith("# ")) continue;
    if (block.length < 40) continue;
    if (block.length < 140 && BYLINE_OR_META_LINE.test(block)) continue;
    if (isBoilerplateParagraph(block)) continue;
    substantive.push(block);
    if (substantive.length >= 2) break;
  }

  if (substantive.length === 0) return null;

  // If the first paragraph is a brief deck/standfirst (< 220 chars) and a second
  // paragraph follows immediately, inspect both together as the opening lead.
  const combined =
    substantive[0].length < 220 && substantive[1]
      ? `${substantive[0]} ${substantive[1]}`
      : substantive[0];

  return combined.length <= maxChars ? combined : `${combined.slice(0, maxChars).trimEnd()}…`;
}

/**
 * True when stored RSS text is too short for a deep analytical summary, so
 * fetching the article page is worthwhile before calling the LLM.
 */
export function shouldFetchFullArticleText(input: {
  url?: string | null;
  description?: string | null;
  content?: string | null;
}): boolean {
  const url = (input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return false;
  const contentLen = (input.content ?? "").trim().length;
  const descLen = (input.description ?? "").trim().length;
  return Math.max(contentLen, descLen) < MIN_RICH_CONTENT_CHARS;
}

/**
 * Combines RSS abstract (`description`) and full article text (`content`)
 * without duplicating identical openings, bounded for predictable token usage.
 */
export function composeArticleTextForAi(input: {
  description?: string | null;
  content?: string | null;
  maxChars?: number;
}): { summarySnippet: string | null; fullText: string | null } {
  const maxChars = Math.max(500, input.maxChars ?? MAX_AI_CONTEXT_CHARS);
  const desc = (input.description ?? "").trim() || null;
  const body = (input.content ?? "").trim() || null;

  if (!body) {
    return {
      summarySnippet: desc ? desc.slice(0, maxChars) : null,
      fullText: null,
    };
  }

  // Avoid repeating description when fullText already starts with or contains it.
  const descNormalized = desc ? desc.slice(0, 140).toLowerCase() : "";
  const bodyIncludesDesc = Boolean(descNormalized && body.toLowerCase().includes(descNormalized));
  const clippedBody = body.length <= maxChars ? body : `${body.slice(0, maxChars).trimEnd()}…`;

  return {
    summarySnippet: bodyIncludesDesc ? null : desc ? desc.slice(0, 1_200) : null,
    fullText: clippedBody,
  };
}
