import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { effectiveOutputSchema } from '../src/lib/ai/effective-schema.ts';
import { buildAIAnalysisPrompt } from '../src/lib/ai/prompt-builder.ts';

// Node's native TS runner needs extensions; keep production bundler imports intact.
const dir = await mkdtemp(join(tmpdir(), 'config-contract-'));
async function load(path, replacements) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, target] of replacements) source = source.replaceAll(from, new URL(target, import.meta.url).href);
  const file = join(dir, path.split('/').at(-1));
  await writeFile(file, source);
  return import(pathToFileURL(file).href);
}
const { parseAiOutput, validateAiOutputAgainstSchema } = await load('../src/lib/ai/output-parser.ts', [['./why-guard', '../src/lib/ai/why-guard.ts']]);
const { renderPublishingMessage } = await load('../src/lib/delivery/template.ts', [['../ai/why-guard', '../src/lib/ai/why-guard.ts'], ['./message', '../src/lib/delivery/message.ts']]);
test.after(() => rm(dir, { recursive: true, force: true }));
const schema = [
  { name: 'summary', enabled: true, required: true, type: 'string', description: 'خلاصه اختصاصی' },
  { name: 'importance', enabled: true, required: true, type: 'number', min: 0, max: 100, description: 'اهمیت' },
  { name: 'shouldSend', enabled: true, required: true, type: 'boolean', description: 'ارسال' },
  { name: 'mainEvent', enabled: true, required: false, type: 'string', description: 'رویداد' },
];
const features = Object.fromEntries(schema.map(f => [f.name, { enabled: true, instruction: 'دستور اختصاصی', ...(f.type === 'number' ? {scaleMin: 20, scaleMax: 80} : {}) }]));
const raw = extra => JSON.stringify({ summary: 'خلاصه معتبر', importance: 60, shouldSend: false, ...extra });
test('required fields, root object, strict boolean, numeric types and range enforced in real parser', () => {
  for (const text of ['null', '[]', raw({ summary: '' }), raw({ shouldSend: 'false' }), raw({ importance: '60' }), raw({ importance: 101 })]) {
    assert.throws(() => parseAiOutput(text, schema));
    assert.equal(validateAiOutputAgainstSchema(text, schema).ok, false);
  }
});
test('disabled features are ignored even when model returns their data', () => {
  const contract = effectiveOutputSchema(schema, {...features, mainEvent: {enabled: false}});
  assert.equal(parseAiOutput(raw({mainEvent: 'نباید ذخیره شود'}), contract).mainEvent, null);
});
test('optional field still respects configured type when present', () => {
  assert.throws(() => parseAiOutput(raw({mainEvent: 123}), schema));
});
test('feature and schema range intersect in prompt and production parsing', () => {
  const contract = effectiveOutputSchema(schema, features);
  assert.throws(() => parseAiOutput(raw({importance: 90}), contract));
  assert.equal(parseAiOutput(raw({importance: 70}), contract).importance, 70);
  const config = {systemPrompt: 'تحلیل', features, outputSchema: schema, decisionRules: {enableAutoRecommendation: true}};
  const prompt = buildAIAnalysisPrompt(config, {title: 'خبر', source: 'منبع', description: null, publishedAt: null});
  assert.ok(prompt.systemPrompt.includes('(20-80)'));
  assert.ok(prompt.systemPrompt.includes('خلاصه اختصاصی'));
  assert.ok(prompt.systemPrompt.includes('دستور اختصاصی'));
});
test('publishing template changes affect rendered output without an AI call', () => {
  const article = {title: 'خبر', summary: 'خلاصه خبر', category: 'اقتصاد', importanceScore: 70, source: 'منبع', url: 'https://example.com/a'};
  assert.equal(renderPublishingMessage('نسخه اول: {summary}', article), 'نسخه اول: خلاصه خبر');
  assert.equal(renderPublishingMessage('نسخه دوم: {importanceScore}', article), 'نسخه دوم: 70');
});

test('hashtags have an independent schema field and normalize escaped underscores', () => {
  const hashtagSchema = [...schema, {name:'hashtags',enabled:true,required:false,type:'string'}];
  const output = parseAiOutput(raw({hashtags:'#بازار\\_سهام #نقدینگی #نقدینگی'}), hashtagSchema);
  assert.equal(output.hashtags, '#بازار_سهام #نقدینگی');
  assert.equal(parseAiOutput(raw({hashtags:'#نقدینگی'}), schema).hashtags, null);
  const rendered = renderPublishingMessage('{summary}\n{hashtags}', {title:'خبر',summary:'خلاصه',hashtags:output.hashtags});
  assert.ok(rendered.includes('#بازار_سهام #نقدینگی'));
  assert.ok(!rendered.includes('\\_'));
});
