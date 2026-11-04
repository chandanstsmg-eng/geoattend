/** Stops the built-in PostgreSQL server (it keeps running after the API stops, by design). */
import { stopEmbeddedDatabase } from '../src/db/postgres.js';

await stopEmbeddedDatabase();
console.log('  Built-in database stopped.');
