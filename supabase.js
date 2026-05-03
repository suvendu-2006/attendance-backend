const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL || 'http://localhost:5432';
const supabaseKey = process.env.SUPABASE_KEY || 'dummy_key';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
