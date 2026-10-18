import { readFileSync, writeFileSync } from 'node:fs';

// Patch only the installed route so the branded frontend and backend stay intact.
const path = '/app/server/dist/modules/podcasts/routes.collaborators.js';
const before = readFileSync(path, 'utf8');
const needle = 'username: users.username,';
const replacement = "username: sql`COALESCE(NULLIF(TRIM(${users.username}), ''), ${users.email})`,";
const count = before.split(needle).length - 1;
if (count !== 3) {
  throw new Error(`Expected three collaborator username projections; found ${count}. Image was not patched.`);
}
writeFileSync(path, before.replaceAll(needle, replacement));
console.log('Patched collaborator labels for list, add, and role update responses.');
