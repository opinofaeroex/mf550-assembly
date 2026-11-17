#!/usr/bin/env node
/**
 * Prints the spoken narration script of every navigation position as JSON
 * (input of tools/narration/generate.py). Uses the app's own modules, so the
 * recordings always match what the app expects to play.
 *
 *   node --no-warnings tools/narration/export-script.mjs > script.json
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pub = (p) => path.join(ROOT, 'public', p);
const { AssemblyModel } = await import(pub('js/data/AssemblyModel.js'));
const { CONFIG } = await import(pub('js/config.js'));
const { spokenText, forSpeech, narrationKey } = await import(pub('js/audio/spokenScript.js'));
const { positionText } = await import(pub('js/ui/text.js'));

const model = new AssemblyModel(JSON.parse(readFileSync(pub(CONFIG.assemblyUrl), 'utf8')));
model.meta.displayName = CONFIG.productName;

const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '')
  .replace(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/g, '$1-of-$2').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const out = [];
for (let pos = -2; pos <= model.stepCount; pos++) {
  const key = narrationKey(model, pos);
  const t = positionText(model, pos);
  const text = spokenText(model, pos);
  out.push({
    key, pos, text, speech: forSpeech(text),
    file: key.startsWith('step-') ? `${key}-${slug(t.title)}` : key,
  });
}
process.stdout.write(JSON.stringify({ product: CONFIG.productName, positions: out }, null, 1) + '\n');
