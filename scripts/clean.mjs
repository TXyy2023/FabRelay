import { rm } from 'node:fs/promises';
import path from 'node:path';

const workspace = path.resolve('.');
for (const name of ['dist', 'coverage']) {
  const target = path.resolve(workspace, name);
  if (path.dirname(target) !== workspace || !['dist', 'coverage'].includes(path.basename(target))) {
    throw new Error(`Refusing unsafe clean target: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
