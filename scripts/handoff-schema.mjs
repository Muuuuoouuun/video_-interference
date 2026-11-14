import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';

let validator;

/** Validate a handoff or context manifest against schema/feedback-handoff.schema.json. Throws with readable paths. */
export async function validateHandoffManifest(manifest) {
  if (!validator) {
    const schema = JSON.parse(await readFile(new URL('../schema/feedback-handoff.schema.json', import.meta.url), 'utf8'));
    validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  }
  if (validator(manifest)) return true;
  const errors = (validator.errors || []).slice(0, 12).map(error => `${error.instancePath || '/'} ${error.message}${error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ''}`);
  throw new Error(`전달 형식 v2 규격과 맞지 않습니다:\n${errors.join('\n')}`);
}
