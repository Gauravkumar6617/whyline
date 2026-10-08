import { handle } from '../lib/handle.js';
import { supabaseDb } from '../lib/db-supabase.js';

export const POST = (request) => handle(request, supabaseDb);
