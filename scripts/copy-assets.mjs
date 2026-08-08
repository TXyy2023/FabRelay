import { chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import { publicSchemas, schemaFor } from '../dist/schema/index.js';

await mkdir('dist/schemas', { recursive: true });
await cp('schemas', 'dist/schemas', { recursive: true });
for (const name of Object.keys(publicSchemas)) {
  const json = `${JSON.stringify(schemaFor(name), null, 2)}\n`;
  await writeFile(`schemas/${name}.schema.json`, json);
  await writeFile(`dist/schemas/${name}.schema.json`, json);
}
await chmod('dist/bin/jlc-cli.js', 0o755);
